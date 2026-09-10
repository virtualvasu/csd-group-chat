const { randomUUID } = require('node:crypto');
const { getDb } = require('./index');

const COLLECTION = 'messages';
const DEFAULT_HISTORY_LIMIT = 100;

// Every stored message looks like this:
//
//   _id              ObjectId  the message id we send to clients
//   messageId        string    caller-supplied (or server-generated) idempotency key, unique
//   roomId           string    one room for now, always 'main'
//   senderId         string    the username that sent it
//   ciphertext       Binary    the encrypted message, with its authentication tag on the end
//   nonce            Binary    the nonce this message was encrypted with
//   signature        Binary    null for unsigned messages (e.g. the /message load-test route)
//   senderPublicKey  Binary    null for unsigned messages
//   timestamp        Date      when the server accepted the message
//   clientTimestamp  number    client-claimed timestamp (ms); used to re-verify signatures on history load
//
// This file stores and returns those bytes as they are. Encrypting and
// decrypting them is the caller's job, so the queries stay independent of how
// messages are protected.
//
// All database queries live in this file. The socket handlers and the
// /message, /feed routes call these functions and never touch the collection
// themselves.

function collection() {
  return getDb().collection(COLLECTION);
}

// Saves one message, keyed by messageId, and returns its id plus whether it
// was already stored.
//
// Retries, reconnects and the load balancer's cross-backend retry can all
// cause the same logical message to arrive more than once. Since every
// backend shares one MongoDB cluster, keying the insert on messageId (unique
// index, see db/index.js) and using $setOnInsert/upsert instead of insertOne
// makes a repeat arrival a no-op — whichever backend sees it first wins, and
// later arrivals just get back the id that was already stored, matching how
// senderRepository.registerSender handles the same problem for identities.
//
// Callers that do not care about idempotency (the socket chat path) can omit
// messageId; one is generated for them, so every message still gets a unique
// id and a duplicate-safe insert.
async function saveMessage({
  roomId,
  senderId,
  ciphertext,
  nonce = null,
  signature = null,
  senderPublicKey = null,
  timestamp = new Date(),
  clientTimestamp = null,
  messageId = null,
}) {
  const key = messageId || randomUUID();

  const result = await collection().updateOne(
    { messageId: key },
    {
      $setOnInsert: {
        messageId: key,
        roomId,
        senderId,
        ciphertext,
        nonce,
        signature,
        senderPublicKey,
        timestamp,
        clientTimestamp: clientTimestamp ?? timestamp.getTime(),
      },
    },
    { upsert: true }
  );

  if (result.upsertedId) {
    return { id: result.upsertedId.toHexString(), messageId: key, duplicate: false };
  }

  // Already stored under this messageId — look up the id it was assigned the
  // first time, rather than inserting a second row.
  const existing = await collection().findOne({ messageId: key }, { projection: { _id: 1 } });
  return { id: existing._id.toHexString(), messageId: key, duplicate: true };
}

// Returns the most recent messages for a room, oldest first.
//
// Note the sort direction: we want the newest messages, but we want to show
// them in reading order. Sorting oldest first and then limiting would return
// the very first messages ever sent once the room has more than `limit` of
// them, which is the wrong end of the history. So we take the newest ones by
// sorting newest first, then flip the list back.
async function getHistory(roomId, limit = DEFAULT_HISTORY_LIMIT) {
  // limit=0 means "no limit" (used by the /feed route, which must return
  // every message, not just the most recent window the chat UI loads on
  // join).
  let query = collection().find({ roomId }).sort({ _id: -1 });
  if (limit > 0) query = query.limit(limit);

  const documents = await query.toArray();

  documents.reverse();

  return documents.map((doc) => ({
    id: doc._id.toHexString(),
    senderId: doc.senderId,
    // The driver hands binary fields back as a Binary wrapper, so unwrap them
    // into normal Buffers for the rest of the code to use.
    ciphertext: toBuffer(doc.ciphertext),
    nonce: toBuffer(doc.nonce),
    signature: toBuffer(doc.signature),
    senderPublicKey: toBuffer(doc.senderPublicKey),
    timestamp: doc.timestamp,
    clientTimestamp: doc.clientTimestamp ?? null,
  }));
}

function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value.buffer !== 'undefined') return Buffer.from(value.buffer);

  return Buffer.from(value);
}

module.exports = { saveMessage, getHistory, toBuffer, DEFAULT_HISTORY_LIMIT, COLLECTION };
