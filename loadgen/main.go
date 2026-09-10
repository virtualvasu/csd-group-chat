// Command loadgen drives concurrent load at the load balancer and records what
// came back, so the deployment can be tuned without waiting on the official
// evaluation run.
//
// It models users rather than bare requests: a configurable number of them,
// each sending messages of random length at random intervals, mixing posts to
// /message with reads of /feed. Alongside the response times it samples every
// machine's own /stats endpoint, so a run produces both halves of what the
// report needs — latency and system utilisation across all four systems.
//
// Modes:
//
//	steady      a fixed number of users for a fixed duration or request budget
//	ladder      a fixed ladder of user counts, a request budget per stage
//	breakpoint  a rising ladder that stops once a stage exceeds an error rate
package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type stageResult struct {
	Stage          int     `json:"stage"`
	Users          int     `json:"users"`
	Requests       int     `json:"requests"`
	Successful     uint64  `json:"successful"`
	Failed         uint64  `json:"failed"`
	Posts          uint64  `json:"posts"`
	Feeds          uint64  `json:"feeds"`
	ThroughputRPS  float64 `json:"throughput_rps"`
	ErrorPercent   float64 `json:"error_percent"`
	MeanMs         float64 `json:"mean_ms"`
	P50Ms          float64 `json:"p50_ms"`
	P95Ms          float64 `json:"p95_ms"`
	P99Ms          float64 `json:"p99_ms"`
	ElapsedSeconds float64 `json:"elapsed_seconds"`
}

type runResult struct {
	Experiment  string        `json:"experiment"`
	Mode        string        `json:"mode"`
	Target      string        `json:"target"`
	FeedRatio   float64       `json:"feed_ratio"`
	Stages      []stageResult `json:"stages"`
	TotalOK     uint64        `json:"total_successful"`
	TotalFailed uint64        `json:"total_failed"`
	MeanMs      float64       `json:"mean_ms_overall"`
	BrokeAt     int           `json:"broke_at_users"`
}

// A machine to sample utilisation from, e.g. sys2=http://10.1.75.53:3266/stats
type system struct {
	name string
	url  string
}

type sample struct {
	elapsed  float64
	users    int
	rps      float64
	meanMs   float64
	inFlight int64
	cpu      map[string]float64
}

var (
	words = strings.Fields(`the quick brown fox jumps over a lazy dog while distributed systems
		balance load across replicas and persist every message exactly once even when
		clients retry reconnect or fail midway through a request under heavy concurrency`)
)

