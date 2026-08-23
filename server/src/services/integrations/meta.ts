/**
 * Meta adapter — Facebook, Instagram and Meta Ads through the Graph API.
 *
 * Real endpoints and real request shapes. The HTTP function is injectable so
 * the test suite can drive the exact JSON Meta returns without a network call
 * or a credential; production passes the global `fetch`. That is the difference
 * between an adapter that is tested and one that is merely written.
 *
 * Two behaviours here are deliberate and worth stating:
 *
 * 1. `discoverAccounts` asks for Pages, the Instagram account attached to each
 *    Page, ad accounts and businesses, and returns them *unselected*. Attaching
 *    everything an operator can see would silently wire another brand's ad
 *    account into this client, which is exactly the cross-client leak the whole
 *    integration layer exists to prevent.
 *
 * 2. The short-lived token from the code exchange is immediately traded for a
 *    long-lived one. A ~1 hour token would leave every connection broken by the
 *    time anyone came back to it.
 */

import { Platform } from '@prisma/client';

import { ProviderNotConfiguredError } from './index.js';

/*
 * Pinned versions — two of them, because Meta runs two clocks.
 *
 * The Graph API and the Marketing API share a host and a version *number* but
 * not a lifecycle. A Graph version lives about two years and, once expired,
 * degrades by falling back. A Marketing version lives roughly a year and, once
 * expired, **fails outright** — ad-account calls stop being served rather than
 * quietly answering from an older version.
 *
 * This file previously pinned one constant at v21.0 for both. v21.0 was
 * released 2 October 2024: still inside the Graph window (it expires
 * 21 January 2027), but far outside the Marketing one, so every campaign, ad
 * set, image, creative, ad and insights call in meta-publish.ts was aimed at an
 * expired Marketing API. Publishing could not have worked in production
 * regardless of credentials.
 *
 * Verified 2026-08-16 against secondary sources — developers.facebook.com is
 * unreachable from this build environment (egress proxy), so these values are
 * documented as *needing confirmation against Meta's own changelog* before a
 * production publish:
 *   - v25.0 is the current version (released 18 February 2026)
 *   - Marketing API v23.0 reached end of life 9 June 2026
 *   - v26.0 expected around September 2026
 * See docs/PLATFORM_INTEGRATIONS.md for the sources and the re-check date.
 *
 * Both are environment-overridable so a version bump is a variable change
 * rather than a deploy — Meta's schedule does not wait for our release cycle.
 */
export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v25.0';
export const MARKETING_VERSION = process.env.META_MARKETING_VERSION ?? 'v25.0';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
/** Ad-account surfaces. Same host, different expiry clock. */
export const MARKETING = `https://graph.facebook.com/${MARKETING_VERSION}`;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface MetaConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  /**
   * The Facebook Login for Business configuration id.
   *
   * Business Login does not take a scope list. The permissions *and* the
   * asset-selection step both come from a configuration created in the app
   * console, and `config_id` is how the dialog is told which one to run. Sending
   * scopes instead runs classic consumer login: the operator authorises
   * permissions but is never offered the screen that assigns a Page and an ad
   * account to the app — which is why discovery came back empty.
   */
  configId: string;
}

export class ProviderApiError extends Error {
  readonly platform: Platform;
  readonly status: number;

  constructor(platform: Platform, status: number, message: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.platform = platform;
    this.status = status;
  }
}

