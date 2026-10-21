/**
 * What each connection needs to be granted, why, and who can grant it.
 *
 * The integrations screen used to show the scopes an adapter *requests*. That
 * answers the wrong question: providers grant per permission, so a login can
 * succeed with publishing declined, and the requested list reads as healthy
 * right up to the first failed post. This catalogue is compared against the
 * grant recorded on the connection (`Integration.scopes`, which connect-flow
 * fills from the provider's own answer), and the difference is what the screen
 * shows as missing.
 *
 * `required` means the connection is not useful without it — its absence makes
 * the connection MISSING_PERMISSIONS. An optional permission powers one feature
 * (ads, insights) and its absence is listed without failing the connection,
 * because a restaurant that never advertises should not see a red badge for
 * `ads_management`.
 *
 * `approval` names what has to happen outside this application before the
 * permission can be granted to customers at all. Those steps cannot be done by
 * code, and saying so is the point: an operator who reconnects ten times
 * because App Review is pending is being failed by the screen, not by Meta.
 */

import { Platform } from '@prisma/client';

import { META_SCOPES } from './meta.js';
import { INSTAGRAM_SCOPES } from './instagram.js';
import { TIKTOK_SCOPES } from './tiktok.js';
import { GOOGLE_SCOPES } from './google.js';
import { GOOGLE_ADS_SCOPES } from './google-ads.js';
import { YOUTUBE_SCOPES } from './youtube.js';
import { LINKEDIN_SCOPES } from './linkedin.js';

export interface PermissionRequirement {
  scope: string;
  /** What breaks without it, in the operator's terms. */
  purpose: string;
  required: boolean;
  /** Who grants it during login. */
  grantedBy: string;
  /** Platform-side approval the app needs before customers can grant it. */
  approval: string | null;
}

const META_REVIEW = 'Meta App Review — Advanced Access for this permission on the Meta app';
const META_ADMIN = 'A Facebook user with full control of the Page / Business Portfolio, via Facebook Login for Business';

const META: PermissionRequirement[] = [
  { scope: 'pages_show_list', purpose: 'List the Pages this login manages so one can be attached', required: true, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'pages_manage_posts', purpose: 'Publish posts to the attached Facebook Page', required: true, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'pages_read_engagement', purpose: 'Read Page posts and engagement for analytics', required: true, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'instagram_basic', purpose: 'Read the Instagram Professional account linked to the Page', required: false, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'instagram_content_publish', purpose: 'Publish to the Page-linked Instagram account', required: false, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'ads_read', purpose: 'Read ad account campaigns and insights', required: false, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'ads_management', purpose: 'Create campaigns, ad sets and ads (Marketing API)', required: false, grantedBy: META_ADMIN, approval: META_REVIEW },
  { scope: 'business_management', purpose: 'Discover ad accounts and Pages owned by a Business Portfolio', required: false, grantedBy: META_ADMIN, approval: META_REVIEW },
];

const INSTAGRAM_ADMIN = 'The owner of the Instagram Professional (Business or Creator) account, via Instagram Login';
const INSTAGRAM_REVIEW = 'Meta App Review — Advanced Access for the Instagram API with Instagram Login';

const INSTAGRAM: PermissionRequirement[] = [
  { scope: 'instagram_business_basic', purpose: 'Identify the account and read its profile', required: true, grantedBy: INSTAGRAM_ADMIN, approval: INSTAGRAM_REVIEW },
  { scope: 'instagram_business_content_publish', purpose: 'Publish images, carousels and reels', required: true, grantedBy: INSTAGRAM_ADMIN, approval: INSTAGRAM_REVIEW },
  { scope: 'instagram_business_manage_insights', purpose: 'Read post and account insights', required: false, grantedBy: INSTAGRAM_ADMIN, approval: INSTAGRAM_REVIEW },
];

const TIKTOK_OWNER = 'The TikTok creator / business account owner, via TikTok Login Kit';

