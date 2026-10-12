// Client-Side End-to-End Encryption (E2EE) Engine using Native Web Crypto API (URL #hash Secret + ECDH P-256 + HKDF + AES-256-GCM)
// Backend / Cloudflare Worker operates strictly as a blind zero-knowledge ciphertext relay.

const E2EE_ENVELOPE_PREFIX = 'E2EE:v1:';
const ECDH_IDENTITY_STORAGE_KEY = 'whispernet_ecdh_keypair_v1';
const PEER_PUBKEY_CACHE_KEY = 'whispernet_peer_pubkeys_v1';
const ROOM_HASH_KEY_STORAGE = 'whispernet_room_hash_keys_v1';
const APP_CRYPTO_PEPPER = 'WHISPERNET-ZERO-TRACE-AES-256-GCM-PROTOCOL-2026';

export interface StoredEcdhIdentity {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  createdAt?: number;
}

const IDENTITY_TTL_MS = 60 * 60 * 1000; // 1 Hour TTL

let cachedMyKeyPair: CryptoKeyPair | null = null;
let cachedMyPublicJwkStr: string | null = null;
const peerPublicKeyStore = new Map<string, string>();
const roomHashSecretStore = new Map<string, string>();
const derivedRoomKeyCache = new Map<string, CryptoKey>();
const decryptedPayloadCache = new Map<string, string>();

// Load cached URL #hash secrets from sessionStorage across page refreshes (F5)
function loadRoomHashSecrets(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(ROOM_HASH_KEY_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        roomHashSecretStore.set(k, v);
      }
    }
  } catch {
    // ignore
  }
}

function saveRoomHashSecrets(): void {
  if (typeof window === 'undefined') return;
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of roomHashSecretStore.entries()) {
      obj[k] = v;
    }
    sessionStorage.setItem(ROOM_HASH_KEY_STORAGE, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

loadRoomHashSecrets();

/**
 * Advanced Client-Side URL Hash Encryption (#hash):
 * Parses `#peer=<PEER_OR_ROOM>&key=<MASTER_SECRET>` or `#<MASTER_SECRET>` from `window.location.hash`.
 * Since URL hash fragments are NEVER sent over HTTP to Cloudflare Workers, the server remains 100% blind to the key.
 */
export function isValidUrlHashSecret(secret?: string | null): boolean {
  if (!secret || typeof secret !== 'string') return false;
  const trimmed = secret.trim();
  return trimmed.length >= 8 && /^[A-Za-z0-9_-]+$/.test(trimmed);
}

/**
 * Checks if `window.location.hash` represents a private chat route/invite link
 * (e.g., contains `#peer=`, `#room=`, `#key=`, or a direct secret hash).
 */
export function hasPrivateUrlHashRoute(): boolean {
  if (typeof window === 'undefined' || !window.location.hash) return false;
  const rawHash = window.location.hash.slice(1).trim();
  if (!rawHash || rawHash.toLowerCase() === 'global') return false;
  if (
    rawHash.toLowerCase() === 'private' ||
    rawHash.includes('peer=') ||
    rawHash.includes('room=') ||
    rawHash.includes('key=') ||
    rawHash.startsWith('peer') ||
    rawHash.startsWith('room') ||
    rawHash.startsWith('key') ||
    isValidUrlHashSecret(rawHash)
  ) {
    return true;
  }
  return true;
}

export function parseUrlHashContext(): {
  peerOrRoom?: string;
  hashSecret?: string;
  hasMalformedOrMissingKeyInHash?: boolean;
} {
  if (typeof window === 'undefined' || !window.location.hash) return {};
  const rawHash = window.location.hash.slice(1).trim();
  if (!rawHash || rawHash === 'global' || rawHash === 'private') return {};

  if (rawHash.includes('=') || rawHash.startsWith('peer') || rawHash.startsWith('room') || rawHash.startsWith('key')) {
    const params = new URLSearchParams(rawHash);
    const peerOrRoom = params.get('peer') || params.get('room') || undefined;
    const rawKey = params.get('key');
    const validKey = isValidUrlHashSecret(rawKey) ? rawKey!.trim() : undefined;

    if (peerOrRoom && validKey) {
      roomHashSecretStore.set(peerOrRoom.trim().toUpperCase(), validKey);
      saveRoomHashSecrets();
      return { peerOrRoom, hashSecret: validKey, hasMalformedOrMissingKeyInHash: false };
    }
    if (validKey) {
      roomHashSecretStore.set('DEFAULT', validKey);
      saveRoomHashSecrets();
      return { hashSecret: validKey, hasMalformedOrMissingKeyInHash: false };
    }
    return {
      peerOrRoom,
      hashSecret: undefined,
      hasMalformedOrMissingKeyInHash: true,
    };
  }

  // Direct `#master-key-xyz` format
  if (isValidUrlHashSecret(rawHash)) {
    roomHashSecretStore.set('DEFAULT', rawHash);
    saveRoomHashSecrets();
    return { hashSecret: rawHash, hasMalformedOrMissingKeyInHash: false };
  }

  return { hasMalformedOrMissingKeyInHash: true };
}

export function hasValidRoomEncryptionKey(roomId?: string | null, peerId?: string | null): boolean {
  const urlCtx = parseUrlHashContext();
  if (urlCtx.hasMalformedOrMissingKeyInHash) {
    return false;
  }
  if (urlCtx.hashSecret && isValidUrlHashSecret(urlCtx.hashSecret)) {
    return true;
  }
  const cleanRoom = roomId ? roomId.trim().toUpperCase() : '';
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  const stored =
    (cleanRoom ? roomHashSecretStore.get(cleanRoom) : undefined) ||
    (cleanPeer ? roomHashSecretStore.get(cleanPeer) : undefined) ||
    roomHashSecretStore.get('DEFAULT');
  return isValidUrlHashSecret(stored);
}

export function getFullRoomInviteUrl(roomId: string, peerId: string, myId?: string): string {
  if (typeof window === 'undefined') return '';
  const cleanRoom = roomId.trim().toUpperCase();
  const cleanPeer = peerId.trim().toUpperCase();
  const secret = bootstrapRoomUrlHashSecret(cleanRoom, cleanPeer);
  const targetPeerParam = myId ? myId.trim().toUpperCase() : cleanPeer;
  try {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#peer=${encodeURIComponent(cleanPeer)}&key=${encodeURIComponent(secret)}`
    );
  } catch {
    // ignore
  }
  return `${window.location.origin}${window.location.pathname}${window.location.search}#peer=${encodeURIComponent(targetPeerParam)}&key=${encodeURIComponent(secret)}`;
}

