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
| `chat-message` | `{ username, text, timestamp }` | Everyone, including the sender |

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
