const { randomBytes } = require('node:crypto');

// ULID: a 48-bit timestamp followed by 80 bits of randomness, in Crockford
// base32. Two properties matter here:
//
//   1. It is generated client-side of the database, so a message has its final
//      id before it is written anywhere. That is what lets the same message be
//      inserted on three machines and collapse into one row: the id is the
//      primary key, so a replay or a retry is a duplicate-key no-op rather than
//      a second copy.
//   2. It sorts lexicographically by creation time, so the feed can be ordered
//      by id without a separate timestamp index.
//
// A UUIDv4 would give property 1 but not property 2.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(time, len) {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(len) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i] % 32];
  }
  return out;
}

function ulid(seedTime = Date.now()) {
  return encodeTime(seedTime, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

// Accepts an id supplied by a caller so a client can retry a request without
// creating a second message. Anything unusable falls back to a fresh id rather
// than failing the request, since a caller that sends garbage still wants their
// message stored.
function normalizeId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  // Keep it to characters that are safe as a Mongo _id and in a URL.
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return null;
  return trimmed;
}

module.exports = { ulid, normalizeId };