func main() {
	target := flag.String("url", "", "base URL of the load balancer, e.g. http://10.1.75.53:3265")
	mode := flag.String("mode", "ladder", "steady | ladder | breakpoint")
	stagesFlag := flag.String("stages", "", "comma-separated user counts; defaults depend on mode")
	users := flag.Int("users", 100, "concurrent users (steady mode)")
	perStage := flag.Int("requests", 5000, "request budget per stage")
	duration := flag.Duration("duration", 0, "steady mode: run for this long instead of a request budget")
	feedRatio := flag.Float64("feed-ratio", 0.2, "fraction of requests that read /feed instead of posting")
	minLen := flag.Int("min-msg-len", 20, "minimum message length in characters")
	maxLen := flag.Int("max-msg-len", 280, "maximum message length in characters")
	minInterval := flag.Duration("min-interval", 0, "minimum think time between one user's requests")
	maxInterval := flag.Duration("max-interval", 0, "maximum think time between one user's requests")
	timeout := flag.Duration("timeout", 15*time.Second, "per-request timeout")
	errorLimit := flag.Float64("error-limit", 20, "breakpoint mode: stop once a stage exceeds this error percent")
	experiment := flag.String("experiment", "run", "label used in the output files")
	systemsFlag := flag.String("systems", "", "name=statsURL pairs to sample utilisation from, comma separated")
	sampleInterval := flag.Duration("sample-interval", 1*time.Second, "how often to sample utilisation")
	outDir := flag.String("out-dir", "results", "directory for the result files")
	flag.Parse()

	if *target == "" {
		log.Fatal("-url is required")
	}
	if *maxLen < *minLen {
		log.Fatal("-max-msg-len must not be smaller than -min-msg-len")
	}

	base := strings.TrimRight(*target, "/")
	stages := resolveStages(*mode, *stagesFlag, *users)
	systems := parseSystems(*systemsFlag)

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatalf("could not create %s: %v", *outDir, err)
	}

	// Sized so the generator itself never becomes the bottleneck: without a
	// large idle pool every request pays for a new TCP handshake and we would
	// be measuring our own connection churn rather than the deployment.
	maxUsers := 0
	for _, count := range stages {
		if count > maxUsers {
			maxUsers = count
		}
	}
	client := &http.Client{
		Timeout: *timeout,
		Transport: &http.Transport{
			MaxIdleConns:        maxUsers * 2,
			MaxIdleConnsPerHost: maxUsers * 2,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	runner := &runner{
		client:      client,
		base:        base,
		feedRatio:   *feedRatio,
		minLen:      *minLen,
		maxLen:      *maxLen,
		minInterval: *minInterval,
		maxInterval: *maxInterval,
	}

	started := time.Now()
	sampler := newSampler(systems, *sampleInterval, started)
	sampler.start(runner)

	result := runResult{
		Experiment: *experiment,
		Mode:       *mode,
		Target:     base,
		FeedRatio:  *feedRatio,
		BrokeAt:    -1,
	}

	var allLatencies []float64

	for index, count := range stages {
		budget := *perStage
		fmt.Printf("\n── stage %d: %d users, %d requests ──\n", index+1, count, budget)

		sampler.setUsers(count)
		stage := runner.runStage(count, budget, *duration)
		stage.Stage = index + 1
		result.Stages = append(result.Stages, stage.stageResult)
		allLatencies = append(allLatencies, stage.latencies...)

		result.TotalOK += stage.Successful
		result.TotalFailed += stage.Failed

		printStage(stage.stageResult)

		if *mode == "breakpoint" && stage.ErrorPercent > *errorLimit {
			fmt.Printf("\nbroke at %d users (%.2f%% errors, limit %.0f%%)\n",
				count, stage.ErrorPercent, *errorLimit)
			result.BrokeAt = count
			break
		}
	}

	sampler.stop()

	if len(allLatencies) > 0 {
		var total float64
		for _, value := range allLatencies {
			total += value
		}
		result.MeanMs = round2(total / float64(len(allLatencies)))
	}

	fmt.Printf("\n═══ %s ═══\n", *experiment)
	fmt.Printf("successful=%d failed=%d overall-mean=%.1fms\n",
		result.TotalOK, result.TotalFailed, result.MeanMs)
	if result.BrokeAt > 0 {
		fmt.Printf("broke at %d users\n", result.BrokeAt)
	}

	writeJSON(filepath.Join(*outDir, *experiment+".json"), result)
	writeStagesCSV(filepath.Join(*outDir, *experiment+"-stages.csv"), result)
	sampler.writeCSV(filepath.Join(*outDir, *experiment+"-timeseries.csv"))

	fmt.Printf("\nwrote %s.json, %s-stages.csv, %s-timeseries.csv in %s/\n",
		*experiment, *experiment, *experiment, *outDir)
}

func resolveStages(mode, raw string, users int) []int {
	if raw != "" {
		var stages []int
		for _, part := range strings.Split(raw, ",") {
			value, err := strconv.Atoi(strings.TrimSpace(part))
			if err == nil && value > 0 {
				stages = append(stages, value)
			}
		}
		if len(stages) > 0 {
			return stages
		}
	}

	switch mode {
	case "ladder":
		// Mirrors the evaluation's static-load ladder.
		return []int{250, 500, 750, 1000}
	case "breakpoint":
		return []int{200, 350, 500, 750, 1000, 1500}
	default:
		return []int{users}
	}
}

func parseSystems(raw string) []system {
	var systems []system
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, url, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		systems = append(systems, system{name: strings.TrimSpace(name), url: strings.TrimSpace(url)})
	}
	return systems
}

// --- running a stage -------------------------------------------------------

type runner struct {
	client      *http.Client
	base        string
	feedRatio   float64
	minLen      int
	maxLen      int
	minInterval time.Duration
	maxInterval time.Duration

	// Live counters the sampler reads to build the time series.
	completed atomic.Uint64
	latencySum atomic.Uint64 // microseconds
	inFlight  atomic.Int64
}

type stageRun struct {
	stageResult
	latencies []float64
}

