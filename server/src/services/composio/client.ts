/**
 * Composio's REST API, the parts this application uses.
 *
 * Plain `fetch`, like every other provider here, so tests inject a fake and no
 * SDK sits between us and the wire. The endpoints, the `x-api-key` header, the
 * comma-separated array query format and the response fields were taken from
 * Composio's own generated client (`@composio/client` 0.1.0-alpha.76, the
 * version `@composio/core` 0.25.0 depends on), because docs.composio.dev was
 * unreachable from the environment this was written in. When Composio ships a
 * breaking v3.x, this file is the one place to change.
 *
 * Two things Composio returns are never passed on:
 *
 *   auth config `credentials` — the OAuth app's client secret for a custom
 *                               auth config;
 *   connected account `state` and `data` — the end user's access and refresh
 *                               tokens.
 *
 * Both are dropped in the mappers below, so nothing downstream can forward them
 * by accident.
 */

export type ComposioFetch = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Composio's own statuses, verbatim. */
export const REMOTE_STATUSES = [
  'INITIALIZING', 'INITIATED', 'ACTIVE', 'FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED',
] as const;
export type RemoteStatus = (typeof REMOTE_STATUSES)[number];

export type ComposioErrorKind =
  | 'NOT_CONFIGURED' | 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMIT' | 'BAD_REQUEST' | 'UNAVAILABLE' | 'NETWORK';

export class ComposioError extends Error {
  readonly status: number | null;
  readonly kind: ComposioErrorKind;
  constructor(kind: ComposioErrorKind, status: number | null, message: string) {
    super(message);
    this.name = 'ComposioError';
    this.kind = kind;
    this.status = status;
  }
}

export function composioConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.COMPOSIO_API_KEY?.trim());
}

function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.COMPOSIO_BASE_URL?.trim() || 'https://backend.composio.dev').replace(/\/+$/, '');
}

function kindFor(status: number): ComposioErrorKind {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UNAVAILABLE';
  return 'BAD_REQUEST';
}

/** Recorded for every call, success or not, for the consumption dashboard. */
export type CallMeter = (call: { operation: string; success: boolean; httpStatus: number | null }) => void;

export interface ComposioClient {
  listAuthConfigs(): Promise<AuthConfigSummary[]>;
  createLink(input: { authConfigId: string; userId: string; callbackUrl: string; alias?: string }): Promise<LinkResult>;
  listAccounts(input: { userId: string }): Promise<RemoteAccount[]>;
  getAccount(id: string): Promise<RemoteAccount>;
  deleteAccount(id: string): Promise<void>;
  executeTool(input: { toolSlug: string; connectedAccountId: string; userId: string; arguments?: Record<string, unknown> }): Promise<{ successful: boolean; error: string | null }>;
  /** Whether Composio knows a toolkit by this slug. */
  toolkitExists(slug: string): Promise<boolean>;
}

/**
 * Can this host reach Composio at all — DNS, TLS, route — independent of the
 * key. An unauthenticated request answering 401 proves the path is open, which
 * is the question to settle before blaming a key or a config.
 */
