// Command loadgen fires a fixed number of concurrent HTTP GET requests at a
// target URL and reports throughput, dropout rate and latency percentiles.
// It is meant to run on the local PC, driving load at the Sys1 load balancer
// (or directly at a single backend, for the single-backend experiment).
package main

import (
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type result struct {
	Experiment        string  `json:"experiment"`
	Requests          int     `json:"requests"`
	Concurrency       int     `json:"concurrency"`
	Successful        uint64  `json:"successful"`
	Failed            uint64  `json:"failed"`
	ThroughputRPS     float64 `json:"throughput_rps"`
	DropoutPercent    float64 `json:"dropout_percent"`
	P50Ms             float64 `json:"p50_ms"`
	P95Ms             float64 `json:"p95_ms"`
	P99Ms             float64 `json:"p99_ms"`
	ElapsedSeconds    float64 `json:"elapsed_seconds"`
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p * float64(len(sorted)-1))
	return sorted[idx]
}

func main() {
	targetURL := flag.String("url", "", "target URL to load, e.g. http://sys1:8080/")
	requests := flag.Int("requests", 1000, "total number of requests to send")
	concurrency := flag.Int("concurrency", 20, "number of concurrent workers")
	timeout := flag.Duration("timeout", 5*time.Second, "per-request timeout")
	experiment := flag.String("experiment", "run", "label for this experiment, used in output filenames/rows")
	outPath := flag.String("out", "", "optional path to write a per-experiment JSON result file")
	csvPath := flag.String("csv", "", "optional path to a cumulative CSV comparison table (appended to)")
	flag.Parse()

	if *targetURL == "" {
		log.Fatal("-url is required")
	}
	if *requests <= 0 || *concurrency <= 0 {
		log.Fatal("-requests and -concurrency must be positive")
	}

	client := &http.Client{Timeout: *timeout}

	jobs := make(chan int, *requests)
	for i := 0; i < *requests; i++ {
		jobs <- i
	}
	close(jobs)

	var successful, failed atomic.Uint64
	latencies := make([]time.Duration, 0, *requests)
	var latMu sync.Mutex

	var wg sync.WaitGroup
	start := time.Now()

	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				reqStart := time.Now()
				resp, err := client.Get(*targetURL)
				elapsed := time.Since(reqStart)

				ok := err == nil
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
		}()
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
	fmt.Printf("experiment=%s requests=%d concurrency=%d\n", r.Experiment, r.Requests, r.Concurrency)
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
	"experiment", "requests", "concurrency", "successful", "failed",
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
