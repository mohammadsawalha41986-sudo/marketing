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

  constructor(platform: Platform, label: string, missingEnv: string[]) {
    super(
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

  constructor(platform: Platform, label: string) {
    super();
    this.platform = platform;
    this.label = label;
  }

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
      scopes: ['ads_management', 'ads_read', 'pages_manage_posts', 'instagram_content_publish', 'business_management'],
      requiredEnv: ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI'],
      docsUrl: 'https://developers.facebook.com/docs/marketing-apis',
    };
  }
}

class TikTokAdapter extends BaseAdapter {
  readonly platform = 'TIKTOK' as Platform;
  readonly label = 'TikTok';
  // Direct posting exists but is gated behind TikTok's own approval, so it is
  // declared as a capability of the API rather than as something we can do yet.
  override readonly capabilities = { publish: true, metrics: true, audiences: false };

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://business-api.tiktok.com/portal/auth',
      scopes: ['ad.group.list', 'campaign.list', 'report.read'],
      requiredEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
      docsUrl: 'https://business-api.tiktok.com/portal/docs',
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
  override readonly capabilities = { publish: false, metrics: true, audiences: true };

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
