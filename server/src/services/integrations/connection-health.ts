/**
 * Is this connection actually working — asked of the provider, not of a column.
 *
 * Three jobs, kept together because each one needs the others' answers:
 *
 *   classify     turn a provider failure into one of the states an operator
 *                can act on: token expired, permission missing, or the API
 *                itself failing. These need different actions — reconnect,
 *                re-grant / App Review, or wait — and the old health route
 *                wrote ERROR for all three, including for a 503 that would
 *                have cleared on its own.
 *
 *   refresh      keep short-lived credentials alive. TikTok tokens last a day
 *                and Google's an hour; the refresh tokens were stored at
 *                connect time and, for TikTok and Instagram, never read. The
 *                refreshed token is written to the integration *and* to the
 *                accounts that carry a copy of it, because publishing reads
 *                the account's copy.
 *
 *   check        the live proof-of-life: refresh if due, call the provider's
 *                identity endpoint, re-read Meta's grant, and record the
 *                verdict. A connection is reported CONNECTED only from here or
 *                from the OAuth callback — both of which have just heard the
 *                provider answer.
 *
 * Nothing here returns or logs a token. Errors are the provider's message,
 * truncated; the providers' readers already strip request echoes from them.
 */

import { IntegrationStatus, Platform, Prisma, type PrismaClient } from '@prisma/client';

import { decryptSecret, encryptSecret, secretFingerprint } from '../../lib/crypto.js';
import {
  adapterFor, connectable, providerReadiness, ProviderNotConfiguredError,
} from './index.js';
import { bindProvider } from './connect-flow.js';
import { grantedPermissions, ProviderApiError, type FetchLike } from './meta.js';
import * as google from './google.js';
import * as googleAds from './google-ads.js';
import * as youtube from './youtube.js';
import * as instagram from './instagram.js';
import * as tiktok from './tiktok.js';
import { permissionReport, type PermissionReport } from './permissions.js';

export type ConnectionState =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'TOKEN_EXPIRED'
  | 'MISSING_PERMISSIONS'
  | 'CONFIGURATION_REQUIRED'
  | 'API_ERROR';

/** The last live verdict, kept on `Integration.metadata.health`. */
export interface HealthRecord {
  state: ConnectionState;
  checkedAt: string;
  live: boolean;
  detail: string;
}

/*
 * Statuses a successful live check may lift back to CONNECTED. CONNECTING is
 * deliberately absent: an authorised login with nothing attached is not a
 * connection, however healthy its token.
 */
const RECOVERABLE: IntegrationStatus[] = [
  IntegrationStatus.ERROR,
  IntegrationStatus.TOKEN_EXPIRED,
  IntegrationStatus.EXPIRED,
  IntegrationStatus.REAUTH_REQUIRED,
  IntegrationStatus.CONNECTED,
];

const EXPIRED_STATUSES: IntegrationStatus[] = [
  IntegrationStatus.TOKEN_EXPIRED,
  IntegrationStatus.EXPIRED,
  IntegrationStatus.REAUTH_REQUIRED,
];

// ---------------------------------------------------------------- classify

const TOKEN_WORDS = /access[ _]?token|expired|revoked|invalid_grant|invalid_token|session has|re-?authori[sz]e|unauthori[sz]ed client|OAuthException|token.*invalid|invalid.*token/i;
const PERMISSION_WORDS = /permission|scope|not authori[sz]ed|insufficient|forbidden|requires .* access|\(#(10|200|3|294)\)/i;

/**
 * Which of the three failure states a provider error is.
 *
 * Status first, words second. Meta answers an expired token with HTTP 400 and
 * code 190, and TikTok answers everything with 200 and an in-band error, so
 * the status alone cannot decide; but where a status is unambiguous it wins
 * over prose, which is any provider's to reword.
 */
export function classifyFailure(error: unknown): Exclude<ConnectionState, 'CONNECTED' | 'DISCONNECTED' | 'CONFIGURATION_REQUIRED'> {
  if (error instanceof ProviderApiError || isStatusError(error)) {
    const status = (error as { status: number }).status;
    const message = (error as Error).message;
    if (status === 401) return 'TOKEN_EXPIRED';
    if (status === 403) return PERMISSION_WORDS.test(message) || !TOKEN_WORDS.test(message) ? 'MISSING_PERMISSIONS' : 'TOKEN_EXPIRED';
    if (status === 429 || status >= 500) return 'API_ERROR';
    if (TOKEN_WORDS.test(message)) return 'TOKEN_EXPIRED';
    if (PERMISSION_WORDS.test(message)) return 'MISSING_PERMISSIONS';
    return 'API_ERROR';
  }
  // A network failure, a timeout, an unreadable body: the provider never
  // answered, which says nothing about the credential.
  return 'API_ERROR';
}

function isStatusError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { status?: unknown }).status === 'number';
}

