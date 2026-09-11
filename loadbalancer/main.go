// Command loadbalancer is a performance-aware reverse proxy in front of the
// csd-group-chat messaging backends.
//
// It is deployed on Sys1 and forwards to copies of the messaging server running
// on Sys2, Sys3 and Sys4. Backend selection is driven by measured load rather
// than by a fixed rotation: each backend carries a score built from how many
// requests it is currently serving, how quickly it has been answering, and how
// busy its CPU is. Traffic stays on a backend until that score crosses a
// threshold, at which point it moves to the least loaded one.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Backend is one messaging-app instance the load balancer can forward to.
type Backend struct {
	URL   *url.URL
	Alive atomic.Bool

	// Updated by the balancer itself, on every request, so selection reacts
	// immediately rather than waiting for the next stats poll.
	InFlight   atomic.Int64
	ewmaMicros atomic.Int64
	Requests   atomic.Uint64
	Failures   atomic.Uint64

	// Reported by the backend and refreshed by the stats poller. CPU is held
	// as hundredths of a percent so it can live in an atomic integer.
	cpuCentis  atomic.Int64
	backendEwma atomic.Int64
	StoredMsgs atomic.Int64

	proxy *httputil.ReverseProxy
}

// observe folds one request's duration into the backend's smoothed latency.
// A plain average would take thousands of requests to notice a backend going
// slow; this weights recent requests heavily enough to react within a burst.
func (b *Backend) observe(d time.Duration) {
	const alpha = 0.2
	previous := b.ewmaMicros.Load()
	current := d.Microseconds()

	if previous == 0 {
		b.ewmaMicros.Store(current)
		return
	}

	b.ewmaMicros.Store(int64(float64(previous)*(1-alpha) + float64(current)*alpha))
}

func (b *Backend) LatencyMs() float64 {
	return float64(b.ewmaMicros.Load()) / 1000.0
}

func (b *Backend) CPUPercent() float64 {
	return float64(b.cpuCentis.Load()) / 100.0
}

// Metrics are the load balancer's own counters, exposed at /lb/metrics.
type Metrics struct {
	Total         atomic.Uint64
	Success       atomic.Uint64
	Failed        atomic.Uint64
	BackendErrors atomic.Uint64
	Switches      atomic.Uint64
	Retries       atomic.Uint64

	// Latency samples in a fixed ring, written at an atomic index.
	ring []atomic.Int64
	pos  atomic.Uint64
}

func newMetrics(size int) *Metrics {
	return &Metrics{ring: make([]atomic.Int64, size)}
}

// record stores one latency sample without taking a lock.
//
// This runs on every proxied request. The previous version took a mutex and
// appended to a slice, which put every concurrent request through one lock —
// and the reslice-from-the-front it used to bound the window meant the
// underlying array was periodically reallocated and 100,000 samples copied.
// A fixed ring written at an atomic index costs one store and never allocates.
func (m *Metrics) record(d time.Duration) {
	index := m.pos.Add(1) - 1
	m.ring[index%uint64(len(m.ring))].Store(d.Microseconds())
}

// Clears the counters between tuning runs so each threshold is measured on its
// own traffic rather than on everything since the process started.
func (m *Metrics) reset() {
	m.Total.Store(0)
	m.Success.Store(0)
	m.Failed.Store(0)
	m.BackendErrors.Store(0)
	m.Switches.Store(0)
	m.Retries.Store(0)

	for i := range m.ring {
		m.ring[i].Store(0)
	}
	m.pos.Store(0)
}

func percentile(sorted []int64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return float64(sorted[int(p*float64(len(sorted)-1))]) / 1000.0
}

func (m *Metrics) snapshot() map[string]any {
	samples := make([]int64, 0, len(m.ring))
	for i := range m.ring {
		if value := m.ring[i].Load(); value > 0 {
			samples = append(samples, value)
		}
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })

	return map[string]any{
		"total":          m.Total.Load(),
		"success":        m.Success.Load(),
		"failed":         m.Failed.Load(),
		"backend_errors": m.BackendErrors.Load(),
		"switches":       m.Switches.Load(),
		"retries":        m.Retries.Load(),
		"p50_ms":         percentile(samples, 0.50),
		"p95_ms":         percentile(samples, 0.95),
		"p99_ms":         percentile(samples, 0.99),
		"samples":        len(samples),
	}
}

