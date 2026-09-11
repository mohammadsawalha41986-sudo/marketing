/**
 * Publishing through Upload-Post, one network at a time.
 *
 * Every other publisher in this directory is one network's adapter. This one is
 * a *route*: the same code publishes to Instagram, TikTok, Facebook, LinkedIn,
 * X, YouTube or Google Business Profile, and which it is comes from the account
 * the post was routed to. So it is a factory rather than a constant — one bound
 * publisher per platform, each satisfying `PlatformPublisher` exactly, so the
 * service, the scheduler, the state machine and the retry policy need to know
 * nothing about any of this.
 *
 * Two things about it are genuinely different from a direct adapter, and both
 * are deliberate.
 *
 * **The credential is the deployment's, not the account's.** `request.account.
 * accessToken` arrives empty for this route and is never read. Upload-Post
 * authorises with `UPLOAD_POST_API_KEY`, which this module reads from the
 * environment at the moment of the call and never returns, logs or puts in an
 * error. A publisher that received an empty token and tried to use it would
 * fail with a message naming the wrong problem, so it does not try.
 *
 * **An accepted upload is not a published post.** Upload-Post processes uploads
 * asynchronously, so the response to a publish is an acknowledgement carrying a
 * `request_id`. Reporting that as a publication would break the one invariant
 * the whole subsystem exists to hold — content becomes PUBLISHED only after a
 * provider returns an id *for the post*. So an acknowledgement without a
 * per-network result is polled to a real outcome, and a poll that runs out of
 * patience is reported as a retryable failure rather than a success.
 */

import { Platform } from '@prisma/client';

import {
  UploadPostError,
  publish as publishToUploadPost,
  uploadPostConfig,
  uploadPostConfigured,
  uploadPostPlatform,
  uploadStatus,
  type UploadPostFailure,
  type UploadPostFetch,
  type UploadPostMedia,
} from '../integrations/upload-post.js';
import type {
  PlatformPublisher,
  PublishError,
  PublishErrorKind,
  PublishRequest,
  PublishResult,
} from './contract.js';

/** How long to wait for one call before giving up on it. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * How long to keep asking what became of an accepted upload, and how often.
 *
 * Bounded on purpose. A poll that waited indefinitely would hold the scheduler
 * tick open on one post; running out is reported as retryable, so the job comes
 * back in a minute and the idempotency key makes that second attempt collapse
 * into the same post rather than duplicate it.
 */
const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 3_000;

/**
 * Upload-Post's failures, mapped onto the ones the service already knows how to
 * act on.
 *
 * The mapping decides retry versus person, so it is written per failure rather
 * than defaulted. `INVALID_KEY` is the one worth looking at twice: it is
 * permanent, and it is the *deployment's* problem rather than the restaurant's
 * — no amount of reconnecting this client fixes a revoked API key, so it must
 * never be classified as something a reconnection would clear.
 */
const ERROR_KIND: Record<UploadPostFailure, PublishErrorKind> = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  INVALID_KEY: 'NOT_CONFIGURED',
  PROFILE_NOT_FOUND: 'INVALID_ACCOUNT',
  ACCOUNT_NOT_LINKED: 'INVALID_ACCOUNT',
  INVALID_MEDIA: 'INVALID_MEDIA',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INVALID_REQUEST: 'INVALID_REQUEST',
};

function toPublishError(error: unknown): PublishError {
  if (error instanceof UploadPostError) {
    return {
      kind: ERROR_KIND[error.failure],
      code: error.failure,
      // The explanation, not the raw message: written for the person who has to
      // fix it, and guaranteed to carry no key material.
      message: error.explanation,
      httpStatus: error.status,
    };
  }

  /*
   * Anything else is the network or this process, not Upload-Post's answer.
   * Retryable, and described without pretending to know a cause the provider
   * never gave.
   */
  const message = error instanceof Error ? error.message : 'The request to Upload-Post failed.';
  return {
    kind: /abort|timeout/i.test(message) ? 'TIMEOUT' : 'NETWORK',
    code: null,
    message: `Upload-Post could not be reached: ${message}`,
    httpStatus: null,
  };
}

/** The profile and network this account is addressed by, read from its metadata. */
function addressOf(metadata: Record<string, unknown> | undefined): {
  profile: string;
  platform: string;
} | null {
  const profile = metadata?.uploadPostProfile;
  const platform = metadata?.uploadPostPlatform;
  if (typeof profile !== 'string' || !profile.trim()) return null;
  if (typeof platform !== 'string' || !platform.trim()) return null;
  return { profile: profile.trim(), platform: platform.trim() };
}

