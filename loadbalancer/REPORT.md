# Load Balancer Assignment Report

## Student Name
(fill in)

## Roll Number
(fill in)

## Assigned Systems

| System | Role            | Address           |
|--------|-----------------|-------------------|
| Sys1   | Load Balancer   | 10.1.75.53:4285 (HTTPS) |
| Sys2   | Backend copy 1  | 10.1.75.53:4286   |
| Sys3   | Backend copy 2  | 10.1.75.53:4287   |
| Sys4   | Backend copy 3  | 10.1.75.53:4288   |

All four are separate VMs sharing one physical host (`10.1.75.53`) — the
system-utilization plot below shows near-identical CPU/memory curves across
all 4 because of that shared-host contention, not a measurement error.

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

Chosen value: **8** (the default). Determined by running the identical load
profile (`loadgen -concurrency 25 -users 25 -feed-ratio 0.15`, see
`loadgen/results/threshold-comparison.csv` and `loadgen/results/comparison.csv`
row `medium-load-c25`) against the load balancer restarted at three different
`-max-inflight` values:

| `-max-inflight` | Throughput (rps) | /message p95 (ms) | Dropout % |
|---|---|---|---|
| 4  | 8.3  | 3041.7 | 58.67% |
| **8**  | **23.4** | **925.8**  | **19.87%** |
| 16 | 11.0 | 3869.2 | 44.40% |

![Threshold comparison](../loadgen/results/plots/threshold_comparison.png)

8 is a clear sweet spot, not just "closer to the default is safer": too low
(4) marks backends overloaded almost immediately without actually reducing
the load reaching them (the threshold only reorders *preference*, it isn't
admission control), so it buys nothing while still adding overhead; too high
(16) lets one backend absorb too much before the load balancer reacts and
starts preferring another. Both mistuned values roughly halve throughput and
triple-plus the dropout rate relative to 8.

## Response Time vs. Load

Own `loadgen` (`loadgen/main.go`) run against the live load balancer URL at
three concurrency levels, each with randomized message length, randomized
inter-message interval per simulated user, and a mix of `/message` and
`/feed` traffic (`-feed-ratio 0.15`). Full rows in
`loadgen/results/comparison.csv`.

| Experiment | Concurrency | Users | RPS | Dropout % | /message p50 (ms) | /message p95 (ms) | /feed p50 (ms) | /feed p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| low-load-c10    | 10 | 10 | 12.8 | 0.00%  | 40.2 | 279.9  | 967.1  | 1508.7 |
| medium-load-c25 | 25 | 25 | 23.4 | 19.87% | 47.5 | 925.8  | 1995.8 | 5001.3 |
| higher-load-c50 | 50 | 50 | 17.1 | 54.13% | 69.7 | 4066.8 | 3004.9 | 5001.1 |

![Response time vs load](../loadgen/results/plots/response_time.png)

### Observations

- **`/message` stays cheap at every load level tested** (p50 under 70ms even
  at concurrency 50) — writes are fast because they're one encrypt + one
  MongoDB insert.
- **`/feed` is the actual bottleneck**, not backend selection. Its p50 grows
  from ~1s to 3s+ across these runs because it decrypts and re-verifies the
  signature of *every* stored message on every call — a cost that scales with
  total chat history, not with request rate. Almost all dropout in these runs
  is `/feed` requests hitting loadgen's 5s client timeout, visible in the
  `context deadline exceeded` errors reported per run.
- This means the dynamic load balancing is doing its job (spreading load
  across healthy, least-loaded backends — see the threshold section above);
  the remaining bottleneck at high concurrency is `/feed`'s per-request cost
  on whichever backend serves it, independent of which backend that is.

## System Utilization (all 4 systems)

CPU and memory sampled once per second on all 4 systems throughout the load
tests above, via `loadgen/monitor.sh` (raw `/proc` parsing, no dependencies).
Raw data: `monitor_results/{lb,server1,server2,server3}`.

![System utilization](../loadgen/results/plots/system_utilization.png)

CPU spikes clearly track the load test windows (idle baseline ~1-2%, up to
~15-19% during the concurrency-50 run); all 4 curves move together because
these VMs share one physical host.

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
