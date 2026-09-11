/**
 * The capability matrix — one answer to "can this platform actually do this".
 *
 * Every surface in the Marketing Command Center needs the same thing before it
 * can render honestly: not "is TikTok a platform we list", but "can this
 * deployment, right now, schedule a TikTok video — and if not, is that because
 * nobody built it, because a credential is missing, because TikTok has to
 * approve the app first, or because the API has no such feature at all". Those
 * four answers need four different things from the operator, and a screen that
 * collapses them into a greyed-out button tells them none of it.
 *
 * Until now that answer lived in three places that disagreed by construction.
 * `social/capabilities.ts` describes organic composing surfaces. The adapter
 * `ImplementationReport` in `integrations/index.ts` describes build state — but
 * keys on Platform, so `MetaAdapter` speaks for Facebook organic *and* Meta Ads
 * at once, and `TikTokAdapter` for Phase 11 organic *and* Phase 13 Ads. Neither
 * knows whether a credential is set. So nothing could answer the question above
 * without a UI hardcoding its own opinion, which is precisely how a screen ends
 * up offering a control the request cannot carry.
 *
 * Two rules give this file its shape.
 *
 * **Organic and paid are separate channels, always.** They are different APIs,
 * different credentials, different approvals and different failure modes. A
 * platform can be perfectly publishable organically while its ads integration
 * does not exist — Facebook and TikTok are both exactly that today — and one
 * row per platform cannot say so.
 *
 * **Derive everything derivable; declare only what cannot be.** Whether we can
 * publish organically is read from the publisher registry. Whether we can read
 * metrics is read from the ingestion registry. Whether credentials exist is
 * read from each provider's own configured-check. Only two classes of fact are
 * written down here, because no code can compute them: what a provider's API
 * genuinely does not offer, and what a provider must approve before letting us
 * use it. Restating a derivable fact is how the old registries drifted.
 */

import { Platform } from '@prisma/client';

import { PLATFORM_LABELS } from '../analytics.js';
import { publisherFor } from '../publishing/registry.js';
import { metricsFetcherFor } from '../social/metrics-ingest.js';
import { WORKSPACE_PLATFORMS } from '../social/capabilities.js';
import { metaConfigDiagnostics } from '../integrations/meta.js';
import { instagramConfigured } from '../integrations/instagram.js';
import { tiktokConfigured } from '../integrations/tiktok.js';
import { googleConfigured } from '../integrations/google.js';
import { googleAdsConfigured } from '../integrations/google-ads.js';
import { youtubeConfigured } from '../integrations/youtube.js';
import { linkedInConfigured } from '../integrations/linkedin.js';

export type MarketingChannel = 'ORGANIC' | 'PAID';

/**
 * The five answers, in the order an operator can act on them.
 *
 * SUPPORTED is the only one that means "use it now". The other four each name a
 * different next action, which is the entire reason they are not one state.
 */
export type CapabilityState =
  /** Built, configured, and usable in this deployment today. */
  | 'SUPPORTED'
  /** Built, but a credential this deployment does not hold is required. */
  | 'NOT_CONFIGURED'
  /** Built and configured, but the provider must approve the app first. */
  | 'REQUIRES_APPROVAL'
  /** The provider's API has no such capability. Nothing can make it appear. */
  | 'NOT_SUPPORTED'
  /** The provider offers it; this repository has not built it. */
  | 'NOT_IMPLEMENTED';

export type CapabilitySurface =
  | 'OAUTH' | 'ACCOUNTS' | 'CONTENT' | 'MEDIA' | 'PUBLISHING' | 'SCHEDULING'
  | 'CAMPAIGNS' | 'AD_GROUPS' | 'ADS' | 'CREATIVES' | 'TARGETING'
  | 'PREVIEW' | 'CALENDAR' | 'ANALYTICS' | 'REPORTING' | 'AI_RECOMMENDATIONS';