// applyCPUQuota keeps the Go runtime's idea of available parallelism in line
// with what the container is actually entitled to.
//
// runtime.NumCPU() reports the host's cores — 120 on the lab machine — but the
// cgroup quota here grants the equivalent of one. Left alone, Go would run 120
// schedulable threads against that single CPU's worth of time, and the kernel
// would throttle the whole process once the quota ran out inside each period.
// The visible effect is latency spikes under exactly the load we care about.
func applyCPUQuota() int {
	data, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
	if err != nil {
		return runtime.GOMAXPROCS(0)
	}

	fields := strings.Fields(strings.TrimSpace(string(data)))
	if len(fields) != 2 || fields[0] == "max" {
		return runtime.GOMAXPROCS(0)
	}

	quota, err1 := strconv.ParseFloat(fields[0], 64)
	period, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil || period <= 0 || quota <= 0 {
		return runtime.GOMAXPROCS(0)
	}

	// One spare thread above the entitlement, so a goroutine blocked in a
	// syscall does not leave the quota unused, without inviting the thrashing
	// that a much larger number would.
	procs := int(quota/period) + 1

	// GOMAXPROCS returns the *previous* setting, so returning its result would
	// report the host's core count and make it look as though the quota had
	// been ignored.
	runtime.GOMAXPROCS(procs)
	return procs
}

// applyMemoryLimit tells the garbage collector how much memory it may actually
// use, which is not something it can otherwise find out.
//
// Go sizes collections against the live heap — roughly doubling it before
// collecting — with no knowledge of any cgroup limit. This container is capped
// at 512MB while the host reports 128GB, so left alone the runtime will happily
// grow past the cap under load and the kernel will kill the process. That death
// is silent: no panic, no message, the balancer simply stops existing, which is
// exactly what happened during the evaluation.
//
// Setting a soft limit makes the collector work harder as it approaches the cap
// instead of running into it. The headroom below the cgroup limit covers what
// the heap limit does not: goroutine stacks, runtime structures and socket
// buffers, all of which count against the container.
func applyMemoryLimit() {
	data, err := os.ReadFile("/sys/fs/cgroup/memory.max")
	if err != nil {
		return
	}

	text := strings.TrimSpace(string(data))
	if text == "max" {
		log.Printf("memory limit: unlimited")
		return
	}

	limit, err := strconv.ParseUint(text, 10, 64)
	if err != nil || limit == 0 {
		return
	}

	// Only a minority of the budget goes to the heap. The rest is kernel
	// socket memory, which is charged to the same cgroup and which the Go
	// runtime neither sees nor accounts for.
	soft := int64(float64(limit) * 0.35)
	debug.SetMemoryLimit(soft)
	log.Printf("memory limit: cgroup %dMB, GC soft limit set to %dMB",
		limit/(1<<20), soft/(1<<20))
}

func (lb *LoadBalancer) totalInFlight() int64 {
	var total int64
	for _, b := range lb.backends {
		total += b.InFlight.Load()
	}
	return total
}

// cpuPercent reports how much of this container's CPU entitlement is in use.
//
// /proc/stat is not namespaced, so inside a container it describes the host —
// on the lab machine, all 120 of its cores. A balancer saturating its single
// allotted CPU would show under 1% busy there, which is worthless both for
// routing and for the utilisation figures in the report. The cgroup accounts
// for this container specifically, so that is what gets read, expressed as a
// percentage of the quota rather than of the host.
var cpuState struct {
	mu            sync.Mutex
	lastUsageUsec uint64
	lastAt        time.Time
	lastReported  float64
}

// cgroupUsageMicros returns CPU microseconds consumed by this container.
func cgroupUsageMicros() (uint64, bool) {
	if data, err := os.ReadFile("/sys/fs/cgroup/cpu.stat"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			rest, found := strings.CutPrefix(line, "usage_usec ")
			if !found {
				continue
			}
			if value, err := strconv.ParseUint(strings.TrimSpace(rest), 10, 64); err == nil {
				return value, true
			}
		}
	}

	// cgroup v1 reports nanoseconds.
	if data, err := os.ReadFile("/sys/fs/cgroup/cpuacct/cpuacct.usage"); err == nil {
		if value, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64); err == nil {
			return value / 1000, true
		}
	}

	return 0, false
}

