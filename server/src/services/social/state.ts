/**
 * What may follow what, for a platform post and for the group it belongs to.
 *
 * The transitions are declared as data rather than scattered through the routes
 * that perform them. A workflow whose rules live in six `if` statements has six
 * places to disagree, and the disagreement shows up as a post that reached
 * PUBLISHED without ever being approved.
 *
 * The group's status is *derived*, never set directly. It is a summary of its
 * children, and the interesting case is the one a single-platform model cannot
 * express at all: Facebook succeeded, TikTok failed. That is neither PUBLISHED
 * nor FAILED, and calling it either loses the half that matters — hence
 * PARTIALLY_PUBLISHED.
 */

import { PlatformPostStatus, PostGroupStatus } from '@prisma/client';

/**
 * Legal transitions for one platform's post.
 *
 * Read as "from → the states it may move to". Anything absent is refused,
 * including the one that matters most: DRAFT → PUBLISHED. Approval is not a
 * step that can be skipped by calling a different endpoint.
 */
const PLATFORM_TRANSITIONS: Record<PlatformPostStatus, PlatformPostStatus[]> = {
  DRAFT: ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW: ['APPROVED', 'CHANGES_REQUESTED', 'CANCELLED'],
  CHANGES_REQUESTED: ['IN_REVIEW', 'DRAFT', 'CANCELLED'],
  // Approved work may be scheduled, or sent straight out. Both are downstream
  // of a human decision, which is the property that matters.
  APPROVED: ['SCHEDULED', 'QUEUED', 'CANCELLED'],
  SCHEDULED: ['QUEUED', 'APPROVED', 'CANCELLED'],
  QUEUED: ['PUBLISHING', 'CANCELLED'],
  // No CANCELLED: a request is already with the provider, and pretending it can
  // be withdrawn would be a lie about what the platform is doing.
  PUBLISHING: ['PUBLISHED', 'FAILED'],
  // Terminal. A published post is undone on the platform, not here.
  PUBLISHED: [],
  // Retry goes back through the queue rather than straight to PUBLISHING, so
  // every attempt is claimed the same way.
  FAILED: ['QUEUED', 'DRAFT'],
  CANCELLED: ['DRAFT'],
};

export function canTransition(from: PlatformPostStatus, to: PlatformPostStatus): boolean {
  return PLATFORM_TRANSITIONS[from].includes(to);
}

/** The refusal, written for the person who tried it. */
export function transitionError(from: PlatformPostStatus, to: PlatformPostStatus): string {
  const allowed = PLATFORM_TRANSITIONS[from];
  return allowed.length === 0
    ? `This post is ${from.toLowerCase().replace('_', ' ')} and cannot change state.`
    : `A post that is ${from.toLowerCase().replace('_', ' ')} cannot become ${to.toLowerCase().replace('_', ' ')}. ` +
      `It can only become: ${allowed.join(', ')}.`;
}

/**
 * The group's status, computed from its children.
 *
 * Order matters here, and it is chosen so the summary never overstates. A group
 * is only PUBLISHED when every platform published; a single failure alongside a
 * success is PARTIALLY_PUBLISHED rather than either extreme; and anything still
 * moving outranks anything settled, because "in progress" is the more useful
 * thing to show while it is true.
 */
export function deriveGroupStatus(posts: Array<{ status: PlatformPostStatus }>): PostGroupStatus {
  if (posts.length === 0) return PostGroupStatus.DRAFT;

  const has = (status: PlatformPostStatus) => posts.some((post) => post.status === status);
  const every = (...statuses: PlatformPostStatus[]) =>
    posts.every((post) => statuses.includes(post.status));

  // Live states first: something is happening right now.
  if (has(PlatformPostStatus.PUBLISHING) || has(PlatformPostStatus.QUEUED)) {
    return PostGroupStatus.PUBLISHING;
  }

  const published = posts.filter((post) => post.status === PlatformPostStatus.PUBLISHED).length;
  const failed = posts.filter((post) => post.status === PlatformPostStatus.FAILED).length;

  if (published > 0 && published === posts.length) return PostGroupStatus.PUBLISHED;
  // The case the old model could not say out loud.
  if (published > 0 && (failed > 0 || published < posts.length)) {
    return PostGroupStatus.PARTIALLY_PUBLISHED;
  }
  if (failed > 0 && failed === posts.length) return PostGroupStatus.FAILED;

  if (every(PlatformPostStatus.CANCELLED)) return PostGroupStatus.CANCELLED;
  if (has(PlatformPostStatus.SCHEDULED)) return PostGroupStatus.SCHEDULED;
  if (has(PlatformPostStatus.CHANGES_REQUESTED)) return PostGroupStatus.CHANGES_REQUESTED;
  if (has(PlatformPostStatus.IN_REVIEW)) return PostGroupStatus.IN_REVIEW;
  if (every(PlatformPostStatus.APPROVED, PlatformPostStatus.CANCELLED)) return PostGroupStatus.APPROVED;

  return PostGroupStatus.DRAFT;
}
