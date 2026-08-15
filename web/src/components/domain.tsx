/** Marketing-specific building blocks shared across pages. */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useInView } from 'framer-motion';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, Info, Sparkles, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import { Badge, Card, type BadgeTone } from './ui';
import { cn } from '../lib/utils';
import { useI18n } from '../lib/i18n';
import { delta, money, num, PLATFORM_COLORS, PLATFORM_LABELS, pct, ratio } from '../lib/format';
import type { AdStatus, CampaignStatus, ContentStatus, RestaurantStatus, Platform } from '../lib/api';

// ---------------------------------------------------------------- status

/*
 * Campaign, ad and restaurant statuses share a badge because they share a
 * lifecycle shape — planning, running, paused, finished — and giving each its
 * own map would be three copies of the same colours.
 */
const CAMPAIGN_TONES: Record<CampaignStatus | AdStatus | RestaurantStatus, BadgeTone> = {
  PLANNING: 'neutral',
  DRAFT: 'neutral',
  ACTIVE: 'ok',
  PAUSED: 'warn',
  COMPLETED: 'accent',
  ARCHIVED: 'neutral',
};

const CONTENT_TONES: Record<ContentStatus, BadgeTone> = {
  IDEA: 'neutral',
  DRAFT: 'neutral',
  READY: 'warn',
  SCHEDULED: 'brand',
  PUBLISHED: 'accent',
  ARCHIVED: 'neutral',
};

const label = (value: string) => value.replace(/_/g, ' ').toLowerCase();

export function StatusBadge({ status, kind }: { status: string; kind: 'campaign' | 'content' }) {
  const tones = kind === 'campaign' ? CAMPAIGN_TONES : CONTENT_TONES;
  const tone = (tones as Record<string, BadgeTone>)[status] ?? 'neutral';
  return <Badge tone={tone} dot>{label(status)}</Badge>;
}

export function PlatformChip({ platform, size = 'md' }: { platform: Platform | string; size?: 'sm' | 'md' }) {
  const color = PLATFORM_COLORS[platform] ?? '#94a3b8';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
      )}
      style={{ borderColor: `${color}44`, background: `${color}18`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {PLATFORM_LABELS[platform] ?? platform}
    </span>
  );
}

// ---------------------------------------------------------------- kpi

/** Counts up when it scrolls into view. Respects reduced-motion via CSS. */
function AnimatedNumber({ value, format }: { value: number; format: (value: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const duration = 750;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // Ease-out cubic: fast start, gentle settle.
      setDisplay(value * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, value]);

  // dir="ltr" keeps currency symbols and signs on the correct side under RTL.
  return <span ref={ref} dir="ltr" className="tabular inline-block">{format(display)}</span>;
}

export interface KpiCardProps {
  label: string;
  value: number;
  format?: 'money' | 'number' | 'percent' | 'ratio';
  previous?: number | null;
  icon?: LucideIcon;
  accent?: string;
  compact?: boolean;
  footer?: ReactNode;
  /** Higher is better for most measures, but not for cost per click. */
  invertTrend?: boolean;
}

export function KpiCard({
  label: title, value, format = 'number', previous, icon: Icon, accent, compact, footer, invertTrend,
}: KpiCardProps) {
  const { lang } = useI18n();

  const formatter = (input: number) => {
    switch (format) {
      case 'money':
        return money(input, lang, compact);
      case 'percent':
        return pct(input);
      case 'ratio':
        return ratio(input);
      default:
        return num(input, lang, compact);
    }
  };

  const trend = previous === undefined || previous === null || previous === 0 ? null : value / previous - 1;
  const good = trend === null ? null : invertTrend ? trend < 0 : trend > 0;

  return (
    <Card className="relative overflow-hidden p-4 sm:p-5" hover>
      {accent ? (
        <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: accent }} />
      ) : null}
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted">{title}</p>
        {Icon ? (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-fg sm:text-[26px]">
        <AnimatedNumber value={value} format={formatter} />
      </p>
      {trend !== null ? (
        <p className={cn('mt-1 flex items-center gap-1 text-[13px]', good ? 'text-ok' : 'text-danger')}>
          {good ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          <span dir="ltr" className="tabular inline-block">{delta(trend)}</span>
        </p>
      ) : footer ? (
        <div className="mt-1 text-[13px] text-muted">{footer}</div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- AI

export function AiBadge({ isFallback }: { isFallback: boolean }) {
  return (
    <Badge tone={isFallback ? 'neutral' : 'brand'}>
      <Sparkles className="h-3 w-3" />
      {isFallback ? 'Built-in engine' : 'AI'}
    </Badge>
  );
}

export function AiNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-[13px] text-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{notice}</span>
    </div>
  );
}

export interface Recommendation {
  title: string;
  detail: string;
  impact: 'high' | 'medium' | 'low';
  area: string;
}

export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const { t } = useI18n();
  const tone: BadgeTone =
    recommendation.impact === 'high' ? 'danger' : recommendation.impact === 'medium' ? 'warn' : 'neutral';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-line bg-surface p-4 ps-5 [border-inline-start:3px_solid_rgb(var(--c-brand))]"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-brand">{t('ai.recommendation')}</span>
        <Badge tone={tone}>{recommendation.impact} impact</Badge>
        <Badge>{recommendation.area}</Badge>
      </div>
      <p className="font-medium text-fg">{recommendation.title}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{recommendation.detail}</p>
    </motion.div>
  );
}

export interface Alert {
  level: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  link?: string;
}

export function AlertRow({ alert, onNavigate }: { alert: Alert; onNavigate?: (link: string) => void }) {
  const icons = { info: Info, warning: TriangleAlert, critical: AlertTriangle };
  const tones = {
    info: 'text-brand bg-brand/10',
    warning: 'text-warn bg-warn/10',
    critical: 'text-danger bg-danger/10',
  };
  const Icon = icons[alert.level];

  return (
    <button
      type="button"
      onClick={() => alert.link && onNavigate?.(alert.link)}
      disabled={!alert.link}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl border border-line p-3.5 text-start transition-colors',
        alert.link ? 'hover:border-brand/30 hover:bg-elevated' : 'cursor-default',
      )}
    >
      <span className={cn('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg', tones[alert.level])}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{alert.title}</span>
        <span className="mt-0.5 block text-[13px] text-muted">{alert.body}</span>
      </span>
    </button>
  );
}

