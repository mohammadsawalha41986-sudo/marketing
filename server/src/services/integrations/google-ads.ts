/**
 * Google Ads, as a provider adapter — OAuth 2.0 and customer discovery.
 *
 * Shaped like `youtube.ts`: the OAuth half is `google.ts` and nothing about
 * tokens is written twice. What is genuinely different about Google Ads lives
 * here, and it is three things.
 *
 * **It is one OAuth application for every client.** NORIVA owns a single Google
 * Cloud OAuth client; each restaurant authorises its own Google login through
 * it and the resulting credential is stored against that client's integration
 * row. That is the same shape Business Profile and YouTube already have, and it
 * is why this file takes a config rather than reading one per tenant.
 *
 * **Access is a property of the Google Cloud project, not a second credential.**
 * Google sunset developer tokens on 9 September 2026: the access level that
 * decides what the API will answer now attaches to the Cloud project whose
 * OAuth client issued the credential. The `developer-token` header is still
 * accepted and ignored, so it is sent when `GOOGLE_ADS_DEVELOPER_TOKEN` happens
 * to be set — a deployment mid-migration keeps working — and never required.
 * Requiring it would report a correctly configured project as unconfigured and
 * block a connection the API would have answered.
 *
 * What replaces it as a real constraint is the project's access level. Explorer
 * is granted automatically and reaches production accounts at 2,880 operations
 * a day; nothing this module calls is outside it. Exceeding the cap, or calling
 * something the level does not cover, fails with a message about access rather
 * than about credentials, which is why `ACCESS_LEVEL` is classified apart from
 * an expired login.
 *
 * **The login is not the account.** A Google login may administer no ad
 * accounts, one, or a manager hierarchy containing dozens. `customer.id` is the
 * thing campaigns belong to and it is unrelated to the email that authorised —
 * so discovery enumerates customers and the operator attaches one, exactly as
 * Meta's ad accounts are attached. Manager accounts are returned alongside the
 * accounts beneath them, marked, because a manager is a real login target for
 * reporting but a poor one to attach for spend.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';
import type { DiscoveredAccount, FetchLike } from './meta.js';
import type { GoogleConfig } from './google.js';

/**
 * The Ads API version this integration speaks.
 *
 * Pinned in one place: Google retires versions on a published schedule and a
 * string repeated across four call sites is how half an integration ends up on
 * a version the other half has left behind.
 */
export const ADS_API_VERSION = 'v17';
const API = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

/**
 * The grant that makes the Google Ads API answer at all.
 *
 * Spelled out rather than read from `google.ts`'s `FUTURE_SCOPES`: that module
 * and this one sit in an import cycle through `index.ts`, and a top-level read
 * of a value from the other side of a cycle resolves to `undefined` depending
 * on which module is entered first. `google-ads.test.ts` asserts the two agree.
 */
export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';

/**
 * What this integration asks for.
 *
 * `adwords` is the one that matters. `openid` and `userinfo.email` are included
 * because the connection is validated against Google's userinfo endpoint before
 * anything is marked connected — the same proof-of-life step every other
 * provider performs — and that endpoint answers nothing to a token holding only
 * `adwords`. Asking for identity is not scope inflation here; it is what makes
 * the existing validation step work.
 */
export const GOOGLE_ADS_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  ADWORDS_SCOPE,
] as const;

/**
 * Google Ads carries its own configuration.
 *
 * The OAuth client is deliberately shared with Business Profile and YouTube —
 * one Google Cloud application, several products — but the redirect URI is its
 * own. Sharing `GOOGLE_REDIRECT_URI` would point the Ads consent at Business
 * Profile's callback route, and the callback route is the independent witness
 * of which provider redirected.
 *
 * Sharing the OAuth client also means sharing the Cloud project, and the Cloud
 * project is now what carries Google Ads API access. That is the arrangement
 * this integration wants: one project, one access level, every client's
 * authorisation flowing through it.
 */
