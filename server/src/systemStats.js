const fs = require('node:fs');
const os = require('node:os');

// System utilisation, sampled cheaply enough that the load balancer can poll it
// several times a second.
//
// The obvious implementation — diff os.cpus() between two readings — is wrong
// inside a container. os.cpus() describes the host, so on the lab machine it
// averages over all 120 of its cores while this container is entitled to one.
// A backend pinned at its limit would report under 1% busy, which is useless
// both for routing decisions and for the utilisation figures in the report.
//
// The cgroup accounts for what this container actually consumed, so that is
// what gets read, normalised against the container's own CPU quota. The
// os.cpus() path stays as a fallback for running outside a container.

const CGROUP_V2_USAGE = '/sys/fs/cgroup/cpu.stat';
const CGROUP_V1_USAGE = '/sys/fs/cgroup/cpuacct/cpuacct.usage';

// Microseconds of CPU time this container has used since it started.
function readCgroupUsageMicros() {
  try {
    const text = fs.readFileSync(CGROUP_V2_USAGE, 'utf8');
    const match = text.match(/usage_usec\s+(\d+)/);
    if (match) return Number(match[1]);
  } catch {}

  try {
    // cgroup v1 reports nanoseconds.
    const nanos = Number(fs.readFileSync(CGROUP_V1_USAGE, 'utf8').trim());
    if (Number.isFinite(nanos)) return nanos / 1000;
  } catch {}

  return null;
}

// How many CPUs this container may use, which is what "100% busy" means here.
function quotaCores() {
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max') {
      const cores = Number(quota) / Number(period);
      if (cores > 0) return cores;
    }
  } catch {}

  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'));
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'));
    if (quota > 0 && period > 0) return quota / period;
  } catch {}

  return os.cpus().length;
}

const CORES = quotaCores();

function hostSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const kind of Object.keys(cpu.times)) total += cpu.times[kind];
    idle += cpu.times.idle;
  }

  return { idle, total };
}

let previousUsage = readCgroupUsageMicros();
let previousHost = previousUsage === null ? hostSnapshot() : null;
let previousAt = Date.now();
let cachedPercent = 0;

// Recomputed on a timer so a burst of /stats requests all read the same recent
// value rather than each taking its own near-zero-length sample.
function sample() {
  const now = Date.now();
  const elapsedMicros = (now - previousAt) * 1000;
  if (elapsedMicros <= 0) return cachedPercent;

  const usage = readCgroupUsageMicros();

  if (usage !== null && previousUsage !== null) {
    const usedMicros = usage - previousUsage;
    previousUsage = usage;
    cachedPercent = clamp((100 * usedMicros) / (elapsedMicros * CORES));
  } else if (previousHost) {
    const current = hostSnapshot();
    const idleDelta = current.idle - previousHost.idle;
    const totalDelta = current.total - previousHost.total;
    previousHost = current;
    if (totalDelta > 0) {
      cachedPercent = clamp(100 * (1 - idleDelta / totalDelta));
    }
  }

  previousAt = now;
  return cachedPercent;
}

function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function getStats(extra = {}) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    hostname: os.hostname(),
    pid: process.pid,
    // Percent of *this container's* CPU entitlement, not of the host.
    cpuPercent: Number(cachedPercent.toFixed(2)),
    cpuCores: Number(CORES.toFixed(2)),
    hostCpuCount: os.cpus().length,
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
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { getStats, startSampling, sample, quotaCores };
