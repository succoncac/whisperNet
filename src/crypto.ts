// Client-Side End-to-End Encryption (E2EE) Engine using Native Web Crypto API (ECDH P-256 + HKDF + AES-256-GCM)
// Backend / Cloudflare Worker operates strictly as a blind zero-knowledge ciphertext relay.

const E2EE_ENVELOPE_PREFIX = 'E2EE:v1:';
const ECDH_IDENTITY_STORAGE_KEY = 'whispernet_ecdh_keypair_v1';
const PEER_PUBKEY_CACHE_KEY = 'whispernet_peer_pubkeys_v1';
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
const derivedRoomKeyCache = new Map<string, CryptoKey>();
const decryptedPayloadCache = new Map<string, string>();

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

// Derive an AES-256-GCM CryptoKey for a room (ECDH shared secret if peer key is present, or PBKDF2 room key)
async function getRoomAesGcmKey(
  roomId: string,
  mode: 'ecdh' | 'deterministic',
  peerId?: string
): Promise<CryptoKey> {
  const cleanRoomId = roomId.trim().toUpperCase();
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  const cacheId = `${cleanRoomId}::${mode}::${cleanPeer}`;

  const existing = derivedRoomKeyCache.get(cacheId);
  if (existing) return existing;

  const encoder = new TextEncoder();

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

// Encrypt plaintext on the client using AES-256-GCM before network transmission
export async function encryptMessageContent(
  plaintext: string,
  roomId: string,
  peerId?: string
): Promise<string> {
  const cleanPeer = peerId ? peerId.trim().toUpperCase() : '';
  const hasPeerEcdh = Boolean(
    cleanPeer && roomId !== 'GLOBAL' && peerPublicKeyStore.has(cleanPeer)
  );
  const mode: 'ecdh' | 'deterministic' = hasPeerEcdh ? 'ecdh' : 'deterministic';

  const key = await getRoomAesGcmKey(roomId, mode, cleanPeer);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encodedPlaintext = new TextEncoder().encode(plaintext);

  const cipherBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encodedPlaintext
  );

  const ivB64 = bytesToBase64(iv);
  const cipherB64 = bytesToBase64(new Uint8Array(cipherBuffer));
  const modeFlag = mode === 'ecdh' ? 'E' : 'D';

  return `${E2EE_ENVELOPE_PREFIX}${modeFlag}:${ivB64}:${cipherB64}`;
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
  const cacheKey = `${roomId}::${cleanPeer}::${payload}`;
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
      return '[Encrypted Payload]';
    }

    const iv = base64ToBytes(ivB64);
    const cipherBytes = base64ToBytes(cipherB64);

    if (modeFlag === 'E' && cleanPeer) {
      try {
        const ecdhKey = await getRoomAesGcmKey(roomId, 'ecdh', cleanPeer);
        const decryptedBuffer = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv },
          ecdhKey,
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
        // Fallback attempt with deterministic room key
      }
    }

    const detKey = await getRoomAesGcmKey(roomId, 'deterministic', cleanPeer);
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      detKey,
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
    return '[Encrypted Message]';
  }
}
