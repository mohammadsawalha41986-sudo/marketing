/**
 * The connection lifecycle: authorize → callback → select → sync.
 *
 * This is the part that makes "Connect" a real button rather than a status
 * label. The orchestration lives here, apart from the HTTP layer, so the whole
 * chain can be driven in tests with an injected `fetchImpl` — the same code
 * path production uses, with the provider's own JSON standing in for the
 * network. An adapter that has only ever been read is not an adapter that works.
 *
 * Two invariants run through every function:
 *
 *   Nothing is CONNECTED until the provider says so. A token that exchanged
 *   successfully is not a connection; the account is validated with a real API
 *   call first, and a failure leaves the row in ERROR with the reason.
 *
 *   Nothing is attached without the operator choosing it. Discovery writes
 *   every asset it finds as `selected: false`. Auto-attaching everything an
 *   access token can see is precisely how one brand's ad account ends up
 *   wired into another client.
 */

import {
  AccountTokenStatus, ExternalAccountKind, IntegrationStatus, Platform, Prisma, SyncStatus,
} from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { encryptSecret, secretFingerprint } from '../../lib/crypto.js';
import { consumeState, issueState } from './oauth-state.js';
import {
  authorizationUrl,
  discoverAccounts,
  exchangeCode,
  metaConfig,
  validateToken,
  type DiscoveredAccount,
  type FetchLike,
} from './meta.js';

/** Where each provider's callback lands. Documented so app consoles match. */
export function callbackPath(platform: Platform): string {
  const slug: Partial<Record<Platform, string>> = {
    FACEBOOK: 'meta',
    INSTAGRAM: 'meta',
    GOOGLE_ADS: 'google',
    GOOGLE_BUSINESS: 'google',
    TIKTOK: 'tiktok',
    SNAPCHAT: 'snapchat',
    LINKEDIN: 'linkedin',
    X: 'x',
  };
  return `/api/integrations/${slug[platform] ?? platform.toLowerCase()}/callback`;
}

export function callbackUrl(baseUrl: string, platform: Platform): string {
  return `${baseUrl.replace(/\/+$/, '')}${callbackPath(platform)}`;
}

// ---------------------------------------------------------------- authorize

export interface AuthorizeResult {
  redirectTo: string;
  integrationId: string;
}

/**
 * Start OAuth: mint a bound state, park the integration in CONNECTING, and hand
 * back the provider's real authorization URL.
 */
export async function beginAuthorization(input: {
  organizationId: string;
  clientId: string;
  platform: Platform;
  baseUrl: string;
}): Promise<AuthorizeResult> {
  /*
   * Meta is the authority on this value, not us.
   *
   * `redirect_uri` must be byte-identical in the authorize call and in the code
   * exchange, and it must match one registered in the app console — so
   * META_REDIRECT_URI wins, and the URI derived from the request host is only a
   * fallback for a deployment that has not set it. Deriving it and then
   * exchanging with a different one is the classic "the code is invalid" loop.
   */
  const config = metaConfig();
  const redirectUri = config.redirectUri || callbackUrl(input.baseUrl, input.platform);

  /*
   * And it has to point back at a route that exists. A console entry aimed at
   * anything other than the mounted callback path sends the operator's browser
   * somewhere with the authorization code in the query string and no handler to
   * consume it — which looks like "Meta did nothing" from the outside.
   */
  const expected = callbackPath(input.platform);
  if (!new URL(redirectUri).pathname.endsWith(expected)) {
    throw new Error(
      `META_REDIRECT_URI must end with ${expected} so the authorization lands on the callback route. ` +
        `It currently points at ${new URL(redirectUri).pathname}.`,
    );
  }

  const integration = await prisma.integration.upsert({
    where: { clientId_platform: { clientId: input.clientId, platform: input.platform } },
    create: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      platform: input.platform,
      status: IntegrationStatus.CONNECTING,
    },
    // A retry must clear the previous failure rather than leaving a stale error
    // sitting under a flow that is now in progress.
    update: { status: IntegrationStatus.CONNECTING, lastError: null },
    select: { id: true },
  });

  const { state } = await issueState({
    organizationId: input.organizationId,
    clientId: input.clientId,
    platform: input.platform,
    redirectUri,
    metadata: { integrationId: integration.id },
  });

  // Only Meta has a real authorization URL builder so far; the rest report the
  // configuration they need rather than pretending to have a URL.
  return { redirectTo: authorizationUrl({ config, state }), integrationId: integration.id };
}