func (r *runner) runStage(users, budget int, duration time.Duration) stageRun {
	var (
		remaining  = int64(budget)
		successful atomic.Uint64
		failed     atomic.Uint64
		posts      atomic.Uint64
		feeds      atomic.Uint64
		mu         sync.Mutex
		latencies  = make([]float64, 0, budget)
		wg         sync.WaitGroup
	)

	deadline := time.Time{}
	if duration > 0 {
		deadline = time.Now().Add(duration)
	}

	start := time.Now()

	for i := 0; i < users; i++ {
		wg.Add(1)
		go func(userID int) {
			defer wg.Done()

			random := rand.New(rand.NewSource(time.Now().UnixNano() + int64(userID)*7919))
			name := fmt.Sprintf("loadgen_user_%04d", userID)
			local := make([]float64, 0, 64)

			for {
				if !deadline.IsZero() {
					if time.Now().After(deadline) {
						break
					}
				} else if atomic.AddInt64(&remaining, -1) < 0 {
					break
				}

				isFeed := random.Float64() < r.feedRatio
				r.inFlight.Add(1)
				began := time.Now()
				ok := r.send(random, name, isFeed)
				elapsed := time.Since(began)
				r.inFlight.Add(-1)

				if ok {
					successful.Add(1)
				} else {
					failed.Add(1)
				}
				if isFeed {
					feeds.Add(1)
				} else {
					posts.Add(1)
				}

				ms := float64(elapsed.Microseconds()) / 1000.0
				local = append(local, ms)
				r.completed.Add(1)
				r.latencySum.Add(uint64(elapsed.Microseconds()))

				// Think time. Real users do not send back to back, and the
				// assignment asks for variable intervals; zero for both bounds
				// turns this off and drives maximum pressure.
				if r.maxInterval > 0 {
					spread := r.maxInterval - r.minInterval
					wait := r.minInterval
					if spread > 0 {
						wait += time.Duration(random.Int63n(int64(spread)))
					}
					time.Sleep(wait)
				}
			}

			mu.Lock()
			latencies = append(latencies, local...)
			mu.Unlock()
		}(i)
	}

	wg.Wait()
	elapsed := time.Since(start)

	sort.Float64s(latencies)
	ok := successful.Load()
	bad := failed.Load()
	total := ok + bad

	var sum float64
	for _, value := range latencies {
		sum += value
	}

	result := stageResult{
		Users:          users,
		Requests:       int(total),
		Successful:     ok,
		Failed:         bad,
		Posts:          posts.Load(),
		Feeds:          feeds.Load(),
		ThroughputRPS:  round2(float64(ok) / elapsed.Seconds()),
		ElapsedSeconds: round2(elapsed.Seconds()),
	}
	if total > 0 {
		result.ErrorPercent = round2(100 * float64(bad) / float64(total))
	}
	if len(latencies) > 0 {
		result.MeanMs = round2(sum / float64(len(latencies)))
		result.P50Ms = round2(pick(latencies, 0.50))
		result.P95Ms = round2(pick(latencies, 0.95))
		result.P99Ms = round2(pick(latencies, 0.99))
	}

	return stageRun{stageResult: result, latencies: latencies}
}

// send performs one request and reports whether it counts as successful.
func (r *runner) send(random *rand.Rand, name string, isFeed bool) bool {
	if isFeed {
		response, err := r.client.Get(r.base + "/feed")
		if err != nil {
			return false
		}
		defer response.Body.Close()
		io.Copy(io.Discard, response.Body)
		return response.StatusCode >= 200 && response.StatusCode < 400
	}

	payload, err := json.Marshal(map[string]string{
		"client-name": name,
		"msg":         randomMessage(random, r.minLen, r.maxLen),
	})
	if err != nil {
		return false
	}

	response, err := r.client.Post(r.base+"/message", "application/json", bytes.NewReader(payload))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	io.Copy(io.Discard, response.Body)
	return response.StatusCode >= 200 && response.StatusCode < 400
}

// Messages vary in length, as the assignment requires, and vary in content so
// the feed does not compress to nothing and flatter the read path.
func randomMessage(random *rand.Rand, minLen, maxLen int) string {
	length := minLen
	if maxLen > minLen {
		length += random.Intn(maxLen - minLen)
	}

	var builder strings.Builder
	builder.Grow(length + 16)
	for builder.Len() < length {
		builder.WriteString(words[random.Intn(len(words))])
		builder.WriteByte(' ')
	}

	return strings.TrimSpace(builder.String()[:length])
}

// --- utilisation sampling --------------------------------------------------

type sampler struct {
	systems  []system
	interval time.Duration
	started  time.Time
	client   *http.Client

	mu      sync.Mutex
	samples []sample
	users   int

	stopCh chan struct{}
	done   chan struct{}
}

func newSampler(systems []system, interval time.Duration, started time.Time) *sampler {
	return &sampler{
		systems:  systems,
		interval: interval,
		started:  started,
		client:   &http.Client{Timeout: 2 * time.Second},
		stopCh:   make(chan struct{}),
		done:     make(chan struct{}),
	}
}

func (s *sampler) setUsers(count int) {
	s.mu.Lock()
	s.users = count
	s.mu.Unlock()
}

