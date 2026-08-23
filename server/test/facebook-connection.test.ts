/**
 * Connecting a Facebook Page, end to end, and what "connected" is allowed to mean.
 *
 * The Graph responses here are fakes with the shapes Meta really returns —
 * `/me/permissions` rows carrying granted/declined, `/me/accounts` entries
 * carrying a per-Page `access_token`. They prove the connection flow does the
 * right thing with each answer. They do not prove Meta gives that answer; only
 * a real round trip does, and `docs/PRODUCTION_VERIFICATION.md` is where that
 * gets recorded.
 *
 * The assertion the file is built around: CONNECTED must mean "this can
 * publish". A Page selected without a usable token, or with a token the app
 * lacks permission to use, is a connection that will fail at the first post —
 * and saying so at selection time is the difference between a fixable setup
 * problem and a mysterious failure at 7pm on a Saturday.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountTokenStatus, IntegrationStatus, Platform } from '@prisma/client';

import { agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import {
  callbackUrl, completeCallback, beginAuthorization, selectAccounts,
} from '../src/services/integrations/connect-flow.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { testPublish } from '../src/services/publishing/service.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';
const BASE = 'https://marketing-osserver-production.up.railway.app';

/** The PawEase Page, with the real id the operator verified against Graph. */
const PAGE_ID = '1220219831177035';
const PAGE_TOKEN = 'page-token-that-must-never-leak';

function metaFetch(options: {
  permissions?: string[];
  pageToken?: string | null;
  publish?: { body: unknown; status?: number };
} = {}): FetchLike {
  const permissions = options.permissions ?? [
    'pages_show_list', 'pages_manage_posts', 'pages_read_engagement',
  ];
  const pageToken = options.pageToken === undefined ? PAGE_TOKEN : options.pageToken;

  return (async (url: string) => {
    const reply = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });

    // Order matters: '/me/permissions' also contains '/me'.
    if (url.includes('/me/permissions')) {
      return reply({ data: permissions.map((permission) => ({ permission, status: 'granted' })) });
    }
    if (url.includes('fb_exchange_token')) return reply({ access_token: 'LONG-USER-TOKEN', expires_in: 5_184_000 });
    if (url.includes('oauth/access_token')) return reply({ access_token: 'SHORT-USER-TOKEN', expires_in: 3600 });
    if (url.includes('/me/accounts')) {
      return reply({
        data: [{
          id: PAGE_ID,
          name: 'PawEase',
          username: 'pawease',
          ...(pageToken ? { access_token: pageToken } : {}),
        }],
      });
    }
    if (url.includes('/me/adaccounts')) return reply({ data: [] });
    if (url.includes('/me/businesses')) return reply({ data: [] });
    if (url.includes('/me')) return reply({ id: 'user-1', name: 'PawEase Operator' });
    if (url.includes('/feed')) {
      return options.publish
        ? reply(options.publish.body, options.publish.status ?? 200)
        : reply({ id: `${PAGE_ID}_900900900` });
    }

    throw new Error(`No stub for ${url}`);
  }) as FetchLike;
}

