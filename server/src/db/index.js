const { MongoClient } = require('mongodb');

const DEFAULT_DB_NAME = 'csd_group_chat';

let client = null;
let db = null;

// Reads the connection string from the environment.
// There is no default on purpose: a wrong default would quietly write messages
// to the wrong place instead of telling us something is missing.
function readUri() {
  const uri = String(process.env.MONGODB_URI || '').trim();

  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Copy server/.env.example to server/.env and put your ' +
        'MongoDB Atlas connection string in it. See README.md for the setup steps.'
    );
  }

  return uri;
}

// Opens the connection and prepares the collections.
// Call this once at startup, before the server starts accepting clients.
async function connect() {
  if (db) return db;

  const uri = readUri();
  const dbName = String(process.env.MONGODB_DB_NAME || '').trim() || DEFAULT_DB_NAME;

  client = new MongoClient(uri, {
    // Give up rather than hanging, so a bad connection string shows up as an
    // error at startup instead of as a stall on the first message.
    serverSelectionTimeoutMS: 10000,
    // Sized for a database on this machine rather than a shared cloud cluster.
    // The old value of 10 was picked for the Atlas free tier's connection cap;
    // against a local server it is simply a ceiling on how many messages can be
    // in flight at once, and at a thousand concurrent clients that ceiling is
    // the bottleneck rather than the database.
    maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 100),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 8),
  });

  await client.connect();
  db = client.db(dbName);

  await createIndexes(db);

  return db;
}

// Indexes we rely on. Creating them is safe to repeat: MongoDB ignores the
// call if the index already exists.
async function createIndexes(database) {
  // History is always read for one room, oldest first, so index both fields
  // together in that order.
  await database.collection('messages').createIndex({ roomId: 1, _id: 1 });

  // The incremental catch-up scan looks for rows this machine wrote since it
  // last checked — that is how a worker process notices messages stored by a
  // sibling worker or pushed here by a peer machine. Without this index that
  // scan is a collection scan several times a second.
  await database
    .collection('messages')
    .createIndex({ roomId: 1, localInsertedAt: 1 });
}

// Returns the open database. Throws if connect() has not finished yet, which
// means we would otherwise be reading from nothing.
function getDb() {
  if (!db) {
    throw new Error('Database is not connected yet. Call connect() first.');
  }

  return db;
}

async function close() {
  if (!client) return;

  await client.close();
  client = null;
  db = null;
}

module.exports = { connect, getDb, close, DEFAULT_DB_NAME };