// ---------------------------------------------------------------- derive

export interface DeriveInput {
  platform: Platform;
  integration: {
    status: IntegrationStatus;
    hasCredential: boolean;
    hasRefreshToken: boolean;
    tokenExpiresAt: Date | null;
    scopes: string[];
    lastError: string | null;
    metadata: Prisma.JsonValue;
  } | null;
  now?: Date;
}

/**
 * The state as far as the database can tell, without calling anyone.
 *
 * This is what the list renders on every page load. It is conservative in one
 * direction only: it never says CONNECTED for something the last live check
 * said was failing, and it never upgrades a status on its own — only `check`
 * does that, after the provider has answered.
 */
export function deriveState(input: DeriveInput): { state: ConnectionState; reason: string } {
  const adapter = adapterFor(input.platform);
  const readiness = providerReadiness(adapter);
  const built = connectable(adapter);
  const row = input.integration;
  const now = input.now ?? new Date();

  const configurationMissing = !built
    ? 'This platform is not implemented in this application yet.'
    : readiness.state !== 'READY'
      ? readiness.detail
      : null;

  if (!row || !row.hasCredential && row.status !== IntegrationStatus.CONNECTED) {
    if (configurationMissing) return { state: 'CONFIGURATION_REQUIRED', reason: configurationMissing };
    if (row?.status === IntegrationStatus.CONNECTING) {
      return { state: 'DISCONNECTED', reason: 'Authorisation was started but not completed.' };
    }
    return { state: 'DISCONNECTED', reason: 'No account is connected.' };
  }

  if (configurationMissing) return { state: 'CONFIGURATION_REQUIRED', reason: configurationMissing };

  if (row.status === IntegrationStatus.DISCONNECTED) {
    return { state: 'DISCONNECTED', reason: 'No account is connected.' };
  }
  if (row.status === IntegrationStatus.CONNECTING) {
    return { state: 'DISCONNECTED', reason: 'Authorised — choose which accounts to attach to finish connecting.' };
  }

  if (EXPIRED_STATUSES.includes(row.status)) {
    return { state: 'TOKEN_EXPIRED', reason: row.lastError ?? 'The authorisation has expired. Reconnect the account.' };
  }

  /*
   * Past its expiry with no way to renew it. A refresh token means the next
   * use renews it; Instagram renews with itself, but only while still valid.
   */
  if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now.getTime() && !row.hasRefreshToken) {
    return { state: 'TOKEN_EXPIRED', reason: `The token expired on ${row.tokenExpiresAt.toISOString().slice(0, 10)}. Reconnect the account.` };
  }

  const health = healthOf(row.metadata);

  if (row.status === IntegrationStatus.ERROR) {
    return { state: 'API_ERROR', reason: row.lastError ?? health?.detail ?? 'The last call to the provider failed.' };
  }
  if (health && (health.state === 'API_ERROR' || health.state === 'TOKEN_EXPIRED')) {
    return { state: health.state, reason: health.detail };
  }

  const report = permissionReport(input.platform, row.scopes);
  if (report.requirements.length > 0 && row.scopes.length > 0 && report.missingRequired.length > 0) {
    return {
      state: 'MISSING_PERMISSIONS',
      reason: `Not granted: ${report.missingRequired.map((entry) => entry.scope).join(', ')}.`,
    };
  }

  return { state: 'CONNECTED', reason: health?.live ? health.detail : 'Connected. Run Test Connection to verify it live.' };
}