export function metaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig {
  const missing = (['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID'] as const).filter(
    (key) => !env[key]?.trim(),
  );
  if (missing.length > 0) throw new ProviderNotConfiguredError('FACEBOOK' as Platform, 'Meta', missing);

  /*
   * Trimmed on the way in.
   *
   * These arrive from a hosting dashboard where a value is pasted by hand, and a
   * trailing newline is invisible in every UI that edits them. Meta rejected an
   * app id in exactly this way — `client_id=…%0A` is not a number to Graph, and
   * the error it returns talks about the app id rather than the whitespace.
   * Cheaper to normalise here than to diagnose again.
   */
  const appId = (env.META_APP_ID as string).trim();
  const configId = (env.META_CONFIG_ID as string).trim();

  /*
   * Refuse a malformed app id here rather than at Facebook.
   *
   * A Meta App ID is a decimal number. Sending anything else produces
   * PLATFORM_INVALID_APP_ID on Facebook's own error page — an error that names
   * the app id but says nothing about which of our variables carries it, and
   * that appears only after the operator has already been redirected away. The
   * common way to get here is pasting the wrong value into the right box:
   * META_CONFIG_ID, an app secret, or a URL.
   *
   * The value never appears in the message. It is not a secret, but the id and
   * the secret sit next to each other in the same dashboard and echoing either
   * one trains everybody to expect credentials in error text.
   */
  if (!APP_ID_FORMAT.test(appId)) {
    throw new ProviderNotConfiguredError('FACEBOOK' as Platform, 'Meta', ['META_APP_ID'], {
      detail:
        'META_APP_ID configuration is invalid: a Meta App ID is a number, 13 to 20 digits long. ' +
        'Copy it from the Meta app dashboard — it is not the configuration id, the app secret, or a URL.',
    });
  }

  if (appId === configId) {
    throw new ProviderNotConfiguredError('FACEBOOK' as Platform, 'Meta', ['META_APP_ID'], {
      detail:
        'META_APP_ID and META_CONFIG_ID hold the same value. The app id identifies the Meta app; ' +
        'the configuration id identifies the Facebook Login for Business configuration inside it. They are never equal.',
    });
  }

  return {
    appId,
    appSecret: (env.META_APP_SECRET as string).trim(),
    redirectUri: (env.META_REDIRECT_URI as string).trim(),
    configId,
  };
}

/**
 * What a Meta App ID looks like.
 *
 * Decimal digits only. The length band is deliberately wide — Meta has issued
 * ids of different lengths over the years and a rule tighter than the format
 * warrants would reject a legitimate new app.
 */
const APP_ID_FORMAT = /^\d{13,20}$/;

/**
 * What can be said about the Meta configuration without saying any of it.
 *
 * Every field here is a shape or a verdict. This is what makes it safe to log
 * at startup and to return from a diagnostics endpoint: an operator debugging a
 * rejected app id needs to know whether the value is numeric and how long it is,
 * and never needs the value itself.
 */
export interface MetaConfigDiagnostics {
  appIdConfigured: boolean;
  appIdLength: number;
  appIdNumeric: boolean;
  appIdEqualsConfigId: boolean;
  appSecretConfigured: boolean;
  redirectUriConfigured: boolean;
  configIdConfigured: boolean;
  /** True when every check passes and an authorization URL can be built. */
  valid: boolean;
}

export function metaConfigDiagnostics(env: NodeJS.ProcessEnv = process.env): MetaConfigDiagnostics {
  const appId = env.META_APP_ID?.trim() ?? '';
  const configId = env.META_CONFIG_ID?.trim() ?? '';
  const appIdNumeric = APP_ID_FORMAT.test(appId);

  const appIdConfigured = appId.length > 0;
  const appSecretConfigured = (env.META_APP_SECRET?.trim().length ?? 0) > 0;
  const redirectUriConfigured = (env.META_REDIRECT_URI?.trim().length ?? 0) > 0;
  const configIdConfigured = configId.length > 0;

  return {
    appIdConfigured,
    // A length is not a value. It is the one number that distinguishes "pasted
    // the config id" from "pasted a URL" without revealing either.
    appIdLength: appId.length,
    appIdNumeric,
    appIdEqualsConfigId: appIdConfigured && appId === configId,
    appSecretConfigured,
    redirectUriConfigured,
    configIdConfigured,
    valid:
      appIdConfigured && appIdNumeric && appId !== configId &&
      appSecretConfigured && redirectUriConfigured && configIdConfigured,
  };
}

