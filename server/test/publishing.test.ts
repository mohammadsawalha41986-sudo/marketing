/**
 * Meta publishing.
 *
 * No Meta credentials exist, so this drives the full sequence against Meta's own
 * documented response shapes through the injected `fetchImpl` — the same code
 * path production uses, with the provider's JSON standing in for the network.
 *
 * The assertion this file exists for is the negative one: **nothing reaches
 * PUBLISHED without ids Meta minted.** A publish that fails at the ad step must
 * not be PUBLISHED, must carry Meta's own message, and must still remember the
 * campaign and ad set it already created — those are real objects in the
 * client's account, and a row that forgot them leaves orphans nobody can find.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalAccountKind,
  IntegrationStatus,
  Platform,
  PublicationStatus,
  Prisma,
  CreativeFormat,
  MediaType,
} from '@prisma/client';
import sharp from 'sharp';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { encryptSecret, secretFingerprint } from '../src/lib/crypto.js';
import { publishToMeta } from '../src/services/integrations/publish-flow.js';
import { toMinorUnits } from '../src/services/integrations/meta-publish.js';
import { storage } from '../src/services/storage/index.js';

/*
 * Credentials are stored AES-256-GCM encrypted, so the publish path needs a key
 * to decrypt the token it sends to Meta. Set here rather than in the shared test
 * config: a suite that silently ran without encryption would prove nothing about
 * the path production takes.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
});

/** Meta's actual response bodies, keyed by the path they come back from. */
function metaApi(overrides: Record<string, { status?: number; body: unknown }> = {}) {
  const calls: Array<{ url: string; body: string | undefined }> = [];

  const responses: Record<string, { status?: number; body: unknown }> = {
    campaigns: { body: { id: '23851234567890123' } },
    adsets: { body: { id: '23851234567890456' } },
    adimages: { body: { images: { 'creative.png': { hash: 'abc123hash', url: 'https://scontent.example/x' } } } },
    advideos: { body: { id: '1234567890123456' } },
    adcreatives: { body: { id: '23851234567890789' } },
    ads: { body: { id: '23851234567890999' } },
    ...overrides,
  };

  const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });

    // Reading an object back: GET /<id>?fields=...
    if (!init?.body) {
      if (/\/1234567890123456\?/.test(url) || url.includes('fields=status')) {
        const video = responses.videoStatus ?? { body: { status: { video_status: 'ready' } } };
        return respond(video);
      }
      const confirm = responses.confirm ?? {
        body: { id: '23851234567890999', name: 'Ad', status: 'PAUSED', effective_status: 'PAUSED' },
      };
      return respond(confirm);
    }

    const key = Object.keys(responses).find((name) => url.includes(`/${name}`));
    return respond(key ? responses[key]! : { body: { id: 'unexpected' } });
  });

  function respond(entry: { status?: number; body: unknown }) {
    const status = entry.status ?? 200;
    const text = JSON.stringify(entry.body);
    return { ok: status < 400, status, json: async () => entry.body, text: async () => text };
  }

  return { fetchImpl: fetchImpl as never, calls };
}

async function creativeImage(): Promise<Buffer> {
  return sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 200, g: 90, b: 40 } } })
    .png()
    .toBuffer();
}

/** A client connected to Meta with a page and an ad account selected. */
async function connectMeta(tenant: Tenant, status = IntegrationStatus.CONNECTED) {
  const integration = await prisma.integration.create({
    data: {
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      platform: Platform.FACEBOOK,
      status,
      accountName: 'Forno Rosso',
      accountId: '100000000000001',
      accessTokenEnc: encryptSecret('EAAtest-access-token'),
      tokenFingerprint: secretFingerprint('EAAtest-access-token'),
    },
  });

  await prisma.integrationAccount.createMany({
    data: [
      {
        integrationId: integration.id,
        clientId: tenant.clientId,
        kind: ExternalAccountKind.PAGE,
        externalId: '555000111',
        name: 'Forno Rosso',
        selected: true,
      },
      {
        integrationId: integration.id,
        clientId: tenant.clientId,
        kind: ExternalAccountKind.AD_ACCOUNT,
        externalId: 'act_998877',
        name: 'Forno Rosso Ads',
        selected: true,
      },
    ],
  });

  return integration;
}

