// Signature verification tests — server side.
//
// These are pure crypto tests: no database, no socket, no server process.
// They run as part of `npm test` alongside the existing suite.
//
// Shared test vector (matches client/src/lib/canonical.ts):
//   username  = "alice"
//   timestamp = 1700000000000
//   text      = "hello"
//   canonical = "alice\n1700000000000\nhello" as UTF-8

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCanonicalBytes } = require('../src/crypto/canonical');
const { verifySignature, isTimestampFresh } = require('../src/crypto/signatures');

// ---------------------------------------------------------------------------
// Shared test vector — asserted here and documented in client/src/lib/canonical.ts
// ---------------------------------------------------------------------------

test('canonical test vector produces the expected UTF-8 bytes', () => {
  const bytes = buildCanonicalBytes('alice', 1700000000000, 'hello');
  const expected = Buffer.from('alice\n1700000000000\nhello', 'utf8');
  assert.deepEqual(bytes, expected);
});

// ---------------------------------------------------------------------------
// Helpers: generate an ephemeral ECDSA P-256 key pair for testing only.
// The private key IS extractable here so we can sign test data.
// ---------------------------------------------------------------------------

async function generateTestKeyPair() {
  return globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable — test only, never done in production
    ['sign', 'verify']
  );
}

async function signBytes(privateKey, bytes) {
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    bytes
  );
  return Buffer.from(sig).toString('base64');
}

async function exportPublicKey(publicKey) {
  const spki = await globalThis.crypto.subtle.exportKey('spki', publicKey);
  return Buffer.from(spki).toString('base64');
}

// ---------------------------------------------------------------------------
// Signature tests
// ---------------------------------------------------------------------------

test('a valid ECDSA signature verifies successfully', async () => {
  const { privateKey, publicKey } = await generateTestKeyPair();
  const publicKeyB64 = await exportPublicKey(publicKey);

  const username = 'alice';
  const timestamp = Date.now();
  const text = 'hello from the test suite';

  const canonical = buildCanonicalBytes(username, timestamp, text);
  const signatureB64 = await signBytes(privateKey, canonical);

  const ok = await verifySignature(username, timestamp, text, signatureB64, publicKeyB64);
  assert.equal(ok, true, 'Expected valid signature to pass verification');
});

test('a modified text field fails verification', async () => {
  const { privateKey, publicKey } = await generateTestKeyPair();
  const publicKeyB64 = await exportPublicKey(publicKey);

  const username = 'alice';
  const timestamp = Date.now();
  const text = 'original message';

  const canonical = buildCanonicalBytes(username, timestamp, text);
  const signatureB64 = await signBytes(privateKey, canonical);

  // Tamper with the text after signing — verification must fail.
  const ok = await verifySignature(username, timestamp, 'TAMPERED message', signatureB64, publicKeyB64);
  assert.equal(ok, false, 'Expected tampered text to fail verification');
});

test('a signature made with a different key pair fails verification', async () => {
  const senderKeys = await generateTestKeyPair();
  const attackerKeys = await generateTestKeyPair();

  const senderPublicKeyB64 = await exportPublicKey(senderKeys.publicKey);

  const username = 'alice';
  const timestamp = Date.now();
  const text = 'genuine message';

  const canonical = buildCanonicalBytes(username, timestamp, text);
  // Sign with the attacker's private key but verify against the sender's public key.
  const attackerSig = await signBytes(attackerKeys.privateKey, canonical);

  const ok = await verifySignature(username, timestamp, text, attackerSig, senderPublicKeyB64);
  assert.equal(ok, false, 'Expected wrong-key signature to fail verification');
});

// ---------------------------------------------------------------------------
// Anti-replay — timestamp freshness
// ---------------------------------------------------------------------------

test('a client timestamp more than 60s in the past is rejected', () => {
  const staleTimestamp = Date.now() - 61_000;
  assert.equal(isTimestampFresh(staleTimestamp), false, 'Expected stale timestamp to be rejected');
});

test('a client timestamp more than 60s in the future is rejected', () => {
  const futureTimestamp = Date.now() + 61_000;
  assert.equal(isTimestampFresh(futureTimestamp), false, 'Expected far-future timestamp to be rejected');
});

test('a client timestamp within the 60s window is accepted', () => {
  const freshTimestamp = Date.now() - 5_000;
  assert.equal(isTimestampFresh(freshTimestamp), true, 'Expected fresh timestamp to be accepted');
});