export interface GoogleAdsConfig extends GoogleConfig {
  /** Sunset by Google and ignored by the API. Sent only when a deployment still holds one. */
  developerToken: string | null;
  /** Set only when a manager account must be named on every request. */
  loginCustomerId: string | null;
}

/**
 * Two variables, and only two.
 *
 * `GOOGLE_ADS_REDIRECT_URI` is optional like YouTube's: unset means "derive it
 * from the request host", which `beginAuthorization` already does and already
 * validates against the mounted callback path.
 *
 * `GOOGLE_ADS_DEVELOPER_TOKEN` is optional because Google sunset developer
 * tokens on 9 September 2026 and the API ignores the header. Access now comes
 * from the Cloud project behind the OAuth client, so a deployment holding only
 * a client id and secret is fully configured, and demanding a third credential
 * would refuse a connection Google would have accepted.
 */
const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

export function googleAdsConfig(env: NodeJS.ProcessEnv = process.env): GoogleAdsConfig {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) throw new ProviderNotConfiguredError(Platform.GOOGLE_ADS, 'Google Ads', [...missing]);

  // Trimmed on the way in, as every other provider's are: these are pasted by
  // hand into a hosting dashboard and a trailing newline is invisible in the UI
  // that edits them while being fatal in an OAuth parameter or an HTTP header.
  return {
    clientId: env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    redirectUri: env.GOOGLE_ADS_REDIRECT_URI?.trim() ?? '',
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || null,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() || null,
  };
}

/** Whether Google Ads is configured at all, without throwing. For diagnostics. */
export function googleAdsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return REQUIRED.every((key) => Boolean(env[key]?.trim()));
}

/** Customer ids are stored and displayed with dashes; the API takes digits. */
export function normalizeCustomerId(customerId: string): string {
  return customerId.replace(/\D/g, '');
}

/** 1234567890 → 123-456-7890, which is how Google Ads shows it to a human. */
export function formatCustomerId(customerId: string): string {
  const digits = normalizeCustomerId(customerId);
  return digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : digits;
}

/**
 * Google Ads reports failure with an HTTP status and a body whose useful part
 * is nested two or three levels down, and the useful part is what tells an
 * operator whether to re-consent, ask Google for access, or pick a different
 * account. Flattening it to "HTTP 403" throws that away.
 */
function describeError(payload: Record<string, unknown>, status: number): string {
  const error = payload.error as Record<string, unknown> | undefined;
  if (!error) return `HTTP ${status}`;

  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    const errors = (detail as Record<string, unknown>)?.errors;
    if (!Array.isArray(errors) || errors.length === 0) continue;
    const first = errors[0] as Record<string, unknown>;
    const message = first.message as string | undefined;
    if (message) return message;
  }

  return (error.message as string | undefined) ?? `HTTP ${status}`;
}

/**
 * The failures that mean something specific, named so the UI can say Google Ads
 * rather than "request failed".
 *
 * `ACCESS_LEVEL` is the one worth separating. Since developer tokens were
 * sunset on 9 September 2026, what gates the API is the Google Cloud project's
 * access level — Explorer reaches production accounts at 2,880 operations a
 * day and excludes billing, account creation and the planning services. A call
 * refused for that reason fails no matter who authorises it, so telling the
 * operator to reconnect would be advice that cannot work. It is a deployment
 * fact, not a client one.
 *
 * The legacy developer-token refusal is folded into the same state: a
 * deployment still carrying an unapproved token sees the same message, and
 * the remedy — raise the project's access with Google — is now the same too.
 */
export type GoogleAdsFailure =
  | 'INVALID_TOKEN'
  | 'ACCESS_LEVEL'
  | 'NOT_AUTHORIZED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_REQUEST';

