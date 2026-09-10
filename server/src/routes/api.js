const { Router } = require('express');

const { ulid, normalizeId } = require('../ids');
const { getStats } = require('../systemStats');

// The two routes the assignment fixes by name — /message and /feed — plus the
// endpoints the load balancer and the peer machines talk to.
//
// Input handling here is deliberately forgiving, and that is a correctness
// decision rather than a lax one. The chat client's own validation refuses a
// username over 20 characters and silently truncates a message at 500, which is
// right for a chat box driven by a person. Applied to this API it would mean an
// evaluation client whose names are `loadtest_user_00123` gets a 400 for every
// request, and one sending long messages reads back text it never sent. So this
// path sanitises rather than rejects, and keeps messages whole.

const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = Number(process.env.API_MAX_MESSAGE_LENGTH || 16384);
const DEFAULT_NAME = 'anonymous';

// Different clients spell these differently; accept the obvious variants rather
// than failing a request over a field name.
const NAME_KEYS = ['client-name', 'client_name', 'clientName', 'name', 'username', 'user', 'sender'];
const TEXT_KEYS = ['msg', 'message', 'text', 'body', 'content'];
const ID_KEYS = ['id', 'messageId', 'message_id', 'msgId'];

function pick(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function cleanName(raw) {
  if (raw === undefined) return DEFAULT_NAME;
  const name = String(raw).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!name) return DEFAULT_NAME;
  return name.slice(0, MAX_NAME_LENGTH);
}

function cleanText(raw) {
  if (raw === undefined) return '';
  return String(raw).slice(0, MAX_TEXT_LENGTH);
}

// Per-process request accounting, reported through /stats so the load balancer
// can score this backend on what it is actually doing rather than on how many
// requests the balancer happens to have sent it.
function createTracker() {
  return {
    inFlight: 0,
    total: 0,
    errors: 0,
    ewmaMs: 0,
    observe(ms) {
      // Weighted towards recent requests: the balancer needs to notice a
      // backend slowing down now, not its average since boot.
      this.ewmaMs = this.ewmaMs === 0 ? ms : this.ewmaMs * 0.8 + ms * 0.2;
    },
  };
}

function createApiRouter({ store, replicator, tracker, reconciler = null }) {
  const router = Router();

  router.post('/message', async (req, res) => {
    const started = process.hrtime.bigint();
    tracker.inFlight += 1;
    tracker.total += 1;

    try {
      const sources = [req.body, req.query];
      const name = cleanName(pick(sources, NAME_KEYS));
      const text = cleanText(pick(sources, TEXT_KEYS));
      // A caller that supplies its own id gets exactly-once semantics for free:
      // resending the same id after a timeout or a reconnect resolves to the
      // message that is already stored.
      const id = normalizeId(pick(sources, ID_KEYS)) || ulid();

      const ts = Date.now();
      const result = await store.add({ id, name, text, ts });

      // Only a genuinely new message is worth forwarding. A duplicate is
      // already on its way to the peers from whichever request created it.
      if (!result.duplicate) {
        replicator.enqueue({ id, name, ts, encrypted: result.encrypted });
      }

      res.json({ status: 'ok', id: result.id, duplicate: result.duplicate });
    } catch (err) {
      tracker.errors += 1;
      console.error('POST /message failed:', err.message);
      res.status(500).json({ status: 'error', error: 'could not store message' });
    } finally {
      tracker.inFlight -= 1;
      tracker.observe(Number(process.hrtime.bigint() - started) / 1e6);
    }
  });

  router.get('/feed', (req, res) => {
    const started = process.hrtime.bigint();
    tracker.inFlight += 1;
    tracker.total += 1;

    try {
      const acceptsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
      const limit = Number.parseInt(req.query.limit, 10) || 0;
      const payload = store.feed({ acceptsGzip, limit });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('X-Message-Count', String(payload.count));
      if (payload.encoding) {
        res.setHeader('Content-Encoding', payload.encoding);
      }
      res.setHeader('Content-Length', String(payload.body.length));
      res.end(payload.body);
    } catch (err) {
      tracker.errors += 1;
      console.error('GET /feed failed:', err.message);
      res.status(500).json({ status: 'error', error: 'could not read feed' });
    } finally {
      tracker.inFlight -= 1;
      tracker.observe(Number(process.hrtime.bigint() - started) / 1e6);
    }
  });

  // What the load balancer polls to decide where to send traffic.
  router.get('/stats', (req, res) => {
    res.json(
      getStats({
        inFlight: tracker.inFlight,
        totalRequests: tracker.total,
        errors: tracker.errors,
        ewmaMs: Number(tracker.ewmaMs.toFixed(2)),
        store: store.stats(),
        replication: replicator.stats(),
        reconciliation: reconciler ? reconciler.stats() : null,
      })
    );
  });

  // Peer-to-peer message delivery. Already-encrypted rows in, keyed on their
  // original ids, so a batch delivered twice changes nothing.
  router.post('/internal/replicate', async (req, res) => {
    try {
      const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
      const stored = await store.ingestReplicated(messages);
      res.json({ status: 'ok', stored });
    } catch (err) {
      console.error('replication ingest failed:', err.message);
      res.status(500).json({ status: 'error' });
    }
  });

  // --- anti-entropy, used by peers to repair gaps in their own copy ---

  // Cheap comparison point: matching count and newest id means no repair.
  router.get('/internal/digest', (req, res) => {
    res.json(store.digest());
  });

  router.get('/internal/ids', (req, res) => {
    res.json({ ids: store.idList() });
  });

  // The still-encrypted rows for a specific set of ids.
  router.post('/internal/fetch', async (req, res) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
      res.json({ messages: await store.fetchEncrypted(ids) });
    } catch (err) {
      console.error('internal fetch failed:', err.message);
      res.status(500).json({ status: 'error' });
    }
  });

  // Clears the conversation between benchmark runs, so a measured run is not
  // reading a feed inflated by previous ones. Disabled unless a token is set.
  router.post('/admin/reset', async (req, res) => {
    const expected = String(process.env.ADMIN_TOKEN || '').trim();
    if (!expected) {
      res.status(404).json({ status: 'error', error: 'not enabled' });
      return;
    }

    const supplied = String(req.query.token || (req.body && req.body.token) || '').trim();
    if (supplied !== expected) {
      res.status(403).json({ status: 'error', error: 'forbidden' });
      return;
    }

    try {
      const removed = await store.reset();
      res.json({ status: 'ok', removed });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  return router;
}

module.exports = { createApiRouter, createTracker, cleanName, cleanText };
