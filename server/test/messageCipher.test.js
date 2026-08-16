const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestEncryptionKey } = require('./helpers/testKey');

useTestEncryptionKey();

const { encrypt, decrypt, NONCE_BYTES, TAG_BYTES } = require('../src/crypto/messageCipher');

// Returns a copy of the buffer with one bit of the given byte flipped, which is
// the smallest change an attacker could make to a stored field.
function flipByte(buffer, index = 0) {
  const changed = Buffer.from(buffer);
  changed[index] ^= 0x01;

  return changed;
}

test('a message survives a round trip', () => {
  const stored = encrypt('hello there');

  assert.equal(decrypt(stored), 'hello there');
});

test('unicode text comes back unchanged', () => {
  const text = 'नमस्ते 🌱';

  assert.equal(decrypt(encrypt(text)), text);
});

test('the stored bytes do not contain the message', () => {
  const { ciphertext } = encrypt('meet me at four');

  assert.ok(!ciphertext.toString('utf8').includes('meet me at four'));
});

test('the same text encrypts differently every time', () => {
  const first = encrypt('same text');
  const second = encrypt('same text');

  // Both the nonce and the ciphertext have to differ. A repeated nonce would
  // reveal that the two messages are identical and break GCM's guarantees.
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.nonce.length, NONCE_BYTES);
});

test('the ciphertext carries the authentication tag', () => {
  const { ciphertext } = encrypt('x');

  assert.equal(ciphertext.length, 1 + TAG_BYTES);
});

test('a changed ciphertext byte is rejected', () => {
  const stored = encrypt('transfer 100');

  assert.throws(() => decrypt({ ...stored, ciphertext: flipByte(stored.ciphertext) }));
});

test('a changed authentication tag is rejected', () => {
  const stored = encrypt('transfer 100');
  const lastByte = stored.ciphertext.length - 1;

  assert.throws(() => decrypt({ ...stored, ciphertext: flipByte(stored.ciphertext, lastByte) }));
});

test('a changed nonce is rejected', () => {
  const stored = encrypt('transfer 100');

  assert.throws(() => decrypt({ ...stored, nonce: flipByte(stored.nonce) }));
});

test('a message with no nonce is rejected', () => {
  const { ciphertext } = encrypt('stored before encryption existed');

  assert.throws(() => decrypt({ ciphertext, nonce: null }));
});
