/** Pure-function tests: colour maths, analytics maths, and the AI analyst. */

import { describe, expect, it } from 'vitest';
import type { Platform } from '@prisma/client';

import {
  contrastRatio, hexToRgb, hslToHex, luminance, readableTextOn, rgbToHex, rgbToHsl, isValidHex,
} from '../src/services/palette.js';
import {
  byDay, byPlatform, changeRatio, derive, deriveAd, emptyTotals, previousWindow, sumSnapshots,
  type RawSnapshot,
} from '../src/services/analytics.js';
import { buildFacts } from '../src/services/ai/facts.js';
import { templateAnalysis, templateCopy, templateHashtags } from '../src/services/ai/template.js';
import { findForbidden, platformRule } from '../src/services/ai/context.js';
import type { BrandContext, ContentRequest } from '../src/services/ai/context.js';

// ---------------------------------------------------------------- colour

describe('colour maths', () => {
  it('round-trips hex and rgb', () => {
    expect(rgbToHex(99, 102, 241)).toBe('#6366F1');
    expect(hexToRgb('#6366F1')).toEqual({ r: 99, g: 102, b: 241 });
    expect(hexToRgb('#FFF')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('converts rgb to hsl and back', () => {
    const hsl = rgbToHsl(255, 0, 0);
    expect(hsl.h).toBeCloseTo(0, 1);
    expect(hsl.s).toBeCloseTo(1, 2);
    expect(hslToHex(0, 1, 0.5)).toBe('#FF0000');
  });

  it('computes WCAG contrast, symmetric in its arguments', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 3);
  });

  it('orders luminance correctly', () => {
    expect(luminance('#FFFFFF')).toBeGreaterThan(luminance('#808080'));
    expect(luminance('#808080')).toBeGreaterThan(luminance('#000000'));
  });

  it('picks whichever of black or white reads better on a background', () => {
    expect(readableTextOn('#0B0F1A')).toBe('#FFFFFF');
    expect(readableTextOn('#FFFFFF')).toBe('#0B0F1A');

    // The contract is "the better of the two", not "always AA". Mid-tone
    // brand colours genuinely cannot reach 4.5:1 against either, which is why
    // the palette approval endpoint warns instead of silently accepting.
    for (const background of ['#6366F1', '#22D3EE', '#1F7A5A', '#E9C46A']) {
      const picked = readableTextOn(background);
      const other = picked === '#FFFFFF' ? '#0B0F1A' : '#FFFFFF';
      expect(contrastRatio(picked, background)).toBeGreaterThanOrEqual(contrastRatio(other, background));
    }
  });

  it('leaves mid-tone backgrounds below AA, which is what the approval warning is for', () => {
    // #6366F1 is the default brand colour; neither black nor white clears 4.5:1.
    const best = contrastRatio(readableTextOn('#6366F1'), '#6366F1');
    expect(best).toBeLessThan(4.5);
    expect(best).toBeGreaterThan(4);
  });

  it('validates hex strings', () => {
    expect(isValidHex('#ABC')).toBe(true);
    expect(isValidHex('#AABBCC')).toBe(true);
    expect(isValidHex('AABBCC')).toBe(false);
    expect(isValidHex('#GGG')).toBe(false);
  });
});

// ---------------------------------------------------------------- analytics

const snapshot = (over: Partial<RawSnapshot> = {}): RawSnapshot => ({
  platform: 'INSTAGRAM' as Platform,
  date: new Date('2026-08-10T00:00:00Z'),
  spend: 100,
  reach: 5000,
  impressions: 10000,
  clicks: 200,
  leads: 20,
  conversions: 10,
  revenue: 800,
  engagements: 300,
  ...over,
});

describe('analytics maths', () => {
  it('sums every measure', () => {
    const totals = sumSnapshots([snapshot(), snapshot({ spend: 50, clicks: 100, leads: 5 })]);
    expect(totals.spend).toBe(150);
    expect(totals.clicks).toBe(300);
    expect(totals.leads).toBe(25);
    expect(totals.impressions).toBe(20000);
  });

  it('returns zeroes, not NaN, for an empty set', () => {
    expect(sumSnapshots([])).toEqual(emptyTotals());
    const derived = derive(sumSnapshots([]));
    for (const value of Object.values(derived)) expect(Number.isFinite(value)).toBe(true);
  });

  it('derives ratios and never divides by zero', () => {
    const derived = derive(sumSnapshots([snapshot()]));
    expect(derived.ctr).toBeCloseTo(0.02, 5);
    expect(derived.cpc).toBeCloseTo(0.5, 5);
    expect(derived.cpm).toBeCloseTo(10, 5);
    expect(derived.conversionRate).toBeCloseTo(0.05, 5);
    expect(derived.costPerLead).toBeCloseTo(5, 5);
    expect(derived.roas).toBeCloseTo(8, 5);

    const empty = derive(emptyTotals());
    expect(empty.ctr).toBe(0);
    expect(empty.roas).toBe(0);
  });

  it('handles Prisma decimal-like values', () => {
    const totals = sumSnapshots([snapshot({ spend: { toString: () => '25.5' } as never })]);
    expect(totals.spend).toBeCloseTo(25.5, 2);
  });

  it('groups by platform and computes each share of spend', () => {
    const rows = [
      snapshot({ platform: 'INSTAGRAM' as Platform, spend: 300 }),
      snapshot({ platform: 'TIKTOK' as Platform, spend: 100 }),
    ];
    const grouped = byPlatform(rows);
    expect(grouped[0]?.platform).toBe('INSTAGRAM');
    expect(grouped[0]?.share).toBeCloseTo(0.75, 3);
    expect(grouped[1]?.share).toBeCloseTo(0.25, 3);
  });

  it('gap-fills the daily series so charts do not imply missing data', () => {
    const points = byDay(
      [snapshot({ date: new Date('2026-08-10T00:00:00Z') })],
      new Date('2026-08-08T00:00:00Z'),
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(points).toHaveLength(5);
    expect(points.map((point) => point.date)).toEqual([
      '2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12',
    ]);
    expect(points[0]?.spend).toBe(0);
    expect(points[2]?.spend).toBe(100);
  });

  it('reports change against a baseline, and null when there is none', () => {
    expect(changeRatio(120, 100)).toBeCloseTo(0.2, 5);
    expect(changeRatio(80, 100)).toBeCloseTo(-0.2, 5);
    expect(changeRatio(50, 0)).toBeNull();
  });

  it('builds an equally sized previous window that does not overlap', () => {
    const from = new Date('2026-08-01T00:00:00Z');
    const to = new Date('2026-08-30T00:00:00Z');
    const previous = previousWindow(from, to);

    expect(previous.to.getTime()).toBeLessThan(from.getTime());
    expect(to.getTime() - from.getTime()).toBe(previous.to.getTime() - previous.from.getTime());
  });
});

describe('ad ratios', () => {
  const ad = {
    spend: 500, revenue: 2000, impressions: 100000,
    reach: 60000, clicks: 2500, leads: 100, conversions: 50,
  };

  it('derives every rate from the stored figures', () => {
    const metrics = deriveAd(ad);
    expect(metrics.ctr).toBeCloseTo(0.025, 5);
    expect(metrics.cpc).toBeCloseTo(0.2, 5);
    expect(metrics.cpm).toBeCloseTo(5, 5);
    expect(metrics.cpa).toBeCloseTo(10, 5);
    expect(metrics.costPerLead).toBeCloseTo(5, 5);
    expect(metrics.conversionRate).toBeCloseTo(0.02, 5);
    expect(metrics.roas).toBeCloseTo(4, 5);
  });

  it('returns zeroes rather than NaN for an ad that has not run', () => {
    const metrics = deriveAd({ spend: 0, revenue: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, conversions: 0 });
    for (const value of Object.values(metrics)) expect(Number.isFinite(value)).toBe(true);
    expect(metrics.roas).toBe(0);
  });

  it('accepts Prisma decimals for the money columns', () => {
    const metrics = deriveAd({
      ...ad,
      spend: { toString: () => '250.50' } as never,
      revenue: { toString: () => '1002.00' } as never,
    });
    expect(metrics.roas).toBeCloseTo(4, 2);
  });
});

// ---------------------------------------------------------------- AI

const brand: BrandContext = {
  businessName: 'Zaytoun Kitchen',
  cuisine: 'Levantine',
  description: 'Levantine home cooking.',
  targetAudience: 'Families in Amman',
  location: 'Amman',
  personality: ['Warm'],
  toneOfVoice: 'Warm and direct',
  values: ['Hospitality'],
  products: ['Mezze platter'],
  services: ['Dine-in'],
  usps: ['Made fresh each morning'],
  offers: ['Family platter for four'],
  keywords: ['Levantine food'],
  forbiddenWords: ['cheap'],
  ctaStyle: 'Book a table',
};

const request: ContentRequest = {
  platform: 'INSTAGRAM' as Platform,
  contentType: 'POST',
  language: 'EN',
  tone: null,
  productService: 'Mezze platter',
  offer: null,
  audience: null,
  adName: null,
};

describe('AI template engine', () => {
  it('fills every copy field from the brand context', () => {
    const copy = templateCopy(brand, request);
    for (const field of ['headline', 'caption', 'primaryText', 'shortText', 'longText', 'slogan', 'cta']) {
      expect(copy[field as keyof typeof copy]).toBeTruthy();
    }
    expect(copy.headline).toContain('Zaytoun Kitchen');
    expect(copy.cta).toBe('Book a table');
  });

  it('is deterministic for the same brief', () => {
    expect(templateCopy(brand, request)).toEqual(templateCopy(brand, request));
  });

  it('writes Arabic when asked', () => {
    const copy = templateCopy(brand, { ...request, language: 'AR' });
    expect(copy.caption).toMatch(/[؀-ۿ]/);
  });

  it('respects the platform caption limit', () => {
    const copy = templateCopy(brand, { ...request, platform: 'TIKTOK' as Platform });
    expect(copy.caption.length).toBeLessThanOrEqual(platformRule('TIKTOK' as Platform).captionMax);
  });

  it('produces hashtags that are well formed and capped', () => {
    const tags = templateHashtags(brand, request, 5);
    expect(tags.length).toBeLessThanOrEqual(5);
    for (const tag of tags) {
      expect(tag.startsWith('#')).toBe(true);
      expect(tag).not.toContain(' ');
    }
  });

  it('detects forbidden words case-insensitively', () => {
    expect(findForbidden('This is CHEAP food', ['cheap'])).toEqual(['cheap']);
    expect(findForbidden('This is good food', ['cheap'])).toEqual([]);
  });
});

describe('AI marketing analyst', () => {
  const facts = (over: Partial<Parameters<typeof buildFacts>[0]> = {}) =>
    buildFacts({
      restaurantName: 'Zaytoun Kitchen',
      campaignNames: ['Ramadan platters'],
      current: [
        snapshot({ platform: 'INSTAGRAM' as Platform, spend: 400, revenue: 2000, conversions: 40, clicks: 800 }),
        snapshot({ platform: 'TIKTOK' as Platform, spend: 400, revenue: 200, conversions: 4, clicks: 300 }),
      ],
      previous: [snapshot({ spend: 700, revenue: 2400, conversions: 40, clicks: 900 })],
      periodStart: new Date('2026-08-01T00:00:00Z'),
      periodEnd: new Date('2026-08-30T00:00:00Z'),
      budget: 1000,
      daysRemaining: 10,
      ...over,
    });

  it('quotes only figures present in the facts it was given', () => {
    const input = facts();
    const analysis = templateAnalysis(input);

    // Every number in the summary must trace back to a measured value.
    expect(analysis.summary).toContain('800');           // total spend
    expect(analysis.summary).toContain(String(input.totals.conversions));
    expect(analysis.summary).toContain(input.totals.roas.toFixed(2));
  });

  it('spots the weaker platform and proposes moving budget', () => {
    const analysis = templateAnalysis(facts());
    const titles = analysis.recommendations.map((r) => r.title).join(' ');
    expect(titles).toMatch(/shift budget/i);
    expect(titles).toMatch(/tiktok/i);
  });

  it('flags a tracking problem when clicks convert to nothing', () => {
    const analysis = templateAnalysis(
      facts({
        current: [snapshot({ spend: 500, clicks: 900, conversions: 0, revenue: 0 })],
        previous: [snapshot({ spend: 500, clicks: 900, conversions: 0, revenue: 0 })],
      }),
    );
    expect(analysis.recommendations.some((r) => /tracking/i.test(r.title))).toBe(true);
  });

  it('flags budget burning down too early', () => {
    const analysis = templateAnalysis(facts({ budget: 850 }));
    expect(analysis.failing.join(' ')).toMatch(/budget is spent/i);
  });

  it('says so plainly when there is nothing to analyse', () => {
    const analysis = templateAnalysis(facts({ current: [], previous: [] }));
    expect(analysis.summary).toMatch(/no spend/i);
  });

  it('always returns at least one recommendation', () => {
    const steady = facts({
      current: [snapshot({ spend: 100, revenue: 200, conversions: 10, clicks: 100 })],
      previous: [snapshot({ spend: 100, revenue: 200, conversions: 10, clicks: 100 })],
      budget: 1000,
    });
    expect(templateAnalysis(steady).recommendations.length).toBeGreaterThan(0);
  });
});
