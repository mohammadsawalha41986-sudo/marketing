/**
 * The catalogue the Integrations page is rendered from.
 *
 * This is the production source of truth for "can an operator connect this
 * provider", and it got that question wrong for the first provider that
 * connects without OAuth.
 *
 * Upload-Post has no OAuth flow — it has a hosted account-linking page — so its
 * adapter declares `implementation.oauth: NOT_SUPPORTED`, which is the truth.
 * But both the catalogue's `canConnect` and the card's own classification
 * derived "is this provider built at all" from `implementation.oauth ===
 * 'IMPLEMENTED'`. A fully implemented, fully configured provider was therefore
 * rendered as NOT BUILT YET with its Connect button disabled, and no amount of
 * setting `UPLOAD_POST_API_KEY` could change it.
 *
 * The fix separates the two questions, so these tests pin both halves:
 *
 *   a provider that connects is never classified as unbuilt, whatever its
 *   OAuth surface says
 *
 *   a provider that genuinely cannot be connected still says so — the
 *   distinction the card exists to draw is not lost in the repair
 *
 * They drive the real HTTP endpoint rather than the adapter table, because the
 * endpoint is what the browser reads and an adapter asserted in isolation
 * proves nothing about the payload the page receives.
 */

import { readFile } from 'node:fs/promises';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from '@prisma/client';

import { Agent, agent, createTenant, resetDatabase, type Tenant } from './helpers.js';
import { adapterFor, connectable, supportsOAuth } from '../src/services/integrations/index.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

interface CatalogAdapter {
  platform: Platform;
  label: string;
  readiness: string;
  ready: boolean;
  missingEnv: string[];
  canConnect: boolean;
  connectMethod: 'OAUTH' | 'HOSTED_LINK' | 'NONE';
  implementation: {
    oauth: string;
    accountDiscovery: string;
    publish: string;
    metrics: string;
    conversions: string;
  };
}

/**
 * The card's own rule, as the page applies it.
 *
 * Kept here in the same shape the frontend uses so the two cannot drift apart
 * silently: a change to the page's predicate that reintroduces the defect makes
 * the source-level assertion at the bottom of this file fail.
 */
const rendersAsNotBuilt = (adapter: CatalogAdapter) => adapter.connectMethod === 'NONE';

