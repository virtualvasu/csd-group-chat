# Security Analysis

This document provides a candid security analysis of the CSD Group Chat application, structured on the four security properties and answering the question on slide 24: **"IS IT REALLY SECURED?"**

## Four Security Properties

### 1. **Persistence**

**What it protects:** Messages are not lost when the server restarts.

**Mechanism:**
- Every message is saved to MongoDB *before* it is broadcast to clients.
- MongoDB uses durable storage; messages survive server shutdown and restart.
- New joiners receive the full message history before their join notification.

**What it does NOT cover:**
- If MongoDB itself crashes or loses power before a message is written, that message is lost.
- If the MongoDB host is physically destroyed or the cluster is deleted, all history is gone.
- There is no replication or backup strategy documented in this system; you must set that up separately.
- A malicious database administrator can read, modify, or delete any message.

---

### 2. **Confidentiality**

**What it protects:** Messages at rest in the database are encrypted and unreadable without the encryption key.

**Mechanism:**
- Messages are encrypted with **AES-256-GCM** before being stored in MongoDB.
- Only the message body is encrypted; sender name, timestamp, and room id are stored in plaintext (needed for history queries).
- Each message gets its own random 12-byte nonce; two identical messages produce different ciphertexts.
- The encryption key is stored in an environment variable (`CHAT_ENCRYPTION_KEY`) on the server host.

**What it does NOT cover:**
- **The server sees every message in plaintext.** Messages are decrypted on the server to validate integrity, broadcast to clients, and stored. A compromised server (or a malicious administrator) can read, copy, or forward any message.
- **The encryption key lives in the server's environment.** An attacker with full host access (shell access, process inspection, memory dumps) can extract both the key and all plaintext messages.
- This is **not end-to-end encryption.** The client does not encrypt messages before sending; the server receives plaintext, encrypts it, and stores it. The architectural model trusts the server.
- **Live socket traffic is plain HTTP/WS** (not HTTPS/WSS). On an untrusted network, an eavesdropper can intercept plaintext messages in transit between the client and server.
- There is no key rotation strategy; the same key encrypts all messages forever. A leaked key compromises all past and future messages.

---

### 3. **Integrity**

**What it protects:** A message stored in the database cannot be silently modified; tampering is detected.

**Mechanism:**
- AES-256-GCM includes an authentication tag (16 bytes appended to the ciphertext).
- When a message is retrieved and decrypted, the tag is verified against the ciphertext.
- If even one bit of the ciphertext has been flipped, decryption fails and the authentication tag does not match.
- A tampered message is flagged with `integrity: 'failed'` in the UI and no plaintext is shown; the server logs the failure.

**What it does NOT cover:**
- A tampered message cannot be *silently* corrupted, but it also cannot be *silently* forged. However, a malicious *database administrator* can modify messages at will or delete them entirely.
- If an attacker changes the sender's username or timestamp fields (which are stored in plaintext), that change is not detected.
- The authentication tag only protects the ciphertext itself, not the metadata.
- A malicious server can *accept unsigned messages* and store them anyway, or *discard* a message it doesn't like. There is no signature from the client to prove they sent it.
- If the database is restored from an unencrypted backup, or if a backup is stolen, all messages are readable.

---

### 4. **Authenticity**

**What it protects:** You know that a message came from the person whose username is shown.

**Mechanism:**
- A username is claimed on join; while that user is online, only they can send messages with that username.
- The server associates a Socket.IO connection with a username on join and rejects any message from a different user claiming that name.
- A username that goes offline can be reclaimed by the same person reconnecting within a short grace period.

