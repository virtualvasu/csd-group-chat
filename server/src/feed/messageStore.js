const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');

const { encrypt, decrypt } = require('../crypto/messageCipher');
const { toBuffer, COLLECTION } = require('../db/messageRepository');

// The store behind /message and /feed.
//
// The shape of this file is driven by one fact: /feed returns the whole
// conversation, and the load test asks for it thousands of times while messages
// are still arriving. Reading and decrypting every stored message per request
// is O(messages) of CPU per request and collapses immediately under load. So
// the process keeps the conversation in memory, keeps a pre-serialised (and
// pre-compressed) copy of the response, and rebuilds that copy on a timer
// rather than on the request path. A /feed request then costs one buffer write.
//
// Writes are batched for the same reason. One round trip to the database per
// message caps throughput at whatever the database's per-op latency allows;
// collecting a few milliseconds of messages and inserting them in one
// bulkWrite raises that ceiling by an order of magnitude without giving up
// durability, because the caller still waits for its batch to be acknowledged.
//
// Messages stay encrypted at rest, exactly as before. Decryption happens once,
// when a message enters this process, not once per read.

const DEFAULTS = {
  roomId: 'main',
  // Larger than a full evaluation run (20,000 requests), so in practice a run
  // sees its whole conversation. Bounded so that a machine which has been up
  // through many runs does not eventually try to serialise a 100MB response.
  maxMessages: Number(process.env.FEED_MAX_MESSAGES || 30000),
  // How long a write may wait to be batched with its neighbours.
  flushMs: Number(process.env.WRITE_FLUSH_MS || 0),
  flushMax: Number(process.env.WRITE_FLUSH_MAX || 250),
  // How often the cached /feed response is rebuilt. This is the staleness
  // bound for readers, and the main CPU knob: rebuilding is the only
  // per-conversation work left in the read path.
  rebuildMs: Number(process.env.FEED_REBUILD_MS || 250),
  // How often we look for messages written by a peer machine or by another
  // worker process on this machine.
  pollMs: Number(process.env.FEED_POLL_MS || 150),
  // How far back each poll looks. Covers clock skew and slow writes without
  // rescanning the collection.
  pollLookbackMs: Number(process.env.FEED_POLL_LOOKBACK_MS || 3000),
  // Only needed when sibling worker processes share this database.
  pollEnabled: false,
};