// quotaCores is how many CPUs this container may use, i.e. what 100% means.
func quotaCores() float64 {
	data, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
	if err != nil {
		return float64(runtime.NumCPU())
	}

	fields := strings.Fields(strings.TrimSpace(string(data)))
	if len(fields) != 2 || fields[0] == "max" {
		return float64(runtime.NumCPU())
	}

	quota, err1 := strconv.ParseFloat(fields[0], 64)
	period, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil || quota <= 0 || period <= 0 {
		return float64(runtime.NumCPU())
	}

	return quota / period
}

var cores = quotaCores()

// sampleCPU is called on a timer rather than from the request handler. Reading
// it per request would measure whatever sliver of time had passed since the
// last read, which for two closely spaced requests is noise rather than a
// measurement.
func sampleCPU() float64 {
	cpuState.mu.Lock()
	defer cpuState.mu.Unlock()

	usage, ok := cgroupUsageMicros()
	now := time.Now()

	if !ok {
		return cpuState.lastReported
	}

	if !cpuState.lastAt.IsZero() {
		elapsedMicros := float64(now.Sub(cpuState.lastAt).Microseconds())
		if elapsedMicros > 0 {
			used := float64(usage - cpuState.lastUsageUsec)
			percent := 100 * used / (elapsedMicros * cores)
			cpuState.lastReported = math.Max(0, math.Min(100, percent))
		}
	}

	cpuState.lastUsageUsec = usage
	cpuState.lastAt = now

	return cpuState.lastReported
}

func cpuPercent() float64 {
	cpuState.mu.Lock()
	defer cpuState.mu.Unlock()
	return cpuState.lastReported
}

func startCPUSampling(interval time.Duration) {
	go func() {
		sampleCPU()
		for range time.Tick(interval) {
			sampleCPU()
		}
	}()
}

// Weights turn three different measurements into one comparable number.
// Defaults are chosen so that one unit of score means roughly the same amount
// of "busy" whichever measurement it came from: one outstanding request, 20ms
// of smoothed latency, or 10% of a CPU.
type Weights struct {
	InFlight float64
	Latency  float64
	CPU      float64
}

type LoadBalancer struct {
	backends  []*Backend
	metrics   *Metrics
	weights   Weights
	threshold atomic.Uint64 // float64 bits, adjustable at runtime

	// The backend currently carrying traffic. Requests stay here until its
	// score crosses the threshold, which is what makes this a threshold-driven
	// switch rather than a rotation.
	current atomic.Pointer[Backend]
}

// Threshold is read on every request and written by the tuning endpoint, so it
// lives as bits in an atomic rather than behind a lock on the hot path.
func (lb *LoadBalancer) Threshold() float64 {
	return math.Float64frombits(lb.threshold.Load())
}

func (lb *LoadBalancer) SetThreshold(v float64) {
	lb.threshold.Store(math.Float64bits(v))
}

func (lb *LoadBalancer) score(b *Backend) float64 {
	return lb.weights.InFlight*float64(b.InFlight.Load()) +
		lb.weights.Latency*b.LatencyMs() +
		lb.weights.CPU*b.CPUPercent()
}

// candidates returns the backends to try, best first.
//
// The head of the list is the backend traffic should go to; the rest are the
// fallbacks used if it fails. The current backend keeps the head while its
// score is under the threshold. Once it crosses, the least loaded healthy
// backend takes over and becomes current.
const maxTrackedBackends = 16

// candidates fills dst with the healthy backends, best first, and returns the
// filled prefix. The caller supplies the array so that choosing a backend —
// which happens on every single request — allocates nothing.
//
// The ordering is an insertion sort rather than sort.Slice: with a handful of
// backends the reflection and closure that sort.Slice needs cost more than the
// comparisons themselves.
func (lb *LoadBalancer) candidates(dst *[maxTrackedBackends]*Backend) []*Backend {
	var scores [maxTrackedBackends]float64
	count := 0

	for _, b := range lb.backends {
		if count == maxTrackedBackends {
			break
		}
		if !b.Alive.Load() {
			continue
		}

		score := lb.score(b)
		i := count
		for i > 0 && scores[i-1] > score {
			scores[i] = scores[i-1]
			dst[i] = dst[i-1]
			i--
		}
		scores[i] = score
		dst[i] = b
		count++
	}

	if count == 0 {
		return nil
	}

	// The threshold rule: stay on the backend currently carrying traffic while
	// its score is under the threshold, and move to the least loaded one once
	// it crosses.
	if current := lb.current.Load(); current != nil && current.Alive.Load() {
		if lb.score(current) <= lb.Threshold() {
			for i := 0; i < count; i++ {
				if dst[i] == current {
					copy(dst[1:i+1], dst[0:i])
					dst[0] = current
					break
				}
			}
		} else if dst[0] != current {
			lb.metrics.Switches.Add(1)
		}
	}

	lb.current.Store(dst[0])
	return dst[:count]
}

