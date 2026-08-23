/**
 * Credential encryption and provider readiness.
 *
 * These are the two pieces of the integration layer that can be proven without
 * any provider credentials, and both are the kind of code that fails silently:
 * encryption that round-trips but does not authenticate, and a readiness model
 * that says "not available" without saying what is missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DecryptionFailedError,
  MissingEncryptionKeyError,
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
  safeEqual,
  secretFingerprint,
} from '../src/lib/crypto.js';
import { adapterFor, allAdapters, providerReadiness } from '../src/services/integrations/index.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ=='; // 32 bytes, base64

describe('credential encryption', () => {
  const original = process.env.TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = original;
  });

  it('round-trips a token', () => {
    const token = 'EAAB0splendidlyLongAccessTokenValue-1234567890';
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it('never stores the plaintext in the envelope', () => {
    const token = 'super-secret-refresh-token';
    const stored = encryptSecret(token);
    expect(stored).not.toContain(token);
    expect(stored.startsWith('v1.')).toBe(true);
  });

  it('produces a different ciphertext each time, so equal tokens are not linkable', () => {
    const token = 'identical-token';
    expect(encryptSecret(token)).not.toBe(encryptSecret(token));
  });

  it('refuses a tampered ciphertext instead of returning altered bytes', () => {
    const stored = encryptSecret('a-token-worth-stealing');
    const parts = stored.split('.');
    // Flip a character in the ciphertext segment.
    const body = parts[3]!;
    parts[3] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);

    expect(() => decryptSecret(parts.join('.'))).toThrow(DecryptionFailedError);
  });

  it('refuses a swapped authentication tag', () => {
    const a = encryptSecret('token-one').split('.');
    const b = encryptSecret('token-two').split('.');
    a[2] = b[2]!;
    expect(() => decryptSecret(a.join('.'))).toThrow(DecryptionFailedError);
  });

  it('refuses a malformed envelope rather than guessing', () => {
    expect(() => decryptSecret('not-an-envelope')).toThrow(DecryptionFailedError);
    expect(() => decryptSecret('v2.a.b.c')).toThrow(DecryptionFailedError);
  });

  it('will not encrypt at all without a key', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(encryptionConfigured()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(MissingEncryptionKeyError);
  });

  it('accepts a passphrase by deriving a key from it', () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'a-long-human-chosen-passphrase-for-this-deployment';
    expect(encryptionConfigured()).toBe(true);
    expect(decryptSecret(encryptSecret('token'))).toBe('token');
  });

  it('cannot decrypt with a different key', () => {
    const stored = encryptSecret('token');
    process.env.TOKEN_ENCRYPTION_KEY = 'a-completely-different-key-value-here';
    expect(() => decryptSecret(stored)).toThrow(DecryptionFailedError);
  });

  it('fingerprints without revealing the secret', () => {
    const token = 'sensitive-value';
    const print = secretFingerprint(token);
    expect(print).toHaveLength(12);
    expect(print).not.toContain(token);
    expect(secretFingerprint(token)).toBe(print);
    expect(secretFingerprint('other')).not.toBe(print);
  });

  it('compares opaque tokens safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('provider readiness', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID', 'TOKEN_ENCRYPTION_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('names the exact missing variables rather than saying "not implemented"', () => {
    // META_CONFIG_ID joins the set: Business Login cannot start without the
    // configuration id, so a deployment missing it is not configured.
    for (const key of ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID']) {
      delete process.env[key];
    }

    const report = providerReadiness(adapterFor('FACEBOOK'));
    expect(report.state).toBe('NOT_CONFIGURED');
    expect(report.missingEnv).toEqual(['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID']);
    expect(report.detail).toContain('META_APP_ID');
    expect(report.detail).not.toMatch(/not implemented/i);
  });

  it('distinguishes a missing encryption key from missing credentials', () => {
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'secret';
    process.env.META_REDIRECT_URI = 'https://example.com/cb';
    process.env.META_CONFIG_ID = 'login-config-1';
    delete process.env.TOKEN_ENCRYPTION_KEY;

    const report = providerReadiness(adapterFor('FACEBOOK'));
    expect(report.state).toBe('NO_ENCRYPTION');
    expect(report.missingEnv).toEqual(['TOKEN_ENCRYPTION_KEY']);
  });

  it('reports READY only when credentials and encryption are both present', () => {
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'secret';
    process.env.META_REDIRECT_URI = 'https://example.com/cb';
    process.env.META_CONFIG_ID = 'login-config-1';
    process.env.TOKEN_ENCRYPTION_KEY = KEY;

    expect(providerReadiness(adapterFor('FACEBOOK')).state).toBe('READY');
  });

  it('never claims a provider is connected merely because it is configured', () => {
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'secret';
    process.env.META_REDIRECT_URI = 'https://example.com/cb';
    process.env.META_CONFIG_ID = 'login-config-1';
    process.env.TOKEN_ENCRYPTION_KEY = KEY;

    // READY is about being able to *start* OAuth. It is not a connection, and
    // nothing in the readiness report may suggest otherwise.
    const report = providerReadiness(adapterFor('FACEBOOK'));
    expect(report.state).not.toBe('CONNECTED');
    expect(report.detail.toLowerCase()).toContain('ready to connect');
  });

  it('declares each provider a real authorize endpoint and scopes', () => {
    for (const adapter of allAdapters()) {
      const oauth = adapter.oauth();
      expect(oauth.authorizeUrl).toMatch(/^https:\/\//);
      expect(oauth.scopes.length).toBeGreaterThan(0);
      expect(oauth.requiredEnv.length).toBeGreaterThan(0);
      expect(oauth.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('describes capabilities per provider rather than all-false', () => {
    // Snapchat's Marketing API reports on ads but does not publish content;
    // Google Business posts and replies but has no ad-metrics surface. A single
    // all-false shape would erase both distinctions.
    expect(adapterFor('SNAPCHAT').capabilities).toMatchObject({ publish: false, metrics: true });
    expect(adapterFor('GOOGLE_BUSINESS').capabilities).toMatchObject({ publish: true, metrics: false });
    expect(adapterFor('FACEBOOK').capabilities).toMatchObject({ publish: true, metrics: true });
  });
});
