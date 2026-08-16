// Canonical signing payload — client side.
// Counterpart: server/src/crypto/canonical.js
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

const encoder = new TextEncoder();

/**
 * Returns a Uint8Array containing the canonical bytes to sign/verify for a message.
 *
 * @param username  - The sender's username.
 * @param timestamp - The client's claimed timestamp (ms since epoch).
 * @param text      - The raw message text (after trimming).
 */
export function buildCanonicalBytes(
  username: string,
  timestamp: number,
  text: string
): Uint8Array {
  return encoder.encode(`${username}\n${timestamp}\n${text}`);
}
