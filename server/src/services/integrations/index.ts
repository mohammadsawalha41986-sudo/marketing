/**
 * Ad-platform integration architecture.
 *
 * Each platform has an adapter carrying its real OAuth descriptor — the actual
 * authorize endpoint, the scopes the provider requires, and the environment
 * variables that must be present before a connection can even be attempted.
 *
 * Readiness is deliberately not a boolean. "Cannot connect" has several
 * distinct causes and they need different actions from whoever is reading the
 * screen, so `providerReadiness()` reports which one applies:
 *
 *   NOT_CONFIGURED   credentials are missing — name them, so the operator
 *                    knows exactly what to add
 *   NO_ENCRYPTION    credentials exist but TOKEN_ENCRYPTION_KEY does not, so
 *                    tokens could not be stored safely even if OAuth succeeded
 *   READY            everything needed to start OAuth is present
 *
 * The one state this must never report is a vague "not implemented", which
 * tells the operator nothing they can act on and is indistinguishable from a
 * bug. A connection still only becomes CONNECTED after a real provider API call
 * succeeds — configuration alone is never treated as a connection.
 */

import type { Platform } from '@prisma/client';

import { encryptionConfigured } from '../../lib/crypto.js';
/*
 * Imported rather than restated so the scopes an operator reads here are the
 * ones the authorization URL actually asks for. The cycle this creates
 * (tiktok.ts imports ProviderNotConfiguredError from this file) is resolved at
 * call time — both sides use the other only inside function bodies, never at
 * module evaluation — which is the same shape meta.ts already has.
 */
import { TIKTOK_SCOPES } from './tiktok.js';

export interface AdapterMetric {
  date: string;
  spend: number;
  reach: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  engagements: number;
}

export interface OAuthDescriptor {
  /** Where the browser is sent to begin the grant. */
  authorizeUrl: string;
  scopes: string[];
  /** Environment variables that must be set before this adapter can connect. */
  requiredEnv: string[];
  docsUrl: string;
}

/**
 * How much of a surface *we* have actually built.
 *
 * This is the second axis, and it exists because readiness alone lies. A
 * provider whose environment variables are all present reports READY, and for
 * six of the eight adapters here that means "ready to throw" — the credentials
 * are fine and there is no implementation behind them. Readiness answers "are
 * we configured"; this answers "did anyone write the code".
 */
export type ImplementationState =
  | 'IMPLEMENTED'
  | 'PARTIALLY_IMPLEMENTED'
  | 'ARCHITECTURE_ONLY'
  | 'NOT_SUPPORTED';

/** Per surface, because they are built at different times and fail separately. */
export interface ImplementationReport {
  oauth: ImplementationState;
  accountDiscovery: ImplementationState;
  publish: ImplementationState;
  metrics: ImplementationState;
  conversions: ImplementationState;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly label: string;
  /**
   * What this provider's API can do for us once connected. Declared from the
   * provider's real capabilities, not from whether we happen to hold a token —
   * the UI needs to show what a connection would buy before one exists.
   */
  readonly capabilities: {
    publish: boolean;
    metrics: boolean;
    audiences: boolean;
  };
  /** What we have built against those capabilities. Never aspirational. */
  readonly implementation: ImplementationReport;
  oauth(): OAuthDescriptor;
  /** Begins a connection. Throws `ProviderNotConfiguredError` when credentials are absent. */
  connect(input: { redirectUri: string }): Promise<{ redirectTo: string }>;
  fetchMetrics(input: { accountId: string; from: Date; to: Date }): Promise<AdapterMetric[]>;
  publish(input: { accountId: string; contentId: string }): Promise<{ externalId: string }>;
}

/**
 * Raised when an operation needs credentials the deployment does not have.
 *
 * It names the exact variables rather than saying "not configured", because the
 * whole point is that the person reading it can go and set them.
 */
export class ProviderNotConfiguredError extends Error {
  readonly platform: Platform;
  readonly missingEnv: string[];

