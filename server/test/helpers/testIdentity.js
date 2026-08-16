'use strict';

// Test-side stand-in for a browser's ECDSA identity.
//
// Logging in is a challenge-response handshake now, so every test that needs a
// connected client needs a key pair and the three-step exchange that goes with
// it. Both live here so the socket tests can share one implementation.

const { webcrypto } = require('node:crypto');

const { buildCanonicalBytes } = require('../../src/crypto/canonical');

/** Resolves with the payload of the next `eventName` on `socket`. */
function waitForEvent(socket, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName}`)),
      timeoutMs
    );
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Generates a key pair and returns the operations a client performs with it.
 * The private key never leaves this object, the same way a browser's does not.
 */
async function createIdentity() {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey));

  async function signBytes(bytes) {
    const signature = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      bytes
    );

    return Buffer.from(signature).toString('base64');
  }

  return {
    publicKey: spki.toString('base64'),
    signBytes,
    sign(username, timestamp, text) {
      return signBytes(buildCanonicalBytes(username, timestamp, text));
    },
  };
}

/**
 * Runs the full challenge-response login and returns the chat history the
 * server sent on the way in.
 */
async function loginAs(socket, username, identity) {
  const historyPromise = waitForEvent(socket, 'chat-history');
  const challengePromise = waitForEvent(socket, 'auth-challenge');

  socket.emit('auth-start', { username, publicKey: identity.publicKey });
  const { challenge } = await challengePromise;

  socket.emit('auth-response', {
    signature: await identity.signBytes(Buffer.from(challenge, 'base64')),
  });
  await waitForEvent(socket, 'join-success');

  return historyPromise;
}

/**
 * Sends one signed message and resolves once the server has broadcast it,
 * which is also when it is safely stored.
 */
async function sendSigned(socket, identity, username, text) {
  const timestamp = Date.now();
  const broadcast = waitForEvent(socket, 'chat-message');

  socket.emit('chat-message', {
    text,
    timestamp,
    signature: await identity.sign(username, timestamp, text),
  });

  return broadcast;
}

module.exports = { waitForEvent, createIdentity, loginAs, sendSigned };
