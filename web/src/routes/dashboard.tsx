/** The main dashboard. Same data shape for agency and client portal. */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity, Bell, Building2, CalendarClock, Eye, Megaphone, MousePointerClick,
  Store, ThumbsUp, TrendingUp, Wallet,
} from 'lucide-react';

import { qs, type Metrics, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { isoDate, money, num, pct, ratio, relative, humanize } from '../lib/format';
import { Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader, Select } from '../components/ui';
import { AlertRow, KpiCard, PlatformChip, StatusBadge, type Alert } from '../components/domain';
import { DonutChart, TrendChart } from '../components/charts';

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

interface CalendarItem {
  id: string;
  name: string;
  status: string;
  platform: Platform;
  scheduledAt: string | null;
  client: { id: string; name: string };
}

const RANGE_KEYS = [
  { value: 7, key: 'dash.range7' },
  { value: 30, key: 'dash.range30' },
  { value: 90, key: 'dash.range90' },
] as const;

export function DashboardPage({ portal = false }: { portal?: boolean }) {
  const { user, isAgency } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [days, setDays] = useState(30);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    return { from: isoDate(from), to: isoDate(to) };
  }, [days]);

  // Home answers "how are things going" for whatever the top bar is pointed at:
  // one restaurant, or all of them. Both endpoints already scope by client, so
  // this is the same data narrowed, not a different number.
  const { current, currentId } = useRestaurant();
  const clientId = portal ? '' : currentId;

  const { data, loading, error, refetch } = useQuery<DashboardData>(
    `/analytics/dashboard${qs({ ...range, clientId })}`,
    [range.from, range.to, clientId],
  );
  const upcoming = useQuery<{ items: CalendarItem[] }>(
    `/calendar${qs({ view: 'week', clientId })}`,
    [clientId],
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

  return (
    <>
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
              <Button onClick={() => navigate('/app/studio')} icon={Megaphone}>{t('dash.newContent')}</Button>
            ) : null}
          </>
        }
      />

      {/*
        * What is in the pipeline, before what it earned. Opening the day on
        * spend answers a question nobody has at 9am; the counters below are the
        * work that is waiting.
        */}
      <p className="mb-2 text-[13px] font-medium text-muted">{t('dash.needsYou')}</p>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {loading || !kpis ? (
          Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
        ) : (
          <>
            {portal ? (
              <KpiCard label={t('kpi.impressions')} value={kpis.impressions} icon={Eye} compact previous={previous?.impressions} />
            ) : current ? (
              // One restaurant is selected, so counting restaurants is noise.
              <KpiCard label={t('kpi.inReview')} value={kpis.pendingApprovals} icon={ThumbsUp} />
            ) : (
              <KpiCard label={t('kpi.restaurants')} value={kpis.clients} icon={Store} />
            )}
            <KpiCard label={t('kpi.campaigns')} value={kpis.activeCampaigns} icon={Megaphone} />
            <KpiCard label={t('kpi.scheduled')} value={kpis.scheduled} icon={CalendarClock} />
            {portal || !current ? (
              <KpiCard label={t('kpi.pending')} value={kpis.pendingApprovals} icon={ThumbsUp} />
            ) : (
              <KpiCard label={t('kpi.reach')} value={kpis.reach} compact icon={Eye} previous={previous?.reach} />
            )}
          </>
        )}
      </div>

      {/* Performance */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {loading || !kpis ? (
          Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
        ) : (
          <>
            <KpiCard label={t('kpi.spend')} value={kpis.spend} format="money" compact icon={Wallet} previous={previous?.spend} />
            <KpiCard label={t('kpi.reach')} value={kpis.reach} compact icon={Eye} previous={previous?.reach} />
            <KpiCard label={t('kpi.clicks')} value={kpis.clicks} compact icon={MousePointerClick} previous={previous?.clicks} />
            <KpiCard label={t('kpi.roas')} value={kpis.roas} format="ratio" icon={TrendingUp} previous={previous?.roas} />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Trend */}
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

        {/* Alerts */}
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
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Platform mix */}
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

        {/* Calendar preview */}
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
          <div className="divide-y divide-line/60">
            {upcoming.loading ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-10" />
                <div className="skeleton h-10" />
              </div>
            ) : upcoming.data && upcoming.data.items.length > 0 ? (
              upcoming.data.items.slice(0, 6).map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">{item.name}</p>
                    <p className="text-[12px] text-muted">
                      {current ? '' : `${item.client.name} · `}
                      {item.scheduledAt ? relative(item.scheduledAt, lang) : '—'}
                    </p>
                  </div>
                  <PlatformChip platform={item.platform} size="sm" />
                </div>
              ))
            ) : (
              <EmptyState icon={CalendarClock} title={t('empty.calendar.title')} body={t('empty.calendar.body')} />
            )}
          </div>
        </Card>

        {/* Activity */}
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
            <span className="text-[13px] font-medium text-muted">Campaigns</span>
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
            action={<Button onClick={() => navigate('/app/restaurants')}>Add your first restaurant</Button>}
          />
        </Card>
      ) : null}

      {data ? (
        <p className="mt-6 text-center text-[12px] text-muted">
          <Badge>Live</Badge>{' '}
          <span className="ms-2">
            {t('dash.liveNote')}
          </span>
        </p>
      ) : null}
    </>
  );
}
