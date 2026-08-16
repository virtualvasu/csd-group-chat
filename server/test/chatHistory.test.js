const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

const { Presence } = require('../src/presence');
const { RateLimiter } = require('../src/rateLimiter');
const { registerSocketHandlers } = require('../src/socketHandlers');
const database = require('../src/db');
const { COLLECTION, toBuffer } = require('../src/db/messageRepository');
const { buildCanonicalBytes } = require('../src/crypto/canonical');
const { connectTestDb, clearTestDb, closeTestDb, skipReason } = require('./helpers/testDb');
const { useTestEncryptionKey } = require('./helpers/testKey');

useTestEncryptionKey();

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

// Sends messages one at a time, waiting for each broadcast, so they keep their
// order and are all stored before the next step of a test runs.
async function send(socket, texts) {
  for (const text of texts) {
    const broadcast = waitForEvent(socket, 'chat-message');
    socket.emit('chat-message', text);
    // eslint-disable-next-line no-await-in-loop
    await broadcast;
  }
}

// Joins the chat and returns the history the server sent on the way in.
async function joinAs(socket, username, publicKey = null) {
  const historyPromise = waitForEvent(socket, 'chat-history');
  socket.emit('join', publicKey ? { username, publicKey } : username);
  await waitForEvent(socket, 'join-success');

  return historyPromise;
}

// Stands in for a browser holding an ECDSA identity, so these tests can send
// messages that are signed the way a real client signs them.
async function createIdentity() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey));

  return {
    publicKey: spki.toString('base64'),
    async sign(username, timestamp, text) {
      const signature = await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        buildCanonicalBytes(username, timestamp, text)
      );

      return Buffer.from(signature).toString('base64');
    },
  };
}

// Sends one signed message and resolves once the server has broadcast it,
// which is also when it is safely stored.
async function sendSigned(socket, identity, username, text) {
  const timestamp = Date.now();
  const broadcast = waitForEvent(socket, 'chat-message');

  socket.emit('chat-message', {
    text,
    timestamp,
    signature: await identity.sign(username, timestamp, text),
  });

  return broadcast;
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

    await send(first, ['one', 'two']);

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

test('a stored message does not hold readable text', { skip }, async () => {
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await joinAs(client, 'Asha');
    await send(client, ['meet me at four']);
  } finally {
    client.disconnect();
  }

  const stored = await database.getDb().collection(COLLECTION).findOne({});

  assert.ok(!toBuffer(stored.ciphertext).toString('utf8').includes('meet me at four'));
  assert.equal(toBuffer(stored.nonce).length, 12);
});

test('a tampered message is flagged and the others still load', { skip }, async () => {
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await joinAs(first, 'Asha');
    await send(first, ['safe one', 'edited one']);
  } finally {
    first.disconnect();
  }

  // Change the stored bytes behind the server's back, the way the tamper demo
  // script does.
  const messages = database.getDb().collection(COLLECTION);
  const latest = await messages.findOne({}, { sort: { _id: -1 } });
  const tampered = toBuffer(latest.ciphertext);
  tampered[0] ^= 0x01;
  await messages.updateOne({ _id: latest._id }, { $set: { ciphertext: tampered } });

  const second = connectClient();

  try {
    await waitForEvent(second, 'connect');
    const history = await joinAs(second, 'Kunal');

    assert.equal(history.length, 2);
    assert.equal(history[0].text, 'safe one');
    assert.equal(history[0].integrity, undefined);
    assert.equal(history[1].text, null);
    assert.equal(history[1].integrity, 'failed');
    assert.equal(history[1].username, 'Asha');
  } finally {
    second.disconnect();
  }
});

// The next three cover the seam between the two features: messages are stored
// encrypted, but the signature is over the plaintext, so history has to decrypt
// before it can verify. Getting that order wrong makes every signature look
// invalid, which is why each verdict is pinned down separately here.

test('a signature still verifies after a round trip through storage', { skip }, async () => {
  const identity = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await joinAs(first, 'Asha', identity.publicKey);
    await sendSigned(first, identity, 'Asha', 'signed and stored');
  } finally {
    first.disconnect();
  }

  const second = connectClient();

  try {
    await waitForEvent(second, 'connect');
    const history = await joinAs(second, 'Kunal');

    assert.equal(history.length, 1);
    assert.equal(history[0].text, 'signed and stored');
    assert.equal(history[0].signature, 'valid');
    assert.equal(history[0].integrity, undefined);
    assert.equal(history[0].senderPublicKey, identity.publicKey);
  } finally {
    second.disconnect();
  }
});

test('editing a stored signature is caught but leaves the text readable', { skip }, async () => {
  const identity = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await joinAs(first, 'Asha', identity.publicKey);
    await sendSigned(first, identity, 'Asha', 'who really sent this');
  } finally {
    first.disconnect();
  }

  // Only the signature is touched, so the ciphertext still decrypts cleanly.
  const messages = database.getDb().collection(COLLECTION);
  const latest = await messages.findOne({}, { sort: { _id: -1 } });
  const forged = toBuffer(latest.signature);
  forged[0] ^= 0x01;
  await messages.updateOne({ _id: latest._id }, { $set: { signature: forged } });

  const second = connectClient();

  try {
    await waitForEvent(second, 'connect');
    const history = await joinAs(second, 'Kunal');

    // The message is readable and its bytes are intact, so integrity passes.
    // What failed is the claim about who wrote it.
    assert.equal(history[0].text, 'who really sent this');
    assert.equal(history[0].integrity, undefined);
    assert.equal(history[0].signature, 'invalid');
  } finally {
    second.disconnect();
  }
});

test('a message that will not decrypt is not blamed on its sender', { skip }, async () => {
  const identity = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await joinAs(first, 'Asha', identity.publicKey);
    await sendSigned(first, identity, 'Asha', 'bytes about to be broken');
  } finally {
    first.disconnect();
  }

  const messages = database.getDb().collection(COLLECTION);
  const latest = await messages.findOne({}, { sort: { _id: -1 } });
  const tampered = toBuffer(latest.ciphertext);
  tampered[0] ^= 0x01;
  await messages.updateOne({ _id: latest._id }, { $set: { ciphertext: tampered } });

  const second = connectClient();

  try {
    await waitForEvent(second, 'connect');
    const history = await joinAs(second, 'Kunal');

    assert.equal(history[0].text, null);
    assert.equal(history[0].integrity, 'failed');
    // Not 'invalid'. There is no plaintext left to check the signature over, so
    // saying the signature failed would accuse the sender of something the
    // server cannot actually tell.
    assert.equal(history[0].signature, 'unknown');
  } finally {
    second.disconnect();
  }
});
