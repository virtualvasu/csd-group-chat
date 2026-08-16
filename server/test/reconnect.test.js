const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

const { Presence } = require('../src/presence');
const { RateLimiter } = require('../src/rateLimiter');
const { registerSocketHandlers } = require('../src/socketHandlers');
const { connectTestDb, closeTestDb, skipReason } = require('./helpers/testDb');
const { useTestEncryptionKey } = require('./helpers/testKey');
const { waitForEvent, createIdentity, loginAs } = require('./helpers/testIdentity');

useTestEncryptionKey();

// Joining now also reads the stored messages, so these tests need a database
// as well. Without one the join still works, but it logs an error every time.
const needsDatabase = !skipReason();

let httpServer;
let ioServer;
let port;
let presence;
let rateLimiter;

test.before(async () => {
  if (needsDatabase) await connectTestDb('reconnect');

  const app = createServer();
  ioServer = new Server(app, { transports: ['websocket'] });
  presence = new Presence();
  rateLimiter = new RateLimiter();

  ioServer.on('connection', (socket) => {
    registerSocketHandlers(ioServer, socket, { presence, messageRateLimiter: rateLimiter });
  });

  await new Promise((resolve) => {
    httpServer = app.listen(0, () => resolve());
  });

  port = httpServer.address().port;
});

test.after(async () => {
  if (ioServer) {
    ioServer.close();
  }
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }
  if (needsDatabase) await closeTestDb();
});

// Logging in reads and writes the sender key store, so this one needs a
// database even though what it is really checking is presence bookkeeping.
test('rejoining a username after disconnect keeps a single presence entry', { skip: skipReason() }, async () => {
  const kunal = await createIdentity();
  const asha = await createIdentity();

  const first = io(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: true,
  });

  const second = io(`http://localhost:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: true,
  });

  try {
    await Promise.all([
      waitForEvent(first, 'connect'),
      waitForEvent(second, 'connect'),
    ]);

    const secondUsersPromise = new Promise((resolve) => {
      const onOnlineUsers = (list) => {
        if (list.includes('Kunal') && list.includes('Asha')) {
          second.off('online-users', onOnlineUsers);
          resolve(list);
        }
      };
      second.on('online-users', onOnlineUsers);
    });

    await loginAs(first, 'Kunal', kunal);
    await loginAs(second, 'Asha', asha);

    const userListAfterJoin = await secondUsersPromise;

    assert.ok(userListAfterJoin.includes('Kunal'));
    assert.ok(userListAfterJoin.includes('Asha'));

    first.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const reconnecting = io(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: true,
    });

    await waitForEvent(reconnecting, 'connect');

    const secondUpdatedUsersPromise = new Promise((resolve) => {
      const onOnlineUsers = (list) => {
        const count = list.filter((name) => name === 'Kunal').length;
        if (count === 1) {
          second.off('online-users', onOnlineUsers);
          resolve(list);
        }
      };
      second.on('online-users', onOnlineUsers);
    });

    // The same identity, because the username is bound to it now. Coming back
    // with a fresh key pair would be refused rather than treated as Kunal.
    await loginAs(reconnecting, 'Kunal', kunal);
    const userListAfterRejoin = await secondUpdatedUsersPromise;

    assert.ok(userListAfterRejoin.includes('Kunal'));
    assert.equal(userListAfterRejoin.filter((name) => name === 'Kunal').length, 1);

    reconnecting.disconnect();
    second.disconnect();
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('reconnect should allow the same username during a short stale-disconnect grace period', () => {
  const staleSocketId = 'stale-1';
  const newSocketId = 'fresh-1';

  presence.add(staleSocketId, 'Thor');
  presence.remove(staleSocketId);
  assert.equal(presence.hasRecentDisconnect('Thor'), true);

  const reclaimed = presence.reclaimUsername(newSocketId, 'Thor');
  assert.equal(reclaimed, true);
  assert.equal(presence.get(newSocketId), 'Thor');
  assert.equal(presence.isUsernameTaken('Thor'), true);
  assert.equal(presence.list().filter((name) => name === 'Thor').length, 1);
});

test('duplicate active usernames are still rejected', () => {
  presence.add('socket-a', 'Hulk');
  presence.add('socket-b', 'Hulk');

  assert.equal(presence.isUsernameTaken('Hulk'), true);
  assert.equal(presence.list().filter((name) => name === 'Hulk').length, 2);
});
