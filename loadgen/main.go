// Command loadgen simulates a variable number of chat users posting
// variable-length messages at variable time intervals to the /message route,
// and reports throughput, dropout rate and latency percentiles. It is meant
// to run on the local PC, driving load at the Sys1 load balancer (or
// directly at a single backend, for the single-backend experiment).
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type result struct {
	Experiment     string  `json:"experiment"`
	Requests       int     `json:"requests"`
	Concurrency    int     `json:"concurrency"`
	Users          int     `json:"users"`
	Successful     uint64  `json:"successful"`
	Failed         uint64  `json:"failed"`
	ThroughputRPS  float64 `json:"throughput_rps"`
	DropoutPercent float64 `json:"dropout_percent"`
	P50Ms          float64 `json:"p50_ms"`
	P95Ms          float64 `json:"p95_ms"`
	P99Ms          float64 `json:"p99_ms"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p * float64(len(sorted)-1))
	return sorted[idx]
}

const msgCharset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "

// randomMessage returns a random printable string with length uniformly
// chosen in [minLen, maxLen], so runs exercise variable message sizes rather
// than one fixed payload.
func randomMessage(minLen, maxLen int) string {
	if maxLen < minLen {
		maxLen = minLen
	}
	n := minLen
	if maxLen > minLen {
		n += rand.Intn(maxLen - minLen + 1)
	}

	b := make([]byte, n)
	for i := range b {
		b[i] = msgCharset[rand.Intn(len(msgCharset))]
	}
	return string(b)
}

// randomInterval returns a random duration uniformly chosen in
// [minMs, maxMs], used as the think-time before a simulated user sends its
// next message.
func randomInterval(minMs, maxMs int) time.Duration {
	if maxMs < minMs {
		maxMs = minMs
	}
	ms := minMs
	if maxMs > minMs {
		ms += rand.Intn(maxMs - minMs + 1)
	}
	return time.Duration(ms) * time.Millisecond
}

func main() {
	targetURL := flag.String("url", "", "base URL of the load balancer (or a single backend), e.g. http://sys1:8080")
	requests := flag.Int("requests", 1000, "total number of /message requests to send across all simulated users")
	concurrency := flag.Int("concurrency", 20, "number of concurrent workers")
	users := flag.Int("users", 20, "number of distinct simulated client-name identities messages are randomly attributed to")
	minMsgLen := flag.Int("min-msg-len", 5, "minimum random message length in characters")
	maxMsgLen := flag.Int("max-msg-len", 200, "maximum random message length in characters")
	minIntervalMs := flag.Int("min-interval-ms", 0, "minimum random per-worker delay before sending its next message, in ms")
	maxIntervalMs := flag.Int("max-interval-ms", 500, "maximum random per-worker delay before sending its next message, in ms")
	timeout := flag.Duration("timeout", 5*time.Second, "per-request timeout")
	experiment := flag.String("experiment", "run", "label for this experiment, used in output filenames/rows")
	outPath := flag.String("out", "", "optional path to write a per-experiment JSON result file")
	csvPath := flag.String("csv", "", "optional path to a cumulative CSV comparison table (appended to)")
	insecure := flag.Bool("insecure", false, "skip TLS certificate verification, for the load balancer's self-signed cert")
	flag.Parse()

	if *targetURL == "" {
		log.Fatal("-url is required")
	}
	if *requests <= 0 || *concurrency <= 0 || *users <= 0 {
		log.Fatal("-requests, -concurrency and -users must be positive")
	}
	if *minMsgLen <= 0 || *maxMsgLen <= 0 {
		log.Fatal("-min-msg-len and -max-msg-len must be positive")
	}

	messageURL := strings.TrimRight(*targetURL, "/") + "/message"

	client := &http.Client{Timeout: *timeout}
	if *insecure {
		// The load balancer serves a self-signed certificate, which the
		// default transport rejects. Without this every request fails at the
		// handshake and is counted as a dropout, which looks exactly like a
		// saturated backend in the results.
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}
	}

	jobs := make(chan int, *requests)
	for i := 0; i < *requests; i++ {
		jobs <- i
	}
	close(jobs)

	var successful, failed atomic.Uint64
	var firstErrOnce sync.Once
	var firstErr error
	latencies := make([]time.Duration, 0, *requests)
	var latMu sync.Mutex

	var wg sync.WaitGroup
	start := time.Now()

	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for range jobs {
				// Random think-time between messages, so requests do not all
				// arrive in one synchronized burst per worker.
				if *maxIntervalMs > 0 {
					time.Sleep(randomInterval(*minIntervalMs, *maxIntervalMs))
				}

				clientName := fmt.Sprintf("loadgen-user-%d", rand.Intn(*users))
				msg := randomMessage(*minMsgLen, *maxMsgLen)
				id := fmt.Sprintf("%d-%d-%d", workerID, time.Now().UnixNano(), rand.Int63())

				body, _ := json.Marshal(map[string]string{
					"client-name": clientName,
					"msg":         msg,
					"id":          id,
				})

				reqStart := time.Now()
				resp, err := client.Post(messageURL, "application/json", bytes.NewReader(body))
				elapsed := time.Since(reqStart)

				ok := err == nil
				if err != nil {
					firstErrOnce.Do(func() { firstErr = err })
				}
				if resp != nil {
					// Drain and close so the connection can be reused by the
					// client's transport instead of piling up new dials.
					_, _ = discard(resp)
					ok = ok && resp.StatusCode >= 200 && resp.StatusCode < 400
					resp.Body.Close()
				}

				if ok {
					successful.Add(1)
				} else {
					failed.Add(1)
				}

				latMu.Lock()
				latencies = append(latencies, elapsed)
				latMu.Unlock()
			}
		}(w)
	}

	wg.Wait()
	elapsed := time.Since(start)

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	toMs := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000.0 }

	succ := successful.Load()
	fail := failed.Load()
	total := succ + fail

	r := result{
		Experiment:     *experiment,
		Requests:       *requests,
		Concurrency:    *concurrency,
		Users:          *users,
		Successful:     succ,
		Failed:         fail,
		ThroughputRPS:  float64(succ) / elapsed.Seconds(),
		DropoutPercent: 100 * float64(fail) / float64(total),
		P50Ms:          toMs(percentile(latencies, 0.50)),
		P95Ms:          toMs(percentile(latencies, 0.95)),
		P99Ms:          toMs(percentile(latencies, 0.99)),
		ElapsedSeconds: elapsed.Seconds(),
	}

	printSummary(r)

	// A run that failed outright is far more often a bad target or a rejected
	// certificate than a real dropout. Say so, rather than letting a broken
	// setup be written into the results as data.
	if fail > 0 && firstErr != nil {
		fmt.Printf("  first error: %v\n", firstErr)
	}

	if *outPath != "" {
		writeJSON(*outPath, r)
	}
	if *csvPath != "" {
		appendCSV(*csvPath, r)
	}
}

func discard(resp *http.Response) (int64, error) {
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, err := resp.Body.Read(buf)
		total += int64(n)
		if err != nil {
			break
		}
	}
	return total, nil
}

func printSummary(r result) {
	fmt.Printf("experiment=%s requests=%d concurrency=%d users=%d\n", r.Experiment, r.Requests, r.Concurrency, r.Users)
	fmt.Printf("  successful=%d failed=%d dropout=%.2f%%\n", r.Successful, r.Failed, r.DropoutPercent)
	fmt.Printf("  throughput=%.1f rps  (elapsed %.2fs)\n", r.ThroughputRPS, r.ElapsedSeconds)
	fmt.Printf("  p50=%.1fms p95=%.1fms p99=%.1fms\n", r.P50Ms, r.P95Ms, r.P99Ms)
}

func writeJSON(path string, r result) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatalf("could not create %s: %v", path, err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(r); err != nil {
		log.Fatalf("could not write %s: %v", path, err)
	}
}

var csvHeader = []string{
	"experiment", "requests", "concurrency", "users", "successful", "failed",
	"throughput_rps", "dropout_percent", "p50_ms", "p95_ms", "p99_ms", "elapsed_seconds",
}

func appendCSV(path string, r result) {
	_, statErr := os.Stat(path)
	needsHeader := os.IsNotExist(statErr)

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Fatalf("could not open %s: %v", path, err)
	}
	defer f.Close()

	w := csv.NewWriter(f)
	defer w.Flush()

	if needsHeader {
		if err := w.Write(csvHeader); err != nil {
			log.Fatalf("could not write CSV header: %v", err)
		}
	}

	row := []string{
		r.Experiment,
		fmt.Sprint(r.Requests),
		fmt.Sprint(r.Concurrency),
		fmt.Sprint(r.Users),
		fmt.Sprint(r.Successful),
		fmt.Sprint(r.Failed),
		fmt.Sprintf("%.2f", r.ThroughputRPS),
		fmt.Sprintf("%.2f", r.DropoutPercent),
		fmt.Sprintf("%.2f", r.P50Ms),
		fmt.Sprintf("%.2f", r.P95Ms),
		fmt.Sprintf("%.2f", r.P99Ms),
		fmt.Sprintf("%.2f", r.ElapsedSeconds),
	}
	if err := w.Write(row); err != nil {
		log.Fatalf("could not write CSV row: %v", err)
	}
}
