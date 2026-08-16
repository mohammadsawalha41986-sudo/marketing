/**
 * The executive view: what a CEO needs to know about marketing in two minutes.
 *
 * The design constraint that shapes this whole page is that **a missing figure
 * must not look like a bad one**. The API returns every derived number as
 * `{ available, value, reason }`, and `<Figure>` renders the unavailable case as
 * a muted "No data" with the reason on hover — never as 0, never as a dash that
 * could be read as zero, and never in the red that a genuinely bad number gets.
 * A CEO who cannot tell "we made no profit" from "nobody connected the till"
 * will make the wrong decision, confidently.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle, ArrowRight, CircleAlert, CircleDollarSign, Gauge, Info,
  Lightbulb, Receipt, Target, TrendingUp, Wallet,
} from 'lucide-react';

import { qs } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { money, num, pct, ratio } from '../lib/format';
import { Badge, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader, Select } from '../components/ui';

// ---------------------------------------------------------------- types

/** Mirrors the server's `Figure`: a value, or the reason there isn't one. */
interface Figure {
  available: boolean;
  value: number | null;
  reason?: string;
}

interface Aggregate {
  figure: Figure;
  contributing: number;
  total: number;
}

type HealthBand =
  | 'EXCELLENT' | 'HEALTHY' | 'NEEDS_ATTENTION' | 'AT_RISK' | 'CRITICAL' | 'INSUFFICIENT_DATA';

interface HealthScore {
  score: number | null;
  band: HealthBand;
  coverage: number;
  components: Array<{ key: string; label: string; weight: number; score: number | null; detail: string; outcome: boolean }>;
  explanation: string;
}

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface AttentionItem {
  severity: Severity;
  kind: string;
  title: string;
  detail: string;
  campaignId?: string;
  link?: string;
}

interface BudgetHealth {
  budget: number;
  utilization: Figure;
  status: 'UNDER_BUDGET' | 'ON_TRACK' | 'AT_RISK' | 'OVER_BUDGET' | 'NO_DATA';
  explanation: string;
}

interface Recommendation {
  action: string;
  priority: Severity;
  reason: string;
  evidence: string[];
  suggestedAction: string;
}

interface CeoData {
  range: { from: string; to: string };
  overview: {
    currency: string;
    campaigns: { total: number; active: number };
    marketingSpend: Aggregate;
    attributedRevenue: Aggregate;
    grossProfit: Aggregate;
    contributionProfit: Aggregate;
    conversions: Aggregate;
    roas: Figure;
    roi: Figure;
    cpa: Figure;
    budgetUtilization: Figure;
    health: HealthScore;
    attention: AttentionItem[];
  };
  brief: string[];
  campaigns: Array<{
    id: string;
    name: string;
    clientName: string;
    status: string;
    health: HealthScore;
    recommendation: Recommendation;
    finance: {
      currency: string;
      adSpend: Figure;
      attributedRevenue: Figure;
      contributionProfit: Figure;
      roas: Figure;
      roi: Figure;
      cpa: Figure;
      budget: BudgetHealth;
    };
  }>;
}

// ------------------------------------------------------------- presentation

const BAND_TONE: Record<HealthBand, { label: string; className: string; ring: string }> = {
  EXCELLENT: { label: 'Excellent', className: 'text-emerald-400', ring: 'stroke-emerald-400' },
  HEALTHY: { label: 'Healthy', className: 'text-emerald-400', ring: 'stroke-emerald-400' },
  NEEDS_ATTENTION: { label: 'Needs attention', className: 'text-amber-400', ring: 'stroke-amber-400' },
  AT_RISK: { label: 'At risk', className: 'text-orange-400', ring: 'stroke-orange-400' },
  CRITICAL: { label: 'Critical', className: 'text-rose-400', ring: 'stroke-rose-400' },
  INSUFFICIENT_DATA: { label: 'Insufficient data', className: 'text-muted', ring: 'stroke-muted' },
};

const SEVERITY_TONE: Record<Severity, { badge: 'danger' | 'warn' | 'brand' | 'neutral'; icon: typeof CircleAlert }> = {
  CRITICAL: { badge: 'danger', icon: CircleAlert },
  HIGH: { badge: 'warn', icon: AlertTriangle },
  MEDIUM: { badge: 'brand', icon: Info },
  LOW: { badge: 'neutral', icon: Info },
};

/**
 * Renders a figure, or says plainly that there isn't one.
 *
 * `reason` goes on the title attribute so the "why" is one hover away without
 * spending layout on it — the CEO view has to stay skimmable.
 */
