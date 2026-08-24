/**
 * Google Ads publish flow — mirrors Meta's publish-flow.ts structure.
 *
 * Campaign → Ad Group → Ad, all created PAUSED. Each provider ID is written
 * to the AdPublication row immediately as it arrives.
 */

import { IntegrationStatus, Platform, PublicationStatus, Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { decryptSecret } from '../../lib/crypto.js';
import type { PublishStep } from './publish-flow.js';
import {
  createGoogleAdsCampaign,
  createGoogleAdsAdGroup,
  createGoogleAdsAd,
  googleAdsManagerUrl,
  GoogleAdsApiError,
} from './google-ads-publish.js';

function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof GoogleAdsApiError)) return false;
  if (error.status === 401) return true;
  return /authentication|token|permission|OAuth/i.test(error.message);
}

export interface GoogleAdsPublishInput {
  publicationId: string;
  organizationId: string;
  fetchImpl: (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

export async function publishToGoogleAds(input: GoogleAdsPublishInput) {
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
    where: { clientId: publication.clientId, platform: Platform.GOOGLE_ADS },
    include: { accounts: { where: { selected: true } } },
  });

  if (!integration) throw badRequest('Connect this client to Google Ads before publishing');
  if (integration.status !== IntegrationStatus.CONNECTED) {
    throw badRequest(`The Google Ads connection is ${integration.status.toLowerCase()}. Reconnect it before publishing.`);
  }
  if (!integration.accessTokenEnc) {
    throw badRequest('The Google Ads connection has no usable credential. Reconnect it before publishing.');
  }

  const adAccount = integration.accounts.find((a) => a.kind === 'AD_ACCOUNT');
  if (!adAccount) throw badRequest('Select a Google Ads account for this client before publishing');

  const accessToken = decryptSecret(integration.accessTokenEnc);
  const customerId = adAccount.externalId.replace(/-/g, '');
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '';

  await prisma.adPublication.update({
    where: { id: publication.id },
    data: {
      status: PublicationStatus.PUBLISHING,
      providerAccountId: customerId,
      errorMessage: null,
      errorStatus: null,
    },
  });

  const { fetchImpl } = input;

  try {
    const { campaignId } = await createGoogleAdsCampaign({
      customerId,
      name: publication.name,
      dailyBudget: Number(publication.dailyBudget),
      currency: publication.currency,
      accessToken,
      developerToken,
      fetchImpl,
    });
    record('campaign', true, campaignId);
    await prisma.adPublication.update({
      where: { id: publication.id },
      data: { providerCampaignId: campaignId, managerUrl: googleAdsManagerUrl(customerId, campaignId) },
    });

    const campaignResourceName = `customers/${customerId}/campaigns/${campaignId}`;
    const { adGroupId } = await createGoogleAdsAdGroup({
      customerId,
      campaignResourceName,
      name: `${publication.name} — ad group`,
      accessToken,
      developerToken,
      fetchImpl,
    });
    record('adGroup', true, adGroupId);
    await prisma.adPublication.update({
      where: { id: publication.id },
      data: { providerAdSetId: adGroupId },
    });

    const adGroupResourceName = `customers/${customerId}/adGroups/${adGroupId}`;
    const { adId } = await createGoogleAdsAd({
      customerId,
      adGroupResourceName,
      headline: publication.headline,
      description: publication.message,
      finalUrl: publication.linkUrl,
      accessToken,
      developerToken,
      fetchImpl,
    });
    record('ad', true, adId);

    return prisma.adPublication.update({
      where: { id: publication.id },
      data: {
        status: PublicationStatus.PUBLISHED,
        providerAdId: adId,
        providerStatus: 'PAUSED',
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
        errorStatus: error instanceof GoogleAdsApiError ? error.status : null,
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
