const { ulid } = require('../ids');
const { extractMessageFields } = require('./api');

// /message and /feed, served straight off the http server.
//
// Everything else in this application goes through Express, and should: the
// chat, the static client, the peer and admin endpoints are all better for
// having a router. But these two routes carry effectively all of the traffic,
// and measured against the same store and the same work, Express with the
// body-parsing middleware in front of it ran at roughly half the throughput of
// a plain handler — 2,080 requests per second against 3,998. On a machine
// entitled to a single core, that difference is the difference between
// finishing the evaluation and not.
//
// So these two are handled here, before Express is consulted, and every other
// path falls through to it untouched. The request parsing deliberately accepts
// exactly what the Express route accepts, by sharing the same extractor.

const MAX_BODY_BYTES = 1024 * 1024;

const JSON_HEADERS_BASE = { 'content-type': 'application/json; charset=utf-8' };

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      // Past the limit, stop accumulating but keep draining: destroying the
      // request here would surface to the client as a connection error rather
      // than an answer.
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// Only pays for query parsing when there is a query string.
function parseQuery(url) {
  const mark = url.indexOf('?');
  if (mark === -1) return null;

  const params = new URLSearchParams(url.slice(mark + 1));
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

function parseBody(raw, contentType) {
  if (!raw) return null;

  if (contentType && contentType.includes('urlencoded')) {
    const out = {};
    for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
    return out;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // A body we cannot parse is not a reason to fail the request: the fields
    // may equally well have been sent in the query string.
    return null;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { ...JSON_HEADERS_BASE, 'content-length': body.length });
  res.end(body);
}

function createFastPath({ store, replicator, tracker }) {
  // Returns true when it has taken responsibility for the request.
  return function fastPath(req, res) {
    const url = req.url;

    if (req.method === 'POST' && (url === '/message' || url.startsWith('/message?'))) {
      handleMessage(req, res, url);
      return true;
    }

    if (req.method === 'GET' && (url === '/feed' || url.startsWith('/feed?'))) {
      handleFeed(req, res, url);
      return true;
    }

    return false;
  };

  async function handleMessage(req, res, url) {
    const started = process.hrtime.bigint();
    tracker.inFlight += 1;
    tracker.total += 1;

    try {
      const raw = await readBody(req);
      const body = parseBody(raw, req.headers['content-type']);
      const query = parseQuery(url);

      const fields = extractMessageFields(body, query);
      const id = fields.id || ulid();
      const ts = Date.now();

      const result = await store.add({ id, name: fields.name, text: fields.text, ts });

      if (!result.duplicate) {
        replicator.enqueue({ id, name: fields.name, ts, encrypted: result.encrypted });
      }

      sendJson(res, 200, { status: 'ok', id: result.id, duplicate: result.duplicate });
    } catch (err) {
      tracker.errors += 1;
      console.error('POST /message failed:', err.message);
      sendJson(res, 500, { status: 'error', error: 'could not store message' });
    } finally {
      tracker.inFlight -= 1;
      tracker.observe(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }

  function handleFeed(req, res, url) {
    const started = process.hrtime.bigint();
    tracker.inFlight += 1;
    tracker.total += 1;

    try {
      const acceptsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
      const query = parseQuery(url);
      const limit = query ? Number.parseInt(query.limit, 10) || 0 : 0;

      const payload = store.feed({ acceptsGzip, limit });

      const headers = {
        ...JSON_HEADERS_BASE,
        'content-length': payload.body.length,
        vary: 'Accept-Encoding',
        'x-message-count': String(payload.count),
      };
      if (payload.encoding) headers['content-encoding'] = payload.encoding;

      res.writeHead(200, headers);
      res.end(payload.body);
    } catch (err) {
      tracker.errors += 1;
      console.error('GET /feed failed:', err.message);
      sendJson(res, 500, { status: 'error', error: 'could not read feed' });
    } finally {
      tracker.inFlight -= 1;
      tracker.observe(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }
}

module.exports = { createFastPath };
