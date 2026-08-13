# Server internals

```
server/
  server.js               Entry point: wires Express, HTTP server, Socket.IO, routes, socket handlers
  src/
    presence.js            In-memory online-user store (socket.id -> username), duplicate-username check
    rateLimiter.js          Per-socket sliding-window rate limiter (5 events / 3s)
    validation.js            Username + message validation rules
    socketHandlers.js         join / chat-message / disconnect event handlers, wrapped for error handling
    routes/health.js          GET /health liveness endpoint
```

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
| `join` | `username: string` | Validates and registers the username. Emits `join-success` or `join-error` back to the sender. Ignored if the socket has already joined. |
| `chat-message` | `text: string` | Requires a prior successful `join`. Subject to rate limiting (5 messages / 3s per socket) and length/emptiness validation. Emits `message-error` back to the sender on rejection. |

### Server → Client

| Event | Payload | Sent to |
|---|---|---|
| `join-success` | `{ username }` | The joining socket only |
| `join-error` | `{ message }` | The joining socket only (invalid username, duplicate username) |
| `message-error` | `{ message }` | The sending socket only (not joined, rate-limited, invalid text) |
| `server-error` | `{ message }` | The socket that triggered an unexpected server-side error |
| `user-joined` | `{ username }` | Everyone except the joining socket |
| `user-left` | `{ username }` | Everyone except the disconnecting socket |
| `online-users` | `string[]` | Everyone, after any join/leave |
| `chat-message` | `{ username, text, timestamp }` | Everyone, including the sender |

## Validation rules

- **Username:** 1-20 characters, letters/numbers/spaces/`_`/`-` only, must not already be online (case-insensitive).
- **Message:** non-empty after trimming, truncated to 500 characters.
- **Rate limit:** max 5 `chat-message` events per rolling 3-second window per socket.
