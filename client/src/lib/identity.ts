// Client-side identity: ECDSA P-256 key pair, persisted in IndexedDB.
//
// Security properties:
//   - The private CryptoKey is generated with extractable: false — the browser
//     exposes only an opaque handle; the raw bytes can never be read or sent.
//   - The public key is exported as SPKI → base64 and included in join/messages.
//   - IndexedDB stores the entire CryptoKeyPair object (the browser serialises
//     the handle, not the raw key material).
//
// NOTE: Clearing browser storage (IndexedDB) destroys the private key permanently.
// The user will be locked out of their TOFU-registered username after doing this.

const DB_NAME = 'csd-identity';
const DB_VERSION = 1;
const STORE_NAME = 'keypair';
const KEY_RECORD_ID = 'main';

const ALGO: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

/**
 * Whether this page can do any of the crypto below.
 *
 * `crypto.subtle` only exists in a secure context — HTTPS, or localhost. A page
 * served over plain HTTP from a LAN address has no WebCrypto at all, so there
 * is no identity to be had and the server will refuse the login. Callers check
 * this so they can say that plainly instead of failing with a TypeError.
 */
export function isSigningAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

/** Decodes a base64 string into the bytes it represents. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// --------------------------------------------------------------------------
// IndexedDB helpers
// --------------------------------------------------------------------------

function openIdentityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --------------------------------------------------------------------------
// Key material
// --------------------------------------------------------------------------

let _keyPair: CryptoKeyPair | null = null;
let _publicKeyB64: string | null = null;

/**
 * Returns the ECDSA key pair for this browser, generating and persisting one
 * the first time it is called.  Subsequent calls return the cached pair.
 */
export async function getOrCreateIdentity(): Promise<CryptoKeyPair> {
  if (_keyPair) return _keyPair;

  const db = await openIdentityDb();
  const stored = await idbGet<CryptoKeyPair>(db, KEY_RECORD_ID);

  if (stored && stored.privateKey && stored.publicKey) {
    _keyPair = stored;
    return _keyPair;
  }

  // Generate a fresh key pair.  Private key is NOT extractable.
  const pair = await crypto.subtle.generateKey(ALGO, false, ['sign', 'verify']);

  await idbPut(db, KEY_RECORD_ID, pair);
  _keyPair = pair;
  return _keyPair;
}

/**
 * Returns the SPKI-encoded public key as a base64 string.
 * Safe to send over the wire — contains no private key material.
 */
export async function exportPublicKey(): Promise<string> {
  if (_publicKeyB64) return _publicKeyB64;

  const pair = await getOrCreateIdentity();
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  _publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  return _publicKeyB64;
}

/**
 * Signs `bytes` with the local private key and returns a base64 signature.
 */
export async function sign(bytes: Uint8Array): Promise<string> {
  const pair = await getOrCreateIdentity();
  // Cast to ArrayBuffer to satisfy strict WebCrypto typings (Uint8Array<ArrayBufferLike>).
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    bytes.buffer as ArrayBuffer
  );
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

/**
 * Returns the first 8 hex characters of the SHA-256 hash of the base64
 * public key string — used as a short visual fingerprint in the UI.
 *
 * @param publicKeyB64 - base64-encoded SPKI public key (as sent over the wire).
 */
export async function getFingerprint(publicKeyB64: string): Promise<string> {
  const encoded = new TextEncoder().encode(publicKeyB64);
  // Use .buffer cast to ArrayBuffer to satisfy strict WebCrypto typings.
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded.buffer as ArrayBuffer);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 8);
}
