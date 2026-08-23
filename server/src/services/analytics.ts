/**
 * Analytics aggregation. Every figure the dashboards, reports and AI analyst use
 * is computed here from `AnalyticsSnapshot` rows — there are no hard-coded
 * numbers anywhere downstream.
 */

import { Prisma, type Platform } from '@prisma/client';

export interface RawSnapshot {
  platform: Platform;
  date: Date;
  spend: Prisma.Decimal | number;
  reach: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: Prisma.Decimal | number;
  engagements: number;
}

export interface Totals {
  spend: number;
  reach: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  engagements: number;
}

/**
 * A ratio is `null` when it cannot be computed, never 0.
 *
 * This is the same principle `finance.ts` encodes with its `Figure` type, and
 * it is here for the same reason: zero is a measurement. A campaign that spent
 * 400 SAR and produced no conversions has a CPA that does not exist — reporting
 * it as 0.00 states that conversions were free, which is the most flattering
 * possible reading of the worst possible outcome. Same for ROAS with no revenue
 * recorded, and CTR with no impressions served.
 *
 * `null` rather than `Figure` here because these objects are serialised
 * straight onto the wire and consumed by charts; `reasons` carries the
 * explanation alongside, so nothing has to guess why a figure is missing.
 */
export interface Derived extends Totals {
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  conversionRate: number | null;
  roas: number | null;
  engagementRate: number | null;
  /** Why each null is null. Absent keys were computable. */
  reasons: Partial<Record<RatioKey, string>>;
}

export type RatioKey = 'ctr' | 'cpc' | 'cpm' | 'cpa' | 'conversionRate' | 'roas' | 'engagementRate';

const toNumber = (value: Prisma.Decimal | number): number =>
  typeof value === 'number' ? value : Number(value.toString());

export function emptyTotals(): Totals {
  return { spend: 0, reach: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, engagements: 0 };
}

export function sumSnapshots(rows: RawSnapshot[]): Totals {
  return rows.reduce<Totals>((acc, row) => {
    acc.spend += toNumber(row.spend);
    acc.reach += row.reach;
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    acc.conversions += row.conversions;
    acc.revenue += toNumber(row.revenue);
    acc.engagements += row.engagements;
    return acc;
  }, emptyTotals());
}

/**
 * Every ratio, or the reason it does not exist.
 *
 * A zero denominator is not an edge case to be smoothed over — it is the answer
 * to a different question. "No conversions yet" and "conversions cost nothing"
 * are opposite facts and they must not render identically.
 */
export function derive(totals: Totals): Derived {
  const reasons: Partial<Record<RatioKey, string>> = {};

  const ratio = (key: RatioKey, numerator: number, denominator: number, whenZero: string): number | null => {
    if (denominator === 0) {
      reasons[key] = whenZero;
      return null;
    }
    return numerator / denominator;
  };

  return {
    ...totals,
    ctr: ratio('ctr', totals.clicks, totals.impressions, 'No impressions were served'),
    cpc: ratio('cpc', totals.spend, totals.clicks, 'No clicks were recorded'),
    cpm: ratio('cpm', totals.spend * 1000, totals.impressions, 'No impressions were served'),
    cpa: ratio('cpa', totals.spend, totals.conversions, 'No conversions were recorded'),
    conversionRate: ratio('conversionRate', totals.conversions, totals.clicks, 'No clicks were recorded'),
    /*
     * ROAS deserves its own note. A zero denominator means nothing was spent,
     * but revenue of zero on real spend is *also* not a 0.00x return — it means
     * no revenue has been attributed, which is usually a tracking gap rather
     * than a commercial result. Both are reported as unavailable, with
     * different reasons, because the fix for each is different.
     */
    roas:
      totals.spend === 0
        ? ((reasons.roas = 'No spend was recorded'), null)
        : totals.revenue === 0
          ? ((reasons.roas = 'No revenue has been attributed to this spend'), null)
          : totals.revenue / totals.spend,
    engagementRate: ratio('engagementRate', totals.engagements, totals.impressions, 'No impressions were served'),
    reasons,
  };
}

export interface PlatformBreakdown extends Derived {
  platform: Platform;
  label: string;
  share: number;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  SNAPCHAT: 'Snapchat',
  GOOGLE_ADS: 'Google Ads',
  GOOGLE_BUSINESS: 'Google Business',
  X: 'X',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
};

export function byPlatform(rows: RawSnapshot[]): PlatformBreakdown[] {
  const groups = new Map<Platform, RawSnapshot[]>();
  for (const row of rows) {
    const bucket = groups.get(row.platform);
    if (bucket) bucket.push(row);
    else groups.set(row.platform, [row]);
  }

  const totalSpend = sumSnapshots(rows).spend;

  return [...groups.entries()]
    .map(([platform, group]) => {
      const derived = derive(sumSnapshots(group));
      return {
        ...derived,
        platform,
        label: PLATFORM_LABELS[platform],
        share: totalSpend === 0 ? 0 : derived.spend / totalSpend,
      };
    })
    .sort((a, b) => b.spend - a.spend);
}

export interface DayPoint extends Derived {
  date: string;
}

/** Daily series, gap-filled so charts do not imply data that is missing. */
export function byDay(rows: RawSnapshot[], from: Date, to: Date): DayPoint[] {
  const groups = new Map<string, RawSnapshot[]>();
  for (const row of rows) {
    const key = row.date.toISOString().slice(0, 10);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const points: DayPoint[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());

  while (cursor.getTime() <= end) {
    const key = cursor.toISOString().slice(0, 10);
    points.push({ date: key, ...derive(sumSnapshots(groups.get(key) ?? [])) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

/** Signed relative change; null when there is no baseline to compare against. */
export function changeRatio(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return current / previous - 1;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
}

/** The equally sized window immediately before `[from, to]`. */
export function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span - 86400000), to: new Date(from.getTime() - 86400000) };
}
