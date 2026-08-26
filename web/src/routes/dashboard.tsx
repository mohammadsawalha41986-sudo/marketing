/**
 * The dashboard. Same data for agency and client portal, one hierarchy.
 *
 * The order is the argument: **Today**, then **Performance**, then the
 * **Calendar**, then **AI recommendations**, then **Activity**. Opening the day
 * on spend answers a question nobody has at 9am. What is going out, what is
 * stuck and what broke overnight is the work; the money is how last month went.
 *
 * Performance is three tabs rather than one merged number, and the split is
 * deliberate. An organic engagement and a paid click are different
 * measurements, taken by different APIs, with different meanings — so Combined
 * shows them beside each other and says in as many words that they are never
 * added together. Adding them would produce a bigger, more impressive figure
 * that describes nothing.
 *
 * Every paid figure is a `QualifiedMetric` drawn by the shared renderer, so an
 * unfetched number reads NOT_FETCHED here exactly as it does on the advertising
 * dashboard. Phase 14 does the computing; this page only asks and lays out.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity, Bell, Building2, CalendarClock, CalendarDays, Eye, Megaphone,
  ShieldCheck, Sparkles, Store, ThumbsUp, TrendingUp, TriangleAlert,
} from 'lucide-react';

import { qs, type Metrics, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { isoDate, money, num, pct, ratio, relative, humanize } from '../lib/format';
import { cn } from '../lib/utils';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader,
  Select, Tabs,
} from '../components/ui';
import {
  AlertRow, KpiCard, MetricValue, PlatformChip, StatusBadge,
  type Alert, type QualifiedMetric,
} from '../components/domain';
import { DonutChart, TrendChart } from '../components/charts';
import { MarketingCalendar } from '../components/marketing-calendar';
import { CreateFlow } from '../components/create-flow';

interface DashboardData {
  range: { from: string; to: string };
  kpis: Metrics & { clients: number; activeCampaigns: number; scheduled: number; pendingApprovals: number };
  previous: Metrics;
  series: Array<{ date: string } & Metrics>;
  platforms: Array<{ platform: Platform; label: string; spend: number; conversions: number; roas: number; clicks: number }>;
  campaignsByStatus: Record<string, number>;
  alerts: Alert[];
  recentActivity: Array<{ id: string; action: string; entity: string; user: string; createdAt: string }>;
}

interface PulseResponse {
  counts: {
    scheduled: number;
    publishing: number;
    published: number;
    needsAttention: number;
    attention: { failedPosts: number; failedAds: number; brokenConnections: number };
  };
}

interface SocialOverview {
  totalPosts: number;
  publishedPosts: number;
  platforms: Array<{
    platform: Platform;
    label: string;
    publishedCount: number;
    totalEngagements: number;
    totalReach: number;
    totalImpressions: number;
  }>;
  periodTotals: {
    likes: number; comments: number; shares: number; saves: number;
    reach: number; impressions: number; engagements: number; clicks: number;
  };
}

interface StoredRecommendation {
  id: string;
  title: string;
  reason: string;
  priority: string;
  platform: string | null;
  expectedImpact: string | null;
}

const RANGE_KEYS = [
  { value: 7, key: 'dash.range7' },
  { value: 30, key: 'dash.range30' },
  { value: 90, key: 'dash.range90' },
] as const;

type PerfTab = 'organic' | 'paid' | 'combined';

/** One "today" counter. The needs-attention tile names its parts rather than
 *  leaving an operator to guess what the number is made of. */
