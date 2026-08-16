const { validateUsername, validateMessage } = require('./validation');
const { saveMessage, getHistory } = require('./db/messageRepository');
const { findSender, registerSender } = require('./db/senderRepository');
const { verifySignature, isTimestampFresh } = require('./crypto/signatures');

// There is only one room for now. Every message is stored against this id, so
// adding more rooms later is a matter of passing a real id through.
const ROOM_ID = 'main';

// Full list of events is in server/README.md
function registerSocketHandlers(io, socket, { presence, messageRateLimiter }) {
  // Wraps a handler so a thrown error tells the client something went wrong
  // instead of taking the server down. Handlers are async now that they talk
  // to the database, so we catch failed promises as well as thrown errors.
  function safeHandler(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (err) {
        console.error(`Error handling event from ${socket.id}:`, err);
        socket.emit('server-error', { message: 'Something went wrong. Please try again.' });
      }
    };
  }

  // Reads the stored messages for the room and turns them into the shape the
  // client expects.  Signatures are re-verified on every history load — we
  // never trust a previously stored verdict, so manual edits to ciphertext or
  // signature fields in the database are always caught.
  async function loadHistory() {
    const stored = await getHistory(ROOM_ID);

    return Promise.all(
      stored.map(async (message) => {
        const text = message.ciphertext.toString('utf8');

        let signatureStatus;
        if (!message.signature || !message.senderPublicKey) {
          signatureStatus = 'unsigned';
        } else {
          const sigB64 = message.signature.toString('base64');
          const keyB64 = message.senderPublicKey.toString('base64');
          const valid = await verifySignature(
            message.senderId,
            message.clientTimestamp ?? message.timestamp.getTime(),
            text,
            sigB64,
            keyB64
          );
          signatureStatus = valid ? 'valid' : 'invalid';
        }

        return {
          id: message.id,
          username: message.senderId,
          text,
          timestamp: message.timestamp.getTime(),
          signature: signatureStatus,
          senderPublicKey: message.senderPublicKey
            ? message.senderPublicKey.toString('base64')
            : null,
        };
      })
    );
  }

  socket.on(
    'join',
    safeHandler(async (rawPayload) => {
      if (socket.data.username) return; // already joined

      // Accept both new shape { username, publicKey } and legacy bare string.
      let rawUsername;
      let publicKey = null;

      if (rawPayload && typeof rawPayload === 'object') {
        rawUsername = rawPayload.username;
        publicKey = typeof rawPayload.publicKey === 'string' ? rawPayload.publicKey : null;
      } else {
        rawUsername = rawPayload; // bare string — backward compat
      }

      const result = validateUsername(rawUsername);
      if (!result.valid) {
        socket.emit('join-error', { message: result.reason });
        return;
      }

      // Trust-on-first-use identity check.
      // Only enforced when the client sends a public key.
      if (publicKey) {
        const existing = await findSender(result.username);
        if (existing && existing.publicKey !== publicKey) {
          socket.emit('join-error', {
            message: 'This username is registered to a different key. Clear your stored identity or choose a different username.',
          });
          return;
        }
      }

      // Usernames are unique per server, so a second tab using the same name
      // is rejected here as well. A reconnecting client may briefly collide with
      // a recently disconnected socket, so allow a short reclaim window for that case.
      if (presence.isUsernameTaken(result.username)) {
        const reclaimed = presence.reclaimUsername(socket.id, result.username);
        if (!reclaimed) {
          socket.emit('join-error', {
            message: `Username "${result.username}" is already taken. It may be open in another tab.`,
          });
          return;
        }
      }

      presence.add(socket.id, result.username);
      socket.data.username = result.username;
      socket.data.publicKey = publicKey; // may be null for legacy clients

      // Record the public key the first time this username joins.
      if (publicKey) {
        await registerSender(result.username, publicKey);
      }

      socket.emit('join-success', { username: result.username });

      // Send the earlier messages before announcing the join, so the new user
      // sees the conversation in order rather than their own join line first.
      // If the history cannot be read we still let them into the chat, because
      // losing old messages is better than blocking the join completely.
      try {
        socket.emit('chat-history', await loadHistory());
      } catch (err) {
        console.error('Could not load chat history:', err);
        socket.emit('chat-history', []);
        socket.emit('server-error', { message: 'Could not load earlier messages.' });
      }

      socket.broadcast.emit('user-joined', { username: result.username, timestamp: Date.now() });
      io.emit('online-users', presence.list());
    })
  );

  socket.on(
    'chat-message',
    safeHandler(async (rawPayload) => {
      const username = socket.data.username;
      if (!username) {
        socket.emit('message-error', { message: 'You must join before sending messages.' });
        return;
      }

      if (!messageRateLimiter.allow(socket.id)) {
        socket.emit('message-error', { message: 'You are sending messages too fast. Slow down.' });
        return;
      }

      // Accept both new shape { text, timestamp, signature } and legacy bare string.
      let rawText;
      let clientTimestamp = null;
      let signatureB64 = null;

      if (rawPayload && typeof rawPayload === 'object') {
        rawText = rawPayload.text;
        clientTimestamp = typeof rawPayload.timestamp === 'number' ? rawPayload.timestamp : null;
        signatureB64 = typeof rawPayload.signature === 'string' ? rawPayload.signature : null;
      } else {
        rawText = rawPayload; // bare string — backward compat, treated as unsigned
      }

      const result = validateMessage(rawText);
      if (!result.valid) {
        socket.emit('message-error', { message: result.reason });
        return;
      }

      const publicKey = socket.data.publicKey ?? null;

      // Signature handling.
      let signatureStatus = 'unsigned';

      if (publicKey && signatureB64 && clientTimestamp !== null) {
        // Anti-replay: reject timestamps that are too far from server time.
        if (!isTimestampFresh(clientTimestamp)) {
          socket.emit('message-error', {
            message: 'Message timestamp is too far from server time. Please check your clock.',
          });
          return;
        }

        const valid = await verifySignature(
          username,
          clientTimestamp,
          result.text,
          signatureB64,
          publicKey
        );

        if (!valid) {
          socket.emit('message-error', { message: 'Signature verification failed. Message rejected.' });
          return;
        }

        signatureStatus = 'valid';
      }

      // Store first, then send it out. That way anything a client receives is
      // already saved, and the broadcast can carry the id the message was
      // stored under.
      //
      // The server records its own timestamp for the stored record.
      // Signature verification used the *client's* claimed timestamp.
      const serverTimestamp = new Date();

      const id = await saveMessage({
        roomId: ROOM_ID,
        senderId: username,
        ciphertext: Buffer.from(result.text, 'utf8'),
        timestamp: serverTimestamp,
        // Store the client timestamp so history re-verification can use it.
        clientTimestamp: clientTimestamp ?? serverTimestamp.getTime(),
        signature: signatureB64 ? Buffer.from(signatureB64, 'base64') : null,
        senderPublicKey: publicKey ? Buffer.from(publicKey, 'base64') : null,
      });

      io.emit('chat-message', {
        id,
        username,
        text: result.text,
        timestamp: serverTimestamp.getTime(),
        signature: signatureStatus,
        senderPublicKey: publicKey,
      });
    })
  );

  socket.on(
    'typing',
    safeHandler((isTyping) => {
      const username = socket.data.username;
      if (!username) return;

      socket.broadcast.emit('user-typing', { username, isTyping: Boolean(isTyping) });
    })
  );

  socket.on(
    'disconnect',
    safeHandler(() => {
      const username = presence.remove(socket.id);
      messageRateLimiter.clear(socket.id);
      if (!username) return;

      socket.broadcast.emit('user-left', { username, timestamp: Date.now() });
      io.emit('online-users', presence.list());
    })
  );
}

module.exports = { registerSocketHandlers, ROOM_ID };
