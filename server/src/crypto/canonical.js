// Canonical signing payload — server side.
// Counterpart: client/src/lib/canonical.ts
//
// Both sides must produce the identical byte sequence for the same inputs.
// The format is:
//
//   <username>\n<timestamp>\n<text>
//
// where <timestamp> is the client's claimed UNIX millisecond integer.
// Only UTF-8 is used; no BOM, no trailing newline.
//
// --- Shared test vector ---
// Input:  username = "alice", timestamp = 1700000000000, text = "hello"
// Bytes:  "alice\n1700000000000\nhello" as UTF-8
// Hex:    61 6c 69 63 65 0a 31 37 30 30 30 30 30 30 30 30
//         30 30 30 0a 68 65 6c 6c 6f

'use strict';

/**
 * Returns a Buffer containing the canonical bytes to sign/verify for a message.
 *
 * @param {string} username       - The sender's username (as stored on the socket).
 * @param {number} timestamp      - The client's claimed timestamp (ms since epoch).
 * @param {string} text           - The raw message text (after trimming, before storage).
 * @returns {Buffer}
 */
function buildCanonicalBytes(username, timestamp, text) {
  return Buffer.from(`${username}\n${timestamp}\n${text}`, 'utf8');
}

module.exports = { buildCanonicalBytes };