/** Which surfaces are meaningful questions to ask of each channel. */
export const ORGANIC_SURFACES: CapabilitySurface[] = [
  'OAUTH', 'ACCOUNTS', 'CONTENT', 'MEDIA', 'PUBLISHING', 'SCHEDULING',
  'PREVIEW', 'CALENDAR', 'ANALYTICS', 'AI_RECOMMENDATIONS',
];

export const PAID_SURFACES: CapabilitySurface[] = [
  'OAUTH', 'ACCOUNTS', 'CAMPAIGNS', 'AD_GROUPS', 'ADS', 'CREATIVES', 'TARGETING',
  'PREVIEW', 'CALENDAR', 'ANALYTICS', 'REPORTING', 'AI_RECOMMENDATIONS',
];

export interface Capability {
  surface: CapabilitySurface;
  state: CapabilityState;
  /** Written for the person who has to act on it. Shown verbatim. */
  detail: string;
  /** Variable names only — never values — when NOT_CONFIGURED. */
  requiredEnv: string[];
  /** What the provider must approve, when REQUIRES_APPROVAL. */
  approval: string | null;
}

export interface ChannelMatrix {
  channel: MarketingChannel;
  /** False when the channel does not exist for this platform at all. */
  available: boolean;
  capabilities: Capability[];
  /** The channel's overall state, derived from its capabilities. */
  state: CapabilityState;
}

export interface PlatformMatrix {
  platform: Platform;
  label: string;
  organic: ChannelMatrix;
  paid: ChannelMatrix;
  /** The better of the two channels — what the platform can do at all. */
  production: CapabilityState;
}

// ------------------------------------------------------------ credentials

/** A credential group, and whether this deployment holds it. */
interface CredentialGroup {
  env: string[];
  configured: () => boolean;
}

const CREDENTIALS = {
  META: {
    env: ['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI', 'META_CONFIG_ID'],
    // `valid` rather than "all present": an app id that equals the config id is
    // a real and common paste error, and a connection built from it fails at
    // the provider with a message that does not name the cause.
    configured: () => metaConfigDiagnostics().valid,
  },
  /*
   * Instagram Login is its own app product in the Meta console, with its own id
   * and secret. Sharing META's group would report an Instagram-only deployment
   * as configured because a Facebook app happened to be set up.
   */
  INSTAGRAM: {
    env: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URI'],
    configured: () => instagramConfigured(),
  },
  TIKTOK: {
    env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
    configured: () => tiktokConfigured(),
  },
  GOOGLE: {
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
    configured: () => googleConfigured(),
  },
  // YouTube rides Google's OAuth client; its redirect URI is derived when unset.
  YOUTUBE: {
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    configured: () => youtubeConfigured(),
  },
  LINKEDIN: {
    env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    configured: () => linkedInConfigured(),
  },
  /*
   * Google Ads shares the OAuth client with Business Profile and YouTube but
   * has its own callback route and its own optional redirect variable, so
   * `GOOGLE_REDIRECT_URI` — which belongs to Business Profile's route — is not
   * among its requirements. Neither is a developer token: Google sunset those
   * on 9 September 2026, and what gates the Ads API now is the access level of
   * the Cloud project the OAuth client belongs to, which no environment
   * variable can express.
   */
  GOOGLE_ADS: {
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    configured: () => googleAdsConfigured(),
  },
  /** No credential group, because nothing is built to use one. */
  NONE: { env: [], configured: () => false },
} satisfies Record<string, CredentialGroup>;

type CredentialKey = keyof typeof CREDENTIALS;

// -------------------------------------------------------------- declared

/**
 * What we built, per platform, channel and surface — and nothing else.
 *
 * `BUILT` here means the code exists in this repository. It says nothing about
 * credentials or approvals; those are applied afterwards, so that a phase which
 * ships an integration never has to remember to also update a "ready" flag.
 */
type BuildState = 'BUILT' | 'NOT_IMPLEMENTED' | 'NOT_SUPPORTED';

interface Declaration {
  build: BuildState;
  detail: string;
  /** Named when the provider gates this behind its own review. */
  approval?: string;
}

type ChannelDeclaration = Partial<Record<CapabilitySurface, Declaration>>;

