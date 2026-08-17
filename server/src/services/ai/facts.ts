/**
 * The only campaign data the AI analyst ever sees.
 *
 * A caller computes this from AnalyticsSnapshot rows and hands it over. The AI
 * service has no database access, so the model cannot reach past this object,
 * and every figure it can cite is one that was measured.
 */

import type { Derived, PlatformBreakdown } from '../analytics.js';
import { changeRatio, derive, sumSnapshots, byPlatform, type RawSnapshot } from '../analytics.js';

export interface CampaignFacts {
  clientName: string;
  campaignNames: string[];
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  daysRemaining: number;
  budget: number;
  budgetUsed: number;
  totals: Derived;
  previous: Derived;
  platforms: PlatformBreakdown[];
  ctrTrend: number;
  conversionTrend: number;
  spendTrend: number;
}

export function buildFacts(input: {
  clientName: string;
  campaignNames: string[];
  current: RawSnapshot[];
  previous: RawSnapshot[];
  periodStart: Date;
  periodEnd: Date;
  budget: number;
  daysRemaining: number;
}): CampaignFacts {
  const totals = derive(sumSnapshots(input.current));
  const previous = derive(sumSnapshots(input.previous));
  const periodDays = Math.max(
    1,
    Math.round((input.periodEnd.getTime() - input.periodStart.getTime()) / 86400000) + 1,
  );

  return {
    clientName: input.clientName,
    campaignNames: input.campaignNames,
    periodStart: input.periodStart.toISOString().slice(0, 10),
    periodEnd: input.periodEnd.toISOString().slice(0, 10),
    periodDays,
    daysRemaining: input.daysRemaining,
    budget: input.budget,
    budgetUsed: input.budget === 0 ? 0 : totals.spend / input.budget,
    totals,
    previous,
    platforms: byPlatform(input.current),
    // 0 means "no movement", which is a claim. Unmeasurable CTR in either
    // period is not no movement, so the trend is only computed when both exist.
    ctrTrend: totals.ctr === null || previous.ctr === null ? 0 : changeRatio(totals.ctr, previous.ctr) ?? 0,
    conversionTrend: changeRatio(totals.conversions, previous.conversions) ?? 0,
    spendTrend: changeRatio(totals.spend, previous.spend) ?? 0,
  };
}