func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/lb/health":
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok\n"))
		return
	case "/lb/status":
		lb.writeStatus(w)
		return
	case "/lb/metrics":
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(lb.metrics.snapshot())
		return
	case "/lb/config":
		// Lets the switching threshold be swept without a restart. Finding a
		// good value means comparing full load runs against each other, and
		// restarting between them would reset every warm connection and
		// counter that the comparison depends on.
		if value := r.URL.Query().Get("threshold"); value != "" {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil || parsed < 0 {
				http.Error(w, "threshold must be a non-negative number", http.StatusBadRequest)
				return
			}
			lb.SetThreshold(parsed)
			log.Printf("threshold set to %.3f", parsed)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"threshold": lb.Threshold()})
		return
	case "/lb/reset-metrics":
		lb.metrics.reset()
		for _, b := range lb.backends {
			b.Requests.Store(0)
			b.Failures.Store(0)
			b.ewmaMicros.Store(0)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok\n"))
		return
	case "/lb/stats":
		// The balancer's own machine. The backends report themselves through
		// their /stats route; without this one, Sys1 would be the one system
		// in the deployment with no utilisation figures.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			// Percent of this container's entitlement, matching what the
			// backends report, so the four systems are directly comparable.
			"cpuPercent":   math.Round(cpuPercent()*100) / 100,
			"cpuCores":     cores,
			"hostCpuCount": runtime.NumCPU(),
			"goroutines":   runtime.NumGoroutine(),
			"inFlight":     lb.totalInFlight(),
		})
		return
	}

	lb.metrics.Total.Add(1)

	var candidateBuf [maxTrackedBackends]*Backend
	candidates := lb.candidates(&candidateBuf)
	if len(candidates) == 0 {
		lb.metrics.Failed.Add(1)
		http.Error(w, "no healthy backend available", http.StatusServiceUnavailable)
		return
	}

	// Buffer the body once so a retry against a different backend can replay
	// it; a request body is a stream and can only be read a single time.
	var bodyBytes []byte
	if r.Body != nil && r.Body != http.NoBody {
		bodyBytes, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}

	start := time.Now()
	var rec *statusRecorder

	for attempt, backend := range candidates {
		if bodyBytes != nil {
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			r.ContentLength = int64(len(bodyBytes))
		}
		if attempt > 0 {
			lb.metrics.Retries.Add(1)
		}

		backend.InFlight.Add(1)
		backend.Requests.Add(1)
		attemptStart := time.Now()

		rec = &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		backend.proxy.ServeHTTP(rec, r)

		backend.InFlight.Add(-1)
		backend.observe(time.Since(attemptStart))

		if !rec.failed {
			break
		}

		backend.Failures.Add(1)
		// The ErrorHandler recorded the failure without writing to the client,
		// so the next candidate can still serve this request cleanly.
	}

	lb.metrics.record(time.Since(start))

	if rec.failed {
		lb.metrics.Failed.Add(1)
		http.Error(w, "all backends unavailable", http.StatusBadGateway)
		return
	}
	if rec.status >= 500 {
		lb.metrics.Failed.Add(1)
	} else {
		lb.metrics.Success.Add(1)
	}
}

