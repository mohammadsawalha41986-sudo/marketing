/**
 * The paid advertising calendar.
 *
 * Separate from the organic content calendar on purpose, and the separation is
 * the feature rather than an implementation detail. An organic post is a moment
 * — it goes out at 8pm on Tuesday. A campaign is a *flight*: it occupies every
 * day from its start to its end, spending money on each one. Drawing both with
 * the same mark would put a fourteen-day budget commitment on a grid as though
 * it were a single tweet.
 *
 * So a paid item carries a span, and the caller is told which days it covers.
 * `/app/social/calendar` keeps organic exactly as it is; nothing here reads or
 * writes a `PlatformPost`.
 */

import { type Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { scopeWhere, type Actor } from '../../lib/scope.js';
import { PLATFORM_LABELS } from '../analytics.js';
import { adStatusOf, type AdStatus } from './status.js';
import type { AdvertisingFilters } from './overview.js';

export interface PaidCalendarItem {
  id: string;
  name: string;
  platform: string;
  platformLabel: string;
  clientId: string;
  clientName: string;
  objective: string;
  status: AdStatus;
  statusDetail: string;
  /** Ours, set when the campaign was drafted. Always known. */
  dailyBudget: number;
  currency: string;
  startDate: Date;
  endDate: Date;
  /** ISO dates this flight covers inside the requested window. */
  days: string[];
  /** Provider structure, so the operator can find it in Ads Manager. */
  provider: { campaignId: string | null; adSetId: string | null; adId: string | null };
}

export interface PaidCalendarResult {
  from: string;
  to: string;
  items: PaidCalendarItem[];
}

const MAX_SPAN_DAYS = 92;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every day of the flight that falls inside the window, capped. */
function daysWithin(start: Date, end: Date, from: Date, to: Date): string[] {
  const first = start.getTime() > from.getTime() ? start : from;
  const last = end.getTime() < to.getTime() ? end : to;
  if (first.getTime() > last.getTime()) return [];

  const days: string[] = [];
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
  const stop = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());

  while (cursor.getTime() <= stop && days.length <= MAX_SPAN_DAYS) {
    days.push(isoDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export async function paidCalendar(
  actor: Actor,
  filters: AdvertisingFilters = {},
  now: Date = new Date(),
): Promise<PaidCalendarResult> {
  // A month view either side by default; the caller normally sends both.
  const from = filters.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = filters.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  const where: Prisma.AdPublicationWhereInput = {
    ...scopeWhere(actor),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    // Overlap, not containment: a campaign running through the whole month
    // starts before it and ends after it, and would otherwise be invisible in
    // the one view where it matters most.
    startDate: { lte: to },
    endDate: { gte: from },
  };

  const publications = await prisma.adPublication.findMany({
    where,
    include: { client: { select: { id: true, name: true, businessName: true } } },
    orderBy: { startDate: 'asc' },
    take: 300,
  });

  const items = publications
    .map((publication): PaidCalendarItem => {
      const verdict = adStatusOf({
        status: publication.status,
        providerStatus: publication.providerStatus,
        endDate: publication.endDate,
        errorMessage: publication.errorMessage,
        now,
      });

      return {
        id: publication.id,
        name: publication.name,
        platform: publication.platform,
        platformLabel: PLATFORM_LABELS[publication.platform],
        clientId: publication.clientId,
        clientName: publication.client.businessName || publication.client.name,
        objective: publication.objective,
        status: verdict.status,
        statusDetail: verdict.detail,
        dailyBudget: Number(publication.dailyBudget),
        currency: publication.currency,
        startDate: publication.startDate,
        endDate: publication.endDate,
        days: daysWithin(publication.startDate, publication.endDate, from, to),
        provider: {
          campaignId: publication.providerCampaignId,
          adSetId: publication.providerAdSetId,
          adId: publication.providerAdId,
        },
      };
    })
    // Status is derived, so it filters here rather than in SQL — the same
    // reason the campaign list does it after mapping.
    .filter((item) => (filters.status ? item.status === filters.status : true));

  return { from: isoDay(from), to: isoDay(to), items };
}
