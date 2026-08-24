import { describe, expect, it } from 'vitest';

import {
  createGoogleAdsCampaign,
  createGoogleAdsAdGroup,
  createGoogleAdsAd,
  googleAdsManagerUrl,
  GoogleAdsApiError,
} from '../src/services/integrations/google-ads-publish.js';

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

function fetchSequence(
  responses: Array<{ body: unknown; status?: number }>,
): { fetchImpl: FetchLike; seen: Array<{ url: string; init: unknown }> } {
  const seen: Array<{ url: string; init: unknown }> = [];
  let call = 0;
  const fetchImpl = (async (url: string, init?: unknown) => {
    seen.push({ url, init });
    const resp = responses[call++] ?? { body: {}, status: 500 };
    const status = resp.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(resp.body) };
  }) as FetchLike;
  return { fetchImpl, seen };
}

describe('Google Ads publish', () => {
  it('creates a campaign with budget and returns the campaign id', async () => {
    const { fetchImpl, seen } = fetchSequence([
      { body: { results: [{ resourceName: 'customers/123/campaignBudgets/456' }] } },
      { body: { results: [{ resourceName: 'customers/123/campaigns/789' }] } },
    ]);

    const result = await createGoogleAdsCampaign({
      customerId: '123',
      name: 'Test Campaign',
      dailyBudget: 50,
      currency: 'USD',
      accessToken: 'token',
      developerToken: 'dev-token',
      fetchImpl,
    });

    expect(result.campaignId).toBe('789');
    expect(result.budgetId).toBe('456');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toContain('/campaignBudgets:mutate');
    expect(seen[1]?.url).toContain('/campaigns:mutate');

    const budgetBody = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(budgetBody.operations[0].create.amountMicros).toBe('50000000');

    const campaignBody = JSON.parse((seen[1]?.init as { body: string }).body);
    expect(campaignBody.operations[0].create.status).toBe('PAUSED');
  });

  it('creates an ad group linked to a campaign', async () => {
    const { fetchImpl } = fetchOnce({
      results: [{ resourceName: 'customers/123/adGroups/AG1' }],
    });

    const result = await createGoogleAdsAdGroup({
      customerId: '123',
      campaignResourceName: 'customers/123/campaigns/789',
      name: 'Test Ad Group',
      accessToken: 'token',
      developerToken: 'dev-token',
      fetchImpl,
    });

    expect(result.adGroupId).toBe('AG1');
  });

  it('creates a responsive search ad', async () => {
    const { fetchImpl, seen } = fetchOnce({
      results: [{ resourceName: 'customers/123/adGroupAds/AD1~1' }],
    });

    const result = await createGoogleAdsAd({
      customerId: '123',
      adGroupResourceName: 'customers/123/adGroups/AG1',
      headline: 'Great Pets',
      description: 'Visit PawEase for the best pet care',
      finalUrl: 'https://pawease.com',
      accessToken: 'token',
      developerToken: 'dev-token',
      fetchImpl,
    });

    expect(result.adId).toBe('AD1~1');
    const body = JSON.parse((seen[0]?.init as { body: string }).body);
    expect(body.operations[0].create.status).toBe('PAUSED');
    expect(body.operations[0].create.ad.finalUrls).toEqual(['https://pawease.com']);
  });

  it('throws GoogleAdsApiError on failure', async () => {
    const { fetchImpl } = fetchOnce(
      { error: { message: 'Authentication failed' } },
      401,
    );

    await expect(
      createGoogleAdsCampaign({
        customerId: '123',
        name: 'Fail',
        dailyBudget: 10,
        currency: 'USD',
        accessToken: 'bad',
        developerToken: 'dev',
        fetchImpl,
      }),
    ).rejects.toThrow(GoogleAdsApiError);
  });

  it('throws when no resource name is returned', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { results: [{ resourceName: 'customers/123/campaignBudgets/456' }] } },
      { body: { results: [] } },
    ]);

    await expect(
      createGoogleAdsCampaign({
        customerId: '123',
        name: 'NoId',
        dailyBudget: 10,
        currency: 'USD',
        accessToken: 'token',
        developerToken: 'dev',
        fetchImpl,
      }),
    ).rejects.toThrow(/no resource name/i);
  });

  it('builds a valid Ads Manager URL', () => {
    const url = googleAdsManagerUrl('1234567890', 'C1');
    expect(url).toContain('campaignId=C1');
    expect(url).toContain('ocid=1234567890');
  });
});
