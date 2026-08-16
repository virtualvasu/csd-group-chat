const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

// AES-256-GCM, from Node's own crypto library. Writing a cipher by hand is how
// you end up with a broken one, so this file only wires up what node:crypto
// already provides.
const ALGORITHM = 'aes-256-gcm';
const KEY_ENV_VAR = 'CHAT_ENCRYPTION_KEY';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey = null;

// Reads the key from the environment, once, and keeps it for the rest of the
// process. Anything wrong with it is a startup problem, not a per-message one,
// so server.js calls this before it starts listening.
//
// There is deliberately no fallback to a generated key. A key made up at boot
// would encrypt today's messages with something nobody has tomorrow, leaving
// the whole history unreadable after the next restart.
function loadKey() {
  if (cachedKey) return cachedKey;

  const configured = String(process.env[KEY_ENV_VAR] || '').trim();

  if (!configured) {
    throw new Error(
      `${KEY_ENV_VAR} is not set. Generate one with "npm run generate-key" in the server ` +
        'directory and put it in server/.env. See README.md for the setup steps.'
    );
  }

  const key = Buffer.from(configured, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${KEY_ENV_VAR} must be ${KEY_BYTES} bytes encoded as base64, but it decoded to ` +
        `${key.length}. Generate a valid key with "npm run generate-key".`
    );
  }

  cachedKey = key;

  return cachedKey;
}

// Encrypts one message and returns the pieces the repository stores.
//
// The nonce is fresh for every message. Reusing a nonce with the same key is
// the one mistake that breaks GCM outright, and random 12 bytes per message is
// what the mode is designed for.
//
// The 16-byte authentication tag is appended to the ciphertext rather than
// stored on its own. Tag and ciphertext are useless apart, so keeping them in
// one field means they cannot drift out of step.
function encrypt(plaintext) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(), nonce);

  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return { ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]), nonce };
}

// Turns a stored message back into text.
//
// Throws if the ciphertext, the nonce or the tag has changed since it was
// written: `final()` checks the tag and refuses to hand back bytes that do not
// match it. That failure is the tamper detection, so callers are expected to
// catch it rather than let it bubble up.
function decrypt({ ciphertext, nonce }) {
  if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(nonce)) {
    throw new Error('Both ciphertext and nonce are needed to decrypt a message.');
  }

  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Expected a ${NONCE_BYTES}-byte nonce, got ${nonce.length}.`);
  }

  if (ciphertext.length < TAG_BYTES) {
    throw new Error('Stored message is too short to hold an authentication tag.');
  }

  const tagAt = ciphertext.length - TAG_BYTES;
  const decipher = createDecipheriv(ALGORITHM, loadKey(), nonce);
  decipher.setAuthTag(ciphertext.subarray(tagAt));

  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, tagAt)),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

module.exports = {
  encrypt,
  decrypt,
  loadKey,
  ALGORITHM,
  KEY_ENV_VAR,
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
};
