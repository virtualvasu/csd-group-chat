const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// Pushes newly accepted messages to the other backend machines.
//
// Each machine owns a local database, so a write is a local operation and never
// waits on the network. Sharing the conversation is then a matter of telling
// the peers what arrived. That push is deliberately off the request path: the
// client's 200 depends on the local write only, and replication catches up
// within a few tens of milliseconds.
//
// Delivery does not have to be reliable, which is what makes this cheap. Every
// message carries the id it was created with, inserts are keyed on that id, and
// each machine independently rescans its own collection on a timer. A dropped
// batch, a peer that was restarting, a duplicate delivered twice — all of them
// converge to the same rows.

const DEFAULTS = {
  flushMs: Number(process.env.REPLICATE_FLUSH_MS || 25),
  flushMax: Number(process.env.REPLICATE_FLUSH_MAX || 200),
  timeoutMs: Number(process.env.REPLICATE_TIMEOUT_MS || 2000),
};

class Replicator {
  constructor(peerUrls = [], options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.queue = [];
    this.timer = null;
    this.counters = { sent: 0, batches: 0, failures: 0 };

    this.peers = peerUrls
      .map((raw) => String(raw).trim())
      .filter(Boolean)
      .map((raw) => {
        const url = new URL('/internal/replicate', raw);
        const isHttps = url.protocol === 'https:';
        return {
          url,
          transport: isHttps ? https : http,
          agent: new (isHttps ? https.Agent : http.Agent)({
            keepAlive: true,
            maxSockets: 32,
            keepAliveMsecs: 30000,
          }),
        };
      });
  }

  get enabled() {
    return this.peers.length > 0;
  }

  stats() {
    return { peers: this.peers.length, queued: this.queue.length, ...this.counters };
  }

  // Takes the encrypted form so peers store byte-identical rows rather than
  // re-encrypting the same text under a different nonce.
  enqueue({ id, name, ts, encrypted }) {
    if (!this.enabled || !encrypted) return;

    this.queue.push({
      id,
      name,
      ts,
      ciphertext: encrypted.ciphertext.toString('base64'),
      nonce: encrypted.nonce.toString('base64'),
    });

    if (this.queue.length >= this.options.flushMax) {
      this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.options.flushMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    const payload = Buffer.from(JSON.stringify({ messages: batch }));
    this.counters.batches += 1;
    this.counters.sent += batch.length;

    for (const peer of this.peers) {
      this.send(peer, payload);
    }
  }

  send(peer, payload) {
    const request = peer.transport.request(
      {
        protocol: peer.url.protocol,
        hostname: peer.url.hostname,
        port: peer.url.port,
        path: peer.url.pathname,
        method: 'POST',
        agent: peer.agent,
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
        },
        // A peer that is down must not hold a socket open; the periodic rescan
        // will reconcile whatever this batch failed to deliver.
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
      }
    );

    request.setTimeout(this.options.timeoutMs, () => request.destroy());
    request.on('error', () => {
      this.counters.failures += 1;
    });

    request.end(payload);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const peer of this.peers) peer.agent.destroy();
  }
}

module.exports = { Replicator };