func (lb *LoadBalancer) writeStatus(w http.ResponseWriter) {
	type backendStatus struct {
		URL        string  `json:"url"`
		Alive      bool    `json:"alive"`
		InFlight   int64   `json:"in_flight"`
		Score      float64 `json:"score"`
		LatencyMs  float64 `json:"latency_ms"`
		CPUPercent float64 `json:"cpu_percent"`
		Requests   uint64  `json:"requests"`
		Failures   uint64  `json:"failures"`
		Messages   int64   `json:"stored_messages"`
		Current    bool    `json:"current"`
	}

	current := lb.current.Load()
	out := struct {
		Threshold float64         `json:"threshold"`
		Backends  []backendStatus `json:"backends"`
	}{Threshold: lb.Threshold()}

	for _, b := range lb.backends {
		out.Backends = append(out.Backends, backendStatus{
			URL:        b.URL.String(),
			Alive:      b.Alive.Load(),
			InFlight:   b.InFlight.Load(),
			Score:      math.Round(lb.score(b)*100) / 100,
			LatencyMs:  math.Round(b.LatencyMs()*100) / 100,
			CPUPercent: b.CPUPercent(),
			Requests:   b.Requests.Load(),
			Failures:   b.Failures.Load(),
			Messages:   b.StoredMsgs.Load(),
			Current:    b == current,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// statusRecorder captures the status a backend responded with, and gives that
// backend's ErrorHandler a way to report failure without writing to the real
// client, so ServeHTTP can retry elsewhere.
//
// Hijack is forwarded explicitly: embedding only promotes the methods declared
// on http.ResponseWriter, and without it the reverse proxy's WebSocket-upgrade
// path would silently stop working and break the chat's Socket.IO connections.
type statusRecorder struct {
	http.ResponseWriter
	status int
	failed bool
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("underlying ResponseWriter does not support hijacking")
	}
	return hj.Hijack()
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// healthLoop decides which backends are eligible for traffic at all. A backend
// that fails a proxied request is marked down immediately by its ErrorHandler;
// this loop is what lets it back in once it answers again.
func (lb *LoadBalancer) healthLoop(interval, timeout time.Duration) {
	client := &http.Client{Timeout: timeout}

	for {
		for _, b := range lb.backends {
			resp, err := client.Get(strings.TrimRight(b.URL.String(), "/") + "/health")
			alive := err == nil && resp.StatusCode < 500
			if resp != nil {
				resp.Body.Close()
			}
			if was := b.Alive.Swap(alive); was != alive {
				log.Printf("backend %s health changed: alive=%v", b.URL, alive)
			}
		}
		time.Sleep(interval)
	}
}

// statsLoop pulls each backend's own view of itself — CPU, its internal queue
// depth, how many messages it holds. CPU in particular cannot be inferred from
// the balancer's side: a backend can look responsive right up to the point its
// cores saturate, and this is the warning.
func (lb *LoadBalancer) statsLoop(interval, timeout time.Duration) {
	client := &http.Client{Timeout: timeout}

	type statsResponse struct {
		CPUPercent float64 `json:"cpuPercent"`
		EwmaMs     float64 `json:"ewmaMs"`
		Store      struct {
			Messages int64 `json:"messages"`
		} `json:"store"`
	}

	for {
		for _, b := range lb.backends {
			resp, err := client.Get(strings.TrimRight(b.URL.String(), "/") + "/stats")
			if err != nil {
				continue
			}

			var parsed statsResponse
			decodeErr := json.NewDecoder(resp.Body).Decode(&parsed)
			resp.Body.Close()
			if decodeErr != nil {
				continue
			}

			b.cpuCentis.Store(int64(parsed.CPUPercent * 100))
			b.backendEwma.Store(int64(parsed.EwmaMs * 1000))
			b.StoredMsgs.Store(parsed.Store.Messages)
		}
		time.Sleep(interval)
	}
}

// --- listening on one port for both plain HTTP and TLS ---------------------
//
// The evaluation harness submits a plain http:// URL, while the chat client in
// a browser needs https:// for the Web Crypto signing keys it depends on. Each
// machine exposes exactly one port, so both have to arrive on the same one.
//
// They are trivially distinguishable: a TLS connection opens with a handshake
// record whose first byte is 0x16, and an HTTP request opens with an ASCII
// method name. Peeking that single byte is enough to hand the connection to
// the right server, with the peeked byte pushed back so neither server sees a
// truncated stream.

// Socket buffer sizes, in bytes. Small enough that a few thousand connections
// cannot exhaust the container, large enough to carry a compressed feed
// response without stalling.
var (
	socketReadBuffer  = 16 * 1024
	socketWriteBuffer = 32 * 1024
)

// capSocketBuffers pins a connection's kernel buffers instead of letting Linux
// auto-tune them.
//
// This is the memory the balancer was actually dying on. Go's heap limit does
// not cover it: send and receive buffers live in the kernel, are charged to
// this container's 512MB, and grow on their own as a connection gets busy. A
// thousand client connections plus the pool to the backends was enough to run
// the whole container out of memory, repeatedly, while the Go heap itself
// stayed small.
func capSocketBuffers(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	tcp.SetReadBuffer(socketReadBuffer)
	tcp.SetWriteBuffer(socketWriteBuffer)
}

type peekedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *peekedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}

// chanListener is a net.Listener fed by hand rather than by the kernel, so one
// real listener can drive two http.Servers.
type chanListener struct {
	conns  chan net.Conn
	addr   net.Addr
	closed chan struct{}
	once   sync.Once
}

func newChanListener(addr net.Addr) *chanListener {
	return &chanListener{
		conns:  make(chan net.Conn, 1024),
		addr:   addr,
		closed: make(chan struct{}),
	}
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *chanListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *chanListener) Addr() net.Addr { return l.addr }

func (l *chanListener) push(conn net.Conn) {
	select {
	case l.conns <- conn:
	case <-l.closed:
		conn.Close()
	}
}

func serveMultiplexed(addr string, handler http.Handler, certFile, keyFile string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}

	plainListener := newChanListener(listener.Addr())
	tlsListener := newChanListener(listener.Addr())

	newServer := func() *http.Server {
		return &http.Server{
			Handler: handler,
			// Only the header read is bounded. Bounding the whole request or
			// response would cut off long-lived WebSocket connections, which
			// are exactly what the chat depends on.
			ReadHeaderTimeout: 20 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
	}

	go func() {
		if err := newServer().Serve(plainListener); err != nil && err != net.ErrClosed {
			log.Printf("plain HTTP server stopped: %v", err)
		}
	}()

	go func() {
		if err := newServer().ServeTLS(tlsListener, certFile, keyFile); err != nil && err != net.ErrClosed {
			log.Printf("TLS server stopped: %v", err)
		}
	}()

	// Accept errors must never end the loop. Running out of descriptors, or
	// hitting a per-process connection limit, produces an error here that
	// clears on its own moments later — but returning it stops the balancer
	// accepting anything, for good. That is precisely what happened on the
	// first evaluation run: the service went from healthy to unreachable
	// mid-ladder and never came back, turning a load problem into an outage.
	//
	// So back off briefly and carry on, the way net/http's own Serve does.
	// Only a closed listener is terminal.
	var backoff time.Duration

	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return err
			}

			if backoff == 0 {
				backoff = 5 * time.Millisecond
			} else {
				backoff *= 2
			}
			if backoff > time.Second {
				backoff = time.Second
			}

			log.Printf("accept failed (%v); retrying in %v", err, backoff)
			time.Sleep(backoff)
			continue
		}
		backoff = 0

		// Linux auto-tunes socket buffers upward under load, and every byte of
		// that is charged to this container. Left alone, a few hundred busy
		// connections is enough to exhaust the whole 512MB budget.
		capSocketBuffers(conn)

		go func(conn net.Conn) {
			// One byte is all this reads. The default 4KB buffer, multiplied by
			// every concurrent connection, is memory spent for nothing — the
			// http server allocates its own buffers behind this.
			reader := bufio.NewReaderSize(conn, 64)
			// A slow or empty connection must not hold this goroutine forever.
			conn.SetReadDeadline(time.Now().Add(20 * time.Second))
			first, err := reader.Peek(1)
			conn.SetReadDeadline(time.Time{})
			if err != nil {
				conn.Close()
				return
			}

			wrapped := &peekedConn{Conn: conn, reader: reader}
			if first[0] == 0x16 {
				tlsListener.push(wrapped)
			} else {
				plainListener.push(wrapped)
			}
		}(conn)
	}
}

