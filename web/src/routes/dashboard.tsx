/**
 * The operator dashboard.
 *
 * Answers, in order: what needs attention, what is going out next, how the
 * whole book of restaurants is performing, and who is performing best. Every
 * figure is computed server-side from stored rows.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity, Bell, CalendarClock, Eye, ListChecks, Megaphone, MousePointerClick, PenLine,
  Store, Target, TrendingUp, Wallet,
} from 'lucide-react';

import { qs, type Metrics, type Platform, type RestaurantRef } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { isoDate, money, num, pct, ratio, relative, humanize } from '../lib/format';
import { Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader, Select } from '../components/ui';
import { AlertRow, KpiCard, PlatformChip, StatusBadge, type Alert } from '../components/domain';
import { DonutChart, TrendChart } from '../components/charts';

interface DashboardData {
  range: { from: string; to: string };
  currency: string;
  kpis: Metrics & {
    restaurants: number;
    activeRestaurants: number;
    activeCampaigns: number;
    activeAds: number;
    adSpend: number;
    adLeads: number;
    adConversions: number;
    scheduled: number;
    published: number;
    openTasks: number;
  };
  previous: Metrics;
  series: Array<{ date: string } & Metrics>;
  platforms: Array<{ platform: Platform; label: string; spend: number; conversions: number; roas: number; clicks: number }>;
  campaignsByStatus: Record<string, number>;
  best: {
    restaurant: (RestaurantRef & { revenue: number; spend: number }) | null;
    campaign: { id: string; name: string; restaurant: RestaurantRef; revenue: number; spend: number } | null;
  };
  upcoming: Array<{
    id: string; name: string; type: string; platform: Platform;
    scheduledAt: string | null; restaurant: RestaurantRef;
  }>;
  alerts: Alert[];
  recentActivity: Array<{ id: string; action: string; entity: string; user: string; createdAt: string }>;
}

/**
 * Date ranges. The month options resolve against the current date rather than
 * a fixed day count, so "this month" means the calendar month, not 30 days.
 */
