/**
 * Publishing to Meta.
 *
 * The whole file exists to serve one rule: **nothing is PUBLISHED until Meta
 * says so.** Every step below returns an id that Meta minted, and a step that
 * cannot produce one throws. There is no code path that sets a published state
 * from a local decision, a timeout, or an optimistic assumption — an operator
 * looking at "Published" must be able to open Ads Manager and find it.
 *
 * Meta's object hierarchy, which the sequence follows exactly:
 *
 *   Campaign   objective and status
 *     Ad Set   budget, schedule, targeting, optimisation
 *       Ad     the thing that runs, pointing at
 *   Creative   the uploaded image or video plus the copy
 *
 * Two Meta-specific hazards are handled here rather than left to the caller.
 * Budgets are minor units (halalas, cents) as integers, and sending 50 when you
 * meant 50.00 underspends by a hundredfold — every amount crossing this boundary
 * is converted explicitly. And everything is created PAUSED: a publish that goes
 * live the instant it is created spends real money before anyone has looked at
 * it in Ads Manager.
 *
 * Uses the same injectable `FetchLike` as the rest of the Meta adapter, so the
 * full sequence runs in tests against Meta's own response shapes.
 */

import { Platform } from '@prisma/client';

import { GRAPH_VERSION, ProviderApiError, type FetchLike } from './meta.js';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Read a Graph response, turning Meta's error envelope into something an
 * operator can act on.
 *
 * Meta returns HTTP 400 with a structured body for everything from an expired
 * token to a rejected budget, and the useful part is `error.error_user_msg` —
 * the message Meta itself would show in Ads Manager. Surfacing the raw status
 * alone would tell the operator "400" and nothing else.
 */
async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};

  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ProviderApiError(Platform.FACEBOOK, response.status, `${context}: Meta returned an unreadable response`);
  }

  if (!response.ok || payload.error) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    const message =
      (error.error_user_msg as string) ??
      (error.message as string) ??
      `Meta rejected the request (HTTP ${response.status})`;

    throw new ProviderApiError(Platform.FACEBOOK, response.status, `${context}: ${message}`);
  }

  return payload;
}

/** Meta wants integer minor units. 50.00 SAR is 5000, never 50. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

async function post(input: {
  path: string;
  params: Record<string, string>;
  accessToken: string;
  fetchImpl: FetchLike;
  context: string;
}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...input.params, access_token: input.accessToken });

  const response = await input.fetchImpl(`${GRAPH}/${input.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  return readJson(response, input.context);
}

/** An id Meta actually returned, or a failure. Never a locally invented one. */
function requireId(payload: Record<string, unknown>, context: string): string {
  const id = payload.id ?? payload.video_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ProviderApiError(Platform.FACEBOOK, 502, `${context}: Meta returned no id, so nothing was published`);
  }
  return id;
}

// ------------------------------------------------------------------ campaign

export type MetaObjective =
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_SALES'
  | 'OUTCOME_APP_PROMOTION';