export function classifyAdsError(message: string, status: number): GoogleAdsFailure {
  const text = message.toLowerCase();

  /*
   * Access-level refusals first: they are the only ones a correct credential
   * cannot fix, and Google words several of them with 'permission' or 'quota'
   * language that the later branches would otherwise capture.
   */
  if (/developer.?token|access.?level|not.?adwords.?manager|operation.?limit/.test(text)) return 'ACCESS_LEVEL';
  if (/invalid.?grant|token.?expired|invalid.?credential|unauthenticated/.test(text)) return 'INVALID_TOKEN';
  if (status === 401) return 'INVALID_TOKEN';
  if (/customer.?not.?found|not.?ad.?words.?user|user.?permission.?denied/.test(text)) return 'NOT_AUTHORIZED';
  if (status === 403) return 'NOT_AUTHORIZED';
  if (/quota|rate.?limit|resource.?exhausted/.test(text) || status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'INVALID_REQUEST';
}

/** What an operator should be told, per failure. Never a stack trace. */
export const ADS_FAILURE_EXPLANATION: Record<GoogleAdsFailure, string> = {
  INVALID_TOKEN:
    'The Google Ads authorisation has expired or been revoked. Reconnect Google Ads for this client.',
  ACCESS_LEVEL:
    'Google Ads refused this request at the account level: the Google Cloud project behind this '
    + 'deployment does not have the API access it needs, or has used its daily operation allowance. '
    + 'This cannot be fixed by reconnecting.',
  NOT_AUTHORIZED:
    'The authorised Google account cannot access this Google Ads account. Choose a different account, '
    + 'or ask the account owner to grant access.',
  RATE_LIMITED: 'Google Ads is rate limiting this app. The request will be retried later.',
  PROVIDER_UNAVAILABLE: 'Google Ads is temporarily unavailable.',
  INVALID_REQUEST: 'Google Ads rejected the request.',
};

/**
 * Extends `Error` directly rather than `ProviderApiError`, deliberately.
 *
 * `index.ts` imports this module for the adapter's scope list, and `meta.ts` —
 * where `ProviderApiError` lives — imports `index.ts`. Subclassing across that
 * cycle evaluates `extends` while `meta.ts` is still initialising, so the base
 * class is undefined and the whole server fails to boot. The shape is kept
 * identical (`platform`, `status`) so every existing `instanceof`-free consumer
 * reads it the same way.
 */
export class GoogleAdsError extends Error {
  readonly platform = Platform.GOOGLE_ADS;
  readonly status: number;
  readonly failure: GoogleAdsFailure;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoogleAdsError';
    this.status = status;
    this.failure = classifyAdsError(message, status);
  }

  /** Safe for a UI: no token material, no stack, and it names Google Ads. */
  get explanation(): string {
    return ADS_FAILURE_EXPLANATION[this.failure];
  }
}

function headers(input: {
  accessToken: string;
  developerToken?: string | null;
  loginCustomerId?: string | null;
}): Record<string, string> {
  const built: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    'content-type': 'application/json',
  };
  /*
   * Sent only when a deployment still holds one. Google ignores the header
   * since the 9 September 2026 sunset, so an absent token is not a failure —
   * but a deployment that has not yet cleared the variable should not start
   * behaving differently on the day it upgrades.
   */
  if (input.developerToken) built['developer-token'] = input.developerToken;
  /*
   * `login-customer-id` is the manager the request acts through. It is required
   * when reaching a client account via its manager and harmless when the
   * account is reached directly, so it is set whenever one is known.
   */
  if (input.loginCustomerId) built['login-customer-id'] = normalizeCustomerId(input.loginCustomerId);
  return built;
}

async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();

  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      // A search response is an object; a searchStream response is an array of
      // them. Both arrive here, and only the object form carries `error`.
      payload = Array.isArray(parsed)
        ? { results: parsed.flatMap((chunk) => (chunk as Record<string, unknown>)?.results ?? []) }
        : (parsed as Record<string, unknown>);
    } catch {
      throw new GoogleAdsError(response.status, `${context}: Google Ads returned an unreadable response`);
    }
  }

  if (!response.ok || payload.error) {
    throw new GoogleAdsError(response.status, `${context}: ${describeError(payload, response.status)}`);
  }
  return payload;
}

