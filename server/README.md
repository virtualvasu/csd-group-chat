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
```

## Configuration

The server reads `server/.env` on startup (via Node's built-in `--env-file-if-exists`,
so there is no `dotenv` dependency). Copy `.env.example` to `.env` and fill it in.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MONGODB_URI` | yes | — | MongoDB Atlas connection string |
| `MONGODB_DB_NAME` | no | `csd_group_chat` | Database name inside the cluster |
| `PORT` | no | `3000` | Port the chat server listens on |

`MONGODB_URI` deliberately has no default. A default pointing at localhost would
let the server start and quietly store messages somewhere nobody intended, so a
missing connection string stops startup with a message explaining what to do.

## Storage

Messages live in the `messages` collection:

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Also the message id sent to clients, as a 24-character hex string |
| `roomId` | string | Always `main` for now |
| `senderId` | string | The username that sent the message |
| `ciphertext` | Binary | The message bytes |
| `nonce` | Binary \| null | Unused for now; reserved for encryption |
| `signature` | Binary \| null | Unused for now; reserved for message signing |
| `senderPublicKey` | Binary \| null | Unused for now; reserved for message signing |
| `timestamp` | Date | When the server accepted the message |

The message bytes sit in a field named `ciphertext` even though they are still
plain text today. The name describes what the field will hold once encryption
lands, so that change will not have to move existing data.

Index: `{ roomId: 1, _id: 1 }`, matching how history is read (one room, in order).

Every query lives in `db/messageRepository.js`. The socket handlers call
`saveMessage` and `getHistory` and never touch the collection directly.

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
| `join` | `username: string` | Validates and registers the username. Emits `join-success`, then `chat-history`, back to the sender. Emits `join-error` if the name is invalid or taken. Ignored if the socket has already joined. |
| `chat-message` | `text: string` | Requires a prior successful `join`. Subject to rate limiting (5 messages / 3s per socket) and length/emptiness validation. Emits `message-error` back to the sender on rejection. |
| `typing` | `isTyping: boolean` | Requires a prior successful `join`. Relays the sender's typing state to the other clients as `user-typing`. Ignored (silently) if the socket has not joined. |

### Server → Client

| Event | Payload | Sent to |
|---|---|---|
| `join-success` | `{ username }` | The joining socket only |
| `join-error` | `{ message }` | The joining socket only (invalid username, duplicate username) |
| `message-error` | `{ message }` | The sending socket only (not joined, rate-limited, invalid text) |
| `server-error` | `{ message }` | The socket that triggered an unexpected server-side error |
| `user-joined` | `{ username, timestamp }` | Everyone except the joining socket |
| `user-left` | `{ username, timestamp }` | Everyone except the disconnecting socket |
| `user-typing` | `{ username, isTyping }` | Everyone except the typing socket |
| `online-users` | `string[]` | Everyone, after any join/leave |
| `chat-history` | `{ id, username, text, timestamp }[]` | The joining socket only, right after `join-success` |
| `chat-message` | `{ id, username, text, timestamp }` | Everyone, including the sender |

`id` is the message's MongoDB `_id` as a 24-character hex string. The same id is
used in `chat-history` and `chat-message`, so a client can tell that a message it
already has and one arriving in history are the same message.

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

## Typing state

Typing state lives on the client. The browser sends `typing` only when its
state changes and stops after two seconds of an idle input, so a burst of
keystrokes costs one event. The server keeps no timers of its own: it relays
the flag, and a socket's typing state disappears with the `user-left` that
follows its disconnect.

## Multi-tab policy

**A username can only be online once — the second tab is blocked.** Opening a
second tab and joining with a name that is already online gets a `join-error`
("...already taken. It may be open in another tab.") and stays on the join
screen. A different username in the second tab is treated as a separate user.

This falls out of the case-insensitive uniqueness check in `presence.js` and
keeps the online-users list a plain set of names. It also means closing the
first tab frees the name immediately, since presence is keyed by socket id and
cleared on disconnect.
