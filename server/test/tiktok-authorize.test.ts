/**
 * The TikTok authorization URL, parameter by parameter.
 *
 * Written against a production failure whose whole content was TikTok's own
 * error page: "We couldn't log in with TikTok — correct the following:
 * client_key". That page names the field and never the reason, so the value of
 * these assertions is that they eliminate our side of it one parameter at a
 * time: the endpoint, the parameter *name* (TikTok says client_key where every
 * other provider says client_id), the variable the value comes from, that it
 * appears exactly once, and that nothing invisible pasted into a hosting
 * dashboard survives into the query string.
 *
 * Nothing here prints a credential. The fixtures are made-up values and the
 * assertions about the real one are about shape, never content.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import {
  TIKTOK_SCOPES,
  authorizationUrl,
  redactCredential,
  tiktokConfig,
  tiktokConfigDiagnostics,
  tiktokConfigured,
} from '../src/services/integrations/tiktok.js';
import { callbackUrl } from '../src/services/integrations/connect-flow.js';

const BASE = 'https://marketing.norivaglobal.com';
const REDIRECT = `${BASE}/api/integrations/tiktok/callback`;
/** Not a real key: the shape of one, so the assertions are about shape. */
const CLIENT_KEY = 'aw1q2w3e4r5t6y7u8i';
const CLIENT_SECRET = 'tiktok-secret-that-must-never-be-echoed';
const STATE = 'signed-state-value';