func (s *sampler) start(r *runner) {
	if len(s.systems) == 0 {
		close(s.done)
		return
	}

	go func() {
		defer close(s.done)
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()

		lastCompleted := uint64(0)
		lastLatency := uint64(0)
		lastAt := time.Now()

		for {
			select {
			case <-s.stopCh:
				return
			case now := <-ticker.C:
				completed := r.completed.Load()
				latency := r.latencySum.Load()

				windowRequests := completed - lastCompleted
				windowLatency := latency - lastLatency
				windowSeconds := now.Sub(lastAt).Seconds()

				lastCompleted, lastLatency, lastAt = completed, latency, now

				entry := sample{
					elapsed:  round2(now.Sub(s.started).Seconds()),
					inFlight: r.inFlight.Load(),
					cpu:      map[string]float64{},
				}
				if windowSeconds > 0 {
					entry.rps = round2(float64(windowRequests) / windowSeconds)
				}
				if windowRequests > 0 {
					entry.meanMs = round2(float64(windowLatency) / float64(windowRequests) / 1000.0)
				}

				s.mu.Lock()
				entry.users = s.users
				s.mu.Unlock()

				for _, target := range s.systems {
					entry.cpu[target.name] = s.readCPU(target.url)
				}

				s.mu.Lock()
				s.samples = append(s.samples, entry)
				s.mu.Unlock()
			}
		}
	}()
}

func (s *sampler) readCPU(url string) float64 {
	response, err := s.client.Get(url)
	if err != nil {
		return -1
	}
	defer response.Body.Close()

	var parsed struct {
		CPUPercent float64 `json:"cpuPercent"`
	}
	if json.NewDecoder(response.Body).Decode(&parsed) != nil {
		return -1
	}

	return parsed.CPUPercent
}

func (s *sampler) stop() {
	if len(s.systems) == 0 {
		return
	}
	close(s.stopCh)
	<-s.done
}

func (s *sampler) writeCSV(path string) {
	if len(s.systems) == 0 {
		return
	}

	file, err := os.Create(path)
	if err != nil {
		log.Printf("could not write %s: %v", path, err)
		return
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	header := []string{"elapsed_s", "users", "rps", "mean_ms", "in_flight"}
	for _, target := range s.systems {
		header = append(header, target.name+"_cpu")
	}
	writer.Write(header)

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, entry := range s.samples {
		row := []string{
			fmt.Sprintf("%.2f", entry.elapsed),
			strconv.Itoa(entry.users),
			fmt.Sprintf("%.2f", entry.rps),
			fmt.Sprintf("%.2f", entry.meanMs),
			strconv.FormatInt(entry.inFlight, 10),
		}
		for _, target := range s.systems {
			row = append(row, fmt.Sprintf("%.2f", entry.cpu[target.name]))
		}
		writer.Write(row)
	}
}

// --- output ----------------------------------------------------------------

func printStage(stage stageResult) {
	fmt.Printf("  users=%d requests=%d ok=%d failed=%d (%.2f%% errors)\n",
		stage.Users, stage.Requests, stage.Successful, stage.Failed, stage.ErrorPercent)
	fmt.Printf("  throughput=%.1f rps  mean=%.1fms  p50=%.1f  p95=%.1f  p99=%.1f\n",
		stage.ThroughputRPS, stage.MeanMs, stage.P50Ms, stage.P95Ms, stage.P99Ms)
}

func writeJSON(path string, result runResult) {
	file, err := os.Create(path)
	if err != nil {
		log.Printf("could not write %s: %v", path, err)
		return
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	encoder.Encode(result)
}

func writeStagesCSV(path string, result runResult) {
	file, err := os.Create(path)
	if err != nil {
		log.Printf("could not write %s: %v", path, err)
		return
	}
	defer file.Close()

	writer := csv.NewWriter(file)
	defer writer.Flush()

	writer.Write([]string{
		"stage", "users", "requests", "successful", "failed", "error_percent",
		"throughput_rps", "mean_ms", "p50_ms", "p95_ms", "p99_ms", "elapsed_seconds",
	})

	for _, stage := range result.Stages {
		writer.Write([]string{
			strconv.Itoa(stage.Stage),
			strconv.Itoa(stage.Users),
			strconv.Itoa(stage.Requests),
			strconv.FormatUint(stage.Successful, 10),
			strconv.FormatUint(stage.Failed, 10),
			fmt.Sprintf("%.2f", stage.ErrorPercent),
			fmt.Sprintf("%.2f", stage.ThroughputRPS),
			fmt.Sprintf("%.2f", stage.MeanMs),
			fmt.Sprintf("%.2f", stage.P50Ms),
			fmt.Sprintf("%.2f", stage.P95Ms),
			fmt.Sprintf("%.2f", stage.P99Ms),
			fmt.Sprintf("%.2f", stage.ElapsedSeconds),
		})
	}
}

func pick(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[int(p*float64(len(sorted)-1))]
}

func round2(value float64) float64 {
	return float64(int(value*100+0.5)) / 100
}
