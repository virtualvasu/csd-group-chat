const { Router } = require('express');

const { validateUsername, validateMessage } = require('../validation');
const { saveMessage } = require('../db/messageRepository');
const { encrypt } = require('../crypto/messageCipher');
const { ROOM_ID, storedForm, loadHistory } = require('../chatHistory');

// Load-balancer assignment routes: POST /message and GET /feed.
//
// These sit alongside the signed, TOFU-authenticated Socket.IO chat path in
// socketHandlers.js — they don't replace it. A generic load generator has no
// ECDSA signing key, so this path accepts a plain client-name/msg pair
// instead of requiring a login handshake. Messages posted here still go
// through the same encryption and the same MongoDB collection as the chat
// UI, and are broadcast to connected Socket.IO clients too, so both paths
// share one feed of persisted data.
function createMessagesRouter(io) {
  const router = Router();

  router.post('/message', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const nameResult = validateUsername(body['client-name']);
    if (!nameResult.valid) {
      res.status(400).json({ error: nameResult.reason });
      return;
    }

    const msgResult = validateMessage(body.msg);
    if (!msgResult.valid) {
      res.status(400).json({ error: msgResult.reason });
      return;
    }

    // Optional idempotency key: a caller that retries a timed-out request
    // should resend the same id, so the retry does not create a second
    // message. See messageRepository.saveMessage.
    const messageId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;

    try {
      const timestamp = new Date();
      const { ciphertext, nonce } = encrypt(msgResult.text);

      const { id, duplicate } = await saveMessage({
        roomId: ROOM_ID,
        senderId: nameResult.username,
        ciphertext,
        nonce,
        timestamp,
        messageId,
      });

      // A duplicate retry already reached every connected client the first
      // time it was stored, so broadcasting it again would show the message
      // twice in the live chat view.
      if (!duplicate) {
        io.emit('chat-message', {
          id,
          username: nameResult.username,
          text: msgResult.text,
          timestamp: timestamp.getTime(),
          signature: 'unsigned',
          senderPublicKey: null,
          stored: storedForm({ ciphertext, nonce, signature: null, clientTimestamp: timestamp.getTime() }),
        });
      }

      res.status(201).json({ id, duplicate });
    } catch (err) {
      console.error('Could not save message:', err);
      res.status(500).json({ error: 'Could not save message.' });
    }
  });

  router.get('/feed', async (req, res) => {
    try {
      // 0: every stored message, not just the recent window the chat UI
      // loads on join — the load generator needs the full feed.
      const messages = await loadHistory(ROOM_ID, 0);
      res.json({ messages });
    } catch (err) {
      console.error('Could not load feed:', err);
      res.status(500).json({ error: 'Could not load messages.' });
    }
  });

  return router;
}

module.exports = { createMessagesRouter };
