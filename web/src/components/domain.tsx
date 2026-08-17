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
import type { ApprovalStatus, CampaignStatus, ContentStatus, Platform } from '../lib/api';

// ---------------------------------------------------------------- status

const CAMPAIGN_TONES: Record<CampaignStatus, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'brand',
  RUNNING: 'ok',
  PAUSED: 'warn',
  COMPLETED: 'accent',
  CANCELLED: 'danger',
};

const CONTENT_TONES: Record<ContentStatus, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'warn',
  APPROVED: 'ok',
  REJECTED: 'danger',
  CHANGES_REQUESTED: 'warn',
  SCHEDULED: 'brand',
  PUBLISHED: 'accent',
  FAILED: 'danger',
};

const APPROVAL_TONES: Record<ApprovalStatus, BadgeTone> = {
  PENDING: 'warn',
  APPROVED: 'ok',
  REJECTED: 'danger',
  CHANGES_REQUESTED: 'warn',
};

const label = (value: string) => value.replace(/_/g, ' ').toLowerCase();

export function StatusBadge({ status, kind }: { status: string; kind: 'campaign' | 'content' | 'approval' }) {
  const tones = kind === 'campaign' ? CAMPAIGN_TONES : kind === 'content' ? CONTENT_TONES : APPROVAL_TONES;
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
  /**
   * `null` means the figure cannot be computed — not that it is zero.
   *
   * The card renders "N/A" and, where the server said why, the reason. This is
   * the whole point: CPA on a campaign with no conversions used to display
   * 0.00, which reads as free conversions rather than none.
   */
  value: number | null;
  /** The server's explanation for a null value, shown under the N/A. */
  unavailableReason?: string;
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
  unavailableReason,
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

  const trend =
    value === null || previous === undefined || previous === null || previous === 0 ? null : value / previous - 1;
  const good = trend === null ? null : invertTrend ? trend < 0 : trend > 0;

  const unavailable = value === null;

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
      {unavailable ? (
        <p className="mt-2 text-2xl font-semibold tracking-tight text-muted sm:text-[26px]" title={unavailableReason}>
          N/A
        </p>
      ) : (
        <p className="mt-2 text-2xl font-semibold tracking-tight text-fg sm:text-[26px]">
          <AnimatedNumber value={value} format={formatter} />
        </p>
      )}
      {unavailable && unavailableReason ? (
        <p className="mt-1 text-[12px] leading-snug text-muted">{unavailableReason}</p>
      ) : trend !== null ? (
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

/*
 * The platform preview that used to live here is now ContentPreview, in
 * content-preview.tsx — one component for every surface that shows a post,
 * rather than a second copy per page.
 */

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
