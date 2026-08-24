/**
 * Publishing an ad to Google Ads via the Google Ads API (REST).
 *
 * Google Ads follows a similar hierarchy to Meta:
 *   Campaign → Ad Group → Ad (with an asset / ad creative inline)
 *
 * The REST endpoint is:
 *   POST https://googleads.googleapis.com/v17/customers/{customerId}/campaigns:mutate
 *   POST https://googleads.googleapis.com/v17/customers/{customerId}/adGroups:mutate
 *   POST https://googleads.googleapis.com/v17/customers/{customerId}/adGroupAds:mutate
 *
 * Everything is created PAUSED — same principle as Meta: a publish that goes
 * live immediately spends real money before anyone reviews it.
 *
 * This requires:
 *   - GOOGLE_ADS_DEVELOPER_TOKEN (issued per MCC account)
 *   - OAuth2 with `https://www.googleapis.com/auth/adwords` scope
 *   - A Google Ads customer ID (the ad account)
 */

import { Platform } from '@prisma/client';

const API = 'https://googleads.googleapis.com/v17';

export class GoogleAdsApiError extends Error {
  readonly platform = Platform.GOOGLE_ADS;
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoogleAdsApiError';
    this.status = status;
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
    throw new GoogleAdsApiError(response.status, `${context}: Google Ads returned an unreadable response`);
  }
  if (!response.ok) {
    const error = (payload.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
    throw new GoogleAdsApiError(response.status, `${context}: ${error}`);
  }
  return payload;
}

function headers(accessToken: string, developerToken: string, customerId?: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'content-type': 'application/json',
  };
  if (customerId) h['login-customer-id'] = customerId;
  return h;
}

export interface GoogleAdsCampaignInput {
  customerId: string;
  name: string;
  dailyBudget: number;
  currency: string;
  accessToken: string;
  developerToken: string;
  fetchImpl: FetchLike;
}

export async function createGoogleAdsCampaign(input: GoogleAdsCampaignInput): Promise<{ campaignId: string; budgetId: string }> {
  const { customerId, fetchImpl, accessToken, developerToken } = input;

  const budgetResponse = await fetchImpl(`${API}/customers/${customerId}/campaignBudgets:mutate`, {
    method: 'POST',
    headers: headers(accessToken, developerToken),
    body: JSON.stringify({
      operations: [{
        create: {
          name: `${input.name} — budget`,
          amountMicros: String(Math.round(input.dailyBudget * 1_000_000)),
          deliveryMethod: 'STANDARD',
        },
      }],
    }),
  });
  const budgetPayload = await readJson(budgetResponse, 'Create campaign budget');
  const budgetResults = (budgetPayload.results as Array<{ resourceName?: string }> | undefined) ?? [];
  const budgetResourceName = budgetResults[0]?.resourceName;
  if (!budgetResourceName) throw new GoogleAdsApiError(200, 'Google Ads accepted the budget but returned no resource name');

  const campaignResponse = await fetchImpl(`${API}/customers/${customerId}/campaigns:mutate`, {
    method: 'POST',
    headers: headers(accessToken, developerToken),
    body: JSON.stringify({
      operations: [{
        create: {
          name: input.name,
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: budgetResourceName,
          manualCpc: {},
        },
      }],
    }),
  });
  const campaignPayload = await readJson(campaignResponse, 'Create campaign');
  const campaignResults = (campaignPayload.results as Array<{ resourceName?: string }> | undefined) ?? [];
  const campaignResourceName = campaignResults[0]?.resourceName;
  if (!campaignResourceName) throw new GoogleAdsApiError(200, 'Google Ads accepted the campaign but returned no resource name');

  const campaignId = campaignResourceName.split('/').pop()!;
  const budgetId = budgetResourceName.split('/').pop()!;
  return { campaignId, budgetId };
}

export interface GoogleAdsAdGroupInput {
  customerId: string;
  campaignResourceName: string;
  name: string;
  accessToken: string;
  developerToken: string;
  fetchImpl: FetchLike;
}

export async function createGoogleAdsAdGroup(input: GoogleAdsAdGroupInput): Promise<{ adGroupId: string }> {
  const { customerId, fetchImpl, accessToken, developerToken } = input;

  const response = await fetchImpl(`${API}/customers/${customerId}/adGroups:mutate`, {
    method: 'POST',
    headers: headers(accessToken, developerToken),
    body: JSON.stringify({
      operations: [{
        create: {
          name: input.name,
          campaign: input.campaignResourceName,
          status: 'PAUSED',
          type: 'SEARCH_STANDARD',
          cpcBidMicros: '1000000',
        },
      }],
    }),
  });
  const payload = await readJson(response, 'Create ad group');
  const results = (payload.results as Array<{ resourceName?: string }> | undefined) ?? [];
  const resourceName = results[0]?.resourceName;
  if (!resourceName) throw new GoogleAdsApiError(200, 'Google Ads accepted the ad group but returned no resource name');

  return { adGroupId: resourceName.split('/').pop()! };
}

export interface GoogleAdsAdInput {
  customerId: string;
  adGroupResourceName: string;
  headline: string;
  description: string;
  finalUrl: string;
  accessToken: string;
  developerToken: string;
  fetchImpl: FetchLike;
}

export async function createGoogleAdsAd(input: GoogleAdsAdInput): Promise<{ adId: string }> {
  const { customerId, fetchImpl, accessToken, developerToken } = input;

  const response = await fetchImpl(`${API}/customers/${customerId}/adGroupAds:mutate`, {
    method: 'POST',
    headers: headers(accessToken, developerToken),
    body: JSON.stringify({
      operations: [{
        create: {
          adGroup: input.adGroupResourceName,
          status: 'PAUSED',
          ad: {
            responsiveSearchAd: {
              headlines: [{ text: input.headline.slice(0, 30) }],
              descriptions: [{ text: input.description.slice(0, 90) }],
            },
            finalUrls: [input.finalUrl],
          },
        },
      }],
    }),
  });
  const payload = await readJson(response, 'Create ad');
  const results = (payload.results as Array<{ resourceName?: string }> | undefined) ?? [];
  const resourceName = results[0]?.resourceName;
  if (!resourceName) throw new GoogleAdsApiError(200, 'Google Ads accepted the ad but returned no resource name');

  return { adId: resourceName.split('/').pop()! };
}

export function googleAdsManagerUrl(customerId: string, campaignId: string): string {
  return `https://ads.google.com/aw/campaigns?campaignId=${campaignId}&ocid=${customerId}`;
}
