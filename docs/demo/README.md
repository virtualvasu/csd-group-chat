# Demo captures

Screenshots and a screen recording of the full front-end flow, for the report.

Captured against an isolated database (`csd_group_chat_demo`) with two browser
profiles, so every key pair and every message here is real — nothing is mocked.

`demo-full-flow.mp4` — the whole flow end to end (1:07).

## Screenshots, in order

| # | File | Shows | Lab requirement |
|---|---|---|---|
| 01 | `01-login-screen.png` | Login screen with this device's key fingerprint | 5 — signing key pair |
| 02 | `02-login-username-entered.png` | Username entered, ready to sign in | — |
| 03 | `03-chat-empty-after-login.png` | Logged in after signing the server's challenge | Auth |
| 04 | `04-first-message-signed.png` | First message, carrying a `Signed` badge | 6 — signature verified |
| 05 | `05-second-user-receives-history.png` | Second user joins and is sent the earlier messages | 2 — chat history |
| 06 | `06-conversation-two-users.png` | Two signed users in conversation | 6 |
| 07 | `07-security-panel-expanded.png` | Scheme panel: AES-256-GCM, GCM tag, ECDSA P-256 | 3, 4, 5 |
| 08 | `08-message-record-inspector.png` | One message's stored row: ciphertext, nonce, signature, key, verdicts | 1, 3, 6 |
| 09 | `09-encrypted-view-ciphertext.png` | Whole conversation shown as stored ciphertext | 3 — not stored as plaintext |
| 10 | `10-chat-history-panel.png` | The restored-messages panel | 2 |
| 11 | `11-history-restored-on-login.png` | A new login replaying messages from the database | 1, 2 — persistence |
| 12 | `12-restored-from-database-panel.png` | Which messages came out of storage, with verdicts | 1, 2 |
| 13 | `13-tamper-detected-integrity-failed.png` | A row edited in the database is flagged; sidebar counts `Tampered 1` | 4 — modification detected |
| 14 | `14-tampered-message-record.png` | The tampered row's record and failed verdict | 4 |
| 15 | `15-impostor-refused-tofu.png` | A different key is refused the registered username | Auth |

`tamper-demo-output.txt` is the output of `npm run tamper-demo`, which flipped
one bit of one stored ciphertext to produce shots 13 and 14.

## Reproducing

```bash
# terminal 1
cd server && npm start
# terminal 2
cd client && npm run dev
# then, to produce shots 13-14:
cd server && npm run tamper-demo
```