/** Shorthand for the common case: built, and nothing more to say. */
const built = (detail: string, approval?: string): Declaration =>
  approval === undefined ? { build: 'BUILT', detail } : { build: 'BUILT', detail, approval };

const missing = (detail: string): Declaration => ({ build: 'NOT_IMPLEMENTED', detail });
const unsupported = (detail: string): Declaration => ({ build: 'NOT_SUPPORTED', detail });

/**
 * Surfaces the content workspace provides for every platform it composes for.
 *
 * Content, media, scheduling, preview and calendar are this application's own
 * features rather than any provider's, so they are built for whatever the
 * workspace includes and absent for what it does not. Declaring them per
 * platform would be nine copies of one fact.
 */
function workspaceOrganic(platform: Platform): ChannelDeclaration {
  const inWorkspace = WORKSPACE_PLATFORMS.includes(platform) || platform === Platform.GOOGLE_BUSINESS;
  if (!inWorkspace) return {};

  return {
    CONTENT: built('Composed in the content workspace, with platform-specific versions.'),
    MEDIA: built('Validated against this platform\'s own media rules before publishing.'),
    SCHEDULING: built('Scheduled through the shared publishing queue, with retries and idempotency.'),
    PREVIEW: built('Previewed as the real platform version of the post, not a re-skin.'),
    CALENDAR: built('Appears on the organic content calendar.'),
    AI_RECOMMENDATIONS: built('Best time, hashtags and CTA, labelled with their basis and confidence.'),
  };
}

const ORGANIC: Partial<Record<Platform, ChannelDeclaration>> = {
  [Platform.FACEBOOK]: {
    OAUTH: built('Facebook Login for Business, through the shared connection lifecycle.'),
    ACCOUNTS: built('Pages discovered on connect; the operator chooses which to attach.'),
    ...workspaceOrganic(Platform.FACEBOOK),
  },

  [Platform.INSTAGRAM]: {
    OAUTH: built(
      'Instagram API with Instagram Login — the account authorises directly, so a Professional '
        + 'account with no Facebook Page can connect. Page-linked accounts still arrive through '
        + 'the Meta connection as well.',
    ),
    ACCOUNTS: built('The one Instagram Professional account the login is; no Page is required.'),
    ...workspaceOrganic(Platform.INSTAGRAM),
    PUBLISHING: built(
      'Two-step container/publish against the Content Publishing API, on whichever Graph host '
        + 'issued the account\'s token. The adapter refuses an authenticated media link rather '
        + 'than send Meta one it cannot fetch.',
      'Meta App Review for instagram_business_content_publish, plus a publicly reachable media URL.',
    ),
  },

  [Platform.TIKTOK]: {
    OAUTH: built('Login Kit v2, with video.publish, video.upload and video.list requested.'),
    ACCOUNTS: built('One creator account; TikTok has no per-asset token to fetch.'),
    ...workspaceOrganic(Platform.TIKTOK),
    PUBLISHING: built(
      'Direct post through the Content Posting API. Privacy levels are read from the '
        + 'creator before upload rather than assumed.',
      'TikTok app audit before a post can be public; an unaudited app may only post privately.',
    ),
  },

  [Platform.YOUTUBE]: {
    OAUTH: built('Google\'s OAuth client with a YouTube grant, on its own callback route.'),
    ACCOUNTS: built('Channels owned by the authorising login.'),
    ...workspaceOrganic(Platform.YOUTUBE),
    PUBLISHING: built(
      'Resumable upload through the Data API v3. Text-only community posts have no public '
        + 'endpoint and are refused rather than silently dropped.',
      'Google verification for the youtube.upload scope.',
    ),
    ANALYTICS: missing(
      'Video statistics come from the YouTube Analytics API, a separate product with its own '
        + 'scope. Nothing here reads it, so metrics stay Not fetched rather than showing zero.',
    ),
  },

  [Platform.LINKEDIN]: {
    OAUTH: built('LinkedIn OAuth 2.0, discovering the organizations this login administers.'),
    ACCOUNTS: built('Organization pages with an approved administrator role.'),
    ...workspaceOrganic(Platform.LINKEDIN),
    PUBLISHING: built(
      'Text posts through /rest/posts with an organization author URN.',
      'LinkedIn Community Management API approval for w_organization_social.',
    ),
    MEDIA: missing(
      'Image posting is a three-call upload the adapter does not implement yet, so it refuses '
        + 'an attached image rather than post without it.',
    ),
    ANALYTICS: missing('Post statistics come from Community Management reporting, which is not read here.'),
  },

  [Platform.GOOGLE_BUSINESS]: {
    OAUTH: built('Google OAuth with business.manage, offline access always requested.'),
    ACCOUNTS: built('Business Profile accounts, with their locations synced underneath.'),
    ...workspaceOrganic(Platform.GOOGLE_BUSINESS),
    PUBLISHING: built(
      'Local posts: updates, offers and events.',
      'Google verification for the business.manage scope.',
    ),
    ANALYTICS: missing(
      'Views and searches come from the Business Profile Performance API, which is not read here.',
    ),
  },

  [Platform.X]: {
    OAUTH: missing('No X connection is implemented; the publisher is an explicit refusal stub.'),
  },

};

