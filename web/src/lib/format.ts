/** Locale-aware formatting. Arabic uses Western digits for scannable tables. */

import type { Lang } from './i18n';

const locales: Record<Lang, string> = { en: 'en-US', ar: 'ar-JO-u-nu-latn' };

/**
 * Money, in the currency the row is actually denominated in.
 *
 * `currency` is last and defaults to USD so existing calls are unaffected, but
 * anything showing a campaign figure should pass the campaign's own currency —
 * a budget of 10,000 SAR rendered as $10,000 is not a formatting nit, it is a
 * wrong number on a financial dashboard.
 */
export function money(value: number | null | undefined, lang: Lang = 'en', compact = false, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  const abs = Math.abs(value);

  if (compact && abs >= 1000) {
    // Intl has no compact currency notation, so the symbol is resolved once
    // and reused rather than hardcoding '$'.
    const symbol =
      new Intl.NumberFormat(locales[lang], { style: 'currency', currency, maximumFractionDigits: 0 })
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? currency;
    const scaled = abs >= 1_000_000 ? value / 1_000_000 : value / 1000;
    const suffix = abs >= 1_000_000 ? 'M' : 'k';
    const digits = abs >= 1_000_000 ? (abs >= 10_000_000 ? 1 : 2) : abs >= 10_000 ? 0 : 1;
    return `${symbol}${scaled.toFixed(digits)}${suffix}`;
  }

  return new Intl.NumberFormat(locales[lang], {
    style: 'currency',
    currency,
    maximumFractionDigits: abs < 100 ? 2 : 0,
  }).format(value);
}

export function num(value: number | null | undefined, lang: Lang = 'en', compact = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (compact && Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(locales[lang], { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(locales[lang], { maximumFractionDigits: 0 }).format(value);
}

/*
 * `null` is not zero.
 *
 * The API sends null for a ratio that cannot be computed — CPA with no
 * conversions, ROAS with no attributed revenue — and these render N/A rather
 * than a number nobody measured. An em dash is used inside dense tables where
 * "N/A" would be noise; both mean the same thing and neither means zero.
 */
export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(digits)}%`;
}

export function ratio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value.toFixed(2)}x`;
}

/** Signed change against a baseline; null when there is nothing to compare. */
export function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return current / previous - 1;
}

export function delta(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

export function date(value: string | Date, lang: Lang = 'en'): string {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locales[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(parsed);
}

export function dateTime(value: string | Date, lang: Lang = 'en'): string {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locales[lang], {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(parsed);
}

export function shortDate(value: string | Date, lang: Lang = 'en'): string {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locales[lang], { day: 'numeric', month: 'short' }).format(parsed);
}

export function relative(value: string | Date, lang: Lang = 'en'): string {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((parsed.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locales[lang], { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, 'second');
}

/** `YYYY-MM-DD` for date inputs and API range parameters. */
export const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

export const PLATFORM_LABELS: Record<string, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  SNAPCHAT: 'Snapchat',
  GOOGLE_ADS: 'Google Ads',
  GOOGLE_BUSINESS: 'Google Business',
  X: 'X',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  UPLOAD_POST: 'Upload-Post',
};

/** Brand-recognisable accents for platform chips and chart series. */
export const PLATFORM_COLORS: Record<string, string> = {
  FACEBOOK: '#3b82f6',
  INSTAGRAM: '#e1306c',
  TIKTOK: '#22d3ee',
  SNAPCHAT: '#eab308',
  GOOGLE_ADS: '#34d399',
  GOOGLE_BUSINESS: '#a78bfa',
  X: '#94a3b8',
  LINKEDIN: '#0ea5e9',
  YOUTUBE: '#ef4444',
  // Distinct from every network's accent: it is a route, and reading as one of
  // them on a chip would suggest a post went somewhere it did not.
  UPLOAD_POST: '#f59e0b',
};

export const humanize = (value: string): string =>
  value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
