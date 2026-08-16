/**
 * Ingesting Meta's numbers, with the provider's JSON standing in for the network.
 *
 * Before this existed, `AnalyticsSnapshot` had one writer — the seed script —
 * so every dashboard figure was demo data. The assertions that matter here are
 * about arithmetic honesty: a re-sync must not double-count, a revised day must
 * replace rather than accumulate, and spend we cannot attribute to a local
 * campaign must be skipped with a reason rather than attached to a guess.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform, PublicationStatus } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { syncMetaMetrics } from '../src/services/integrations/metric-sync.js';
import { encryptSecret } from '../src/lib/crypto.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

/** Meta's real insights shape, including the actions array. */
function insightsFetch(rows: Array<Record<string, unknown>>, calls: string[] = []): FetchLike {
  return (async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: rows }),
      text: async () => JSON.stringify({ data: rows }),
    };
  }) as FetchLike;
}

const day = (iso: string, spend: number, extra: Record<string, unknown> = {}) => ({
  date_start: iso,
  spend: String(spend),
  impressions: '1000',
  reach: '800',
  clicks: '40',
  ...extra,
});

describe('Meta metric ingestion', () => {
  let tenant: Tenant;
  let integrationId: string;
  let campaignId: string;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('metrics');
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    campaignId = tenant.campaignId;
  });

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    await prisma.analyticsSnapshot.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.adPublication.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.integrationSyncRun.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });

    const integration = await prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: IntegrationStatus.CONNECTED,
        accountName: 'Operator',
        accessTokenEnc: encryptSecret('a-live-token'),
        accounts: {
          create: [
            { clientId: tenant.clientId, kind: 'AD_ACCOUNT', externalId: 'act_1', name: 'Ads', currency: 'SAR', selected: true },
          ],
        },
      },
    });
    integrationId = integration.id;
  });

  const publish = (overrides: Record<string, unknown> = {}) =>
    prisma.adPublication.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        campaignId,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.PUBLISHED,
        providerCampaignId: '120200000000001',
        name: 'Ramadan burger',
        objective: 'OUTCOME_SALES',
        dailyBudget: 100,
        currency: 'SAR',
        startDate: new Date('2026-08-01'),
        endDate: new Date('2026-08-10'),
        countries: ['SA'],
        linkUrl: 'https://example.com',
        message: 'Burger',
        headline: 'Burger',
        ...overrides,
      },
    });

  const run = (fetchImpl: FetchLike) =>
    syncMetaMetrics({ prisma, integrationId, organizationId: tenant.organizationId, fetchImpl });

  it('writes real provider figures into AnalyticsSnapshot', async () => {
    await publish();
    const result = await run(insightsFetch([day('2026-08-14', 250.5), day('2026-08-15', 310.25)]));

    expect(result?.status).toBe('SUCCESS');
    expect(result?.created).toBe(2);
    expect(result?.campaignsRead).toBe(1);

    const rows = await prisma.analyticsSnapshot.findMany({
      where: { campaignId },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.spend)).toBe(250.5);
    expect(rows[0]!.impressions).toBe(1000);
    expect(rows[0]!.clicks).toBe(40);
  });

  it('does not double-count when the same window is synced twice', async () => {
    await publish();
    const rows = [day('2026-08-14', 250.5)];

    await run(insightsFetch(rows));
    const second = await run(insightsFetch(rows));

    expect(second?.created).toBe(0);
    expect(second?.updated).toBe(1);

    const stored = await prisma.analyticsSnapshot.findMany({ where: { campaignId } });
    expect(stored).toHaveLength(1);
    // Replaced, not accumulated.
    expect(Number(stored[0]!.spend)).toBe(250.5);
  });

  it('lets Meta revise a day it has already reported', async () => {
    await publish();
    await run(insightsFetch([day('2026-08-14', 100)]));
    // Meta settles attribution and reports a different number for the same day.
    await run(insightsFetch([day('2026-08-14', 137.75)]));

    const stored = await prisma.analyticsSnapshot.findMany({ where: { campaignId } });
    expect(stored).toHaveLength(1);
    expect(Number(stored[0]!.spend)).toBe(137.75);
  });

  it('reads conversions and revenue from the actions arrays', async () => {
    await publish();
    await run(
      insightsFetch([
        day('2026-08-14', 200, {
          actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '7' }],
          action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '1400.5' }],
        }),
      ]),
    );

    const row = await prisma.analyticsSnapshot.findFirstOrThrow({ where: { campaignId } });
    expect(row.conversions).toBe(7);
    expect(Number(row.revenue)).toBe(1400.5);
  });

  it('reports when a campaign tracks no conversions at all', async () => {
    await publish();
    const result = await run(insightsFetch([day('2026-08-14', 200)]));

    // Zero conversions measured is different from conversions never tracked,
    // and the run says which this was.
    expect(result?.conversionTracking).toBe(false);

    const row = await prisma.analyticsSnapshot.findFirstOrThrow({ where: { campaignId } });
    expect(row.conversions).toBe(0);
  });

  it('skips spend it cannot attribute rather than guessing a campaign', async () => {
    const orphan = await publish({ campaignId: null });
    const result = await run(insightsFetch([day('2026-08-14', 999)]));

    expect(result?.campaignsRead).toBe(0);
    expect(result?.skipped).toHaveLength(1);
    expect(result?.skipped[0]?.publicationId).toBe(orphan.id);
    expect(result?.skipped[0]?.reason).toMatch(/not linked to a local campaign/i);

    // And nothing was written, so no ratio is computed from a guess.
    expect(await prisma.analyticsSnapshot.count({ where: { organizationId: tenant.organizationId } })).toBe(0);
  });

  it('ignores advertisements that were never published', async () => {
    await publish({ status: PublicationStatus.DRAFT, providerCampaignId: null });
    const result = await run(insightsFetch([day('2026-08-14', 500)]));

    expect(result?.campaignsRead).toBe(0);
    expect(await prisma.analyticsSnapshot.count()).toBe(0);
  });

  it('re-reads recent days on a later sync so revisions are picked up', async () => {
    await publish();
    const calls: string[] = [];

    await prisma.integration.update({
      where: { id: integrationId },
      data: { lastSyncAt: new Date('2026-08-15T00:00:00.000Z') },
    });

    await syncMetaMetrics({
      prisma,
      integrationId,
      organizationId: tenant.organizationId,
      fetchImpl: insightsFetch([], calls),
      now: new Date('2026-08-16T00:00:00.000Z'),
    });

    const timeRange = decodeURIComponent(calls[0] ?? '');
    // Three days of overlap, not "since the last sync".
    expect(timeRange).toContain('"since":"2026-08-12"');
    expect(timeRange).toContain('"until":"2026-08-16"');
  });

  it('records a failed run instead of throwing the provider error away', async () => {
    await publish();
    const failing: FetchLike = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
      text: async () => '',
    })) as FetchLike;

    const result = await run(failing);

    expect(result?.status).toBe('FAILED');
    expect(result?.errorMessage).toMatch(/Invalid OAuth access token/);

    const run_ = await prisma.integrationSyncRun.findFirstOrThrow({ where: { integrationId } });
    expect(run_.status).toBe('FAILED');
    // The provider's own words, kept.
    expect(run_.errorMessage).toMatch(/Invalid OAuth access token/);
  });

  it('refuses to sync a connection that is not connected', async () => {
    await prisma.integration.update({
      where: { id: integrationId },
      data: { status: IntegrationStatus.DISCONNECTED },
    });

    await expect(run(insightsFetch([]))).rejects.toThrow(/nothing to sync/i);
  });

  it('cannot be run against another tenant\'s integration', async () => {
    const other = await createTenant('metrics-other');
    const result = await syncMetaMetrics({
      prisma,
      integrationId,
      organizationId: other.organizationId,
      fetchImpl: insightsFetch([]),
    });
    expect(result).toBeNull();
  });
});
