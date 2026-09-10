const { getDb } = require('./index');
const { ulid } = require('../ids');

const COLLECTION = 'messages';
const DEFAULT_HISTORY_LIMIT = 100;

// Every stored message looks like this:
//
//   _id              ObjectId  also used as the message id we send to clients
//   roomId           string    one room for now, always 'main'
//   senderId         string    the username that sent it
//   ciphertext       Binary    the encrypted message, with its authentication tag on the end
//   nonce            Binary    the nonce this message was encrypted with
//   signature        Binary    null for now, used once messages are signed
//   senderPublicKey  Binary    null for now, used once messages are signed
//   timestamp        Date      when the server accepted the message
//   clientTimestamp  number    client-claimed timestamp (ms); used to re-verify signatures on history load
//
// This file stores and returns those bytes as they are. Encrypting and
// decrypting them is the caller's job, so the queries stay independent of how
// messages are protected.
//
// All database queries live in this file. The socket handlers call these two
// functions and never touch the collection themselves.

function collection() {
  return getDb().collection(COLLECTION);
}

// Saves one message and returns the new id as a plain string.
//
// The id is generated here rather than left to MongoDB, so that a message has
// its identity before it is written. That is what makes storing it idempotent:
// the same message arriving twice — replayed by a peer machine, retried after a
// timeout — lands on the same _id and collapses into one row instead of
// appearing twice in the conversation.
async function saveMessage({
  id = ulid(),
  roomId,
  senderId,
  ciphertext,
  nonce = null,
  signature = null,
  senderPublicKey = null,
  timestamp = new Date(),
  clientTimestamp = null,
}) {
  await collection().insertOne({
    _id: id,
    roomId,
    senderId,
    ciphertext,
    nonce,
    signature,
    senderPublicKey,
    timestamp,
    clientTimestamp: clientTimestamp ?? timestamp.getTime(),
    // Stamped by whichever machine wrote the row, so each machine can scan for
    // what it has recently taken in without coordinating a shared sequence.
    localInsertedAt: new Date(),
  });

  return id;
}

// Returns the most recent messages for a room, oldest first.
//
// Note the sort direction: we want the newest messages, but we want to show
// them in reading order. Sorting oldest first and then limiting would return
// the very first messages ever sent once the room has more than `limit` of
// them, which is the wrong end of the history. So we take the newest ones by
// sorting newest first, then flip the list back.
async function getHistory(roomId, limit = DEFAULT_HISTORY_LIMIT) {
  const documents = await collection()
    .find({ roomId })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();

  documents.reverse();

  return documents.map((doc) => ({
    // Ids are strings now, but rows written before that change still carry an
    // ObjectId, so handle both rather than throwing on old history.
    id: typeof doc._id === 'string' ? doc._id : doc._id.toHexString(),
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
