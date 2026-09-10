// Anti-entropy between the backend machines.
//
// Replication is a fire-and-forget push, which is what keeps it off the request
// path — but it means a message written while a peer was down, restarting, or
// briefly unreachable never reaches that peer. Nothing would ever repair it,
// and that machine's /feed would stay permanently short. Since the evaluation
// reads /feed through a load balancer that may route it to any of the three,
// a divergent replica is a wrong answer.
//
// So each machine periodically asks its peers what they hold, and pulls
// anything it is missing. Insertion is keyed on the message id, so pulling a
// message that arrived by push in the meantime is a no-op — the same property
// that makes retries safe makes repair safe.
//
// The comparison is cheap in the common case: a digest of count plus newest id
// settles it in one small request, and the id list is only fetched when those
// disagree.

const DEFAULTS = {
  intervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 10000),
  // Cap on how much repair happens in one round, so catching up a machine that
  // missed a lot never turns into one enormous request.
  batchSize: Number(process.env.RECONCILE_BATCH || 2000),
  timeoutMs: Number(process.env.RECONCILE_TIMEOUT_MS || 5000),
};

class Reconciler {
  constructor(store, peerUrls = [], options = {}) {
    this.store = store;
    this.options = { ...DEFAULTS, ...options };
    this.peers = peerUrls.map((raw) => String(raw).trim().replace(/\/$/, '')).filter(Boolean);
    this.timer = null;
    this.running = false;
    this.counters = { rounds: 0, repaired: 0, errors: 0 };
  }

  get enabled() {
    return this.peers.length > 0;
  }

  stats() {
    return { ...this.counters };
  }

  async request(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`${url} -> ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async reconcileWith(peer) {
    const digest = await this.request(`${peer}/internal/digest`);
    const local = this.store.digest();

    // Same number of messages and the same newest one: nothing to do. This is
    // the steady state, and it costs one small request per peer per round.
    if (digest.count === local.count && digest.lastId === local.lastId) {
      return 0;
    }

    const { ids } = await this.request(`${peer}/internal/ids`);
    const missing = ids.filter((id) => !this.store.has(id));
    if (missing.length === 0) return 0;

    let repaired = 0;
    for (let i = 0; i < missing.length; i += this.options.batchSize) {
      const batch = missing.slice(i, i + this.options.batchSize);
      const payload = await this.request(`${peer}/internal/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });

      repaired += await this.store.ingestReplicated(payload.messages || []);
    }

    if (repaired > 0) {
      console.log(`reconciled ${repaired} message(s) from ${peer}`);
    }

    return repaired;
  }

  async runOnce() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.counters.rounds += 1;

    for (const peer of this.peers) {
      try {
        this.counters.repaired += await this.reconcileWith(peer);
      } catch (err) {
        // A peer being unreachable is the case this exists for, not an error
        // worth making noise about; the next round tries again.
        this.counters.errors += 1;
      }
    }

    this.running = false;
  }

  start() {
    if (!this.enabled) return;

    // Once at startup, which is what repairs a machine that has just come back
    // after missing messages entirely.
    setTimeout(() => this.runOnce(), 1000).unref?.();

    this.timer = setInterval(() => this.runOnce(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Reconciler };
