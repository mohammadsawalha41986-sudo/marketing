/**
 * What every platform publisher promises, and nothing more.
 *
 * The publishing service knows this file and no provider's file. That is the
 * whole point: adding Instagram or TikTok later means writing an adapter and
 * registering it, not editing the workflow, the scheduler, the worker or the
 * state machine. Anything Meta-specific that leaks up to here — a page id, a
 * Graph version, an OAuthException subcode — has leaked into every future
 * platform too.
 *
 * Note what a publisher does *not* do: it does not read or write the database,
 * decide statuses, count attempts, or schedule retries. It performs one call
 * against one provider and reports what happened. Everything durable is the
 * service's job, so a publisher can be reasoned about — and tested — as a pure
 * function of its inputs.
 */

import type { Platform } from '@prisma/client';

/** Node's fetch, narrowed to what publishers use, so tests can supply their own. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/**
 * Why a publish failed, and whether trying again could possibly help.
 *
 * This distinction is the one that decides between a retry and a person. A
 * missing permission will fail identically forever, so retrying it wastes rate
 * limit and buries the real problem; a 503 from Meta will very likely succeed in
 * a minute. Getting this wrong in either direction is expensive, so the mapping
 * lives in one place per provider and is asserted in tests.
 */
export type PublishErrorKind =
  // Retryable.
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  // Permanent, until a human changes something.
  | 'INVALID_TOKEN'
  | 'MISSING_PERMISSION'
  | 'INVALID_ACCOUNT'
  | 'INVALID_MEDIA'
  | 'INVALID_REQUEST'
  | 'NOT_CONFIGURED';

const RETRYABLE: ReadonlySet<PublishErrorKind> = new Set<PublishErrorKind>([
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
]);

export function isRetryable(kind: PublishErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export interface PublishError {
  kind: PublishErrorKind;
  /** The provider's own code, when it gave one. Kept for debugging. */
  code: string | null;
  /**
   * A sentence an operator can act on. Written for the person who has to fix
   * it, not copied from the provider — but never inventing a cause the provider
   * did not give.
   */
  message: string;
  /** The provider's HTTP status, when there was a response at all. */
  httpStatus: number | null;
}

/**
 * The media being published, resolved to bytes.
 *
 * Bytes rather than a URL, deliberately. The obvious design hands the provider
 * a link and lets it fetch — but this application serves media from
 * `/api/media/:id/file`, which is authenticated and relative, so Meta would get
 * a redirect to a login page. Making it work by URL would mean publishing a
 * public, unauthenticated endpoint for every customer's creative, or minting
 * signed links with an expiry that has to outlive an unknown provider fetch
 * delay. Uploading the bytes needs neither, and keeps private storage private.
 *
 * The cost is holding a file in memory for the duration of the call, which is
 * bounded by the upload limits already enforced when the media was accepted.
 */
export interface PublishMedia {
  kind: 'IMAGE' | 'VIDEO';
  data: Buffer;
  mimeType: string;
  filename: string;
  /**
   * A public, un-authenticated URL for the same bytes, when one exists.
   *
   * Facebook takes the bytes directly, so it never needs this. Instagram's
   * Content Publishing API is URL-only: it hands Meta a link and Meta fetches
   * it, which cannot be an authenticated endpoint. A publisher that needs a
   * public URL and does not get one must refuse with INVALID_MEDIA rather than
   * publish something Meta will fail to fetch.
   */
  publicUrl?: string | null;
}

/** Everything a publisher needs, with nothing about how it was stored. */
export interface PublishRequest {
  /** The post's text. Platforms that separate headline from body compose it. */
  caption: string;
  media: PublishMedia[];
  /** The account being published to, and its decrypted credential. */
  account: {
    externalId: string;
    name: string;
    /**
     * Decrypted immediately before the call and never held longer.
     * Publishers must not log it, echo it, or put it in a PublishError.
     */
    accessToken: string;
    /**
     * The account's own provider metadata, straight from
     * `IntegrationAccount.metadata`. Never credentials — those are the field
     * above — but facts about the account a publisher cannot infer from a
     * token: today, which Instagram connection issued it, because an
     * Instagram-Login token is served by a different Graph host than a
     * Page-derived one and calling the wrong host fails with an error that
     * names neither.
     */
    metadata?: Record<string, unknown>;
  };
  fetchImpl: FetchLike;
  /** Abandon the call after this long. Absent means the publisher's default. */
  timeoutMs?: number;
  /**
   * The post's provider-specific settings, straight from `PlatformPost.config`.
   *
   * Declared here rather than reached for through a cast because two adapters
   * now genuinely need it — YouTube for title and visibility, TikTok for the
   * privacy level it must send. A publisher that does not understand a key
   * ignores it; nothing here is credentials, which live encrypted on the
   * account and are never addressable from a post's config.
   */
  config?: Record<string, unknown>;
}

export type PublishResult =
  | {
      success: true;
      platform: Platform;
      /** The provider's id for the post. Never ours, never synthesised. */
      externalPostId: string;
      permalink: string | null;
      publishedAt: Date;
    }
  | {
      success: false;
      platform: Platform;
      error: PublishError;
    };

export interface PlatformPublisher {
  readonly platform: Platform;
  /** Shown to operators when this platform cannot be used yet. */
  readonly label: string;
  /**
   * Whether this adapter can actually publish, as opposed to merely existing.
   * A registered publisher that answers false is honest architecture; one that
   * answers true and throws is not.
   */
  readonly canPublish: boolean;
  publish(request: PublishRequest): Promise<PublishResult>;
}