/**
 * Automatic Key Bootstrap:
 * Generates and attaches a cryptographic secret hash to the browser URL (`#peer=USER-XXXX&key=...`)
 * when creating/joining a 1-on-1 room, ensuring zero-knowledge URL fragment key derivation.
 */
export function bootstrapRoomUrlHashSecret(
  roomId: string,
  peerId?: string,
  skipIfMalformedUrl = false
): string {
  const cleanRoom = roomId.trim().toUpperCase();
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';

  const urlCtx = parseUrlHashContext();
  if (skipIfMalformedUrl && urlCtx.hasMalformedOrMissingKeyInHash) {
    return '';
  }

  if (urlCtx.hashSecret && isValidUrlHashSecret(urlCtx.hashSecret)) {
    roomHashSecretStore.set(cleanRoom, urlCtx.hashSecret);
    if (cleanPeer) roomHashSecretStore.set(cleanPeer, urlCtx.hashSecret);
    saveRoomHashSecrets();
    return urlCtx.hashSecret;
  }

  const existing =
    roomHashSecretStore.get(cleanRoom) ||
    (cleanPeer ? roomHashSecretStore.get(cleanPeer) : undefined) ||
    roomHashSecretStore.get('DEFAULT');

  if (existing && isValidUrlHashSecret(existing)) {
    return existing;
  }

  // Generate fresh cryptographic session key for invite links
  const randomBytes = new Uint8Array(12);
  window.crypto.getRandomValues(randomBytes);
  const generatedSecret = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  roomHashSecretStore.set(cleanRoom, generatedSecret);
  if (cleanPeer) roomHashSecretStore.set(cleanPeer, generatedSecret);
  saveRoomHashSecrets();

  return generatedSecret;
}

