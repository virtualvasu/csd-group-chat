const { validateUsername, validateMessage } = require('./validation');
const { saveMessage, getHistory } = require('./db/messageRepository');
const { findSender, registerSender } = require('./db/senderRepository');
const {
  verifyBytes,
  verifySignature,
  isTimestampFresh,
  createChallenge,
} = require('./crypto/signatures');
const { encrypt, decrypt } = require('./crypto/messageCipher');

// There is only one room for now. Every message is stored against this id, so
// adding more rooms later is a matter of passing a real id through.
const ROOM_ID = 'main';

// How long a login challenge stays usable. Long enough for a slow browser to
// sign it, short enough that a captured challenge is worthless later.
const CHALLENGE_TTL_MS = 30_000;

// The stored bytes of one message, base64-encoded for the wire.
//
// This is what the database actually holds. Clients render it in their
// encrypted view, which is how someone reading the UI can satisfy themselves
// that messages are not stored as plaintext without opening a mongo shell.
// Nothing here is secret: the ciphertext is useless without the server key,
// and the signature and public key are already broadcast with every message.
function storedForm(message) {
  return {
    ciphertext: message.ciphertext ? message.ciphertext.toString('base64') : null,
    nonce: message.nonce ? message.nonce.toString('base64') : null,
    signature: message.signature ? message.signature.toString('base64') : null,
    clientTimestamp: message.clientTimestamp ?? null,
  };
}

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
          // The stored record exactly as the database holds it. The client
          // shows this in its encrypted view, so what someone inspects is the
          // real row rather than a re-encryption made for display.
          stored: storedForm(message),
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

  // Logging in takes two round trips, because presenting a public key proves
  // nothing on its own — every message broadcast carries the sender's public
  // key, so anyone can read one off the wire and claim it. What we need is
  // proof the client holds the matching *private* key, so the server sends a
  // random challenge and only accepts a signature over it.
  //
  //   client  --auth-start {username, publicKey}-->  server
  //   client  <--auth-challenge {challenge}--------  server
  //   client  --auth-response {signature}--------->  server
  //   client  <--join-success ---------------------  server
  //
  // The username is bound to its key on first use, so a later login for that
  // name is rejected unless it presents the same key and can sign with it.
  socket.on(
    'auth-start',
    safeHandler(async (rawPayload) => {
      if (socket.data.username) return; // already logged in

      const rawUsername = rawPayload && typeof rawPayload === 'object' ? rawPayload.username : null;
      const publicKey =
        rawPayload && typeof rawPayload.publicKey === 'string' ? rawPayload.publicKey : null;

      const result = validateUsername(rawUsername);
      if (!result.valid) {
        socket.emit('join-error', { message: result.reason });
        return;
      }

      // No key means the client could not reach WebCrypto at all, which is
      // usually a page served over plain HTTP from something other than
      // localhost. Saying so is more useful than a generic refusal.
      if (!publicKey) {
        socket.emit('join-error', {
          message:
            'This page could not create a signing key. Open the app over HTTPS or on localhost and try again.',
        });
        return;
      }

      // Trust on first use: once a name has a key, only that key may use it.
      // Checked here as well as after the proof so an impostor is turned away
      // before the server spends anything on a challenge.
      const existing = await findSender(result.username);
      if (existing && existing.publicKey !== publicKey) {
        socket.emit('join-error', {
          message:
            'This username is registered to a different key. Clear your stored identity or choose a different username.',
        });
        return;
      }

      const challenge = createChallenge();
      socket.data.pendingAuth = {
        username: result.username,
        publicKey,
        challenge,
        expiresAt: Date.now() + CHALLENGE_TTL_MS,
      };

      socket.emit('auth-challenge', { challenge });
    })
  );

  socket.on(
    'auth-response',
    safeHandler(async (rawPayload) => {
      if (socket.data.username) return; // already logged in

      const pending = socket.data.pendingAuth;
      if (!pending) {
        socket.emit('join-error', { message: 'No login in progress. Please try again.' });
        return;
      }

      // One challenge, one attempt. Clearing it up front means a failed proof
      // cannot be retried against the same random bytes.
      socket.data.pendingAuth = null;

      if (Date.now() > pending.expiresAt) {
        socket.emit('join-error', { message: 'Login timed out. Please try again.' });
        return;
      }

      const signature =
        rawPayload && typeof rawPayload.signature === 'string' ? rawPayload.signature : null;

      const proved =
        signature !== null &&
        (await verifyBytes(
          Buffer.from(pending.challenge, 'base64'),
          signature,
          pending.publicKey
        ));

      if (!proved) {
        socket.emit('join-error', {
          message: 'Could not verify that you hold the private key for this username.',
        });
        return;
      }

      // Usernames are unique per server, so a second tab using the same name
      // is rejected here as well. A reconnecting client may briefly collide with
      // a recently disconnected socket, so allow a short reclaim window for that case.
      if (presence.isUsernameTaken(pending.username)) {
        const reclaimed = presence.reclaimUsername(socket.id, pending.username);
        if (!reclaimed) {
          socket.emit('join-error', {
            message: `Username "${pending.username}" is already taken. It may be open in another tab.`,
          });
          return;
        }
      }

      presence.add(socket.id, pending.username);
      socket.data.username = pending.username;
      socket.data.publicKey = pending.publicKey;

      // Record the public key the first time this username logs in.
      await registerSender(pending.username, pending.publicKey);

      socket.emit('join-success', { username: pending.username });

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

      socket.broadcast.emit('user-joined', { username: pending.username, timestamp: Date.now() });
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

      // Every message must arrive signed. There is no unsigned path: a message
      // the server cannot attribute to a key is refused rather than stored with
      // a weaker verdict, so "who wrote this" has an answer for every row in
      // the database.
      //
      // A bare string is what the old unsigned client sent, so it is turned
      // away here rather than falling through to the text validator, which
      // would blame the text for a problem that is really a missing signature.
      if (!rawPayload || typeof rawPayload !== 'object') {
        socket.emit('message-error', { message: 'Unsigned messages are not accepted.' });
        return;
      }

      const clientTimestamp =
        typeof rawPayload.timestamp === 'number' ? rawPayload.timestamp : null;
      const signatureB64 =
        typeof rawPayload.signature === 'string' ? rawPayload.signature : null;

      const result = validateMessage(rawPayload.text);
      if (!result.valid) {
        socket.emit('message-error', { message: result.reason });
        return;
      }

      const publicKey = socket.data.publicKey ?? null;

      if (!publicKey || !signatureB64 || clientTimestamp === null) {
        socket.emit('message-error', { message: 'Unsigned messages are not accepted.' });
        return;
      }

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
      const signature = Buffer.from(signatureB64, 'base64');

      const id = await saveMessage({
        roomId: ROOM_ID,
        senderId: username,
        ciphertext,
        nonce,
        timestamp: serverTimestamp,
        clientTimestamp,
        signature,
        senderPublicKey: Buffer.from(publicKey, 'base64'),
      });

      io.emit('chat-message', {
        id,
        username,
        text: result.text,
        timestamp: serverTimestamp.getTime(),
        signature: 'valid',
        senderPublicKey: publicKey,
        // Same shape history sends, so a live message and a reloaded one are
        // interchangeable to the client's encrypted view.
        stored: storedForm({ ciphertext, nonce, signature, clientTimestamp }),
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
