const { validateUsername, validateMessage } = require('./validation');
const { saveMessage, getHistory } = require('./db/messageRepository');
const { encrypt, decrypt } = require('./crypto/messageCipher');

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
  // client expects. A database problem here should not stop someone joining,
  // so the caller decides what to do if this throws.
  //
  // Each message is decrypted on its own. A document whose bytes no longer
  // match their authentication tag has been changed since it was written, and
  // it is reported as such instead of throwing: one tampered message must not
  // cost everyone else their whole history.
  async function loadHistory() {
    const stored = await getHistory(ROOM_ID);

    return stored.map((message) => {
      const common = {
        id: message.id,
        username: message.senderId,
        timestamp: message.timestamp.getTime(),
      };

      try {
        return { ...common, text: decrypt(message) };
      } catch (err) {
        console.error(`Message ${message.id} failed integrity verification:`, err.message);

        return { ...common, text: null, integrity: 'failed' };
      }
    });
  }

  socket.on(
    'join',
    safeHandler(async (rawUsername) => {
      if (socket.data.username) return; // already joined

      const result = validateUsername(rawUsername);
      if (!result.valid) {
        socket.emit('join-error', { message: result.reason });
        return;
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
    safeHandler(async (rawText) => {
      const username = socket.data.username;
      if (!username) {
        socket.emit('message-error', { message: 'You must join before sending messages.' });
        return;
      }

      if (!messageRateLimiter.allow(socket.id)) {
        socket.emit('message-error', { message: 'You are sending messages too fast. Slow down.' });
        return;
      }

      const result = validateMessage(rawText);
      if (!result.valid) {
        socket.emit('message-error', { message: result.reason });
        return;
      }

      // Store first, then send it out. That way anything a client receives is
      // already saved, and the broadcast can carry the id the message was
      // stored under.
      //
      // Only the stored copy is encrypted. The broadcast below still carries
      // the text, because the requirement here is that the database holds no
      // readable message, not that clients cannot read what was sent to them.
      const timestamp = new Date();
      const { ciphertext, nonce } = encrypt(result.text);
      const id = await saveMessage({
        roomId: ROOM_ID,
        senderId: username,
        ciphertext,
        nonce,
        timestamp,
      });

      io.emit('chat-message', {
        id,
        username,
        text: result.text,
        timestamp: timestamp.getTime(),
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