export function healthOf(metadata: Prisma.JsonValue): HealthRecord | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const health = (metadata as Record<string, unknown>).health;
  if (!health || typeof health !== 'object') return null;
  const record = health as Partial<HealthRecord>;
  return typeof record.state === 'string' && typeof record.checkedAt === 'string'
    ? { state: record.state, checkedAt: record.checkedAt, live: Boolean(record.live), detail: String(record.detail ?? '') }
    : null;
}

// ---------------------------------------------------------------- refresh

/** How long before expiry a token is renewed. Instagram's lasts 60 days. */
const MARGIN_MS: Partial<Record<Platform, number>> = {
  [Platform.INSTAGRAM]: 7 * 86_400_000,
};
const DEFAULT_MARGIN_MS = 5 * 60_000;

/** Platforms this module knows how to renew, and with what. */
const REFRESHABLE: Platform[] = [
  Platform.TIKTOK, Platform.GOOGLE_BUSINESS, Platform.GOOGLE_ADS, Platform.YOUTUBE, Platform.INSTAGRAM,
];

export function canRefresh(platform: Platform): boolean {
  return REFRESHABLE.includes(platform);
}

interface CredentialRow {
  id: string;
  platform: Platform;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}

export class RefreshUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshUnavailableError';
  }
}

async function renew(row: CredentialRow, fetchImpl: FetchLike, now: Date) {
  switch (row.platform) {
    case Platform.TIKTOK: {
      if (!row.refreshTokenEnc) throw new RefreshUnavailableError('No TikTok refresh token is stored. Reconnect TikTok.');
      const config = tiktok.tiktokConfig();
      return tiktok.refreshAccessToken({ config, refreshToken: decryptSecret(row.refreshTokenEnc), fetchImpl, now });
    }
    case Platform.GOOGLE_BUSINESS:
    case Platform.GOOGLE_ADS:
    case Platform.YOUTUBE: {
      if (!row.refreshTokenEnc) throw new RefreshUnavailableError('No Google refresh token is stored. Reconnect the account.');
      const config = row.platform === Platform.GOOGLE_ADS
        ? googleAds.googleAdsConfig()
        : row.platform === Platform.YOUTUBE ? youtube.youtubeConfig() : google.googleConfig();
      const refreshed = await google.refreshAccessToken({
        config, refreshToken: decryptSecret(row.refreshTokenEnc), fetchImpl, now,
      });
      return { ...refreshed, refreshToken: null };
    }
    case Platform.INSTAGRAM: {
      if (!row.accessTokenEnc) throw new RefreshUnavailableError('No Instagram token is stored. Reconnect Instagram.');
      if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= now.getTime()) {
        throw new RefreshUnavailableError('The Instagram token has already expired and cannot renew itself. Reconnect Instagram.');
      }
      const refreshed = await instagram.refreshAccessToken({ accessToken: decryptSecret(row.accessTokenEnc), fetchImpl, now });
      return { ...refreshed, refreshToken: null };
    }
    default:
      throw new RefreshUnavailableError(
        row.platform === Platform.FACEBOOK
          ? 'Meta issues no refresh token. A long-lived token is renewed only by the account owner logging in again — use Reconnect.'
          : 'This platform\'s credential cannot be renewed automatically. Use Reconnect.',
      );
  }
}

/**
 * Renew the connection's credential and write it everywhere it is copied.
 *
 * Every non-Meta provider here hands the attached accounts the same user token
 * the integration holds — there is no per-asset credential on TikTok, Google
 * or Instagram Login — so the accounts carrying a token are updated with it.
 * Meta is excluded by `renew` refusing it: its Page tokens are distinct
 * credentials and must never be overwritten with a user token.
 */
