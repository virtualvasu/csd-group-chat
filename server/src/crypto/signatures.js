'use strict';

// ECDSA P-256 signature verification — server side.
//
// Uses the WebCrypto API exposed by Node.js 19+ via `globalThis.crypto.subtle`.
// The public key is expected as a base64-encoded SPKI buffer (the format
// `exportKey('spki', ...)` produces in the browser).
// The signature is expected as a base64-encoded DER-encoded ECDSA signature.

const { randomBytes } = require('node:crypto');

const { buildCanonicalBytes } = require('./canonical');

/**
 * Verifies an ECDSA P-256 signature over an arbitrary byte string.
 *
 * This is the primitive both callers share: message signatures verify over the
 * canonical message bytes, login proofs verify over a random challenge.
 *
 * @param {Buffer|Uint8Array} bytes - The exact bytes that were signed.
 * @param {string} signatureB64     - base64-encoded signature bytes.
 * @param {string} publicKeyB64     - base64-encoded SPKI public key.
 * @returns {Promise<boolean>}      - true if the signature is valid.
 */
async function verifyBytes(bytes, signatureB64, publicKeyB64) {
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'spki',
      Buffer.from(publicKeyB64, 'base64'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // not extractable
      ['verify']
    );

    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      Buffer.from(signatureB64, 'base64'),
      bytes
    );
  } catch {
    // Any import or format error is treated as a bad signature.
    return false;
  }
}

/**
 * Imports a base64 SPKI public key and verifies an ECDSA P-256 signature.
 *
 * @param {string} username       - The sender's username.
 * @param {number} clientTimestamp - The timestamp claimed by the client (ms).
 * @param {string} text           - The raw message text.
 * @param {string} signatureB64   - base64-encoded signature bytes.
 * @param {string} publicKeyB64   - base64-encoded SPKI public key.
 * @returns {Promise<boolean>}    - true if the signature is valid.
 */
async function verifySignature(username, clientTimestamp, text, signatureB64, publicKeyB64) {
  return verifyBytes(
    buildCanonicalBytes(username, clientTimestamp, text),
    signatureB64,
    publicKeyB64
  );
}

/**
 * Returns a fresh random login challenge as a base64 string.
 *
 * The client signs the decoded bytes of this value to prove it holds the
 * private key for the public key it is presenting. It is single-use: the
 * server drops it as soon as one proof is checked against it.
 *
 * @returns {string} base64-encoded 32 random bytes.
 */
function createChallenge() {
  return randomBytes(32).toString('base64');
}

/**
 * Returns true if the client timestamp is within the allowed skew window.
 *
 * @param {number} clientTimestamp  - Client's claimed timestamp (ms since epoch).
 * @param {number} [maxSkewMs=60000] - Maximum allowed skew in milliseconds.
 * @returns {boolean}
 */
function isTimestampFresh(clientTimestamp, maxSkewMs = 60_000) {
  return Math.abs(Date.now() - clientTimestamp) <= maxSkewMs;
}

module.exports = { verifyBytes, verifySignature, isTimestampFresh, createChallenge };
