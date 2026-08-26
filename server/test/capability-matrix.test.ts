/**
 * The capability matrix.
 *
 * This is the file every Command Center surface reads before deciding what to
 * render, so the tests are mostly about the four ways a capability can be
 * absent staying distinguishable. Collapsing any two of them produces a screen
 * that either invites an operator to do something impossible, or hides
 * something they only needed to paste a credential to unlock.
 *
 * The other half is drift. The matrix derives publishing and analytics from the
 * publisher and ingestion registries rather than restating them, and these
 * tests assert that derivation against the registries themselves — so a future
 * change to either cannot leave a stale claim here.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import { Agent, agent, createTenant, resetDatabase, type Tenant } from './helpers.js';

import {
  ORGANIC_SURFACES,
  PAID_SURFACES,
  adjacentProducts,
  fullMatrix,
  matrixFor,
} from '../src/services/marketing/capability-matrix.js';
import { publisherFor } from '../src/services/publishing/registry.js';
import { metricsFetcherFor } from '../src/services/social/metrics-ingest.js';

/** A Meta configuration that passes the diagnostics' own validity rules. */
const META = {
  META_APP_ID: '1821333942563322',
  META_APP_SECRET: 'meta-secret',
  META_REDIRECT_URI: 'https://example.test/api/integrations/meta/callback',
  META_CONFIG_ID: 'login-config-1',
};

const PROVIDER_VARS = [
  ...Object.keys(META),
  'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_ADS_DEVELOPER_TOKEN',
  'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET',
];

const surface = (
  matrix: ReturnType<typeof matrixFor>,
  channel: 'organic' | 'paid',
  key: string,
) => matrix[channel].capabilities.find((capability) => capability.surface === key)!;

