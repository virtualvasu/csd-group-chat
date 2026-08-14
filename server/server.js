const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { Presence } = require('./src/presence');
const { RateLimiter } = require('./src/rateLimiter');
const { registerSocketHandlers } = require('./src/socketHandlers');
const { createHealthRouter } = require('./src/routes/health');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

const presence = new Presence();
const messageRateLimiter = new RateLimiter();

app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use(createHealthRouter(presence));

io.on('connection', (socket) => {
  registerSocketHandlers(io, socket, { presence, messageRateLimiter });
});

httpServer.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});
