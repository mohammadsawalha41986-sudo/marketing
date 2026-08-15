/** Locale-aware formatting. Arabic uses Western digits for scannable tables. */

import type { Lang } from './i18n';

const locales: Record<Lang, string> = { en: 'en-US', ar: 'ar-JO-u-nu-latn' };

/*
 * The workspace currency, held at module scope.
 *
 * money() is called from roughly a hundred places, most of them deep inside
 * table cells and chart tooltips. Threading a currency prop through all of them
 * would add a parameter to every one of those call sites to carry a value that
 * is the same everywhere in the application. The AuthProvider sets this once
 * when the workspace loads, which is before any figure is rendered.
 */
let currencyCode = 'SAR';

export function setCurrency(code: string): void {
  if (/^[A-Z]{3}$/.test(code)) currencyCode = code;
}

export function currency(): string {
  return currencyCode;
}

export function money(value: number, lang: Lang = 'en', compact = false): string {
  const abs = Math.abs(value);
  if (compact && abs >= 1000) {
    const unit = abs >= 1_000_000
      ? `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`
      : `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
    return `${currencyCode} ${unit}`;
  }
  return new Intl.NumberFormat(locales[lang], {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: abs < 100 ? 2 : 0,
  }).format(value);
}

export function num(value: number, lang: Lang = 'en', compact = false): string {
  if (compact && Math.abs(value) >= 1000) {
    return new Intl.NumberFormat(locales[lang], { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(locales[lang], { maximumFractionDigits: 0 }).format(value);
}

export function pct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function ratio(value: number): string {
  if (!Number.isFinite(value)) return '—';
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
};

export const humanize = (value: string): string =>
  value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
