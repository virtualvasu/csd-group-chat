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
    // Give up after 10 seconds instead of hanging, so a wrong password or a
    // missing IP in the Atlas access list shows up as an error right away.
    serverSelectionTimeoutMS: 10000,
    // The Atlas free tier allows a limited number of connections, so keep the
    // pool small. One lab server does not need more than this.
    maxPoolSize: 10,
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
