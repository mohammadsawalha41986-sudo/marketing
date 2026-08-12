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

export interface Derived extends Totals {
  ctr: number;
  cpc: number;
  cpm: number;
  cpa: number;
  conversionRate: number;
  roas: number;
  engagementRate: number;
}

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

/** Ratios, with zero denominators returning 0 rather than NaN or Infinity. */
export function derive(totals: Totals): Derived {
  const safe = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator);
  return {
    ...totals,
    ctr: safe(totals.clicks, totals.impressions),
    cpc: safe(totals.spend, totals.clicks),
    cpm: safe(totals.spend * 1000, totals.impressions),
    cpa: safe(totals.spend, totals.conversions),
    conversionRate: safe(totals.conversions, totals.clicks),
    roas: safe(totals.revenue, totals.spend),
    engagementRate: safe(totals.engagements, totals.impressions),
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
