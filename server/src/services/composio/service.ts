/**
 * Restaurant connections through Composio.
 *
 * A third route to a social account, beside direct OAuth (`Integration`) and
 * Upload-Post — added, not substituted. Direct OAuth stays the route for
 * everything it already does well (Page tokens, account selection, metric
 * ingestion); Composio adds what that model cannot: several accounts of one
 * platform per restaurant, toolkits with no direct adapter here (GA4, Search
 * Console), and a hosted login the restaurant's own manager can complete
 * without anyone at the agency touching OAuth apps.
 *
 * The tenant boundary is the Composio `user_id`. It is derived on the server
 * from a client id that has already been checked against the caller's
 * organisation, and never accepted from a request. Every account Composio
 * returns is checked against it again before a row is written — an account
 * listed under another restaurant's id is dropped, not trusted.
 *
 * "Connected" here means Composio reported the account ACTIVE when we last
 * asked, and, where a verification tool is configured for the toolkit, that a
 * read-only call through it succeeded. `verification` records which.
 */

import { NotificationType, type PrismaClient, type ComposioConnection } from '@prisma/client';

import {
  ComposioError, composioConfigured, createComposioClient,
  type AuthConfigSummary, type ComposioClient, type ComposioFetch, type RemoteAccount,
} from './client.js';
import { notify } from '../notify.js';

export type ConnectionState =
  | 'CONNECTED' | 'DISCONNECTED' | 'PENDING_APPROVAL' | 'TOKEN_EXPIRED' | 'MISSING_PERMISSIONS'
  | 'REAUTHORIZATION_REQUIRED' | 'API_ERROR' | 'UNSUPPORTED';

/**
 * The Composio end-user id for one restaurant.
 *
 * Client ids are cuids, unique across organisations, so the restaurant alone
 * identifies the tenant. The prefix keeps this deployment's users apart from
 * anything else living in the same Composio project.
 */
export function composioUserId(clientId: string, env: NodeJS.ProcessEnv = process.env): string {
  const prefix = env.COMPOSIO_USER_PREFIX?.trim() || 'marketing-os';
  return `${prefix}:client:${clientId}`;
}

/**
 * Which business platform a toolkit slug serves — for grouping and coverage
 * only. The slugs are Composio's and were not verifiable when this was
 * written, so nothing here decides what can be connected: the auth configs
 * the Composio project actually holds do. An unknown slug is shown under its
 * own name, never dropped.
 */
export const PLATFORM_FAMILIES: Array<{ key: string; label: string; labelAr: string; slugs: string[] }> = [
  { key: 'TIKTOK', label: 'TikTok', labelAr: 'تيك توك', slugs: ['tiktok'] },
  { key: 'TIKTOK_ADS', label: 'TikTok Ads', labelAr: 'إعلانات تيك توك', slugs: ['tiktok_ads', 'tiktokads', 'tiktok_business', 'tiktokbusiness'] },
  { key: 'FACEBOOK', label: 'Facebook', labelAr: 'فيسبوك', slugs: ['facebook'] },
  { key: 'INSTAGRAM', label: 'Instagram', labelAr: 'إنستغرام', slugs: ['instagram'] },
  { key: 'META_ADS', label: 'Meta Ads', labelAr: 'إعلانات ميتا', slugs: ['metaads', 'meta_ads', 'facebook_ads', 'facebookads'] },
  { key: 'GOOGLE_ADS', label: 'Google Ads', labelAr: 'إعلانات جوجل', slugs: ['googleads', 'google_ads'] },
  { key: 'GOOGLE_ANALYTICS', label: 'Google Analytics 4', labelAr: 'تحليلات جوجل 4', slugs: ['google_analytics', 'googleanalytics'] },
  { key: 'GOOGLE_BUSINESS', label: 'Google Business Profile', labelAr: 'الملف التجاري في جوجل', slugs: ['google_my_business', 'googlemybusiness', 'google_business_profile', 'google_business'] },
  { key: 'GOOGLE_SEARCH_CONSOLE', label: 'Google Search Console', labelAr: 'جوجل سيرش كونسول', slugs: ['google_search_console', 'googlesearchconsole'] },
];

export function familyOf(toolkit: string): string | null {
  const slug = toolkit.toLowerCase();
  return PLATFORM_FAMILIES.find((family) => family.slugs.includes(slug))?.key ?? null;
}

