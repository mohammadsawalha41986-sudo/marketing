/**
 * Ad-platform integration architecture.
 *
 * Each platform gets an adapter implementing `PlatformAdapter`. Today every
 * adapter reports `implemented: false` and refuses to connect, because no
 * provider credentials exist — the routes, storage, status model and UI are all
 * real, and swapping in a working adapter is the only change a live integration
 * needs. Nothing here pretends a connection succeeded.
 */

import type { Platform } from '@prisma/client';

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
  /** False until real API credentials and code are wired up. */
  readonly implemented: boolean;
  readonly capabilities: {
    publish: boolean;
    metrics: boolean;
    audiences: boolean;
  };
  oauth(): OAuthDescriptor;
  /** Begins a connection. Throws `NotImplementedError` while `implemented` is false. */
  connect(input: { redirectUri: string }): Promise<{ redirectTo: string }>;
  fetchMetrics(input: { accountId: string; from: Date; to: Date }): Promise<AdapterMetric[]>;
  publish(input: { accountId: string; contentId: string }): Promise<{ externalId: string }>;
}

export class NotImplementedError extends Error {
  readonly platform: Platform;
  readonly requiredEnv: string[];

  constructor(platform: Platform, label: string, requiredEnv: string[]) {
    super(
      `The ${label} adapter is not implemented yet. Set ${requiredEnv.join(', ')} and provide a real adapter before connecting.`,
    );
    this.name = 'NotImplementedError';
    this.platform = platform;
    this.requiredEnv = requiredEnv;
  }
}

/** Shared base: everything an unimplemented adapter should do, which is refuse. */
abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: Platform;
  abstract readonly label: string;
  readonly implemented: boolean = false;
  readonly capabilities = { publish: false, metrics: false, audiences: false };

  abstract oauth(): OAuthDescriptor;

  async connect(): Promise<{ redirectTo: string }> {
    throw new NotImplementedError(this.platform, this.label, this.oauth().requiredEnv);
  }

  async fetchMetrics(): Promise<AdapterMetric[]> {
    throw new NotImplementedError(this.platform, this.label, this.oauth().requiredEnv);
  }

  async publish(): Promise<{ externalId: string }> {
    throw new NotImplementedError(this.platform, this.label, this.oauth().requiredEnv);
  }
}

class MetaAdapter extends BaseAdapter {
  readonly platform: Platform;
  readonly label: string;

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

  override oauth(): OAuthDescriptor {
    return {
      authorizeUrl: 'https://business-api.tiktok.com/portal/auth',
      scopes: ['ad.group.list', 'campaign.list', 'report.read'],
      requiredEnv: ['TIKTOK_APP_ID', 'TIKTOK_APP_SECRET', 'TIKTOK_REDIRECT_URI'],
      docsUrl: 'https://business-api.tiktok.com/portal/docs',
    };
  }
}

class SnapchatAdapter extends BaseAdapter {
  readonly platform = 'SNAPCHAT' as Platform;
  readonly label = 'Snapchat';

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

/** Which env vars are present, so the UI can say what is still missing. */
export function adapterReadiness(adapter: PlatformAdapter): { ready: boolean; missingEnv: string[] } {
  const missingEnv = adapter.oauth().requiredEnv.filter((key) => !process.env[key]);
  return { ready: adapter.implemented && missingEnv.length === 0, missingEnv };
}
