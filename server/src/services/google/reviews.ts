/**
 * Google reviews: reading them, and replying to them.
 *
 * The reply half is the reason this file is careful. A reply is published under
 * the restaurant's own name on a public listing that ranks in search — there is
 * no draft state on Google's side and no undo that customers will not have
 * already seen. So `publishReply` takes text a human approved and nothing else:
 * it does not generate, does not fall back to a suggestion, and does not accept
 * an empty string. The AI's proposal reaches Google only after passing through
 * a person, and the row records who that was.
 *
 * Reviews come from the older v4 host, which is addressed by
 * `accounts/{a}/locations/{l}/reviews` — location alone is not enough, which is
 * why `GoogleLocation` stores its parent account name.
 *
 * Everything here takes `fetchImpl` so the whole path can be driven in tests
 * against Google's own response shapes, which is the only way an adapter that
 * cannot reach the network from this environment gets exercised at all.
 */

import { Platform, type PrismaClient } from '@prisma/client';

import { ProviderApiError, type FetchLike } from '../integrations/meta.js';

const V4 = 'https://mybusiness.googleapis.com/v4';

/** Google's star ratings arrive as words. */
const STAR_VALUES: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
};

export interface GoogleReviewPayload {
  externalId: string;
  reviewerName: string | null;
  reviewerPhotoUrl: string | null;
  rating: number;
  comment: string | null;
  createTime: Date;
  updateTime: Date | null;
  /** The reply already on Google, if the business has answered before. */
  existingReply: { comment: string; updateTime: Date | null } | null;
}

async function readJson(
  response: Awaited<ReturnType<FetchLike>>,
  context: string,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  const error = payload.error;
  if (error && typeof error === 'object') {
    const detail = (error as { message?: string }).message ?? 'Google rejected the request';
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, response.status, `${context}: ${detail}`);
  }
  if (!response.ok) {
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, response.status, `${context}: HTTP ${response.status}`);
  }
  return payload;
}

function toReview(row: Record<string, unknown>): GoogleReviewPayload | null {
  const name = String(row.reviewId ?? row.name ?? '');
  if (!name) return null;

  const reviewer = (row.reviewer ?? {}) as Record<string, unknown>;
  const reply = (row.reviewReply ?? null) as Record<string, unknown> | null;
  const starRating = String(row.starRating ?? '');
  const rating = STAR_VALUES[starRating];

  // A review whose rating we cannot read is skipped rather than defaulted.
  // Storing it as 0 or 3 would put a number Google never said into an average.
  if (!rating) return null;

  const createTime = row.createTime ? new Date(String(row.createTime)) : null;
  if (!createTime || Number.isNaN(createTime.getTime())) return null;

  return {
    // `reviewId` is the last segment of the resource name on v4; either shape is
    // accepted so a change of field name does not silently duplicate every row.
    externalId: name.includes('/') ? name.split('/').pop()! : name,
    reviewerName: (reviewer.displayName as string | undefined) ?? null,
    reviewerPhotoUrl: (reviewer.profilePhotoUrl as string | undefined) ?? null,
    rating,
    comment: (row.comment as string | undefined)?.trim() || null,
    createTime,
    updateTime: row.updateTime ? new Date(String(row.updateTime)) : null,
    existingReply: reply
      ? {
        comment: String(reply.comment ?? ''),
        updateTime: reply.updateTime ? new Date(String(reply.updateTime)) : null,
      }
      : null,
  };
}

