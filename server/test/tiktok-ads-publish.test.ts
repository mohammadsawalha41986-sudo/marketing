import { describe, expect, it } from 'vitest';

import {
  createTikTokCampaign,
  createTikTokAdGroup,
  createTikTokAd,
  tiktokAdsManagerUrl,
  TikTokAdsApiError,
} from '../src/services/integrations/tiktok-ads-publish.js';

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function fetchOnce(body: unknown, status = 200): { fetchImpl: FetchLike; seen: Array<{ url: string; init: unknown }> } {
  const seen: Array<{ url: string; init: unknown }> = [];
  const fetchImpl = (async (url: string, init?: unknown) => {
    seen.push({ url, init });
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
    };
  }) as FetchLike;
  return { fetchImpl, seen };
}

describe('TikTok Ads publish', () => {
  it('creates a campaign and returns the campaign id', async () => {
    const { fetchImpl, seen } = fetchOnce({
      code: 0,
      data: { campaign_id: 'CAMP123' },
    });

    const result = await createTikTokCampaign({
      advertiserId: 'ADV1',
      name: 'Summer Sale',
      objective: 'TRAFFIC',
      dailyBudget: 100,
      accessToken: 'token',
      fetchImpl,
    });

    expect(result.campaignId).toBe('CAMP123');
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.operation_status).toBe('DISABLE');
    expect(body.advertiser_id).toBe('ADV1');
  });

  it('creates an ad group linked to a campaign', async () => {
    const { fetchImpl } = fetchOnce({
      code: 0,
      data: { adgroup_id: 'AG456' },
    });

    const result = await createTikTokAdGroup({
      advertiserId: 'ADV1',
      campaignId: 'CAMP123',
      name: 'Summer Sale — ad group',
      dailyBudget: 100,
      accessToken: 'token',
      fetchImpl,
    });

    expect(result.adGroupId).toBe('AG456');
  });

  it('creates an ad and returns the ad id', async () => {
    const { fetchImpl, seen } = fetchOnce({
      code: 0,
      data: { ad_ids: ['AD789'] },
    });

    const result = await createTikTokAd({
      advertiserId: 'ADV1',
      adGroupId: 'AG456',
      name: 'Summer Sale ad',
      headline: 'Best deals this summer',
      landingPageUrl: 'https://pawease.com/summer',
      accessToken: 'token',
      fetchImpl,
    });

    expect(result.adId).toBe('AD789');
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.creatives[0].landing_page_url).toBe('https://pawease.com/summer');
  });

  it('throws TikTokAdsApiError on non-zero code', async () => {
    const { fetchImpl } = fetchOnce({
      code: 40001,
      message: 'Invalid access token',
    });

    await expect(
      createTikTokCampaign({
        advertiserId: 'ADV1',
        name: 'Fail',
        objective: 'TRAFFIC',
        dailyBudget: 10,
        accessToken: 'bad',
        fetchImpl,
      }),
    ).rejects.toThrow(TikTokAdsApiError);
  });

  it('throws when no campaign_id is returned', async () => {
    const { fetchImpl } = fetchOnce({ code: 0, data: {} });

    await expect(
      createTikTokCampaign({
        advertiserId: 'ADV1',
        name: 'NoId',
        objective: 'TRAFFIC',
        dailyBudget: 10,
        accessToken: 'token',
        fetchImpl,
      }),
    ).rejects.toThrow(/no campaign_id/i);
  });

  it('builds a valid TikTok Ads Manager URL', () => {
    const url = tiktokAdsManagerUrl('ADV1', 'CAMP1');
    expect(url).toContain('aadvid=ADV1');
    expect(url).toContain('campaign_id=CAMP1');
  });
});