describe('TikTok authorization URL', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.TIKTOK_CLIENT_KEY = CLIENT_KEY;
    process.env.TIKTOK_CLIENT_SECRET = CLIENT_SECRET;
    process.env.TIKTOK_REDIRECT_URI = REDIRECT;
  });

  afterEach(() => {
    for (const key of ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const authorize = () => new URL(authorizationUrl({ config: tiktokConfig(), state: STATE }));

  // ------------------------------------------------------------- endpoint

  it('uses TikTok\'s v2 authorization endpoint', () => {
    const url = authorize();
    expect(url.origin).toBe('https://www.tiktok.com');
    expect(url.pathname).toBe('/v2/auth/authorize/');
    // Not the Business API portal, which is a different product taking app_id.
    expect(url.origin).not.toContain('business-api');
  });

  // ------------------------------------------------------------ client_key

  it('sends client_key, not client_id, and takes it from TIKTOK_CLIENT_KEY', () => {
    const url = authorize();
    expect(url.searchParams.get('client_key')).toBe(CLIENT_KEY);
    expect(url.searchParams.get('client_key')).toBe(process.env.TIKTOK_CLIENT_KEY);
    expect(url.searchParams.has('client_id')).toBe(false);
    expect(url.searchParams.has('app_id')).toBe(false);
  });

  it('sends client_key exactly once', () => {
    // A duplicated parameter is one of the shapes TikTok reports as an invalid
    // client_key, and it is invisible in a URL read quickly.
    expect(url_query_count(authorize(), 'client_key')).toBe(1);
  });

  it('never puts the client secret in the URL', () => {
    expect(authorize().toString()).not.toContain(CLIENT_SECRET);
  });

  // ---------------------------------------------------- the other parameters

  it('sends response_type, redirect_uri, scope and state', () => {
    const url = authorize();
    expect(url.searchParams.get('response_type')).toBe('code');
    // Byte-identical to the variable: the exchange has to send the same string.
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe(STATE);
    // TikTok takes a comma-separated list, unlike the space-separated OAuth
    // convention Google and LinkedIn use.
    expect(url.searchParams.get('scope')).toBe(TIKTOK_SCOPES.join(','));
    expect(url.searchParams.get('scope')?.split(',')).toContain('user.info.basic');
  });

  it('points at the callback route that is actually mounted', () => {
    expect(callbackUrl(BASE, Platform.TIKTOK)).toBe(REDIRECT);
    expect(authorize().searchParams.get('redirect_uri')).toBe(callbackUrl(BASE, Platform.TIKTOK));
  });

  // ------------------------------------------- what a dashboard pastes in

  it('strips quotes a .env-style paste leaves around the key', () => {
    process.env.TIKTOK_CLIENT_KEY = `"${CLIENT_KEY}"`;
    // Quotes survive .trim(), reach TikTok percent-encoded, and are reported as
    // an invalid client_key with no mention of a quote.
    expect(authorize().searchParams.get('client_key')).toBe(CLIENT_KEY);
    expect(authorize().toString()).not.toContain('%22');
  });

  it('strips a trailing newline and invisible characters', () => {
    process.env.TIKTOK_CLIENT_KEY = `\u200b${CLIENT_KEY}\n`;
    expect(authorize().searchParams.get('client_key')).toBe(CLIENT_KEY);
    expect(authorize().toString()).not.toContain('%0A');
  });

  it('refuses a key carrying a space or quote inside it, naming the variable only', () => {
    process.env.TIKTOK_CLIENT_KEY = 'aw1q2w3e4r 5t6y7u8i';
    let message = '';
    try {
      tiktokConfig();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TIKTOK_CLIENT_KEY/);
    // The refusal explains the shape and never echoes the value.
    expect(message).not.toContain('aw1q2w3e4r');
    expect(message).not.toContain(CLIENT_SECRET);
  });

  // --------------------------------------------------------- diagnostics

  it('describes the configuration without revealing it', () => {
    const report = tiktokConfigDiagnostics();

    expect(report.valid).toBe(true);
    expect(report.clientKeyConfigured).toBe(true);
    expect(report.clientKeyLength).toBe(CLIENT_KEY.length);
    expect(report.clientKeyCharsetValid).toBe(true);
    expect(report.clientKeyNeededCleaning).toBe(false);
    expect(report.clientKeyLooksSandbox).toBe(false);
    expect(report.redirectUriPathValid).toBe(true);

    // First three and last three, and nothing in between.
    expect(report.clientKeyRedacted).toBe('aw1…u8i');
    expect(report.clientKeyRedacted).not.toContain(CLIENT_KEY.slice(3, -3));
    expect(JSON.stringify(report)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(report)).not.toContain(CLIENT_KEY);
  });

  it('flags a sandbox key, which the live endpoint refuses', () => {
    process.env.TIKTOK_CLIENT_KEY = `sbaw${CLIENT_KEY.slice(2)}`;
    const report = tiktokConfigDiagnostics();
    expect(report.clientKeyLooksSandbox).toBe(true);
    // Still structurally valid — it is the right shape for the wrong app, which
    // is exactly why TikTok's message is so hard to act on.
    expect(report.clientKeyCharsetValid).toBe(true);
  });

  it('reports an unusual charset without refusing the connection', () => {
    // An opaque identifier is the provider's to shape. A rule tighter than the
    // format warrants would refuse a legitimate key with total confidence, so
    // this is a warning and the connection still builds.
    process.env.TIKTOK_CLIENT_KEY = 'aw1q2w3e4r5t6y7u8i.v2';
    expect(tiktokConfigDiagnostics().clientKeyCharsetValid).toBe(false);
    expect(tiktokConfigDiagnostics().valid).toBe(true);
    expect(authorize().searchParams.get('client_key')).toBe('aw1q2w3e4r5t6y7u8i.v2');
  });

  it('flags a redirect URI that does not end at the mounted callback', () => {
    process.env.TIKTOK_REDIRECT_URI = `${BASE}/api/integrations/meta/callback`;
    expect(tiktokConfigDiagnostics().redirectUriPathValid).toBe(false);
    expect(tiktokConfigDiagnostics().valid).toBe(false);
  });

  it('reports quotes as something that needed cleaning', () => {
    process.env.TIKTOK_CLIENT_KEY = `'${CLIENT_KEY}'`;
    const report = tiktokConfigDiagnostics();
    expect(report.clientKeyNeededCleaning).toBe(true);
    expect(report.clientKeyLength).toBe(CLIENT_KEY.length);
  });

  it('reads configured-ness through the same normalisation', () => {
    process.env.TIKTOK_CLIENT_KEY = '   ';
    expect(tiktokConfigured()).toBe(false);
    process.env.TIKTOK_CLIENT_KEY = CLIENT_KEY;
    expect(tiktokConfigured()).toBe(true);
  });

  it('redacts short and empty values without leaking them', () => {
    expect(redactCredential('')).toBe('unset');
    expect(redactCredential('abc123')).toBe('***');
  });
});

/** How many times a parameter appears in the query string. */
function url_query_count(url: URL, name: string): number {
  return url.searchParams.getAll(name).length;
}