// ------------------------------------------------------------------- oauth

/**
 * Google Ads authorises through the shared Google OAuth client.
 *
 * Re-exported rather than reimplemented so that offline access, the mandatory
 * `prompt=consent`, the refusal to store a refresh-token-less grant, and the
 * refresh call itself all stay in exactly one place. A second copy of that
 * logic is a second place for the refresh token to be silently dropped.
 */
export { authorizationUrl, exchangeCode, refreshAccessToken, validateToken } from './google.js';

// --------------------------------------------------------------- discovery

export interface GoogleAdsCustomer {
  /** Digits only, as the API addresses it. */
  id: string;
  descriptiveName: string;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  testAccount: boolean;
  /** The manager this account was reached through, when it was. */
  managerCustomerId: string | null;
}

interface RawCustomer {
  id?: string;
  descriptiveName?: string;
  currencyCode?: string;
  timeZone?: string;
  manager?: boolean;
  testAccount?: boolean;
}

/**
 * Every customer id this login can address, as Google reports them.
 *
 * This is the only endpoint that answers "what does this person have access
 * to"; everything after it is detail lookup.
 */
export async function listAccessibleCustomers(input: {
  accessToken: string;
  developerToken?: string | null;
  loginCustomerId?: string | null;
  fetchImpl: FetchLike;
}): Promise<string[]> {
  const payload = await readJson(
    await input.fetchImpl(`${API}/customers:listAccessibleCustomers`, {
      method: 'GET',
      headers: headers(input),
    }),
    'Google Ads accessible customers',
  );

  const names = Array.isArray(payload.resourceNames) ? payload.resourceNames : [];
  return names
    .map((name) => normalizeCustomerId(String(name)))
    .filter((id) => id.length > 0);
}

/** One GAQL query against one customer. */
async function search(input: {
  customerId: string;
  query: string;
  accessToken: string;
  developerToken?: string | null;
  loginCustomerId?: string | null;
  fetchImpl: FetchLike;
  context: string;
}): Promise<Record<string, unknown>[]> {
  const payload = await readJson(
    await input.fetchImpl(`${API}/customers/${normalizeCustomerId(input.customerId)}/googleAds:search`, {
      method: 'POST',
      headers: headers(input),
      body: JSON.stringify({ query: input.query, pageSize: 1000 }),
    }),
    input.context,
  );

  return Array.isArray(payload.results) ? (payload.results as Record<string, unknown>[]) : [];
}

function toCustomer(row: RawCustomer, managerCustomerId: string | null): GoogleAdsCustomer | null {
  const id = normalizeCustomerId(String(row.id ?? ''));
  if (!id) return null;

  return {
    id,
    // A Google Ads account may genuinely have no descriptive name. Showing the
    // formatted id is better than an empty row the operator cannot identify.
    descriptiveName: row.descriptiveName?.trim() || formatCustomerId(id),
    currencyCode: row.currencyCode ?? null,
    timeZone: row.timeZone ?? null,
    manager: Boolean(row.manager),
    testAccount: Boolean(row.testAccount),
    managerCustomerId,
  };
}

const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, '
  + 'customer.manager, customer.test_account FROM customer LIMIT 1';

/*
 * Children of a manager, one level down.
 *
 * `customer_client.level <= 1` keeps a deep agency hierarchy from returning
 * several hundred rows onto a selection screen. Anyone who needs a grandchild
 * account can authorise against the manager that owns it directly — an
 * unbounded tree walk here would be slow, rate-limit-hungry, and produce a list
 * nobody can read.
 */
const CLIENT_QUERY =
  'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, '
  + 'customer_client.time_zone, customer_client.manager, customer_client.test_account, customer_client.level '
  + 'FROM customer_client WHERE customer_client.level <= 1';

/**
 * The Google Ads accounts this login can actually use.
 *
 * Resilient by design: one inaccessible customer in a list of twenty must not
 * fail discovery for the other nineteen — `listAccessibleCustomers` routinely
 * returns ids whose detail read is refused. Failures are collected, and only a
 * total failure is raised, because "no accounts" and "every lookup was refused"
 * need different actions from the operator.
 */