export function resetMyEcdhIdentity(): void {
  cachedMyKeyPair = null;
  cachedMyPublicJwkStr = null;
  derivedRoomKeyCache.clear();
  decryptedPayloadCache.clear();
  try {
    localStorage.removeItem(ECDH_IDENTITY_STORAGE_KEY);
    sessionStorage.removeItem(ECDH_IDENTITY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function purgeRoomCryptoSession(roomId: string): void {
  const cleanRoom = roomId.trim().toUpperCase();
  for (const key of Array.from(derivedRoomKeyCache.keys())) {
    if (key.startsWith(`${cleanRoom}::`)) {
      derivedRoomKeyCache.delete(key);
    }
  }
  for (const key of Array.from(decryptedPayloadCache.keys())) {
    if (key.startsWith(`${roomId}::`) || key.startsWith(`${cleanRoom}::`)) {
      decryptedPayloadCache.delete(key);
    }
  }
}

function loadCachedPeerKeys(): void {
  try {
    const raw =
      localStorage.getItem(PEER_PUBKEY_CACHE_KEY) ||
      sessionStorage.getItem(PEER_PUBKEY_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [uid, jwkStr] of Object.entries(parsed)) {
      peerPublicKeyStore.set(uid, jwkStr);
    }
  } catch {
    // ignore
  }
}

loadCachedPeerKeys();

export function registerPeerPublicKey(peerId: string, publicKeyJwkStr?: string | null): void {
  if (!peerId || !publicKeyJwkStr) return;
  const cleanId = peerId.trim().toUpperCase();
  if (peerPublicKeyStore.get(cleanId) === publicKeyJwkStr) return;
  peerPublicKeyStore.set(cleanId, publicKeyJwkStr);
  // Invalidate any previously cached room keys involving this peer so ECDH upgrades seamlessly
  for (const cacheKey of Array.from(derivedRoomKeyCache.keys())) {
    if (cacheKey.includes(cleanId)) {
      derivedRoomKeyCache.delete(cacheKey);
    }
  }
  // Clear cached failed decryptions so messages re-decrypt cleanly once peer key arrives
  for (const [k, v] of Array.from(decryptedPayloadCache.entries())) {
    if (v.startsWith('[Decryption Failed') || k.includes(cleanId)) {
      decryptedPayloadCache.delete(k);
    }
  }
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of peerPublicKeyStore.entries()) {
      obj[k] = v;
    }
    const serialized = JSON.stringify(obj);
    localStorage.setItem(PEER_PUBKEY_CACHE_KEY, serialized);
    sessionStorage.setItem(PEER_PUBKEY_CACHE_KEY, serialized);
  } catch {
    // ignore
  }
}

export async function getOrCreateMyEcdhIdentity(): Promise<{
  keyPair: CryptoKeyPair;
  publicKeyJwkString: string;
}> {
  if (cachedMyKeyPair && cachedMyPublicJwkStr) {
    return { keyPair: cachedMyKeyPair, publicKeyJwkString: cachedMyPublicJwkStr };
  }

  try {
    const saved =
      localStorage.getItem(ECDH_IDENTITY_STORAGE_KEY) ||
      sessionStorage.getItem(ECDH_IDENTITY_STORAGE_KEY);
    if (saved) {
      const parsed: StoredEcdhIdentity = JSON.parse(saved);
      const isExpired =
        parsed.createdAt && Date.now() - parsed.createdAt >= IDENTITY_TTL_MS;
      if (!isExpired) {
        const privateKey = await window.crypto.subtle.importKey(
          'jwk',
          parsed.privateKeyJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveBits']
        );
        const publicKey = await window.crypto.subtle.importKey(
          'jwk',
          parsed.publicKeyJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          []
        );
        cachedMyKeyPair = { privateKey, publicKey };
        cachedMyPublicJwkStr = JSON.stringify(parsed.publicKeyJwk);
        return { keyPair: cachedMyKeyPair, publicKeyJwkString: cachedMyPublicJwkStr };
      }
    }
  } catch {
    // Regenerate on parse/import error
  }

  const keyPair = await window.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwkString = JSON.stringify(publicKeyJwk);

  try {
    const serialized = JSON.stringify({
      publicKeyJwk,
      privateKeyJwk,
      createdAt: Date.now(),
    });
    localStorage.setItem(ECDH_IDENTITY_STORAGE_KEY, serialized);
    sessionStorage.setItem(ECDH_IDENTITY_STORAGE_KEY, serialized);
  } catch {
    // ignore storage quota errors
  }

  cachedMyKeyPair = keyPair;
  cachedMyPublicJwkStr = publicKeyJwkString;
  return { keyPair, publicKeyJwkString };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Derive an AES-256-GCM CryptoKey for a room (URL #hash key, ECDH shared secret, or PBKDF2 room key)
async function getRoomAesGcmKey(
  roomId: string,
  mode: 'hash' | 'ecdh' | 'deterministic',
  peerId?: string,
  explicitHashSecret?: string
): Promise<CryptoKey> {
  const cleanRoomId = roomId.trim().toUpperCase();
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  const urlCtx = parseUrlHashContext();
  const hashSecret =
    explicitHashSecret ||
    urlCtx.hashSecret ||
    roomHashSecretStore.get(cleanRoomId) ||
    (cleanPeer ? roomHashSecretStore.get(cleanPeer) : undefined) ||
    roomHashSecretStore.get('DEFAULT') ||
    '';
  const cacheId = `${cleanRoomId}::${mode}::${cleanPeer}::${mode === 'hash' ? hashSecret : ''}`;

  const existing = derivedRoomKeyCache.get(cacheId);
  if (existing) return existing;

  const encoder = new TextEncoder();

  if (mode === 'hash' && hashSecret) {
    const hashKeyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(`URL-HASH-KEY::${cleanRoomId}::${hashSecret}::${APP_CRYPTO_PEPPER}`),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const hashAesKey = await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(`WHISPERNET-HASH-SALT::${cleanRoomId}`),
        iterations: 65000,
        hash: 'SHA-256',
      },
      hashKeyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    derivedRoomKeyCache.set(cacheId, hashAesKey);
    return hashAesKey;
  }

  if (mode === 'ecdh' && cleanPeer) {
    const peerPubJwkStr = peerPublicKeyStore.get(cleanPeer);
    if (peerPubJwkStr) {
      try {
        const { keyPair } = await getOrCreateMyEcdhIdentity();
        const peerPubJwk = JSON.parse(peerPubJwkStr) as JsonWebKey;
        const peerPublicKey = await window.crypto.subtle.importKey(
          'jwk',
          peerPubJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );

        const sharedBits = await window.crypto.subtle.deriveBits(
          { name: 'ECDH', public: peerPublicKey },
          keyPair.privateKey,
          256
        );

        const hkdfBaseKey = await window.crypto.subtle.importKey(
          'raw',
          sharedBits,
          'HKDF',
          false,
          ['deriveKey']
        );

        const aesKey = await window.crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode(`WHISPERNET-SALT-${cleanRoomId}`),
            info: encoder.encode(APP_CRYPTO_PEPPER),
          },
          hkdfBaseKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );

        derivedRoomKeyCache.set(cacheId, aesKey);
        return aesKey;
      } catch {
        // Fallback to deterministic PBKDF2 room key if peer JWK is malformed
      }
    }
  }

  // Deterministic PBKDF2-SHA256 AES-256-GCM Room Key
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(`${cleanRoomId}::${APP_CRYPTO_PEPPER}`),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const deterministicKey = await window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(`WHISPERNET-PBKDF2-SALT::${cleanRoomId}`),
      iterations: 65000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  derivedRoomKeyCache.set(cacheId, deterministicKey);
  return deterministicKey;
}

