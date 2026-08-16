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
3. Open the app on each machine at `http://<server-ip>:3000`.
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

## Automated tests

```bash
cd server
npm test
```

The database tests need `MONGODB_URI` set in `server/.env`. They run against a
separate database (`csd_group_chat_test`) so they never touch the real chat
data. Without a connection string they are skipped rather than failed, so the
rest of the suite still runs.

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
- README instructions match the actual lab setup that worked

## Suggested test record

Record a short note for each member:

- username used
- machine used
- time of join
- message sent to test broadcast
- result of disconnect/reconnect check

This makes it easier to show the real verification work in the group report and PR description.
