/**
 * What state an advertisement is actually in, and why.
 *
 * `PublicationStatus` describes *our* side of the exchange — did we manage to
 * send this to the provider — and it stops there. It cannot say whether the
 * campaign is running, because running is the provider's fact, not ours. An
 * operator looking at an advertising dashboard is asking the second question,
 * and answering it with the first is how "Published" comes to sit beside a
 * campaign that has been paused in Ads Manager for a week.
 *
 * So this maps the pair — our status and the provider's raw status — onto one
 * vocabulary, and refuses to guess when the pair does not determine an answer.
 *
 * The refusal matters more than it looks. Every adapter in this repository
 * creates campaigns paused on purpose, so nothing spends unattended. Only Meta
 * reads its status back (`effectiveStatus ?? status`); Google Ads and TikTok
 * record the value they were created with and never revisit it, because neither
 * has reporting ingestion. Treating "PUBLISHED with no provider status" as
 * ACTIVE would therefore report money being spent that is not, on every
 * platform but one. It reports UNKNOWN instead, and says why.
 */

import { PublicationStatus } from '@prisma/client';

export type AdStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED'
  | 'NEEDS_ATTENTION'
  | 'UNKNOWN';

/** Statuses that mean an operator has something to do right now. */
export const ATTENTION_STATUSES: readonly AdStatus[] = ['FAILED', 'REJECTED', 'NEEDS_ATTENTION'];

export interface StatusVerdict {
  status: AdStatus;
  /** What the provider itself said, verbatim, when it said anything. */
  providerStatus: string | null;
  /** Why this verdict, in the operator's terms. Never invented. */
  detail: string;
}

/**
 * The provider vocabularies, normalised.
 *
 * Each platform names the same two states differently — Meta says PAUSED,
 * TikTok says DISABLE, Google says PAUSED — and a dashboard that showed the raw
 * word would make one paused campaign look like three different things.
 * Anything not in this table is deliberately not guessed at.
 */
const PROVIDER_STATUS: Record<string, AdStatus> = {
  // Running.
  ACTIVE: 'ACTIVE',
  ENABLE: 'ACTIVE',
  ENABLED: 'ACTIVE',
  // Stopped by someone.
  PAUSED: 'PAUSED',
  DISABLE: 'PAUSED',
  DISABLED: 'PAUSED',
  CAMPAIGN_PAUSED: 'PAUSED',
  ADSET_PAUSED: 'PAUSED',
  // Refused by the provider's review.
  DISAPPROVED: 'REJECTED',
  REJECTED: 'REJECTED',
  WITH_ISSUES: 'REJECTED',
  // Waiting on the provider.
  PENDING_REVIEW: 'PENDING',
  IN_PROCESS: 'PENDING',
  PENDING: 'PENDING',
  // Over.
  ARCHIVED: 'COMPLETED',
  COMPLETED: 'COMPLETED',
  DELETED: 'COMPLETED',
  REMOVED: 'COMPLETED',
};

export interface StatusInput {
  status: PublicationStatus;
  providerStatus: string | null;
  endDate: Date | null;
  errorMessage: string | null;
  now?: Date;
}

export function adStatusOf(input: StatusInput): StatusVerdict {
  const now = input.now ?? new Date();
  const raw = input.providerStatus?.trim() ?? null;

  switch (input.status) {
    case PublicationStatus.DRAFT:
      return { status: 'DRAFT', providerStatus: raw, detail: 'Not sent to the provider yet.' };

    case PublicationStatus.APPROVED:
      return {
        status: 'PENDING',
        providerStatus: raw,
        detail: 'Approved internally and waiting to be published.',
      };

    case PublicationStatus.PUBLISHING:
      return { status: 'PENDING', providerStatus: raw, detail: 'Being sent to the provider now.' };

    case PublicationStatus.FAILED:
      return {
        status: 'FAILED',
        providerStatus: raw,
        detail: input.errorMessage ?? 'The provider refused this advertisement.',
      };

    case PublicationStatus.REQUIRES_REAUTH:
      return {
        status: 'NEEDS_ATTENTION',
        providerStatus: raw,
        detail: 'The provider connection expired. Reconnect the account to continue.',
      };

    case PublicationStatus.PUBLISHED:
    default:
      break;
  }

  // Published. What happens next is the provider's to say.
  const mapped = raw ? PROVIDER_STATUS[raw.toUpperCase()] : undefined;

  if (mapped === 'REJECTED') {
    return { status: 'REJECTED', providerStatus: raw, detail: 'The provider rejected this advertisement on review.' };
  }

  /*
   * A finished flight is finished whatever the provider still calls it — a
   * campaign whose end date passed last month is not "active", and showing it
   * among the running campaigns puts it in the operator's way every morning.
   */
  if (input.endDate && input.endDate.getTime() < now.getTime()) {
    return {
      status: 'COMPLETED',
      providerStatus: raw,
      detail: 'The scheduled flight has ended.',
    };
  }

  if (mapped) {
    return {
      status: mapped,
      providerStatus: raw,
      detail:
        mapped === 'ACTIVE'
          ? 'The provider reports this advertisement as running.'
          : mapped === 'PAUSED'
            ? 'Paused at the provider. Every advertisement is created paused so nothing spends unattended.'
            : 'Reported by the provider.',
    };
  }

  /*
   * Published, and nothing readable came back. Not "active" — see the header.
   * The honest answer names what is missing rather than picking the optimistic
   * reading of an unanswered question.
   */
  return {
    status: 'UNKNOWN',
    providerStatus: raw,
    detail: raw
      ? `The provider reported "${raw}", which this application does not recognise. Check the platform's own manager.`
      : 'Published, but the provider\'s current status has not been read back. Check the platform\'s own manager.',
  };
}