const PAID: Partial<Record<Platform, ChannelDeclaration>> = {
  // Meta Ads. Facebook and Instagram are one integration and one ad account —
  // Instagram is a placement inside a Meta campaign, never a separate API.
  [Platform.FACEBOOK]: {
    OAUTH: built('The same Meta connection as organic, with ads_management.'),
    ACCOUNTS: built('Ad accounts discovered on connect; the operator chooses which to attach.'),
    CAMPAIGNS: built('Created through the Marketing API, always PAUSED so nothing spends unattended.'),
    AD_GROUPS: built('Ad sets with budget, schedule and targeting.'),
    ADS: built('Ads created against the ad set, paused.'),
    CREATIVES: built('Image and video creatives uploaded to the ad account.'),
    TARGETING: built('Country, region and city targeting.'),
    PREVIEW: built('Rendered per placement from the real publication record.'),
    CALENDAR: missing('Paid flights do not appear on a calendar yet; the organic calendar is organic only.'),
    ANALYTICS: built('Insights sync into analytics snapshots.'),
    REPORTING: { build: 'BUILT', detail: 'Spend, impressions, clicks and derived rates, on demand rather than on a schedule.' },
    AI_RECOMMENDATIONS: built('Campaign optimiser findings over recorded performance.'),
  },

  [Platform.INSTAGRAM]: {
    OAUTH: built('The same Meta connection; Instagram has no separate ads API.'),
    ACCOUNTS: built('The Meta ad account that owns the Instagram placement.'),
    CAMPAIGNS: built('A Meta campaign; Instagram is chosen as a placement within it.'),
    AD_GROUPS: built('The Meta ad set carrying the Instagram placement.'),
    ADS: built('Meta ads delivered to Instagram feed, Stories, Reels or Explore.'),
    CREATIVES: built('Meta creatives, validated against the Instagram placement\'s media rules.'),
    TARGETING: built('Meta targeting; identical to Facebook because it is the same ad set.'),
    PREVIEW: built('Instagram feed, Stories and Reels placements rendered from the publication.'),
    CALENDAR: missing('Paid flights do not appear on a calendar yet.'),
    ANALYTICS: built('Reported as a placement breakdown inside Meta insights.'),
    REPORTING: built('Through the Meta ad account, split by placement.'),
    AI_RECOMMENDATIONS: built('Campaign optimiser findings over recorded performance.'),
  },

  [Platform.TIKTOK]: {
    OAUTH: built('TikTok Business API, sharing the TikTok credential group.'),
    ACCOUNTS: built('Advertiser accounts.'),
    CAMPAIGNS: built('Created through Business API v1.3 with operation_status DISABLE — TikTok\'s paused.'),
    AD_GROUPS: built('Ad groups with budget, schedule and targeting.'),
    ADS: built('Ads created against the ad group, disabled.'),
    CREATIVES: built('Video creatives uploaded to the advertiser account.'),
    TARGETING: built('Country and region targeting.'),
    PREVIEW: built('Vertical video preview rendered from the publication record.'),
    CALENDAR: missing('Paid flights do not appear on a calendar yet.'),
    ANALYTICS: missing('TikTok Ads reporting is not read; only the write path is built.'),
    REPORTING: missing('TikTok Ads reporting is not read; only the write path is built.'),
    AI_RECOMMENDATIONS: built('Campaign optimiser findings over recorded performance.'),
  },

  [Platform.GOOGLE_ADS]: {
    OAUTH: built(
      'Google OAuth with the adwords scope, offline access always requested, on its own callback route.',
      'Google Ads API access on the Cloud project behind the OAuth client. Explorer is granted '
      + 'automatically and reaches production accounts at 2,880 operations a day; Basic or Standard '
      + 'must be applied for, and only if that ceiling is reached.',
    ),
    ACCOUNTS: built(
      'Accessible customers are enumerated after consent, with the accounts under a manager listed '
      + 'alongside it; the operator attaches one per client.',
    ),
    CAMPAIGNS: built('Created through REST v17 with the budget in micros, always PAUSED.'),
    AD_GROUPS: built('Ad groups created against the campaign.'),
    ADS: built('Responsive search ads with headlines and descriptions.'),
    CREATIVES: built('Text assets; image and video assets are not built.'),
    TARGETING: missing('Location and keyword targeting are not written by this integration yet.'),
    PREVIEW: missing('No search-ad preview is rendered from Google\'s own asset data.'),
    CALENDAR: missing('Paid flights do not appear on a calendar yet.'),
    ANALYTICS: built('Daily campaign performance read through GAQL and stored as snapshots.'),
    REPORTING: built('Campaign spend, clicks, impressions, conversions and conversion value.'),
    AI_RECOMMENDATIONS: built('Campaign optimiser findings over recorded performance.'),
  },

  // YouTube advertising is bought through Google Ads as a campaign type, not as
  // a YouTube API. Saying "not implemented" against YouTube would imply a
  // separate integration is missing; the honest answer points at Google Ads.
  [Platform.YOUTUBE]: {
    OAUTH: unsupported('YouTube advertising is bought through Google Ads; there is no YouTube Ads API.'),
    CAMPAIGNS: missing('Video campaigns are a Google Ads campaign type this integration does not create yet.'),
    ADS: missing('Video ads are a Google Ads asset type this integration does not create yet.'),
    PREVIEW: missing('No video ad preview is rendered.'),
  },

  [Platform.LINKEDIN]: {
    OAUTH: missing('LinkedIn Marketing Solutions is a separate approval and is not implemented.'),
    ACCOUNTS: missing('No LinkedIn ads integration exists.'),
    CAMPAIGNS: missing('No LinkedIn ads integration exists.'),
    AD_GROUPS: missing('No LinkedIn ads integration exists.'),
    ADS: missing('No LinkedIn ads integration exists.'),
    CREATIVES: missing('No LinkedIn ads integration exists.'),
    TARGETING: missing('No LinkedIn ads integration exists.'),
    PREVIEW: missing('No LinkedIn ads integration exists.'),
    ANALYTICS: missing('No LinkedIn ads integration exists.'),
    REPORTING: missing('No LinkedIn ads integration exists.'),
  },

  [Platform.SNAPCHAT]: {
    OAUTH: missing('Snap Marketing API login is not implemented.'),
    ACCOUNTS: missing('No Snapchat ads integration exists.'),
    CAMPAIGNS: missing('Snap\'s Marketing API supports campaigns and ad squads; none of it is built here.'),
    AD_GROUPS: missing('No Snapchat ads integration exists.'),
    ADS: missing('No Snapchat ads integration exists.'),
    CREATIVES: missing('No Snapchat ads integration exists.'),
    TARGETING: missing('No Snapchat ads integration exists.'),
    PREVIEW: missing('No Snapchat ads integration exists.'),
    ANALYTICS: missing('No Snapchat ads integration exists.'),
    REPORTING: missing('No Snapchat ads integration exists.'),
  },

};