export async function refreshCredential(input: {
  prisma: PrismaClient;
  row: CredentialRow;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const now = input.now ?? new Date();
  const renewed = await renew(input.row, input.fetchImpl, now);
  const accessTokenEnc = encryptSecret(renewed.accessToken);

  await input.prisma.$transaction([
    input.prisma.integration.update({
      where: { id: input.row.id },
      data: {
        accessTokenEnc,
        tokenExpiresAt: renewed.expiresAt,
        tokenFingerprint: secretFingerprint(renewed.accessToken),
        // TikTok may rotate the refresh token; keeping the retired one works
        // until TikTok stops accepting it, which is the worst time to find out.
        ...(renewed.refreshToken ? { refreshTokenEnc: encryptSecret(renewed.refreshToken) } : {}),
      },
    }),
    input.prisma.integrationAccount.updateMany({
      where: { integrationId: input.row.id, accessTokenEnc: { not: null } },
      data: { accessTokenEnc, tokenExpiresAt: renewed.expiresAt },
    }),
  ]);

  return { accessToken: renewed.accessToken, expiresAt: renewed.expiresAt };
}

function due(row: CredentialRow, now: Date): boolean {
  if (!row.tokenExpiresAt) return false;
  const margin = MARGIN_MS[row.platform] ?? DEFAULT_MARGIN_MS;
  return row.tokenExpiresAt.getTime() - margin <= now.getTime();
}

/**
 * The account's credential, renewed first if it is about to lapse.
 *
 * Called by the publisher immediately before a post. A renewal that fails is
 * not fatal here: the stored token is returned and the provider's own refusal
 * — classified and recorded by the publishing path — is a better account of
 * what went wrong than a refresh error would be.
 */
export async function freshAccountToken(input: {
  prisma: PrismaClient;
  accountId: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  const account = await input.prisma.integrationAccount.findUnique({
    where: { id: input.accountId },
    select: {
      accessTokenEnc: true,
      integration: {
        select: { id: true, platform: true, accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true },
      },
    },
  });
  if (!account?.accessTokenEnc) return null;

  const row = account.integration;
  if (canRefresh(row.platform) && due(row, now)) {
    try {
      return (await refreshCredential({ prisma: input.prisma, row, fetchImpl: input.fetchImpl, now })).accessToken;
    } catch {
      // Fall through to the stored token; see above.
    }
  }
  return decryptSecret(account.accessTokenEnc);
}

// ---------------------------------------------------------------- check

export interface HealthResult {
  integrationId: string;
  platform: Platform;
  status: IntegrationStatus;
  state: ConnectionState;
  live: boolean;
  detail: string;
  checkedAt: string;
  refreshed: boolean;
  tokenExpiresAt: Date | null;
  identity: { id: string; name: string } | null;
  permissions: PermissionReport;
}

/**
 * Prove the connection against the provider, and record what it said.
 *
 * `forceRefresh` is the operator's "Refresh Authorization": renew now rather
 * than when due. Where renewal is impossible (Meta), that is reported as the
 * detail and the live check still runs, so the button never answers with
 * nothing.
 */
export async function checkConnection(input: {
  prisma: PrismaClient;
  integrationId: string;
  organizationId: string;
  fetchImpl: FetchLike;
  forceRefresh?: boolean;
  now?: Date;
}): Promise<HealthResult | null> {
  const now = input.now ?? new Date();
  const integration = await input.prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId },
    select: {
      id: true, platform: true, status: true, scopes: true, metadata: true, lastError: true,
      accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true,
      accounts: { where: { selected: true }, select: { id: true } },
    },
  });
  if (!integration) return null;

  const adapter = adapterFor(integration.platform);
  const readiness = providerReadiness(adapter);
  let status = integration.status;
  let scopes = integration.scopes;
  let tokenExpiresAt = integration.tokenExpiresAt;
  let refreshed = false;
  let identity: { id: string; name: string } | null = null;

  const finish = async (state: ConnectionState, live: boolean, detail: string, data: Prisma.IntegrationUpdateInput = {}) => {
    const record: HealthRecord = { state, live, detail: detail.slice(0, 500), checkedAt: now.toISOString() };
    const metadata = {
      ...((integration.metadata && typeof integration.metadata === 'object' && !Array.isArray(integration.metadata))
        ? integration.metadata as Record<string, unknown>
        : {}),
      health: { ...record },
    } as unknown as Prisma.InputJsonValue;
    await input.prisma.integration.update({ where: { id: integration.id }, data: { ...data, metadata } });
    return {
      integrationId: integration.id,
      platform: integration.platform,
      status,
      state,
      live,
      detail: record.detail,
      checkedAt: record.checkedAt,
      refreshed,
      tokenExpiresAt,
      identity,
      permissions: permissionReport(integration.platform, scopes),
    };
  };

  const configurationMissing = adapter.implementation.oauth !== 'IMPLEMENTED'
    ? `${adapter.label} has no OAuth connection in this application yet.`
    : readiness.state !== 'READY' ? readiness.detail : null;

  if (!integration.accessTokenEnc) {
    const detail = 'No credential is stored for this connection.';
    return configurationMissing
      ? finish('CONFIGURATION_REQUIRED', false, `${detail} ${configurationMissing}`)
      : finish('DISCONNECTED', false, detail);
  }
  if (configurationMissing) return finish('CONFIGURATION_REQUIRED', false, configurationMissing);

  let accessToken = decryptSecret(integration.accessTokenEnc);
  let refreshNote = '';

  try {
    if (canRefresh(integration.platform) && (input.forceRefresh || due(integration, now))) {
      const renewed = await refreshCredential({ prisma: input.prisma, row: integration, fetchImpl: input.fetchImpl, now });
      accessToken = renewed.accessToken;
      tokenExpiresAt = renewed.expiresAt;
      refreshed = true;
    } else if (input.forceRefresh) {
      // Meta, LinkedIn: nothing to renew with. `renew` says why without a
      // network call, and the live check carries on.
      await renew(integration, input.fetchImpl, now).catch((error: Error) => {
        refreshNote = ` ${error.message}`;
      });
    }

    identity = await bindProvider(integration.platform).validate({ accessToken, fetchImpl: input.fetchImpl });

    if (integration.platform === Platform.FACEBOOK) {
      // Meta's grant can change after login — a permission removed in the
      // Business settings — and only `/me/permissions` knows.
      scopes = await grantedPermissions({ accessToken, fetchImpl: input.fetchImpl });
    }
  } catch (error) {
    if (error instanceof RefreshUnavailableError) {
      status = IntegrationStatus.TOKEN_EXPIRED;
      return finish('TOKEN_EXPIRED', false, error.message, { status, lastError: error.message });
    }
    if (error instanceof ProviderNotConfiguredError) {
      return finish('CONFIGURATION_REQUIRED', false, error.message);
    }
    const state = classifyFailure(error);
    const detail = (error as Error).message.slice(0, 500);
    if (state === 'TOKEN_EXPIRED') {
      status = IntegrationStatus.TOKEN_EXPIRED;
      return finish(state, false, detail, { status, lastError: detail });
    }
    // A missing permission or a failing API leaves the stored status alone:
    // neither says the credential is gone, and an outage must not disconnect.
    return finish(state, false, detail);
  }

  const report = permissionReport(integration.platform, scopes);
  const hasAccounts = integration.accounts.length > 0;
  // An empty grant is "not recorded" (rows from before grants were stored),
  // not "nothing granted" — the identity call just succeeded with it.
  const missing = scopes.length > 0 ? report.missingRequired : [];
  const state: ConnectionState = !hasAccounts && integration.status === IntegrationStatus.CONNECTING
    ? 'DISCONNECTED'
    : missing.length > 0 ? 'MISSING_PERMISSIONS' : 'CONNECTED';

  if (hasAccounts && RECOVERABLE.includes(integration.status)) status = IntegrationStatus.CONNECTED;

  const detail = state === 'DISCONNECTED'
    ? `${adapter.label} answered as ${identity.name}. Choose which accounts to attach to finish connecting.`
    : state === 'MISSING_PERMISSIONS'
      ? `${adapter.label} answered as ${identity.name}, but these permissions were not granted: ${missing.map((entry) => entry.scope).join(', ')}.`
      : `${adapter.label} answered as ${identity.name}.${refreshed ? ' The authorisation was renewed.' : ''}`;

  return finish(state, true, detail + refreshNote, {
    status,
    scopes,
    // A recovered connection must not keep the error that no longer applies;
    // a half-finished one keeps its discovery note.
    ...(status === IntegrationStatus.CONNECTED ? { lastError: null } : {}),
  });
}
