/**
 * The dashboard — the command centre, in the shape the product was approved in.
 *
 * Reading order is the argument: what the money did, then how it moved over the
 * period, then what is going out this week, then what is running, then what is
 * connected. The right rail carries the two things that are about *now* rather
 * than about the period — what the engine thinks you should do, and what just
 * happened.
 *
 * Every figure is measured. Where a number cannot be computed — a ratio with no
 * spend behind it, a platform that has reported nothing — the card says so
 * instead of printing a confident zero. That rule is the difference between a
 * dashboard and a picture of one.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, BarChart3, CalendarDays, CalendarPlus, ChartNoAxesCombined, Coins, Building2,
  MousePointerClick, Plug, Sparkles, Target, TrendingUp, Users, Wallet,
} from 'lucide-react';

import { qs, type Metrics, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { isoDate, money, num, ratio, relative, humanize, date as formatDate } from '../lib/format';
import { cn } from '../lib/utils';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Select,
  TableWrap, Td, Th,
} from '../components/ui';
import {
  AlertRow, KpiCard, PlatformChip, StatusBadge, type Alert,
} from '../components/domain';
import { TrendChart } from '../components/charts';
import { MarketingCalendar } from '../components/marketing-calendar';
import { CreateFlow } from '../components/create-flow';

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  client: { id: string; businessName: string; logoUrl: string | null } | null;
  platforms: Platform[];
  budget: number;
  spend: number;
  roas: number | null;
  roasReason: string | null;
}

interface DashboardData {
  range: { from: string; to: string };
  kpis: Metrics & { clients: number; activeCampaigns: number; scheduled: number; pendingApprovals: number };
  previous: Metrics;
  series: Array<{ date: string } & Metrics>;
  platforms: Array<{ platform: Platform; label: string; spend: number; conversions: number; roas: number; clicks: number }>;
  campaignsByStatus: Record<string, number>;
  campaigns: CampaignRow[];
  alerts: Alert[];
  recentActivity: Array<{ id: string; action: string; entity: string; user: string; createdAt: string }>;
}

interface OrganicMetric {
  value: number | null;
  state: 'ZERO' | 'UNAVAILABLE' | 'NOT_FETCHED' | 'PROVIDER_ERROR';
}

interface TopPost {
  platformPostId: string;
  postGroupId: string;
  platform: Platform;
  platformLabel: string;
  caption: string | null;
  publishedAt: string | null;
  metrics: Record<'reach' | 'impressions' | 'engagements' | 'clicks', OrganicMetric>;
}

interface SocialOverview {
  totalPosts: number;
  publishedPosts: number;
  topPosts: TopPost[];
  periodTotals: {
    likes: number; comments: number; shares: number; saves: number;
    reach: number; impressions: number; engagements: number; clicks: number;
  };
}

interface IntegrationRow {
  id: string;
  platform: Platform;
  status: string;
  accountName: string | null;
  lastError: string | null;
  client: { id: string; name: string } | null;
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

/** Connection states carry meaning; each gets the tone that meaning deserves. */
const INTEGRATION_TONES: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  CONNECTED: 'ok',
  EXPIRED: 'warn',
  REAUTH_REQUIRED: 'warn',
  PENDING: 'warn',
  ERROR: 'danger',
  DISCONNECTED: 'neutral',
};