export async function listCustomers(input: {
  accessToken: string;
  developerToken?: string | null;
  loginCustomerId?: string | null;
  fetchImpl: FetchLike;
}): Promise<{ customers: GoogleAdsCustomer[]; failures: Array<{ customerId: string; message: string }> }> {
  const ids = await listAccessibleCustomers(input);

  const customers = new Map<string, GoogleAdsCustomer>();
  const failures: Array<{ customerId: string; message: string }> = [];

  for (const id of ids) {
    try {
      const rows = await search({
        ...input,
        customerId: id,
        // Acting as itself: a directly accessible customer needs no manager.
        loginCustomerId: input.loginCustomerId ?? id,
        query: CUSTOMER_QUERY,
        context: 'Google Ads customer',
      });

      const customer = toCustomer(
        (rows[0]?.customer ?? {}) as RawCustomer,
        null,
      );
      if (!customer) continue;
      customers.set(customer.id, customer);

      // A manager is worth attaching for reporting, but the accounts beneath it
      // are where campaigns and spend actually live.
      if (customer.manager) {
        const children = await search({
          ...input,
          customerId: id,
          loginCustomerId: id,
          query: CLIENT_QUERY,
          context: 'Google Ads client accounts',
        });

        for (const row of children) {
          const child = toCustomer((row.customerClient ?? {}) as RawCustomer, customer.id);
          // Never let a child overwrite an account discovered in its own right:
          // the direct read is the more authoritative of the two.
          if (child && child.id !== customer.id && !customers.has(child.id)) {
            customers.set(child.id, child);
          }
        }
      }
    } catch (error) {
      failures.push({
        customerId: id,
        message: error instanceof GoogleAdsError ? error.explanation : 'Google Ads refused this account.',
      });
    }
  }

  /*
   * Nothing readable and something refused is not the same as "this login has
   * no ad accounts", and the two need different actions from the operator, so
   * the refusal is raised rather than returned as an empty list.
   */
  const [firstFailure] = failures;
  if (customers.size === 0 && firstFailure) {
    throw new GoogleAdsError(403, `Google Ads accessible customers: ${firstFailure.message}`);
  }

  return { customers: [...customers.values()], failures };
}

/**
 * Discovery, in the shape `connect-flow` attaches.
 *
 * The developer token is read here rather than passed in because discovery is
 * called through the provider interface, which knows only about access tokens —
 * and refusing by name now is far better than letting every call fail later
 * with a message that reads like an expired login.
 */
