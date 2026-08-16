const { randomBytes } = require('node:crypto');

// Tests encrypt and decrypt inside a single process, so any valid key works.
// Setting one here keeps the suite runnable on a machine that has no key in its
// environment, and keeps it independent of whichever key server/.env holds.
//
// Call this before the first encrypt or decrypt in a test file: the cipher
// reads the key once and keeps it for the rest of the process.
function useTestEncryptionKey() {
  process.env.CHAT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
}

module.exports = { useTestEncryptionKey };
