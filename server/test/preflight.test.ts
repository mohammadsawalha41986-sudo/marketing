/**
 * The gate between a draft and real money.
 *
 * These assertions are mostly about refusing: an advertisement that would spend
 * a budget must not get past preflight while the connection is missing, the
 * account is not attached, the currency disagrees with the ad account, the file
 * is gone from storage or nobody has approved it.
 *
 * The other half is what preflight must *not* claim. It never says an ad is
 * approved by Meta, and missing conversion tracking is a warning rather than a
 * block, because awareness campaigns are legitimate and refusing them would be
 * wrong.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationStatus, Platform, PublicationStatus } from '@prisma/client';

import { createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { preflight } from '../src/services/campaign/preflight.js';
import { storage } from '../src/services/storage/index.js';

const KEY = 'Zm9yLXRlc3Rpbmctb25seS0zMi1ieXRlLWtleS0hIQ==';

describe('campaign preflight', () => {
  let tenant: Tenant;
  let creativeId: string;

  beforeAll(async () => {
    await resetDatabase();
    tenant = await createTenant('preflight');
    process.env.TOKEN_ENCRYPTION_KEY = KEY;

    // A real object, because preflight checks that the bytes are actually there
    // — pointing at a key that was never written is exactly what it must catch.
    const stored = await storage.save(Buffer.from('pretend-jpeg-bytes'), {
      filename: 'ad.jpg',
      mimeType: 'image/jpeg',
      prefix: `clients/${tenant.clientId}/assets`,
    });

    const media = await prisma.media.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        type: 'IMAGE',
        filename: stored.key,
        originalName: 'ad.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1_500_000,
        width: 1080,
        height: 1080,
        url: '/api/media/x/file',
      },
    });

    const creative = await prisma.creative.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        source: 'UPLOADED',
        mediaId: media.id,
        platform: Platform.FACEBOOK,
        preset: 'UPLOADED',
        width: 1080,
        height: 1080,
        storageKey: stored.key,
        url: '/api/creatives/x/file',
        sizeBytes: 1_500_000,
      },
    });
    creativeId = creative.id;
  });

  beforeEach(async () => {
    await prisma.adPublication.deleteMany({ where: { organizationId: tenant.organizationId } });
    await prisma.integrationAccount.deleteMany({ where: { clientId: tenant.clientId } });
    await prisma.integration.deleteMany({ where: { clientId: tenant.clientId } });
  });

  const draft = (overrides: Record<string, unknown> = {}) =>
    prisma.adPublication.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        creativeId,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.APPROVED,
        name: 'Weekend brunch',
        objective: 'OUTCOME_TRAFFIC',
        dailyBudget: 25,
        currency: 'SAR',
        startDate: new Date(Date.now() + 86_400_000),
        endDate: new Date(Date.now() + 8 * 86_400_000),
        countries: ['SA'],
        linkUrl: 'https://example.com/brunch',
        message: 'Brunch, every weekend.',
        headline: 'Weekend brunch',
        ...overrides,
      },
    });

  const connect = (overrides: { currency?: string; status?: IntegrationStatus; withPage?: boolean } = {}) =>
    prisma.integration.create({
      data: {
        organizationId: tenant.organizationId,
        clientId: tenant.clientId,
        platform: Platform.FACEBOOK,
        status: overrides.status ?? IntegrationStatus.CONNECTED,
        accountName: 'Test Operator',
        accessTokenEnc: 'encrypted-placeholder',
        accounts: {
          create: [
            {
              clientId: tenant.clientId, kind: 'AD_ACCOUNT', externalId: 'act_1',
              name: 'Ads', currency: overrides.currency ?? 'SAR', selected: true,
            },
            ...(overrides.withPage === false
              ? []
              : [{ clientId: tenant.clientId, kind: 'PAGE' as const, externalId: 'page-1', name: 'The Page', selected: true }]),
          ],
        },
      },
    });

  const run = async (publicationId: string) =>
    preflight({ prisma, publicationId, organizationId: tenant.organizationId });

  it('blocks when the restaurant is not connected to Meta', async () => {
    const publication = await draft();
    const report = await run(publication.id);

    expect(report?.outcome).toBe('BLOCK');
    expect(report?.canPublish).toBe(false);
    const connection = report?.checks.find((check) => check.key === 'connection');
    expect(connection?.outcome).toBe('BLOCK');
    expect(connection?.fix).toMatch(/connect meta/i);
  });

  it('blocks an authorized connection that has no accounts attached', async () => {
    await connect({ status: IntegrationStatus.CONNECTING });
    const publication = await draft();
    const report = await run(publication.id);

    expect(report?.canPublish).toBe(false);
    expect(report?.checks.find((check) => check.key === 'connection')?.fix).toMatch(/choosing which accounts/i);
  });

  it('blocks when no Facebook Page is attached', async () => {
    await connect({ withPage: false });
    const publication = await draft();
    const report = await run(publication.id);

    expect(report?.checks.find((check) => check.key === 'page')?.outcome).toBe('BLOCK');
  });

  it('blocks a budget denominated in a currency the ad account does not bill in', async () => {
    await connect({ currency: 'SAR' });
    const publication = await draft({ currency: 'USD' });
    const report = await run(publication.id);

    const currency = report?.checks.find((check) => check.key === 'currency');
    expect(currency?.outcome).toBe('BLOCK');
    expect(currency?.detail).toContain('SAR');
    expect(currency?.detail).toContain('USD');
  });

  it('blocks an unapproved draft, because publishing spends the budget', async () => {
    await connect();
    const publication = await draft({ status: PublicationStatus.DRAFT });
    const report = await run(publication.id);

    const status = report?.checks.find((check) => check.key === 'status');
    expect(status?.outcome).toBe('BLOCK');
    expect(status?.fix).toMatch(/approve/i);
  });

  it('blocks an advertisement that has already been published', async () => {
    await connect();
    const publication = await draft({ status: PublicationStatus.PUBLISHED });
    const report = await run(publication.id);

    expect(report?.canPublish).toBe(false);
    expect(report?.checks.find((check) => check.key === 'status')?.detail).toMatch(/already been published/i);
  });

  it('blocks a malformed destination and states the budget in full', async () => {
    await connect();
    const publication = await draft({ linkUrl: 'not a url at all' });
    const report = await run(publication.id);

    expect(report?.checks.find((check) => check.key === 'destination')?.outcome).toBe('BLOCK');
    // The number that surprises people is stated, not left to be inferred.
    expect(report?.checks.find((check) => check.key === 'budget')?.detail).toMatch(/up to 175\.00 SAR/);
  });

  it('passes a complete advertisement, warning about what is not measured', async () => {
    await connect();
    const publication = await draft();
    const report = await run(publication.id);

    expect(report?.canPublish).toBe(true);
    expect(report?.outcome).toBe('WARNING');

    // Missing conversion tracking must never block an awareness campaign.
    const conversions = report?.checks.find((check) => check.key === 'conversions');
    expect(conversions?.outcome).toBe('WARNING');

    // And preflight never claims Meta has approved anything.
    expect(report?.summary).toMatch(/Meta reviews the ad separately/i);
    expect(report?.summary).not.toMatch(/guaranteed|will be approved/i);
  });

  it('cannot be run against another tenant\'s advertisement', async () => {
    const other = await createTenant('preflight-other');
    await connect();
    const publication = await draft();

    const report = await preflight({
      prisma,
      publicationId: publication.id,
      organizationId: other.organizationId,
    });
    expect(report).toBeNull();
  });
});
