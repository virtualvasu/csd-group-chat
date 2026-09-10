const test = require('node:test');
const assert = require('node:assert/strict');

const { saveMessage, getHistory } = require('../src/db/messageRepository');
const { connectTestDb, clearTestDb, closeTestDb, skipReason } = require('./helpers/testDb');

const skip = skipReason();
const ROOM = 'main';

// Saves several messages in order and returns the text of each one.
async function saveAll(texts, roomId = ROOM) {
  const ids = [];

  for (const text of texts) {
    // Saved one at a time so the ids stay in the same order as the texts.
    // eslint-disable-next-line no-await-in-loop
    const { id } = await saveMessage({
      roomId,
      senderId: 'Asha',
      ciphertext: Buffer.from(text, 'utf8'),
    });
    ids.push(id);
  }

  return ids;
}

function textsOf(history) {
  return history.map((message) => message.ciphertext.toString('utf8'));
}

test.before(async () => {
  if (skip) return;
  await connectTestDb('repository');
});

test.beforeEach(async () => {
  if (skip) return;
  await clearTestDb();
});

test.after(async () => {
  if (skip) return;
  await closeTestDb();
});

test('a saved message comes back with the same content', { skip }, async () => {
  const timestamp = new Date();

  const { id } = await saveMessage({
    roomId: ROOM,
    senderId: 'Kunal',
    ciphertext: Buffer.from('hello there', 'utf8'),
    timestamp,
  });

  const history = await getHistory(ROOM);

  assert.equal(history.length, 1);
  assert.equal(history[0].id, id);
  assert.equal(history[0].senderId, 'Kunal');
  assert.equal(history[0].ciphertext.toString('utf8'), 'hello there');
  assert.equal(history[0].timestamp.getTime(), timestamp.getTime());
});

test('history comes back oldest first', { skip }, async () => {
  await saveAll(['first', 'second', 'third']);

  const history = await getHistory(ROOM);

  assert.deepEqual(textsOf(history), ['first', 'second', 'third']);
});

test('the limit keeps the newest messages, still oldest first', { skip }, async () => {
  await saveAll(['one', 'two', 'three', 'four', 'five']);

  const history = await getHistory(ROOM, 2);

  // The point of this test: asking for 2 must give the two most recent
  // messages, not the two oldest ones.
  assert.deepEqual(textsOf(history), ['four', 'five']);
});

test('messages from another room are not returned', { skip }, async () => {
  await saveAll(['in main'], ROOM);
  await saveAll(['somewhere else'], 'other-room');

  const history = await getHistory(ROOM);

  assert.deepEqual(textsOf(history), ['in main']);
});

test('the fields used later for signing default to empty', { skip }, async () => {
  await saveAll(['no signature yet']);

  const [message] = await getHistory(ROOM);

  assert.equal(message.signature, null);
  assert.equal(message.senderPublicKey, null);
});

test('saving the same messageId twice does not insert a duplicate', { skip }, async () => {
  const first = await saveMessage({
    roomId: ROOM,
    senderId: 'Asha',
    ciphertext: Buffer.from('retry me', 'utf8'),
    messageId: 'client-generated-id-1',
  });
  const second = await saveMessage({
    roomId: ROOM,
    senderId: 'Asha',
    ciphertext: Buffer.from('retry me', 'utf8'),
    messageId: 'client-generated-id-1',
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const history = await getHistory(ROOM);
  assert.equal(history.length, 1);
});

test('messages without a messageId still each get their own unique id', { skip }, async () => {
  const first = await saveMessage({
    roomId: ROOM,
    senderId: 'Asha',
    ciphertext: Buffer.from('one', 'utf8'),
  });
  const second = await saveMessage({
    roomId: ROOM,
    senderId: 'Asha',
    ciphertext: Buffer.from('two', 'utf8'),
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
});

test('the nonce is stored and returned alongside the message', { skip }, async () => {
  const nonce = Buffer.from('0123456789ab', 'utf8');

  await saveMessage({
    roomId: ROOM,
    senderId: 'Asha',
    ciphertext: Buffer.from('some bytes', 'utf8'),
    nonce,
  });

  const [message] = await getHistory(ROOM);

  assert.deepEqual(message.nonce, nonce);
});
