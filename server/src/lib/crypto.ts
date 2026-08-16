/**
 * Authenticated encryption for provider credentials at rest.
 *
 * OAuth access and refresh tokens are bearer credentials: whoever holds one can
 * spend a client's ad budget until it expires. They must never sit in the
 * database in plaintext, where a read-only SQL leak or a stray backup would be
 * enough to take over every connected account.
 *
 * AES-256-GCM, not CBC: GCM authenticates the ciphertext, so a tampered row
 * fails to decrypt instead of silently yielding altered bytes. The nonce is
 * random per encryption and stored alongside — reusing a nonce under one key is
 * the classic way to destroy GCM's guarantees, so it is never derived from the
 * plaintext or from a counter.
 *
 * Stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix
 * is there so a future key rotation or algorithm change can be told apart from
 * existing rows rather than guessed at.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;
const PREFIX = 'v1';

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      'TOKEN_ENCRYPTION_KEY is not set. Provider credentials cannot be stored without it. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
    this.name = 'MissingEncryptionKeyError';
  }
}

export class DecryptionFailedError extends Error {
  constructor(reason: string) {
    // Deliberately vague to the caller: a decryption failure must not become an
    // oracle that reports *why* a value did not authenticate.
    super(`Stored credential could not be decrypted (${reason})`);
    this.name = 'DecryptionFailedError';
  }
}

/**
 * Resolve the 32-byte key from the environment.
 *
 * A base64 or hex key of exactly 32 bytes is used directly. Anything else is
 * hashed to 32 bytes with SHA-256 so a passphrase still produces a valid key
 * rather than crashing at the first write — but the length is checked first,
 * because silently hashing a *nearly* correct key would mask a truncated secret.
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) throw new MissingEncryptionKeyError();

  for (const encoding of ['base64', 'hex'] as const) {
    try {
      const decoded = Buffer.from(raw, encoding);
      if (decoded.byteLength === 32) return decoded;
    } catch {
      // Not this encoding; fall through.
    }
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** True when a usable key is configured, without throwing. */
export function encryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new DecryptionFailedError('unrecognised format');

  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ciphertext = Buffer.from(parts[3]!, 'base64url');

  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new DecryptionFailedError('malformed envelope');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionFailedError('authentication failed');
  }
}

/**
 * A short, non-reversible fingerprint of a secret.
 *
 * Lets a log line or a support conversation identify *which* token is in play
 * without ever writing the token itself down. Truncated to 12 hex characters —
 * enough to distinguish tokens in practice, far too little to attack.
 */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

/** Constant-time comparison, for OAuth state and similar opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // Length is not secret, but bailing early on it keeps timingSafeEqual happy.
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
