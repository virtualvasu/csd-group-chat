// Prints one fresh AES-256 key, base64 encoded, for CHAT_ENCRYPTION_KEY.
//
// Run it once per deployment and keep the result in server/.env, which is
// ignored by git. A new key does not unlock messages written under the old one,
// so do not regenerate a key for a database that already holds messages.
const { randomBytes } = require('node:crypto');

const { KEY_BYTES, KEY_ENV_VAR } = require('../src/crypto/messageCipher');

// The key goes to stdout on its own so it can be piped or copied directly.
// Everything else is written to stderr.
console.error('Add this line to server/.env (never commit it):\n');
console.log(`${KEY_ENV_VAR}=${randomBytes(KEY_BYTES).toString('base64')}`);