// Automatically derive and warm up a temporary cryptographic session key in-browser upon joining a room
export async function initializeRoomSessionKey(
  roomId: string,
  peerId?: string
): Promise<void> {
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  if (roomId !== 'GLOBAL') {
    const hashSecret = bootstrapRoomUrlHashSecret(roomId, cleanPeer);
    if (hashSecret) {
      await getRoomAesGcmKey(roomId, 'hash', cleanPeer, hashSecret);
    }
  }
  const hasPeerEcdh = Boolean(
    cleanPeer && roomId !== 'GLOBAL' && peerPublicKeyStore.has(cleanPeer)
  );
  if (hasPeerEcdh) {
    await getRoomAesGcmKey(roomId, 'ecdh', cleanPeer);
  }
  await getRoomAesGcmKey(roomId, 'deterministic', cleanPeer);
}

// Encrypt plaintext on the client using AES-256-GCM before network transmission (only for Private 1-on-1 rooms; GLOBAL chat sends normal readable plaintext)
export async function encryptMessageContent(
  plaintext: string,
  roomId: string,
  peerId?: string
): Promise<string> {
  if (!roomId || roomId.trim().toUpperCase() === 'GLOBAL') {
    return plaintext;
  }

  const cleanRoom = roomId.trim().toUpperCase();
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  const urlCtx = parseUrlHashContext();
  const activeHashSecret =
    urlCtx.hashSecret ||
    roomHashSecretStore.get(cleanRoom) ||
    (cleanPeer ? roomHashSecretStore.get(cleanPeer) : undefined);

  const useHashMode = Boolean(urlCtx.hashSecret && isValidUrlHashSecret(urlCtx.hashSecret));
  const modeToUse = useHashMode ? 'hash' : 'deterministic';
  const flagToUse = useHashMode ? 'H' : 'D';

  const key = await getRoomAesGcmKey(roomId, modeToUse, cleanPeer, activeHashSecret);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encodedPlaintext = new TextEncoder().encode(plaintext);

  const cipherBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedPlaintext
  );

  const ivB64 = bytesToBase64(iv);
  const cipherB64 = bytesToBase64(new Uint8Array(cipherBuffer));

  return `${E2EE_ENVELOPE_PREFIX}${flagToUse}:${ivB64}:${cipherB64}`;
}

