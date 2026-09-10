# Load Balancer Assignment Report

## Student Name
Kunal Sewal

## Roll Number
12341270

## Assigned Systems

| System | Role            | Address           |
|--------|-----------------|-------------------|
| Sys1   | Load Balancer   | 10.1.75.53:3265   |
| Sys2   | Backend copy 1  | 10.1.75.53:3266   |
| Sys3   | Backend copy 2  | 10.1.75.53:3267   |
| Sys4   | Backend copy 3  | 10.1.75.53:3268   |

## Load Balancer Code

See `loadbalancer/main.go` (reverse proxy, round-robin, health checks) and
`loadgen/main.go` (load generator) in this repository.

Backend: the existing `server/` messaging app (Node.js + Express + Socket.IO +
MongoDB), run as three independent, identically-configured copies on Sys2,
Sys3 and Sys4.

## Comparison Table

### Baseline: `/health` (no real backend work)

| Experiment    | Requests | Concurrency | Successful | Failed | RPS | Dropout % | p50 (ms) | p95 (ms) | p99 (ms) |
|---------------|----------|-------------|------------|--------|-----|-----------|----------|----------|----------|
| 1 backend (Sys2 only) | 5000 | 40 | 5000 | 0 | 266.08 | 0.00% | 106.20 | 313.60 | 498.14 |
| 3 backends (Sys2+3+4) | 5000 | 40 | 4999 | 1 | 270.95 | 0.02% | 103.56 | 324.60 | 578.46 |

`/health` does no real work (no DB call, no computation), so a single Node
process can already answer it instantly regardless of load — it was never
the bottleneck at this concurrency. That's why the two rows are nearly
identical: this run mostly measures network round-trip time through the
NAT path to Sys1, not backend capacity, and is included as a baseline/sanity
check rather than the main result.

### Real comparison: `/lb-test?busy=20` (CPU-bound work per request)

To actually saturate a backend, `/lb-test` (a load-test-only endpoint added
for this assignment, see `server/src/routes/loadtest.js`) burns 20ms of CPU
synchronously per request. Because Node is single-threaded for JS execution,
this genuinely blocks that process's event loop, so concurrent requests to
*one* process serialize behind each other — while three independent
processes (Sys2/3/4) can do three times the work in parallel.

| Experiment    | Requests | Concurrency | Successful | Failed | RPS | Dropout % | p50 (ms) | p95 (ms) | p99 (ms) |
|---------------|----------|-------------|------------|--------|-----|-----------|----------|----------|----------|
| 1 backend (Sys2 only) | 3000 | 100 | 205  | 2795 | 46.39  | 93.17% | 8.76   | 360.62  | 3765.78 |
| 3 backends (Sys2+3+4) | 3000 | 100 | 3000 | 0    | 119.48 | 0.00%  | 340.04 | 4111.18 | 4313.66 |

### Observations
- **Throughput**: three backends sustained ~119 rps vs. ~46 rps for one —
  roughly 2.6x, close to the theoretical 3x ceiling (1000ms / 20ms = 50 rps
  per process), with some overhead from proxying and queueing.
- **Dropout**: the single backend failed 93% of requests under this load;
  three backends completed all 3000 with zero failures. This is the actual
  effect the assignment is demonstrating — redundancy, not just raw
  throughput, is what a load balancer buys you.
- **Latency inverted**: p50/p95/p99 are all *higher* with three backends
  (340ms vs 8.76ms at p50) even though it had zero failures. This isn't a
  regression — with one backend, most requests failed fast (fed straight
  back as an error) rather than waiting; with three, every request queued
  until it was actually served successfully. Lower latency with a much
  higher failure rate is not actually "better" — it's a fundamentally
  different (broken) system to compare against.
- **Why single-backend failures cascade so hard**: this load balancer marks
  a backend "dead" the moment a proxied request exceeds the response-header
  timeout, and (originally) simply returned that error to the client. Under
  sustained overload, one slow response was enough to flip the flag, and
  every other in-flight request would then get an instant "no healthy
  backend" error — with only one backend in the pool, there's nothing to
  fall back to. Adding retry-across-backends (falling through to the next
  healthy backend on error, see the retry loop in `loadbalancer/main.go`)
  is what took the three-backend dropout from ~70% down to 0%: when one
  backend is momentarily marked dead, the other two absorb the traffic
  instead of the request failing outright.
- **Health-check timeouts must be tuned to expected worst-case latency,
  not just "typical" latency** — the defaults (800ms) were tuned for quick
  detection of a truly dead backend, but under deliberate overload they
  caused false positives. `-backend-timeout 5s -health-timeout 2s` was used
  for the load-bearing runs to give a slow-but-alive backend room to
  actually finish instead of being evicted mid-response.

## Relevant Screenshots
- [ ] `curl` output of `/lb/status` showing all three backends alive
- [ ] `loadgen` terminal output for the single-backend run
- [ ] `loadgen` terminal output for the three-backend run
- [ ] Browser screenshot of the chat app working through the load balancer
      (i.e. loaded from `http://10.1.75.53:3265/`)

## Integration with the Previous (Group) Assignment
- Previously graded messaging app URL: (fill in)
- Confirms it now resolves through the load balancer: (yes/no + how verified)