  /**
   * `detail` is for a variable that is present but wrong.
   *
   * "Missing: META_APP_ID" is misleading when the variable is set and merely
   * malformed — the operator looks at the dashboard, sees a value, and concludes
   * the server is broken. A supplied detail replaces the missing-variable
   * sentence and says what is actually wrong with it.
   */
  constructor(platform: Platform, label: string, missingEnv: string[], options?: { detail?: string }) {
    super(
      options?.detail ??
        `${label} is not configured on this deployment. Missing: ${missingEnv.join(', ')}. ` +
          'Set these on the server and restart before connecting.',
    );
    this.name = 'ProviderNotConfiguredError';
    this.platform = platform;
    this.missingEnv = missingEnv;
  }
}

/**
 * Shared base.
 *
 * `connect`, `fetchMetrics` and `publish` all refuse while credentials are
 * absent — and refuse *with the missing variable names*. A provider-specific
 * subclass overrides them once there is something real to call.
 */
abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: Platform;
  abstract readonly label: string;
  readonly capabilities = { publish: false, metrics: false, audiences: false };
  /*
   * An adapter that declares only its OAuth descriptor is architecture. Saying
   * so here is what stops the UI offering a Connect button that cannot work.
   */
  readonly implementation: ImplementationReport = {
    oauth: 'ARCHITECTURE_ONLY',
    accountDiscovery: 'ARCHITECTURE_ONLY',
    publish: 'ARCHITECTURE_ONLY',
    metrics: 'ARCHITECTURE_ONLY',
    conversions: 'NOT_SUPPORTED',
  };

  abstract oauth(): OAuthDescriptor;

  /** Variables this deployment is still missing for this provider. */
  protected missingEnv(): string[] {
    return this.oauth().requiredEnv.filter((name) => !process.env[name]);
  }

  protected assertConfigured(): void {
    const missing = this.missingEnv();
    if (missing.length > 0) throw new ProviderNotConfiguredError(this.platform, this.label, missing);
  }

  async connect(): Promise<{ redirectTo: string }> {
    this.assertConfigured();
    throw new ProviderNotConfiguredError(this.platform, this.label, this.oauth().requiredEnv);
  }

  async fetchMetrics(): Promise<AdapterMetric[]> {
    this.assertConfigured();
    return [];
  }

  async publish(): Promise<{ externalId: string }> {
    this.assertConfigured();
    throw new ProviderNotConfiguredError(this.platform, this.label, this.oauth().requiredEnv);
  }
}

class MetaAdapter extends BaseAdapter {
  readonly platform: Platform;
  readonly label: string;
  // Meta's Marketing and Graph APIs support all three once the app holds the
  // matching scopes; publishing additionally needs app review.
  override readonly capabilities = { publish: true, metrics: true, audiences: true };

  /*
   * The only adapter with anything behind it. OAuth, discovery and the publish
   * sequence are real code with real provider calls (connect-flow.ts,
   * publish-flow.ts, meta-publish.ts).
   *
   * `metrics` is PARTIALLY_IMPLEMENTED rather than IMPLEMENTED, and the
   * distinction is real: daily insights are ingested for advertisements this
   * system published and linked to a local campaign (metric-sync.ts), and for
   * nothing else. Spend made in Ads Manager against campaigns we did not create
   * is not attributed here, because guessing which local campaign it belongs to
   * would corrupt every ratio computed from these rows.
   *
   * `conversions` stays NOT_SUPPORTED: Meta reports conversion actions when a
   * Pixel is configured, but this system has no first-party conversion model to
   * reconcile them against.
   */
  override readonly implementation: ImplementationReport = {
    oauth: 'IMPLEMENTED',
    accountDiscovery: 'IMPLEMENTED',
    publish: 'IMPLEMENTED',
    metrics: 'PARTIALLY_IMPLEMENTED',
    conversions: 'NOT_SUPPORTED',
  };

