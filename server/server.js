const path = require('path');
const os = require('node:os');
const cluster = require('node:cluster');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { Presence } = require('./src/presence');
const { RateLimiter } = require('./src/rateLimiter');
const { registerSocketHandlers, ROOM_ID } = require('./src/socketHandlers');
const { createHealthRouter } = require('./src/routes/health');
const { createLoadTestRouter } = require('./src/routes/loadtest');
const { createApiRouter, createTracker } = require('./src/routes/api');
const { MessageStore } = require('./src/feed/messageStore');
const { Replicator } = require('./src/feed/replicator');
const { Reconciler } = require('./src/feed/reconciler');
const { startSampling } = require('./src/systemStats');
const { loadKey } = require('./src/crypto/messageCipher');
const db = require('./src/db');

// 4000, not 3000: the client dev server takes 3000, so keeping the backend off
// that port lets both run at once. In the lab deployment PORT is set to
// whatever the machine's forwarded port maps to.
const PORT = process.env.PORT || 4000;

// Node runs JavaScript on one thread, so a single process uses one core no
// matter how many the machine has. Under concurrent load that is the ceiling,
// so the process forks a worker per core and they share the listening socket.
// Each worker keeps its own copy of the conversation in memory, which is why
// the count is capped: the win from another core stops being worth another
// copy of the feed fairly quickly.
function resolveWorkerCount() {
  const configured = Number(process.env.WORKERS || 0);
  if (configured > 0) return configured;

  // os.cpus() reports the host's cores, not this container's share of them, so
  // it is an upper bound rather than an answer — a container limited to a
  // fraction of a large machine would otherwise fork dozens of workers that
  // only fight each other. The cgroup quota is the real limit where it is set.
  return Math.max(1, Math.min(availableCores(), 8));
}

function availableCores() {
  const fs = require('node:fs');

  // cgroup v2: "<quota> <period>", or "max" when unlimited.
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max') {
      return Math.max(1, Math.floor(Number(quota) / Number(period)));
    }
  } catch {}

  // cgroup v1.
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'));
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'));
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.floor(quota / period));
    }
  } catch {}

  return os.cpus().length;
}

const WORKERS = resolveWorkerCount();

// Peer machines to replicate to, e.g.
// PEERS=http://10.1.75.53:3267,http://10.1.75.53:3268
const PEERS = String(process.env.PEERS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

async function start() {
  // Check the encryption key before anything else. A missing or malformed key
  // only shows up when the first message is sent otherwise, by which point
  // people are already in the room and that message is lost.
  loadKey();

  await db.connect();
  console.log('Connected to MongoDB');

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  const presence = new Presence();
  const messageRateLimiter = new RateLimiter();
  const tracker = createTracker();

  const store = new MessageStore({ roomId: ROOM_ID });
  await store.init(db.getDb());
  store.start();

  const replicator = new Replicator(PEERS);

  // Only one worker per machine reconciles. Every worker shares the same local
  // database, so a second one would re-pull the same messages and repair
  // nothing that the first had not already fixed.
  const reconciler =
    !cluster.isWorker || cluster.worker.id === 1 ? new Reconciler(store, PEERS) : null;
  if (reconciler) reconciler.start();

  startSampling();

  // Bodies arrive as JSON from most clients and as a form post from some, and
  // a request that cannot be parsed is a request that fails, so accept both.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Order matters. The API routes are the hot path and are matched first;
  // putting express.static ahead of them would make every /message and /feed
  // request pay for a filesystem lookup that can only ever miss.
  app.use(createApiRouter({ store, replicator, tracker, reconciler }));
  app.use(createHealthRouter(presence));
  app.use(createLoadTestRouter());
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

  wireChatBroadcast({ io, store });

  io.on('connection', (socket) => {
    registerSocketHandlers(io, socket, {
      presence,
      messageRateLimiter,
      onMessageStored: (id) => markEmitted(id),
    });
  });

  httpServer.listen(PORT, () => {
    console.log(
      `Chat server running on http://localhost:${PORT} ` +
        `(worker ${process.pid}, peers: ${PEERS.length})`
    );
  });

  return { httpServer, io, store, replicator, reconciler };
}

// Messages reach a worker three ways: posted to its own /message route, pushed
// by a peer machine, or written by a sibling worker on this machine and picked
// up by the periodic rescan. Chat clients connected to *this* worker need to
// see all of them, so the store is the single broadcast bus.
//
// The socket path already emits the message it just stored, so ids that went
// out that way are remembered and skipped here rather than being delivered
// twice.
const emittedGenerations = [new Set(), new Set()];

function markEmitted(id) {
  const [current] = emittedGenerations;
  current.add(id);

  // Two generations rather than one unbounded set: when the newest fills up it
  // becomes the older one and a fresh set takes over, so ids stay known for at
  // least one full generation without the set growing forever.
  if (current.size > 10000) {
    emittedGenerations.unshift(new Set());
    emittedGenerations.length = 2;
  }
}

function wasEmitted(id) {
  return emittedGenerations.some((generation) => generation.has(id));
}

function wireChatBroadcast({ io, store }) {
  const deliver = (messages) => {
    // No connected chat clients is the normal case during a load run, and
    // there is nothing to deliver to, so skip the work entirely.
    if (io.engine.clientsCount === 0) {
      for (const message of messages) markEmitted(message.id);
      return;
    }

    for (const message of messages) {
      if (wasEmitted(message.id)) continue;
      markEmitted(message.id);

      io.emit('chat-message', {
        id: message.id,
        username: message.name,
        text: message.text,
        timestamp: message.ts,
        signature: 'unsigned',
        senderPublicKey: null,
        stored: null,
      });
    }
  };

  store.on('messages', deliver);
  store.on('message', (message) => deliver([message]));
}

// Close the database connection on the way out so MongoDB does not keep the
// connection open after the process is gone.
async function shutdown(signal, context) {
  console.log(`\nReceived ${signal}, shutting down.`);

  try {
    if (context) {
      context.io.close();
      context.httpServer.close();
      context.store.stop();
      // Anything still queued was accepted with a promise that it would be
      // stored, so flush before the connection goes away.
      await context.store.flushWrites();
      context.replicator.stop();
      if (context.reconciler) context.reconciler.stop();
    }

    await db.close();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }

  process.exit(0);
}

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`Primary ${process.pid} starting ${WORKERS} workers`);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  // A worker that dies takes its share of the traffic with it, so replace it.
  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} exited (${signal || code}), restarting`);
    cluster.fork();
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      for (const worker of Object.values(cluster.workers)) worker.kill();
      process.exit(0);
    });
  }
} else {
  start()
    .then((context) => {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => shutdown(signal, context));
      }
    })
    .catch((err) => {
      console.error('Failed to start the server:', err.message);
      process.exit(1);
    });
}
