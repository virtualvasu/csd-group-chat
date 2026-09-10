const os = require('node:os');

// System utilisation, sampled cheaply enough that the load balancer can poll it
// several times a second.
//
// os.cpus() reports cumulative CPU time since boot, so a single reading says
// nothing about current load — the useful number is the delta between two
// readings. We keep the previous snapshot and report the busy fraction over the
// interval between them.

function snapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const kind of Object.keys(cpu.times)) {
      total += cpu.times[kind];
    }
    idle += cpu.times.idle;
  }

  return { idle, total, at: Date.now() };
}

let previous = snapshot();
let cachedPercent = 0;

// Recomputes the busy fraction against the last snapshot. Called on a timer so
// that a burst of /stats requests all read the same recent value instead of
// each taking their own near-zero-length sample (which would be pure noise).
function sample() {
  const current = snapshot();
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (totalDelta > 0) {
    cachedPercent = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
  }

  previous = current;
  return cachedPercent;
}

function getStats(extra = {}) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    hostname: os.hostname(),
    pid: process.pid,
    cpuPercent: Number(cachedPercent.toFixed(2)),
    cpuCount: os.cpus().length,
    loadAvg1: Number(os.loadavg()[0].toFixed(2)),
    memUsedPercent: Number((100 * (1 - freeMem / totalMem)).toFixed(2)),
    memTotalMb: Math.round(totalMem / 1024 / 1024),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uptimeSeconds: Math.round(process.uptime()),
    ...extra,
  };
}

function startSampling(intervalMs = 500) {
  const timer = setInterval(sample, intervalMs);
  // Sampling must never be the reason the process stays alive at shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { getStats, startSampling, sample };
