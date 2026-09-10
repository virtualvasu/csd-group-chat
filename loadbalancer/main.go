// Command loadbalancer is a round-robin, health-aware reverse proxy in front
// of one or more copies of the csd-group-chat messaging backend.
//
// It is deployed on Sys1 and forwards to backend copies of server.js running
// on Sys2, Sys3 and Sys4 (each pointed at the same MongoDB cluster and the
// same CHAT_ENCRYPTION_KEY, so they all read/write the same chat history).
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Backend is one messaging-app instance the load balancer can forward to.
type Backend struct {
	URL      *url.URL
	Alive    atomic.Bool
	InFlight atomic.Int64
	proxy    *httputil.ReverseProxy

	// consecutiveHealthFailures counts back-to-back failed active health
	// checks. A backend under heavy but legitimate load can occasionally miss
	// the health check's timeout without actually being down — Node runs the
	// health handler on the same single-threaded event loop as every other
	// request, so a burst of concurrent traffic can transiently delay it past
	// the deadline. Requiring several failures in a row before flipping Alive
	// to false (see healthLoop) avoids a single slow response taking a
	// working backend out of rotation, which would only pile its load onto
	// the remaining backends and risk cascading the same problem to them.
	consecutiveHealthFailures atomic.Int64
}

// Metrics are the load balancer's own request counters, independent of
// whatever a load generator records client-side. Exposed at /lb/metrics.
type Metrics struct {
	Total         atomic.Uint64
	Success       atomic.Uint64
	Failed        atomic.Uint64
	BackendErrors atomic.Uint64

	mu         sync.Mutex
	latencies  []time.Duration
	maxSamples int
}

func (m *Metrics) record(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.latencies) >= m.maxSamples {
		// Drop the oldest sample so long-running processes do not grow this
		// slice without bound.
		m.latencies = m.latencies[1:]
	}
	m.latencies = append(m.latencies, d)
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p * float64(len(sorted)-1))
	return sorted[idx]
}

func (m *Metrics) snapshot() map[string]any {
	m.mu.Lock()
	latencies := append([]time.Duration(nil), m.latencies...)
	m.mu.Unlock()

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	toMs := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000.0 }

	return map[string]any{
		"total":          m.Total.Load(),
		"success":        m.Success.Load(),
		"failed":         m.Failed.Load(),
		"backend_errors": m.BackendErrors.Load(),
		"p50_ms":         toMs(percentile(latencies, 0.50)),
		"p95_ms":         toMs(percentile(latencies, 0.95)),
		"p99_ms":         toMs(percentile(latencies, 0.99)),
	}
}

// LoadBalancer holds the backend list and the shared round-robin cursor.
type LoadBalancer struct {
	backends []*Backend
	next     atomic.Uint64
	metrics  *Metrics

	// OverloadThreshold is the in-flight-request count at or above which a
	// backend is treated as overloaded: still eligible if nothing better is
	// available, but never preferred over a less-loaded one. 0 disables
	// this (pure least-connections, no threshold-based demotion). See
	// REPORT.md for how this value was picked.
	OverloadThreshold int64
}