/** The bytes, in the shape the API module sends them. */
function toMedia(request: PublishRequest): UploadPostMedia[] {
  return request.media.map((item) => ({
    kind: item.kind,
    data: item.data,
    mimeType: item.mimeType,
    filename: item.filename,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Turn an accepted upload into a real outcome, or a real failure.
 *
 * Returns the live post's URL when the network published one. A `null` URL with
 * no error is a post Upload-Post has accepted and finished — some networks
 * simply do not hand back a link — and is treated as published, because the
 * per-network result saying so *is* the provider's confirmation.
 */
async function awaitOutcome(input: {
  requestId: string;
  platform: string;
  fetchImpl: UploadPostFetch;
  timeoutMs: number;
}): Promise<{ url: string | null }> {
  const config = uploadPostConfig();

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    // Ask before waiting: a synchronous upload is already finished, and sleeping
    // first would add three seconds to every fast post.
    const { status, platforms } = await uploadStatus({
      config,
      requestId: input.requestId,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    });

    const mine = platforms.find((entry) => entry.name.toLowerCase() === input.platform);
    if (mine?.error) throw new UploadPostError(502, `Upload-Post ${input.platform}: ${mine.error}`);
    if (mine) return { url: mine.url };

    // A terminal status with no entry for this network means the upload
    // finished and this network was not part of it — which is a failure, not a
    // publication, and must never be reported as one.
    if (status && /failed|error/i.test(status)) {
      throw new UploadPostError(502, `Upload-Post ${input.platform}: the upload finished as ${status}.`);
    }
    if (status && /complete|success|published|done/i.test(status)) {
      throw new UploadPostError(
        502,
        `Upload-Post ${input.platform}: the upload completed without a result for this network.`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  /*
   * Still processing. Retryable rather than failed: the post may well be on its
   * way, and the idempotency key means the next attempt joins it instead of
   * publishing a second one.
   */
  throw new UploadPostError(
    503,
    'Upload-Post is still processing this upload. It will be checked again shortly.',
    'PROVIDER_UNAVAILABLE',
  );
}

/**
 * A publisher bound to one network, routed through Upload-Post.
 *
 * `canPublish` answers for the deployment rather than the code: the adapter is
 * written, but without an API key it can do nothing, and a publisher that
 * claims it can publish and then refuses every call is the dishonest
 * architecture `registry.ts` exists to avoid. It is read per call rather than
 * captured at module load so that setting the variable and restarting is enough
 * — there is no build step that bakes it in.
 */
export function uploadPostPublisher(platform: Platform): PlatformPublisher {
  const slug = uploadPostPlatform(platform);

  return {
    platform,
    label: 'Upload-Post',

    get canPublish(): boolean {
      return Boolean(slug) && uploadPostConfigured();
    },

    async publish(request: PublishRequest): Promise<PublishResult> {
      if (!slug) {
        return refuse(platform, {
          kind: 'NOT_CONFIGURED',
          code: null,
          message: `Upload-Post does not publish to ${platform}.`,
          httpStatus: null,
        });
      }

      const address = addressOf(request.account.metadata);
      if (!address) {
        return refuse(platform, {
          kind: 'INVALID_ACCOUNT',
          code: null,
          message:
            'This account is not addressable on Upload-Post. Reconnect Upload-Post for this restaurant so its '
            + 'linked accounts are discovered again.',
          httpStatus: null,
        });
      }

      /*
       * The account's network must be the one being published to. Both come
       * from the same row so they agree in every ordinary case — but the route
       * resolver is what guarantees it, and a publisher that trusted rather than
       * checked would turn a resolver bug into a post on the wrong network.
       */
      if (address.platform !== slug) {
        return refuse(platform, {
          kind: 'INVALID_ACCOUNT',
          code: null,
          message:
            `This account is linked to Upload-Post as ${address.platform}, not ${slug}. `
            + 'Reconnect Upload-Post for this restaurant.',
          httpStatus: null,
        });
      }

      if (!request.idempotencyKey) {
        /*
         * Refused rather than sent with a generated key. The key's whole job is
         * to be the *same* across retries of one post; one invented here would
         * differ on every attempt, which is precisely the duplicate it exists to
         * prevent.
         */
        return refuse(platform, {
          kind: 'INVALID_REQUEST',
          code: null,
          message: 'This post has no idempotency key, so publishing it could duplicate it. This is a bug.',
          httpStatus: null,
        });
      }

      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        const config = uploadPostConfig();

        const result = await publishToUploadPost({
          config,
          username: address.profile,
          platform: slug,
          caption: request.caption,
          media: toMedia(request),
          idempotencyKey: request.idempotencyKey,
          fetchImpl: request.fetchImpl as unknown as UploadPostFetch,
          timeoutMs,
        });

        /*
         * A per-network result in the upload response is the answer. Otherwise
         * the upload was accepted for asynchronous processing and the real
         * outcome has to be waited for — an acknowledgement is not a post.
         */
        let url = result.url;
        if (!result.platforms.some((entry) => entry.name.toLowerCase() === slug)) {
          if (!result.requestId) {
            throw new UploadPostError(
              502,
              `Upload-Post ${slug}: the upload was accepted without a result or a request id.`,
            );
          }
          ({ url } = await awaitOutcome({
            requestId: result.requestId,
            platform: slug,
            fetchImpl: request.fetchImpl as unknown as UploadPostFetch,
            timeoutMs,
          }));
        }

        /*
         * The provider's id, never ours.
         *
         * Upload-Post's `request_id` is the identifier it gives the post and the
         * only handle either system has on it afterwards. Where a network also
         * returned a live URL it is kept as the permalink, but the id is what
         * makes the publish idempotent from here on: `runJob` refuses to publish
         * a job that already has one.
         */
        const externalPostId = result.requestId ?? url;
        if (!externalPostId) {
          throw new UploadPostError(
            502,
            `Upload-Post ${slug}: the post published without an identifier to record.`,
          );
        }

        return {
          success: true,
          platform,
          externalPostId,
          permalink: url,
          publishedAt: new Date(),
        };
      } catch (error) {
        return refuse(platform, toPublishError(error));
      }
    },
  };
}

function refuse(platform: Platform, error: PublishError): PublishResult {
  return { success: false, platform, error };
}