async function seedCreative(tenant: Tenant) {
  const image = await creativeImage();

  // A creative is always rendered *from* a source asset, and the schema enforces
  // it — the master is what a re-render works from and what must never be lost.
  const source = await storage.save(image, {
    filename: 'source.png',
    mimeType: 'image/png',
    prefix: `clients/${tenant.clientId}/assets`,
  });
  const media = await prisma.media.create({
    data: {
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      type: MediaType.IMAGE,
      filename: source.key,
      originalName: 'source.png',
      mimeType: 'image/png',
      sizeBytes: source.sizeBytes,
      width: 1080,
      height: 1350,
      url: source.url,
    },
  });

  const stored = await storage.save(image, {
    filename: 'instagram_portrait.png',
    mimeType: 'image/png',
    prefix: `clients/${tenant.clientId}/creatives`,
  });

  return prisma.creative.create({
    data: {
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      sourceMediaId: media.id,
      platform: Platform.INSTAGRAM,
      preset: 'INSTAGRAM_PORTRAIT',
      width: 1080,
      height: 1350,
      format: CreativeFormat.PNG,
      storageKey: stored.key,
      url: stored.url,
      sizeBytes: stored.sizeBytes,
      match: {} as Prisma.InputJsonValue,
    },
  });
}

async function draftPublication(tenant: Tenant, creativeId: string, status = PublicationStatus.APPROVED) {
  return prisma.adPublication.create({
    data: {
      organizationId: tenant.organizationId,
      clientId: tenant.clientId,
      creativeId,
      platform: Platform.FACEBOOK,
      status,
      name: 'Margherita launch',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudget: new Prisma.Decimal(150),
      currency: 'SAR',
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-09-15T00:00:00Z'),
      countries: ['SA'],
      linkUrl: 'https://shop.example.com/margherita',
      message: 'Hand-stretched dough, fired at 450C.',
      headline: 'Stone Oven Margherita',
      callToAction: 'SHOP_NOW',
    },
  });
}