// ---------------------------------------------------------------- callback

export interface CallbackResult {
  integrationId: string;
  clientId: string;
  platform: Platform;
  accountName: string;
  discovered: DiscoveredAccount[];
}

const KIND: Record<DiscoveredAccount['kind'], ExternalAccountKind> = {
  BUSINESS: ExternalAccountKind.BUSINESS,
  PAGE: ExternalAccountKind.PAGE,
  INSTAGRAM: ExternalAccountKind.INSTAGRAM,
  AD_ACCOUNT: ExternalAccountKind.AD_ACCOUNT,
};

/**
 * Handle the provider's redirect back.
 *
 * State first, then code exchange, then a live validation call, then discovery.
 * The order matters: every step that could attach a stranger's account to this
 * client happens after the state has proved which client and provider the flow
 * belongs to.
 */
export async function completeCallback(input: {
  platform: Platform;
  state: string;
  code: string;
  fetchImpl: FetchLike;
}): Promise<CallbackResult> {
  const consumed = await consumeState({ state: input.state, platform: input.platform });

  const integration = await prisma.integration.findFirst({
    where: { clientId: consumed.clientId, platform: consumed.platform },
    select: { id: true },
  });
  if (!integration) throw new Error('The integration this authorization belongs to no longer exists');

  try {
    const config = metaConfig();
    const tokens = await exchangeCode({ config, code: input.code, fetchImpl: input.fetchImpl });

    // The connection is only real if the provider answers with this token.
    const identity = await validateToken({ accessToken: tokens.accessToken, fetchImpl: input.fetchImpl });
    const discovered = await discoverAccounts({ accessToken: tokens.accessToken, fetchImpl: input.fetchImpl });

    await prisma.$transaction(async (tx) => {
      await tx.integration.update({
        where: { id: integration.id },
        data: {
          // Not CONNECTED yet: nothing has been chosen. Connection completes
          // when the operator selects the assets to attach.
          status: IntegrationStatus.CONNECTING,
          accountName: identity.name,
          accountId: identity.id,
          scopes: tokens.scopes,
          accessTokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          tokenExpiresAt: tokens.expiresAt,
          tokenFingerprint: secretFingerprint(tokens.accessToken),
          lastError: null,
        },
      });

      for (const account of discovered) {
        /*
         * The Page's own publishing credential, encrypted before it is stored.
         *
         * A Page that came back without one cannot publish — the granted
         * permissions did not extend to managing it — and is recorded as
         * REAUTH_REQUIRED rather than left to fail at the moment of publication.
         * The plaintext exists only inside this loop.
         */
        const pageToken = account.accessToken?.trim();
        const tokenFields = pageToken
          ? {
              accessTokenEnc: encryptSecret(pageToken),
              // Discovery proved the user token works, not this one. It is
              // verified against the provider before the first publish.
              tokenStatus: AccountTokenStatus.UNKNOWN,
            }
          : {
              accessTokenEnc: null,
              tokenStatus: AccountTokenStatus.REAUTH_REQUIRED,
            };

        // Upsert on (integration, kind, externalId): re-running discovery after
        // a reconnect refreshes names and never duplicates rows.
        await tx.integrationAccount.upsert({
          where: {
            integrationId_kind_externalId: {
              integrationId: integration.id,
              kind: KIND[account.kind],
              externalId: account.externalId,
            },
          },
          create: {
            integrationId: integration.id,
            clientId: consumed.clientId,
            kind: KIND[account.kind],
            externalId: account.externalId,
            name: account.name,
            username: account.username ?? null,
            currency: account.currency ?? null,
            timezone: account.timezone ?? null,
            parentExternalId: account.parentExternalId ?? null,
            metadata: (account.metadata ?? {}) as Prisma.InputJsonValue,
            ...tokenFields,
          },
          // `selected` is deliberately not updated: a reconnect must not silently
          // re-attach something the operator previously removed.
          update: {
            name: account.name,
            username: account.username ?? null,
            currency: account.currency ?? null,
            timezone: account.timezone ?? null,
            // A reconnect is how a REAUTH_REQUIRED account gets its token, so
            // this must overwrite — including back to null if the permission was
            // withdrawn, which is a downgrade the operator needs to see.
            ...tokenFields,
          },
        });
      }
    });

    return {
      integrationId: integration.id,
      clientId: consumed.clientId,
      platform: consumed.platform,
      accountName: identity.name,
      discovered,
    };
  } catch (error) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: IntegrationStatus.ERROR,
        // Adapter errors carry provider messages, never tokens or codes.
        lastError: (error as Error).message.slice(0, 500),
        /*
         * Clear the stored credential rather than leaving the previous one in
         * place. A re-authorization that failed validation means the old token
         * can no longer be trusted, and keeping it would let every later sync
         * quietly go on using a credential the provider has already rejected —
         * the failure would then surface as mysteriously empty data instead of
         * a connection that needs attention.
         */
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        tokenFingerprint: null,
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------- selection

/**
 * Attach the assets the operator chose, and only then mark the connection live.
 *
 * Selecting nothing is a valid instruction — it means "detach everything" — and
 * it returns the integration to DISCONNECTED rather than leaving it CONNECTED
 * with nothing behind it.
 */
export async function selectAccounts(input: {
  integrationId: string;
  organizationId: string;
  accountIds: string[];
}): Promise<{ status: IntegrationStatus; selected: number }> {
  const integration = await prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId },
    select: { id: true, accounts: { select: { id: true } } },
  });
  if (!integration) throw new Error('Integration not found');

  const owned = new Set(integration.accounts.map((account) => account.id));
  // Ids the caller supplied that do not belong to this integration are dropped
  // rather than trusted — the request body is not an authorisation.
  const chosen = input.accountIds.filter((id) => owned.has(id));

  await prisma.$transaction([
    prisma.integrationAccount.updateMany({ where: { integrationId: integration.id }, data: { selected: false } }),
    ...(chosen.length > 0
      ? [prisma.integrationAccount.updateMany({ where: { id: { in: chosen } }, data: { selected: true } })]
      : []),
  ]);

  const status = chosen.length > 0 ? IntegrationStatus.CONNECTED : IntegrationStatus.DISCONNECTED;
  await prisma.integration.update({ where: { id: integration.id }, data: { status } });

  return { status, selected: chosen.length };
}

