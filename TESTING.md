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

## Submission demo verification

This section covers the three required demos for the issue submission: persistence, tamper detection, and signature verification.

### Demo 1: Persistence

**Goal:** Prove that messages survive a server restart.

**Setup:**
- Four users already connected, 5-10 messages exchanged.

**Steps:**
1. Note the messages visible in the chat window.
2. On the server machine, run `Ctrl+C` to stop the server.
3. Wait 2-3 seconds.
4. Restart the server with `npm start`.
5. On one of the client machines, reload the browser (`Ctrl+R` or `Cmd+R`).
6. Rejoin with the same username.

**Expected result:**
- The chat window shows all the messages from before the restart, in the same order.
- No messages are lost, duplicated, or out of order.
- The join notice for the reconnecting user appears after the historical messages.

**Evidence to capture:**
- Screenshot showing the chat window with multiple messages before restart.
- Screenshot showing the same messages after server restart and client reload.

---

### Demo 2: Tamper detection

**Goal:** Prove that modified messages are detected and flagged.

**Setup:**
- Server running, 5-10 messages already in the database.

**Steps:**
1. Take a screenshot of the current chat window showing the messages.
2. On the server machine, run:
   ```bash
   cd server
   npm run tamper-demo
   ```
   This prints the message id, the byte offset, and the before/after bytes of the bit that was flipped.
3. Take a screenshot of the console output showing the tamper-demo results.
4. On one of the client machines, reload the browser and rejoin.

**Expected result:**
- The client loads the messages.
- The tampered message (identified by id in the tamper-demo output) appears with:
  - **No message text** (shows as empty or null)
  - **Integrity: failed** flag displayed in the UI
- All other messages load and display normally.
- The server console shows a log message: `Message [id] failed integrity verification`.

**Evidence to capture:**
- Screenshot of console output from `npm run tamper-demo` showing byte flip.
- Screenshot of the chat UI showing the tampered message flagged as failed integrity.
- Screenshot of the MongoDB collection showing binary ciphertext (see "Binary ciphertext evidence" below).

**Binary ciphertext evidence:**

To show that messages are encrypted and not stored as plaintext:

1. Open the MongoDB UI (Atlas or `mongosh`).
2. Browse to `csd_group_chat` database → `messages` collection.
3. Run:
   ```bash
   db.messages.find()
   ```
   or use the Atlas UI to view documents.
4. Take a screenshot showing a message document where:
   - `ciphertext` field contains **binary data** (not readable text)
   - `senderId` and `timestamp` are in plaintext (by design)
   - The memorable phrase from any message does **not** appear in the `ciphertext` field

---

### Demo 3: Signature verification (future work)

**Status:** Signatures are reserved for future implementation.

**Current state:**
- The database schema includes `signature` and `senderPublicKey` fields.
- These fields are currently `null` and unused.

**What this demo will verify (when implemented):**
- Each user has a keypair (public and private).
- Every message is signed with the sender's private key.
- When the message is retrieved, the server verifies the signature using the sender's public key.
- If the signature is forged or the message is modified after signing, verification fails.
- A message with a failed signature verification is flagged in the UI.

**Future implementation notes:**
- Clients will generate keypairs on first join (or during registration).
- Messages will be signed client-side before sending to the server.
- Verification can be done server-side (current design) or client-side (more secure).
- This prevents a malicious server from forging messages.

---

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

## Suggested test record

Record a short note for each member:

- username used
- machine used
- time of join
- message sent to test broadcast
- result of disconnect/reconnect check

This makes it easier to show the real verification work in the group report and PR description.