const TIKTOK: PermissionRequirement[] = [
  { scope: 'user.info.basic', purpose: 'Identify the connected TikTok account', required: true, grantedBy: TIKTOK_OWNER, approval: 'Scope enabled on the app in the TikTok for Developers portal' },
  { scope: 'video.publish', purpose: 'Post videos directly to the profile', required: true, grantedBy: TIKTOK_OWNER, approval: 'Content Posting API audit by TikTok — unaudited apps can only post privately (SELF_ONLY)' },
  { scope: 'video.upload', purpose: 'Send videos to the creator\'s TikTok drafts', required: false, grantedBy: TIKTOK_OWNER, approval: 'Scope enabled on the app in the TikTok for Developers portal' },
  { scope: 'video.list', purpose: 'Read view, like, comment and share counts of published videos', required: false, grantedBy: TIKTOK_OWNER, approval: 'Scope enabled on the app in the TikTok for Developers portal' },
];

const GOOGLE_OWNER = 'A Google account that is an owner or manager of the Business Profile';
const GOOGLE_ADS_OWNER = 'A Google account with access to the Google Ads customer (or its manager account)';

const GOOGLE_BUSINESS: PermissionRequirement[] = [
  { scope: 'openid', purpose: 'Verify the connected Google identity', required: true, grantedBy: GOOGLE_OWNER, approval: null },
  { scope: 'https://www.googleapis.com/auth/userinfo.email', purpose: 'Show which Google account is connected', required: true, grantedBy: GOOGLE_OWNER, approval: null },
  { scope: 'https://www.googleapis.com/auth/business.manage', purpose: 'Read locations and reviews, reply to reviews, publish posts', required: true, grantedBy: GOOGLE_OWNER, approval: 'Google Business Profile API access request approved for the Google Cloud project; OAuth consent screen verified for this sensitive scope' },
];

const GOOGLE_ADS: PermissionRequirement[] = [
  { scope: 'openid', purpose: 'Verify the connected Google identity', required: true, grantedBy: GOOGLE_ADS_OWNER, approval: null },
  { scope: 'https://www.googleapis.com/auth/userinfo.email', purpose: 'Show which Google account is connected', required: true, grantedBy: GOOGLE_ADS_OWNER, approval: null },
  { scope: 'https://www.googleapis.com/auth/adwords', purpose: 'Read and manage Google Ads campaigns', required: true, grantedBy: GOOGLE_ADS_OWNER, approval: 'A Google Ads API developer token with Basic or Standard access (test-access tokens reach test accounts only)' },
];

const YOUTUBE: PermissionRequirement[] = YOUTUBE_SCOPES.map((scope) => ({
  scope,
  purpose: scope.endsWith('youtube.upload') ? 'Upload videos to the channel' : 'Read the channel this login owns',
  required: true,
  grantedBy: 'The YouTube channel owner',
  approval: 'OAuth consent screen verified by Google for YouTube scopes',
}));

const LINKEDIN: PermissionRequirement[] = LINKEDIN_SCOPES.map((scope) => ({
  scope,
  purpose: scope === 'w_organization_social' ? 'Post as the Company Page' : 'Read the organisation and member identity',
  required: true,
  grantedBy: 'A Super Admin or Content Admin of the LinkedIn Company Page',
  approval: 'LinkedIn Community Management API product approved for the app',
}));

const REQUIREMENTS: Partial<Record<Platform, PermissionRequirement[]>> = {
  [Platform.FACEBOOK]: META,
  [Platform.INSTAGRAM]: INSTAGRAM,
  [Platform.TIKTOK]: TIKTOK,
  [Platform.GOOGLE_BUSINESS]: GOOGLE_BUSINESS,
  [Platform.GOOGLE_ADS]: GOOGLE_ADS,
  [Platform.YOUTUBE]: YOUTUBE,
  [Platform.LINKEDIN]: LINKEDIN,
};

