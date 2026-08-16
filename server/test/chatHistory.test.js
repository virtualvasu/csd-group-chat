const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

const { Presence } = require('../src/presence');
const { RateLimiter } = require('../src/rateLimiter');
const { registerSocketHandlers } = require('../src/socketHandlers');
const { connectTestDb, clearTestDb, closeTestDb, skipReason } = require('./helpers/testDb');

const skip = skipReason();

let httpServer;
let ioServer;
let port;

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName}`)),
      timeoutMs
    );
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connectClient() {
  return io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
}

// Joins the chat and returns the history the server sent on the way in.
async function joinAs(socket, username) {
  const historyPromise = waitForEvent(socket, 'chat-history');
  socket.emit('join', username);
  await waitForEvent(socket, 'join-success');

  return historyPromise;
}

test.before(async () => {
  if (skip) return;

  await connectTestDb('history');

  const app = createServer();
  ioServer = new Server(app, { transports: ['websocket'] });
  const presence = new Presence();
  const messageRateLimiter = new RateLimiter();

  ioServer.on('connection', (socket) => {
    registerSocketHandlers(ioServer, socket, { presence, messageRateLimiter });
  });

  await new Promise((resolve) => {
    httpServer = app.listen(0, resolve);
  });

  port = httpServer.address().port;
});

test.beforeEach(async () => {
  if (skip) return;
  await clearTestDb();
});

test.after(async () => {
  if (skip) return;

  if (ioServer) ioServer.close();
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await closeTestDb();
});

test('a broadcast message carries the id it was stored under', { skip }, async () => {
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await joinAs(client, 'Asha');

    const messagePromise = waitForEvent(client, 'chat-message');
    client.emit('chat-message', 'hello');
    const message = await messagePromise;

    assert.equal(message.text, 'hello');
    assert.equal(message.username, 'Asha');
    assert.equal(typeof message.id, 'string');
    assert.equal(message.id.length, 24);
  } finally {
    client.disconnect();
  }
});

test('someone joining later receives the earlier messages', { skip }, async () => {
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    const emptyHistory = await joinAs(first, 'Asha');
    assert.deepEqual(emptyHistory, []);

    for (const text of ['one', 'two']) {
      const sent = waitForEvent(first, 'chat-message');
      first.emit('chat-message', text);
      // Waited for one at a time so the two messages keep their order.
      // eslint-disable-next-line no-await-in-loop
      await sent;
    }

    const second = connectClient();

    try {
      await waitForEvent(second, 'connect');
      const history = await joinAs(second, 'Kunal');

      assert.deepEqual(
        history.map((message) => message.text),
        ['one', 'two']
      );
      assert.equal(history[0].username, 'Asha');
      assert.equal(typeof history[0].timestamp, 'number');
    } finally {
      second.disconnect();
    }
  } finally {
    first.disconnect();
  }
});

test('messages survive a server restart', { skip }, async () => {
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await joinAs(client, 'Asha');

    const sent = waitForEvent(client, 'chat-message');
    client.emit('chat-message', 'still here tomorrow');
    await sent;
  } finally {
    client.disconnect();
  }

  // Standing in for a restart: a brand new server with fresh in-memory state,
  // reading from the same database.
  const app = createServer();
  const restarted = new Server(app, { transports: ['websocket'] });
  const presence = new Presence();
  const messageRateLimiter = new RateLimiter();

  restarted.on('connection', (socket) => {
    registerSocketHandlers(restarted, socket, { presence, messageRateLimiter });
  });

  const restartedHttp = await new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

  const afterRestart = io(`http://localhost:${restartedHttp.address().port}`, {
    transports: ['websocket'],
    forceNew: true,
  });

  try {
    await waitForEvent(afterRestart, 'connect');
    const history = await joinAs(afterRestart, 'Kunal');

    assert.deepEqual(
      history.map((message) => message.text),
      ['still here tomorrow']
    );
  } finally {
    afterRestart.disconnect();
    restarted.close();
    await new Promise((resolve) => restartedHttp.close(resolve));
  }
});