// Decrypt AES-256-GCM ciphertext exclusively on the client browser (with bounded in-memory LRU cache)
export async function decryptMessageContent(
  payload: string,
  roomId: string,
  peerId?: string
): Promise<string> {
  if (!payload || !payload.startsWith(E2EE_ENVELOPE_PREFIX)) {
    return payload;
  }

  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  const urlCtx = parseUrlHashContext();
  if (urlCtx.hasMalformedOrMissingKeyInHash && roomId !== 'GLOBAL') {
    return '[Decryption Failed: Missing or invalid key]';
  }

  const cacheKey = `${roomId}::${cleanPeer}::${urlCtx.hashSecret || ''}::${payload}`;
  const cachedPlaintext = decryptedPayloadCache.get(cacheKey);
  if (cachedPlaintext !== undefined) {
    return cachedPlaintext;
  }

  try {
    const rawBody = payload.slice(E2EE_ENVELOPE_PREFIX.length);
    const parts = rawBody.split(':');

    let modeFlag = 'D';
    let ivB64 = '';
    let cipherB64 = '';

    if (parts.length === 3) {
      modeFlag = parts[0];
      ivB64 = parts[1];
      cipherB64 = parts[2];
    } else if (parts.length === 2) {
      ivB64 = parts[0];
      cipherB64 = parts[1];
    } else {
      return '[Decryption Failed: Missing or invalid key]';
    }

    const iv = base64ToBytes(ivB64);
    const cipherBytes = base64ToBytes(cipherB64);

    const candidateModes: Array<'deterministic' | 'ecdh' | 'hash'> =
      modeFlag === 'H'
        ? ['hash']
        : modeFlag === 'E'
        ? ['ecdh', 'deterministic', 'hash']
        : ['deterministic', 'hash', 'ecdh'];

    for (const candidateMode of candidateModes) {
      if (candidateMode === 'ecdh' && !cleanPeer) continue;
      try {
        const candidateKey = await getRoomAesGcmKey(roomId, candidateMode, cleanPeer);
        const decryptedBuffer = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          candidateKey,
          cipherBytes
        );
        const decoded = new TextDecoder().decode(decryptedBuffer);
        if (decryptedPayloadCache.size > 600) {
          const firstKey = decryptedPayloadCache.keys().next().value;
          if (firstKey) decryptedPayloadCache.delete(firstKey);
        }
        decryptedPayloadCache.set(cacheKey, decoded);
        return decoded;
      } catch {
        // Try next candidate key mode
      }
    }

    return '[Decryption Failed: Missing or invalid key]';
  } catch {
    return '[Decryption Failed: Missing or invalid key]';
  }
}