export const META_SCOPES = [
  'ads_management',
  'ads_read',
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
];

/**
 * Where the operator is sent to authorise.
 *
 * This is Facebook Login **for Business**, driven by `config_id`. The
 * configuration in the app console owns the permission list and, critically, the
 * asset-selection step where a specific Page and ad account are granted to the
 * app. That step is what makes discovery return anything at all.
 *
 * `scope` is deliberately not sent. Business Login takes its permissions from
 * the configuration, and passing both is contradictory — the classic
 * scope-based dialog would run instead, which is the bug this replaces.
 */
export function authorizationUrl(input: { config: MetaConfig; state: string }): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', input.config.appId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('config_id', input.config.configId);
  return url.toString();
}

async function readJson(response: Awaited<ReturnType<FetchLike>>, context: string): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    // Meta nests the useful part; the raw body may echo request parameters, so
    // only the message is surfaced and never the whole payload.
    const error = payload.error as { message?: string; type?: string } | undefined;
    throw new ProviderApiError(
      'FACEBOOK' as Platform,
      response.status,
      error?.message ? `${context}: ${error.message}` : `${context}: Meta returned HTTP ${response.status}`,
    );
  }
  return payload;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export async function exchangeCode(input: {
  config: MetaConfig;
  code: string;
  fetchImpl: FetchLike;
  now?: Date;
}): Promise<TokenSet> {
  const now = input.now ?? new Date();

  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('client_id', input.config.appId);
  url.searchParams.set('client_secret', input.config.appSecret);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('code', input.code);

  const short = await readJson(await input.fetchImpl(url.toString()), 'Meta token exchange');
  const shortToken = short.access_token as string | undefined;
  if (!shortToken) throw new ProviderApiError('FACEBOOK' as Platform, 502, 'Meta token exchange returned no access token');

  // Trade up immediately: the exchange token expires in about an hour.
  const longUrl = new URL(`${GRAPH}/oauth/access_token`);
  longUrl.searchParams.set('grant_type', 'fb_exchange_token');
  longUrl.searchParams.set('client_id', input.config.appId);
  longUrl.searchParams.set('client_secret', input.config.appSecret);
  longUrl.searchParams.set('fb_exchange_token', shortToken);

  const long = await readJson(await input.fetchImpl(longUrl.toString()), 'Meta long-lived token exchange');
  const accessToken = (long.access_token as string | undefined) ?? shortToken;
  const expiresIn = Number(long.expires_in ?? short.expires_in ?? 0);

  return {
    accessToken,
    // Meta has no refresh token; a long-lived token is re-exchanged instead.
    refreshToken: null,
    expiresAt: expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000) : null,
    scopes: META_SCOPES,
  };
}

export interface DiscoveredAccount {
  kind: 'BUSINESS' | 'PAGE' | 'INSTAGRAM' | 'AD_ACCOUNT';
  externalId: string;
  name: string;
  username?: string;
  currency?: string;
  timezone?: string;
  parentExternalId?: string;
  metadata?: Record<string, unknown>;
  /**
   * The Page's own publishing credential, in plaintext, for the caller to
   * encrypt before it touches the database.
   *
   * Present only for Pages. A Facebook Page is posted to with a Page access
   * token — the user token that discovered it cannot publish as the Page, which
   * is why discovery has to ask for this and not merely note the Page exists.
   *
   * Never logged, never serialised into an API response, never put in an error.
   * `connect-flow` encrypts it on arrival and nothing else reads it.
   */
  accessToken?: string;
}

/**
 * Confirm a token actually works before anything is marked connected.
 *
 * `/me` is the cheapest call that proves the token is live and readable. A
 * connection that skipped this would report CONNECTED on the strength of a
 * token the provider may already have invalidated.
 */