function PulseTile({
  label, value, icon: Icon, tone = 'neutral', detail, to,
}: {
  label: string; value: number; icon: typeof Activity;
  tone?: 'neutral' | 'danger'; detail?: string | null; to?: string;
}) {
  const { lang } = useI18n();
  const alarming = tone === 'danger' && value > 0;

  const body = (
    <Card className={cn('h-full p-3.5', to && 'transition-colors hover:border-brand/40')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium text-muted">{label}</p>
        <Icon className={cn('h-4 w-4 shrink-0', alarming ? 'text-danger' : 'text-muted')} aria-hidden />
      </div>
      <p className={cn('mt-1 text-[26px] font-semibold tabular leading-none', alarming ? 'text-danger' : 'text-fg')}>
        {num(value, lang)}
      </p>
      {detail ? <p className="mt-1.5 text-[11px] leading-snug text-muted" dir="auto">{detail}</p> : null}
    </Card>
  );

  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

/** One organic total. Organic figures are counts of things that happened, so a
 *  zero here is a measured zero — Phase 14 already excluded the unfetched. */
function OrganicTile({ label, value }: { label: string; value: number }) {
  const { lang } = useI18n();
  return (
    <Card className="p-3.5">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular leading-none text-fg">{num(value, lang, true)}</p>
    </Card>
  );
}

function PaidTile({ metric, label }: { metric: QualifiedMetric | undefined; label: string }) {
  if (!metric) return null;
  return (
    <Card className="p-3.5">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular leading-none text-fg">
        <MetricValue metric={metric} />
      </p>
    </Card>
  );
}

export function DashboardPage({ portal = false }: { portal?: boolean }) {
  const { user, isAgency } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [perf, setPerf] = useState<PerfTab>('combined');
  const [creating, setCreating] = useState(false);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    return { from: isoDate(from), to: isoDate(to) };
  }, [days]);

  // Home answers "how are things going" for whatever the top bar is pointed at:
  // one project, or all of them. Every endpoint below already scopes by client,
  // so this is the same data narrowed, not a different number.
  const { current, currentId } = useRestaurant();
  const clientId = portal ? '' : currentId;

  /* The operator's own day. The server refuses to guess a timezone. */
  const dayWindow = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const { data, loading, error, refetch } = useQuery<DashboardData>(
    `/analytics/dashboard${qs({ ...range, clientId })}`,
    [range.from, range.to, clientId],
  );
  const pulse = useQuery<PulseResponse>(
    `/marketing/pulse${qs({ clientId, ...dayWindow })}`,
    [clientId, dayWindow.from],
  );
  /* Only the tab that is open is fetched. Nothing is loaded to be discarded. */
  const organic = useQuery<SocialOverview>(
    perf === 'paid' ? null : `/social/analytics/overview${qs({ ...range, clientId })}`,
    [range.from, range.to, clientId, perf === 'paid'],
  );
  const recommendations = useQuery<{ items: StoredRecommendation[] }>(
    isAgency ? `/advertising/ai/recommendations${qs({ clientId, pageSize: 3 })}` : null,
    [clientId, isAgency],
  );

  const greeting = user?.name.split(' ')[0] ?? '';
  const base = portal ? '/client' : '/app';

  if (error) {
    return (
      <>
        <PageHeader title={t('nav.dashboard')} />
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      </>
    );
  }

  const kpis = data?.kpis;
  const previous = data?.previous;
  const counts = pulse.data?.counts;

  const attentionDetail = counts && counts.needsAttention > 0
    ? [
      counts.attention.failedPosts > 0 ? `${num(counts.attention.failedPosts, lang)} ${t('ws.attention.posts')}` : null,
      counts.attention.failedAds > 0 ? `${num(counts.attention.failedAds, lang)} ${t('ws.attention.ads')}` : null,
      counts.attention.brokenConnections > 0 ? `${num(counts.attention.brokenConnections, lang)} ${t('ws.attention.connections')}` : null,
    ].filter(Boolean).join(' · ')
    : counts ? t('ws.attention.none') : null;

  /*
   * Paid figures come from the same Phase 14 aggregate that draws the chart and
   * the donut below them, and this was found by looking at the rendered page.
   *
   * They were read from `/advertising/overview` — the Advertising Command
   * Center's per-publication view — which answered NOT_FETCHED for every metric
   * because this deployment has no `AdPublication` rows, while the chart three
   * inches lower drew SAR 65,934 of measured campaign spend from
   * `AnalyticsSnapshot`. Both were telling the truth about different things,
   * and the screen contradicted itself.
   *
   * Phase 14 is the single source of truth for analytics (§35), so the tiles
   * read it. A ratio it could not compute arrives as null with a reason, which
   * is Phase 14's own way of refusing to print a number it does not have — the
   * same discipline as the four states, expressed in the shape this endpoint
   * returns. Dropping the second call also removes a duplicate request. §45.
   */
  const paidMetric = (
    name: string, value: number | null | undefined, reason?: string,
  ): QualifiedMetric => (
    typeof value === 'number'
      ? { metric: name, value, state: 'ZERO', note: null }
      : { metric: name, value: null, state: 'UNAVAILABLE', note: reason ?? null }
  );

  return (
    <>
      {/* PROJECT HEADER — project, date range, create. §40. */}
      <PageHeader
        title={
          portal
            ? user?.client?.businessName ?? t('nav.home')
            : current
              ? current.businessName
              : `${t('dash.greeting')}, ${greeting}`
        }
        subtitle={
          data
            ? `${!portal && !current ? `${t('dash.allRestaurants')} · ` : ''}${data.range.from} → ${data.range.to} · ${t('common.vsPrevious')}`
            : t('common.loading')
        }
        action={
          <>
            <Select value={days} onChange={(event) => setDays(Number(event.target.value))} className="w-40">
              {RANGE_KEYS.map((option) => (
                <option key={option.value} value={option.value}>{t(option.key)}</option>
              ))}
            </Select>
            {isAgency ? (
              <Button onClick={() => setCreating(true)} icon={Sparkles}>{t('create.button')}</Button>
            ) : null}
          </>
        }
      >
        {/* §1/§38 — the project, and its business type where it declares one.
            The type is a property of the project, never the global noun for
            it: "Business type: Restaurant", not a product full of restaurants. */}
        {current?.businessType ? (
          <p className="mt-1 text-[12px] text-muted" dir="auto">
            {t('common.businessType')}: {current.businessType}
          </p>
        ) : null}
      </PageHeader>

      {isAgency ? <CreateFlow open={creating} onClose={() => setCreating(false)} /> : null}

      {/* TODAY */}
      <section className="mb-6">
        <p className="mb-2 text-[13px] font-medium text-muted">{t('dash.todayHeading')}</p>
        {pulse.loading || !counts ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <PulseTile
              label={t('ws.scheduled')}
              value={counts.scheduled}
              icon={CalendarDays}
              to={portal ? undefined : '/app/marketing/calendar'}
            />
            <PulseTile label={t('ws.publishing')} value={counts.publishing} icon={Activity} />
            <PulseTile label={t('ws.published')} value={counts.published} icon={ShieldCheck} />
            <PulseTile
              label={t('ws.needsAttention')}
              value={counts.needsAttention}
              icon={TriangleAlert}
              tone="danger"
              detail={attentionDetail}
              to={portal ? undefined : '/app/library'}
            />
          </div>
        )}
      </section>

      {/* PERFORMANCE */}
      <section className="mb-6">
        <p className="mb-2 text-[13px] font-medium text-muted">{t('dash.performanceHeading')}</p>
        <Tabs
          tabs={[
            { value: 'organic' as const, label: t('dash.perf.organic') },
            { value: 'paid' as const, label: t('dash.perf.paid') },
            { value: 'combined' as const, label: t('dash.perf.combined') },
          ]}
          value={perf}
          onChange={setPerf}
          className="mb-3"
        />

        <p className="mb-3 text-[12px] leading-relaxed text-muted">
          {perf === 'organic' ? t('dash.organicNote')
            : perf === 'paid' ? t('dash.paidNote')
              : t('dash.combinedNote')}
        </p>

        {perf !== 'paid' ? (
          organic.loading ? (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)}
            </div>
          ) : organic.data ? (
            <div className="mb-4">
              {perf === 'combined' ? (
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                  {t('dash.perf.organic')}
                </p>
              ) : null}
              {/*
                * How many published posts these totals are drawn from.
                *
                * Without it, a row of zeros is ambiguous in exactly the way
                * that matters: nothing was published, or things were published
                * and no platform has reported on them yet. Phase 14 sums only
                * measured figures, so both produce the same zeros, and the
                * count is the only thing on screen that separates them.
                */}
              <p className="mb-2 text-[12px] text-muted">
                {t('dash.organicBasis')
                  .replace('{count}', num(organic.data.publishedPosts, lang))}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                <OrganicTile label={t('kpi.reach')} value={organic.data.periodTotals.reach} />
                <OrganicTile label={t('kpi.impressions')} value={organic.data.periodTotals.impressions} />
                <OrganicTile label={t('report.metric.engagements')} value={organic.data.periodTotals.engagements} />
                <OrganicTile label={t('kpi.clicks')} value={organic.data.periodTotals.clicks} />
              </div>
            </div>
          ) : null
        ) : null}

        {perf !== 'organic' ? (
          loading || !kpis ? (
            <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)}
            </div>
          ) : (
            <div className="mb-4">
              {perf === 'combined' ? (
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                  {t('dash.perf.paid')}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
                <PaidTile metric={paidMetric('spend', kpis.spend)} label={t('kpi.spend')} />
                <PaidTile metric={paidMetric('impressions', kpis.impressions)} label={t('kpi.impressions')} />
                <PaidTile metric={paidMetric('clicks', kpis.clicks)} label={t('kpi.clicks')} />
                <PaidTile metric={paidMetric('ctr', kpis.ctr, kpis.reasons?.ctr)} label={t('kpi.ctr')} />
              </div>
            </div>
          )
        ) : null}

        {/* The financial trend, which is a paid series. Hidden on the organic
            tab because putting spend under an organic heading is the same
            category error the tabs exist to prevent. */}
        {perf !== 'organic' ? (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title={t('dash.performance')}
                subtitle={data ? `${t('kpi.ctr')} ${pct(data.kpis.ctr)} · ${t('kpi.cpc')} ${money(data.kpis.cpc, lang)} · ${t('kpi.roas')} ${ratio(data.kpis.roas)}` : undefined}
                icon={Activity}
              />
              <div className="p-3 sm:p-4">
                {loading ? (
                  <div className="skeleton h-[260px]" />
                ) : data && data.series.some((point) => point.spend > 0) ? (
                  <TrendChart
                    data={data.series}
                    keys={[
                      { key: 'spend', label: t('kpi.spend') },
                      { key: 'revenue', label: t('kpi.revenue') },
                    ]}
                    currency
                  />
                ) : (
                  <p className="py-16 text-center text-sm text-muted">{t('common.noData')}</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title={t('dash.spendByPlatform')} icon={TrendingUp} />
              <div className="p-4">
                {loading ? (
                  <div className="skeleton h-[240px]" />
                ) : data && data.platforms.length > 0 ? (
                  <>
                    <DonutChart data={data.platforms.map((row) => ({ label: row.label, value: row.spend, platform: row.platform }))} />
                    <div className="mt-3 space-y-1.5">
                      {data.platforms.slice(0, 4).map((row) => (
                        <div key={row.platform} className="flex items-center justify-between gap-2 text-[13px]">
                          <PlatformChip platform={row.platform} size="sm" />
                          <span className="tabular text-muted">
                            {money(row.spend, lang, true)} · {ratio(row.roas)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="py-16 text-center text-sm text-muted">{t('common.noData')}</p>
                )}
              </div>
            </Card>
          </div>
        ) : null}

        {/* The pipeline counters, which are neither organic nor paid delivery. */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {loading || !kpis ? (
            Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
          ) : (
            <>
              {portal ? (
                <KpiCard label={t('kpi.impressions')} value={kpis.impressions} icon={Eye} compact previous={previous?.impressions} />
              ) : current ? (
                // One project is selected, so counting projects is noise.
                <KpiCard label={t('kpi.inReview')} value={kpis.pendingApprovals} icon={ThumbsUp} />
              ) : (
                <KpiCard label={t('kpi.restaurants')} value={kpis.clients} icon={Store} />
              )}
              <KpiCard label={t('kpi.campaigns')} value={kpis.activeCampaigns} icon={Megaphone} />
              <KpiCard label={t('kpi.scheduled')} value={kpis.scheduled} icon={CalendarClock} />
              {portal || !current ? (
                <KpiCard label={t('kpi.pending')} value={kpis.pendingApprovals} icon={ThumbsUp} />
              ) : (
                <KpiCard label={t('kpi.roas')} value={kpis.roas} format="ratio" icon={TrendingUp} previous={previous?.roas} unavailableReason={kpis.reasons?.roas} />
              )}
            </>
          )}
        </div>
      </section>

      {/* MARKETING CALENDAR — the same component the unified calendar uses. */}
      {!portal ? (
        <section className="mb-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-muted">{t('dash.calendarHeading')}</p>
            <Link to="/app/marketing/calendar" className="text-[13px] text-brand hover:underline">
              {t('common.viewAll')}
            </Link>
          </div>
          <MarketingCalendar clientId={clientId} initialView="week" />
        </section>
      ) : (
        <section className="mb-6">
          <Card>
            <CardHeader
              title={t('dash.publishingWeek')}
              icon={CalendarClock}
              action={
                <Link to={`${base}/calendar`} className="text-[13px] text-brand hover:underline">
                  {t('common.viewAll')}
                </Link>
              }
            />
            <EmptyState icon={CalendarClock} title={t('empty.calendar.title')} body={t('empty.calendar.body')} />
          </Card>
        </section>
      )}

      {/* AI RECOMMENDATIONS — only what the data supports. §11. */}
      {isAgency ? (
        <section className="mb-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-muted">{t('dash.aiHeading')}</p>
            <Link to="/app/marketing/advertising/ai" className="text-[13px] text-brand hover:underline">
              {t('common.viewAll')}
            </Link>
          </div>
          {recommendations.loading ? (
            <CardSkeleton rows={3} />
          ) : recommendations.data && recommendations.data.items.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-3">
              {recommendations.data.items.slice(0, 3).map((item) => (
                <Link key={item.id} to="/app/marketing/advertising/ai" className="block h-full">
                  <Card className="h-full p-3.5 transition-colors hover:border-brand/40">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={item.priority === 'P0' ? 'danger' : item.priority === 'P1' ? 'warn' : 'neutral'}>
                        {item.priority}
                      </Badge>
                      {item.platform ? <PlatformChip platform={item.platform} size="sm" /> : null}
                    </div>
                    <p className="mt-2 text-[13px] font-medium leading-snug text-fg" dir="auto">{item.title}</p>
                    {item.expectedImpact ? (
                      <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted" dir="auto">
                        {item.expectedImpact}
                      </p>
                    ) : null}
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            /* An honest empty state, not a filler card: the engine looked and
               the data did not carry a claim. */
            <Card>
              <EmptyState icon={Sparkles} title={t('dash.aiHeading')} body={t('dash.noRecommendations')} />
            </Card>
          )}
        </section>
      ) : null}

      {/* Alerts and activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('dash.alerts')} icon={Bell} subtitle={t('dash.alertsSub')} />
          <div className="space-y-2 p-4">
            {loading ? (
              <>
                <div className="skeleton h-16" />
                <div className="skeleton h-16" />
              </>
            ) : data && data.alerts.length > 0 ? (
              data.alerts.slice(0, 5).map((alert, index) => (
                <motion.div key={index} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
                  <AlertRow alert={alert} onNavigate={(link) => navigate(portal ? link.replace('/app', '/client') : link)} />
                </motion.div>
              ))
            ) : (
              <p className="py-10 text-center text-sm text-muted">{t('dash.noAlerts')}</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t('dash.recentActivity')} icon={Activity} />
          <div className="divide-y divide-line/60">
            {loading ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-10" />
                <div className="skeleton h-10" />
              </div>
            ) : data && data.recentActivity.length > 0 ? (
              data.recentActivity.slice(0, 7).map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-fg">{humanize(entry.action.replace('.', ' '))}</p>
                    <p className="text-[12px] text-muted">
                      {entry.user} · {relative(entry.createdAt, lang)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-10 text-center text-sm text-muted">{t('dash.noActivity')}</p>
            )}
          </div>
        </Card>
      </div>

      {/* Campaign status strip */}
      {data && Object.keys(data.campaignsByStatus).length > 0 ? (
        <Card className="mt-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] font-medium text-muted">{t('dash.campaignsLabel')}</span>
            {Object.entries(data.campaignsByStatus).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1.5">
                <StatusBadge status={status} kind="campaign" />
                <span className="tabular text-[13px] text-fg">{num(count, lang)}</span>
              </span>
            ))}
            <Link to={`${base}/campaigns`} className="ms-auto text-[13px] text-brand hover:underline">
              {t('common.viewAll')}
            </Link>
          </div>
        </Card>
      ) : null}

      {!loading && data && data.kpis.clients === 0 && !portal ? (
        <Card className="mt-4">
          <EmptyState
            icon={Building2}
            title={t('empty.clients.title')}
            body={t('empty.clients.body')}
            action={<Button onClick={() => navigate('/app/restaurants')}>{t('dash.addFirstProject')}</Button>}
          />
        </Card>
      ) : null}

      {data ? (
        <p className="mt-6 text-center text-[12px] text-muted">
          <Badge>{t('dash.liveLabel')}</Badge>{' '}
          <span className="ms-2">{t('dash.liveNote')}</span>
        </p>
      ) : null}
    </>
  );
}