describe('connecting a Facebook Page', () => {
  let tenant: Tenant;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('fb-connect');
  });

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    process.env.META_APP_ID = '1821333942563322';
    process.env.META_APP_SECRET = 'app-secret';
    process.env.META_REDIRECT_URI = callbackUrl(BASE, Platform.FACEBOOK);
    process.env.META_CONFIG_ID = '1063587136062050';

    await prisma.integrationAccount.deleteMany({ where: { clientId: tenant.clientId } });
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });
  });

  /** Walks the flow to the point where a Page is discovered but not chosen. */
  const connectThrough = async (fetchImpl: FetchLike) => {
    const started = await beginAuthorization({
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      platform: Platform.FACEBOOK,
      baseUrl: BASE,
    });
    const state = new URL(started.redirectTo).searchParams.get('state') as string;
    return completeCallback({ platform: Platform.FACEBOOK, state, code: 'auth-code', fetchImpl });
  };

  // ------------------------------------------------------------ 1. initiation

  it('starts the authorization against the existing Login for Business configuration', async () => {
    const started = await beginAuthorization({
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      platform: Platform.FACEBOOK,
      baseUrl: BASE,
    });

    const url = new URL(started.redirectTo);
    expect(url.origin).toBe('https://www.facebook.com');
    // config_id is what runs Business Login and its asset-selection step. The
    // value comes from the environment; nothing here hardcodes a configuration.
    expect(url.searchParams.get('config_id')).toBe('1063587136062050');
    expect(url.searchParams.get('client_id')).toBe('1821333942563322');
    // Business Login takes permissions from the configuration; sending a scope
    // list is what makes the dialog fall back to classic consumer login.
    expect(url.searchParams.get('scope')).toBeNull();
  });

  // ------------------------------------------------- 2-5. callback and Pages

  it('completes the callback and discovers the Page', async () => {
    const result = await connectThrough(metaFetch());

    expect(result.discovered.some((account) => account.externalId === PAGE_ID)).toBe(true);

    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });
    expect(page.name).toBe('PawEase');
    expect(page.kind).toBe('PAGE');
    // Discovery attaches nothing on its own.
    expect(page.selected).toBe(false);
  });

  it('stores the Page access token encrypted, and only the token', async () => {
    await connectThrough(metaFetch());

    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });

    expect(page.accessTokenEnc).toBeTruthy();
    // Encrypted at rest: the stored value is not the token.
    expect(page.accessTokenEnc).not.toBe(PAGE_TOKEN);
    expect(page.accessTokenEnc).not.toContain(PAGE_TOKEN);
    // And it is the *Page* token that came back, not the user token.
    expect(decryptSecret(page.accessTokenEnc as string)).toBe(PAGE_TOKEN);
  });

  it('records the permissions Meta granted, not the ones we asked for', async () => {
    await connectThrough(metaFetch({ permissions: ['pages_show_list', 'pages_manage_posts'] }));

    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });

    expect(page.grantedScopes).toContain('pages_manage_posts');
    // Requested but declined, so it must not appear.
    expect(page.grantedScopes).not.toContain('instagram_content_publish');
  });

  // --------------------------------------------------- 6. connection storage

  it('reaches CONNECTED when the chosen Page can actually publish', async () => {
    const result = await connectThrough(metaFetch());
    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });

    const selection = await selectAccounts({
      integrationId: result.integrationId,
      organizationId: tenant.organizationId,
      accountIds: [page.id],
    });

    expect(selection.status).toBe(IntegrationStatus.CONNECTED);
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.lastError).toBeNull();
  });

  it('refuses to call a Page connected when no token arrived', async () => {
    // Meta returned the Page but no access_token: the login did not cover it.
    const result = await connectThrough(metaFetch({ pageToken: null }));
    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });

    expect(page.tokenStatus).toBe(AccountTokenStatus.REAUTH_REQUIRED);

    const selection = await selectAccounts({
      integrationId: result.integrationId,
      organizationId: tenant.organizationId,
      accountIds: [page.id],
    });

    // The bug this guards: a green CONNECTED badge over a connection whose
    // first publish is guaranteed to fail.
    expect(selection.status).toBe(IntegrationStatus.ERROR);
    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    expect(integration.lastError).toMatch(/no usable publishing token/i);
  });

  it('names a missing publishing permission instead of failing later', async () => {
    // A token, but the app was never granted pages_manage_posts.
    const result = await connectThrough(metaFetch({ permissions: ['pages_show_list', 'pages_read_engagement'] }));
    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });

    expect(page.tokenStatus).toBe(AccountTokenStatus.MISSING_PERMISSION);

    await selectAccounts({
      integrationId: result.integrationId,
      organizationId: tenant.organizationId,
      accountIds: [page.id],
    });

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: result.integrationId } });
    // Reconnecting cannot fix this; App Review can. The message must not send
    // the operator round the OAuth loop again.
    expect(integration.lastError).toMatch(/pages_manage_posts/);
  });

  // ---------------------------------------------------- 7. the token is safe

  it('never exposes the Page token through the accounts API', async () => {
    const result = await connectThrough(metaFetch());
    const client = agent();
    await client.login(tenant.adminEmail);

    const response = await client.get(`/api/integrations/${result.integrationId}/accounts`);

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(PAGE_TOKEN);
    expect(serialized).not.toContain('accessTokenEnc');
    // The safe metadata the frontend is entitled to.
    const page = response.body.integration.accounts.find(
      (row: { externalId: string }) => row.externalId === PAGE_ID,
    );
    expect(page.name).toBe('PawEase');
    expect(page.tokenStatus).toBeTruthy();
  });

  // --------------------------------------------------------- 8. test publish

  it('publishes a test post to the Page and returns the provider id', async () => {
    const result = await connectThrough(metaFetch());
    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });
    await selectAccounts({
      integrationId: result.integrationId,
      organizationId: tenant.organizationId,
      accountIds: [page.id],
    });

    /*
     * Through the service rather than the route: the route supplies the real
     * fetch, which is the point of it, and there is no Facebook to reach here.
     * The route's own guards are covered by the two tests below.
     */
    const published = await testPublish({
      prisma,
      accountId: page.id,
      message: 'Marketing OS test post',
      platform: Platform.FACEBOOK,
      fetchImpl: metaFetch(),
    });

    expect(published.published).toBe(true);
    if (!published.published) throw new Error('unreachable');
    // The provider's id, not one we made up.
    expect(published.externalPostId).toBe(`${PAGE_ID}_900900900`);
    expect(published.permalink).toContain(PAGE_ID);
    // And the token is nowhere in the answer.
    expect(JSON.stringify(published)).not.toContain(PAGE_TOKEN);

    // A successful call is proof the credential works.
    const after = await prisma.integrationAccount.findUniqueOrThrow({ where: { id: page.id } });
    expect(after.tokenStatus).toBe(AccountTokenStatus.TOKEN_VALID);
  });

  it('surfaces the provider\'s real reason when a test publish fails', async () => {
    const result = await connectThrough(
      metaFetch({
        publish: {
          body: {
            error: {
              message: 'If posting to a page, requires pages_manage_posts',
              type: 'OAuthException',
              code: 200,
            },
          },
          status: 403,
        },
      }),
    );
    const page = await prisma.integrationAccount.findFirstOrThrow({
      where: { clientId: tenant.clientId, externalId: PAGE_ID },
    });
    await selectAccounts({
      integrationId: result.integrationId,
      organizationId: tenant.organizationId,
      accountIds: [page.id],
    });

    const failed = await testPublish({
      prisma,
      accountId: page.id,
      message: 'Marketing OS test post',
      platform: Platform.FACEBOOK,
      fetchImpl: metaFetch({
        publish: {
          body: {
            error: {
              message: 'If posting to a page, requires pages_manage_posts',
              type: 'OAuthException',
              code: 200,
            },
          },
          status: 403,
        },
      }),
    });

    expect(failed.published).toBe(false);
    if (failed.published) throw new Error('unreachable');
    expect(failed.code).toBe('MISSING_PERMISSION');
    expect(failed.message).toMatch(/pages_manage_posts/);
  });

  it('refuses a test publish when no Page is attached', async () => {
    const result = await connectThrough(metaFetch());
    const client = agent();
    await client.login(tenant.adminEmail);

    const response = await client.post(`/api/integrations/${result.integrationId}/test-publish`, {
      message: 'Nowhere to go',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/no page is attached/i);
  });

  it('cannot test-publish through another tenant\'s connection', async () => {
    const result = await connectThrough(metaFetch());
    const other = await createTenant('fb-connect-intruder');

    const intruder = agent();
    await intruder.login(other.adminEmail);
    const response = await intruder.post(`/api/integrations/${result.integrationId}/test-publish`, {
      message: 'Not yours',
    });

    expect(response.status).toBe(404);
  });
});