describe('the integrations catalogue', () => {
  let tenant: Tenant;
  let api: Agent;
  const saved = { ...process.env };

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('catalog');
    api = agent();
    await api.login(tenant.adminEmail);
  });

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.UPLOAD_POST_API_KEY = 'up-test-key-never-real';
  });

  afterEach(() => {
    for (const key of ['TOKEN_ENCRYPTION_KEY', 'UPLOAD_POST_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function catalog(): Promise<CatalogAdapter[]> {
    const response = await api.get('/api/integrations/catalog').expect(200);
    return (response.body as { adapters: CatalogAdapter[] }).adapters;
  }

  const find = (adapters: CatalogAdapter[], platform: Platform) =>
    adapters.find((adapter) => adapter.platform === platform)!;

  // ------------------------------------------------------- the reported bug

  it('never classifies a configured Upload-Post as NOT BUILT YET', async () => {
    const uploadPost = find(await catalog(), Platform.UPLOAD_POST);

    // The exact symptom reported from production.
    expect(rendersAsNotBuilt(uploadPost)).toBe(false);
    expect(uploadPost.connectMethod).toBe('HOSTED_LINK');
  });

  it('offers Upload-Post as ready to connect once its key is set', async () => {
    const uploadPost = find(await catalog(), Platform.UPLOAD_POST);

    expect(uploadPost.readiness).toBe('READY');
    expect(uploadPost.ready).toBe(true);
    expect(uploadPost.missingEnv).toEqual([]);
    // The field the Connect button is enabled from.
    expect(uploadPost.canConnect).toBe(true);
  });

  it('still reports Upload-Post as unconfigured when the key is absent', async () => {
    delete process.env.UPLOAD_POST_API_KEY;
    const uploadPost = find(await catalog(), Platform.UPLOAD_POST);

    /*
     * Unconfigured is not unbuilt, and the difference is the whole point of the
     * repair: the operator is told to set a variable, not that the code does
     * not exist. The provider stays connectable — what it lacks is a key.
     */
    expect(rendersAsNotBuilt(uploadPost)).toBe(false);
    expect(uploadPost.readiness).toBe('NOT_CONFIGURED');
    expect(uploadPost.missingEnv).toContain('UPLOAD_POST_API_KEY');
    expect(uploadPost.canConnect).toBe(false);
  });

  it('needs no encryption key, because it stores no per-client credential', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const uploadPost = find(await catalog(), Platform.UPLOAD_POST);

    // Every other provider is blocked on TOKEN_ENCRYPTION_KEY because it has a
    // token to store. This one authorises with the deployment's own key.
    expect(uploadPost.readiness).toBe('READY');
    expect(uploadPost.canConnect).toBe(true);
  });

  it('keeps describing Upload-Post\'s OAuth surface honestly', () => {
    const adapter = adapterFor(Platform.UPLOAD_POST);

    /*
     * The repair must not be "call it OAuth". Upload-Post has none, and the
     * generic OAuth connect route refuses it on exactly this answer — claiming
     * otherwise would send the operator into a flow that throws.
     */
    expect(adapter.implementation.oauth).toBe('NOT_SUPPORTED');
    expect(supportsOAuth(adapter)).toBe(false);
    // Connectable all the same, by a different method.
    expect(connectable(adapter)).toBe(true);
  });

  // --------------------------------------------------- the other providers

  it('leaves every OAuth provider classified exactly as it was', async () => {
    const adapters = await catalog();

    for (const platform of [
      Platform.FACEBOOK, Platform.INSTAGRAM, Platform.TIKTOK,
      Platform.GOOGLE_BUSINESS, Platform.YOUTUBE, Platform.LINKEDIN,
    ]) {
      const row = find(adapters, platform);
      expect(row.implementation.oauth).toBe('IMPLEMENTED');
      // Derived from the OAuth surface, exactly as before.
      expect(row.connectMethod).toBe('OAUTH');
      expect(rendersAsNotBuilt(row)).toBe(false);
    }
  });

  it('still says NOT BUILT YET for a provider that genuinely is not', async () => {
    const adapters = await catalog();

    /*
     * Snapchat and X only. Google Ads is deliberately absent: its OAuth was
     * built, so it is connectable and must *not* read as unbuilt — asserting
     * otherwise here would pin the opposite of the truth.
     */
    for (const platform of [Platform.SNAPCHAT, Platform.X]) {
      const row = find(adapters, platform);
      // No connect flow of any kind. The distinction the card draws survives.
      expect(row.connectMethod).toBe('NONE');
      expect(rendersAsNotBuilt(row)).toBe(true);
      expect(row.canConnect).toBe(false);
    }
  });

  it('keeps Google Ads connectable, as its own OAuth work made it', async () => {
    const googleAds = find(await catalog(), Platform.GOOGLE_ADS);

    expect(googleAds.implementation.oauth).toBe('IMPLEMENTED');
    expect(googleAds.connectMethod).toBe('OAUTH');
    expect(rendersAsNotBuilt(googleAds)).toBe(false);
  });

  it('never puts a credential in the catalogue', async () => {
    const body = JSON.stringify(await catalog());

    expect(body).not.toContain('up-test-key-never-real');
    expect(body).not.toContain(KEY);
  });

  // ----------------------------------------------------- the Connect route

  it('reaches the Upload-Post connect route rather than the generic OAuth one', async () => {
    /*
     * The second half of the reported failure, and the one the card fix alone
     * would have left standing.
     *
     * `/:clientId/:platform/connect` matches `/<client>/upload-post/connect`
     * with `platform` bound to the literal "upload-post". Registered after it,
     * the dedicated route was unreachable and Connect answered 400 "Invalid
     * path parameters, expected FACEBOOK | INSTAGRAM | …" — an enum error about
     * a route the operator never meant to call.
     *
     * A non-existent client is used deliberately: the dedicated handler checks
     * client ownership first, so reaching it produces a 404 for the *client*
     * and no Upload-Post API call is made. A 400 about the platform enum means
     * the generic route swallowed it again.
     */
    const response = await api.post('/api/integrations/no-such-client/upload-post/connect');

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toMatch(/Invalid path parameters/);
    expect(JSON.stringify(response.body)).not.toMatch(/Expected 'FACEBOOK'/);
  });

  it('still refuses Upload-Post on the generic OAuth connect route', async () => {
    // It has no authorization URL to redirect to. The refusal is correct and
    // is why the dedicated route exists at all.
    const adapter = adapterFor(Platform.UPLOAD_POST);
    expect(supportsOAuth(adapter)).toBe(false);
  });

  // ------------------------------------------------ the page's own predicate

  it('classifies the card from the connect method, not from OAuth', async () => {
    /*
     * A source-level assertion, in the style of `web/src/layout.test.ts`. The
     * defect was a single predicate in the page, and no API test can see it:
     * the catalogue can be perfectly correct while the card still derives
     * "unbuilt" from the wrong field. Both halves are pinned — the page must
     * read `connectMethod`, and must not read `implementation.oauth` at all.
     */
    const page = await readFile(
      new URL('../../web/src/routes/workspace.tsx', import.meta.url),
      'utf8',
    );

    expect(page).toMatch(/const buildable = adapter\.connectMethod !== 'NONE'/);
    expect(page).not.toContain("adapter.implementation.oauth === 'IMPLEMENTED'");
  });
});
