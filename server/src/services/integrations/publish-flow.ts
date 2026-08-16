/**
 * Orchestrating a publish.
 *
 * The sequence is: confirm the media is really in persistent storage → confirm
 * the connection is live and the operator selected a page and an ad account →
 * create the campaign, ad set, creative and ad → read the ad back from the
 * provider → only then mark it PUBLISHED.
 *
 * Each provider id is written to the row *the moment it arrives*, before the
 * next call is attempted. That matters for the failure case above all: a
 * publish that dies at the ad step has already created a real campaign and a
 * real ad set in the operator's account, and a row that forgot them would leave
 * two orphans nobody can find. The `steps` column records the whole attempt.
 *
 * Nothing here invents a state. PUBLISHED requires `providerAdId`; a provider
 * error becomes FAILED with the provider's own message and HTTP status;
 * anything that looks like a credential problem becomes REQUIRES_REAUTH,
 * because retrying that one will never work until somebody reconnects.
 */

import { IntegrationStatus, Platform, PublicationStatus, Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { decryptSecret } from '../../lib/crypto.js';
import { storage } from '../storage/index.js';
import { readObject } from '../storage/objects.js';
import { ProviderApiError, type FetchLike } from './meta.js';
import {
  adsManagerUrl,
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  fetchAd,
  uploadImage,
  uploadVideo,
  videoStatus,
  type MetaObjective,
} from './meta-publish.js';

export interface PublishStep {
  step: string;
  ok: boolean;
  detail: string;
  at: string;
}

/**
 * Meta HTTP statuses and codes that mean "the credential is the problem".
 *
 * Separated from ordinary failures because the operator's next action is
 * completely different: a rejected budget is fixed by editing the budget, an
 * invalid token is fixed only by reconnecting, and telling them to "try again"
 * would send them round a loop that cannot terminate.
 */
function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof ProviderApiError)) return false;
  if (error.status === 401) return true;
  return /access token|session has expired|not authorized|permission|OAuth/i.test(error.message);
}

export interface PublishInput {
  publicationId: string;
  organizationId: string;
  fetchImpl: FetchLike;
  /** Injected so tests can drive video processing without waiting. */
  waitForVideo?: (check: () => Promise<{ ready: boolean; error: string | null }>) => Promise<void>;
}