  constructor(platform: Platform, label: string) {
    super();
    this.platform = platform;
    this.label = label;
  }

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
      scopes: ['ads_management', 'ads_read', 'pages_manage_posts', 'instagram_content_publish', 'business_management'],
      requiredEnv: ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID'],
      docsUrl: 'https://developers.facebook.com/docs/marketing-apis',
    };
  }
}

/**
 * TikTok, which is two products behind one Platform value.
 *
 * Organic posting goes through Login Kit and the Content Posting API, and that
 * is what the Connect button now runs: `beginAuthorization` builds a Login Kit
 * URL and discovery attaches the creator's own account. The Ads side
 * (`tiktok-ads-flow.ts`) speaks to the Business API and needs an advertiser
 * account, which this login does not grant and this descriptor does not claim.
 *
 * The descriptor therefore describes the flow the button actually starts. The
 * previous entry pointed at the Business API portal while no TikTok OAuth
 * existed at all, which meant the one thing an operator could read about the
 * connection was describing a flow nothing implemented.
 */
class TikTokAdapter extends BaseAdapter {
  readonly platform = 'TIKTOK' as Platform;
  readonly label = 'TikTok';
  override readonly capabilities = { publish: true, metrics: true, audiences: false };
  override readonly implementation: ImplementationReport = {
    oauth: 'IMPLEMENTED',
    accountDiscovery: 'IMPLEMENTED',
    publish: 'IMPLEMENTED',
    // Post metrics still arrive through the shared organic sync, which has no
    // TikTok reader yet. Claiming otherwise would put empty numbers on a chart.
    metrics: 'ARCHITECTURE_ONLY',
    conversions: 'NOT_SUPPORTED',
  };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
      scopes: [...TIKTOK_SCOPES],
      requiredEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
      docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    };
  }
}

class SnapchatAdapter extends BaseAdapter {
  readonly platform = 'SNAPCHAT' as Platform;
  readonly label = 'Snapchat';
  // The Marketing API reports on ads; it is not a content-publishing surface.
  override readonly capabilities = { publish: false, metrics: true, audiences: true };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://accounts.snapchat.com/login/oauth2/authorize',
      scopes: ['snapchat-marketing-api'],
      requiredEnv: ['SNAPCHAT_CLIENT_ID', 'SNAPCHAT_CLIENT_SECRET', 'SNAPCHAT_REDIRECT_URI'],
      docsUrl: 'https://marketingapi.snapchat.com/docs/',
    };
  }
}

class GoogleAdsAdapter extends BaseAdapter {
  readonly platform = 'GOOGLE_ADS' as Platform;
  readonly label = 'Google Ads';
  override readonly capabilities = { publish: true, metrics: true, audiences: true };
  override readonly implementation: ImplementationReport = {
    oauth: 'ARCHITECTURE_ONLY',
    accountDiscovery: 'ARCHITECTURE_ONLY',
    publish: 'IMPLEMENTED',
    metrics: 'ARCHITECTURE_ONLY',
    conversions: 'NOT_SUPPORTED',
  };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      scopes: ['https://www.googleapis.com/auth/adwords'],
      requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_REDIRECT_URI'],
      docsUrl: 'https://developers.google.com/google-ads/api/docs/start',
    };
  }
}

class GoogleBusinessAdapter extends BaseAdapter {
  readonly platform = 'GOOGLE_BUSINESS' as Platform;
  readonly label = 'Google Business Profile';
  // Posts and review replies are publishing; there is no ad-metrics surface.
  override readonly capabilities = { publish: true, metrics: false, audiences: false };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      scopes: ['https://www.googleapis.com/auth/business.manage'],
      requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
      docsUrl: 'https://developers.google.com/my-business',
    };
  }
}

class LinkedInAdapter extends BaseAdapter {
  readonly platform = 'LINKEDIN' as Platform;
  readonly label = 'LinkedIn';
  override readonly capabilities = { publish: true, metrics: true, audiences: true };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      scopes: ['r_ads', 'r_ads_reporting', 'w_organization_social'],
      requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_REDIRECT_URI'],
      docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/',
    };
  }
}