function rangeFor(key: string): { from: string; to: string } {
  const now = new Date();
  if (key === 'month') {
    return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
  }
  if (key === 'lastMonth') {
    return {
      from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  const days = Number(key);
  return { from: isoDate(new Date(now.getTime() - (days - 1) * 86400000)), to: isoDate(now) };
}

export function DashboardPage() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState('30');
  const [restaurantId, setRestaurantId] = useState('');

  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);
  const restaurants = useQuery<{ items: RestaurantRef[] }>(`/restaurants${qs({ pageSize: 100 })}`);

  const { data, loading, error, refetch } = useQuery<DashboardData>(
    `/analytics/dashboard${qs({ ...range, restaurantId: restaurantId || undefined })}`,
    [range.from, range.to, restaurantId],
  );

  const greeting = user?.name.split(' ')[0] ?? '';

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
        title={`${t('dash.greeting')}, ${greeting}`}
        subtitle={data ? `${data.range.from} → ${data.range.to} · ${t('common.vsPrevious')}` : t('common.loading')}
        action={
          <>
            <Select value={restaurantId} onChange={(event) => setRestaurantId(event.target.value)} className="w-44">
              <option value="">{t('common.all')}</option>
              {restaurants.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <Select value={rangeKey} onChange={(event) => setRangeKey(event.target.value)} className="w-40">
              <option value="7">{t('dash.range7')}</option>
              <option value="30">{t('dash.range30')}</option>
              <option value="90">{t('dash.range90')}</option>
              <option value="month">{t('dash.rangeMonth')}</option>
              <option value="lastMonth">{t('dash.rangeLastMonth')}</option>
            </Select>
            <Button onClick={() => navigate('/ai')} icon={PenLine}>{t('dash.newContent')}</Button>
          </>
        }
      />

      {/* Operational counters — the state of the book of business. */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        {loading || !kpis ? (
          Array.from({ length: 5 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
        ) : (
          <>
            <KpiCard label={t('kpi.restaurants')} value={kpis.activeRestaurants} icon={Store} footer={t('kpi.ofTotal').replace('{n}', num(kpis.restaurants, lang))} />
            <KpiCard label={t('kpi.campaigns')} value={kpis.activeCampaigns} icon={Megaphone} />
            <KpiCard label={t('kpi.ads')} value={kpis.activeAds} icon={Target} />
            <KpiCard label={t('kpi.scheduled')} value={kpis.scheduled} icon={CalendarClock} />
            <KpiCard label={t('kpi.tasks')} value={kpis.openTasks} icon={ListChecks} />
          </>
        )}
      </div>

      {/* Performance. */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        {loading || !kpis ? (
          Array.from({ length: 5 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
        ) : (
          <>
            <KpiCard label={t('kpi.spend')} value={kpis.spend} format="money" compact icon={Wallet} previous={previous?.spend} />
            <KpiCard label={t('kpi.reach')} value={kpis.reach} compact icon={Eye} previous={previous?.reach} />
            <KpiCard label={t('kpi.clicks')} value={kpis.clicks} compact icon={MousePointerClick} previous={previous?.clicks} />
            <KpiCard label={t('kpi.leads')} value={kpis.leads} previous={previous?.leads} />
            <KpiCard label={t('kpi.roas')} value={kpis.roas} format="ratio" icon={TrendingUp} previous={previous?.roas} />
          </>
        )}
      </div>

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
                  <AlertRow alert={alert} onNavigate={(link) => navigate(link)} />
                </motion.div>
              ))
            ) : (
              <p className="py-10 text-center text-sm text-muted">{t('dash.noAlerts')}</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
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

        <Card>
          <CardHeader
            title={t('dash.publishingWeek')}
            icon={CalendarClock}
            action={<Link to="/calendar" className="text-[13px] text-brand hover:underline">{t('common.viewAll')}</Link>}
          />
          <div className="divide-y divide-line/60">
            {loading ? (
              <div className="space-y-2 p-4">
                <div className="skeleton h-10" />
                <div className="skeleton h-10" />
              </div>
            ) : data && data.upcoming.length > 0 ? (
              data.upcoming.slice(0, 6).map((item) => (
                <Link key={item.id} to={`/content/${item.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">{item.name}</p>
                    <p className="truncate text-[12px] text-muted">
                      {item.restaurant.name} · {item.scheduledAt ? relative(item.scheduledAt, lang) : '—'}
                    </p>
                  </div>
                  <PlatformChip platform={item.platform} size="sm" />
                </Link>
              ))
            ) : (
              <EmptyState icon={CalendarClock} title={t('empty.calendar.title')} body={t('empty.calendar.body')} />
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

      {/* Best performers, decided by revenue over the window rather than by hand. */}
      {data && (data.best.restaurant || data.best.campaign) ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {data.best.restaurant ? (
            <Card className="p-5">
              <p className="text-[12px] uppercase tracking-wide text-muted">{t('dash.bestRestaurant')}</p>
              <Link to={`/restaurants/${data.best.restaurant.id}`} className="mt-1 block text-lg font-semibold text-fg hover:text-brand">
                {data.best.restaurant.name}
              </Link>
              <p className="mt-1 text-[13px] text-muted">
                {money(data.best.restaurant.revenue, lang, true)} {t('kpi.revenue').toLowerCase()} ·{' '}
                {ratio(data.best.restaurant.spend === 0 ? 0 : data.best.restaurant.revenue / data.best.restaurant.spend)} {t('kpi.roas')}
              </p>
            </Card>
          ) : null}
          {data.best.campaign ? (
            <Card className="p-5">
              <p className="text-[12px] uppercase tracking-wide text-muted">{t('dash.bestCampaign')}</p>
              <Link to={`/campaigns/${data.best.campaign.id}`} className="mt-1 block text-lg font-semibold text-fg hover:text-brand">
                {data.best.campaign.name}
              </Link>
              <p className="mt-1 text-[13px] text-muted">
                {data.best.campaign.restaurant.name} · {money(data.best.campaign.revenue, lang, true)} {t('kpi.revenue').toLowerCase()}
              </p>
            </Card>
          ) : null}
        </div>
      ) : null}

      {data && Object.keys(data.campaignsByStatus).length > 0 ? (
        <Card className="mt-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] font-medium text-muted">{t('nav.campaigns')}</span>
            {Object.entries(data.campaignsByStatus).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1.5">
                <StatusBadge status={status} kind="campaign" />
                <span className="tabular text-[13px] text-fg">{num(count, lang)}</span>
              </span>
            ))}
            <Link to="/campaigns" className="ms-auto text-[13px] text-brand hover:underline">
              {t('common.viewAll')}
            </Link>
          </div>
        </Card>
      ) : null}

      {!loading && data && data.kpis.restaurants === 0 ? (
        <Card className="mt-4">
          <EmptyState
            icon={Store}
            title={t('empty.restaurants.title')}
            body={t('empty.restaurants.body')}
            action={<Button onClick={() => navigate('/restaurants')}>{t('action.firstRestaurant')}</Button>}
          />
        </Card>
      ) : null}

      {data ? (
        <p className="mt-6 text-center text-[12px] text-muted">
          <Badge>Live</Badge>
          <span className="ms-2">{t('dash.liveNote')}</span>
        </p>
      ) : null}
    </>
  );
}
