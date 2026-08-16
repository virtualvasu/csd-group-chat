const { validateUsername, validateMessage } = require('./validation');
const { saveMessage, getHistory } = require('./db/messageRepository');
const { findSender, registerSender } = require('./db/senderRepository');
const { verifySignature, isTimestampFresh } = require('./crypto/signatures');
const { encrypt, decrypt } = require('./crypto/messageCipher');

// There is only one room for now. Every message is stored against this id, so
// adding more rooms later is a matter of passing a real id through.
const ROOM_ID = 'main';

// Re-checks the ECDSA signature on one already-decrypted stored message.
//
// The signature covers the plaintext, so this can only run after the message
// has decrypted. Messages written before signing existed, or by a client that
// does not sign, carry no signature and are reported as 'unsigned' rather than
// as a failure.
async function verifyStoredSignature(message, text) {
  if (!message.signature || !message.senderPublicKey) return 'unsigned';

  const valid = await verifySignature(
    message.senderId,
    // Signing used the client's claimed timestamp, so verification has to use
    // the same one. Messages stored before that field existed fall back to the
    // server timestamp, which is what they were signed with.
    message.clientTimestamp ?? message.timestamp.getTime(),
    text,
    message.signature.toString('base64'),
    message.senderPublicKey.toString('base64')
  );

  return valid ? 'valid' : 'invalid';
}

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
  // client expects. A database problem here should not stop someone joining,
  // so the caller decides what to do if this throws.
  //
  // Two independent checks run over every stored message and both verdicts are
  // sent on:
  //
  //   integrity — does the stored copy still match its GCM authentication tag?
  //               Catches anything that edited the database directly.
  //   signature — does the sender's ECDSA signature still verify over the text?
  //               Catches a message that was not sent by the account it is
  //               attributed to.
  //
  // They run in that order because the signature covers the plaintext: until a
  // message decrypts there is nothing to verify it against. A message that
  // fails to decrypt gets a signature verdict of 'unknown', not 'invalid' — we
  // cannot recover what was signed, so blaming the sender would be wrong.
  //
  // Neither verdict is ever read back from the database, only recomputed. A
  // stored "this one was fine" flag would be exactly as editable as the message
  // it vouches for.
  //
  // Each message is handled on its own, so one tampered message does not cost
  // everyone else their whole history.
  async function loadHistory() {
    const stored = await getHistory(ROOM_ID);

    return Promise.all(
      stored.map(async (message) => {
        const common = {
          id: message.id,
          username: message.senderId,
          timestamp: message.timestamp.getTime(),
          senderPublicKey: message.senderPublicKey
            ? message.senderPublicKey.toString('base64')
            : null,
        };

        let text;
        try {
          text = decrypt(message);
        } catch (err) {
          console.error(`Message ${message.id} failed integrity verification:`, err.message);

          return { ...common, text: null, integrity: 'failed', signature: 'unknown' };
        }

        return { ...common, text, signature: await verifyStoredSignature(message, text) };
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
      // Only the stored copy is encrypted. The broadcast below still carries
      // the text, because the requirement here is that the database holds no
      // readable message, not that clients cannot read what was sent to them.
      //
      // The server stamps its own time on the record, but the signature was
      // made over the client's claimed time, so that one is stored alongside it
      // — without it, no stored signature could ever be re-verified.
      const serverTimestamp = new Date();
      const { ciphertext, nonce } = encrypt(result.text);

      const id = await saveMessage({
        roomId: ROOM_ID,
        senderId: username,
        ciphertext,
        nonce,
        timestamp: serverTimestamp,
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