class XAdapter extends BaseAdapter {
  readonly platform = 'X' as Platform;
  readonly label = 'X';
  override readonly capabilities = { publish: true, metrics: false, audiences: false };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
      scopes: ['tweet.read', 'tweet.write', 'users.read'],
      requiredEnv: ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REDIRECT_URI'],
      docsUrl: 'https://developer.x.com/en/docs',
    };
  }
}

const adapters: Record<string, PlatformAdapter> = {
  FACEBOOK: new MetaAdapter('FACEBOOK' as Platform, 'Facebook'),
  INSTAGRAM: new MetaAdapter('INSTAGRAM' as Platform, 'Instagram'),
  TIKTOK: new TikTokAdapter(),
  SNAPCHAT: new SnapchatAdapter(),
  GOOGLE_ADS: new GoogleAdsAdapter(),
  GOOGLE_BUSINESS: new GoogleBusinessAdapter(),
  LINKEDIN: new LinkedInAdapter(),
  X: new XAdapter(),
};

export function adapterFor(platform: Platform): PlatformAdapter {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`No adapter registered for ${platform}`);
  return adapter;
}

export function allAdapters(): PlatformAdapter[] {
  return Object.values(adapters);
}

/**
 * Can this provider's Connect button do anything?
 *
 * Configuration is necessary and not sufficient: a Google Ads adapter with all
 * four environment variables set is configured and still cannot start a flow.
 * The route asks this before it asks about credentials, so the operator is told
 * "not built yet" rather than being sent to fix variables that are already fine.
 */
export function supportsOAuth(adapter: PlatformAdapter): boolean {
  return adapter.implementation.oauth === 'IMPLEMENTED';
}

/** Raised when a provider is configured but the surface is not built. */
export class ProviderNotImplementedError extends Error {
  readonly platform: Platform;
  readonly surface: keyof ImplementationReport;
  readonly state: ImplementationState;

  constructor(adapter: PlatformAdapter, surface: keyof ImplementationReport) {
    super(
      `${adapter.label} ${surface} is not implemented in this application ` +
        `(${adapter.implementation[surface]}). Its credentials may be present; the code is not.`,
    );
    this.name = 'ProviderNotImplementedError';
    this.platform = adapter.platform;
    this.surface = surface;
    this.state = adapter.implementation[surface];
  }
}

export type ProviderReadiness = 'READY' | 'NOT_CONFIGURED' | 'NO_ENCRYPTION';

export interface ReadinessReport {
  state: ProviderReadiness;
  /** Environment variables this deployment is still missing. */
  missingEnv: string[];
  /** One sentence an operator can act on. */
  detail: string;
}

/**
 * Why this provider can or cannot be connected right now.
 *
 * Credentials and the encryption key are checked separately because they fail
 * for different reasons and are fixed by different people — and because storing
 * an OAuth token without `TOKEN_ENCRYPTION_KEY` would put a live bearer
 * credential in the database in plaintext, which is worse than not connecting.
 */
export function providerReadiness(adapter: PlatformAdapter): ReadinessReport {
  const missingEnv = adapter.oauth().requiredEnv.filter((name) => !process.env[name]);

  if (missingEnv.length > 0) {
    return {
      state: 'NOT_CONFIGURED',
      missingEnv,
      detail: `Not configured — set ${missingEnv.join(', ')} on the server.`,
    };
  }
  if (!encryptionConfigured()) {
    return {
      state: 'NO_ENCRYPTION',
      missingEnv: ['TOKEN_ENCRYPTION_KEY'],
      detail: 'TOKEN_ENCRYPTION_KEY is not set, so provider tokens cannot be stored safely.',
    };
  }
  return { state: 'READY', missingEnv: [], detail: 'Ready to connect.' };
}

/** Back-compat shape for existing callers. */
export function adapterReadiness(adapter: PlatformAdapter): { ready: boolean; missingEnv: string[] } {
  const report = providerReadiness(adapter);
  return { ready: report.state === 'READY', missingEnv: report.missingEnv };
}