export function DashboardPage({ portal = false }: { portal?: boolean }) {
  const { user, isAgency } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
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
  const base = portal ? '/client' : '/app';

  const { data, loading, error, refetch } = useQuery<DashboardData>(
    `/analytics/dashboard${qs({ ...range, clientId })}`,
    [range.from, range.to, clientId],
  );
  const organic = useQuery<SocialOverview>(
    `/social/analytics/overview${qs({ ...range, clientId })}`,
    [range.from, range.to, clientId],
  );
  const recommendations = useQuery<{ items: StoredRecommendation[] }>(
    isAgency ? `/advertising/ai/recommendations${qs({ clientId, pageSize: 3 })}` : null,
    [clientId, isAgency],
  );
  const integrations = useQuery<{ items: IntegrationRow[] }>(
    isAgency && !portal ? `/integrations${qs({ clientId })}` : null,
    [clientId, isAgency, portal],
  );

  const hour = new Date().getHours();
  const greetingKey = hour < 12 ? 'dash.morning' : hour < 18 ? 'dash.afternoon' : 'dash.evening';
  const firstName = user?.name.split(' ')[0] ?? '';

  if (error) {
    return (
      <>
        <h1 className="mb-4 text-[22px] font-semibold tracking-tight text-fg">{t('nav.dashboard')}</h1>
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      </>
    );
  }

  const kpis = data?.kpis;
  const previous = data?.previous;
  const totals = organic.data?.periodTotals;

  return (
    <>
      {/* ---------------------------------------------------------- header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight text-fg sm:text-[28px]" dir="auto">
            {portal
              ? user?.client?.businessName ?? t('nav.home')
              : `${t(greetingKey)}, ${firstName}`}
          </h1>
          <p className="mt-1 text-[13.5px] text-muted">
            {portal ? t('dash.todaySub') : current ? current.businessName : t('dash.todaySub')}
          </p>
          {current?.businessType && !portal ? (
            <p className="mt-0.5 text-[12px] text-muted" dir="auto">
              {t('common.businessType')}: {current.businessType}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden text-[13px] text-muted sm:block">{formatDate(new Date(), lang)}</span>
          <Select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className="w-40"
            aria-label={t('common.date')}
          >
            {RANGE_KEYS.map((option) => (
              <option key={option.value} value={option.value}>{t(option.key)}</option>
            ))}
          </Select>
        </div>
      </div>

      {isAgency ? <CreateFlow open={creating} onClose={() => setCreating(false)} /> : null}

      {/* ------------------------------------------------------------- KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {loading || !kpis ? (
          Array.from({ length: 6 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
        ) : (
          <>
            <KpiCard
              label={t('kpi.revenue')} value={kpis.revenue} previous={previous?.revenue}
              format="money" compact icon={Coins}
            />
            {/* Spend rising is neither good nor bad on its own, so the change is
                shown without a verdict attached to it. */}
            <KpiCard
              label={t('kpi.spend')} value={kpis.spend} previous={previous?.spend}
              format="money" compact icon={Wallet} neutralTrend
            />
            <KpiCard
              label={t('kpi.roas')} value={kpis.roas} previous={previous?.roas}
              format="ratio" icon={TrendingUp} unavailableReason={kpis.reasons?.roas}
            />
            <KpiCard
              label={t('kpi.conversions')} value={kpis.conversions} previous={previous?.conversions}
              compact icon={Target}
            />
            {/* Cost per conversion falling is the good direction. */}
            <KpiCard
              label={t('kpi.cpaShort')} value={kpis.cpa} previous={previous?.cpa}
              format="money" icon={MousePointerClick} invertTrend
              unavailableReason={kpis.reasons?.cpa}
            />
            <KpiCard
              label={t('report.metric.engagements')}
              value={totals ? totals.engagements : null}
              compact icon={Users}
              unavailableReason={organic.loading ? t('common.loading') : t('dash.notMeasured')}
              footer={
                organic.data
                  ? t('dash.engagementBasis').replace('{count}', num(organic.data.publishedPosts, lang))
                  : undefined
              }
            />
          </>
        )}
      </div>

      {/* ------------------------------------------------- workspace + rail */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* Performance over the period, beside what performed best in it. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="min-w-0">
              <CardHeader
                title={t('dash.performance')}
                subtitle={data ? `${data.range.from} → ${data.range.to} · ${t('common.vsPrevious')}` : undefined}
                icon={ChartNoAxesCombined}
              />
              <div className="p-3 sm:p-4">
                {loading ? (
                  <div className="skeleton h-[260px]" />
                ) : data && data.series.some((point) => point.spend > 0 || point.revenue > 0) ? (
                  <TrendChart
                    data={data.series}
                    keys={[
                      { key: 'revenue', label: t('kpi.revenue') },
                      { key: 'spend', label: t('kpi.spend') },
                    ]}
                    currency
                  />
                ) : (
                  <p className="py-20 text-center text-sm text-muted">{t('common.noData')}</p>
                )}
              </div>
            </Card>

            <Card className="min-w-0">
              <CardHeader
                title={t('dash.topContent')}
                icon={BarChart3}
                action={
                  <Link to={`${base}/analytics`} className="text-[13px] text-brand hover:underline">
                    {t('common.viewAll')}
                  </Link>
                }
              />
              {organic.loading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton h-12" />)}
                </div>
              ) : organic.data && organic.data.topPosts.length > 0 ? (
                <div className="divide-y divide-line/60">
                  {organic.data.topPosts.slice(0, 4).map((post) => {
                    const engagements = post.metrics.engagements;
                    const reach = post.metrics.reach;
                    return (
                      <Link
                        key={post.platformPostId}
                        to={portal ? `${base}/content` : `/app/social/${post.postGroupId}`}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated"
                      >
                        <PlatformChip platform={post.platform} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-fg" dir="auto">
                            {post.caption?.trim() || t('common.none')}
                          </span>
                          <span className="block text-[11.5px] text-muted">
                            {reach.value === null
                              ? t('dash.notMeasured')
                              : `${num(reach.value, lang, true)} ${t('kpi.reach').toLowerCase()}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-[13px] font-medium tabular text-fg" dir="ltr">
                          {engagements.value === null ? '—' : num(engagements.value, lang, true)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <EmptyState compact icon={BarChart3} title={t('dash.topContent')} body={t('dash.noTopContent')} />
              )}
            </Card>
          </div>

          {/* The week ahead. The same calendar the unified view uses — one
              engine, two placements. */}
          {!portal ? (
            <Card className="min-w-0 overflow-hidden">
              <CardHeader
                title={t('dash.contentCalendar')}
                subtitle={t('dash.contentCalendarSub')}
                icon={CalendarDays}
                action={
                  <div className="flex items-center gap-2">
                    <Link to="/app/social" className="text-[13px] text-brand hover:underline">
                      {t('create.button')}
                    </Link>
                    <Link to="/app/marketing/calendar" className="text-[13px] text-brand hover:underline">
                      {t('common.viewAll')}
                    </Link>
                  </div>
                }
              />
              <div className="p-3 sm:p-4">
                <MarketingCalendar clientId={clientId} initialView="week" />
              </div>
            </Card>
          ) : (
            <Card>
              <CardHeader
                title={t('dash.contentCalendar')}
                icon={CalendarDays}
                action={
                  <Link to={`${base}/calendar`} className="text-[13px] text-brand hover:underline">
                    {t('common.viewAll')}
                  </Link>
                }
              />
              <EmptyState
                icon={CalendarPlus}
                title={t('empty.calendar.title')}
                body={t('empty.calendar.body')}
                action={<Button onClick={() => navigate(`${base}/calendar`)}>{t('common.viewAll')}</Button>}
              />
            </Card>
          )}

          {/* What is running, and what it costs. */}
          <Card className="min-w-0">
            <CardHeader
              title={t('dash.activeCampaigns')}
              icon={Activity}
              action={
                <Link to={`${base}/campaigns`} className="text-[13px] text-brand hover:underline">
                  {t('common.viewAll')}
                </Link>
              }
            />
            {loading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 3 }).map((_, index) => <div key={index} className="skeleton h-11" />)}
              </div>
            ) : data && data.campaigns.length > 0 ? (
              <TableWrap>
                <thead>
                  <tr>
                    <Th>{t('common.campaign')}</Th>
                    <Th>{t('common.platform')}</Th>
                    <Th>{t('common.status')}</Th>
                    <Th align="end">{t('common.budget')}</Th>
                    <Th align="end">{t('kpi.spend')}</Th>
                    <Th align="end">{t('kpi.roas')}</Th>
                    <Th align="end">{t('common.actions')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((row) => (
                    <tr key={row.id}>
                      <Td>
                        <span className="block max-w-[16rem] truncate font-medium text-fg" dir="auto">
                          {row.name}
                        </span>
                        <span className="block truncate text-[11.5px] text-muted" dir="auto">
                          {row.client?.businessName ?? humanize(row.objective.toLowerCase())}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          {row.platforms.length === 0 ? (
                            <span className="text-muted">—</span>
                          ) : (
                            row.platforms.slice(0, 3).map((platform) => (
                              <PlatformChip key={platform} platform={platform} size="sm" />
                            ))
                          )}
                        </span>
                      </Td>
                      <Td><StatusBadge status={row.status} kind="campaign" /></Td>
                      <Td align="end"><span dir="ltr">{money(row.budget, lang, true)}</span></Td>
                      <Td align="end"><span dir="ltr">{money(row.spend, lang, true)}</span></Td>
                      <Td align="end">
                        {row.roas === null ? (
                          <span className="text-muted" title={row.roasReason ?? undefined}>—</span>
                        ) : (
                          <span dir="ltr">{ratio(row.roas)}</span>
                        )}
                      </Td>
                      <Td align="end">
                        <Link
                          to={`${base}/campaigns/${row.id}`}
                          className="rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-muted transition-colors hover:border-brand/40 hover:text-brand"
                        >
                          {t('common.view')}
                        </Link>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            ) : (
              <EmptyState compact icon={Activity} title={t('dash.activeCampaigns')} body={t('dash.noCampaigns')} />
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------- the rail */}
        <div className="min-w-0 space-y-4">
          {isAgency ? (
            <Card className="min-w-0">
              <CardHeader
                title={t('dash.assistant')}
                subtitle={t('dash.assistantSub')}
                icon={Sparkles}
                action={
                  <Link to="/app/marketing/advertising/ai" className="text-[13px] text-brand hover:underline">
                    {t('common.viewAll')}
                  </Link>
                }
              />
              <div className="space-y-2.5 p-4">
                {recommendations.loading ? (
                  <>
                    <div className="skeleton h-20" />
                    <div className="skeleton h-20" />
                  </>
                ) : recommendations.data && recommendations.data.items.length > 0 ? (
                  recommendations.data.items.slice(0, 3).map((item) => (
                    <Link
                      key={item.id}
                      to="/app/marketing/advertising/ai"
                      className="block rounded-[10px] border border-line p-3 transition-colors hover:border-brand/40"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone={item.priority === 'P0' ? 'danger' : item.priority === 'P1' ? 'warn' : 'neutral'}>
                          {item.priority}
                        </Badge>
                        {item.platform ? <PlatformChip platform={item.platform} size="sm" /> : null}
                      </span>
                      <span className="mt-2 block text-[13px] font-medium leading-snug text-fg" dir="auto">
                        {item.title}
                      </span>
                      <span className="mt-1 block line-clamp-2 text-[12px] leading-snug text-muted" dir="auto">
                        {item.reason}
                      </span>
                      {item.expectedImpact ? (
                        <span className="mt-1 block text-[12px] leading-snug text-brand" dir="auto">
                          {item.expectedImpact}
                        </span>
                      ) : null}
                    </Link>
                  ))
                ) : (
                  <p className="py-6 text-center text-[13px] text-muted">{t('dash.noRecommendations')}</p>
                )}

                {/* Alerts are derived from live rows, so they belong with the
                    recommendations rather than in a card of their own. */}
                {data && data.alerts.length > 0
                  ? data.alerts.slice(0, 3).map((alert, index) => (
                    <AlertRow
                      key={`${alert.title}-${index}`}
                      alert={alert}
                      onNavigate={(link) => navigate(portal ? link.replace('/app', '/client') : link)}
                    />
                  ))
                  : null}
              </div>
            </Card>
          ) : null}

          {/* Connected accounts, in whatever state they are actually in. */}
          {!portal && isAgency ? (
            <Card className="min-w-0">
              <CardHeader
                title={t('dash.connectedAccounts')}
                icon={Plug}
                action={
                  <Link to="/app/integrations" className="text-[13px] text-brand hover:underline">
                    {t('dash.manage')}
                  </Link>
                }
              />
              {integrations.loading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton h-10" />)}
                </div>
              ) : integrations.data && integrations.data.items.length > 0 ? (
                <div className="divide-y divide-line/60">
                  {integrations.data.items.slice(0, 6).map((row) => (
                    <div key={row.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <span className="min-w-0">
                        <PlatformChip platform={row.platform} size="sm" />
                        {row.accountName ?? (!clientId && row.client) ? (
                          <span className="mt-0.5 block truncate text-[11.5px] text-muted" dir="auto">
                            {row.accountName ?? row.client?.name}
                          </span>
                        ) : null}
                      </span>
                      <Badge tone={INTEGRATION_TONES[row.status] ?? 'neutral'}>
                        {humanize(row.status.toLowerCase())}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={Plug}
                  title={t('dash.connectedAccounts')}
                  body={t('dash.noAccounts')}
                  action={<Button onClick={() => navigate('/app/integrations')}>{t('dash.manage')}</Button>}
                />
              )}
            </Card>
          ) : null}

          <Card className="min-w-0">
            <CardHeader title={t('dash.recentActivity')} icon={Activity} />
            <div className="divide-y divide-line/60">
              {loading ? (
                <div className="space-y-2 p-4">
                  <div className="skeleton h-10" />
                  <div className="skeleton h-10" />
                  <div className="skeleton h-10" />
                </div>
              ) : data && data.recentActivity.length > 0 ? (
                data.recentActivity.slice(0, 8).map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2.5 px-4 py-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-fg">{humanize(entry.action.replace('.', ' '))}</p>
                      <p className="text-[11.5px] text-muted">
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

          {/* Campaign mix, when there is one to describe. */}
          {data && Object.keys(data.campaignsByStatus).length > 0 ? (
            <Card className="p-4">
              <p className="mb-2 text-[13px] font-medium text-muted">{t('dash.campaignsLabel')}</p>
              <div className="flex flex-wrap items-center gap-2.5">
                {Object.entries(data.campaignsByStatus).map(([status, count]) => (
                  <span key={status} className="flex items-center gap-1.5">
                    <StatusBadge status={status} kind="campaign" />
                    <span className="tabular text-[13px] text-fg">{num(count, lang)}</span>
                  </span>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

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

      <p className={cn('mt-6 text-center text-[12px] text-muted', !data && 'hidden')}>
        <Badge>{t('dash.liveLabel')}</Badge>{' '}
        <span className="ms-2">{t('dash.liveNote')}</span>
      </p>
    </>
  );
}
