/**
 * Publishing an ad to TikTok via the TikTok Business API.
 *
 * TikTok's ad hierarchy:
 *   Campaign → Ad Group → Ad (with creative inline)
 *
 * The REST endpoints:
 *   POST https://business-api.tiktok.com/open_api/v1.3/campaign/create/
 *   POST https://business-api.tiktok.com/open_api/v1.3/adgroup/create/
 *   POST https://business-api.tiktok.com/open_api/v1.3/ad/create/
 *
 * Everything is created with `operation_status: DISABLE` — TikTok's equivalent
 * of PAUSED. Same principle: never spend money automatically.
 *
 * Requires:
 *   - TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET
 *   - OAuth2 access token with ad management scopes
 *   - An advertiser_id (TikTok's ad account identifier)
 */

import { Platform } from '@prisma/client';

const API = 'https://business-api.tiktok.com/open_api/v1.3';

export class TikTokAdsApiError extends Error {
  readonly platform = Platform.TIKTOK;
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = 'TikTokAdsApiError';
    this.status = status;
    this.code = code ?? null;
  }
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new TikTokAdsApiError(response.status, `${context}: TikTok returned an unreadable response`);
  }
  const code = payload.code as number | undefined;
  if (code !== undefined && code !== 0) {
    const message = (payload.message as string | undefined) ?? `TikTok error code ${code}`;
    throw new TikTokAdsApiError(response.status, `${context}: ${message}`, code);
  }
  if (!response.ok) {
    throw new TikTokAdsApiError(response.status, `${context}: HTTP ${response.status}`);
  }
  return payload;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    'access-token': accessToken,
    'content-type': 'application/json',
  };
}

export interface TikTokCampaignInput {
  advertiserId: string;
  name: string;
  objective: string;
  dailyBudget: number;
  accessToken: string;
  fetchImpl: FetchLike;
}

export async function createTikTokCampaign(input: TikTokCampaignInput): Promise<{ campaignId: string }> {
  const response = await input.fetchImpl(`${API}/campaign/create/`, {
    method: 'POST',
    headers: authHeaders(input.accessToken),
    body: JSON.stringify({
      advertiser_id: input.advertiserId,
      campaign_name: input.name,
      objective_type: input.objective || 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_DAY',
      budget: input.dailyBudget,
      operation_status: 'DISABLE',
    }),
  });
  const payload = await readJson(response, 'Create campaign');
  const data = payload.data as { campaign_id?: string } | undefined;
  if (!data?.campaign_id) throw new TikTokAdsApiError(200, 'TikTok accepted the campaign but returned no campaign_id');
  return { campaignId: data.campaign_id };
}

export interface TikTokAdGroupInput {
  advertiserId: string;
  campaignId: string;
  name: string;
  dailyBudget: number;
  accessToken: string;
  fetchImpl: FetchLike;
}

export async function createTikTokAdGroup(input: TikTokAdGroupInput): Promise<{ adGroupId: string }> {
  const response = await input.fetchImpl(`${API}/adgroup/create/`, {
    method: 'POST',
    headers: authHeaders(input.accessToken),
    body: JSON.stringify({
      advertiser_id: input.advertiserId,
      campaign_id: input.campaignId,
      adgroup_name: input.name,
      budget_mode: 'BUDGET_MODE_DAY',
      budget: input.dailyBudget,
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
      billing_event: 'CPC',
      bid_type: 'BID_TYPE_NO_BID',
    }),
  });
  const payload = await readJson(response, 'Create ad group');
  const data = payload.data as { adgroup_id?: string } | undefined;
  if (!data?.adgroup_id) throw new TikTokAdsApiError(200, 'TikTok accepted the ad group but returned no adgroup_id');
  return { adGroupId: data.adgroup_id };
}

export interface TikTokAdInput {
  advertiserId: string;
  adGroupId: string;
  name: string;
  headline: string;
  landingPageUrl: string;
  accessToken: string;
  fetchImpl: FetchLike;
}

export async function createTikTokAd(input: TikTokAdInput): Promise<{ adId: string }> {
  const response = await input.fetchImpl(`${API}/ad/create/`, {
    method: 'POST',
    headers: authHeaders(input.accessToken),
    body: JSON.stringify({
      advertiser_id: input.advertiserId,
      adgroup_id: input.adGroupId,
      creatives: [{
        ad_name: input.name,
        ad_text: input.headline,
        landing_page_url: input.landingPageUrl,
        call_to_action: 'LEARN_MORE',
      }],
    }),
  });
  const payload = await readJson(response, 'Create ad');
  const data = payload.data as { ad_ids?: string[] } | undefined;
  if (!data?.ad_ids?.[0]) throw new TikTokAdsApiError(200, 'TikTok accepted the ad but returned no ad_id');
  return { adId: data.ad_ids[0] };
}

export function tiktokAdsManagerUrl(advertiserId: string, campaignId: string): string {
  return `https://ads.tiktok.com/i18n/perf?aadvid=${advertiserId}&campaign_id=${campaignId}`;
}