// ---------------------------------------------------------------- sync

export interface SyncOutcome {
  runId: string;
  status: SyncStatus;
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  errorMessage: string | null;
}

/**
 * Record a synchronisation run around whatever work the caller performs.
 *
 * The run row is written before the work starts and closed after, so a sync
 * that crashes leaves a FAILED run rather than no evidence at all — "it never
 * ran" and "it ran and died" need to be distinguishable afterwards.
 */
export async function runSync(
  input: { integrationId: string; organizationId: string; clientId: string; platform: Platform },
  work: () => Promise<{ processed: number; created: number; updated: number }>,
): Promise<SyncOutcome> {
  const run = await prisma.integrationSyncRun.create({
    data: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      integrationId: input.integrationId,
      platform: input.platform,
      status: SyncStatus.RUNNING,
    },
    select: { id: true },
  });

  try {
    const result = await work();

    await prisma.$transaction([
      prisma.integrationSyncRun.update({
        where: { id: run.id },
        data: {
          status: SyncStatus.SUCCESS,
          completedAt: new Date(),
          recordsProcessed: result.processed,
          recordsCreated: result.created,
          recordsUpdated: result.updated,
        },
      }),
      prisma.integration.update({ where: { id: input.integrationId }, data: { lastSyncAt: new Date(), lastError: null } }),
    ]);

    return {
      runId: run.id,
      status: SyncStatus.SUCCESS,
      recordsProcessed: result.processed,
      recordsCreated: result.created,
      recordsUpdated: result.updated,
      errorMessage: null,
    };
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);

    await prisma.$transaction([
      prisma.integrationSyncRun.update({
        where: { id: run.id },
        data: { status: SyncStatus.FAILED, completedAt: new Date(), errorMessage: message },
      }),
      prisma.integration.update({ where: { id: input.integrationId }, data: { lastError: message } }),
    ]);

    return {
      runId: run.id,
      status: SyncStatus.FAILED,
      recordsProcessed: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      errorMessage: message,
    };
  }
}