function FigureValue({
  figure,
  format,
  className,
}: {
  figure: Figure | undefined;
  format: (value: number) => string;
  className?: string;
}) {
  if (!figure || !figure.available || figure.value === null) {
    return (
      <span className="text-muted/70 text-[0.6em] font-medium uppercase tracking-wide" title={figure?.reason ?? 'No data'}>
        No data
      </span>
    );
  }
  return <span className={className}>{format(figure.value)}</span>;
}

function KpiTile({
  icon: Icon,
  label,
  figure,
  format,
  coverage,
  tone,
}: {
  icon: typeof Wallet;
  label: string;
  figure: Figure;
  format: (value: number) => string;
  coverage?: Aggregate;
  tone?: 'good' | 'bad';
}) {
  const negative = figure.available && figure.value !== null && figure.value < 0;
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          negative || tone === 'bad' ? 'text-rose-400' : tone === 'good' ? 'text-emerald-400' : ''
        }`}
      >
        <FigureValue figure={figure} format={format} />
      </div>
      {coverage && coverage.contributing < coverage.total ? (
        <p className="mt-1 text-[11px] text-muted">
          From {coverage.contributing} of {coverage.total} campaigns
        </p>
      ) : null}
    </Card>
  );
}

/** The health dial. Shows an empty ring, not a zero, when there is no score. */
function HealthDial({ health }: { health: HealthScore }) {
  const tone = BAND_TONE[health.band];
  const score = health.score;
  const circumference = 2 * Math.PI * 52;
  const dash = score === null ? 0 : (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-6">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
          <circle cx="60" cy="60" r="52" fill="none" strokeWidth="10" className="stroke-line" />
          {score !== null ? (
            <motion.circle
              cx="60" cy="60" r="52" fill="none" strokeWidth="10" strokeLinecap="round"
              className={tone.ring}
              initial={{ strokeDasharray: `0 ${circumference}` }}
              animate={{ strokeDasharray: `${dash} ${circumference}` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          {score === null ? (
            <span className="px-2 text-[10px] font-medium uppercase tracking-wide text-muted">No score</span>
          ) : (
            <div>
              <div className="text-3xl font-semibold tabular-nums">{score}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted">/ 100</div>
            </div>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1 text-center sm:text-start">
        <div className={`text-lg font-semibold ${tone.className}`}>{tone.label}</div>
        <p className="mt-1 text-sm text-muted">{health.explanation}</p>
        <p className="mt-2 text-[11px] text-muted">
          Outcome checks measurable: {Math.round(health.coverage * 100)}%
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page

const RANGES = [
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
];

export function CeoPage({ portal = false }: { portal?: boolean } = {}) {
  const { lang } = useI18n();
  const [days, setDays] = useState('30');

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (Number(days) - 1) * 86400000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [days]);

  const { data, loading, error, refetch } = useQuery<CeoData>(`/ceo/overview${qs(range)}`, [range.from, range.to]);

  const base = portal ? '/client' : '/app';
  const fmtMoney = (currency: string) => (value: number) => `${money(value, lang, true)} ${currency}`;

  if (error) return <ErrorState message={error} onRetry={refetch} />;

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Executive view" subtitle="Marketing, as the business sees it" />
        <CardSkeleton rows={4} />
      </div>
    );
  }
  if (!data) return null;

  const { overview, brief, campaigns } = data;
  const currency = overview.currency;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Executive view"
        subtitle={`${overview.campaigns.total} campaign${overview.campaigns.total === 1 ? '' : 's'}, ${overview.campaigns.active} running · ${data.range.from} → ${data.range.to}`}
        action={
          <Select value={days} onChange={(event) => setDays(event.target.value)} aria-label="Date range">
            {RANGES.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </Select>
        }
      />

      {overview.campaigns.total === 0 ? (
        <EmptyState
          icon={Gauge}
          title="No campaigns yet"
          body="Create a campaign and the executive view will fill in as results arrive."
        />
      ) : (
        <>
          {/* Health + brief */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Card>
              <CardHeader title="Marketing health" icon={Gauge} />
              <div className="p-5">
                <HealthDial health={overview.health} />
                {overview.health.components.length > 0 ? (
                  <ul className="mt-5 space-y-2">
                    {overview.health.components.map((component) => (
                      <li key={component.key} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-muted">{component.label}</span>
                        <span className="tabular-nums">
                          {component.score === null ? (
                            <span className="text-[11px] uppercase tracking-wide text-muted/70" title={component.detail}>
                              No data
                            </span>
                          ) : (
                            `${component.score}/100`
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Card>

            <Card>
              <CardHeader title="Executive brief" icon={Lightbulb} />
              <div className="p-5">
                <ul className="space-y-3">
                  {brief.map((line, index) => (
                    <li key={index} className="flex gap-2.5 text-sm leading-relaxed">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">
                  Written from recorded figures only. Anything that cannot be calculated is named rather than estimated.
                </p>
              </div>
            </Card>
          </div>

          {/* Money */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile icon={Wallet} label="Marketing spend" figure={overview.marketingSpend.figure} format={fmtMoney(currency)} coverage={overview.marketingSpend} />
            <KpiTile icon={TrendingUp} label="Attributed revenue" figure={overview.attributedRevenue.figure} format={fmtMoney(currency)} coverage={overview.attributedRevenue} />
            <KpiTile icon={CircleDollarSign} label="Gross profit" figure={overview.grossProfit.figure} format={fmtMoney(currency)} coverage={overview.grossProfit} />
            <KpiTile icon={Receipt} label="Contribution profit" figure={overview.contributionProfit.figure} format={fmtMoney(currency)} coverage={overview.contributionProfit} />
            <KpiTile icon={Target} label="ROAS" figure={overview.roas} format={(value) => ratio(value)} />
            <KpiTile icon={Target} label="ROI" figure={overview.roi} format={(value) => pct(value, 0)} />
            <KpiTile icon={Target} label="Cost per acquisition" figure={overview.cpa} format={fmtMoney(currency)} />
            <KpiTile icon={Gauge} label="Budget utilisation" figure={overview.budgetUtilization} format={(value) => pct(value, 0)} />
          </div>

          {/* Attention */}
          <Card>
            <CardHeader
              title="Needs your attention"
              icon={AlertTriangle}
              action={<Badge tone="neutral">{overview.attention.length}</Badge>}
            />
            {overview.attention.length === 0 ? (
              <p className="p-5 text-sm text-muted">Nothing is flagged right now.</p>
            ) : (
              <ul className="space-y-2 p-5">
                {overview.attention.map((item, index) => {
                  const tone = SEVERITY_TONE[item.severity];
                  const Icon = tone.icon;
                  const body = (
                    <div className="flex items-start gap-3 rounded-xl border border-line bg-elevated p-3 transition hover:border-brand/30">
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{item.title}</span>
                          <Badge tone={tone.badge}>{item.severity}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted">{item.detail}</p>
                      </div>
                      {item.link ? <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted" /> : null}
                    </div>
                  );
                  return (
                    <li key={`${item.kind}-${index}`}>
                      {item.link ? <Link to={item.link.replace('/app', base)}>{body}</Link> : body}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* Per campaign */}
          <Card>
            <CardHeader title="Campaigns" icon={Target} />
            <div className="space-y-2 p-5">
              {campaigns.map((campaign) => {
                const tone = BAND_TONE[campaign.health.band];
                return (
                  <Link
                    key={campaign.id}
                    to={`${base}/campaigns/${campaign.id}`}
                    className="block rounded-xl border border-line bg-elevated p-3 transition hover:border-brand/30"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{campaign.name}</div>
                        <div className="text-[11px] text-muted">{campaign.clientName}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone="neutral">{campaign.recommendation.action}</Badge>
                        <span className={`text-sm font-semibold tabular-nums ${tone.className}`}>
                          {campaign.health.score === null ? tone.label : `${campaign.health.score}/100`}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted">Spend</div>
                        <div className="tabular-nums">
                          <FigureValue figure={campaign.finance.adSpend} format={fmtMoney(campaign.finance.currency)} />
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted">ROAS</div>
                        <div className="tabular-nums">
                          <FigureValue figure={campaign.finance.roas} format={ratio} />
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted">CPA</div>
                        <div className="tabular-nums">
                          <FigureValue figure={campaign.finance.cpa} format={fmtMoney(campaign.finance.currency)} />
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted">Budget</div>
                        <div className="tabular-nums">
                          <FigureValue figure={campaign.finance.budget.utilization} format={(value) => pct(value, 0)} />
                        </div>
                      </div>
                    </div>

                    <p className="mt-3 border-t border-line pt-2 text-[12px] text-muted">
                      {campaign.recommendation.reason} {campaign.recommendation.suggestedAction}
                    </p>
                  </Link>
                );
              })}
            </div>
          </Card>

          <p className="pb-2 text-center text-[11px] text-muted">
            {num(overview.conversions.figure.value ?? 0, lang)} conversions recorded across{' '}
            {overview.conversions.contributing} of {overview.conversions.total} campaigns.
          </p>
        </>
      )}
    </div>
  );
}

export default CeoPage;