describe('capability matrix', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Start from nothing configured, so each test states its own world.
    for (const key of PROVIDER_VARS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of PROVIDER_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ------------------------------------------------- the four kinds of no

  it('separates a missing credential from unbuilt code', () => {
    // TikTok organic is fully built; only the credential is absent.
    const withoutCredentials = surface(matrixFor(Platform.TIKTOK), 'organic', 'PUBLISHING');
    expect(withoutCredentials.state).toBe('NOT_CONFIGURED');
    expect(withoutCredentials.requiredEnv).toContain('TIKTOK_CLIENT_KEY');

    // LinkedIn paid is not built at all, so no credential would help.
    const unbuilt = surface(matrixFor(Platform.LINKEDIN), 'paid', 'CAMPAIGNS');
    expect(unbuilt.state).toBe('NOT_IMPLEMENTED');
    expect(unbuilt.requiredEnv).toEqual([]);
  });

  it('names the exact variables rather than saying "not configured"', () => {
    // The whole value of the state is that the operator can finish the task.
    const google = surface(matrixFor(Platform.GOOGLE_BUSINESS), 'organic', 'OAUTH');
    expect(google.state).toBe('NOT_CONFIGURED');
    expect(google.requiredEnv).toEqual([
      'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
    ]);
  });

  it('reports a credential before an approval, because the approval cannot be used without it', () => {
    // Instagram needs both. Told about App Review first, an operator who has not
    // set a client secret would go and do the slower of the two tasks.
    const unconfigured = surface(matrixFor(Platform.INSTAGRAM), 'organic', 'PUBLISHING');
    expect(unconfigured.state).toBe('NOT_CONFIGURED');

    Object.assign(process.env, META);
    const configured = surface(matrixFor(Platform.INSTAGRAM), 'organic', 'PUBLISHING');
    expect(configured.state).toBe('REQUIRES_APPROVAL');
    expect(configured.approval).toMatch(/instagram_content_publish/);
    expect(configured.requiredEnv).toEqual([]);
  });

  it('reaches SUPPORTED only when built, configured and unblocked', () => {
    Object.assign(process.env, META);
    const facebook = matrixFor(Platform.FACEBOOK);

    expect(facebook.organic.state).toBe('SUPPORTED');
    for (const capability of facebook.organic.capabilities) {
      expect(capability.state).toBe('SUPPORTED');
    }
  });

  // ------------------------------------------------------- not supported

  it('does not let a registry downgrade NOT_SUPPORTED to NOT_IMPLEMENTED', () => {
    /*
     * The regression. Organic publishing is derived by looking for an entry in
     * the publisher registry, and absence there means unbuilt — but Snapchat is
     * absent because Snap exposes no organic posting API at all. Reporting that
     * as NOT_IMPLEMENTED files a permanent impossibility as a backlog item.
     */
    expect(publisherFor(Platform.SNAPCHAT)).toBeNull();

    const snapchat = matrixFor(Platform.SNAPCHAT);
    expect(surface(snapchat, 'organic', 'PUBLISHING').state).toBe('NOT_SUPPORTED');
    expect(snapchat.organic.state).toBe('NOT_SUPPORTED');
    // Nothing to show, so the channel is not offered as a tab.
    expect(snapchat.organic.available).toBe(false);
  });

  it('keeps Snapchat advertising as unbuilt rather than impossible', () => {
    // Snap's Marketing API is real; we simply have not built against it. That
    // is a different answer from organic, and must not be merged with it.
    const snapchat = matrixFor(Platform.SNAPCHAT);
    expect(snapchat.paid.state).toBe('NOT_IMPLEMENTED');
    expect(surface(snapchat, 'paid', 'CAMPAIGNS').state).toBe('NOT_IMPLEMENTED');
  });

  it('treats an advertising-only product as having no organic channel', () => {
    expect(matrixFor(Platform.GOOGLE_ADS).organic.state).toBe('NOT_SUPPORTED');
    expect(matrixFor(Platform.GOOGLE_ADS).organic.available).toBe(false);
    // And Business Profile the other way round.
    expect(matrixFor(Platform.GOOGLE_BUSINESS).paid.available).toBe(false);
  });

  // ------------------------------------------------------------- no drift

  it('reads organic publishing from the publisher registry rather than restating it', () => {
    Object.assign(process.env, META);

    for (const matrix of fullMatrix()) {
      const capability = surface(matrix, 'organic', 'PUBLISHING');
      const canPublish = publisherFor(matrix.platform)?.canPublish ?? false;

      if (capability.state === 'NOT_SUPPORTED') continue;
      // Anything other than NOT_IMPLEMENTED is a claim that the code exists,
      // and the registry is the only thing entitled to make it.
      expect(capability.state === 'NOT_IMPLEMENTED').toBe(!canPublish);
    }
  });

  it('reads organic analytics from the ingestion registry rather than restating it', () => {
    Object.assign(process.env, META);

    for (const matrix of fullMatrix()) {
      const capability = surface(matrix, 'organic', 'ANALYTICS');
      if (capability.state === 'NOT_SUPPORTED') continue;
      const hasFetcher = metricsFetcherFor(matrix.platform) !== null;
      expect(capability.state === 'NOT_IMPLEMENTED').toBe(!hasFetcher);
    }
  });

  // ------------------------------------------------------------- shape

  it('answers every surface for every platform, with none silently absent', () => {
    // A missing row reads as an oversight; an explicit NOT_IMPLEMENTED does not.
    for (const matrix of fullMatrix()) {
      expect(matrix.organic.capabilities.map((c) => c.surface)).toEqual(ORGANIC_SURFACES);
      expect(matrix.paid.capabilities.map((c) => c.surface)).toEqual(PAID_SURFACES);
      for (const capability of [...matrix.organic.capabilities, ...matrix.paid.capabilities]) {
        expect(capability.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('summarises a platform by its better channel', () => {
    Object.assign(process.env, META);
    const instagram = matrixFor(Platform.INSTAGRAM);

    // Organic needs App Review; paid does not, because it is a Meta ad set.
    expect(instagram.organic.state).toBe('REQUIRES_APPROVAL');
    expect(instagram.paid.state).toBe('SUPPORTED');
    expect(instagram.production).toBe('SUPPORTED');
  });

  it('routes Instagram advertising through Meta rather than inventing an API', () => {
    Object.assign(process.env, META);
    const paid = matrixFor(Platform.INSTAGRAM).paid;

    // Same credential group as Facebook: one connection, one ad account.
    expect(paid.state).toBe(matrixFor(Platform.FACEBOOK).paid.state);
    expect(surface(matrixFor(Platform.INSTAGRAM), 'paid', 'OAUTH').detail).toMatch(/Meta/);
  });

  it('routes YouTube advertising to Google Ads rather than reporting it unbuilt', () => {
    // "Not implemented" would imply a YouTube Ads API we have not written
    // against. There is no such API; the campaign type lives in Google Ads.
    const capability = surface(matrixFor(Platform.YOUTUBE), 'paid', 'OAUTH');
    expect(capability.state).toBe('NOT_SUPPORTED');
    expect(capability.detail).toMatch(/Google Ads/);
  });

  // ------------------------------------------------------------- secrets

  it('never puts a credential value in the payload', () => {
    Object.assign(process.env, META);
    process.env.TIKTOK_CLIENT_KEY = 'tiktok-key-value';
    process.env.TIKTOK_CLIENT_SECRET = 'tiktok-secret-value';
    process.env.TIKTOK_REDIRECT_URI = 'https://example.test/api/integrations/tiktok/callback';

    const payload = JSON.stringify({ platforms: fullMatrix(), adjacent: adjacentProducts() });

    for (const value of ['tiktok-key-value', 'tiktok-secret-value', META.META_APP_SECRET]) {
      expect(payload).not.toContain(value);
    }
  });

  it('names variables only while they are the thing standing in the way', () => {
    // Unconfigured: the name is the actionable part of the answer.
    const unconfigured = JSON.stringify(fullMatrix());
    expect(unconfigured).toContain('TIKTOK_CLIENT_KEY');

    // Configured: there is nothing to ask for, so nothing is listed. A screen
    // that kept showing the variable would read as a warning about a setting
    // that is already correct.
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
    process.env.TIKTOK_REDIRECT_URI = 'https://example.test/api/integrations/tiktok/callback';

    const configured = matrixFor(Platform.TIKTOK);
    expect(surface(configured, 'organic', 'OAUTH').requiredEnv).toEqual([]);
  });

  // ------------------------------------------------------------ adjacent

  it('names the Google products that are not connected, and the one that cannot be', () => {
    const products = adjacentProducts();
    const byKey = Object.fromEntries(products.map((product) => [product.key, product]));

    expect(byKey.SEARCH_CONSOLE!.state).toBe('NOT_IMPLEMENTED');
    expect(byKey.GA4!.state).toBe('NOT_IMPLEMENTED');
    // Local rank tracking has no API at all — a permanent answer, not a backlog.
    expect(byKey.LOCAL_RANK_TRACKING!.state).toBe('NOT_SUPPORTED');
  });
});

/**
 * The endpoint, over HTTP.
 *
 * Separate from the matrix tests above because the thing being checked is the
 * mounting, not the logic: the router is authenticated by its own `use` call
 * rather than by anything global, and the first version of this file omitted
 * that line and served the whole matrix — including this deployment's variable
 * names and a list of which integrations are unconfigured — to anyone who
 * asked.
 */
describe('marketing capabilities endpoint', () => {
  let alpha: Tenant;
  let admin: Agent;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('capabilities');
    admin = agent();
    await admin.login(alpha.adminEmail);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await agent().get('/api/marketing/capabilities');
    expect(response.status).toBe(401);
  });

  it('answers a signed-in operator with every platform and no secret values', async () => {
    process.env.TIKTOK_CLIENT_SECRET = 'a-real-looking-secret';

    const response = await admin.get('/api/marketing/capabilities');

    expect(response.status).toBe(200);
    expect(response.body.platforms.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain('a-real-looking-secret');

    for (const platform of response.body.platforms) {
      expect(platform.organic).toBeTruthy();
      expect(platform.paid).toBeTruthy();
    }

    delete process.env.TIKTOK_CLIENT_SECRET;
  });
});