export async function createCampaign(input: {
  adAccountId: string;
  name: string;
  objective: MetaObjective;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ campaignId: string }> {
  const payload = await post({
    path: `${input.adAccountId}/campaigns`,
    params: {
      name: input.name,
      objective: input.objective,
      // Paused on creation, always. See the file comment: a campaign that goes
      // live at creation spends money before anyone has reviewed it.
      status: 'PAUSED',
      special_ad_categories: '[]',
    },
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    context: 'Creating the Meta campaign',
  });

  return { campaignId: requireId(payload, 'Creating the Meta campaign') };
}

// -------------------------------------------------------------------- ad set

export interface AdSetInput {
  adAccountId: string;
  campaignId: string;
  name: string;
  dailyBudget: number;
  currency: string;
  startTime: Date;
  endTime: Date;
  /** Country codes. Meta requires geo targeting on every ad set. */
  countries: string[];
  optimizationGoal?: string;
  billingEvent?: string;
  accessToken: string;
  fetchImpl: FetchLike;
}

export async function createAdSet(input: AdSetInput): Promise<{ adSetId: string }> {
  const payload = await post({
    path: `${input.adAccountId}/adsets`,
    params: {
      name: input.name,
      campaign_id: input.campaignId,
      daily_budget: String(toMinorUnits(input.dailyBudget)),
      billing_event: input.billingEvent ?? 'IMPRESSIONS',
      optimization_goal: input.optimizationGoal ?? 'LINK_CLICKS',
      start_time: input.startTime.toISOString(),
      end_time: input.endTime.toISOString(),
      // Geo targeting is mandatory; an ad set without it is rejected, and
      // defaulting to "everywhere" would spend a local budget globally.
      targeting: JSON.stringify({ geo_locations: { countries: input.countries } }),
      status: 'PAUSED',
    },
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    context: 'Creating the Meta ad set',
  });

  return { adSetId: requireId(payload, 'Creating the Meta ad set') };
}

// ------------------------------------------------------------------ uploads

/**
 * Upload an image and return the hash Meta files it under.
 *
 * The images endpoint answers with a map keyed by *filename*, not a flat id, so
 * the hash has to be dug out of the first entry rather than read off the top
 * level like every other Graph response.
 */
export async function uploadImage(input: {
  adAccountId: string;
  bytes: Buffer;
  filename: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ imageHash: string }> {
  const payload = await post({
    path: `${input.adAccountId}/adimages`,
    params: { bytes: input.bytes.toString('base64') },
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    context: 'Uploading the image to Meta',
  });

  const images = (payload.images ?? {}) as Record<string, { hash?: string }>;
  const hash = Object.values(images)[0]?.hash;

  if (!hash) {
    throw new ProviderApiError(Platform.FACEBOOK, 502, 'Uploading the image to Meta: no image hash was returned');
  }
  return { imageHash: hash };
}

/**
 * Upload a video.
 *
 * Meta processes video asynchronously: the id comes back immediately but the
 * asset is unusable until processing finishes, and creating an ad against a
 * still-processing video fails with an error that does not say so. The caller
 * polls `videoStatus` before proceeding.
 */
export async function uploadVideo(input: {
  adAccountId: string;
  bytes: Buffer;
  filename: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ videoId: string }> {
  const payload = await post({
    path: `${input.adAccountId}/advideos`,
    params: { source: input.bytes.toString('base64'), name: input.filename },
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    context: 'Uploading the video to Meta',
  });

  return { videoId: requireId(payload, 'Uploading the video to Meta') };
}

export async function videoStatus(input: {
  videoId: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ status: string; ready: boolean; error: string | null }> {
  const url = new URL(`${GRAPH}/${input.videoId}`);
  url.searchParams.set('fields', 'status');
  url.searchParams.set('access_token', input.accessToken);

  const payload = await readJson(await input.fetchImpl(url.toString()), 'Checking Meta video processing');
  const status = (payload.status ?? {}) as Record<string, unknown>;
  const phase = (status.video_status as string) ?? 'unknown';

  return {
    status: phase,
    ready: phase === 'ready',
    error: phase === 'error' ? ((status.processing_progress as string) ?? 'Meta could not process the video') : null,
  };
}

// ----------------------------------------------------------------- creative

export interface CreativeInput {
  adAccountId: string;
  name: string;
  pageId: string;
  instagramActorId?: string | null;
  message: string;
  headline: string;
  description?: string | null;
  linkUrl: string;
  callToAction?: string;
  imageHash?: string | null;
  videoId?: string | null;
  /** Required alongside a video: Meta will not accept one without a thumbnail. */
  videoThumbnailHash?: string | null;
  accessToken: string;
  fetchImpl: FetchLike;
}

export async function createAdCreative(input: CreativeInput): Promise<{ creativeId: string }> {
  if (!input.imageHash && !input.videoId) {
    throw new ProviderApiError(Platform.FACEBOOK, 400, 'An ad creative needs either an image or a video');
  }

  const linkData = {
    message: input.message,
    link: input.linkUrl,
    name: input.headline,
    ...(input.description ? { description: input.description } : {}),
    ...(input.callToAction ? { call_to_action: { type: input.callToAction, value: { link: input.linkUrl } } } : {}),
  };

  // Video and image creatives use different spec keys; Meta rejects a payload
  // carrying both.
  const objectStorySpec = input.videoId
    ? {
        page_id: input.pageId,
        ...(input.instagramActorId ? { instagram_actor_id: input.instagramActorId } : {}),
        video_data: {
          video_id: input.videoId,
          ...(input.videoThumbnailHash ? { image_hash: input.videoThumbnailHash } : {}),
          message: input.message,
          title: input.headline,
          ...(input.callToAction
            ? { call_to_action: { type: input.callToAction, value: { link: input.linkUrl } } }
            : {}),
        },
      }
    : {
        page_id: input.pageId,
        ...(input.instagramActorId ? { instagram_actor_id: input.instagramActorId } : {}),
        link_data: { ...linkData, image_hash: input.imageHash },
      };

  const payload = await post({
    path: `${input.adAccountId}/adcreatives`,
    params: { name: input.name, object_story_spec: JSON.stringify(objectStorySpec) },
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    context: 'Creating the Meta ad creative',
  });

  return { creativeId: requireId(payload, 'Creating the Meta ad creative') };
}

// ----------------------------------------------------------------------- ad

export async function createAd(input: {
  adAccountId: string;
  name: string;
  adSetId: string;
  creativeId: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ adId: string }> {
  const payload = await post({
    path: `${input.adAccountId}/ads`,
    params: {
      name: input.name,
      adset_id: input.adSetId,
      creative: JSON.stringify({ creative_id: input.creativeId }),
      status: 'PAUSED',
    },
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl,
    context: 'Creating the Meta ad',
  });

  return { adId: requireId(payload, 'Creating the Meta ad') };
}

/**
 * Read an object back from Meta.
 *
 * This is the confirmation step, and it is not ceremony. A create call can
 * return an id for an object that is then rejected in review or fails
 * validation asynchronously; fetching it back is the difference between "Meta
 * accepted our request" and "the ad exists".
 */
export async function fetchAd(input: {
  adId: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<{ id: string; name: string; status: string; effectiveStatus: string | null }> {
  const url = new URL(`${GRAPH}/${input.adId}`);
  url.searchParams.set('fields', 'id,name,status,effective_status');
  url.searchParams.set('access_token', input.accessToken);

  const payload = await readJson(await input.fetchImpl(url.toString()), 'Confirming the Meta ad');

  return {
    id: payload.id as string,
    name: (payload.name as string) ?? '',
    status: (payload.status as string) ?? 'UNKNOWN',
    effectiveStatus: (payload.effective_status as string | undefined) ?? null,
  };
}

/** Ads Manager deep link, so "View in Meta" goes somewhere real. */
export function adsManagerUrl(adAccountId: string, campaignId: string): string {
  const account = adAccountId.replace(/^act_/, '');
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${account}&selected_campaign_ids=${campaignId}`;
}