/** Which credential group each platform's channel depends on. */
const CREDENTIAL_FOR: Record<Platform, { organic: CredentialKey; paid: CredentialKey }> = {
  /*
   * Nothing is ever authored *for* Upload-Post — content names the real network
   * it is going to and the route is resolved at publish time — so it has no
   * channel of its own to depend on a credential for.
   */
  [Platform.UPLOAD_POST]: { organic: 'NONE', paid: 'NONE' },
  [Platform.FACEBOOK]: { organic: 'META', paid: 'META' },
  // Organic Instagram connects on its own; Instagram ads are a Meta ad set.
  [Platform.INSTAGRAM]: { organic: 'INSTAGRAM', paid: 'META' },
  [Platform.TIKTOK]: { organic: 'TIKTOK', paid: 'TIKTOK' },
  [Platform.YOUTUBE]: { organic: 'YOUTUBE', paid: 'GOOGLE_ADS' },
  [Platform.LINKEDIN]: { organic: 'LINKEDIN', paid: 'NONE' },
  [Platform.GOOGLE_BUSINESS]: { organic: 'GOOGLE', paid: 'NONE' },
  [Platform.GOOGLE_ADS]: { organic: 'NONE', paid: 'GOOGLE_ADS' },
  [Platform.SNAPCHAT]: { organic: 'NONE', paid: 'NONE' },
  [Platform.X]: { organic: 'NONE', paid: 'NONE' },
};

