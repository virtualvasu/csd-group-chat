// Command loadbalancer is a round-robin, health-aware reverse proxy in front
// of one or more copies of the csd-group-chat messaging backend.
//
// It is deployed on Sys1 and forwards to backend copies of server.js running
// on Sys2, Sys3 and Sys4 (each pointed at the same MongoDB cluster and the
// same CHAT_ENCRYPTION_KEY, so they all read/write the same chat history).
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
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
}

// nextBackend walks the backend list starting from the shared cursor and
// returns the first healthy one. It never loops more than once around the
// list, so an all-unhealthy pool returns nil instead of spinning forever.
func (lb *LoadBalancer) nextBackend() *Backend {
	n := len(lb.backends)
	if n == 0 {
		return nil
	}
	for i := 0; i < n; i++ {
		index := lb.next.Add(1) % uint64(n)
		b := lb.backends[index]
		if b.Alive.Load() {
			return b
		}
	}
	return nil
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

	backend := lb.nextBackend()
	if backend == nil {
		lb.metrics.Failed.Add(1)
		http.Error(w, "no healthy backend available", http.StatusServiceUnavailable)
		return
	}

	backend.InFlight.Add(1)
	defer backend.InFlight.Add(-1)

	start := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	backend.proxy.ServeHTTP(rec, r)
	lb.metrics.record(time.Since(start))

	if rec.status >= 500 {
		lb.metrics.Failed.Add(1)
	} else {
		lb.metrics.Success.Add(1)
	}
}

func (lb *LoadBalancer) writeStatus(w http.ResponseWriter) {
	type backendStatus struct {
		URL      string `json:"url"`
		Alive    bool   `json:"alive"`
		InFlight int64  `json:"in_flight"`
	}
	out := struct {
		Backends []backendStatus `json:"backends"`
	}{}
	for _, b := range lb.backends {
		out.Backends = append(out.Backends, backendStatus{
			URL:      b.URL.String(),
			Alive:    b.Alive.Load(),
			InFlight: b.InFlight.Load(),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// statusRecorder captures the status code the backend responded with, since
// the standard ResponseWriter does not expose it after the fact.
//
// It forwards Hijack explicitly because embedding only promotes the methods
// declared on the http.ResponseWriter interface itself; without this, the
// reverse proxy's WebSocket-upgrade path (which type-asserts for
// http.Hijacker) would silently stop working and break the live chat's
// Socket.IO connections whenever they go through the load balancer.
type statusRecorder struct {
	http.ResponseWriter
	status int
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
func (lb *LoadBalancer) healthLoop(interval, timeout time.Duration) {
	client := &http.Client{Timeout: timeout}
	for {
		for _, b := range lb.backends {
			healthURL := strings.TrimRight(b.URL.String(), "/") + "/health"
			resp, err := client.Get(healthURL)
			alive := err == nil && resp.StatusCode < 500
			if resp != nil {
				resp.Body.Close()
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
	healthTimeout := flag.Duration("health-timeout", 800*time.Millisecond, "timeout for a single health check request")
	backendTimeout := flag.Duration("backend-timeout", 800*time.Millisecond, "timeout waiting for a backend's response headers")
	dialTimeout := flag.Duration("dial-timeout", 800*time.Millisecond, "timeout connecting to a backend")
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
		metrics: &Metrics{maxSamples: 100_000},
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
			// Failed/Success are tallied once, from the response status,
			// after ServeHTTP returns (see LoadBalancer.ServeHTTP) — this
			// handler only needs to flip health state and count the
			// backend-specific error, or the request would be double
			// counted as failed.
			b.Alive.Store(false)
			lb.metrics.BackendErrors.Add(1)
			log.Printf("backend %s error: %v", b.URL, err)
			http.Error(rw, "backend unavailable", http.StatusBadGateway)
		}
		b.proxy = proxy

		lb.backends = append(lb.backends, b)
	}

	go lb.healthLoop(*healthInterval, *healthTimeout)

	log.Printf("load balancer listening on %s, backends: %v", *listenAddr, *backendsFlag)
	if err := http.ListenAndServe(*listenAddr, lb); err != nil {
		log.Fatal(err)
	}
}
