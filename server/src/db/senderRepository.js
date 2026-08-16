'use strict';

// Trust-on-first-use identity store.
//
// Every document in the `senders` collection looks like this:
//
//   _id          string   lowercased username (unique)
//   publicKey    string   base64-encoded SPKI public key from the first join
//   firstSeen    Date     when that join arrived
//
// The first time a username joins with a public key we record it here.
// Every subsequent join for the same username must present the same key.

const { getDb } = require('./index');

const COLLECTION = 'senders';

function collection() {
  return getDb().collection(COLLECTION);
}

/**
 * Returns the stored sender record for a username, or null if none.
 *
 * @param {string} username
 * @returns {Promise<{ _id: string, publicKey: string, firstSeen: Date } | null>}
 */
async function findSender(username) {
  return collection().findOne({ _id: username.toLowerCase() });
}

/**
 * Records a sender's public key the first time they join (no-op on subsequent
 * calls with the same key, because of the $setOnInsert).
 *
 * @param {string} username
 * @param {string} publicKey   base64 SPKI string
 */
async function registerSender(username, publicKey) {
  await collection().updateOne(
    { _id: username.toLowerCase() },
    {
      $setOnInsert: {
        _id: username.toLowerCase(),
        publicKey,
        firstSeen: new Date(),
      },
    },
    { upsert: true }
  );
}

module.exports = { findSender, registerSender };