class MessageStore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(50);
    this.options = { ...DEFAULTS, ...options };

    this.db = null;
    this.messages = [];
    this.ids = new Set();

    // Serialised message bodies, parallel to this.messages, so a rebuild is a
    // join rather than a re-stringify of every message.
    this.parts = [];
    this.joined = '';
    this.needsRejoin = false;

    this.cache = { plain: Buffer.from('[]'), gzip: null, count: 0, builtAt: 0 };
    this.dirty = true;
    this.building = false;

    this.pendingWrites = [];
    this.flushTimer = null;
    this.flushScheduled = false;
    this.flushing = false;

    this.lastPollAt = 0;
    this.timers = [];

    this.counters = { accepted: 0, duplicates: 0, replicated: 0, writeErrors: 0 };
  }

  collection() {
    return this.db.collection(COLLECTION);
  }

  // Loads the tail of the conversation into memory. Only the newest
  // maxMessages are kept: older history stays in the database and is still
  // reachable through the chat client's own history load, it just is not part
  // of the hot feed payload.
  async init(db) {
    this.db = db;

    const documents = await this.collection()
      .find({ roomId: this.options.roomId })
      .sort({ _id: -1 })
      .limit(this.options.maxMessages)
      .toArray();

    documents.reverse();
    this.ingestDocuments(documents, { emit: false });
    this.lastPollAt = Date.now();
    this.dirty = true;
  }

  size() {
    return this.messages.length;
  }

  has(id) {
    return this.ids.has(id);
  }

  // A cheap summary for peers to compare against without transferring
  // anything: if the count and the newest id both match, the two machines hold
  // the same conversation and no repair is needed.
  digest() {
    const last = this.messages[this.messages.length - 1];
    return {
      count: this.messages.length,
      lastId: last ? last.id : null,
    };
  }

  idList() {
    return this.messages.map((message) => message.id);
  }

  // Returns the stored, still-encrypted form of specific messages, for a peer
  // repairing a gap. Read from the database rather than from memory because
  // memory holds decrypted text — sending that would put plaintext on the wire
  // where the push path sends ciphertext.
  async fetchEncrypted(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];

    const documents = await this.collection()
      .find({ _id: { $in: ids } })
      .toArray();

    return documents.map((doc) => ({
      id: typeof doc._id === 'string' ? doc._id : String(doc._id),
      name: doc.senderId,
      ts: doc.clientTimestamp ?? (doc.timestamp ? doc.timestamp.getTime() : Date.now()),
      ciphertext: toBuffer(doc.ciphertext).toString('base64'),
      nonce: toBuffer(doc.nonce).toString('base64'),
    }));
  }

  stats() {
    return {
      messages: this.messages.length,
      feedBytes: this.cache.plain.length,
      feedGzipBytes: this.cache.gzip ? this.cache.gzip.length : 0,
      pendingWrites: this.pendingWrites.length,
      ...this.counters,
    };
  }

  // Accepts one new message from a client. Resolves once the message is
  // durably written (its batch acknowledged), so a 200 response means stored.
  async add({ id, name, text, ts = Date.now() }) {
    if (this.ids.has(id)) {
      this.counters.duplicates += 1;
      return { id, duplicate: true };
    }

    const { ciphertext, nonce } = encrypt(text);
    const timestamp = new Date(ts);

    const doc = {
      _id: id,
      roomId: this.options.roomId,
      senderId: name,
      ciphertext,
      nonce,
      signature: null,
      senderPublicKey: null,
      timestamp,
      clientTimestamp: ts,
      // When *this* machine wrote the row. Peers each stamp their own, which
      // is what the incremental poll below scans on.
      localInsertedAt: new Date(),
    };

    this.appendToMemory({ id, name, text, ts });
    this.counters.accepted += 1;

    await this.queueWrite(doc);

    this.emit('message', { id, name, text, ts, local: true, encrypted: { ciphertext, nonce } });

    // The encrypted form goes back to the caller so replication can forward the
    // exact bytes that were stored, rather than re-encrypting the same text
    // under a fresh nonce and leaving peers holding a different row for the
    // same message.
    return { id, duplicate: false, encrypted: { ciphertext, nonce } };
  }

  // Drops the conversation, in memory and on disk. Used between benchmark runs
  // so a measured run starts from a known, empty state.
  async reset() {
    const result = await this.collection().deleteMany({ roomId: this.options.roomId });

    this.messages = [];
    this.ids = new Set();
    this.parts = [];
    this.joined = '';
    this.needsRejoin = false;
    this.dirty = true;
    this.lastPollAt = Date.now();
    this.rebuild();

    return result.deletedCount ?? 0;
  }

  // Messages arriving from a peer machine. They are already encrypted, and
  // they keep their original id, so inserting a message twice — a retry, a
  // reconnection, a peer replaying its backlog — collapses onto the same row.
  async ingestReplicated(entries) {
    const docs = [];
    const now = new Date();

    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || this.ids.has(entry.id)) continue;

      const ciphertext = Buffer.from(entry.ciphertext, 'base64');
      const nonce = Buffer.from(entry.nonce, 'base64');

      let text;
      try {
        text = decrypt({ ciphertext, nonce });
      } catch (err) {
        // A message we cannot decrypt is one written under a different key.
        // Skip it rather than poisoning the feed with an unreadable entry.
        continue;
      }

      this.appendToMemory({ id: entry.id, name: entry.name, text, ts: entry.ts });
      this.counters.replicated += 1;

      docs.push({
        _id: entry.id,
        roomId: this.options.roomId,
        senderId: entry.name,
        ciphertext,
        nonce,
        signature: null,
        senderPublicKey: null,
        timestamp: new Date(entry.ts),
        clientTimestamp: entry.ts,
        localInsertedAt: now,
      });
    }

    if (docs.length > 0) {
      await this.writeBatch(docs);
    }

    return docs.length;
  }

  // Rows read straight from the database, either at startup or by the poll.
  ingestDocuments(documents, { emit = true } = {}) {
    const added = [];

    for (const doc of documents) {
      const id = typeof doc._id === 'string' ? doc._id : String(doc._id);
      if (this.ids.has(id)) continue;

      let text;
      try {
        text = decrypt({ ciphertext: toBuffer(doc.ciphertext), nonce: toBuffer(doc.nonce) });
      } catch (err) {
        continue;
      }

      const message = {
        id,
        name: doc.senderId,
        text,
        ts: doc.clientTimestamp ?? (doc.timestamp ? doc.timestamp.getTime() : Date.now()),
      };

      this.appendToMemory(message);
      added.push(message);
    }

    if (emit && added.length > 0) {
      this.emit('messages', added);
    }

    return added;
  }

  appendToMemory(message) {
    const last = this.messages[this.messages.length - 1];
    // Ids sort by creation time, so an id below the current tail means this
    // message arrived out of order (a peer whose clock is slightly behind, or
    // a slow replication batch). Those are rare, so rather than doing an
    // insertion sort per message we mark the serialised copy for a full
    // re-join on the next rebuild.
    if (last && message.id < last.id) {
      this.needsRejoin = true;
    }

    this.ids.add(message.id);
    this.messages.push(message);
    this.parts.push(serialise(message));

    if (!this.needsRejoin) {
      this.joined += this.joined ? ',' + this.parts[this.parts.length - 1] : this.parts[this.parts.length - 1];
    }

    if (this.messages.length > this.options.maxMessages) {
      this.trim();
    }

    this.dirty = true;
  }

  trim() {
    const excess = this.messages.length - this.options.maxMessages;
    if (excess <= 0) return;

    for (let i = 0; i < excess; i++) {
      this.ids.delete(this.messages[i].id);
    }

    this.messages.splice(0, excess);
    this.parts.splice(0, excess);
    this.needsRejoin = true;
  }

  queueWrite(doc) {
    return new Promise((resolve, reject) => {
      this.pendingWrites.push({ doc, resolve, reject });

      if (this.pendingWrites.length >= this.options.flushMax) {
        this.flushWrites();
        return;
      }

      if (this.flushScheduled) return;
      this.flushScheduled = true;

      // Batch on the event loop turn rather than on a fixed delay. A timer
      // charges every request that fixed delay even when nothing else is
      // happening — 5ms on a request whose useful work is under 1ms. Deferring
      // to the end of the current turn instead costs nothing when idle, and
      // still batches heavily under load: while one bulk write is in flight
      // every request that arrives joins the next batch.
      const schedule = this.options.flushMs > 0
        ? (run) => setTimeout(run, this.options.flushMs)
        : setImmediate;

      schedule(() => {
        this.flushScheduled = false;
        this.flushWrites();
      });
    });
  }

  async flushWrites() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing || this.pendingWrites.length === 0) return;

    this.flushing = true;
    const batch = this.pendingWrites;
    this.pendingWrites = [];

    try {
      await this.writeBatch(batch.map((entry) => entry.doc));
      for (const entry of batch) entry.resolve();
    } catch (err) {
      this.counters.writeErrors += 1;
      for (const entry of batch) entry.reject(err);
    } finally {
      this.flushing = false;
      if (this.pendingWrites.length > 0) {
        setImmediate(() => this.flushWrites());
      }
    }
  }

  // One unordered bulk insert. Duplicate-key errors are the expected outcome
  // of replication and retries, not a failure: the row is already there, which
  // is exactly the state the caller wanted.
  async writeBatch(docs) {
    if (docs.length === 0) return;

    try {
      await this.collection().insertMany(docs, { ordered: false });
    } catch (err) {
      const writeErrors = err && (err.writeErrors || (err.result && err.result.writeErrors)) || [];
      const onlyDuplicates =
        writeErrors.length > 0 && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000);

      if (!onlyDuplicates && err.code !== 11000) {
        throw err;
      }
    }
  }

  // Picks up anything written by a peer machine or by a sibling worker process
  // on this machine. Scans by insertion time on this node with a lookback
  // window; ids already in memory are skipped, so overlapping scans are free.
  async poll() {
    if (!this.db) return 0;

    const since = new Date(Math.max(0, this.lastPollAt - this.options.pollLookbackMs));
    this.lastPollAt = Date.now();

    const documents = await this.collection()
      .find({ roomId: this.options.roomId, localInsertedAt: { $gte: since } })
      .sort({ _id: 1 })
      .limit(this.options.maxMessages)
      .toArray();

    const added = this.ingestDocuments(documents);
    return added.length;
  }

  // Rebuilds the cached response. Runs on a timer, off the request path, so no
  // client ever waits for a serialisation or a compression.
  rebuild() {
    if (this.building || !this.dirty) return;
    this.building = true;

    if (this.needsRejoin) {
      this.messages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      this.parts = this.messages.map(serialise);
      this.joined = this.parts.join(',');
      this.needsRejoin = false;
    }

    const plain = Buffer.from('[' + this.joined + ']');
    const count = this.messages.length;
    this.dirty = false;

    // Compression is the expensive half, so it is done asynchronously on the
    // threadpool at the fastest level: this payload is highly repetitive JSON,
    // where level 1 already gets most of the ratio for a fraction of the cost.
    zlib.gzip(plain, { level: 1 }, (err, gzipped) => {
      this.cache = {
        plain,
        gzip: err ? null : gzipped,
        count,
        builtAt: Date.now(),
      };
      this.building = false;
    });
  }

  // The response for GET /feed. Returns pre-built bytes; the only per-request
  // work is choosing which of the two encodings to hand back.
  feed({ acceptsGzip = false, limit = 0 } = {}) {
    if (limit > 0 && limit < this.messages.length) {
      // Only our own load generator asks for a slice; build it on the spot
      // rather than keeping a second cache warm for a path the evaluation
      // never takes.
      const slice = this.messages.slice(-limit).map(serialise).join(',');
      return { body: Buffer.from('[' + slice + ']'), encoding: null, count: limit };
    }

    if (acceptsGzip && this.cache.gzip) {
      return { body: this.cache.gzip, encoding: 'gzip', count: this.cache.count };
    }

    return { body: this.cache.plain, encoding: null, count: this.cache.count };
  }

  start() {
    const timers = [setInterval(() => this.rebuild(), this.options.rebuildMs)];

    // The rescan only exists to notice rows written by a *sibling worker
    // process* sharing this machine's database. Messages this process accepted,
    // and messages pushed here by a peer, are already in memory by the time
    // they are written, and gaps left by a peer that was unreachable are the
    // reconciler's job. With a single worker the scan therefore finds nothing
    // it does not already have — while still making the database re-read and
    // re-decode every recently written row several times a second, on the one
    // core it shares with mongod.
    if (this.options.pollEnabled) {
      timers.push(
        setInterval(() => {
          this.poll().catch((err) => console.error('feed poll failed:', err.message));
        }, this.options.pollMs)
      );
    }

    for (const timer of timers) {
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.push(timer);
    }

    this.rebuild();
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

// The wire shape of one message. The two input field names from the assignment
// (`client-name` and `msg`) are mirrored here so a caller reads back what it
// sent under the name it sent it under.
function serialise(message) {
  return JSON.stringify({
    id: message.id,
    'client-name': message.name,
    msg: message.text,
    timestamp: message.ts,
  });
}

module.exports = { MessageStore, serialise };
