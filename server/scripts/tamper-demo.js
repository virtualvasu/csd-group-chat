// Modifies a stored message directly in the database, the way an attacker with
// database access would, so the client can be shown flagging it.
//
// It flips a single bit in the ciphertext of the most recent message. That is
// enough: the GCM authentication tag no longer matches the bytes it was written
// for, so decryption of that one document fails and the server marks it as
// failing integrity verification while every other message still loads.
//
// The change is permanent for that message. Run this against the demo database,
// not against anything worth keeping.
const db = require('../src/db');
const { COLLECTION, toBuffer } = require('../src/db/messageRepository');

const PREVIEW_BYTES = 16;

function preview(buffer) {
  const head = buffer.subarray(0, PREVIEW_BYTES).toString('hex');

  return buffer.length > PREVIEW_BYTES ? `${head}...` : head;
}

async function main() {
  await db.connect();

  const messages = db.getDb().collection(COLLECTION);
  const latest = await messages.findOne({}, { sort: { _id: -1 } });

  if (!latest) {
    console.log('There are no stored messages to tamper with. Send one first.');
    return;
  }

  const original = toBuffer(latest.ciphertext);
  const tampered = Buffer.from(original);
  tampered[0] ^= 0x01;

  await messages.updateOne({ _id: latest._id }, { $set: { ciphertext: tampered } });

  console.log(`Message  : ${latest._id.toHexString()}`);
  console.log(`Sender   : ${latest.senderId}`);
  console.log(`Sent at  : ${latest.timestamp.toISOString()}`);
  console.log(`Before   : ${preview(original)}`);
  console.log(`After    : ${preview(tampered)}`);
  console.log('\nOne bit of the ciphertext changed. Reload the client: this message is');
  console.log('flagged as failing integrity verification, the rest load as usual.');
}

main()
  .catch((err) => {
    console.error('Tamper demo failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