export async function listReviews(input: {
  accessToken: string;
  accountName: string;
  locationName: string;
  fetchImpl: FetchLike;
  /** Bounded so one enormous location cannot stall a sync indefinitely. */
  maxPages?: number;
}): Promise<GoogleReviewPayload[]> {
  const maxPages = input.maxPages ?? 10;
  const collected: GoogleReviewPayload[] = [];
  let pageToken: string | undefined;
  let page = 0;

  // `locations/123` → `123`, so the v4 path composes correctly whether the
  // stored name carries its prefix or not.
  const locationId = input.locationName.split('/').pop();

  do {
    const url = new URL(`${V4}/${input.accountName}/locations/${locationId}/reviews`);
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const payload = await readJson(
      await input.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${input.accessToken}` },
      }),
      'Google reviews',
    );

    for (const entry of Array.isArray(payload.reviews) ? payload.reviews : []) {
      const review = toReview(entry as Record<string, unknown>);
      if (review) collected.push(review);
    }

    pageToken = payload.nextPageToken as string | undefined;
    page += 1;
  } while (pageToken && page < maxPages);

  return collected;
}

/**
 * Publish a reply that a human approved.
 *
 * Deliberately dumb: it takes the exact text and sends it. There is no
 * "generate if missing" path, because that would be the one code path capable
 * of putting unreviewed AI wording on a customer's public listing.
 */
export async function publishReply(input: {
  accessToken: string;
  accountName: string;
  locationName: string;
  reviewExternalId: string;
  comment: string;
  fetchImpl: FetchLike;
}): Promise<{ updateTime: Date | null }> {
  const comment = input.comment.trim();
  if (!comment) {
    throw new ProviderApiError(Platform.GOOGLE_BUSINESS, 400, 'A reply cannot be empty.');
  }

  const locationId = input.locationName.split('/').pop();
  const url = `${V4}/${input.accountName}/locations/${locationId}/reviews/${input.reviewExternalId}/reply`;

  const payload = await readJson(
    await input.fetchImpl(url, {
      // PUT, not POST: the reply is a singleton on the review, so replying twice
      // edits rather than appends. That is also what makes a retry safe.
      method: 'PUT',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ comment }),
    }),
    'Google review reply',
  );

  return {
    updateTime: payload.updateTime ? new Date(String(payload.updateTime)) : null,
  };
}

/**
 * Persist a page of reviews, preserving everything we derived about them.
 *
 * The upsert deliberately does not touch `sentiment`, `category`,
 * `aiSuggestion` or the reply workflow columns: a re-sync refreshes what Google
 * owns — the rating, the text, the reply that is live — and leaves our own
 * analysis and an operator's queued reply exactly where they were. A sync that
 * cleared them would quietly discard an approval someone was waiting on.
 */
export async function persistReviews(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  locationId: string;
  reviews: GoogleReviewPayload[];
}): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const review of input.reviews) {
    const existing = await input.prisma.googleReview.findUnique({
      where: { locationId_externalId: { locationId: input.locationId, externalId: review.externalId } },
      select: { id: true },
    });

    const googleOwned = {
      reviewerName: review.reviewerName,
      reviewerPhotoUrl: review.reviewerPhotoUrl,
      rating: review.rating,
      comment: review.comment,
      createTime: review.createTime,
      updateTime: review.updateTime,
    };

    if (existing) {
      await input.prisma.googleReview.update({
        where: { id: existing.id },
        data: {
          ...googleOwned,
          // A reply that exists on Google is the truth about what is published,
          // including one written in the Google interface rather than here.
          ...(review.existingReply
            ? {
              replyStatus: 'PUBLISHED' as const,
              replyText: review.existingReply.comment,
              repliedAt: review.existingReply.updateTime ?? new Date(),
            }
            : {}),
        },
      });
      updated += 1;
    } else {
      await input.prisma.googleReview.create({
        data: {
          organizationId: input.organizationId,
          clientId: input.clientId,
          locationId: input.locationId,
          externalId: review.externalId,
          ...googleOwned,
          ...(review.existingReply
            ? {
              replyStatus: 'PUBLISHED' as const,
              replyText: review.existingReply.comment,
              repliedAt: review.existingReply.updateTime ?? new Date(),
            }
            : {}),
        },
      });
      created += 1;
    }
  }

  return { created, updated };
}