**What it does NOT cover:**
- **There is no out-of-band identity verification.** A username is just a string; anyone can join as "Alice" if Alice is not online. Trust on first use (TOFU) means the *first* person to claim a username wins; later claimants are rejected. But there is no proof that the first claimant is actually Alice.
- **The server is trusted to authenticate.** A malicious server can accept a message from an unauthenticated or wrong-claiming socket and attribute it to anyone. There is no *client-side* signature verification; the client must trust the server's word about who sent what.
- **Messages are not signed by the sender.** The database schema reserves fields for signatures and public keys (`signature`, `senderPublicKey`), but they are `null` and unused. Future work can add cryptographic signing; currently, there is none.
- **Live socket connections are not authenticated.** Socket.IO uses only a session cookie or query parameter to identify reconnections; there is no mutual authentication between client and server.
- **The server is a single point of trust.** If the server is compromised, it can forge any message and claim it came from anyone.

---

## Honest Answer to Slide 24: "IS IT REALLY SECURED?"

**Short answer: No, not in the way you might expect.**

This system provides:
- ✓ **Persistence:** Messages are durably stored.
- ✓ **Encryption at rest:** Messages in the database are not readable without the key.
- ✓ **Tamper detection:** One bit wrong and you know something happened.
- ✓ **Unique usernames:** While online, each user speaks with their username.

This system does **not** provide:
- ✗ **End-to-end encryption.** The server sees every message in plaintext.
- ✗ **Message authentication.** No signature proves a user sent a message; the server decides.
- ✗ **Transport security.** Live messages are sent over plain HTTP/WS.
- ✗ **Host security.** An attacker with shell access to the server host can extract both the encryption key and all plaintext.
- ✗ **Trust verification.** Usernames are claimed, not proven. You cannot verify Alice is really Alice without meeting her in person or calling her.

**Why?** This is a teaching project built in a semester, not a production chat system. The design is honest about its scope: it shows how to add encryption, integrity checks, and persistence to a basic chat app. It is secure *against database theft* (the stated goal) but not secure *against server compromise* or *network eavesdropping* or *identity spoofing*.

---

## What a Real System Would Add

To close these gaps, a production system would include:

1. **End-to-End Encryption (E2EE)**
   - Each client generates a keypair on first use.
   - Messages are encrypted client-side with the recipient's public key (or a shared session key derived via key exchange).
   - The server never sees the plaintext.

2. **Message Signing**
   - Each client signs every message with their private key.
   - Clients verify signatures client-side; a malicious server cannot forge messages.

3. **Centralized Key Management (KMS) or Per-User Key Wrapping**
   - The encryption key is not stored on the server in plaintext.
   - Either a hardware KMS holds the key and decrypts only when needed, or each user's messages are wrapped under their own key and the server cannot decrypt them.

4. **Transport Security (TLS/HTTPS + WSS)**
   - All traffic between client and server is encrypted in transit.
   - Protects against network eavesdropping on any network (including the lab network).

5. **Certificate Pinning or Key Fingerprint Verification**
   - On first use, the client displays the server's public key fingerprint.
   - The user manually verifies it with the server operator (out-of-band).
   - On later connections, the client refuses any server with a different fingerprint.
   - This prevents TOFU attacks (impostor on the first connection).

6. **Rate Limiting and Abuse Prevention**
   - Already partially present (rate limiter in server code), but could be stronger.

7. **Audit Logging**
   - Every login, logout, message send, and modification is logged (e.g., to immutable storage).
   - Administrators can prove what happened when.

8. **User Registration and Password Authentication**
   - Currently, you claim a username; there is no password or persistent identity across sessions.
   - A real system would require registration and login.

---

## Current Limitations Versus Design Goals

This system is intentionally limited. The assignment is:
1. Add persistence (✓ done: MongoDB).
2. Add encryption (✓ done: AES-256-GCM at rest).
3. Detect tampering (✓ done: AES-GCM authentication tag).
4. Show that the design is not "magic security" (✓ done: honest analysis above).

The goal is **not** to build Signal, WhatsApp, or a production-grade chat system. It is to show that security is built in layers, each with costs and tradeoffs, and that you must understand your threat model.

**The honest answer to "Is it really secured?" is: "It's secure against the threat this system was designed for (database theft), but it's not secure against other threats (server compromise, network eavesdropping, identity spoofing). Choose your system based on your threat model, and never trust marketing that says one system is 'really secured' without naming what it's secured against."**
