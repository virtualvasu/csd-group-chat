# Server internals

```
server/
  server.js               Entry point: connects to MongoDB, then wires Express, HTTP server, Socket.IO, routes, socket handlers
  .env.example            Template for server/.env (connection string, port)
  src/
    presence.js            In-memory online-user store (socket.id -> username), duplicate-username check
    rateLimiter.js          Per-socket sliding-window rate limiter (5 events / 3s)
    validation.js            Username + message validation rules
    socketHandlers.js         join / chat-message / disconnect event handlers, wrapped for error handling
    routes/health.js          GET /health liveness endpoint
    db/index.js               MongoDB connection lifecycle (connect / getDb / close) and index setup
    db/messageRepository.js    All message queries: saveMessage + getHistory
    db/senderRepository.js    TOFU identity store: first-seen public key per username
    crypto/messageCipher.js   AES-256-GCM encrypt / decrypt and the key loaded at startup
    crypto/canonical.js       Canonical signing payload builder (counterpart: client/src/lib/canonical.ts)
    crypto/signatures.js      ECDSA P-256 verification + anti-replay timestamp check
  scripts/
    generate-key.js           Prints a fresh CHAT_ENCRYPTION_KEY
    tamper-demo.js            Flips a bit in the newest stored message, for the tamper-detection demo
```

## Configuration