describe('publishing to Meta', () => {
  let alpha: Tenant;

  beforeEach(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
  });

  it('creates the full object hierarchy and records every provider id', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl, calls } = metaApi();
    const result = await publishToMeta({
      publicationId: publication.id,
      organizationId: alpha.organizationId,
      fetchImpl,
    });

    expect(result.status).toBe(PublicationStatus.PUBLISHED);
    expect(result.providerCampaignId).toBe('23851234567890123');
    expect(result.providerAdSetId).toBe('23851234567890456');
    expect(result.providerImageHash).toBe('abc123hash');
    expect(result.providerCreativeId).toBe('23851234567890789');
    expect(result.providerAdId).toBe('23851234567890999');
    expect(result.publishedAt).not.toBeNull();

    // Meta's own hierarchy, in order.
    const paths = calls.map((call) => call.url);
    expect(paths.some((url) => url.includes('/act_998877/campaigns'))).toBe(true);
    expect(paths.some((url) => url.includes('/act_998877/adsets'))).toBe(true);
    expect(paths.some((url) => url.includes('/act_998877/adimages'))).toBe(true);
    expect(paths.some((url) => url.includes('/act_998877/adcreatives'))).toBe(true);
    expect(paths.some((url) => url.includes('/act_998877/ads'))).toBe(true);
  });

  it('sends the budget in minor units, not major', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl, calls } = metaApi();
    await publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl });

    // 150.00 SAR is 15000 halalas. Sending 150 would underspend by 100×, and
    // the API accepts both without complaint.
    const adset = calls.find((call) => call.url.includes('/adsets'));
    expect(adset?.body).toContain('daily_budget=15000');
    expect(toMinorUnits(150)).toBe(15000);
  });

  it('creates everything paused, so nothing spends before a human looks at it', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl, calls } = metaApi();
    await publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl });

    for (const path of ['/campaigns', '/adsets', '/ads']) {
      const call = calls.find((entry) => entry.url.includes(path));
      expect(call?.body, path).toContain('status=PAUSED');
    }
  });

  it('never reaches PUBLISHED when the provider rejects the ad', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl } = metaApi({
      ads: {
        status: 400,
        body: {
          error: {
            message: 'Invalid parameter',
            error_user_msg: 'Your ad could not be created because the ad set has no budget.',
            code: 100,
          },
        },
      },
    });

    const result = await publishToMeta({
      publicationId: publication.id,
      organizationId: alpha.organizationId,
      fetchImpl,
    });

    expect(result.status).toBe(PublicationStatus.FAILED);
    expect(result.providerAdId).toBeNull();
    expect(result.publishedAt).toBeNull();
    // Meta's own words, not a rewrite. And the HTTP status, not hidden.
    expect(result.errorMessage).toContain('ad set has no budget');
    expect(result.errorStatus).toBe(400);

    // The campaign and ad set that *were* created are still recorded: they
    // exist in the client's account and somebody has to be able to find them.
    expect(result.providerCampaignId).toBe('23851234567890123');
    expect(result.providerAdSetId).toBe('23851234567890456');
  });

  it('separates a credential failure from an ordinary one', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl } = metaApi({
      campaigns: {
        status: 401,
        body: { error: { message: 'Error validating access token: Session has expired', code: 190 } },
      },
    });

    const result = await publishToMeta({
      publicationId: publication.id,
      organizationId: alpha.organizationId,
      fetchImpl,
    });

    // Retrying this can never succeed, so it is not FAILED — it needs a person
    // to reconnect, and the state says so.
    expect(result.status).toBe(PublicationStatus.REQUIRES_REAUTH);
    expect(result.providerAdId).toBeNull();
  });

  it('refuses to publish when the provider returns no id', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    // HTTP 200 with an empty body: the request "succeeded" and nothing exists.
    const { fetchImpl } = metaApi({ ads: { body: {} } });

    const result = await publishToMeta({
      publicationId: publication.id,
      organizationId: alpha.organizationId,
      fetchImpl,
    });

    expect(result.status).toBe(PublicationStatus.FAILED);
    expect(result.providerAdId).toBeNull();
    expect(result.errorMessage).toMatch(/no id/i);
  });

  it('waits for Meta to finish processing an uploaded video', async () => {
    await connectMeta(alpha);

    const stored = await storage.save(Buffer.from('fake-mp4-bytes-for-upload'), {
      filename: 'tiktok_video.mp4',
      mimeType: 'video/mp4',
      prefix: `clients/${alpha.clientId}/videos`,
    });

    const video = await prisma.videoCreative.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        platform: Platform.INSTAGRAM,
        placement: 'INSTAGRAM_REEL',
        width: 1080,
        height: 1920,
        durationSeconds: 12,
        storageKey: stored.key,
        url: stored.url,
        sizeBytes: stored.sizeBytes,
        script: {} as Prisma.InputJsonValue,
      },
    });

    const publication = await prisma.adPublication.create({
      data: {
        organizationId: alpha.organizationId,
        clientId: alpha.clientId,
        videoCreativeId: video.id,
        platform: Platform.FACEBOOK,
        status: PublicationStatus.APPROVED,
        name: 'Reel launch',
        objective: 'OUTCOME_TRAFFIC',
        dailyBudget: new Prisma.Decimal(200),
        currency: 'SAR',
        startDate: new Date('2026-09-01T00:00:00Z'),
        endDate: new Date('2026-09-10T00:00:00Z'),
        countries: ['SA'],
        linkUrl: 'https://shop.example.com/margherita',
        message: 'Fired at 450C.',
        headline: 'Stone Oven Margherita',
      },
    });

    let checks = 0;
    const { fetchImpl, calls } = metaApi();

    const result = await publishToMeta({
      publicationId: publication.id,
      organizationId: alpha.organizationId,
      fetchImpl,
      // Injected so the test does not sleep: an ad created against a video
      // Meta is still processing fails with an error that does not say so.
      waitForVideo: async (check) => {
        checks += 1;
        const status = await check();
        expect(status.ready).toBe(true);
      },
    });

    expect(result.status).toBe(PublicationStatus.PUBLISHED);
    expect(result.providerVideoId).toBe('1234567890123456');
    expect(checks).toBe(1);
    expect(calls.some((call) => call.url.includes('/advideos'))).toBe(true);
    // A video creative uses video_data, never link_data with an image hash.
    const creativeCall = calls.find((call) => call.url.includes('/adcreatives'));
    expect(decodeURIComponent(creativeCall?.body ?? '')).toContain('video_data');
  });
});