export async function validateToken(input: { accessToken: string; fetchImpl: FetchLike }): Promise<{ id: string; name: string }> {
  const url = new URL(`${GRAPH}/me`);
  url.searchParams.set('fields', 'id,name');
  url.searchParams.set('access_token', input.accessToken);

  const payload = await readJson(await input.fetchImpl(url.toString()), 'Meta token validation');
  const id = payload.id as string | undefined;
  if (!id) throw new ProviderApiError('FACEBOOK' as Platform, 502, 'Meta token validation returned no user id');
  return { id, name: (payload.name as string | undefined) ?? 'Meta user' };
}

export async function discoverAccounts(input: { accessToken: string; fetchImpl: FetchLike }): Promise<DiscoveredAccount[]> {
  const accounts: DiscoveredAccount[] = [];

  // --- Pages, and the Instagram account attached to each -----------------
  const pagesUrl = new URL(`${GRAPH}/me/accounts`);
  /*
   * `access_token` here is the Page token, and it is the reason this call has to
   * request it rather than settle for names and ids. Publishing to a Page uses
   * the Page's own token; the user token is only good for discovering that the
   * Page exists. Without this field the connection completes, looks healthy, and
   * cannot publish anything.
   */
  pagesUrl.searchParams.set(
    'fields',
    'id,name,username,access_token,instagram_business_account{id,username,name}',
  );
  pagesUrl.searchParams.set('access_token', input.accessToken);

  const pages = await readJson(await input.fetchImpl(pagesUrl.toString()), 'Meta page discovery');
  for (const page of (pages.data as Array<Record<string, unknown>> | undefined) ?? []) {
    const pageId = page.id as string;
    accounts.push({
      kind: 'PAGE',
      externalId: pageId,
      name: (page.name as string) ?? 'Facebook Page',
      username: page.username as string | undefined,
      // Absent when the granted permissions do not extend to managing the Page.
      // The account is still recorded — it just cannot publish, and says so.
      accessToken: (page.access_token as string | undefined) ?? undefined,
    });

    const instagram = page.instagram_business_account as Record<string, unknown> | undefined;
    if (instagram?.id) {
      accounts.push({
        kind: 'INSTAGRAM',
        externalId: instagram.id as string,
        name: (instagram.name as string) ?? (instagram.username as string) ?? 'Instagram account',
        username: instagram.username as string | undefined,
        // Publishing to Instagram goes through the Page, so the link matters.
        parentExternalId: pageId,
      });
    }
  }

  // --- Ad accounts -------------------------------------------------------
  const adUrl = new URL(`${GRAPH}/me/adaccounts`);
  adUrl.searchParams.set('fields', 'id,account_id,name,currency,timezone_name,business{id,name}');
  adUrl.searchParams.set('access_token', input.accessToken);

  const adAccounts = await readJson(await input.fetchImpl(adUrl.toString()), 'Meta ad account discovery');
  for (const account of (adAccounts.data as Array<Record<string, unknown>> | undefined) ?? []) {
    const business = account.business as Record<string, unknown> | undefined;
    accounts.push({
      kind: 'AD_ACCOUNT',
      // `id` is the act_ prefixed form the API expects on later calls.
      externalId: (account.id as string) ?? `act_${account.account_id as string}`,
      name: (account.name as string) ?? 'Ad account',
      // The account's own currency. Never assumed — a SAR account reported as
      // USD would corrupt every spend figure downstream.
      currency: account.currency as string | undefined,
      timezone: account.timezone_name as string | undefined,
      parentExternalId: business?.id as string | undefined,
    });
  }

  // --- Businesses --------------------------------------------------------
  const bizUrl = new URL(`${GRAPH}/me/businesses`);
  bizUrl.searchParams.set('fields', 'id,name');
  bizUrl.searchParams.set('access_token', input.accessToken);

  const businesses = await readJson(await input.fetchImpl(bizUrl.toString()), 'Meta business discovery');
  for (const business of (businesses.data as Array<Record<string, unknown>> | undefined) ?? []) {
    accounts.push({
      kind: 'BUSINESS',
      externalId: business.id as string,
      name: (business.name as string) ?? 'Business portfolio',
    });
  }

  return accounts;
}

