/**
 * TikTok Ads publish flow — mirrors Meta's publish-flow.ts structure.
 *
 * Campaign → Ad Group → Ad, all created DISABLED (TikTok's equivalent of
 * PAUSED). Each provider ID written to AdPublication immediately.
 */

import { IntegrationStatus, Platform, PublicationStatus, Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { decryptSecret } from '../../lib/crypto.js';
import type { PublishStep } from './publish-flow.js';
import {
  createTikTokCampaign,
  createTikTokAdGroup,
  createTikTokAd,
  tiktokAdsManagerUrl,
  TikTokAdsApiError,
} from './tiktok-ads-publish.js';

function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof TikTokAdsApiError)) return false;
  if (error.status === 401) return true;
  return /authentication|token|permission|unauthorized/i.test(error.message);
}

export interface TikTokAdsPublishInput {
  publicationId: string;
  organizationId: string;
  fetchImpl: (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export async function publishToTikTok(input: TikTokAdsPublishInput) {
  const publication = await prisma.adPublication.findFirst({
    where: { id: input.publicationId, organizationId: input.organizationId },
  });
  if (!publication) throw notFound('Publication');

  if (publication.status === PublicationStatus.PUBLISHED) {
    throw conflict('This advertisement has already been published.');
  }
  if (publication.status === PublicationStatus.PUBLISHING) {
    throw conflict('This advertisement is already being published.');
  }
  if (publication.status !== PublicationStatus.APPROVED) {
    throw badRequest('This advertisement must be approved before it can be published.');
  }

  const steps: PublishStep[] = [];
  const record = (step: string, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail, at: new Date().toISOString() });
  };

  const integration = await prisma.integration.findFirst({
    where: { clientId: publication.clientId, platform: Platform.TIKTOK },
    include: { accounts: { where: { selected: true } } },
  });

  if (!integration) throw badRequest('Connect this client to TikTok before publishing');
  if (integration.status !== IntegrationStatus.CONNECTED) {
    throw badRequest(`The TikTok connection is ${integration.status.toLowerCase()}. Reconnect it before publishing.`);
  }
  if (!integration.accessTokenEnc) {
    throw badRequest('The TikTok connection has no usable credential. Reconnect it before publishing.');
  }

  const adAccount = integration.accounts.find((a) => a.kind === 'AD_ACCOUNT');
  if (!adAccount) throw badRequest('Select a TikTok advertiser account for this client before publishing');

  const accessToken = decryptSecret(integration.accessTokenEnc);
  const advertiserId = adAccount.externalId;

  await prisma.adPublication.update({
    where: { id: publication.id },
    data: {
      status: PublicationStatus.PUBLISHING,
      providerAccountId: advertiserId,
      errorMessage: null,
      errorStatus: null,
    },
  });

  const { fetchImpl } = input;

  try {
    const { campaignId } = await createTikTokCampaign({
      advertiserId,
      name: publication.name,
      objective: publication.objective ?? 'TRAFFIC',
      dailyBudget: Number(publication.dailyBudget),
      accessToken,
      fetchImpl,
    });
    record('campaign', true, campaignId);
    await prisma.adPublication.update({
      where: { id: publication.id },
      data: { providerCampaignId: campaignId, managerUrl: tiktokAdsManagerUrl(advertiserId, campaignId) },
    });

    const { adGroupId } = await createTikTokAdGroup({
      advertiserId,
      campaignId,
      name: `${publication.name} — ad group`,
      dailyBudget: Number(publication.dailyBudget),
      accessToken,
      fetchImpl,
    });
    record('adGroup', true, adGroupId);
    await prisma.adPublication.update({
      where: { id: publication.id },
      data: { providerAdSetId: adGroupId },
    });

    const { adId } = await createTikTokAd({
      advertiserId,
      adGroupId,
      name: publication.name,
      headline: publication.headline ?? publication.message,
      landingPageUrl: publication.linkUrl,
      accessToken,
      fetchImpl,
    });
    record('ad', true, adId);

    return prisma.adPublication.update({
      where: { id: publication.id },
      data: {
        status: PublicationStatus.PUBLISHED,
        providerAdId: adId,
        providerStatus: 'DISABLE',
        publishedAt: new Date(),
        steps: steps as unknown as Prisma.InputJsonValue,
        errorMessage: null,
        errorStatus: null,
      },
    });
  } catch (error) {
    record('failed', false, (error as Error).message);
    return prisma.adPublication.update({
      where: { id: publication.id },
      data: {
        status: isAuthFailure(error) ? PublicationStatus.REQUIRES_REAUTH : PublicationStatus.FAILED,
        errorMessage: (error as Error).message.slice(0, 1000),
        errorStatus: error instanceof TikTokAdsApiError ? error.status : null,
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