// --------------------------------------------------------------- derived

/**
 * Facts the registries already hold, read rather than repeated.
 *
 * A declaration for one of these is ignored on purpose: if `registry.ts` says a
 * platform cannot publish, this file must not be able to claim otherwise, and
 * the way to guarantee that is to never consult the declaration at all.
 */
function derivedOrganic(
  platform: Platform,
  surface: CapabilitySurface,
): { build: BuildState; detail: string } | null {
  if (surface === 'PUBLISHING') {
    const publisher = publisherFor(platform);
    return publisher?.canPublish
      ? { build: 'BUILT', detail: `Published through the ${publisher.label} adapter.` }
      : { build: 'NOT_IMPLEMENTED', detail: 'No publisher is registered for this platform.' };
  }
  if (surface === 'ANALYTICS') {
    // A platform with no ingestion fetcher has no organic metrics, whatever
    // Phase 14 would be willing to display for it.
    return metricsFetcherFor(platform)
      ? { build: 'BUILT', detail: 'Post metrics are fetched on a schedule and read by analytics.' }
      : {
        build: 'NOT_IMPLEMENTED',
        detail: 'No metrics are fetched for this platform, so figures stay Not fetched rather than zero.',
      };
  }
  return null;
}

/**
 * Channels that do not exist for a platform at all.
 *
 * Declared once here rather than as a dozen NOT_SUPPORTED rows per platform.
 * Business Profile is not an advertising product and Google Ads is not an
 * organic one; Snapchat has no organic posting API. Saying so per surface was
 * both repetitive and easy to leave half-done — which is exactly what happened:
 * Google Ads declared only its OAuth row unsupported, so the other nine organic
 * surfaces fell through to "not implemented" and the channel offered itself as
 * a tab for a thing that cannot exist.
 */
const CHANNEL_UNAVAILABLE: Partial<Record<Platform, Partial<Record<MarketingChannel, string>>>> = {
  [Platform.GOOGLE_ADS]: {
    ORGANIC: 'Google Ads is an advertising product and has no organic channel.',
  },
  [Platform.GOOGLE_BUSINESS]: {
    PAID: 'Business Profile is not an advertising product. Google advertising is bought through Google Ads.',
  },
  [Platform.SNAPCHAT]: {
    ORGANIC:
      'Snap publishes no API for posting organic content to a profile. There is no endpoint to '
      + 'call, so this cannot be built rather than merely being unbuilt.',
  },
};

