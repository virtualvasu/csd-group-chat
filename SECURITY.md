# Security Analysis

This document provides a candid security analysis of the CSD Group Chat application, structured on the four security properties and answering the question on slide 24: **"IS IT REALLY SECURED?"**

## Four Security Properties

### 1. **Persistence**

**What it protects:** Messages are not lost when the server restarts.

**Mechanism:**
- Every message is saved to MongoDB *before* it is broadcast to clients.
- MongoDB uses durable storage; messages survive server shutdown and restart.
- New joiners receive the stored history before their join notification. It is capped at the 100 most recent messages, so a long-running room is not replayed in full.

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
- **Transport is HTTPS/WSS in development, but with a self-signed certificate.** That encrypts traffic against a passive eavesdropper, but it does not authenticate the server: a user who clicks through the certificate warning cannot tell a real server from an impostor. Nothing in this repository provisions a trusted certificate for a deployment.
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
- **A malicious server is still free to drop messages.** The server refuses unsigned messages, but nothing forces it to store a message it received, and a reader has no way to notice a message that never arrived.
- If the database is restored from an unencrypted backup, or if a backup is stolen, all messages are readable.

---

### 4. **Authenticity**

**What it protects:** You know that a message came from the person whose username is shown.

**Mechanism:**
- Each browser generates an **ECDSA P-256** key pair on first use and keeps it in IndexedDB. The private key is created with `extractable: false`, so the browser will not release its bytes to any script — including ours.
- **Logging in is a challenge-response.** The client presents its username and public key; the server replies with 32 random bytes; the client returns a signature over them. Only a client holding the matching private key can produce it. The challenge is single-use and expires after 30 seconds.
- Trust on first use binds a username to the first public key that claims it. A later login for that name must present the same key *and* sign the challenge.
- **Every message carries a signature** over a canonical encoding of sender, timestamp, and text. The server verifies it before storing; an invalid signature means the message is rejected and never written.
- Stored signatures are **re-verified on every history read**, so a signature edited in the database is reported as `invalid` rather than trusted.
- Messages with a client timestamp more than 60 seconds from the server clock are rejected, which bounds replay of a captured message.

**What it does NOT cover:**
- **There is no out-of-band identity verification.** The *first* claim of a username is unauthenticated: whoever registers "Alice" first owns it, and nothing proves that person is the real Alice. The key fingerprint shown in the UI is what makes this checkable — two people must compare it over another channel to know they are talking to the same device.
- **The client trusts the server's verdicts.** Signature checking happens on the server, and the client displays the `valid` / `invalid` / `unsigned` result it is told. The client now receives the stored signature and the sender's public key, so it *could* verify independently, but it does not yet. A malicious server could therefore report a forged message as valid.
- **Losing the key means losing the name.** Clearing browser storage destroys the private key permanently, and the username stays bound to the key that is now gone. There is no recovery or key-rotation path.
- **The server is not authenticated to the client.** The login proves the client to the server, not the reverse. With a self-signed certificate a user cannot tell the real server from an impostor.
- **The server remains a single point of trust.** It cannot forge a valid signature — that needs a private key it does not have — but it can drop messages, lie about verdicts, or attribute an unsigned system message to anyone.

---

## Honest Answer to Slide 24: "IS IT REALLY SECURED?"

**Short answer: No, not in the way you might expect.**

This system provides:
- ✓ **Persistence:** Messages are durably stored.
- ✓ **Encryption at rest:** Messages in the database are not readable without the key.
- ✓ **Tamper detection:** One bit wrong and you know something happened.
- ✓ **Proof of key possession at login:** You cannot take a username by replaying its public key; you must sign a random challenge with the private half.
- ✓ **Message authentication:** Every stored message carries an ECDSA signature that is verified before storage and re-verified on every read. Unsigned messages are refused.

This system does **not** provide:
- ✗ **End-to-end encryption.** The server sees every message in plaintext.
- ✗ **Client-side verification.** Signatures are checked by the server; the client shows the verdict it is given rather than checking for itself.
- ✗ **Server authentication.** Transport is HTTPS/WSS, but with a self-signed certificate, so nothing proves you reached the right server.
- ✗ **Host security.** An attacker with shell access to the server host can extract both the encryption key and all plaintext.
- ✗ **Identity beyond first use.** A username belongs to the first key that claims it. Nothing proves that key belongs to the real Alice, and comparing fingerprints out of band is the only way to check.

**Why?** This is a teaching project built in a semester, not a production chat system. The design is honest about its scope. It is secure *against database theft* and *against username theft by an observer*, but not against *server compromise*, and it does not tell you who a key really belongs to.

---

## What a Real System Would Add

To close these gaps, a production system would include:

1. **End-to-End Encryption (E2EE)**
   - Each client generates a keypair on first use.
   - Messages are encrypted client-side with the recipient's public key (or a shared session key derived via key exchange).
   - The server never sees the plaintext.

2. **Client-Side Signature Verification** *(signing is done; verification is not)*
   - Clients already sign every message, and the server already verifies.
   - What is missing is the client re-checking signatures itself against a public key it trusts, so that a malicious server reporting "valid" could be caught.

3. **Centralized Key Management (KMS) or Per-User Key Wrapping**
   - The encryption key is not stored on the server in plaintext.
   - Either a hardware KMS holds the key and decrypts only when needed, or each user's messages are wrapped under their own key and the server cannot decrypt them.

4. **Trusted Transport Security** *(HTTPS/WSS is done; a trusted certificate is not)*
   - The development server already serves HTTPS/WSS, which is what makes WebCrypto available to devices other than the host.
   - What is missing is a certificate from an authority the browser trusts, so users stop clicking through a warning that would also appear for an attacker.

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

8. **Account Recovery and Key Rotation**
   - Identity does persist across sessions: the key pair lives in IndexedDB and the username is bound to it.
   - What is missing is a way back in after that key is lost, and a way to retire a key that has leaked, without abandoning the username. That usually means a second factor or a registration authority.

---

## Current Limitations Versus Design Goals

This system is intentionally limited. The assignment is:
1. Store messages in a database (✓ done: MongoDB).
2. Give a joining user the previous chat history (✓ done: replayed on login).
3. Do not store messages as plaintext (✓ done: AES-256-GCM at rest).
4. Detect modification of a stored message (✓ done: AES-GCM authentication tag).
5. Give each sender a signing key pair (✓ done: ECDSA P-256, private key non-extractable, held in the browser).
6. Carry and verify a sender signature (✓ done: verified before storage, re-verified on every read).

And, beyond the assignment: show that the design is not "magic security" (the analysis above).

The goal is **not** to build Signal, WhatsApp, or a production-grade chat system. It is to show that security is built in layers, each with costs and tradeoffs, and that you must understand your threat model.

**The honest answer to "Is it really secured?" is: "It is secure against the threats it was designed for — someone reading the database, someone editing a stored message, and someone claiming a username they do not hold the key for. It is not secure against a compromised server, and it cannot tell you who a key really belongs to. Choose your system based on your threat model, and never trust marketing that says one system is 'really secured' without naming what it is secured against."**