/*
 * The catalogue must not drift from what the adapters actually request: a
 * scope listed here that is never asked for would be reported missing forever,
 * and a requested one absent here would never be reported at all. Checked by
 * test against these constants.
 */
export const REQUESTED_SCOPES: Partial<Record<Platform, readonly string[]>> = {
  [Platform.FACEBOOK]: META_SCOPES,
  [Platform.INSTAGRAM]: INSTAGRAM_SCOPES,
  [Platform.TIKTOK]: TIKTOK_SCOPES,
  [Platform.GOOGLE_BUSINESS]: GOOGLE_SCOPES,
  [Platform.GOOGLE_ADS]: GOOGLE_ADS_SCOPES,
  [Platform.YOUTUBE]: YOUTUBE_SCOPES,
  [Platform.LINKEDIN]: LINKEDIN_SCOPES,
};

export function permissionRequirements(platform: Platform): PermissionRequirement[] {
  return REQUIREMENTS[platform] ?? [];
}

export interface PermissionReport {
  granted: string[];
  missingRequired: PermissionRequirement[];
  missingOptional: PermissionRequirement[];
  requirements: Array<PermissionRequirement & { granted: boolean }>;
}

/**
 * The grant compared with what the platform needs.
 *
 * Google answers `openid` as the scope string `openid` and sometimes as nothing
 * at all once `userinfo.email` is granted alongside it — an identity token is
 * proof enough — so `openid` is never reported missing when email is present.
 */
export function permissionReport(platform: Platform, grantedScopes: readonly string[]): PermissionReport {
  const granted = new Set(grantedScopes);
  if (granted.has('https://www.googleapis.com/auth/userinfo.email')) granted.add('openid');

  const requirements = permissionRequirements(platform).map((requirement) => ({
    ...requirement,
    granted: granted.has(requirement.scope),
  }));

  return {
    granted: [...grantedScopes],
    missingRequired: requirements.filter((entry) => entry.required && !entry.granted),
    missingOptional: requirements.filter((entry) => !entry.required && !entry.granted),
    requirements,
  };
}

/**
 * What a platform's connection here does *not* cover, said once so nobody
 * looks for it behind a permission that cannot grant it.
 */
const NOTES: Partial<Record<Platform, string[]>> = {
  [Platform.TIKTOK]: [
    'This is a TikTok Login Kit connection: it publishes to the creator profile and reads video statistics.',
    'TikTok Ads (Marketing API, business-api.tiktok.com) authorises through a separate TikTok for Business developer app and advertiser authorisation. That flow is not built here yet, so no advertiser account can be attached and ad publishing to TikTok cannot run.',
  ],
  [Platform.FACEBOOK]: [
    'Facebook Login for Business: permissions come from the login configuration (META_CONFIG_ID) in the Meta app, not from this application.',
    'Meta issues no refresh token. The long-lived user token lasts about 60 days; Page tokens derived from it do not expire while the user keeps their Page role.',
  ],
  [Platform.INSTAGRAM]: [
    'Instagram API with Instagram Login, for Professional accounts without a Facebook Page. A Page-linked account can also be attached through the Facebook connection.',
    'The token lasts 60 days and is renewed automatically within 7 days of expiry, as long as it has not already expired.',
  ],
  [Platform.GOOGLE_BUSINESS]: [
    'Google Analytics 4 (analytics.readonly) and Search Console (webmasters.readonly) are not requested: nothing in this application reads them yet, and requesting unused sensitive scopes widens the consent screen and Google\'s verification review.',
  ],
  [Platform.GOOGLE_ADS]: [
    'Requests also need GOOGLE_ADS_DEVELOPER_TOKEN, and GOOGLE_ADS_LOGIN_CUSTOMER_ID when the account is reached through a manager account.',
  ],
};

export function platformNotes(platform: Platform): string[] {
  return NOTES[platform] ?? [];
}
