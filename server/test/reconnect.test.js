const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

const { Presence } = require('../src/presence');
const { RateLimiter } = require('../src/rateLimiter');
const { registerSocketHandlers } = require('../src/socketHandlers');

let httpServer;
let ioServer;
let port;
let presence;
let rateLimiter;

function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test.before(async () => {
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
});

test('rejoining a username after disconnect keeps a single presence entry', async () => {
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

    const firstJoinPromise = waitForEvent(first, 'join-success');
    const secondJoinPromise = waitForEvent(second, 'join-success');

    const secondUsersPromise = new Promise((resolve) => {
      const onOnlineUsers = (list) => {
        if (list.includes('Kunal') && list.includes('Asha')) {
          second.off('online-users', onOnlineUsers);
          resolve(list);
        }
      };
      second.on('online-users', onOnlineUsers);
    });

    first.emit('join', 'Kunal');
    second.emit('join', 'Asha');

    const firstJoin = await firstJoinPromise;
    const secondJoin = await secondJoinPromise;
    const userListAfterJoin = await secondUsersPromise;

    assert.equal(firstJoin.username, 'Kunal');
    assert.equal(secondJoin.username, 'Asha');
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

    const reconnectingJoinPromise = waitForEvent(reconnecting, 'join-success');
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

    reconnecting.emit('join', 'Kunal');
    const rejoinSuccess = await reconnectingJoinPromise;
    const userListAfterRejoin = await secondUpdatedUsersPromise;

    assert.equal(rejoinSuccess.username, 'Kunal');
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