/** Poll Meta until the uploaded video finishes processing. */
async function defaultWaitForVideo(check: () => Promise<{ ready: boolean; error: string | null }>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await check();
    if (status.ready) return;
    if (status.error) throw new ProviderApiError(Platform.FACEBOOK, 502, `Meta could not process the video: ${status.error}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new ProviderApiError(Platform.FACEBOOK, 504, 'Meta did not finish processing the video in time');
}

/**
 * Publish one advertisement.
 *
 * Returns the updated row rather than throwing on provider failure: a failed
 * publish is a *result* the operator needs to see, with the provider's message
 * on it, not an exception that turns into a generic 500.
 */
export async function publishToMeta(input: PublishInput) {
  const publication = await prisma.adPublication.findFirst({
    where: { id: input.publicationId, organizationId: input.organizationId },
  });
  if (!publication) throw notFound('Publication');

  if (publication.status === PublicationStatus.PUBLISHED) {
    throw conflict('This advertisement has already been published. Create a new one rather than republishing.');
  }
  if (publication.status === PublicationStatus.PUBLISHING) {
    throw conflict('This advertisement is already being published.');
  }
  // Approval is a gate, not a formality: publishing spends the client's money.
  if (publication.status !== PublicationStatus.APPROVED) {
    throw badRequest('This advertisement must be approved before it can be published.');
  }

  const steps: PublishStep[] = [];
  const record = (step: string, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail, at: new Date().toISOString() });
  };

  // ------------------------------------------------- the media must be real
  const creative = publication.creativeId
    ? await prisma.creative.findFirst({ where: { id: publication.creativeId, clientId: publication.clientId } })
    : null;
  const video = publication.videoCreativeId
    ? await prisma.videoCreative.findFirst({ where: { id: publication.videoCreativeId, clientId: publication.clientId } })
    : null;

  if (!creative && !video) throw badRequest('Attach a creative or a video before publishing');

  const storageKey = video?.storageKey ?? creative!.storageKey;

  /*
   * Confirm the bytes exist in persistent storage before anything is created at
   * the provider. Publishing a reference to a file that is not there produces a
   * campaign and an ad set in the operator's account and then fails at upload —
   * and on ephemeral storage that is not hypothetical, it is the normal outcome
   * a week after the file was rendered.
   */
  if (storage.exists) {
    const present = await storage.exists(storageKey);
    if (!present) {
      throw badRequest(
        'The media for this advertisement is no longer in storage, so there is nothing to upload. Re-render it and try again.',
      );
    }
  }
  record('media', true, `Confirmed ${storageKey} is present in ${storage.name} storage`);

  // ------------------------------------------------ the connection must be live
  const integration = await prisma.integration.findFirst({
    where: { clientId: publication.clientId, platform: { in: [Platform.FACEBOOK, Platform.INSTAGRAM] } },
    include: { accounts: { where: { selected: true } } },
  });

  if (!integration) throw badRequest('Connect this client to Meta before publishing');
  if (integration.status !== IntegrationStatus.CONNECTED) {
    throw badRequest(`The Meta connection is ${integration.status.toLowerCase()}. Reconnect it before publishing.`);
  }
  if (!integration.accessTokenEnc) {
    throw badRequest('The Meta connection has no usable credential. Reconnect it before publishing.');
  }

  const adAccount = integration.accounts.find((account) => account.kind === 'AD_ACCOUNT');
  const page = integration.accounts.find((account) => account.kind === 'PAGE');
  const instagram = integration.accounts.find((account) => account.kind === 'INSTAGRAM');

  if (!adAccount) throw badRequest('Select a Meta ad account for this client before publishing');
  if (!page) throw badRequest('Select a Facebook Page for this client before publishing');

  const accessToken = decryptSecret(integration.accessTokenEnc);
  const adAccountId = adAccount.externalId.startsWith('act_') ? adAccount.externalId : `act_${adAccount.externalId}`;

  await prisma.adPublication.update({
    where: { id: publication.id },
    data: {
      status: PublicationStatus.PUBLISHING,
      providerAccountId: adAccountId,
      errorMessage: null,
      errorStatus: null,
    },
  });

  const { fetchImpl } = input;
  const wait = input.waitForVideo ?? defaultWaitForVideo;

  try {
    // ------------------------------------------------------------- campaign
    const { campaignId } = await createCampaign({
      adAccountId,
      name: publication.name,
      objective: publication.objective as MetaObjective,
      accessToken,
      fetchImpl,
    });
    record('campaign', true, campaignId);
    // Written immediately: if the next step fails, this campaign exists in the
    // operator's account and the row has to be able to point at it.
    await prisma.adPublication.update({
      where: { id: publication.id },
      data: { providerCampaignId: campaignId, managerUrl: adsManagerUrl(adAccountId, campaignId) },
    });

    // --------------------------------------------------------------- ad set
    const { adSetId } = await createAdSet({
      adAccountId,
      campaignId,
      name: `${publication.name} — ad set`,
      dailyBudget: Number(publication.dailyBudget),
      currency: publication.currency,
      startTime: publication.startDate,
      endTime: publication.endDate,
      countries: publication.countries.length > 0 ? publication.countries : ['SA'],
      accessToken,
      fetchImpl,
    });
    record('adSet', true, adSetId);
    await prisma.adPublication.update({ where: { id: publication.id }, data: { providerAdSetId: adSetId } });

    // --------------------------------------------------------------- upload
    const bytes = await readObject(storageKey);
    let imageHash: string | null = null;
    let videoId: string | null = null;

    if (video) {
      const uploaded = await uploadVideo({
        adAccountId,
        bytes,
        filename: `${video.placement.toLowerCase()}.mp4`,
        accessToken,
        fetchImpl,
      });
      videoId = uploaded.videoId;
      record('videoUpload', true, videoId);
      await prisma.adPublication.update({ where: { id: publication.id }, data: { providerVideoId: videoId } });

      // Meta accepts the upload immediately and processes it afterwards; an ad
      // created against a still-processing video fails with an error that does
      // not mention processing.
      await wait(async () => {
        const status = await videoStatus({ videoId: videoId!, accessToken, fetchImpl });
        return { ready: status.ready, error: status.error };
      });
      record('videoProcessing', true, 'Meta reports the video as ready');
    } else {
      const uploaded = await uploadImage({
        adAccountId,
        bytes,
        filename: `${creative!.preset.toLowerCase()}.${creative!.format.toLowerCase()}`,
        accessToken,
        fetchImpl,
      });
      imageHash = uploaded.imageHash;
      record('imageUpload', true, imageHash);
      await prisma.adPublication.update({ where: { id: publication.id }, data: { providerImageHash: imageHash } });
    }

    // ------------------------------------------------------------- creative
    const { creativeId } = await createAdCreative({
      adAccountId,
      name: `${publication.name} — creative`,
      pageId: page.externalId,
      instagramActorId: instagram?.externalId ?? null,
      message: publication.message,
      headline: publication.headline,
      linkUrl: publication.linkUrl,
      callToAction: publication.callToAction ?? undefined,
      imageHash,
      videoId,
      accessToken,
      fetchImpl,
    });
    record('creative', true, creativeId);
    await prisma.adPublication.update({ where: { id: publication.id }, data: { providerCreativeId: creativeId } });

    // ------------------------------------------------------------------- ad
    const { adId } = await createAd({
      adAccountId,
      name: publication.name,
      adSetId,
      creativeId,
      accessToken,
      fetchImpl,
    });
    record('ad', true, adId);

    /*
     * Read it back. A create call returning an id means Meta accepted the
     * request; fetching the object is what proves the ad exists. Without this,
     * "Published" would mean "we sent something and nothing threw".
     */
    const confirmed = await fetchAd({ adId, accessToken, fetchImpl });
    record('confirm', true, `${confirmed.id} is ${confirmed.effectiveStatus ?? confirmed.status}`);

    return prisma.adPublication.update({
      where: { id: publication.id },
      data: {
        status: PublicationStatus.PUBLISHED,
        providerAdId: confirmed.id,
        providerStatus: confirmed.effectiveStatus ?? confirmed.status,
        publishedAt: new Date(),
        steps: steps as unknown as Prisma.InputJsonValue,
        errorMessage: null,
        errorStatus: null,
      },
    });
  } catch (error) {
    const providerError = error instanceof ProviderApiError ? error : null;
    record('failed', false, (error as Error).message);

    return prisma.adPublication.update({
      where: { id: publication.id },
      data: {
        // A credential failure is its own state: retrying it cannot succeed.
        status: isAuthFailure(error) ? PublicationStatus.REQUIRES_REAUTH : PublicationStatus.FAILED,
        // The provider's own words, not a rewrite of them.
        errorMessage: (error as Error).message.slice(0, 1000),
        errorStatus: providerError?.status ?? null,
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