/** Composio's status, and the last error we saw, as one actionable state. */
export function connectionState(row: Pick<ComposioConnection, 'remoteStatus' | 'lastErrorKind' | 'verifiedAt'>): ConnectionState {
  // An error from our most recent call wins: it is newer than the status.
  if (row.lastErrorKind === 'FORBIDDEN') return 'MISSING_PERMISSIONS';
  if (row.lastErrorKind && ['UNAVAILABLE', 'NETWORK', 'RATE_LIMIT'].includes(row.lastErrorKind)) return 'API_ERROR';
  switch (row.remoteStatus) {
    case 'ACTIVE': return row.verifiedAt ? 'CONNECTED' : 'PENDING_APPROVAL';
    case 'INITIALIZING':
    case 'INITIATED': return 'PENDING_APPROVAL';
    case 'EXPIRED': return 'TOKEN_EXPIRED';
    case 'FAILED':
    case 'REVOKED': return 'REAUTHORIZATION_REQUIRED';
    case 'INACTIVE': return 'DISCONNECTED';
    default: return 'API_ERROR';
  }
}

const BROKEN: ConnectionState[] = ['TOKEN_EXPIRED', 'REAUTHORIZATION_REQUIRED', 'MISSING_PERMISSIONS'];

/** A link not completed within this long is not "pending" any more. */
const PENDING_GRACE_MS = 30 * 60_000;

export class ComposioRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One client per request, metering every call against the tenant that made it. */
export function clientFor(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string | null;
  fetchImpl: ComposioFetch;
}): ComposioClient {
  return createComposioClient({
    fetchImpl: input.fetchImpl,
    meter: ({ operation, success, httpStatus }) => {
      // Best effort: a metering failure must never fail the operation itself.
      void input.prisma.providerCallLog.create({
        data: {
          organizationId: input.organizationId,
          clientId: input.clientId,
          provider: 'COMPOSIO',
          operation,
          success,
          httpStatus,
        },
      }).catch(() => undefined);
    },
  });
}

// ---------------------------------------------------------------- catalog

let catalogCache: { at: number; configs: AuthConfigSummary[] } | null = null;
const CATALOG_TTL_MS = 60_000;

/** Test hook: the catalogue is cached per process. */
export function resetCatalogCache(): void {
  catalogCache = null;
}

export async function authConfigs(client: ComposioClient, now = Date.now()): Promise<AuthConfigSummary[]> {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.configs;
  const configs = await client.listAuthConfigs();
  catalogCache = { at: now, configs };
  return configs;
}

/**
 * What can be connected, grouped by business platform.
 *
 * A platform with no enabled auth config in the Composio project is listed as
 * UNSUPPORTED with the reason, so the screen says what is missing instead of
 * leaving the platform out.
 */
export async function catalog(client: ComposioClient) {
  if (!composioConfigured()) {
    return { configured: false, reason: 'COMPOSIO_API_KEY is not set on the server.', platforms: [], other: [] };
  }
  const configs = (await authConfigs(client)).filter((config) => config.enabled);
  const platforms = PLATFORM_FAMILIES.map((family) => {
    const matching = configs.filter((config) => family.slugs.includes(config.toolkit.toLowerCase()));
    return {
      key: family.key,
      label: family.label,
      labelAr: family.labelAr,
      supported: matching.length > 0,
      authConfigs: matching.map(({ id, name, toolkit, authScheme, managedByComposio }) => ({
        id, name, toolkit, authScheme, managedByComposio,
      })),
    };
  });
  const other = configs
    .filter((config) => !familyOf(config.toolkit))
    .map(({ id, name, toolkit, authScheme, managedByComposio }) => ({ id, name, toolkit, authScheme, managedByComposio }));
  return { configured: true, reason: null, platforms, other };
}

// ---------------------------------------------------------------- lifecycle