export async function discoverAccounts(input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<DiscoveredAccount[]> {
  const config = googleAdsConfig();

  const { customers } = await listCustomers({
    accessToken: input.accessToken,
    developerToken: config.developerToken,
    loginCustomerId: config.loginCustomerId,
    fetchImpl: input.fetchImpl,
  });

  return customers.map((customer) => ({
    kind: 'AD_ACCOUNT' as DiscoveredAccount['kind'],
    externalId: customer.id,
    name: customer.manager ? `${customer.descriptiveName} (manager)` : customer.descriptiveName,
    currency: customer.currencyCode ?? undefined,
    timezone: customer.timeZone ?? undefined,
    parentExternalId: customer.managerCustomerId ?? undefined,
    /*
     * No per-account credential. Google Ads authorises the *login*, and the
     * same access token addresses every customer that login can reach — unlike
     * a Facebook Page, which carries its own token. `connect-flow` records the
     * account as usable on the strength of the connection's own token.
     */
    accessToken: input.accessToken,
    metadata: {
      manager: customer.manager,
      testAccount: customer.testAccount,
      managerCustomerId: customer.managerCustomerId,
      formattedId: formatCustomerId(customer.id),
      currencyCode: customer.currencyCode,
      timeZone: customer.timeZone,
    },
  }));
}

// ----------------------------------------------------------------- reading

export interface GoogleAdsCampaignRow {
  campaignId: string;
  name: string;
  status: string;
  advertisingChannelType: string | null;
  /** Daily budget in account currency. Null when the campaign has no budget. */
  dailyBudget: number | null;
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  /** Account currency units, not micros. */
  cost: number;
  conversions: number;
  conversionValue: number;
}

/** Google reports money in millionths of the account currency. */
function fromMicros(value: unknown): number {
  const micros = Number(value ?? 0);
  return Number.isFinite(micros) ? micros / 1_000_000 : 0;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Daily campaign performance over a date range.
 *
 * Segmented by day rather than summed, because `AnalyticsSnapshot` is grained
 * campaign + platform + day and a range total cannot be written into it without
 * inventing a distribution across the days it covers.
 *
 * CTR, CPC and every other ratio are deliberately *not* requested. The existing
 * `analytics.ts` derives them from the stored totals and refuses to derive one
 * it cannot; reading Google's own rounded ratios alongside would give the
 * application two answers to the same question.
 */
export async function fetchCampaignReport(input: {
  customerId: string;
  accessToken: string;
  developerToken?: string | null;
  loginCustomerId?: string | null;
  since: string;
  until: string;
  campaignIds?: string[];
  fetchImpl: FetchLike;
}): Promise<GoogleAdsCampaignRow[]> {
  /*
   * Dates are interpolated rather than parameterised because GAQL has no bind
   * parameters. They are constrained to YYYY-MM-DD first, so nothing an
   * operator controls reaches the query as free text.
   */
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(input.since) || !day.test(input.until)) {
    throw new GoogleAdsError(400, 'Google Ads report: the date range must be YYYY-MM-DD.');
  }

  const filters = [`segments.date BETWEEN '${input.since}' AND '${input.until}'`];
  if (input.campaignIds && input.campaignIds.length > 0) {
    const ids = input.campaignIds.map((id) => normalizeCustomerId(id)).filter(Boolean);
    if (ids.length === 0) return [];
    filters.push(`campaign.id IN (${ids.join(',')})`);
  }

  const query =
    'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, '
    + 'campaign_budget.amount_micros, segments.date, metrics.impressions, metrics.clicks, '
    + 'metrics.cost_micros, metrics.conversions, metrics.conversions_value '
    + `FROM campaign WHERE ${filters.join(' AND ')} ORDER BY segments.date`;

  const rows = await search({
    customerId: input.customerId,
    query,
    accessToken: input.accessToken,
    developerToken: input.developerToken,
    loginCustomerId: input.loginCustomerId ?? input.customerId,
    fetchImpl: input.fetchImpl,
    context: 'Google Ads campaign report',
  });

  return rows.flatMap((row) => {
    const campaign = (row.campaign ?? {}) as Record<string, unknown>;
    const budget = (row.campaignBudget ?? {}) as Record<string, unknown>;
    const segments = (row.segments ?? {}) as Record<string, unknown>;
    const metrics = (row.metrics ?? {}) as Record<string, unknown>;

    const campaignId = String(campaign.id ?? '');
    const date = String(segments.date ?? '');
    // A row without either is not attributable to a campaign-day and is dropped
    // rather than written under a guessed key.
    if (!campaignId || !date) return [];

    const costMicros = toNumber(metrics.costMicros);

    return [{
      campaignId,
      name: String(campaign.name ?? formatCustomerId(campaignId)),
      status: String(campaign.status ?? 'UNKNOWN'),
      advertisingChannelType: (campaign.advertisingChannelType as string | undefined) ?? null,
      dailyBudget: budget.amountMicros === undefined ? null : fromMicros(budget.amountMicros),
      date,
      impressions: Math.round(toNumber(metrics.impressions)),
      clicks: Math.round(toNumber(metrics.clicks)),
      costMicros,
      cost: costMicros / 1_000_000,
      conversions: toNumber(metrics.conversions),
      conversionValue: toNumber(metrics.conversionsValue),
    }];
  });
}
