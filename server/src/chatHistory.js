'use strict';

// Shared between the Socket.IO join flow (chat-history event) and the HTTP
// /feed route: both need the same stored-message -> client-shaped-message
// logic, so it lives here once instead of twice.

const { getHistory } = require('./db/messageRepository');
const { verifySignature } = require('./crypto/signatures');
const { decrypt } = require('./crypto/messageCipher');

// There is only one room for now. Every message is stored against this id, so
// adding more rooms later is a matter of passing a real id through.
const ROOM_ID = 'main';

// The stored bytes of one message, base64-encoded for the wire.
//
// This is what the database actually holds. Clients render it in their
// encrypted view, which is how someone reading the UI can satisfy themselves
// that messages are not stored as plaintext without opening a mongo shell.
// Nothing here is secret: the ciphertext is useless without the server key,
// and the signature and public key are already broadcast with every message.
function storedForm(message) {
  return {
    ciphertext: message.ciphertext ? message.ciphertext.toString('base64') : null,
    nonce: message.nonce ? message.nonce.toString('base64') : null,
    signature: message.signature ? message.signature.toString('base64') : null,
    clientTimestamp: message.clientTimestamp ?? null,
  };
}

// Re-checks the ECDSA signature on one already-decrypted stored message.
//
// The signature covers the plaintext, so this can only run after the message
// has decrypted. Messages written before signing existed, or sent through the
// unsigned /message route, carry no signature and are reported as 'unsigned'
// rather than as a failure.
async function verifyStoredSignature(message, text) {
  if (!message.signature || !message.senderPublicKey) return 'unsigned';

  const valid = await verifySignature(
    message.senderId,
    // Signing used the client's claimed timestamp, so verification has to use
    // the same one. Messages stored before that field existed fall back to the
    // server timestamp, which is what they were signed with.
    message.clientTimestamp ?? message.timestamp.getTime(),
    text,
    message.signature.toString('base64'),
    message.senderPublicKey.toString('base64')
  );

  return valid ? 'valid' : 'invalid';
}

// Reads the stored messages for a room and turns them into the shape clients
// expect (Socket.IO chat-history) or the HTTP /feed route returns.
//
// Two independent checks run over every stored message and both verdicts are
// sent on:
//
//   integrity — does the stored copy still match its GCM authentication tag?
//               Catches anything that edited the database directly.
//   signature — does the sender's ECDSA signature still verify over the text?
//               Catches a message that was not sent by the account it is
//               attributed to. 'unsigned' for messages that never carried one
//               (e.g. the /message load-test route).
//
// They run in that order because the signature covers the plaintext: until a
// message decrypts there is nothing to verify it against. A message that
// fails to decrypt gets a signature verdict of 'unknown', not 'invalid' — we
// cannot recover what was signed, so blaming the sender would be wrong.
//
// Each message is handled on its own, so one tampered message does not cost
// everyone else their whole history.
async function loadHistory(roomId = ROOM_ID, limit) {
  const stored = await getHistory(roomId, limit);

  return Promise.all(
    stored.map(async (message) => {
      const common = {
        id: message.id,
        username: message.senderId,
        timestamp: message.timestamp.getTime(),
        senderPublicKey: message.senderPublicKey
          ? message.senderPublicKey.toString('base64')
          : null,
        // The stored record exactly as the database holds it. The client
        // shows this in its encrypted view, so what someone inspects is the
        // real row rather than a re-encryption made for display.
        stored: storedForm(message),
      };

      let text;
      try {
        text = decrypt(message);
      } catch (err) {
        console.error(`Message ${message.id} failed integrity verification:`, err.message);

        return { ...common, text: null, integrity: 'failed', signature: 'unknown' };
      }

      return { ...common, text, signature: await verifyStoredSignature(message, text) };
    })
  );
}

module.exports = { ROOM_ID, storedForm, loadHistory };