export interface NormalizedCampaign {
  externalId: string;
  name: string;
  status: string;
  objective: string | null;
  budgetMinor: number | null;
  currency: string | null;
  startDate: Date | null;
  endDate: Date | null;
  metadata: Record<string, unknown>;
}

export async function fetchCampaigns(input: {
  adAccountId: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<NormalizedCampaign[]> {
  // Ad-account edge: Marketing API, which expires on its own faster clock.
  const url = new URL(`${MARKETING}/${input.adAccountId}/campaigns`);
  url.searchParams.set('fields', 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time');
  url.searchParams.set('limit', '200');
  url.searchParams.set('access_token', input.accessToken);

  const payload = await readJson(await input.fetchImpl(url.toString()), 'Meta campaign sync');

  return ((payload.data as Array<Record<string, unknown>> | undefined) ?? []).map((campaign) => ({
    externalId: campaign.id as string,
    name: (campaign.name as string) ?? 'Untitled campaign',
    status: (campaign.status as string) ?? 'UNKNOWN',
    objective: (campaign.objective as string | undefined) ?? null,
    // Meta reports budgets in minor units as strings. Kept in minor units here
    // so no rounding happens before the currency is known.
    budgetMinor: campaign.daily_budget
      ? Number(campaign.daily_budget)
      : campaign.lifetime_budget
        ? Number(campaign.lifetime_budget)
        : null,
    currency: null,
    startDate: campaign.start_time ? new Date(campaign.start_time as string) : null,
    endDate: campaign.stop_time ? new Date(campaign.stop_time as string) : null,
    metadata: { raw: campaign },
  }));
}

export interface NormalizedInsight {
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
}

/**
 * Daily insights for one campaign.
 *
 * Conversions and their value come from the `actions` / `action_values` arrays
 * and are **absent** far more often than not — they need a Pixel and a
 * configured event. When absent the figure is 0 *and the caller is told the
 * campaign reported no conversion actions*, because the finance engine must be
 * able to tell "no conversions happened" from "conversions were not measured".
 */
export function normalizeInsights(rows: Array<Record<string, unknown>>): {
  insights: NormalizedInsight[];
  hasConversionTracking: boolean;
} {
  let hasConversionTracking = false;

  const insights = rows.map((row) => {
    const actions = (row.actions as Array<Record<string, unknown>> | undefined) ?? [];
    const values = (row.action_values as Array<Record<string, unknown>> | undefined) ?? [];
    if (actions.length > 0) hasConversionTracking = true;

    const purchase = actions.find((action) => String(action.action_type).includes('purchase'));
    const purchaseValue = values.find((value) => String(value.action_type).includes('purchase'));

    return {
      date: (row.date_start as string) ?? '',
      spend: Number(row.spend ?? 0),
      impressions: Number(row.impressions ?? 0),
      reach: Number(row.reach ?? 0),
      clicks: Number(row.clicks ?? 0),
      conversions: purchase ? Number(purchase.value ?? 0) : 0,
      conversionValue: purchaseValue ? Number(purchaseValue.value ?? 0) : 0,
    };
  });

  return { insights, hasConversionTracking };
}

export async function fetchInsights(input: {
  campaignId: string;
  accessToken: string;
  since: string;
  until: string;
  fetchImpl: FetchLike;
}): Promise<{ insights: NormalizedInsight[]; hasConversionTracking: boolean }> {
  // Insights is a Marketing API surface, not a Graph one.
  const url = new URL(`${MARKETING}/${input.campaignId}/insights`);
  url.searchParams.set('fields', 'spend,impressions,reach,clicks,actions,action_values,date_start');
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('time_range', JSON.stringify({ since: input.since, until: input.until }));
  url.searchParams.set('access_token', input.accessToken);

  const payload = await readJson(await input.fetchImpl(url.toString()), 'Meta insight sync');
  return normalizeInsights((payload.data as Array<Record<string, unknown>> | undefined) ?? []);
}
