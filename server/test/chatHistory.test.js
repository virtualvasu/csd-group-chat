const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

const { Presence } = require('../src/presence');
const { RateLimiter } = require('../src/rateLimiter');
const { registerSocketHandlers } = require('../src/socketHandlers');
const database = require('../src/db');
const { COLLECTION, toBuffer } = require('../src/db/messageRepository');
const { connectTestDb, clearTestDb, closeTestDb, skipReason } = require('./helpers/testDb');
const { useTestEncryptionKey } = require('./helpers/testKey');
const {
  waitForEvent,
  createIdentity,
  loginAs,
  sendSigned,
} = require('./helpers/testIdentity');

useTestEncryptionKey();

const skip = skipReason();

let httpServer;
let ioServer;
let port;

function connectClient() {
  return io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
}

// Sends messages one at a time, waiting for each broadcast, so they keep their
// order and are all stored before the next step of a test runs.
async function send(socket, identity, username, texts) {
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await sendSigned(socket, identity, username, text);
  }
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
  const identity = await createIdentity();
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await loginAs(client, 'Asha', identity);

    const message = await sendSigned(client, identity, 'Asha', 'hello');

    assert.equal(message.text, 'hello');
    assert.equal(message.username, 'Asha');
    assert.equal(typeof message.id, 'string');
    assert.equal(message.id.length, 24);
  } finally {
    client.disconnect();
  }
});

test('someone joining later receives the earlier messages', { skip }, async () => {
  const asha = await createIdentity();
  const kunal = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    const emptyHistory = await loginAs(first, 'Asha', asha);
    assert.deepEqual(emptyHistory, []);

    await send(first, asha, 'Asha', ['one', 'two']);

    const second = connectClient();

    try {
      await waitForEvent(second, 'connect');
      const history = await loginAs(second, 'Kunal', kunal);

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
  const asha = await createIdentity();
  const kunal = await createIdentity();
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await loginAs(client, 'Asha', asha);
    await sendSigned(client, asha, 'Asha', 'still here tomorrow');
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
    const history = await loginAs(afterRestart, 'Kunal', kunal);

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
  const asha = await createIdentity();
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await loginAs(client, 'Asha', asha);
    await send(client, asha, 'Asha', ['meet me at four']);
  } finally {
    client.disconnect();
  }

  const stored = await database.getDb().collection(COLLECTION).findOne({});

  assert.ok(!toBuffer(stored.ciphertext).toString('utf8').includes('meet me at four'));
  assert.equal(toBuffer(stored.nonce).length, 12);
});

test('a tampered message is flagged and the others still load', { skip }, async () => {
  const asha = await createIdentity();
  const kunal = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await loginAs(first, 'Asha', asha);
    await send(first, asha, 'Asha', ['safe one', 'edited one']);
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
    const history = await loginAs(second, 'Kunal', kunal);

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

// Logging in has to prove possession of a private key, not just knowledge of a
// public one. A public key is not a secret — it is broadcast with every message
// its owner sends — so these two pin down that presenting one is not enough.

test("presenting someone else's public key does not get you their username", { skip }, async () => {
  const asha = await createIdentity();
  const impostor = await createIdentity();

  const real = connectClient();

  try {
    await waitForEvent(real, 'connect');
    await loginAs(real, 'Asha', asha);
  } finally {
    real.disconnect();
  }

  const fake = connectClient();

  try {
    await waitForEvent(fake, 'connect');

    // Asha's public key is readable by anyone who saw one of her messages, so
    // the impostor gets this far without any secret at all.
    const challengePromise = waitForEvent(fake, 'auth-challenge');
    fake.emit('auth-start', { username: 'Asha', publicKey: asha.publicKey });
    const { challenge } = await challengePromise;

    // What they cannot do is sign the challenge with Asha's private key.
    const errorPromise = waitForEvent(fake, 'join-error');
    fake.emit('auth-response', {
      signature: await impostor.signBytes(Buffer.from(challenge, 'base64')),
    });

    const { message } = await errorPromise;
    assert.match(message, /private key/i);
  } finally {
    fake.disconnect();
  }
});

test('an unsigned message is refused and never stored', { skip }, async () => {
  const asha = await createIdentity();
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await loginAs(client, 'Asha', asha);

    // The shape the old unsigned client used.
    const bareStringError = waitForEvent(client, 'message-error');
    client.emit('chat-message', 'no signature here');
    assert.match((await bareStringError).message, /unsigned/i);

    // And a well-formed payload that simply omits the signature.
    const missingSignatureError = waitForEvent(client, 'message-error');
    client.emit('chat-message', { text: 'still no signature', timestamp: Date.now() });
    assert.match((await missingSignatureError).message, /unsigned/i);

    const stored = await database.getDb().collection(COLLECTION).countDocuments({});
    assert.equal(stored, 0);
  } finally {
    client.disconnect();
  }
});

test('a message carries the stored ciphertext alongside its text', { skip }, async () => {
  const asha = await createIdentity();
  const client = connectClient();

  try {
    await waitForEvent(client, 'connect');
    await loginAs(client, 'Asha', asha);

    const broadcast = await sendSigned(client, asha, 'Asha', 'show me the bytes');

    // What the client needs to render its encrypted view without asking again.
    assert.equal(typeof broadcast.stored.ciphertext, 'string');
    assert.equal(Buffer.from(broadcast.stored.nonce, 'base64').length, 12);
    assert.ok(!Buffer.from(broadcast.stored.ciphertext, 'base64').toString('utf8').includes('show me the bytes'));

    // And it matches the row that history will hand back later.
    const persisted = await database.getDb().collection(COLLECTION).findOne({});
    assert.equal(toBuffer(persisted.ciphertext).toString('base64'), broadcast.stored.ciphertext);
  } finally {
    client.disconnect();
  }
});

// The next three cover the seam between the two features: messages are stored
// encrypted, but the signature is over the plaintext, so history has to decrypt
// before it can verify. Getting that order wrong makes every signature look
// invalid, which is why each verdict is pinned down separately here.

test('a signature still verifies after a round trip through storage', { skip }, async () => {
  const identity = await createIdentity();
  const kunal = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await loginAs(first, 'Asha', identity);
    await sendSigned(first, identity, 'Asha', 'signed and stored');
  } finally {
    first.disconnect();
  }

  const second = connectClient();

  try {
    await waitForEvent(second, 'connect');
    const history = await loginAs(second, 'Kunal', kunal);

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
  const kunal = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await loginAs(first, 'Asha', identity);
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
    const history = await loginAs(second, 'Kunal', kunal);

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
  const kunal = await createIdentity();
  const first = connectClient();

  try {
    await waitForEvent(first, 'connect');
    await loginAs(first, 'Asha', identity);
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
    const history = await loginAs(second, 'Kunal', kunal);

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
