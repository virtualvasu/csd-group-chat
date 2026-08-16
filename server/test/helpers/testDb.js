const db = require('../../src/db');

// Tests run against their own database so they never touch the real chat data.
const TEST_DB_NAME = 'csd_group_chat_test';

// Tests need a MongoDB to talk to. When MONGODB_URI is not set we skip them
// instead of failing, so someone can still run the rest of the suite without a
// database set up.
function databaseUri() {
  return String(process.env.MONGODB_URI || '').trim();
}

function skipReason() {
  return databaseUri()
    ? false
    : 'MONGODB_URI is not set, so database tests are skipped';
}

async function connectTestDb() {
  process.env.MONGODB_DB_NAME = TEST_DB_NAME;

  return db.connect();
}

// Empties the collections between tests so one test cannot affect the next.
async function clearTestDb() {
  const database = db.getDb();
  const collections = await database.collections();

  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

async function closeTestDb() {
  await db.close();
}

module.exports = { connectTestDb, clearTestDb, closeTestDb, skipReason, TEST_DB_NAME };
