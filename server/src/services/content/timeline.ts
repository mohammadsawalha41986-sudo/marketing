/**
 * One chronological history for a piece of content.
 *
 * The detail screen used to show approvals in one list and comments in another,
 * which meant nobody could answer "what actually happened to this post, in what
 * order" without reading both and merging them by eye. Scheduling did not appear
 * at all, so the gap between "approved" and "why has this not gone out" had no
 * record to consult.
 *
 * Events are assembled from the domain rows that already exist rather than a new
 * log table: approvals, comments and the content's own timestamps are the record,
 * and duplicating them into a second store would create two versions of the past
 * that can disagree. The audit log contributes only the actions that leave no
 * domain trace of their own — scheduling being the one that matters — and only
 * ever as { who, when, what }. It carries IP addresses and arbitrary metadata
 * that a client reviewer has no business reading.
 */

import type { PrismaClient } from '@prisma/client';

export type TimelineKind =
  | 'CREATED'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'SCHEDULED'
  | 'PUBLISHED'
  | 'FAILED';

export interface TimelineEvent {
  kind: TimelineKind;
  /** When it happened. Events are returned oldest first. */
  at: Date;
  /** Who did it, when a person did. Null for anything the system did alone. */
  actor: string | null;
  /** The reviewer's note or the comment body. Never invented. */
  note: string | null;
}

/** The audit actions worth showing, and what each is called on screen. */
const AUDITED: Record<string, TimelineKind> = {
  'content.schedule': 'SCHEDULED',
};

export async function contentTimeline(input: {
  prisma: PrismaClient;
  contentId: string;
  organizationId: string;
}): Promise<TimelineEvent[]> {
  const { prisma, contentId, organizationId } = input;

  const content = await prisma.content.findFirst({
    where: { id: contentId, organizationId },
    select: {
      createdAt: true,
      publishedAt: true,
      failureReason: true,
      author: { select: { name: true } },
      approvals: {
        orderBy: { createdAt: 'asc' },
        select: {
          status: true,
          note: true,
          createdAt: true,
          decidedAt: true,
          decidedBy: { select: { name: true } },
        },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        select: { body: true, createdAt: true, author: { select: { name: true } } },
      },
    },
  });

  if (!content) return [];

  const events: TimelineEvent[] = [
    { kind: 'CREATED', at: content.createdAt, actor: content.author?.name ?? null, note: null },
  ];

  for (const approval of content.approvals) {
    // Every approval row began as a submission, whatever it became.
    events.push({ kind: 'SUBMITTED', at: approval.createdAt, actor: null, note: null });

    // A decision only exists once it has been made. A PENDING row is a post
    // waiting for a reviewer, not an event.
    if (approval.status !== 'PENDING' && approval.decidedAt) {
      events.push({
        kind: approval.status,
        at: approval.decidedAt,
        actor: approval.decidedBy?.name ?? null,
        note: approval.note,
      });
    }
  }

  for (const comment of content.comments) {
    events.push({
      kind: 'COMMENTED',
      at: comment.createdAt,
      actor: comment.author?.name ?? null,
      note: comment.body,
    });
  }

  const audited = await prisma.auditLog.findMany({
    where: { entity: 'Content', entityId: contentId, action: { in: Object.keys(AUDITED) } },
    orderBy: { createdAt: 'asc' },
    select: { action: true, createdAt: true, user: { select: { name: true } } },
  });

  for (const row of audited) {
    const kind = AUDITED[row.action];
    if (kind) events.push({ kind, at: row.createdAt, actor: row.user?.name ?? null, note: null });
  }

  if (content.publishedAt) {
    events.push({ kind: 'PUBLISHED', at: content.publishedAt, actor: null, note: null });
  }

  /*
   * A failure has no timestamp of its own on Content, so it is placed last
   * rather than given an invented one. It is the current state, not a moment.
   */
  if (content.failureReason) {
    events.push({
      kind: 'FAILED',
      at: content.publishedAt ?? new Date(),
      actor: null,
      note: content.failureReason,
    });
  }

  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}
