const db = require('../../src/db');

// Tests run against their own databases so they never touch the real chat data.
//
// Each test file gets its own database name. The test runner runs files at the
// same time, so if they shared one database the cleanup in one file would wipe
// the rows another file was in the middle of checking.
const TEST_DB_PREFIX = 'csd_group_chat_test';

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

// `suiteName` must be different in every test file.
async function connectTestDb(suiteName) {
  process.env.MONGODB_DB_NAME = `${TEST_DB_PREFIX}_${suiteName}`;

  return db.connect();
}

// Empties the collections between tests so one test cannot affect the next.
async function clearTestDb() {
  const database = db.getDb();
  const collections = await database.collections();

  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

// Drops the whole test database on the way out, so running the tests does not
// leave anything behind in the cluster.
async function closeTestDb() {
  try {
    await db.getDb().dropDatabase();
  } catch (err) {
    console.error('Could not drop the test database:', err.message);
  }

  await db.close();
}

module.exports = { connectTestDb, clearTestDb, closeTestDb, skipReason, TEST_DB_PREFIX };
