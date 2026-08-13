const { validateUsername, validateMessage } = require('./validation');

// Full list of events is in server/README.md
function registerSocketHandlers(io, socket, { presence, messageRateLimiter }) {
  function safeHandler(fn) {
    return (...args) => {
      try {
        fn(...args);
      } catch (err) {
        console.error(`Error handling event from ${socket.id}:`, err);
        socket.emit('server-error', { message: 'Something went wrong. Please try again.' });
      }
    };
  }

  socket.on(
    'join',
    safeHandler((rawUsername) => {
      if (socket.data.username) return; // already joined

      const result = validateUsername(rawUsername);
      if (!result.valid) {
        socket.emit('join-error', { message: result.reason });
        return;
      }

      // Usernames are unique per server, so a second tab using the same name
      // is rejected here as well.
      if (presence.isUsernameTaken(result.username)) {
        socket.emit('join-error', {
          message: `Username "${result.username}" is already taken. It may be open in another tab.`,
        });
        return;
      }

      presence.add(socket.id, result.username);
      socket.data.username = result.username;

      socket.emit('join-success', { username: result.username });
      socket.broadcast.emit('user-joined', { username: result.username, timestamp: Date.now() });
      io.emit('online-users', presence.list());
    })
  );

  socket.on(
    'chat-message',
    safeHandler((rawText) => {
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

      io.emit('chat-message', {
        username,
        text: result.text,
        timestamp: Date.now(),
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

module.exports = { registerSocketHandlers };
