/**
 * Ads: the list, and the per-ad view where figures are recorded.
 *
 * Nothing here fetches from an ad platform. The adapters are architecture only
 * and every one returns 501, so rather than pretend otherwise, entering figures
 * by hand is the workflow — and an ad whose figures have never been entered is
 * shown as "not recorded", never as a row of zeroes.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarRange, MousePointerClick, Plus, Search, Target, TrendingUp, Wallet } from 'lucide-react';

import {
  api, qs, AD_STATUSES, CAMPAIGN_OBJECTIVES, PLATFORMS,
  type AdMetrics, type AdStatus, type Paginated, type Platform, type RestaurantRef,
} from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { date, humanize, money, num, pct, ratio } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, Textarea, useToast,
} from '../components/ui';
import { KpiCard, PlatformChip, StatusBadge } from '../components/domain';

interface AdRow {
  id: string;
  name: string;
  platform: Platform;
  status: AdStatus;
  objective: string;
  headline: string | null;
  primaryText: string | null;
  cta: string | null;
  audience: string | null;
  notes: string | null;
  budget: number;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
  conversions: number;
  revenue: number;
  metricsAt: string | null;
  metricsRecorded: boolean;
  metrics: AdMetrics;
  startDate: string | null;
  endDate: string | null;
  restaurant: RestaurantRef;
  campaign: { id: string; name: string; currency: string };
}

interface CampaignOption {
  id: string;
  name: string;
  restaurant: RestaurantRef;
}

function AdForm({
  open, onClose, onSaved, restaurantId, campaignId,
}: { open: boolean; onClose: () => void; onSaved: () => void; restaurantId?: string; campaignId?: string }) {
  const { t } = useI18n();
  const { push } = useToast();
  const campaigns = useQuery<Paginated<CampaignOption>>(
    `/campaigns${qs({ pageSize: 100, restaurantId })}`,
    [restaurantId],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = {
    campaignId: campaignId ?? '',
    name: '',
    platform: 'INSTAGRAM' as Platform,
    objective: 'SALES',
    status: 'DRAFT' as AdStatus,
    headline: '',
    primaryText: '',
    cta: '',
    audience: '',
    budget: 1000,
    startDate: '',
    endDate: '',
  };
  const [form, setForm] = useState(blank);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/ads', {
        ...form,
        budget: Number(form.budget),
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
      });
      push({ tone: 'success', title: 'Ad created', body: 'Record its figures once it has run.' });
      onSaved();
      onClose();
      setForm(blank);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the ad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New ad"
      subtitle="The restaurant is taken from the campaign you choose."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button form="ad-form" type="submit" loading={busy}>{t('common.create')}</Button>
        </>
      }
    >
      <form id="ad-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.campaign')} required className="sm:col-span-2">
          <Select value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })} required>
            <option value="">Select a campaign</option>
            {campaigns.data?.items.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}{restaurantId ? '' : ` — ${campaign.restaurant.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ad name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <Field label={t('common.platform')} required>
          <Select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}>
            {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label="Objective">
          <Select value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}>
            {CAMPAIGN_OBJECTIVES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label={t('common.status')}>
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as AdStatus })}>
            {AD_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label={t('common.budget')}>
          <Input type="number" min={0} step={50} value={form.budget} onChange={(e) => setForm({ ...form, budget: Number(e.target.value) })} />
        </Field>
        <Field label="Call to action">
          <Input value={form.cta} onChange={(e) => setForm({ ...form, cta: e.target.value })} placeholder="Order now" />
        </Field>
        <Field label="Start date">
          <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </Field>
        <Field label="End date">
          <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        </Field>
        <Field label="Headline" className="sm:col-span-2">
          <Input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} />
        </Field>
        <Field label="Primary text" className="sm:col-span-2">
          <Textarea value={form.primaryText} onChange={(e) => setForm({ ...form, primaryText: e.target.value })} rows={3} />
        </Field>
        <Field label="Audience" className="sm:col-span-2" error={error ?? undefined}>
          <Input value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} placeholder="Riyadh, 18–34, food and dining interests" />
        </Field>
      </form>
    </Modal>
  );
}

/** The dialog where the operator types in what the ad platform reported. */
function MetricsForm({ ad, open, onClose, onSaved }: { ad: AdRow; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    spend: ad.spend,
    impressions: ad.impressions,
    reach: ad.reach,
    clicks: ad.clicks,
    leads: ad.leads,
    conversions: ad.conversions,
    revenue: ad.revenue,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ads/${ad.id}/metrics`, Object.fromEntries(
        Object.entries(form).map(([key, value]) => [key, Number(value)]),
      ));
      push({ tone: 'success', title: 'Figures recorded' });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the figures');
    } finally {
      setBusy(false);
    }
  };

  const fields: Array<[keyof typeof form, string]> = [
    ['spend', t('kpi.spend')],
    ['revenue', t('kpi.revenue')],
    ['impressions', t('kpi.impressions')],
    ['reach', t('kpi.reach')],
    ['clicks', t('kpi.clicks')],
    ['leads', t('kpi.leads')],
    ['conversions', t('kpi.conversions')],
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('ads.recordMetrics')}
      subtitle={t('ads.manualNotice')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button form="metrics-form" type="submit" loading={busy}>{t('common.save')}</Button>
        </>
      }
    >
      <form id="metrics-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {fields.map(([key, label], index) => (
          <Field
            key={key}
            label={label}
            error={index === fields.length - 1 ? error ?? undefined : undefined}
          >
            <Input
              type="number"
              min={0}
              step={key === 'spend' || key === 'revenue' ? 0.01 : 1}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </Field>
        ))}
        <p className="text-[12px] text-muted sm:col-span-2">
          CTR, CPC, CPM and ROAS are calculated from these figures — they are never entered directly, so they
          cannot disagree with the numbers above.
        </p>
      </form>
    </Modal>
  );
}

export function AdsPage({ restaurantId, embedded = false }: { restaurantId?: string; embedded?: boolean } = {}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search);

  const campaignId = params.get('campaign') ?? undefined;
  const scoped = restaurantId ?? params.get('restaurant') ?? undefined;

  const { data, loading, error, refetch } = useQuery<Paginated<AdRow>>(
    `/ads${qs({ page, pageSize: 12, search: debounced, status, platform, restaurantId: scoped, campaignId })}`,
    [page, debounced, status, platform, scoped, campaignId],
  );

  return (
    <>
      {embedded ? null : (
        <PageHeader
          title={t('nav.ads')}
          subtitle={t('ads.manualNotice')}
          action={<Button icon={Plus} onClick={() => setCreating(true)}>New ad</Button>}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40">
          <option value="">{t('common.all')}</option>
          {AD_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.platform')}</option>
          {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        {embedded ? <Button icon={Plus} onClick={() => setCreating(true)}>New ad</Button> : null}
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
            {data.items.map((ad) => (
              <Card key={ad.id} hover className="cursor-pointer p-5" onClick={() => navigate(`/ads/${ad.id}`)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-fg">{ad.name}</p>
                    <p className="truncate text-[13px] text-muted">
                      {embedded ? ad.campaign.name : `${ad.restaurant.name} · ${ad.campaign.name}`}
                    </p>
                  </div>
                  <StatusBadge status={ad.status} kind="campaign" />
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <PlatformChip platform={ad.platform} size="sm" />
                  <Badge>{humanize(ad.objective)}</Badge>
                </div>

                {ad.metricsRecorded ? (
                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3.5 text-center">
                    {[
                      { label: t('kpi.spend'), value: money(ad.spend, lang, true) },
                      { label: t('kpi.ctr'), value: pct(ad.metrics.ctr, 1) },
                      { label: t('kpi.roas'), value: ratio(ad.metrics.roas) },
                    ].map((stat) => (
                      <div key={stat.label}>
                        <p className="tabular text-[15px] font-semibold text-fg">{stat.value}</p>
                        <p className="truncate text-[11px] uppercase tracking-wide text-muted">{stat.label}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 border-t border-line pt-3.5">
                    <p className="text-center text-[13px] italic text-muted">{t('ads.neverRecorded')}</p>
                  </div>
                )}
              </Card>
            ))}
          </div>
          <Card className="mt-4"><Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} /></Card>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={Target}
            title={debounced || status ? t('empty.search.title') : t('empty.ads.title')}
            body={debounced || status ? t('empty.search.body') : t('empty.ads.body')}
            action={!debounced ? <Button icon={Plus} onClick={() => setCreating(true)}>New ad</Button> : undefined}
          />
        </Card>
      )}

      <AdForm
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={refetch}
        restaurantId={scoped}
        campaignId={campaignId}
      />
    </>
  );
}

// ---------------------------------------------------------------- detail

export function AdDetailPage() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const [recording, setRecording] = useState(false);

  const { data, loading, error, refetch } = useQuery<{ ad: AdRow }>(`/ads/${id}`, [id]);

  if (loading) return <div className="space-y-4"><CardSkeleton rows={2} /><CardSkeleton rows={4} /></div>;
  if (error || !data) return <Card><ErrorState message={error ?? 'Ad not found'} onRetry={refetch} /></Card>;

  const ad = data.ad;
  const used = ad.budget === 0 ? 0 : ad.spend / ad.budget;

  return (
    <>
      <PageHeader
        title={ad.name}
        subtitle={
          <>
            <Link to={`/restaurants/${ad.restaurant.id}`} className="hover:text-brand">{ad.restaurant.name}</Link>
            {' · '}
            <Link to={`/campaigns/${ad.campaign.id}`} className="hover:text-brand">{ad.campaign.name}</Link>
            {' · '}{humanize(ad.objective)}
          </>
        }
        action={
          <>
            <StatusBadge status={ad.status} kind="campaign" />
            <Button icon={TrendingUp} onClick={() => setRecording(true)}>{t('ads.recordMetrics')}</Button>
          </>
        }
      />

      {ad.metricsRecorded ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <KpiCard label={t('kpi.spend')} value={ad.spend} format="money" compact icon={Wallet} footer={`${Math.round(used * 100)}% of budget`} />
            <KpiCard label={t('kpi.impressions')} value={ad.impressions} compact />
            <KpiCard label={t('kpi.clicks')} value={ad.clicks} compact icon={MousePointerClick} />
            <KpiCard label={t('kpi.roas')} value={ad.metrics.roas} format="ratio" icon={TrendingUp} />
          </div>

          <Card className="mb-4">
            <CardHeader
              title={t('ads.metrics')}
              icon={Target}
              subtitle={ad.metricsAt ? `Recorded ${date(ad.metricsAt, lang)}` : undefined}
            />
            <div className="grid gap-x-6 gap-y-3 p-5 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
              {[
                { label: t('kpi.reach'), value: num(ad.reach, lang) },
                { label: t('kpi.leads'), value: num(ad.leads, lang) },
                { label: t('kpi.conversions'), value: num(ad.conversions, lang) },
                { label: t('kpi.revenue'), value: money(ad.revenue, lang) },
                { label: t('kpi.ctr'), value: pct(ad.metrics.ctr) },
                { label: t('kpi.cpc'), value: money(ad.metrics.cpc, lang) },
                { label: t('kpi.cpm'), value: money(ad.metrics.cpm, lang) },
                { label: t('kpi.costPerLead'), value: ad.leads > 0 ? money(ad.metrics.costPerLead, lang) : '—' },
                { label: t('kpi.cpa'), value: ad.conversions > 0 ? money(ad.metrics.cpa, lang) : '—' },
                { label: t('kpi.convRate'), value: pct(ad.metrics.conversionRate) },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3 border-b border-line/60 pb-2">
                  <span className="text-muted">{row.label}</span>
                  <span className="tabular font-medium text-fg">{row.value}</span>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : (
        <Card className="mb-4">
          <EmptyState
            icon={TrendingUp}
            title={t('ads.neverRecorded')}
            body="Copy the latest figures from the ad platform's reporting. Nothing is fetched automatically, so this ad has no performance data until you enter it."
            action={<Button icon={TrendingUp} onClick={() => setRecording(true)}>{t('ads.recordMetrics')}</Button>}
          />
        </Card>
      )}

      <Card>
        <CardHeader title="Creative and targeting" icon={CalendarRange} />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <div className="space-y-3 text-[13px]">
            {[
              { label: 'Headline', value: ad.headline },
              { label: 'Call to action', value: ad.cta },
              { label: 'Audience', value: ad.audience },
            ].map((row) => (
              <div key={row.label}>
                <p className="text-muted">{row.label}</p>
                <p className="text-fg">{row.value || '—'}</p>
              </div>
            ))}
          </div>
          <div className="space-y-3 text-[13px]">
            <div>
              <p className="text-muted">Primary text</p>
              <p className="whitespace-pre-wrap text-fg">{ad.primaryText || '—'}</p>
            </div>
            <div>
              <p className="text-muted">Flight</p>
              <p className="text-fg">
                {ad.startDate ? date(ad.startDate, lang) : '—'} → {ad.endDate ? date(ad.endDate, lang) : '—'}
              </p>
            </div>
            <div>
              <p className="text-muted">{t('common.budget')}</p>
              <p className="tabular text-fg">{money(ad.budget, lang)}</p>
            </div>
          </div>
        </div>
      </Card>

      <MetricsForm ad={ad} open={recording} onClose={() => setRecording(false)} onSaved={refetch} />
    </>
  );
}
