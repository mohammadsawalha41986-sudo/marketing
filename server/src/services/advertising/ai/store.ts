/**
 * Persisting recommendations, and the decisions people make about them.
 *
 * Reuses `AiRecommendation` — the model the campaign optimizer has written to
 * since Phase 13 — rather than adding a second one. The engine only needed four
 * columns it did not have (priority, data sources, platform, place), and those
 * were added to it; a parallel table would have meant two histories of the same
 * kind of decision.
 *
 * The status vocabulary the brief asks for maps onto the existing enum rather
 * than replacing it:
 *
 *   NEW        PENDING     nobody has looked
 *   REVIEWED   REVIEWED    read, not yet decided
 *   ACCEPTED   APPROVED    the operator agrees
 *   DISMISSED  REJECTED    the operator disagrees
 *   APPLIED    APPLIED     the change was actually made
 *
 * APPLIED is deliberately not reachable from this phase's routes. Nothing here
 * changes a budget, a schedule or a campaign — accepting a recommendation
 * records agreement, and the change itself remains a separate, explicit act
 * against the publications API. §29.
 */

import {
  Prisma, RecommendationStatus, type PrismaClient, type RecommendationType,
} from '@prisma/client';

import { orgId, scopeWhere, type Actor } from '../../../lib/scope.js';
import { toConfidenceEnum, type InsightsReport } from './insights.js';

/** What a person can do to a recommendation from this phase's UI. */
export type Decision = 'REVIEWED' | 'ACCEPTED' | 'DISMISSED';

const DECISION_STATUS: Record<Decision, RecommendationStatus> = {
  REVIEWED: RecommendationStatus.REVIEWED,
  ACCEPTED: RecommendationStatus.APPROVED,
  DISMISSED: RecommendationStatus.REJECTED,
};

const PRIORITY = { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' } as const;

/**
 * Persist a run's findings, replacing the previous run's undecided ones.
 *
 * Superseding rather than accumulating: a recommendation is a statement about a
 * window of data, and last week's "increase this budget" sitting beside this
 * week's "decrease it" is not history, it is contradiction. Anything a person
 * has already acted on is left alone — their decision is the record.
 */
export async function persistInsights(input: {
  prisma: PrismaClient;
  actor: Actor;
  clientId: string;
  report: InsightsReport;
}): Promise<{ created: number; superseded: number }> {
  const organizationId = orgId(input.actor);

  const superseded = await input.prisma.aiRecommendation.updateMany({
    where: {
      organizationId,
      clientId: input.clientId,
      // Only the undecided. An accepted or dismissed row is somebody's decision.
      status: { in: [RecommendationStatus.PENDING, RecommendationStatus.REVIEWED] },
    },
    data: { status: RecommendationStatus.EXPIRED },
  });

  const worth = input.report.sections
    .flatMap((section) => section.insights)
    /*
     * An INSUFFICIENT_DATA finding is worth showing on the dashboard — it is
     * how an operator learns the engine looked — but storing it as a pending
     * decision would fill the log with rows nobody can act on.
     */
    .filter((insight) => insight.state !== 'INSUFFICIENT_DATA');

  const created = await Promise.all(
    worth.map((insight) => input.prisma.aiRecommendation.create({
      data: {
        organizationId,
        clientId: input.clientId,
        campaignId: insight.campaignId,
        creativeId: insight.creativeId,
        publicationId: insight.publicationId,
        type: insight.type,
        priority: PRIORITY[insight.priority],
        state: insight.state,
        title: insight.title,
        // Finding and reason are both kept: what was seen, and why it matters.
        reason: `${insight.finding}\n\n${insight.reason}`,
        evidence: insight.evidence as unknown as Prisma.InputJsonValue,
        confidence: toConfidenceEnum(insight.confidence),
        proposedChange: (insight.proposedChange ?? undefined) as unknown as Prisma.InputJsonValue,
        expectedImpact: insight.recommendedAction,
        dataSources: insight.dataSources,
        platform: insight.platform,
        location: insight.location,
        metricsSnapshot: { window: input.report.window } as unknown as Prisma.InputJsonValue,
        windowFrom: new Date(input.report.window.from),
        windowTo: new Date(input.report.window.to),
      },
      select: { id: true },
    })),
  );

  return { created: created.length, superseded: superseded.count };
}

export interface StoredRecommendation {
  id: string;
  type: RecommendationType;
  priority: string;
  state: string;
  title: string;
  reason: string;
  evidence: unknown;
  confidence: string;
  proposedChange: unknown;
  expectedImpact: string | null;
  dataSources: string[];
  platform: string | null;
  location: string | null;
  campaignId: string | null;
  creativeId: string | null;
  publicationId: string | null;
  status: RecommendationStatus;
  windowFrom: Date | null;
  windowTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListFilters {
  clientId?: string;
  platform?: string;
  type?: RecommendationType;
  priority?: string;
  status?: RecommendationStatus;
  campaignId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export async function listRecommendations(
  prisma: PrismaClient,
  actor: Actor,
  filters: ListFilters = {},
): Promise<{ items: StoredRecommendation[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);

  const where: Prisma.AiRecommendationWhereInput = {
    // Scoped without exception: these rows carry another business's spend.
    ...scopeWhere(actor),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.platform ? { platform: filters.platform as never } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.priority ? { priority: filters.priority as never } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    status: filters.status
      ? filters.status
      // Expired rows are superseded findings; showing them would present a
      // previous window's conclusion as though it still stood.
      : { not: RecommendationStatus.EXPIRED },
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.aiRecommendation.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.aiRecommendation.count({ where }),
  ]);

  return { items: items as unknown as StoredRecommendation[], total, page, pageSize };
}

/**
 * Record what a person decided.
 *
 * Scoped by the same rule as the read: a recommendation belonging to another
 * organisation is not found, so it cannot be decided either. The update is a
 * conditional `updateMany` rather than a read-then-write, so a row that slipped
 * out of scope between the two cannot be written by the second half.
 */
export async function decide(input: {
  prisma: PrismaClient;
  actor: Actor;
  id: string;
  decision: Decision;
}): Promise<StoredRecommendation | null> {
  const updated = await input.prisma.aiRecommendation.updateMany({
    where: { id: input.id, ...scopeWhere(input.actor) },
    data: {
      status: DECISION_STATUS[input.decision],
      /*
       * Deliberately not setting appliedAt or appliedById. Accepting a
       * recommendation records agreement with it; it does not apply anything,
       * and nothing in this phase can. §29.
       */
    },
  });

  if (updated.count === 0) return null;

  const row = await input.prisma.aiRecommendation.findFirst({
    where: { id: input.id, ...scopeWhere(input.actor) },
  });
  return (row as unknown as StoredRecommendation) ?? null;
}

export { DECISION_STATUS };
