/**
 * The restaurant roster, and the per-restaurant workspace.
 *
 * The workspace tabs do not reimplement content, campaigns, ads, media,
 * analytics or reports. Each tab renders the same page the sidebar does, scoped
 * to one restaurant via `restaurantId` — so a fix to the content list is a fix
 * in both places, and the two can never drift apart.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Archive, CalendarDays, ChartNoAxesCombined, ExternalLink, Globe, Mail, MapPin, PenLine, Phone,
  Plus, Search, Store, Target, Trash2, Utensils,
} from 'lucide-react';

import {
  api, qs, RESTAURANT_STATUSES,
  type Metrics, type Paginated, type RestaurantStatus,
} from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { humanize, money, num, pct, ratio, relative } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, Pagination, Select, Tabs, Textarea, useToast,
} from '../components/ui';
import { KpiCard, PlatformChip, StatusBadge } from '../components/domain';

import { ContentPage } from './content';
import { CampaignsPage } from './campaigns';
import { AdsPage } from './ads';
import { BrandPage } from './brand';
import { CalendarPage, MediaPage } from './workspace';
import { AnalyticsPage, ReportsPage } from './insights';
import { TasksPage } from './tasks';

interface RestaurantRow {
  id: string;
  name: string;
  businessName: string;
  email: string | null;
  phone: string | null;
  cuisine: string | null;
  website: string | null;
  location: string | null;
  status: RestaurantStatus;
  logoUrl: string | null;
  brand: { primaryColor: string; accentColor: string; logoUrl: string | null } | null;
  _count: { campaigns: number; contents: number; ads: number; media: number };
}

function RestaurantForm({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = {
    name: '', businessName: '', email: '', phone: '', cuisine: '', description: '',
    website: '', location: '', address: '', notes: '', preferredLanguage: 'EN',
  };
  const [form, setForm] = useState(blank);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/restaurants', {
        ...form,
        website: form.website.trim() || undefined,
        email: form.email.trim() || undefined,
      });
      push({ tone: 'success', title: 'Restaurant added', body: 'Build its brand identity next.' });
      onSaved();
      onClose();
      setForm(blank);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the restaurant');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a restaurant"
      subtitle="A brand profile is created automatically so the AI can write in its voice."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button form="restaurant-form" type="submit" loading={busy}>Add restaurant</Button>
        </>
      }
    >
      <form id="restaurant-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Restaurant name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Sabah Al Leil" />
        </Field>
        <Field label="Legal or trading name" required>
          <Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} required />
        </Field>
        <Field label="Cuisine">
          <Input value={form.cuisine} onChange={(e) => setForm({ ...form, cuisine: e.target.value })} placeholder="Lebanese, Grill, Café…" />
        </Field>
        <Field label="City or area">
          <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Riyadh" />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Website" hint="Include https://">
          <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
        </Field>
        <Field label="Content language">
          <Select value={form.preferredLanguage} onChange={(e) => setForm({ ...form, preferredLanguage: e.target.value })}>
            <option value="EN">English</option>
            <option value="AR">العربية</option>
          </Select>
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="What the restaurant is known for." />
        </Field>
        <Field label="Notes" className="sm:col-span-2" error={error ?? undefined}>
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </Field>
      </form>
    </Modal>
  );
}

export function RestaurantsPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search);

  const { data, loading, error, refetch } = useQuery<Paginated<RestaurantRow>>(
    `/restaurants${qs({ page, pageSize: 12, search: debounced, status })}`,
    [page, debounced, status],
  );

  return (
    <>
      <PageHeader
        title={t('nav.restaurants')}
        subtitle="Every restaurant you market for, with its own brand, content and reporting."
        action={<Button icon={Plus} onClick={() => setCreating(true)}>Add restaurant</Button>}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t('common.search')}
            className="ps-9"
          />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.all')}</option>
          {RESTAURANT_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => <CardSkeleton key={index} />)}
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((restaurant) => (
              <Card
                key={restaurant.id}
                hover
                className="cursor-pointer overflow-hidden"
                onClick={() => navigate(`/restaurants/${restaurant.id}`)}
              >
                <span
                  className="block h-1"
                  style={{
                    background: restaurant.brand
                      ? `linear-gradient(90deg, ${restaurant.brand.primaryColor}, ${restaurant.brand.accentColor})`
                      : 'rgb(var(--c-line))',
                  }}
                />
                <div className="p-5">
                  <div className="flex items-start gap-3">
                    <Avatar name={restaurant.businessName} src={restaurant.logoUrl} size={44} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-fg">{restaurant.name}</p>
                      <p className="truncate text-[13px] text-muted">{restaurant.cuisine ?? '—'}</p>
                    </div>
                    <StatusBadge status={restaurant.status} kind="campaign" />
                  </div>

                  {restaurant.location ? (
                    <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
                      <MapPin className="h-3.5 w-3.5" /> {restaurant.location}
                    </p>
                  ) : null}

                  <div className="mt-4 grid grid-cols-4 gap-2 border-t border-line pt-3.5 text-center">
                    {[
                      { label: t('nav.campaigns'), value: restaurant._count.campaigns },
                      { label: t('nav.content'), value: restaurant._count.contents },
                      { label: t('nav.ads'), value: restaurant._count.ads },
                      { label: t('nav.media'), value: restaurant._count.media },
                    ].map((stat) => (
                      <div key={stat.label}>
                        <p className="tabular text-lg font-semibold text-fg">{num(stat.value, lang)}</p>
                        <p className="truncate text-[11px] uppercase tracking-wide text-muted">{stat.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <Card className="mt-4">
            <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
          </Card>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={Store}
            title={debounced || status ? t('empty.search.title') : t('empty.restaurants.title')}
            body={debounced || status ? t('empty.search.body') : t('empty.restaurants.body')}
            action={!debounced ? <Button icon={Plus} onClick={() => setCreating(true)}>Add restaurant</Button> : undefined}
          />
        </Card>
      )}

      <RestaurantForm open={creating} onClose={() => setCreating(false)} onSaved={refetch} />
    </>
  );
}

// ---------------------------------------------------------------- workspace

interface RestaurantDetail extends RestaurantRow {
  description: string | null;
  address: string | null;
  branches: string[];
  marketingObjectives: string[];
  notes: string | null;
  coverUrl: string | null;
  socialLinks: Record<string, string>;
  googleBusiness: Record<string, string>;
  brand: (RestaurantRow['brand'] & { id: string; businessName: string; toneOfVoice: string | null; targetAudience: string | null }) | null;
  integrations: Array<{ id: string; platform: string; status: string; accountName: string | null }>;
  _count: { campaigns: number; contents: number; ads: number; media: number; reports: number; tasks: number };
}

interface Overview {
  metrics: Metrics;
  campaignsByStatus: Record<string, number>;
  ads: {
    count: number; spend: number; impressions: number; reach: number;
    clicks: number; leads: number; conversions: number; revenue: number;
  };
  scheduled: number;
  publishedThisMonth: number;
  openTasks: number;
  upcoming: Array<{ id: string; name: string; type: string; platform: string; scheduledAt: string | null }>;
  recentContent: Array<{ id: string; name: string; status: string; type: string; platform: string; updatedAt: string }>;
  window: { from: string; to: string; days: number };
}

const TABS = [
  'overview', 'brand', 'content', 'campaigns', 'ads',
  'calendar', 'media', 'analytics', 'reports', 'tasks',
] as const;
type TabKey = (typeof TABS)[number];

export function RestaurantWorkspacePage() {
  const { id = '', tab: tabParam } = useParams();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { push } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The tab lives in the URL so a workspace view is linkable and survives reload.
  const tab: TabKey = TABS.includes(tabParam as TabKey) ? (tabParam as TabKey) : 'overview';

  const { data, loading, error, refetch } = useQuery<{ restaurant: RestaurantDetail }>(`/restaurants/${id}`, [id]);
  const overview = useQuery<Overview>(`/restaurants/${id}/overview`, [id]);

  const archive = async () => {
    try {
      await api.post(`/restaurants/${id}/archive`);
      push({ tone: 'success', title: 'Restaurant archived' });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not archive', body: err instanceof Error ? err.message : undefined });
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/restaurants/${id}`);
      push({ tone: 'success', title: 'Restaurant deleted' });
      navigate('/restaurants');
    } catch (err) {
      push({ tone: 'error', title: 'Could not delete', body: err instanceof Error ? err.message : undefined });
    }
  };

  if (loading) return <div className="space-y-4"><CardSkeleton rows={2} /><CardSkeleton rows={4} /></div>;
  if (error || !data) return <Card><ErrorState message={error ?? 'Restaurant not found'} onRetry={refetch} /></Card>;

  const restaurant = data.restaurant;
  const metrics = overview.data?.metrics;
  const ads = overview.data?.ads;

  return (
    <>
      <PageHeader
        title={restaurant.name}
        subtitle={[restaurant.cuisine, restaurant.location].filter(Boolean).join(' · ') || restaurant.businessName}
        action={
          <>
            <Button variant="secondary" onClick={() => navigate(`/ai?restaurant=${restaurant.id}`)}>{t('nav.ai')}</Button>
            <Button onClick={() => navigate(`/content?restaurant=${restaurant.id}`)} icon={PenLine}>{t('dash.newContent')}</Button>
          </>
        }
      />

      <Card className="mb-4 overflow-hidden">
        <span
          className="block h-1.5"
          style={{
            background: restaurant.brand
              ? `linear-gradient(90deg, ${restaurant.brand.primaryColor}, ${restaurant.brand.accentColor})`
              : 'rgb(var(--c-line))',
          }}
        />
        <div className="flex flex-wrap items-center gap-4 p-5">
          <Avatar name={restaurant.businessName} src={restaurant.logoUrl} size={56} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-fg">{restaurant.businessName}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
              {restaurant.cuisine ? <span className="flex items-center gap-1.5"><Utensils className="h-3.5 w-3.5" />{restaurant.cuisine}</span> : null}
              {restaurant.email ? <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />{restaurant.email}</span> : null}
              {restaurant.phone ? <span className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" />{restaurant.phone}</span> : null}
              {restaurant.website ? (
                <a href={restaurant.website} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-brand">
                  <Globe className="h-3.5 w-3.5" />Website<ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          </div>
          <StatusBadge status={restaurant.status} kind="campaign" />
        </div>
      </Card>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={(next) => navigate(`/restaurants/${id}/${next}`)}
        tabs={[
          { value: 'overview', label: t('nav.overview') },
          { value: 'brand', label: t('nav.brand') },
          { value: 'content', label: t('nav.content'), count: restaurant._count.contents },
          { value: 'campaigns', label: t('nav.campaigns'), count: restaurant._count.campaigns },
          { value: 'ads', label: t('nav.ads'), count: restaurant._count.ads },
          { value: 'calendar', label: t('nav.calendar') },
          { value: 'media', label: t('nav.media'), count: restaurant._count.media },
          { value: 'analytics', label: t('nav.analytics') },
          { value: 'reports', label: t('nav.reports'), count: restaurant._count.reports },
          { value: 'tasks', label: t('nav.tasks'), count: restaurant._count.tasks },
        ]}
      />

      {tab === 'overview' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {overview.loading || !metrics ? (
              Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
            ) : (
              <>
                <KpiCard label={t('kpi.spend')} value={metrics.spend} format="money" compact />
                <KpiCard label={t('kpi.reach')} value={metrics.reach} compact />
                <KpiCard label={t('kpi.leads')} value={metrics.leads} />
                <KpiCard label={t('kpi.roas')} value={metrics.roas} format="ratio" />
              </>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title={t('dash.publishingWeek')}
                icon={CalendarDays}
                action={<Link to={`/restaurants/${id}/calendar`} className="text-[13px] text-brand hover:underline">{t('common.viewAll')}</Link>}
              />
              <div className="divide-y divide-line/60">
                {overview.data?.upcoming.length ? (
                  overview.data.upcoming.map((item) => (
                    <Link key={item.id} to={`/content/${item.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-fg">{item.name}</p>
                        <p className="text-[12px] text-muted">
                          {humanize(item.type)} · {item.scheduledAt ? relative(item.scheduledAt, lang) : '—'}
                        </p>
                      </div>
                      <PlatformChip platform={item.platform} size="sm" />
                    </Link>
                  ))
                ) : (
                  <EmptyState icon={CalendarDays} title={t('empty.calendar.title')} body={t('empty.calendar.body')} />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Marketing health" icon={ChartNoAxesCombined} />
              <div className="space-y-3 p-4 text-[13px]">
                {[
                  { label: t('kpi.published'), value: num(overview.data?.publishedThisMonth ?? 0, lang) },
                  { label: t('kpi.scheduled'), value: num(overview.data?.scheduled ?? 0, lang) },
                  { label: t('kpi.tasks'), value: num(overview.data?.openTasks ?? 0, lang) },
                  { label: t('kpi.impressions'), value: metrics ? num(metrics.impressions, lang, true) : '—' },
                  { label: t('kpi.engagementRate'), value: metrics ? pct(metrics.engagementRate) : '—' },
                  { label: t('kpi.ctr'), value: metrics ? pct(metrics.ctr) : '—' },
                  { label: t('kpi.cpc'), value: metrics ? money(metrics.cpc, lang) : '—' },
                  { label: t('kpi.conversions'), value: metrics ? num(metrics.conversions, lang) : '—' },
                  { label: t('kpi.revenue'), value: metrics ? money(metrics.revenue, lang, true) : '—' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3">
                    <span className="text-muted">{row.label}</span>
                    <span className="tabular font-medium text-fg">{row.value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader
                title={t('nav.ads')}
                icon={Target}
                subtitle={ads?.count ? t('ads.manualNotice') : undefined}
                action={<Link to={`/restaurants/${id}/ads`} className="text-[13px] text-brand hover:underline">{t('common.viewAll')}</Link>}
              />
              <div className="space-y-3 p-4 text-[13px]">
                {ads && ads.count > 0 ? (
                  [
                    { label: t('kpi.adSpend'), value: money(ads.spend, lang, true) },
                    { label: t('kpi.impressions'), value: num(ads.impressions, lang, true) },
                    { label: t('kpi.clicks'), value: num(ads.clicks, lang, true) },
                    { label: t('kpi.leads'), value: num(ads.leads, lang) },
                    { label: t('kpi.conversions'), value: num(ads.conversions, lang) },
                    { label: t('kpi.roas'), value: ratio(ads.spend === 0 ? 0 : ads.revenue / ads.spend) },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3">
                      <span className="text-muted">{row.label}</span>
                      <span className="tabular font-medium text-fg">{row.value}</span>
                    </div>
                  ))
                ) : (
                  <p className="py-6 text-center text-muted">{t('empty.ads.body')}</p>
                )}
              </div>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader
                title="Recent content"
                icon={PenLine}
                action={<Link to={`/restaurants/${id}/content`} className="text-[13px] text-brand hover:underline">{t('common.viewAll')}</Link>}
              />
              <div className="divide-y divide-line/60">
                {overview.data?.recentContent.length ? (
                  overview.data.recentContent.map((item) => (
                    <Link key={item.id} to={`/content/${item.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-fg">{item.name}</p>
                        <p className="text-[12px] text-muted">{humanize(item.type)}</p>
                      </div>
                      <PlatformChip platform={item.platform} size="sm" />
                      <StatusBadge status={item.status} kind="content" />
                    </Link>
                  ))
                ) : (
                  <EmptyState icon={PenLine} title={t('empty.content.title')} body={t('empty.content.body')} />
                )}
              </div>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title="Profile" icon={Store} />
            <div className="grid gap-5 p-5 sm:grid-cols-2">
              <div className="space-y-3 text-[13px]">
                {[
                  { label: 'Address', value: restaurant.address ?? '—' },
                  { label: 'Branches', value: restaurant.branches.join(', ') || '—' },
                  { label: t('brand.audience'), value: restaurant.brand?.targetAudience ?? '—' },
                  { label: t('brand.voice'), value: restaurant.brand?.toneOfVoice ?? '—' },
                ].map((row) => (
                  <div key={row.label}>
                    <p className="text-muted">{row.label}</p>
                    <p className="text-fg">{row.value}</p>
                  </div>
                ))}
              </div>
              <div className="space-y-3 text-[13px]">
                <div>
                  <p className="text-muted">Marketing objectives</p>
                  {restaurant.marketingObjectives.length > 0 ? (
                    <ul className="mt-1 list-inside list-disc text-fg">
                      {restaurant.marketingObjectives.map((objective) => <li key={objective}>{objective}</li>)}
                    </ul>
                  ) : <p className="text-fg">—</p>}
                </div>
                <div>
                  <p className="text-muted">Notes</p>
                  <p className="whitespace-pre-wrap text-fg">{restaurant.notes ?? '—'}</p>
                </div>
                {Object.keys(restaurant.socialLinks).length > 0 ? (
                  <div>
                    <p className="text-muted">Social</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.entries(restaurant.socialLinks).map(([key, value]) => (
                        <a key={key} href={value} target="_blank" rel="noreferrer">
                          <Badge tone="brand">{key}</Badge>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-5">
              <div>
                <p className="text-sm font-medium text-fg">Retire this restaurant</p>
                <p className="text-[13px] text-muted">
                  Archiving keeps every campaign, report and figure and moves it out of the way. Deleting removes all of it.
                </p>
              </div>
              <div className="flex gap-2">
                {restaurant.status !== 'ARCHIVED' ? (
                  <Button variant="secondary" icon={Archive} onClick={archive}>{t('common.archive')}</Button>
                ) : null}
                <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)}>{t('common.delete')}</Button>
              </div>
            </div>
          </Card>
        </>
      ) : null}

      {/*
        Each tab below renders the same page the sidebar shows, scoped to this
        restaurant. `embedded` drops the page header and the restaurant filter,
        both of which the workspace already provides.
      */}
      {tab === 'brand' ? <BrandPage restaurantId={id} embedded /> : null}
      {tab === 'content' ? <ContentPage restaurantId={id} embedded /> : null}
      {tab === 'campaigns' ? <CampaignsPage restaurantId={id} embedded /> : null}
      {tab === 'ads' ? <AdsPage restaurantId={id} embedded /> : null}
      {tab === 'calendar' ? <CalendarPage restaurantId={id} embedded /> : null}
      {tab === 'media' ? <MediaPage restaurantId={id} embedded /> : null}
      {tab === 'analytics' ? <AnalyticsPage restaurantId={id} embedded /> : null}
      {tab === 'reports' ? <ReportsPage restaurantId={id} embedded /> : null}
      {tab === 'tasks' ? <TasksPage restaurantId={id} embedded /> : null}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${restaurant.name}?`}
        subtitle="Everything belonging to this restaurant is removed permanently."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={remove}>{t('common.delete')}</Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {restaurant._count.campaigns} campaigns, {restaurant._count.contents} content items,{' '}
          {restaurant._count.ads} ads, {restaurant._count.media} media files and{' '}
          {restaurant._count.reports} reports will be deleted. Archive instead if you may need the history.
        </p>
      </Modal>
    </>
  );
}
