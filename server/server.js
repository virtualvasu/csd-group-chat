const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { Presence } = require('./src/presence');
const { RateLimiter } = require('./src/rateLimiter');
const { registerSocketHandlers } = require('./src/socketHandlers');
const { createHealthRouter } = require('./src/routes/health');
const db = require('./src/db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

const presence = new Presence();
const messageRateLimiter = new RateLimiter();

app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use(createHealthRouter(presence));

// Connect to the database before listening. If we started listening first, a
// client could send a message before the database was ready and that message
// would be lost.
async function start() {
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
