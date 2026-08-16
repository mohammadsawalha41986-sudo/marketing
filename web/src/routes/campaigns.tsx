/** Campaign list, creation, and the per-campaign workspace. */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CalendarRange, Megaphone, Plus, Search, Target, Wallet } from 'lucide-react';

import { api, qs, type CampaignStatus, type Metrics, type Paginated, type Platform } from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, isoDate, money, num, humanize } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Progress, Select, Tabs, useToast,
} from '../components/ui';
import { KpiCard, PlatformChip, StatusBadge } from '../components/domain';
import { ComparisonBars, TrendChart } from '../components/charts';

const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'SNAPCHAT', 'GOOGLE_ADS', 'GOOGLE_BUSINESS', 'LINKEDIN', 'X'];
const OBJECTIVES = ['AWARENESS', 'TRAFFIC', 'ENGAGEMENT', 'LEADS', 'SALES', 'APP_INSTALLS', 'VIDEO_VIEWS'];
const STATUSES: CampaignStatus[] = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'];

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: CampaignStatus;
  budget: number;
  spend: number;
  startDate: string;
  endDate: string;
  client: { id: string; name: string; logoUrl: string | null };
  platforms: Array<{ platform: Platform; budget: number }>;
  _count: { contents: number };
}

function CampaignForm({ open, onClose, onSaved, presetClient }: { open: boolean; onClose: () => void; onSaved: () => void; presetClient?: string }) {
  const { push } = useToast();
  const clients = useQuery<Paginated<{ id: string; name: string }>>(`/clients${qs({ pageSize: 100 })}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>(['INSTAGRAM']);
  const [form, setForm] = useState({
    clientId: presetClient ?? '',
    name: '',
    objective: 'AWARENESS',
    status: 'DRAFT',
    budget: 5000,
    startDate: isoDate(new Date()),
    endDate: isoDate(new Date(Date.now() + 30 * 86400000)),
    targetAudience: '',
    kpi: '',
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/campaigns', {
        ...form,
        budget: Number(form.budget),
        platforms: platforms.map((platform) => ({ platform, budget: Number(form.budget) / platforms.length })),
      });
      push({ tone: 'success', title: 'Campaign created' });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the campaign');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (platform: Platform) =>
    setPlatforms((current) =>
      current.includes(platform) ? current.filter((value) => value !== platform) : [...current, platform],
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button form="campaign-form" type="submit" loading={busy} disabled={platforms.length === 0}>Create campaign</Button>
        </>
      }
    >
      <form id="campaign-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Client" required>
          <Select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required>
            <option value="">Select a client</option>
            {clients.data?.items.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </Select>
        </Field>
        <Field label="Campaign name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <Field label="Objective">
          <Select value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}>
            {OBJECTIVES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            {STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label="Budget (USD)" required>
          <Input type="number" min={0} step={100} value={form.budget} onChange={(e) => setForm({ ...form, budget: Number(e.target.value) })} required />
        </Field>
        <Field label="KPI" hint="What does success look like?">
          <Input value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })} placeholder="ROAS above 3.0x" />
        </Field>
        <Field label="Start date" required>
          <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
        </Field>
        <Field label="End date" required>
          <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
        </Field>
        <Field label="Target audience" className="sm:col-span-2">
          <Input value={form.targetAudience} onChange={(e) => setForm({ ...form, targetAudience: e.target.value })} />
        </Field>
        <Field label="Platforms" required className="sm:col-span-2" error={error ?? undefined} hint="Budget is split evenly to begin with.">
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((platform) => (
              <button
                key={platform}
                type="button"
                onClick={() => toggle(platform)}
                className={`rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
                  platforms.includes(platform)
                    ? 'border-brand bg-brand/12 text-brand'
                    : 'border-line text-muted hover:text-fg'
                }`}
              >
                {humanize(platform)}
              </button>
            ))}
          </div>
        </Field>
      </form>
    </Modal>
  );
}

export function CampaignsPage({ portal = false }: { portal?: boolean }) {
  const { t, lang } = useI18n();
  const { canManage } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search);

  // The restaurant comes from the top bar, which still honours a ?client= in
  // the URL — so a link to one restaurant's campaigns keeps working.
  const { currentId: clientId } = useRestaurant();
  useEffect(() => setPage(1), [clientId]);

  const { data, loading, error, refetch } = useQuery<Paginated<CampaignRow>>(
    `/campaigns${qs({ page, pageSize: 12, search: debounced, status, clientId })}`,
    [page, debounced, status, clientId],
  );

  const base = portal ? '/client' : '/app';

  return (
    <>
      <PageHeader
        title={t('nav.campaigns')}
        subtitle="Budget, platforms, flight dates and the content attached to each."
        action={canManage && !portal ? <Button icon={Plus} onClick={() => setCreating(true)}>New campaign</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.all')}</option>
          {STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => <CardSkeleton key={index} />)}
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.items.map((campaign) => {
              const used = campaign.budget === 0 ? 0 : campaign.spend / campaign.budget;
              const tone = used > 0.95 ? 'danger' : used > 0.8 ? 'warn' : 'brand';
              return (
                <Card key={campaign.id} hover className="cursor-pointer p-5" onClick={() => navigate(`${base}/campaigns/${campaign.id}`)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-fg">{campaign.name}</p>
                      <p className="truncate text-[13px] text-muted">{campaign.client.name}</p>
                    </div>
                    <StatusBadge status={campaign.status} kind="campaign" />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {campaign.platforms.slice(0, 4).map((entry) => (
                      <PlatformChip key={entry.platform} platform={entry.platform} size="sm" />
                    ))}
                    {campaign.platforms.length > 4 ? <Badge>+{campaign.platforms.length - 4}</Badge> : null}
                  </div>

                  <div className="mt-4">
                    <div className="mb-1.5 flex items-center justify-between text-[13px]">
                      <span className="text-muted">{t('common.budget')}</span>
                      <span className="tabular text-fg">
                        {money(campaign.spend, lang, true)} / {money(campaign.budget, lang, true)}
                      </span>
                    </div>
                    <Progress value={used} tone={tone} />
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
                    <span className="flex items-center gap-1.5">
                      <CalendarRange className="h-3.5 w-3.5" />
                      {date(campaign.startDate, lang)} → {date(campaign.endDate, lang)}
                    </span>
                    <span>{num(campaign._count.contents, lang)} items</span>
                  </div>
                </Card>
              );
            })}
          </div>
          <Card className="mt-4"><Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} /></Card>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={Megaphone}
            title={debounced || status ? t('empty.search.title') : t('empty.campaigns.title')}
            body={debounced || status ? t('empty.search.body') : t('empty.campaigns.body')}
            action={canManage && !portal && !debounced ? <Button icon={Plus} onClick={() => setCreating(true)}>New campaign</Button> : undefined}
          />
        </Card>
      )}

      <CampaignForm open={creating} onClose={() => setCreating(false)} onSaved={refetch} presetClient={clientId || undefined} />
    </>
  );
}

// ---------------------------------------------------------------- detail

interface CampaignDetail extends CampaignRow {
  targetAudience: string | null;
  kpi: string | null;
  notes: string | null;
  locations: string[];
  contents: Array<{ id: string; name: string; status: string; platform: Platform; scheduledAt: string | null; headline: string | null }>;
}

interface CampaignAnalytics {
  range: { from: string; to: string };
  totals: Metrics;
  previous: Metrics;
  series: Array<{ date: string } & Metrics>;
  platforms: Array<{ platform: Platform; label: string; spend: number; clicks: number; conversions: number; roas: number; ctr: number }>;
  budget: { total: number; spent: number; remaining: number };
}

export function CampaignDetailPage({ portal = false }: { portal?: boolean }) {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<'overview' | 'content' | 'analytics'>('overview');

  const { data, loading, error, refetch } = useQuery<{ campaign: CampaignDetail }>(`/campaigns/${id}`, [id]);
  const analytics = useQuery<CampaignAnalytics>(`/campaigns/${id}/analytics`, [id]);

  const used = useMemo(() => {
    if (!data) return 0;
    return data.campaign.budget === 0 ? 0 : data.campaign.spend / data.campaign.budget;
  }, [data]);

  if (loading) return <div className="space-y-4"><CardSkeleton rows={2} /><CardSkeleton rows={4} /></div>;
  if (error || !data) return <Card><ErrorState message={error ?? 'Campaign not found'} onRetry={refetch} /></Card>;

  const campaign = data.campaign;
  const base = portal ? '/client' : '/app';

  return (
    <>
      <PageHeader
        title={campaign.name}
        subtitle={`${campaign.client.name} · ${humanize(campaign.objective)} · ${date(campaign.startDate, lang)} → ${date(campaign.endDate, lang)}`}
        action={<StatusBadge status={campaign.status} kind="campaign" />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <KpiCard label={t('common.budget')} value={campaign.budget} format="money" compact icon={Wallet} />
        <KpiCard label={t('kpi.spend')} value={campaign.spend} format="money" compact footer={`${Math.round(used * 100)}% used`} />
        <KpiCard label={t('kpi.conversions')} value={analytics.data?.totals.conversions ?? 0} icon={Target} />
        <KpiCard label={t('kpi.roas')} value={analytics.data?.totals.roas ?? 0} format="ratio" previous={analytics.data?.previous.roas} />
      </div>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: t('nav.overview') },
          { value: 'content', label: t('nav.content'), count: campaign.contents.length },
          { value: 'analytics', label: t('nav.analytics') },
        ]}
      />

      {tab === 'overview' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Budget pacing" icon={Wallet} />
            <div className="p-5">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted">{money(campaign.spend, lang)} spent</span>
                <span className="text-muted">{money(campaign.budget, lang)} budget</span>
              </div>
              <Progress value={used} tone={used > 0.95 ? 'danger' : used > 0.8 ? 'warn' : 'brand'} />
              <p className="mt-2 text-[13px] text-muted">
                {money(Math.max(campaign.budget - campaign.spend, 0), lang)} remaining
              </p>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">Platform split</p>
                  <div className="space-y-2">
                    {campaign.platforms.map((entry) => (
                      <div key={entry.platform} className="flex items-center justify-between gap-2">
                        <PlatformChip platform={entry.platform} size="sm" />
                        <span className="tabular text-[13px] text-muted">{money(entry.budget, lang, true)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-3 text-[13px]">
                  <div><p className="text-muted">KPI</p><p className="text-fg">{campaign.kpi ?? '—'}</p></div>
                  <div><p className="text-muted">Audience</p><p className="text-fg">{campaign.targetAudience ?? '—'}</p></div>
                  <div><p className="text-muted">Locations</p><p className="text-fg">{campaign.locations.join(', ') || '—'}</p></div>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Timeline" icon={CalendarRange} />
            <div className="space-y-4 p-5">
              {[
                { label: 'Starts', value: date(campaign.startDate, lang) },
                { label: 'Ends', value: date(campaign.endDate, lang) },
                { label: 'Content items', value: num(campaign.contents.length, lang) },
                { label: 'Scheduled', value: num(campaign.contents.filter((item) => item.status === 'SCHEDULED').length, lang) },
                { label: 'Published', value: num(campaign.contents.filter((item) => item.status === 'PUBLISHED').length, lang) },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between text-[13px]">
                  <span className="text-muted">{row.label}</span>
                  <span className="tabular font-medium text-fg">{row.value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'content' ? (
        <Card>
          <CardHeader title="Content in this campaign" />
          <div className="divide-y divide-line/60">
            {campaign.contents.length === 0 ? (
              <EmptyState icon={Megaphone} title={t('empty.content.title')} body={t('empty.content.body')} />
            ) : (
              campaign.contents.map((item) => (
                <Link key={item.id} to={`${base}/content/${item.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">{item.name}</p>
                    <p className="truncate text-[12px] text-muted">{item.headline ?? '—'}</p>
                  </div>
                  <PlatformChip platform={item.platform} size="sm" />
                  {item.scheduledAt ? <span className="text-[12px] text-muted">{date(item.scheduledAt, lang)}</span> : null}
                  <StatusBadge status={item.status} kind="content" />
                </Link>
              ))
            )}
          </div>
        </Card>
      ) : null}

      {tab === 'analytics' ? (
        analytics.loading ? (
          <CardSkeleton rows={6} />
        ) : analytics.data && analytics.data.totals.impressions > 0 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <KpiCard label={t('kpi.impressions')} value={analytics.data.totals.impressions} compact previous={analytics.data.previous.impressions} />
              <KpiCard label={t('kpi.clicks')} value={analytics.data.totals.clicks} compact previous={analytics.data.previous.clicks} />
              <KpiCard label={t('kpi.ctr')} value={analytics.data.totals.ctr} format="percent" previous={analytics.data.previous.ctr} />
              <KpiCard label={t('kpi.cpc')} value={analytics.data.totals.cpc} format="money" previous={analytics.data.previous.cpc} invertTrend />
            </div>

            <Card>
              <CardHeader title="Daily performance" />
              <div className="p-4">
                <TrendChart
                  data={analytics.data.series}
                  keys={[{ key: 'spend', label: t('kpi.spend') }, { key: 'revenue', label: t('kpi.revenue') }]}
                  currency
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Platform comparison" />
              <div className="p-4">
                <ComparisonBars data={analytics.data.platforms as never} dataKey="spend" currency />
              </div>
            </Card>
          </div>
        ) : (
          <Card>
            <EmptyState icon={Target} title="No analytics yet" body="Data appears once the campaign starts delivering." />
          </Card>
        )
      ) : null}
    </>
  );
}
