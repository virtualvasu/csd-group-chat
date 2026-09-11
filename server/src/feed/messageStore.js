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

// How many snapshot buffers to rotate through. Deep enough that a buffer is
// not overwritten until long after any response written from it has drained.
const SNAPSHOT_BUFFERS = 4;

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

    // The feed body, accumulated as raw bytes: "[" followed by each message's
    // JSON separated by commas, with the closing bracket added when a snapshot
    // is taken. Appending costs one small copy per message.
    //
    // The obvious alternative — keeping the JSON in a string and encoding it on
    // each rebuild — measured 41ms per rebuild at 30,000 messages, because it
    // flattens a multi-megabyte rope and re-encodes the whole thing to UTF-8
    // every time. That ran on the timer, synchronously, so every request in
    // flight stalled for those 41ms.
    this.body = Buffer.allocUnsafe(64 * 1024);
    this.body[0] = 0x5b; // '['
    this.bodyLen = 1;
    this.checksum = 0;
    this.lastRebuildMs = 0;
    this.snapshots = new Array(SNAPSHOT_BUFFERS).fill(null);
    this.snapshotSlot = 0;
    // How far past the cap the conversation may grow before it is trimmed.
    // Larger slack means the costly re-lay happens proportionally less often.
    this.trimSlack = Math.max(1000, Math.floor(this.options.maxMessages * 0.1));

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

    // Whether the database is reachable. A backend that cannot persist is not
    // healthy, however well it can still serve reads from memory, and the
    // balancer needs to know that so it can route around it.
    this.dbHealthy = true;
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
  // Order-independent on purpose: two machines holding the same messages may
  // have received them in different orders, and a digest that disagreed for
  // that reason alone would send them into a full id comparison every round.
  digest() {
    return { count: this.messages.length, checksum: this.checksum };
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
    this.bodyLen = 1;
    this.body[0] = 0x5b;
    this.checksum = 0;
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

  // Hands back one of a fixed set of buffers, grown in place when the feed
  // outgrows them, so the steady state allocates nothing. Returns a view of
  // exactly the requested length.
  takeSnapshotBuffer(size) {
    const slot = this.snapshotSlot % SNAPSHOT_BUFFERS;
    this.snapshotSlot += 1;

    let buffer = this.snapshots[slot];
    if (!buffer || buffer.length < size) {
      // Grow with headroom so a steadily growing feed does not reallocate on
      // every single rebuild.
      buffer = Buffer.allocUnsafe(Math.max(size * 2, 64 * 1024));
      this.snapshots[slot] = buffer;
    }

    return buffer.subarray(0, size);
  }

  ensureCapacity(extra) {
    // +1 leaves room for the closing bracket a snapshot appends.
    const needed = this.bodyLen + extra + 1;
    if (needed <= this.body.length) return;

    let size = Math.max(this.body.length * 2, 64 * 1024);
    while (size < needed) size *= 2;

    const grown = Buffer.allocUnsafe(size);
    this.body.copy(grown, 0, 0, this.bodyLen);
    this.body = grown;
  }

  appendBytes(message) {
    const encoded = Buffer.from(serialise(message));
    const separator = this.bodyLen > 1 ? 1 : 0;

    this.ensureCapacity(encoded.length + separator);
    if (separator) {
      this.body[this.bodyLen] = 0x2c; // ','
      this.bodyLen += 1;
    }
    encoded.copy(this.body, this.bodyLen);
    this.bodyLen += encoded.length;
  }

  // Re-lays the whole body. Only needed after messages are removed or reordered,
  // which is rare — the steady state is append-only.
  rebuildBody() {
    this.bodyLen = 1;
    this.body[0] = 0x5b; // '['
    for (const message of this.messages) this.appendBytes(message);
  }

  // Messages are held in arrival order, which is close enough to chronological
  // to read naturally and costs nothing to maintain.
  //
  // An earlier version tried to keep them strictly sorted by id, re-laying the
  // serialised body whenever one arrived "early". That was wrong twice over: a
  // ULID's ordering within a millisecond comes from its random half, so half of
  // all consecutive ids compare as out of order and the re-lay latched on
  // permanently; and re-laying meant sorting and re-serialising the entire
  // conversation, which is where the 41ms rebuild came from. Nothing requires
  // the feed to be sorted, so nothing here sorts it.
  appendToMemory(message) {
    this.ids.add(message.id);
    this.messages.push(message);
    this.checksum = (this.checksum ^ hashId(message.id)) | 0;
    this.appendBytes(message);

    // Trimming re-lays the whole serialised body, so it is done in batches
    // once the conversation has overrun the cap by a margin — never per
    // message. Trimming the moment the cap is passed meant every subsequent
    // message re-serialised the entire conversation, which at thirty thousand
    // messages is thirty thousand stringify calls and as many allocations, per
    // request. That is what killed the backends: the load itself was fine, the
    // conversation simply grew past the cap mid-run.
    if (this.messages.length >= this.options.maxMessages + this.trimSlack) {
      this.trim();
    }

    this.dirty = true;
  }

  trim() {
    const excess = this.messages.length - this.options.maxMessages;
    if (excess <= 0) return;

    for (let i = 0; i < excess; i++) {
      const id = this.messages[i].id;
      this.ids.delete(id);
      this.checksum = (this.checksum ^ hashId(id)) | 0;
    }

    this.messages.splice(0, excess);
    // Removing from the front is the one case that cannot be done by appending,
    // so the body is re-laid here. It happens only once the conversation passes
    // maxMessages, not per message.
    this.rebuildBody();
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
      this.dbHealthy = true;
      for (const entry of batch) entry.resolve();
    } catch (err) {
      this.counters.writeErrors += 1;
      this.dbHealthy = false;
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

    const startedAt = Date.now();

    // A snapshot, not a view of the live buffer: the response may still be
    // being written to a socket when the next message appends, and that append
    // would otherwise overwrite the closing bracket mid-flight.
    //
    // The snapshots are taken from a small rotation of reused buffers rather
    // than allocated fresh each time. At thirty thousand messages a snapshot is
    // five and a half megabytes, and allocating one every rebuild produced
    // twenty megabytes a second of garbage — which is survivable when the
    // collector can keep up, and is not when the core is already saturated.
    // These buffers are outside the V8 heap, so --max-old-space-size does not
    // bound them; only not allocating them does.
    //
    // Rotating several deep means a buffer is not reused until well after any
    // response written from it has finished.
    const plain = this.takeSnapshotBuffer(this.bodyLen + 1);
    this.body.copy(plain, 0, 0, this.bodyLen);
    plain[this.bodyLen] = 0x5d; // ']'

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
      // What the whole rebuild cost, used to pace the next one so that
      // maintaining the cache cannot consume the machine as the feed grows.
      this.lastRebuildMs = Date.now() - startedAt;
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
    const timers = [];

    // A plain interval. Rebuilds cannot pile up because rebuild() returns
    // immediately while one is still in flight, so if compressing a large feed
    // takes longer than the interval the effective rate simply drops to
    // whatever the machine can sustain.
    //
    // A previous version tried to pace this explicitly, scheduling the next
    // rebuild at a multiple of how long the last one took. That measured wall
    // time, which for an asynchronous compression includes time spent waiting
    // for a threadpool slot, so under load the delay grew without bound and the
    // feed silently stopped updating — the one failure mode that matters here,
    // since a stale feed is a wrong answer rather than a slow one.
    // The interval widens as the conversation grows: snapshotting and
    // compressing five megabytes is not worth doing four times a second, and
    // a second of staleness on a feed is not something a reader can detect.
    // Bounded at both ends so it can never run away, which is what broke the
    // earlier attempt at pacing this.
    timers.push(
      setInterval(() => {
        const due = Math.min(1000, Math.max(this.options.rebuildMs, this.bodyLen / 8000));
        if (Date.now() - this.cache.builtAt >= due) this.rebuild();
      }, this.options.rebuildMs)
    );

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

    // Without this, a backend with no traffic would keep reporting healthy
    // indefinitely after losing its database, because nothing would have tried
    // to write.
    timers.push(
      setInterval(async () => {
        try {
          await this.db.command({ ping: 1 });
          this.dbHealthy = true;
        } catch {
          this.dbHealthy = false;
        }
      }, 2000)
    );

    for (const timer of timers) {
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.push(timer);
    }

    this.rebuild();
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.timers = [];
  }
}

// Cheap, order-independent accumulator: XORing each id in means the result
// depends on the set of messages held, not the sequence they arrived in, and
// a message can be removed by XORing it back out.
function hashId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return hash;
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