func main() {
	backendsFlag := flag.String("backends", "", "comma-separated backend base URLs, e.g. http://10.1.75.53:3266,http://10.1.75.53:3267")
	listenAddr := flag.String("listen", ":3000", "address the load balancer listens on")
	healthInterval := flag.Duration("health-interval", 1*time.Second, "interval between backend health checks")
	healthTimeout := flag.Duration("health-timeout", 2*time.Second, "timeout for a single health check")
	statsInterval := flag.Duration("stats-interval", 400*time.Millisecond, "interval between backend stats polls")
	statsTimeout := flag.Duration("stats-timeout", 1*time.Second, "timeout for a single stats poll")
	backendTimeout := flag.Duration("backend-timeout", 15*time.Second, "how long to wait for a backend's response headers")
	dialTimeout := flag.Duration("dial-timeout", 2*time.Second, "timeout connecting to a backend")
	threshold := flag.Float64("load-threshold", 4.0, "load score above which traffic switches to another backend")
	wInFlight := flag.Float64("w-inflight", 1.0, "score weight for one outstanding request")
	wLatency := flag.Float64("w-latency", 0.05, "score weight per millisecond of smoothed latency")
	wCPU := flag.Float64("w-cpu", 0.10, "score weight per percent of backend CPU")
	maxIdlePerHost := flag.Int("max-idle-per-host", 256, "idle keep-alive connections kept per backend")
	flag.IntVar(&socketReadBuffer, "socket-read-buffer", socketReadBuffer, "per-connection kernel read buffer, bytes")
	flag.IntVar(&socketWriteBuffer, "socket-write-buffer", socketWriteBuffer, "per-connection kernel write buffer, bytes")
	tlsCert := flag.String("tls-cert", "", "TLS certificate; with -tls-key, the same port also serves HTTPS")
	tlsKey := flag.String("tls-key", "", "TLS certificate private key")
	flag.Parse()

	if *backendsFlag == "" {
		log.Fatal("at least one -backends URL is required")
	}

	// Before anything opens a socket or allocates.
	raiseFileLimit()
	applyMemoryLimit()

	dialer := &net.Dialer{
		Timeout:   *dialTimeout,
		KeepAlive: 30 * time.Second,
	}

	transport := &http.Transport{
		// Connections to the backends get their buffers capped too. The pool
		// below holds a lot of them, and each one's kernel buffers count
		// against the same container budget as the client connections do.
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			capSocketBuffers(conn)
			return conn, nil
		},
		ResponseHeaderTimeout: *backendTimeout,
		// The default of 2 idle connections per host means almost every request
		// under load pays for a fresh TCP handshake. At a thousand concurrent
		// clients that cost dominates everything the backend actually does.
		MaxIdleConnsPerHost: *maxIdlePerHost,
		MaxIdleConns:        *maxIdlePerHost * 4,
		IdleConnTimeout:     90 * time.Second,
		// Let the client's own Accept-Encoding reach the backend and its
		// compressed response come back untouched. Without this, Go would
		// transparently decompress every /feed response here and the client
		// would receive it uncompressed — paying for the compression twice and
		// sending far more bytes than necessary.
		DisableCompression: true,
		ForceAttemptHTTP2:  false,
	}

	lb := &LoadBalancer{
		metrics: newMetrics(65536),
		weights: Weights{InFlight: *wInFlight, Latency: *wLatency, CPU: *wCPU},
	}
	lb.SetThreshold(*threshold)

	for _, part := range strings.Split(*backendsFlag, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		target, err := url.Parse(part)
		if err != nil {
			log.Fatalf("invalid backend URL %q: %v", part, err)
		}

		b := &Backend{URL: target}
		b.Alive.Store(true)

		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.Transport = transport
		proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, err error) {
			// Fires for connection-establishment failures, before anything has
			// been written to the client, so the request can still be retried
			// against another backend.
			b.Alive.Store(false)
			lb.metrics.BackendErrors.Add(1)
			if rec, ok := rw.(*statusRecorder); ok {
				rec.failed = true
				return
			}
			http.Error(rw, "backend unavailable", http.StatusBadGateway)
		}
		b.proxy = proxy

		lb.backends = append(lb.backends, b)
	}

	if len(lb.backends) == 0 {
		log.Fatal("no usable backends were parsed")
	}
	lb.current.Store(lb.backends[0])

	go lb.healthLoop(*healthInterval, *healthTimeout)
	go lb.statsLoop(*statsInterval, *statsTimeout)
	startCPUSampling(500 * time.Millisecond)

	log.Printf(
		"load balancer on %s | backends=%d threshold=%.2f weights(inflight=%.2f latency=%.3f cpu=%.2f) gomaxprocs=%d",
		*listenAddr, len(lb.backends), lb.Threshold(), lb.weights.InFlight, lb.weights.Latency, lb.weights.CPU,
		applyCPUQuota(),
	)

	if *tlsCert != "" && *tlsKey != "" {
		log.Printf("serving plain HTTP and HTTPS on the same port")
		if err := serveMultiplexed(*listenAddr, lb, *tlsCert, *tlsKey); err != nil {
			log.Fatal(err)
		}
		return
	}

	server := &http.Server{
		Addr:              *listenAddr,
		Handler:           lb,
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(fmt.Sprintf("server stopped: %v", err))
	}
}