export async function startConnection(input: {
  prisma: PrismaClient;
  client: ComposioClient;
  organizationId: string;
  clientId: string;
  authConfigId: string;
  alias?: string;
  returnUrl: string;
  actorId: string;
  replacesId?: string;
}) {
  // Only an auth config this deployment's project actually offers: a request
  // body naming any other id is not a way to attach an arbitrary app.
  const config = (await authConfigs(input.client)).find((entry) => entry.id === input.authConfigId && entry.enabled);
  if (!config) throw new ComposioRequestError(400, 'That connection type is not enabled in this deployment\'s Composio project.');

  const link = await input.client.createLink({
    authConfigId: config.id,
    userId: composioUserId(input.clientId),
    callbackUrl: input.returnUrl,
    alias: input.alias,
  });

  const row = await input.prisma.composioConnection.create({
    data: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      toolkit: config.toolkit,
      authConfigId: config.id,
      composioAccountId: link.connectedAccountId,
      remoteStatus: 'INITIATED',
      alias: input.alias ?? null,
      replacesId: input.replacesId ?? null,
      createdById: input.actorId,
    },
  });

  return { connectionId: row.id, redirectUrl: link.redirectUrl, expiresAt: link.expiresAt };
}

/**
 * Read every account Composio holds for this restaurant and bring the rows in
 * line. Called when the manager returns from the hosted page, on Sync, and
 * whenever the screen asks to look again.
 */