function resolve(input: {
  declaration: Declaration | undefined;
  derived: { build: BuildState; detail: string } | null;
  credential: CredentialGroup;
  fallbackDetail: string;
}): Omit<Capability, 'surface'> {
  const declaration = input.declaration;

  /*
   * Derivation wins, with one exception that running this exposed.
   *
   * `derivedOrganic` answers "did anyone build it" by looking for an entry in
   * the publisher and ingestion registries. Absence from those means unbuilt —
   * but it cannot distinguish unbuilt from unbuildable, and it reported
   * Snapchat organic publishing as NOT_IMPLEMENTED when Snap exposes no organic
   * posting API for it to have been built against. That difference is the whole
   * point of having two states: one is a backlog item, the other never will be.
   *
   * So a declared NOT_SUPPORTED is a statement about the provider's API, and no
   * registry in this repository is entitled to contradict it. Everything else
   * still defers to the registries.
   */
  const build = declaration?.build === 'NOT_SUPPORTED'
    ? 'NOT_SUPPORTED'
    : input.derived?.build ?? declaration?.build ?? 'NOT_IMPLEMENTED';

  /*
   * The declaration's own words win when there are any, because they say
   * something specific. Otherwise the derived sentence is used — which matters:
   * falling back to the generic "not implemented" text on a *derived* BUILT
   * surface printed "Supported — Not implemented in this deployment" against
   * Facebook publishing, a row that contradicted itself.
   */
  const detail = declaration?.detail ?? input.derived?.detail ?? input.fallbackDetail;

  if (build === 'NOT_SUPPORTED') {
    return { state: 'NOT_SUPPORTED', detail, requiredEnv: [], approval: null };
  }
  if (build === 'NOT_IMPLEMENTED') {
    return { state: 'NOT_IMPLEMENTED', detail, requiredEnv: [], approval: null };
  }

  // Built. Credentials first: an approval cannot be exercised without one, so
  // naming the approval to someone who has not set a client secret sends them
  // to the wrong task.
  if (!input.credential.configured()) {
    return {
      state: 'NOT_CONFIGURED',
      detail,
      requiredEnv: [...input.credential.env],
      approval: declaration?.approval ?? null,
    };
  }

  if (declaration?.approval) {
    return { state: 'REQUIRES_APPROVAL', detail, requiredEnv: [], approval: declaration.approval };
  }

  return { state: 'SUPPORTED', detail, requiredEnv: [], approval: null };
}

/**
 * A channel's overall state.
 *
 * The rule is "the worst state that still blocks the channel's core work",
 * which in practice is whatever OAUTH and PUBLISHING/CAMPAIGNS resolve to:
 * a platform whose analytics are unbuilt is still perfectly publishable, and
 * reporting the channel as NOT_IMPLEMENTED because of it would be wrong.
 */
function channelState(channel: MarketingChannel, capabilities: Capability[]): CapabilityState {
  const core: CapabilitySurface[] = channel === 'ORGANIC'
    ? ['OAUTH', 'PUBLISHING']
    : ['OAUTH', 'CAMPAIGNS'];

  const states = capabilities
    .filter((capability) => core.includes(capability.surface))
    .map((capability) => capability.state);

  if (states.length === 0) return 'NOT_IMPLEMENTED';

  // Ordered by how far the operator is from using it.
  for (const state of ['NOT_SUPPORTED', 'NOT_IMPLEMENTED', 'NOT_CONFIGURED', 'REQUIRES_APPROVAL'] as const) {
    if (states.includes(state)) return state;
  }
  return 'SUPPORTED';
}

