# Testing guide

This project is verified in the lab with one backend server and four browser clients.
The goal is to confirm the required flow works across machines, not just on a single browser tab.

## Required setup

1. Build the frontend and start the backend on one lab machine:
   ```bash
   cd client
   npm install
   npm run build
   cd ../server
   npm install
   npm start
   ```
2. Find the server IP and share it with the other three students.
3. Open the app on each machine at `http://<server-ip>:4000`.
4. Each person joins using a different username.

## End-to-end checks

### 1) Join flow
- Expect every user to join successfully.
- Expect the online user list to update with all active names.
- Expect a join system message on each client.

### 2) Broadcast flow
- Send a message from one machine.
- Confirm it appears on all other machines.
- Confirm the sender sees the same message in their own chat stream.

### 3) Leave flow
- One user closes the tab or leaves the app.
- Confirm the other clients receive a user-left notification.
- Confirm the online user list is updated instantly.

### 4) Disconnect and reconnect flow
- Briefly disconnect a client from the network or close the browser tab.
- Restore connectivity.
- Confirm the app reconnects and reuses the previous username.
- Confirm a clear system message states that the user reconnected.
- Confirm there is only one active entry for that user in the online list.

### 5) Message history and persistence
- Send a few messages with two or more users connected.
- Have a new person join. Confirm they see the earlier messages, in order,
  before their own join notice.
- Stop the server with `Ctrl+C` and start it again with `npm start`.
- Reload the app and rejoin. Confirm the earlier messages are still there.
- Briefly disconnect a client from the network and let it reconnect. Confirm
  the conversation is **not** shown twice after the reconnect, and that any
  messages sent while it was offline now appear.

You can also check the stored messages directly in the Atlas UI under
**Browse Collections → csd_group_chat → messages**.

### 6) Encryption at rest
- Send a message with a memorable phrase in it.
- Open the `messages` collection in Compass, the Atlas UI or `mongosh`
  (`db.messages.find()`).
- Confirm `ciphertext` is binary and the phrase does not appear anywhere in the
  document. `senderId` and `timestamp` are stored as they are, by design.
- Confirm every document has its own `nonce`, and that two identical messages
  produce different `ciphertext`.

### 7) Tamper detection
- With a few messages in the room, run:
  ```bash
  cd server
  npm run tamper-demo
  ```
  It flips one bit of the newest stored message and prints the bytes before and
  after. This is the screenshot the submission asks for.
- Reload the client and rejoin.
- Confirm the tampered message is shown as failing integrity verification, with
  no message text.
- Confirm every other message still loads normally, and that the server logged
  the failure with the message id.

### 8) Signature verification (Issue #14)

#### Every message shows a trust badge
- Join as any user and send a message.
- Confirm a small badge ("Signed") appears next to the username/timestamp.
- Hover the badge: the tooltip explains the verdict and shows a short
  fingerprint like `key: a3f9b2c1`.

#### Two clients have different fingerprints
- Open the app in two different **browsers** (or two different machines, or one
  normal window + one incognito window — each must have its own IndexedDB).
- Join as `alice` in one and `bob` in the other.
- Send a message from each.
- Hover the badge on each message: the fingerprints must be different, confirming
  the two clients hold distinct key pairs.

#### Forging a signature is caught
Note that this is a *different* check from step 7, and the two are worth doing
separately — encryption protects the stored bytes, signing protects who the
message is attributed to.

1. Open the Atlas UI (**Browse Collections → csd_group_chat → messages**).
2. Find a stored document and edit its `signature` field to any different value.
   Leave `ciphertext` and `nonce` alone, so the message still decrypts.
3. Reload the page and rejoin.
4. The message now shows "Invalid signature" in red, with its text still
   readable — the server re-verifies every signature on history load and never
   trusts a stored verdict.

If you edit `ciphertext` instead, you get the step 7 result rather than this
one: the message fails to decrypt, so it is reported as an integrity failure and
its signature verdict is "unknown". There is no plaintext left to check a
signature against, so the sender is not blamed for it.

#### TOFU key binding
- Join as `alice` in Browser A. Send a message. Note the fingerprint.
- In Browser B (or incognito — different IndexedDB), attempt to join as `alice`.
- Expect a `join-error`: "This username is registered to a different key."
  Browser B cannot impersonate `alice` because it holds a different key pair.

## Automated tests

```bash
cd server
npm test
```

The database tests need `MONGODB_URI` set in `server/.env`. They run against a
separate database (`csd_group_chat_test`) so they never touch the real chat
data. Without a connection string they are skipped rather than failed, so the
rest of the suite still runs.

The encryption tests need no database and no key of your own: they generate a
key of their own, cover the encrypt/decrypt round trip, and check that a flipped
ciphertext byte or nonce is rejected.

The signature tests (`server/test/signatures.test.js`) are pure crypto too — no
database or network required — so both suites always run.

## Acceptance criteria check

The app passes when all of the following are true:

- four users can join the same room simultaneously
- chat messages broadcast to every connected user
- join and leave notifications appear correctly
- brief network interruption does not leave the client in a broken state
- the UI shows the correct connection state as the connection changes
- messages are still there after the server is restarted
- someone joining late sees the messages sent before they arrived
- reconnecting does not show the conversation twice
- the stored messages hold no readable text
- a message edited in the database is flagged in the chat while the rest load
- README instructions match the actual lab setup that worked
- every message in the UI shows a signature trust badge ("✓ Signed", "✗ Invalid", or "· Unsigned")
- manually editing a stored `ciphertext` or `signature` field in the DB makes that message show "✗ Invalid" after a reload
- two different clients (different browsers or incognito windows) show different key fingerprints
- no private key is ever transmitted — verify in the browser Network tab that no WebSocket frame contains private key material

## ⚠️ Identity loss warning

Each browser's ECDSA private key is stored in **IndexedDB** and is **non-extractable**.
Clearing browser storage (Site Settings → Clear data, or clearing cookies/storage,
or using a fresh browser profile) permanently destroys the private key.

**Consequence:** After clearing storage, the browser generates a new key pair.
The server's TOFU record still holds the **old** key for that username. Rejoining
with the same username will produce:

> "This username is registered to a different key."

The user is effectively locked out of their username for the lifetime of the
demo server. To recover, either:
- Use a different username, **or**
- A server admin deletes the document for that username from the `senders`
  collection in Atlas (this resets the TOFU binding).

**Call this out explicitly before the demo:** no one should clear browser storage
during or between demo sessions.

## Suggested test record

Record a short note for each member:

- username used
- machine used
- time of join
- message sent to test broadcast
- key fingerprint observed (hover the badge)
- result of disconnect/reconnect check

This makes it easier to show the real verification work in the group report and PR description.