describe('refusing to publish', () => {
  let alpha: Tenant;

  beforeEach(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
  });

  it('will not publish media that is no longer in storage', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    // Exactly what a redeploy did to every rendered file before object storage.
    await storage.delete(creative.storageKey);

    const publication = await draftPublication(alpha, creative.id);
    const { fetchImpl, calls } = metaApi();

    await expect(
      publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl }),
    ).rejects.toThrow(/no longer in storage/i);

    // Nothing was created at Meta: the check happens before the first call, so
    // a missing file cannot leave an orphaned campaign behind.
    expect(calls).toHaveLength(0);
  });

  it('will not publish without an approval', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id, PublicationStatus.DRAFT);

    const { fetchImpl, calls } = metaApi();
    await expect(
      publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl }),
    ).rejects.toThrow(/approved/i);
    expect(calls).toHaveLength(0);
  });

  it('will not publish twice', async () => {
    await connectMeta(alpha);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl } = metaApi();
    await publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl });

    await expect(
      publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl }),
    ).rejects.toThrow(/already been published/i);
  });

  it('will not publish through a connection that is not connected', async () => {
    await connectMeta(alpha, IntegrationStatus.REAUTH_REQUIRED);
    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl } = metaApi();
    await expect(
      publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl }),
    ).rejects.toThrow(/reauth_required|reconnect/i);
  });

  it('will not publish without a selected ad account', async () => {
    const integration = await connectMeta(alpha);
    await prisma.integrationAccount.updateMany({
      where: { integrationId: integration.id, kind: ExternalAccountKind.AD_ACCOUNT },
      data: { selected: false },
    });

    const creative = await seedCreative(alpha);
    const publication = await draftPublication(alpha, creative.id);

    const { fetchImpl } = metaApi();
    await expect(
      publishToMeta({ publicationId: publication.id, organizationId: alpha.organizationId, fetchImpl }),
    ).rejects.toThrow(/ad account/i);
  });
});

describe('the publishing routes', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let admin: Agent;
  let outsider: Agent;

  beforeEach(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');
    admin = agent();
    await admin.login(alpha.adminEmail);
    outsider = agent();
    await outsider.login(beta.adminEmail);
  });

  it('previews exactly what is about to be committed, and what blocks it', async () => {
    const creative = await seedCreative(alpha);
    const draft = await admin.post('/api/publications', {
      clientId: alpha.clientId,
      creativeId: creative.id,
      name: 'Margherita launch',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudget: 150,
      currency: 'SAR',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-15T00:00:00Z',
      countries: ['SA'],
      linkUrl: 'https://shop.example.com/margherita',
      message: 'Hand-stretched dough.',
      headline: 'Stone Oven Margherita',
    });
    expect(draft.status).toBe(201);

    const preview = await admin.get(`/api/publications/${draft.body.publication.id}/preview`);
    expect(preview.status).toBe(200);

    // 150/day over 14 days is the number that surprises people, so it is stated.
    expect(preview.body.budget.estimatedTotal).toBe(2100);
    expect(preview.body.mediaKind).toBe('IMAGE');
    expect(preview.body.mediaPresent).toBe(true);
    expect(preview.body.readyToPublish).toBe(false);
    expect(preview.body.blockers.join(' ')).toMatch(/not connected to Meta/i);
    expect(preview.body.confirmation).toMatch(/about to publish/i);
  });

  it('rejects a draft carrying both an image and a video', async () => {
    const creative = await seedCreative(alpha);
    const response = await admin.post('/api/publications', {
      clientId: alpha.clientId,
      creativeId: creative.id,
      videoCreativeId: creative.id,
      name: 'Both',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudget: 10,
      currency: 'SAR',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-15T00:00:00Z',
      countries: ['SA'],
      linkUrl: 'https://shop.example.com/x',
      message: 'x',
      headline: 'x',
    });
    expect(response.status).toBe(400);
  });

  it('will not let one tenant publish another tenant’s creative', async () => {
    const creative = await seedCreative(alpha);

    const response = await outsider.post('/api/publications', {
      clientId: beta.clientId,
      creativeId: creative.id,
      name: 'Stolen',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudget: 10,
      currency: 'SAR',
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-15T00:00:00Z',
      countries: ['SA'],
      linkUrl: 'https://shop.example.com/x',
      message: 'x',
      headline: 'x',
    });

    expect(response.status).toBe(404);
  });

  it('keeps one tenant’s publications out of another’s list', async () => {
    const creative = await seedCreative(alpha);
    await draftPublication(alpha, creative.id);

    expect((await admin.get('/api/publications')).body.publications.length).toBe(1);
    expect((await outsider.get('/api/publications')).body.publications).toHaveLength(0);
  });
});