function buildChannel(platform: Platform, channel: MarketingChannel): ChannelMatrix {
  const surfaces = channel === 'ORGANIC' ? ORGANIC_SURFACES : PAID_SURFACES;

  // A channel that does not exist for this platform: every surface answers the
  // same way, with the same reason, and the channel is not offered as a tab.
  const unavailable = CHANNEL_UNAVAILABLE[platform]?.[channel];
  if (unavailable) {
    return {
      channel,
      available: false,
      capabilities: surfaces.map((surface) => ({
        surface,
        state: 'NOT_SUPPORTED' as const,
        detail: unavailable,
        requiredEnv: [],
        approval: null,
      })),
      state: 'NOT_SUPPORTED',
    };
  }

  const declarations = (channel === 'ORGANIC' ? ORGANIC : PAID)[platform] ?? {};
  const credential = CREDENTIALS[
    channel === 'ORGANIC' ? CREDENTIAL_FOR[platform].organic : CREDENTIAL_FOR[platform].paid
  ];

  const capabilities: Capability[] = surfaces.map((surface) => ({
    surface,
    ...resolve({
      declaration: declarations[surface],
      derived: channel === 'ORGANIC' ? derivedOrganic(platform, surface) : null,
      credential,
      // An undeclared surface is unbuilt, and says so plainly rather than
      // going missing from the list — an absent row reads as an oversight.
      fallbackDetail: 'Not implemented in this deployment.',
    }),
  }));

  const state = channelState(channel, capabilities);

  return {
    channel,
    // A channel is "available" when anything in it is real enough to show. A
    // channel that is NOT_SUPPORTED end to end gets a stated reason, not a tab.
    available: capabilities.some((capability) => capability.state !== 'NOT_SUPPORTED'),
    capabilities,
    state,
  };
}

/** The better of two states — used to summarise a platform across channels. */
function bestOf(a: CapabilityState, b: CapabilityState): CapabilityState {
  const rank: CapabilityState[] = [
    'SUPPORTED', 'REQUIRES_APPROVAL', 'NOT_CONFIGURED', 'NOT_IMPLEMENTED', 'NOT_SUPPORTED',
  ];
  return rank.indexOf(a) <= rank.indexOf(b) ? a : b;
}

export function matrixFor(platform: Platform): PlatformMatrix {
  const organic = buildChannel(platform, 'ORGANIC');
  const paid = buildChannel(platform, 'PAID');

  return {
    platform,
    label: PLATFORM_LABELS[platform],
    organic,
    paid,
    production: bestOf(organic.state, paid.state),
  };
}

/**
 * Every platform the product names, in the order the command centre shows them.
 *
 * X is included despite nothing being built for it, because the publisher
 * registry names it as an explicit refusal and a platform that silently
 * disappears from this list is indistinguishable from one nobody thought of.
 */
export const MATRIX_PLATFORMS: Platform[] = [
  Platform.FACEBOOK,
  Platform.INSTAGRAM,
  Platform.TIKTOK,
  Platform.YOUTUBE,
  Platform.LINKEDIN,
  Platform.SNAPCHAT,
  Platform.GOOGLE_BUSINESS,
  Platform.GOOGLE_ADS,
  Platform.X,
];

export function fullMatrix(): PlatformMatrix[] {
  return MATRIX_PLATFORMS.map(matrixFor);
}

/**
 * Google products that are not Platform enum members.
 *
 * Search Console and GA4 are separate products with their own scopes. They are
 * reported here rather than omitted so the command centre can say they are not
 * connected instead of leaving a panel an operator reads as still loading.
 */
export interface AdjacentProduct {
  key: string;
  label: string;
  state: CapabilityState;
  detail: string;
  requiredEnv: string[];
}

export function adjacentProducts(): AdjacentProduct[] {
  return [
    {
      key: 'SEARCH_CONSOLE',
      label: 'Google Search Console',
      state: 'NOT_IMPLEMENTED',
      detail:
        'Queries, clicks, impressions, CTR and position are available through Search Console, '
        + 'which is a separate Google product with its own scope. It is not connected.',
      requiredEnv: [],
    },
    {
      key: 'GA4',
      label: 'Google Analytics 4',
      state: 'NOT_IMPLEMENTED',
      detail:
        'Traffic, events and conversions are available through the GA4 Data API, a separate '
        + 'Google product with its own scope. It is not connected.',
      requiredEnv: [],
    },
    {
      key: 'LOCAL_RANK_TRACKING',
      label: 'Local ranking positions',
      state: 'NOT_SUPPORTED',
      detail:
        'Google publishes no API for local search rankings. Any product showing them is '
        + 'scraping results or buying third-party data.',
      requiredEnv: [],
    },
  ];
}