export async function reconcile(input: {
  prisma: PrismaClient;
  client: ComposioClient;
  organizationId: string;
  clientId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const userId = composioUserId(input.clientId);
  const remote = (await input.client.listAccounts({ userId }))
    // Defence in depth: Composio filtered by user_id; we check it anyway.
    .filter((account) => account.userId === userId);

  const existing = await input.prisma.composioConnection.findMany({
    where: { organizationId: input.organizationId, clientId: input.clientId },
  });
  const byRemoteId = new Map(existing.map((row) => [row.composioAccountId, row]));
  const seen = new Set<string>();
  const brokenNow: Array<{ toolkit: string; state: ConnectionState }> = [];

  for (const account of remote) {
    seen.add(account.id);
    const row = byRemoteId.get(account.id);
    const data = remoteFields(account, now);
    if (row) {
      const before = connectionState(row);
      const updated = await input.prisma.composioConnection.update({ where: { id: row.id }, data });
      const after = connectionState(updated);
      if (before === 'CONNECTED' && BROKEN.includes(after)) brokenNow.push({ toolkit: row.toolkit, state: after });
    } else {
      /*
       * Connected outside this screen — from Composio's dashboard, say — but
       * under this restaurant's user id, so it is this restaurant's. A row
       * whose id another tenant already holds is impossible: the id is unique
       * and the user id is this client's.
       */
      await input.prisma.composioConnection.create({
        data: {
          organizationId: input.organizationId,
          clientId: input.clientId,
          toolkit: account.toolkit,
          authConfigId: account.authConfigId,
          composioAccountId: account.id,
          alias: account.alias,
          ...data,
        },
      });
    }
  }

  // Rows Composio no longer has. A link still inside its grace period is
  // simply not finished yet.
  for (const row of existing) {
    if (seen.has(row.composioAccountId)) continue;
    if (row.remoteStatus === 'INITIATED' && now.getTime() - row.createdAt.getTime() < PENDING_GRACE_MS) continue;
    if (row.remoteStatus === 'REVOKED' && row.statusReason?.startsWith('No longer present')) continue;
    await input.prisma.composioConnection.update({
      where: { id: row.id },
      data: {
        remoteStatus: 'REVOKED',
        statusReason: 'No longer present in Composio — removed there, or the connect link was never completed.',
        lastCheckedAt: now,
      },
    });
  }

  await retireReplaced(input);

  for (const entry of brokenNow) {
    await notify({
      organizationId: input.organizationId,
      clientId: input.clientId,
      type: NotificationType.INTEGRATION_DISCONNECTED,
      title: `${entry.toolkit} connection needs attention`,
      body: entry.state === 'TOKEN_EXPIRED'
        ? 'The authorisation expired and could not be renewed automatically. Reconnect it from the Integrations Center.'
        : 'The connection was revoked or lost a permission. Reconnect it from the Integrations Center.',
      link: '/app/integrations',
      audience: 'both',
    }).catch(() => undefined);
  }

  return { accounts: remote.length };
}

function remoteFields(account: RemoteAccount, now: Date) {
  const active = account.status === 'ACTIVE' && !account.disabled;
  return {
    remoteStatus: account.disabled ? 'INACTIVE' : account.status,
    statusReason: account.statusReason,
    lastCheckedAt: now,
    lastError: null,
    lastErrorKind: null,
    ...(active ? { verifiedAt: now, verification: 'COMPOSIO_STATUS', lastSuccessfulSyncAt: now } : {}),
  };
}

/** A reconnect that has gone ACTIVE replaces the connection it was opened for. */
async function retireReplaced(input: { prisma: PrismaClient; client: ComposioClient; organizationId: string; clientId: string }) {
  const replacements = await input.prisma.composioConnection.findMany({
    where: { organizationId: input.organizationId, clientId: input.clientId, replacesId: { not: null }, remoteStatus: 'ACTIVE' },
  });
  for (const replacement of replacements) {
    const old = await input.prisma.composioConnection.findFirst({
      where: { id: replacement.replacesId!, clientId: input.clientId },
    });
    if (old) {
      await removeRemote(input.client, old.composioAccountId);
      await input.prisma.composioConnection.delete({ where: { id: old.id } });
    }
    await input.prisma.composioConnection.update({ where: { id: replacement.id }, data: { replacesId: null } });
  }
}

async function removeRemote(client: ComposioClient, id: string) {
  try {
    await client.deleteAccount(id);
  } catch (error) {
    // Already gone at Composio is the outcome we wanted.
    if (!(error instanceof ComposioError && error.kind === 'NOT_FOUND')) throw error;
  }
}

/**
 * Ask Composio about one account now; where a read-only verification tool is
 * configured for the toolkit, also make one call through it to the platform.
 */
export async function testConnection(input: {
  prisma: PrismaClient;
  client: ComposioClient;
  row: ComposioConnection;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  try {
    const account = await input.client.getAccount(input.row.composioAccountId);
    if (account.userId !== composioUserId(input.row.clientId)) {
      throw new ComposioRequestError(404, 'That account does not belong to this restaurant.');
    }
    const data: Record<string, unknown> = remoteFields(account, now);

    const tool = env[`COMPOSIO_VERIFY_TOOL_${input.row.toolkit.toUpperCase()}`]?.trim();
    if (tool && account.status === 'ACTIVE' && !account.disabled) {
      const result = await input.client.executeTool({
        toolSlug: tool,
        connectedAccountId: account.id,
        userId: account.userId,
      });
      if (result.successful) {
        Object.assign(data, { verification: 'PROVIDER_CALL' });
      } else {
        const permission = /permission|scope|forbidden|not authori[sz]ed|insufficient/i.test(result.error ?? '');
        Object.assign(data, {
          verifiedAt: input.row.verifiedAt,
          verification: input.row.verification,
          lastSuccessfulSyncAt: input.row.lastSuccessfulSyncAt,
          lastError: (result.error ?? 'The platform refused the verification call.').slice(0, 500),
          lastErrorKind: permission ? 'FORBIDDEN' : 'UNAVAILABLE',
        });
      }
    }
    return input.prisma.composioConnection.update({ where: { id: input.row.id }, data });
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    if (error.kind === 'NOT_FOUND') {
      return input.prisma.composioConnection.update({
        where: { id: input.row.id },
        data: { remoteStatus: 'REVOKED', statusReason: 'Composio no longer has this account.', lastCheckedAt: now, lastError: null, lastErrorKind: null },
      });
    }
    return input.prisma.composioConnection.update({
      where: { id: input.row.id },
      data: { lastCheckedAt: now, lastError: error.message.slice(0, 500), lastErrorKind: error.kind },
    });
  }
}

export async function disconnect(input: { prisma: PrismaClient; client: ComposioClient; row: ComposioConnection }) {
  await removeRemote(input.client, input.row.composioAccountId);
  await input.prisma.composioConnection.delete({ where: { id: input.row.id } });
}

export function serializeConnection(row: ComposioConnection) {
  return {
    id: row.id,
    clientId: row.clientId,
    toolkit: row.toolkit,
    platform: familyOf(row.toolkit),
    authConfigId: row.authConfigId,
    accountId: row.composioAccountId,
    alias: row.alias,
    remoteStatus: row.remoteStatus,
    statusReason: row.statusReason,
    state: connectionState(row),
    verification: row.verification,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
    lastError: row.lastError,
    replacing: Boolean(row.replacesId),
    createdAt: row.createdAt,
  };
}