export function AiEmptyHint({ onRun, loading }: { onRun: () => void; loading: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand/10 text-brand">
        <Bot className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-fg">{t('ai.analyst')}</p>
        <p className="mt-1 max-w-sm text-[13px] text-muted">{t('ai.disclaimer')}</p>
      </div>
      <button
        onClick={onRun}
        disabled={loading}
        className="mt-1 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60"
      >
        {loading ? t('ai.analyzing') : t('ai.analyze')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- previews

/**
 * Platform preview. An approximation of each surface's chrome — enough to judge
 * whether copy fits and reads, not a pixel-accurate clone.
 */
export function PlatformPreview({
  platform, brandName, logoUrl, headline, caption, cta, hashtags, mediaUrl,
}: {
  platform: Platform;
  brandName: string;
  logoUrl?: string | null;
  headline?: string | null;
  caption?: string | null;
  cta?: string | null;
  hashtags?: string[];
  mediaUrl?: string | null;
}) {
  const color = PLATFORM_COLORS[platform] ?? '#94a3b8';
  const isGoogle = platform === 'GOOGLE_ADS';
  const tags = (hashtags ?? []).slice(0, 6).join(' ');

  if (isGoogle) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          <span className="rounded border border-line px-1 font-semibold">Ad</span>
          <span className="truncate">{brandName.toLowerCase().replace(/\s+/g, '')}.com</span>
        </div>
        <p className="text-[17px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">
          {headline || 'Your headline appears here'}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          {caption || 'Your description text appears here, up to about 90 characters.'}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-8 w-8 rounded-full object-cover ring-1 ring-line" />
        ) : (
          <span className="h-8 w-8 rounded-full" style={{ background: `linear-gradient(135deg, ${color}, ${color}66)` }} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-fg">{brandName}</p>
          <p className="text-[11px] text-muted">Sponsored</p>
        </div>
        <span className="text-lg leading-none text-muted">···</span>
      </div>

      <div
        className="relative grid aspect-square w-full place-items-center overflow-hidden"
        style={{ background: `linear-gradient(135deg, ${color}22, ${color}08)` }}
      >
        {mediaUrl ? (
          <img src={mediaUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <p className="px-6 text-center text-[13px] text-muted">Attach media to preview the creative</p>
        )}
        {platform === 'TIKTOK' || platform === 'SNAPCHAT' ? (
          <span className="absolute bottom-3 start-3 max-w-[75%] text-[13px] font-medium text-white drop-shadow">
            {headline}
          </span>
        ) : null}
      </div>

      {cta ? (
        <div className="flex items-center justify-between border-y border-line px-3.5 py-2.5">
          <span className="text-[13px] text-muted">Learn more</span>
          <span className="rounded-md px-2.5 py-1 text-[12px] font-semibold text-white" style={{ background: color }}>
            {cta}
          </span>
        </div>
      ) : null}

      <div className="px-3.5 py-3">
        {headline ? <p className="text-[13px] font-semibold text-fg">{headline}</p> : null}
        {caption ? (
          <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-fg/90 line-clamp-5">{caption}</p>
        ) : null}
        {tags ? <p className="mt-1.5 break-words text-[13px] text-brand">{tags}</p> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- colour swatch

export function Swatch({
  color, label: name, onChange, readOnly,
}: { color: string; label: string; onChange?: (value: string) => void; readOnly?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-elevated p-2.5">
      <label className="relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-lg ring-1 ring-line">
        <span className="absolute inset-0" style={{ background: color }} />
        {!readOnly && onChange ? (
          <input
            type="color"
            value={color}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label={name}
          />
        ) : null}
      </label>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-fg">{name}</p>
        <p className="tabular text-[12px] uppercase text-muted">{color}</p>
      </div>
    </div>
  );
}
