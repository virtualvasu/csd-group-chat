# Load Balancer Assignment Report

## Student Name
(fill in)

## Roll Number
(fill in)

## Assigned Systems

| System | Role            | Address           |
|--------|-----------------|-------------------|
| Sys1   | Load Balancer   | 10.1.75.53:3265   |
| Sys2   | Backend copy 1  | 10.1.75.53:3266   |
| Sys3   | Backend copy 2  | 10.1.75.53:3267   |
| Sys4   | Backend copy 3  | 10.1.75.53:3268   |

## Load Balancer Code

See `loadbalancer/main.go` (reverse proxy, performance-based dynamic backend
selection, health checks) and `loadgen/main.go` (load generator) in this
repository.

Backend: the existing `server/` messaging app (Node.js + Express + Socket.IO +
MongoDB), run as three independent, identically-configured copies on Sys2,
Sys3 and Sys4, all sharing one MongoDB Atlas cluster and one
`CHAT_ENCRYPTION_KEY` — that is what makes them share persistent chat data
rather than three separate histories. Required routes `POST /message` and
`GET /feed` are exposed by every backend and proxied through unchanged, so the
load balancer's own URL is what gets submitted.

## Dynamic Load Balancing

`candidateBackends()` (`loadbalancer/main.go`) is **not** fixed round-robin.
Each request is routed to the currently least-loaded healthy backend, using
the in-flight-request count the load balancer already tracks per backend (no
cooperation needed from the Node process). A backend at or above
`-max-inflight` in-flight requests is treated as **overloaded**: still used as
a last resort so a request is never dropped while any backend is alive, but
never preferred over a less-loaded one. This is the dynamic switch-away
behavior — a backend that starts falling behind loses new traffic to its
peers immediately, without waiting for a health check to fail it outright.

Unhealthy/unavailable backends are handled separately and unconditionally:

- **Active check** — `healthLoop` polls each backend's `GET /health` every
  `-health-interval` and flips `Alive` off on a non-2xx/3xx response or a
  failed request.
- **Passive check** — the reverse proxy's `ErrorHandler` marks a backend dead
  immediately on a dial or response-header timeout, before anything is
  retried against it.

A dead backend never appears in `candidateBackends()`'s output regardless of
its load score.

### Threshold (`-max-inflight`)

Default: `8` in-flight requests per backend. (Fill in after running loadgen:
what value maximized throughput / minimized p95 without materially raising
the dropout rate? Try a few values via `-max-inflight` against the CPU-bound
`/lb-test` endpoint or `/message`, and record the comparison here.)

| `-max-inflight` | Throughput (rps) | p95 (ms) | Dropout % | Notes |
|---|---|---|---|---|
|   |   |   |   |   |

## Comparison Table

| Experiment    | Requests | Concurrency | Successful | Failed | RPS | Dropout % | p50 (ms) | p95 (ms) | p99 (ms) |
|---------------|----------|-------------|------------|--------|-----|-----------|----------|----------|----------|
| 1 backend (Sys2 only) |    |             |            |        |     |           |          |          |          |
| 3 backends (Sys2+3+4) |    |             |            |        |     |           |          |          |          |

(Fill this in from `results/single.json` and `results/three.json`, or from
`results/comparison.csv` produced by `loadgen`.)

### Observations
- (fill in: throughput / dropout / latency differences between the two runs)
- (fill in: what happened when a backend was killed mid-experiment, if tested)

## Relevant Screenshots
- [ ] `curl` output of `/lb/status` showing all three backends alive, with `in_flight`/`overloaded` fields
- [ ] `loadgen` terminal output for the single-backend run
- [ ] `loadgen` terminal output for the three-backend run
- [ ] `loadgen` terminal output showing the dynamic-selection effect (e.g. one backend saturated, `/lb/status` showing it marked `overloaded` while traffic shifts to the others)
- [ ] Browser screenshot of the chat app working through the load balancer
      (i.e. loaded from `http://10.1.75.53:3265/`)
- [ ] `curl -X POST .../message -d '{"client-name":"x","msg":"y","id":"dup-1"}'` sent twice, showing `duplicate: false` then `duplicate: true`, and `GET /feed` showing only one copy stored

## Integration with the Previous (Group) Assignment
- Previously graded messaging app URL: (fill in)
- Confirms it now resolves through the load balancer: (yes/no + how verified)