export async function probeReachability(fetchImpl: ComposioFetch, env: NodeJS.ProcessEnv = process.env): Promise<{
  reachable: boolean; httpStatus: number | null; detail: string;
}> {
  try {
    const response = await fetchImpl(`${baseUrl(env)}/api/v3.1/toolkits?limit=1`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    return { reachable: true, httpStatus: response.status, detail: `${baseUrl(env)} answered HTTP ${response.status}.` };
  } catch (error) {
    return { reachable: false, httpStatus: null, detail: `${baseUrl(env)} could not be reached (${(error as Error).name}: ${(error as Error).message.slice(0, 120)}).` };
  }
}

export interface AuthConfigSummary {
  id: string;
  name: string;
  toolkit: string;
  authScheme: string | null;
  managedByComposio: boolean;
  enabled: boolean;
}

export interface LinkResult {
  connectedAccountId: string;
  redirectUrl: string;
  expiresAt: string | null;
}

export interface RemoteAccount {
  id: string;
  userId: string;
  toolkit: string;
  authConfigId: string;
  status: RemoteStatus;
  statusReason: string | null;
  alias: string | null;
  disabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

function asRemoteAccount(item: Record<string, unknown>): RemoteAccount {
  const status = String(item.status ?? '') as RemoteStatus;
  return {
    id: String(item.id),
    userId: String(item.user_id ?? ''),
    toolkit: String((item.toolkit as { slug?: string } | undefined)?.slug ?? ''),
    authConfigId: String((item.auth_config as { id?: string } | undefined)?.id ?? ''),
    status: (REMOTE_STATUSES as readonly string[]).includes(status) ? status : 'FAILED',
    statusReason: (item.status_reason as string | null | undefined) ?? null,
    alias: (item.alias as string | null | undefined) ?? null,
    disabled: Boolean(item.is_disabled),
    createdAt: (item.created_at as string | undefined) ?? null,
    updatedAt: (item.updated_at as string | undefined) ?? null,
    // `state` and `data` deliberately not read: they carry the user's tokens.
  };
}

export function createComposioClient(input: {
  fetchImpl: ComposioFetch;
  meter?: CallMeter;
  env?: NodeJS.ProcessEnv;
}): ComposioClient {
  const env = input.env ?? process.env;
  const apiKey = env.COMPOSIO_API_KEY?.trim();

  async function call(operation: string, method: string, path: string, opts: {
    query?: Record<string, string | undefined>;
    body?: unknown;
  } = {}): Promise<Record<string, unknown>> {
    if (!apiKey) {
      throw new ComposioError('NOT_CONFIGURED', null, 'Composio is not configured: set COMPOSIO_API_KEY on the server.');
    }
    const url = new URL(`${baseUrl(env)}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Awaited<ReturnType<ComposioFetch>>;
    try {
      response = await input.fetchImpl(url.toString(), {
        method,
        headers: {
          'x-api-key': apiKey,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      input.meter?.({ operation, success: false, httpStatus: null });
      throw new ComposioError('NETWORK', null, `Composio could not be reached (${(error as Error).name}).`);
    }

    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }
    input.meter?.({ operation, success: response.ok, httpStatus: response.status });

    if (!response.ok) {
      const error = payload.error as { message?: string } | string | undefined;
      const detail = typeof error === 'string' ? error : error?.message ?? (payload.message as string | undefined);
      // The key is never in a Composio error body, but the message is capped so
      // a verbose upstream answer cannot flood a log or a screen.
      throw new ComposioError(
        kindFor(response.status),
        response.status,
        `Composio ${operation} failed (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`,
      );
    }
    return payload;
  }

  return {
    async listAuthConfigs() {
      const payload = await call('auth_configs.list', 'GET', '/api/v3.1/auth_configs', { query: { limit: '100' } });
      const items = (payload.items as Array<Record<string, unknown>> | undefined) ?? [];
      return items.map((item) => ({
        id: String(item.id),
        name: String(item.name ?? ''),
        toolkit: String((item.toolkit as { slug?: string } | undefined)?.slug ?? ''),
        authScheme: (item.auth_scheme as string | undefined) ?? null,
        managedByComposio: Boolean(item.is_composio_managed),
        enabled: item.status === 'ENABLED',
        // `credentials` deliberately not read: it is the OAuth app secret.
      }));
    },

    async createLink({ authConfigId, userId, callbackUrl, alias }) {
      const payload = await call('connected_accounts.link', 'POST', '/api/v3.1/connected_accounts/link', {
        body: { auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl, ...(alias ? { alias } : {}) },
      });
      const redirectUrl = payload.redirect_url as string | undefined;
      const connectedAccountId = payload.connected_account_id as string | undefined;
      if (!redirectUrl || !connectedAccountId) {
        throw new ComposioError('UNAVAILABLE', 200, 'Composio returned no connect link.');
      }
      return { connectedAccountId, redirectUrl, expiresAt: (payload.expires_at as string | undefined) ?? null };
    },

    async listAccounts({ userId }) {
      const accounts: RemoteAccount[] = [];
      let cursor: string | undefined;
      // Paged; bounded so a misbehaving cursor cannot loop forever.
      for (let page = 0; page < 20; page += 1) {
        const payload = await call('connected_accounts.list', 'GET', '/api/v3.1/connected_accounts', {
          query: { user_ids: userId, limit: '100', cursor },
        });
        for (const item of (payload.items as Array<Record<string, unknown>> | undefined) ?? []) {
          accounts.push(asRemoteAccount(item));
        }
        cursor = (payload.next_cursor as string | null | undefined) ?? undefined;
        if (!cursor) break;
      }
      return accounts;
    },

    async getAccount(id) {
      return asRemoteAccount(await call('connected_accounts.get', 'GET', `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`));
    },

    async deleteAccount(id) {
      await call('connected_accounts.delete', 'DELETE', `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
    },

    async executeTool({ toolSlug, connectedAccountId, userId, arguments: args }) {
      const payload = await call('tools.execute', 'POST', `/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`, {
        body: { connected_account_id: connectedAccountId, user_id: userId, arguments: args ?? {} },
      });
      return {
        successful: Boolean(payload.successful),
        error: (payload.error as string | null | undefined) ?? null,
        // `data` deliberately not returned: it is the provider's payload.
      };
    },

    async toolkitExists(slug) {
      try {
        await call('toolkits.get', 'GET', `/api/v3.1/toolkits/${encodeURIComponent(slug)}`);
        return true;
      } catch (error) {
        if (error instanceof ComposioError && (error.kind === 'NOT_FOUND' || error.kind === 'BAD_REQUEST')) return false;
        throw error;
      }
    },
  };
}
