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
  AccountTokenStatus, IntegrationStatus, Platform, Prisma, SyncStatus,
} from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { encryptSecret, secretFingerprint } from '../../lib/crypto.js';
import { consumeState, issueState } from './oauth-state.js';
import {
  PAGE_PUBLISH_PERMISSION,
  authorizationUrl,
  discoverAccounts,
  exchangeCode,
  grantedPermissions,
  metaConfig,
  validateToken,
  type DiscoveredAccount,
  type DiscoveryResult,
  type FetchLike,
  type TokenSet,
} from './meta.js';
import * as instagram from './instagram.js';
import * as tiktok from './tiktok.js';
import * as google from './google.js';
import * as googleAds from './google-ads.js';
import * as youtube from './youtube.js';
import * as linkedin from './linkedin.js';
import { discoveryNote, missingGrantNote, noUsableCredentialNote } from './connection-notes.js';
import { KIND_FOR_DISCOVERY } from './account-kinds.js';

/** Where each provider's callback lands. Documented so app consoles match. */
export function callbackPath(platform: Platform): string {
  const slug: Partial<Record<Platform, string>> = {
    FACEBOOK: 'meta',
    /*
     * Instagram authorises through Instagram Login — its own app product, its
     * own token host — so it lands on its own route. Sharing Meta's would mean
     * a state minted for one provider being redeemed on the other's callback,
     * which is the binding check, deleted.
     */
    INSTAGRAM: 'instagram',
    /*
     * Google Ads authorises through the same Google OAuth client as Business
     * Profile but lands on its own route, for the reason YouTube does: the
     * state is bound to one platform and the callback route is what proves
     * which provider redirected. Sharing Business Profile's route would mean
     * reading the platform out of the state instead of checking the state
     * against the route.
     */
    GOOGLE_ADS: 'google-ads',
    GOOGLE_BUSINESS: 'google',
    TIKTOK: 'tiktok',
    SNAPCHAT: 'snapchat',
    LINKEDIN: 'linkedin',
    /*
     * YouTube authorises through the same Google OAuth client as Business
     * Profile but lands on its own route. The state is bound to one platform
     * and the callback route is what proves which provider redirected, so
     * sharing Business Profile's route would mean reading the platform out of
     * the state instead of checking the state against the route — deleting the
     * check rather than passing it.
     */
    YOUTUBE: 'youtube',
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
/**
 * Which provider owns a platform's OAuth.
 *
 * A lookup rather than a chain of ifs, so adding a provider is one entry and
 * every platform that has no adapter still fails loudly rather than silently
 * receiving Meta's authorization URL — which is exactly what happened while
 * TikTok was routed through `metaConfig()`.
 */
export type OAuthProvider =
  | 'META' | 'INSTAGRAM' | 'TIKTOK' | 'GOOGLE' | 'GOOGLE_ADS' | 'YOUTUBE' | 'LINKEDIN';

const OAUTH_PROVIDER: Partial<Record<Platform, OAuthProvider>> = {
  [Platform.FACEBOOK]: 'META',
  /*
   * Instagram connects on its own, because a great many Instagram Professional
   * accounts have no Facebook Page and cannot complete Facebook Login for
   * Business at all. An Instagram account that *is* Page-linked still arrives
   * through the Meta connection as a discovered asset — that path is untouched.
   */
  [Platform.INSTAGRAM]: 'INSTAGRAM',
  [Platform.TIKTOK]: 'TIKTOK',
  [Platform.GOOGLE_BUSINESS]: 'GOOGLE',
  // Google's OAuth client, an adwords-shaped grant. See `google-ads.ts`.
  [Platform.GOOGLE_ADS]: 'GOOGLE_ADS',
  // Google's OAuth client, a YouTube-shaped grant. See `youtube.ts`.
  [Platform.YOUTUBE]: 'YOUTUBE',
  [Platform.LINKEDIN]: 'LINKEDIN',
};

export function providerFor(platform: Platform): OAuthProvider {
  const provider = OAUTH_PROVIDER[platform];
  if (!provider) {
    throw new Error(`${platform} has no OAuth integration on this deployment yet.`);
  }
  return provider;
}

/**
 * One provider's OAuth, with its configuration already read.
 *
 * This replaced four parallel chains of ternaries — one each for the
 * authorization URL, the code exchange, the validation call and discovery —
 * that had to be edited in lockstep every time a provider was added. Adding one
 * wrongly was not hypothetical: TikTok shipped routed through `metaConfig()`,
 * so pressing Connect on TikTok produced a Facebook authorization URL, and
 * Google shipped with the same defect. A single entry per provider is the shape
 * where that mistake has nowhere to hide.
 *
 * `redirectUri` is threaded through `authorize` and `exchange` rather than read
 * from the config inside them, because OAuth requires the two calls to send a
 * byte-identical value and the authoritative copy is the one recorded in the
 * signed state — not whatever the environment holds by the time the operator
 * comes back from the provider.
 */
interface BoundProvider {
  /** From the provider's own variable; empty means "derive it from the host". */
  redirectUri: string;
  /** Named in the error when the configured URI points at the wrong route. */
  redirectVariable: string;
  authorize(input: { state: string; redirectUri: string }): string;
  exchange(input: { code: string; redirectUri: string; fetchImpl: FetchLike }): Promise<TokenSet>;
  validate(input: { accessToken: string; fetchImpl: FetchLike }): Promise<{ id: string; name: string }>;
  /**
   * What the provider actually granted.
   *
   * Meta answers this from a second endpoint; every other provider returns the
   * grant in the token response itself. Asking Meta's `/me/permissions` with a
   * TikTok token would fail the whole connection, which is why this is the
   * provider's own question rather than a shared step.
   */
  grantedScopes(input: { tokens: TokenSet; fetchImpl: FetchLike }): Promise<string[]>;
  /** The one grant that decides whether an attached account can post. */
  publishScope: string;
  /**
   * What this login can attach, and what it was refused.
   *
   * A result rather than a bare array, because "nothing came back" and "what
   * came back was refused" are different facts that need different sentences in
   * front of the operator — and only the provider knows which happened.
   * Providers that cannot be refused per asset report no refusals, and the
   * shape costs them one wrapper each.
   */
  discover(input: { accessToken: string; fetchImpl: FetchLike }): Promise<DiscoveryResult>;
}

const PROVIDERS: Record<OAuthProvider, () => BoundProvider> = {
  META: () => {
    const config = metaConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'META_REDIRECT_URI',
      authorize: ({ state, redirectUri }) => authorizationUrl({ config: { ...config, redirectUri }, state }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => validateToken(input),
      grantedScopes: ({ fetchImpl, tokens }) =>
        grantedPermissions({ accessToken: tokens.accessToken, fetchImpl }),
      publishScope: PAGE_PUBLISH_PERMISSION,
      discover: async (input) => ({ accounts: await discoverAccounts(input) }),
    };
  },

  /*
   * Instagram API with Instagram Login. Everything token-shaped is
   * `instagram.ts`; the grant arrives with the token, so `grantedScopes` asks
   * no second question, and discovery returns the single account the login is.
   */
  INSTAGRAM: () => {
    const config = instagram.instagramConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'INSTAGRAM_REDIRECT_URI',
      authorize: ({ state, redirectUri }) =>
        instagram.authorizationUrl({ config: { ...config, redirectUri }, state }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        instagram.exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => instagram.validateToken(input),
      grantedScopes: async ({ tokens }) => tokens.scopes,
      publishScope: instagram.PUBLISH_SCOPE,
      discover: async (input) => ({ accounts: await instagram.discoverAccounts(input) }),
    };
  },

  TIKTOK: () => {
    const config = tiktok.tiktokConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'TIKTOK_REDIRECT_URI',
      authorize: ({ state, redirectUri }) =>
        tiktok.authorizationUrl({ config: { ...config, redirectUri }, state }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        tiktok.exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => tiktok.validateToken(input),
      grantedScopes: async ({ tokens }) => tokens.scopes,
      publishScope: tiktok.PUBLISH_SCOPE,
      discover: async (input) => ({ accounts: await tiktok.discoverAccounts(input) }),
    };
  },

  GOOGLE: () => {
    const config = google.googleConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'GOOGLE_REDIRECT_URI',
      authorize: ({ state, redirectUri }) =>
        google.authorizationUrl({ config: { ...config, redirectUri }, state }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        google.exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => google.validateToken(input),
      grantedScopes: async ({ tokens }) => tokens.scopes,
      publishScope: google.BUSINESS_SCOPE,
      discover: async (input) => ({ accounts: await google.discoverAccounts(input) }),
    };
  },

  /*
   * The same Google OAuth client again, asking for `adwords` and discovering ad
   * accounts rather than Business Profile accounts. One NORIVA application,
   * many clients: each restaurant authorises its own Google login through it.
   */
  GOOGLE_ADS: () => {
    const config = googleAds.googleAdsConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'GOOGLE_ADS_REDIRECT_URI',
      authorize: ({ state, redirectUri }) =>
        google.authorizationUrl({
          config: { ...config, redirectUri },
          state,
          scopes: googleAds.GOOGLE_ADS_SCOPES,
        }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        google.exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => google.validateToken(input),
      grantedScopes: async ({ tokens }) => tokens.scopes,
      publishScope: googleAds.ADWORDS_SCOPE,
      discover: (input) => googleAds.discoverAccounts(input),
    };
  },

  /*
   * The same Google OAuth client and the same token calls, asking for the
   * scope the YouTube publisher actually needs and discovering channels rather
   * than Business Profile accounts. Everything token-shaped is `google.ts`;
   * nothing about OAuth is written twice.
   */
  YOUTUBE: () => {
    const config = youtube.youtubeConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'YOUTUBE_REDIRECT_URI',
      authorize: ({ state, redirectUri }) =>
        google.authorizationUrl({
          config: { ...config, redirectUri },
          state,
          scopes: youtube.YOUTUBE_SCOPES,
        }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        google.exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => google.validateToken(input),
      grantedScopes: async ({ tokens }) => tokens.scopes,
      publishScope: youtube.UPLOAD_SCOPE,
      discover: async (input) => ({ accounts: await youtube.discoverAccounts(input) }),
    };
  },

  LINKEDIN: () => {
    const config = linkedin.linkedInConfig();
    return {
      redirectUri: config.redirectUri,
      redirectVariable: 'LINKEDIN_REDIRECT_URI',
      authorize: ({ state, redirectUri }) =>
        linkedin.authorizationUrl({ config: { ...config, redirectUri }, state }),
      exchange: ({ code, redirectUri, fetchImpl }) =>
        linkedin.exchangeCode({ config: { ...config, redirectUri }, code, fetchImpl }),
      validate: (input) => linkedin.validateToken(input),
      grantedScopes: async ({ tokens }) => tokens.scopes,
      publishScope: linkedin.PUBLISH_SCOPE,
      discover: async (input) => ({ accounts: await linkedin.discoverAccounts(input) }),
    };
  },
};

/** The provider's OAuth, configuration read and ready to call. */
export function bindProvider(platform: Platform): BoundProvider {
  return PROVIDERS[providerFor(platform)]();
}

export async function beginAuthorization(input: {
  organizationId: string;
  clientId: string;
  platform: Platform;
  baseUrl: string;
}): Promise<AuthorizeResult> {
  const provider = bindProvider(input.platform);

  /*
   * The provider is the authority on this value, not us.
   *
   * `redirect_uri` must be byte-identical in the authorize call and in the code
   * exchange, and it must match one registered in the app console — so the
   * provider's own variable wins, and the URI derived from the request host is
   * only a fallback for a deployment that has not set it. Deriving it and then
   * exchanging with a different one is the classic "the code is invalid" loop.
   */
  const redirectUri = provider.redirectUri || callbackUrl(input.baseUrl, input.platform);

  /*
   * And it has to point back at a route that exists. A console entry aimed at
   * anything other than the mounted callback path sends the operator's browser
   * somewhere with the authorization code in the query string and no handler to
   * consume it — which looks like "Meta did nothing" from the outside.
   */
  const expected = callbackPath(input.platform);
  if (!new URL(redirectUri).pathname.endsWith(expected)) {
    throw new Error(
      `${provider.redirectVariable} must end with ${expected} so the authorization lands on the callback route. ` +
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

  return { redirectTo: provider.authorize({ state, redirectUri }), integrationId: integration.id };
}

// ---------------------------------------------------------------- callback

export interface CallbackResult {
  integrationId: string;
  clientId: string;
  platform: Platform;
  accountName: string;
  discovered: DiscoveredAccount[];
}

// Shared with the Upload-Post flow, which discovers the same kinds through a
// lifecycle that is not OAuth. See `account-kinds.ts`.
const KIND = KIND_FOR_DISCOVERY;

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

  const provider = bindProvider(consumed.platform);

  try {
    /*
     * The same four steps for every provider — exchange, validate, read the
     * grant, discover — because the invariants below (nothing CONNECTED until
     * the provider answers; nothing attached the operator did not choose) are
     * the connection's, not Meta's. Only the calls behind them differ.
     *
     * The redirect URI comes from the consumed state rather than from the
     * environment: it is the value that was actually sent to the provider when
     * this flow started, and the exchange has to match it byte for byte even if
     * a variable changed in between.
     */
    const tokens = await provider.exchange({
      code: input.code,
      redirectUri: consumed.redirectUri,
      fetchImpl: input.fetchImpl,
    });

    // The connection is only real if the provider answers with this token.
    const identity = await provider.validate({
      accessToken: tokens.accessToken,
      fetchImpl: input.fetchImpl,
    });

    /*
     * The grant, asked as the provider's own question.
     *
     * Providers grant per-permission, so this login may have allowed everything
     * except publishing. Recording the request instead of the grant is how a
     * connection reads CONNECTED and then fails at the first post with an error
     * nobody saw coming.
     */
    const granted = await provider.grantedScopes({ tokens, fetchImpl: input.fetchImpl });

    // The permission that decides whether the attached account can actually
    // post: pages_manage_posts on Meta, video.publish on TikTok, and so on.
    const canPublishPages = granted.includes(provider.publishScope);

    const { accounts: discovered, refusals = [] } = await provider.discover({
      accessToken: tokens.accessToken,
      fetchImpl: input.fetchImpl,
    });

    await prisma.$transaction(async (tx) => {
      await tx.integration.update({
        where: { id: integration.id },
        data: {
          // Not CONNECTED yet: nothing has been chosen. Connection completes
          // when the operator selects the assets to attach.
          status: IntegrationStatus.CONNECTING,
          accountName: identity.name,
          accountId: identity.id,
          // The grant, not the request.
          scopes: granted,
          accessTokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          tokenExpiresAt: tokens.expiresAt,
          tokenFingerprint: secretFingerprint(tokens.accessToken),
          /*
           * An authorisation that discovered nothing — or that was refused some
           * of what it named — is not an error, but it is the only thing the
           * operator will be looking at: the selection drawer opens empty, or
           * short, and without this says nothing about why. The note is written
           * in the provider's own vocabulary and cleared the moment something
           * is attached.
           */
          lastError: discoveryNote({
            platform: consumed.platform,
            discovered: discovered.length,
            refusals,
          }),
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

        /*
         * Three distinguishable states, because they need three different
         * actions from the operator:
         *
         *   no token          reconnect — the login did not cover this Page
         *   token, no grant   the app is missing pages_manage_posts; App Review
         *   token and grant   nothing to do; verified on first use
         *
         * Collapsing the middle case into "reauthorise" would send someone to
         * reconnect repeatedly against a permission the app has never held.
         */
        const tokenFields = !pageToken
          ? {
              accessTokenEnc: null,
              tokenStatus: AccountTokenStatus.REAUTH_REQUIRED,
              grantedScopes: granted,
            }
          : {
              accessTokenEnc: encryptSecret(pageToken),
              grantedScopes: granted,
              // Discovery proved the *user* token works, not this one, so the
              // best that can be claimed is that nothing is known against it.
              tokenStatus: canPublishPages
                ? AccountTokenStatus.UNKNOWN
                : AccountTokenStatus.MISSING_PERMISSION,
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
 * The scope whose absence marks an attached account MISSING_PERMISSION.
 *
 * Read back from the same bound provider that set the flag, so the permission
 * named in an error is the one actually compared against — not a second list
 * that drifts. Configuration is read to answer it, and a deployment that has
 * since had a variable cleared should still be able to detach its accounts, so
 * an unconfigured provider yields no name rather than an exception.
 */
function recordedPublishScope(platform: Platform): string | null {
  try {
    return bindProvider(platform).publishScope;
  } catch {
    return null;
  }
}

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
    // The platform decides every sentence this function can end up writing.
    // Selecting it is what stopped a Google Ads connection being told to go and
    // grant a Facebook Page permission.
    select: { id: true, platform: true, accounts: { select: { id: true } } },
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

  /*
   * CONNECTED means "this can publish", not "a box was ticked".
   *
   * Selecting a Page whose token never arrived used to mark the whole
   * integration CONNECTED, so the Integrations screen showed a healthy green
   * connection whose first publish would fail with a permissions error. A
   * connection is only live once at least one attached account holds a
   * credential that could actually be used.
   *
   * ERROR rather than DISCONNECTED for the half-connected case: the operator
   * *did* connect something, and telling them nothing is attached would send
   * them to repeat a step they already completed. `lastError` names the real
   * next action.
   */
  const attached = chosen.length === 0 ? [] : await prisma.integrationAccount.findMany({
    where: { id: { in: chosen } },
    select: { accessTokenEnc: true, tokenStatus: true },
  });

  const usable = attached.filter(
    (account) =>
      account.accessTokenEnc !== null &&
      account.tokenStatus !== AccountTokenStatus.REAUTH_REQUIRED &&
      account.tokenStatus !== AccountTokenStatus.TOKEN_EXPIRED,
  );

  const missingPermission = attached.some(
    (account) => account.tokenStatus === AccountTokenStatus.MISSING_PERMISSION,
  );

  const status = chosen.length === 0
    ? IntegrationStatus.DISCONNECTED
    : usable.length > 0
      ? IntegrationStatus.CONNECTED
      : IntegrationStatus.ERROR;

  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      status,
      lastError:
        status === IntegrationStatus.ERROR
          ? noUsableCredentialNote(integration.platform)
          : missingPermission
            ? missingGrantNote(integration.platform, recordedPublishScope(integration.platform))
            : null,
    },
  });

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
