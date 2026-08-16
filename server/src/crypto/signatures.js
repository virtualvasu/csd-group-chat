'use strict';

// ECDSA P-256 signature verification — server side.
//
// Uses the WebCrypto API exposed by Node.js 19+ via `globalThis.crypto.subtle`.
// The public key is expected as a base64-encoded SPKI buffer (the format
// `exportKey('spki', ...)` produces in the browser).
// The signature is expected as a base64-encoded DER-encoded ECDSA signature.

const { buildCanonicalBytes } = require('./canonical');

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
  try {
    const keyBytes = Buffer.from(publicKeyB64, 'base64');
    const sigBytes = Buffer.from(signatureB64, 'base64');
    const canonicalBytes = buildCanonicalBytes(username, clientTimestamp, text);

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'spki',
      keyBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // not extractable
      ['verify']
    );

    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      sigBytes,
      canonicalBytes
    );
  } catch {
    // Any import or format error is treated as a bad signature.
    return false;
  }
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

module.exports = { verifySignature, isTimestampFresh };