// candidateBackends returns every currently-healthy backend, ordered
// least-loaded first (by current in-flight request count — the load signal
// the load balancer already has for free, with no backend cooperation
// needed). Callers try them in this order, falling through to the next one
// if a request fails.
//
// This is performance-based dynamic selection, not fixed round-robin: which
// backend is "first" changes request to request as load shifts between
// them. A backend at or above OverloadThreshold is pushed to the back of the
// list — still used as a last resort so a request is never dropped while any
// backend is alive, but only after every less-loaded backend has been tried.
// The round-robin cursor still rotates the starting point on each call so
// that backends sitting at equal load (e.g. all idle) are spread across
// evenly instead of always favoring the same one.
func (lb *LoadBalancer) candidateBackends() []*Backend {
	n := len(lb.backends)
	if n == 0 {
		return nil
	}
	start := int(lb.next.Add(1) % uint64(n))

	type scored struct {
		backend  *Backend
		inFlight int64
	}
	alive := make([]scored, 0, n)
	for i := 0; i < n; i++ {
		b := lb.backends[(start+i)%n]
		if b.Alive.Load() {
			alive = append(alive, scored{backend: b, inFlight: b.InFlight.Load()})
		}
	}

	sort.SliceStable(alive, func(i, j int) bool {
		iOverloaded := lb.OverloadThreshold > 0 && alive[i].inFlight >= lb.OverloadThreshold
		jOverloaded := lb.OverloadThreshold > 0 && alive[j].inFlight >= lb.OverloadThreshold
		if iOverloaded != jOverloaded {
			return !iOverloaded
		}
		return alive[i].inFlight < alive[j].inFlight
	})

	candidates := make([]*Backend, len(alive))
	for i, s := range alive {
		candidates[i] = s.backend
	}
	return candidates
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
	}

	lb.metrics.Total.Add(1)

	candidates := lb.candidateBackends()
	if len(candidates) == 0 {
		lb.metrics.Failed.Add(1)
		http.Error(w, "no healthy backend available", http.StatusServiceUnavailable)
		return
	}

	// Buffer the request body once (it is a stream and can only be read a
	// single time) so it can be replayed if the first backend tried fails
	// before we've committed a response, letting us retry against the next
	// healthy candidate instead of failing the whole request.
	var bodyBytes []byte
	if r.Body != nil && r.Body != http.NoBody {
		bodyBytes, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}

	start := time.Now()
	var rec *statusRecorder
	for _, backend := range candidates {
		if bodyBytes != nil {
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			r.ContentLength = int64(len(bodyBytes))
		}

		backend.InFlight.Add(1)
		rec = &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		backend.proxy.ServeHTTP(rec, r)
		backend.InFlight.Add(-1)

		if !rec.failed {
			break
		}
		// This backend's ErrorHandler marked the attempt failed without
		// writing anything to the client (see below) — safe to retry the
		// next candidate. Once a response has actually started streaming to
		// the client this loop is not reached again, since ServeHTTP has
		// already returned by then.
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
		URL        string `json:"url"`
		Alive      bool   `json:"alive"`
		InFlight   int64  `json:"in_flight"`
		Overloaded bool   `json:"overloaded"`
	}
	out := struct {
		OverloadThreshold int64           `json:"overload_threshold"`
		Backends          []backendStatus `json:"backends"`
	}{OverloadThreshold: lb.OverloadThreshold}
	for _, b := range lb.backends {
		inFlight := b.InFlight.Load()
		out.Backends = append(out.Backends, backendStatus{
			URL:        b.URL.String(),
			Alive:      b.Alive.Load(),
			InFlight:   inFlight,
			Overloaded: lb.OverloadThreshold > 0 && inFlight >= lb.OverloadThreshold,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// statusRecorder captures the status code the backend responded with, since
// the standard ResponseWriter does not expose it after the fact. It also
// gives a backend's ErrorHandler a way to report failure (see below)
// without writing to the real client, so LoadBalancer.ServeHTTP can retry a
// different backend instead of the error being final.
//
// It forwards Hijack explicitly because embedding only promotes the methods
// declared on the http.ResponseWriter interface itself; without this, the
// reverse proxy's WebSocket-upgrade path (which type-asserts for
// http.Hijacker) would silently stop working and break the live chat's
// Socket.IO connections whenever they go through the load balancer.
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

// healthLoop polls every backend's /health endpoint on a fixed interval and
// flips Alive accordingly. A backend that starts failing proxied requests is
// also marked dead immediately by the reverse proxy's ErrorHandler below;
// this loop is what brings it back once it recovers.
//
// A backend is marked dead only after failThreshold consecutive failed
// checks, but returns to alive on the very first success. One slow health
// check under a real traffic spike (see the comment on
// Backend.consecutiveHealthFailures) should not be enough to pull a working
// backend out of rotation; several in a row, on the other hand, is a real
// signal something is actually wrong.
func (lb *LoadBalancer) healthLoop(interval, timeout time.Duration, failThreshold int64) {
	client := &http.Client{Timeout: timeout}
	for {
		for _, b := range lb.backends {
			healthURL := strings.TrimRight(b.URL.String(), "/") + "/health"
			resp, err := client.Get(healthURL)
			healthy := err == nil && resp.StatusCode < 500
			if resp != nil {
				resp.Body.Close()
			}

			var alive bool
			if healthy {
				b.consecutiveHealthFailures.Store(0)
				alive = true
			} else {
				failures := b.consecutiveHealthFailures.Add(1)
				alive = failures < failThreshold
			}

			was := b.Alive.Swap(alive)
			if was != alive {
				log.Printf("backend %s health changed: alive=%v", b.URL, alive)
			}
		}
		time.Sleep(interval)
	}
}

func main() {
	backendsFlag := flag.String("backends", "", "comma-separated list of backend base URLs, e.g. http://sys2:4000,http://sys3:4000,http://sys4:4000")
	listenAddr := flag.String("listen", ":8080", "address the load balancer listens on")
	healthInterval := flag.Duration("health-interval", 1*time.Second, "interval between backend health checks")
	healthTimeout := flag.Duration("health-timeout", 1500*time.Millisecond, "timeout for a single health check request")
	healthFailThreshold := flag.Int64("health-fail-threshold", 3, "consecutive failed health checks required before a backend is marked dead; it returns to alive on the first success")
	backendTimeout := flag.Duration("backend-timeout", 3*time.Second, "timeout waiting for a backend's response headers")
	dialTimeout := flag.Duration("dial-timeout", 800*time.Millisecond, "timeout connecting to a backend")
	maxInFlight := flag.Int64("max-inflight", 8, "in-flight requests on a backend at or above which it is treated as overloaded and only used if no less-loaded backend is available; 0 disables this")
	tlsCert := flag.String("tls-cert", "", "path to a TLS certificate file; if set with -tls-key, serve HTTPS instead of plain HTTP")
	tlsKey := flag.String("tls-key", "", "path to the TLS certificate's private key file")
	flag.Parse()

	if *backendsFlag == "" {
		log.Fatal("at least one -backends URL is required")
	}

	// Response-header timeout only bounds how long we wait for the backend
	// to start responding; it does NOT cut off the connection afterwards.
	// That distinction matters here because the backend also serves
	// long-lived Socket.IO / WebSocket connections for the live chat, which
	// must be allowed to stay open for as long as the client is connected.
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout: *dialTimeout,
		}).DialContext,
		ResponseHeaderTimeout: *backendTimeout,
	}

	lb := &LoadBalancer{
		metrics:           &Metrics{maxSamples: 100_000},
		OverloadThreshold: *maxInFlight,
	}

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
			// This fires for connection-establishment failures — dial
			// errors, response-header timeouts — before any part of a
			// response has been written to the real client. That means it
			// is safe to leave rw untouched and let ServeHTTP's retry loop
			// try the next healthy backend instead of failing the request
			// outright. (It is only ever unsafe to retry after headers have
			// already been committed to the client, which is not the case
			// here — see the retry loop in LoadBalancer.ServeHTTP.)
			//
			// Shares consecutiveHealthFailures with healthLoop rather than
			// flipping Alive on a single failure: under a real traffic spike
			// a backend can miss one request's deadline while still being
			// genuinely up, and marking it dead immediately would only dump
			// its share of the load onto the remaining backends and risk the
			// same failure cascading to them.
			failures := b.consecutiveHealthFailures.Add(1)
			if failures >= *healthFailThreshold {
				b.Alive.Store(false)
			}
			lb.metrics.BackendErrors.Add(1)
			log.Printf("backend %s error: %v", b.URL, err)
			if rec, ok := rw.(*statusRecorder); ok {
				rec.failed = true
				return
			}
			// Should not normally happen — ServeHTTP always passes a
			// *statusRecorder — but fail safe rather than hang the client.
			http.Error(rw, "backend unavailable", http.StatusBadGateway)
		}
		b.proxy = proxy

		lb.backends = append(lb.backends, b)
	}

	go lb.healthLoop(*healthInterval, *healthTimeout, *healthFailThreshold)

	// TLS terminates here, at the load balancer, and traffic to the
	// backends stays plain HTTP — the browser only needs a secure context
	// (required for the chat client's Web Crypto signing keys) up to this
	// edge, and the backends are all on the same trusted internal network.
	if *tlsCert != "" && *tlsKey != "" {
		log.Printf("load balancer listening on %s (TLS), backends: %v, max-inflight: %d", *listenAddr, *backendsFlag, *maxInFlight)
		if err := http.ListenAndServeTLS(*listenAddr, *tlsCert, *tlsKey, lb); err != nil {
			log.Fatal(err)
		}
		return
	}

	log.Printf("load balancer listening on %s, backends: %v, max-inflight: %d", *listenAddr, *backendsFlag, *maxInFlight)
	if err := http.ListenAndServe(*listenAddr, lb); err != nil {
		log.Fatal(err)
	}
}
