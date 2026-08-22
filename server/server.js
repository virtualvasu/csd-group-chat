const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { Presence } = require('./src/presence');
const { RateLimiter } = require('./src/rateLimiter');
const { registerSocketHandlers } = require('./src/socketHandlers');
const { createHealthRouter } = require('./src/routes/health');
const { createLoadTestRouter } = require('./src/routes/loadtest');
const { loadKey } = require('./src/crypto/messageCipher');
const db = require('./src/db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// 4000, not 3000: the client dev server takes 3000, so keeping the backend off
// that port lets both run at once.
const PORT = process.env.PORT || 4000;

const presence = new Presence();
const messageRateLimiter = new RateLimiter();

app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use(createHealthRouter(presence));
app.use(createLoadTestRouter());

// Connect to the database before listening. If we started listening first, a
// client could send a message before the database was ready and that message
// would be lost.
async function start() {
  // Check the encryption key before anything else. A missing or malformed key
  // only shows up when the first message is sent otherwise, by which point
  // people are already in the room and that message is lost.
  loadKey();

  await db.connect();
  console.log('Connected to MongoDB');

  io.on('connection', (socket) => {
    registerSocketHandlers(io, socket, { presence, messageRateLimiter });
  });

  httpServer.listen(PORT, () => {
    console.log(`Chat server running on http://localhost:${PORT}`);
  });
}

// Close the database connection on the way out so MongoDB does not keep the
// connection open after the process is gone.
async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down.`);

  io.close();
  httpServer.close();

  try {
    await db.close();
  } catch (err) {
    console.error('Error while closing the database connection:', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('Failed to start the server:', err.message);
  process.exit(1);
});