The server reads `server/.env` on startup (via Node's built-in `--env-file-if-exists`,
so there is no `dotenv` dependency). Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MONGODB_URI` | yes | — | MongoDB Atlas connection string |
| `CHAT_ENCRYPTION_KEY` | yes | — | 32-byte AES key, base64 encoded, used to encrypt stored messages |
| `MONGODB_DB_NAME` | no | `csd_group_chat` | Database name inside the cluster |
| `PORT` | no | `4000` | Port the chat server listens on. 3000 is left free for the client dev server |

`MONGODB_URI` deliberately has no default. A default pointing at localhost would
let the server start and quietly store messages somewhere nobody intended, so a
missing connection string stops startup with a message explaining what to do.

`CHAT_ENCRYPTION_KEY` has no default either, and for a sharper reason: a key
invented at boot would encrypt today's messages with something no later run of
the server has, so every restart would leave the whole history unreadable.
Generate one with `npm run generate-key` and keep it in `server/.env`. The key is
checked before the server starts listening, so a missing or wrong-sized key is a
startup error rather than a surprise on the first message.

## Storage

### `messages` collection

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Also the message id sent to clients, as a 24-character hex string |
| `roomId` | string | Always `main` for now |
| `senderId` | string | The username that sent the message |
| `ciphertext` | Binary | The encrypted message, with the 16-byte authentication tag on the end |
| `nonce` | Binary | The 12-byte nonce this message was encrypted with |
| `signature` | Binary \| null | Base64-decoded ECDSA signature bytes from the client; null for unsigned messages |
| `senderPublicKey` | Binary \| null | Base64-decoded SPKI public key bytes from the client; null for unsigned messages |
| `timestamp` | Date | When the **server** accepted the message |
| `clientTimestamp` | number | The **client's** claimed timestamp (ms since epoch); used when re-verifying signatures on history load |

Only the message body is encrypted. The sender, the room and the timestamp are
stored as they are, because history is read and sorted by them.

Index: `{ roomId: 1, _id: 1 }`, matching how history is read (one room, in order).

### `senders` collection (new — Issue #14)

Stores the first public key seen for each username (Trust-on-first-use / TOFU).

| Field | Type | Notes |
|---|---|---|
| `_id` | string | Lowercased username |
| `publicKey` | string | Base64 SPKI public key from the first join |
| `firstSeen` | Date | Timestamp of the first join |

A later join that presents a **different** key for the same username is rejected
with `join-error`. Sending no key at all (legacy/unsigned client) is still
allowed — those messages are marked `unsigned`.

Every query lives in `db/messageRepository.js` and `db/senderRepository.js`.
The socket handlers call those functions and never touch collections directly.

### History ordering

`getHistory` returns the **newest** messages, in **oldest-first** order. It sorts
newest-first, applies the limit, then reverses. Sorting oldest-first and then
limiting would return the first messages ever sent once a room grows past the
limit, which is the wrong end of the conversation.

### Startup order

`server.js` connects to MongoDB *before* it starts listening. If it listened
first, a client could connect and send a message before the database was ready,
and that message would be lost. `SIGINT`/`SIGTERM` close the connection on the
way out.

## Encryption at rest

Messages are encrypted with **AES-256-GCM** before they are stored and decrypted
again when history is read. `src/crypto/messageCipher.js` holds both halves and
uses Node's built-in `node:crypto`, not an implementation of our own.

- **A fresh 12-byte nonce per message**, from `randomBytes`. Reusing a nonce with
  the same key is the one mistake that breaks GCM outright, so nothing here ever
  reuses one. It also means two identical messages produce different ciphertext.
- **The authentication tag is appended to the ciphertext.** Tag and ciphertext
  are useless apart, so keeping them in one field means they cannot drift out of
  step. `decrypt` splits the last 16 bytes back off and calls `setAuthTag`
  before `final()`.
- **The socket traffic still carries plain text.** The requirement is that the
  database holds nothing readable, not that clients cannot read messages sent to
  them. End-to-end encryption between browsers is a different problem.

Changing `CHAT_ENCRYPTION_KEY` does not re-encrypt anything: messages written
under the old key stop being readable and start showing up as failed integrity
checks. The same is true of any message stored before encryption was added.

### Tamper detection

GCM's tag is checked on the way out, so a stored message that was edited in the
database no longer decrypts. That failure is reported, not thrown:

- `loadHistory` decrypts each document inside its own `try`/`catch`.
- A document that fails is sent as `{ id, username, text: null, timestamp,
  integrity: 'failed' }` and logged server-side with its id.
- Every other message in the same history loads normally. One tampered document
  must not cost everyone else the conversation.

To see it happen, send a few messages and then run:

```bash
cd server
npm run tamper-demo
```

It flips one bit of the newest stored message and prints the bytes before and
after. Reload the client: that message is marked as failing verification and the
rest are unaffected.

## HTTP endpoints

### `GET /health`

Liveness check. Returns:

```json
{ "status": "ok", "uptimeSeconds": 42, "onlineUsers": 3 }
```

## Socket.IO event contract

### Client → Server

| Event | Payload | Behavior |
|---|---|---|
| `auth-start` | `{ username: string, publicKey: string }` | Step one of login. Validates the username and the SPKI public key (base64). Replies with `auth-challenge`. Emits `join-error` if the name is invalid, if no key was supplied, or if the key differs from the one already registered for that username (TOFU). Ignored if the socket is already logged in. |
| `auth-response` | `{ signature: string }` | Step two of login: an ECDSA signature (base64) over the raw bytes of the challenge. On success emits `join-success`, then `chat-history`. Emits `join-error` if there is no login in progress, if the challenge has expired (30 s), if the signature does not verify, or if the username is already online in another tab. The challenge is single-use — a failed attempt must start over from `auth-start`. |
| `chat-message` | `{ text: string, timestamp: number, signature: string }` | Requires a completed login. Carries the client's ECDSA signature (base64) over the canonical payload and its claimed timestamp. **Unsigned messages are refused** — a bare string, a missing signature, or a missing timestamp all get `message-error`. Subject to rate limiting (5 messages / 3s per socket) and length/emptiness validation. Anti-replay: rejects a `timestamp` more than 60 s from the server clock. The message is **never stored** if the signature is invalid. |
| `typing` | `isTyping: boolean` | Requires a completed login. Relays the sender's typing state to the other clients as `user-typing`. Ignored (silently) if the socket has not logged in. |

### Server → Client

| Event | Payload | Sent to |
|---|---|---|
| `auth-challenge` | `{ challenge }` | The logging-in socket only. Base64 of 32 random bytes, valid for 30 s and usable once. |
| `join-success` | `{ username }` | The joining socket only |
| `join-error` | `{ message }` | The joining socket only (invalid username, missing key, duplicate username, TOFU key mismatch, failed or expired challenge) |
| `message-error` | `{ message }` | The sending socket only (not joined, rate-limited, invalid text, unsigned, bad signature, stale timestamp) |
| `server-error` | `{ message }` | The socket that triggered an unexpected server-side error |
| `user-joined` | `{ username, timestamp }` | Everyone except the joining socket |
| `user-left` | `{ username, timestamp }` | Everyone except the disconnecting socket |
| `user-typing` | `{ username, isTyping }` | Everyone except the typing socket |
| `online-users` | `string[]` | Everyone, after any join/leave |
| `chat-history` | `{ id, username, text, timestamp, signature, senderPublicKey, stored, integrity? }[]` | The joining socket only, right after `join-success` |
| `chat-message` | `{ id, username, text, timestamp, signature, senderPublicKey, stored }` | Everyone, including the sender |

### Why login takes two round trips

A public key is not a secret — it is broadcast with every message its owner
sends, as `senderPublicKey`. So presenting one proves nothing: anyone who has
seen a message can replay that key and claim the username. The challenge exists
so the server checks for possession of the *private* key instead. Signing 32
random bytes is something only the key holder can do, and the challenge is
single-use so a captured exchange cannot be replayed.

### The `stored` field

`stored` is `{ ciphertext, nonce, signature, clientTimestamp }`, all base64
except the timestamp, and it is the row as the database holds it. Clients render
it in their "stored bytes" view so that "messages are not stored as plaintext"
is something a reader can check for themselves rather than take on trust.
Nothing in it is secret: the ciphertext is useless without the server's key, and
the signature and public key already travel with every message.

`integrity` appears in `chat-history` only, and only on a message whose stored
copy failed its authentication check. It is then `'failed'` and `text` is `null`,
so the client has nothing to show as the message and says so instead. Live
`chat-message` broadcasts never carry it: they are sent from what the server just
received, so there is nothing to verify yet.

`id` is the message's MongoDB `_id` as a 24-character hex string. The same id is
used in `chat-history` and `chat-message`, so a client can tell that a message it
already has and one arriving in history are the same message.

`signature` is one of `'valid' | 'invalid' | 'unsigned'`:
- `valid` — the server verified the ECDSA signature before storing the message.
- `invalid` — re-verification on history load failed (message or signature was tampered with).
- `unsigned` — no signature was provided (legacy/stale client).

`senderPublicKey` is the base64 SPKI public key of the sender, or `null` for unsigned messages.

## Signature verification

Signatures are verified **twice**:

1. **On send** — before the message is stored. An invalid signature returns a
   `message-error` and the message never reaches the database.
2. **On history load** — every stored message is re-verified against its stored
   public key each time a client joins. A stored verdict is never trusted;
   tampering with `ciphertext` or `signature` in the database will be detected.

The signing payload is byte-for-byte identical on both sides:

```
<username>\n<clientTimestamp>\n<text>   (UTF-8, no trailing newline)
```

See `server/src/crypto/canonical.js` and `client/src/lib/canonical.ts`.

## Chat history

On a successful join the server reads the stored messages for the room and sends
them to that socket only, as `chat-history`, before broadcasting `user-joined`.
Sending history first means a new user sees the conversation in order instead of
their own join line appearing above messages that came earlier.

If the history cannot be read, the join still succeeds: the server sends an empty
`chat-history` plus a `server-error`. Losing sight of old messages is better than
blocking someone from joining at all.

**History is re-sent on every join, including reconnects.** Socket.IO creates a
new socket when it reconnects, so the rejoin is a normal join as far as the
server is concerned and the full history goes out again. Clients must ignore
messages they already hold — the ids are stable, so matching on `id` is enough.
Without that, one brief network drop would show the whole conversation twice.

Messages are stored before they are broadcast, so anything a client receives is
already saved, and the broadcast can carry the id it was stored under.

## Validation rules

- **Username:** 1-20 characters, letters/numbers/spaces/`_`/`-` only, must not already be online (case-insensitive).
- **Message:** non-empty after trimming, truncated to 500 characters.
- **Rate limit:** max 5 `chat-message` events per rolling 3-second window per socket.
- **Timestamp:** client-supplied timestamp must be within 60 seconds of the server clock (anti-replay).

## Typing state

Typing state lives on the client. The browser sends `typing` only when its
state changes and stops after two seconds of an idle input, so a burst of
keystrokes costs one event. The server keeps no timers of its own: it relays
the flag, and a socket's typing state disappears with the `user-left` that
follows its disconnect.

## Multi-tab policy

**A username can only be online once — the second tab is blocked.** Opening a
second tab and joining with a name that is already online gets a `join-error`
(\"...already taken. It may be open in another tab.\") and stays on the join
screen. A different username in the second tab is treated as a separate user.

This falls out of the case-insensitive uniqueness check in `presence.js` and
keeps the online-users list a plain set of names. It also means closing the
first tab frees the name immediately, since presence is keyed by socket id and
cleared on disconnect.
