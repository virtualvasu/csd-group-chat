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

See `loadbalancer/main.go` (reverse proxy, round-robin, health checks) and
`loadgen/main.go` (load generator) in this repository.

Backend: the existing `server/` messaging app (Node.js + Express + Socket.IO +
MongoDB), run as three independent, identically-configured copies on Sys2,
Sys3 and Sys4.

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
- [ ] `curl` output of `/lb/status` showing all three backends alive
- [ ] `loadgen` terminal output for the single-backend run
- [ ] `loadgen` terminal output for the three-backend run
- [ ] Browser screenshot of the chat app working through the load balancer
      (i.e. loaded from `http://10.1.75.53:3265/`)

## Integration with the Previous (Group) Assignment
- Previously graded messaging app URL: (fill in)
- Confirms it now resolves through the load balancer: (yes/no + how verified)
