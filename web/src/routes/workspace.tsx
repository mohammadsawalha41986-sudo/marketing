/** Calendar, media library and notifications. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Bell, CalendarDays, ChevronLeft, ChevronRight, Film, FileText, Image as ImageIcon,
  Search, Trash2, Upload,
} from 'lucide-react';

import {
  api, qs, CONTENT_STATUSES, CONTENT_TYPES, PLATFORMS,
  type MediaType, type Paginated, type Platform, type RestaurantRef,
} from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { bytes, cn } from '../lib/utils';
import { date, dateTime, humanize, isoDate, relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, Tabs, Toggle, useToast,
} from '../components/ui';
import { PlatformChip, StatusBadge } from '../components/domain';
import { ThemeSwitch } from '../components/layout';
import { useAuth } from '../lib/auth';

// ---------------------------------------------------------------- calendar

interface CalendarItem {
  id: string;
  name: string;
  status: string;
  platform: Platform;
  type: string;
  scheduledAt: string | null;
  headline: string | null;
  restaurant: RestaurantRef;
  campaign: { id: string; name: string } | null;
}

const STATUS_DOT: Record<string, string> = {
  IDEA: 'bg-muted/60',
  DRAFT: 'bg-muted',
  READY: 'bg-warn',
  SCHEDULED: 'bg-brand',
  PUBLISHED: 'bg-accent',
  ARCHIVED: 'bg-muted/40',
};

export function CalendarPage({ restaurantId, embedded = false }: { restaurantId?: string; embedded?: boolean } = {}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [view, setView] = useState<'month' | 'week' | 'day' | 'list'>('month');
  const [anchor, setAnchor] = useState(new Date());
  const [platform, setPlatform] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [filterRestaurant, setFilterRestaurant] = useState('');

  const scoped = restaurantId ?? params.get('restaurant') ?? filterRestaurant ?? undefined;
  const restaurants = useQuery<Paginated<RestaurantRef>>(
    embedded ? null : `/restaurants${qs({ pageSize: 100 })}`,
  );

  // The list view is the month's rows without the grid, so it asks the API for
  // a month and renders it differently rather than being its own server view.
  const apiView = view === 'list' ? 'month' : view;

  const { data, loading, error, refetch } = useQuery<{
    view: string;
    range: { from: string; to: string };
    items: CalendarItem[];
    counts: Record<string, number>;
  }>(
    `/calendar${qs({ view: apiView, anchor: isoDate(anchor), restaurantId: scoped || undefined, platform, type, status })}`,
    [apiView, isoDate(anchor), scoped, platform, type, status],
  );

  const shift = (direction: number) => {
    const next = new Date(anchor);
    if (view === 'month') next.setMonth(next.getMonth() + direction);
    else if (view === 'week') next.setDate(next.getDate() + direction * 7);
    else next.setDate(next.getDate() + direction);
    setAnchor(next);
  };

  // Month grid, Monday-first, padded to whole weeks.
  const grid = useMemo(() => {
    if (view !== 'month') return null;
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
  }, [anchor, view]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of data?.items ?? []) {
      if (!item.scheduledAt) continue;
      const key = item.scheduledAt.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [data]);

  const title = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-JO-u-nu-latn' : 'en-US', {
    month: 'long', year: 'numeric',
  }).format(anchor);

  return (
    <>
      {embedded ? null : (
        <PageHeader
          title={t('nav.calendar')}
          subtitle="Everything scheduled across every restaurant."
        />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-elevated p-0.5">
          <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label={t('common.previous')}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <button onClick={() => setAnchor(new Date())} className="px-3 text-[13px] font-medium text-fg">
            {t('common.today')}
          </button>
          <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label={t('common.next')}>
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
        </div>
        <Select value={view} onChange={(event) => setView(event.target.value as typeof view)} className="w-32">
          <option value="month">Month</option>
          <option value="week">Week</option>
          <option value="day">Day</option>
          <option value="list">List</option>
        </Select>
        {embedded ? null : (
          <Select value={filterRestaurant} onChange={(e) => setFilterRestaurant(e.target.value)} className="w-48">
            <option value="">{t('common.restaurant')}</option>
            {restaurants.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
        <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-40">
          <option value="">{t('common.platform')}</option>
          {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-36">
          <option value="">{t('common.type')}</option>
          {CONTENT_TYPES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
          <option value="">{t('common.status')}</option>
          {CONTENT_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(data?.counts ?? {}).map(([status, count]) => (
            <span key={status} className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status] ?? 'bg-muted')} />
              {humanize(status)} {count}
            </span>
          ))}
        </div>
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <CardSkeleton rows={8} />
      ) : view === 'month' && grid ? (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line bg-elevated">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
              <div key={day} className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((day) => {
              const key = isoDate(day);
              const items = byDay.get(key) ?? [];
              const outside = day.getMonth() !== anchor.getMonth();
              const today = key === isoDate(new Date());
              return (
                <div
                  key={key}
                  className={cn(
                    'min-h-[92px] border-b border-e border-line p-1.5 last:border-e-0',
                    outside && 'bg-elevated/40',
                  )}
                >
                  <span
                    className={cn(
                      'mb-1 inline-grid h-6 w-6 place-items-center rounded-full text-[12px]',
                      today ? 'bg-brand font-semibold text-white' : outside ? 'text-muted/50' : 'text-muted',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <div className="space-y-1">
                    {items.slice(0, 3).map((item) => (
                      <button
                        key={item.id}
                        onClick={() => navigate(`/content/${item.id}`)}
                        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-start text-[11px] transition-colors hover:bg-elevated"
                      >
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[item.status] ?? 'bg-muted')} />
                        <span className="truncate text-fg">{item.name}</span>
                      </button>
                    ))}
                    {items.length > 3 ? (
                      <span className="block px-1 text-[11px] text-muted">+{items.length - 3} more</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : data && data.items.length > 0 ? (
        <Card>
          <div className="divide-y divide-line/60">
            {data.items.map((item) => (
              <Link key={item.id} to={`/content/${item.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[item.status] ?? 'bg-muted')} />
                <span className="w-32 shrink-0 text-[13px] text-muted">
                  {item.scheduledAt ? dateTime(item.scheduledAt, lang) : '—'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">{item.name}</span>
                  <span className="block truncate text-[12px] text-muted">{item.restaurant.name}</span>
                </span>
                <PlatformChip platform={item.platform} size="sm" />
                <StatusBadge status={item.status} kind="content" />
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <Card><EmptyState icon={CalendarDays} title={t('empty.calendar.title')} body={t('empty.calendar.body')} /></Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- media

interface MediaRow {
  id: string;
  type: MediaType;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbnailUrl: string | null;
  category: string | null;
  createdAt: string;
  restaurant: RestaurantRef | null;
}

export function MediaPage({ restaurantId, embedded = false }: { restaurantId?: string; embedded?: boolean } = {}) {
  const { t, lang } = useI18n();
  const { push } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [filterRestaurant, setFilterRestaurant] = useState('');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<MediaRow | null>(null);
  const debounced = useDebounced(search);

  const scoped = restaurantId ?? params.get('restaurant') ?? filterRestaurant ?? undefined;

  const restaurants = useQuery<Paginated<RestaurantRef>>(
    embedded ? null : `/restaurants${qs({ pageSize: 100 })}`,
  );
  const { data, loading, error, refetch } = useQuery<Paginated<MediaRow>>(
    `/media${qs({ page, pageSize: 24, search: debounced, type, restaurantId: scoped || undefined })}`,
    [page, debounced, type, scoped],
  );
  const usage = useQuery<{ totalMb: number; byType: Array<{ type: string; count: number }> }>('/media/usage/summary');

  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      const body = new FormData();
      for (const file of Array.from(files).slice(0, 10)) body.append('files', file);
      // Uploads land against the restaurant in scope, so media is filed correctly
      // rather than dropped into a shared pool the operator has to sort later.
      if (scoped) body.append('restaurantId', scoped);
      const response = await api.post<{ items: MediaRow[] }>('/media', body);
      push({ tone: 'success', title: `${response.items.length} file(s) uploaded` });
      refetch();
      usage.refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Upload failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.delete(`/media/${id}`);
      push({ tone: 'success', title: 'Deleted' });
      setPreview(null);
      refetch();
      usage.refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not delete', body: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => event.target.files && upload(event.target.files)}
      />

      {embedded ? null : (
        <PageHeader
          title={t('nav.media')}
          subtitle={usage.data ? `${usage.data.totalMb} MB stored across ${data?.pagination.total ?? 0} files` : undefined}
          action={<Button icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{t('common.upload')}</Button>}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        {embedded ? null : (
          <Select value={filterRestaurant} onChange={(e) => { setFilterRestaurant(e.target.value); setPage(1); }} className="w-48">
            <option value="">{t('common.restaurant')}</option>
            {restaurants.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-40">
          <option value="">{t('common.all')}</option>
          {['IMAGE', 'VIDEO', 'DOCUMENT', 'LOGO'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        {embedded ? <Button icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{t('common.upload')}</Button> : null}
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, index) => <div key={index} className="skeleton aspect-square" />)}
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {data.items.map((item) => (
              <motion.button
                key={item.id}
                layout
                onClick={() => setPreview(item)}
                className="group relative aspect-square overflow-hidden rounded-xl border border-line bg-elevated"
              >
                {item.type === 'IMAGE' || item.type === 'LOGO' ? (
                  <img src={item.thumbnailUrl ?? item.url} alt={item.originalName} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy" />
                ) : (
                  <span className="grid h-full w-full place-items-center text-muted">
                    {item.type === 'VIDEO' ? <Film className="h-7 w-7" /> : <FileText className="h-7 w-7" />}
                  </span>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-start opacity-0 transition-opacity group-hover:opacity-100">
                  <span className="block truncate text-[11px] text-white">{item.originalName}</span>
                  <span className="block text-[10px] text-white/70">{bytes(item.sizeBytes)}</span>
                </span>
              </motion.button>
            ))}
          </div>
          <Card className="mt-4"><Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} /></Card>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={ImageIcon}
            title={debounced ? t('empty.search.title') : t('empty.media.title')}
            body={debounced ? t('empty.search.body') : t('empty.media.body')}
            action={<Button icon={Upload} onClick={() => fileRef.current?.click()}>{t('common.upload')}</Button>}
          />
        </Card>
      )}

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.originalName ?? ''}
        size="lg"
        footer={
          preview ? <Button variant="danger" icon={Trash2} onClick={() => remove(preview.id)}>{t('common.delete')}</Button> : null
        }
      >
        {preview ? (
          <div className="space-y-4">
            <div className="grid max-h-[50vh] place-items-center overflow-hidden rounded-xl bg-elevated">
              {preview.type === 'IMAGE' || preview.type === 'LOGO' ? (
                <img src={preview.url} alt={preview.originalName} className="max-h-[50vh] object-contain" />
              ) : preview.type === 'VIDEO' ? (
                <video src={preview.url} controls className="max-h-[50vh]" />
              ) : (
                <a href={preview.url} target="_blank" rel="noreferrer" className="p-10 text-brand hover:underline">
                  Open file
                </a>
              )}
            </div>
            <div className="grid gap-3 text-[13px] sm:grid-cols-2">
              {[
                { label: 'Type', value: preview.mimeType },
                { label: 'Size', value: bytes(preview.sizeBytes) },
                { label: 'Dimensions', value: preview.width ? `${preview.width} × ${preview.height}` : '—' },
                { label: t('common.restaurant'), value: preview.restaurant?.name ?? 'Shared' },
                { label: 'Uploaded', value: date(preview.createdAt, lang) },
                { label: 'Category', value: preview.category ?? '—' },
              ].map((row) => (
                <div key={row.label} className="flex justify-between gap-3">
                  <span className="text-muted">{row.label}</span>
                  <span className="text-fg">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- notifications

export function NotificationsPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const { data, loading, refetch } = useQuery<Paginated<{
    id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string;
  }> & { unread: number }>(`/notifications${qs({ page, pageSize: 25, unreadOnly })}`, [page, unreadOnly]);

  return (
    <>
      <PageHeader
        title={t('nav.notifications')}
        subtitle={data ? `${data.unread} unread` : undefined}
        action={
          <>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Unread only
              <Toggle checked={unreadOnly} onChange={(value) => { setUnreadOnly(value); setPage(1); }} label="Unread only" />
            </label>
            <Button variant="secondary" onClick={async () => { await api.post('/notifications/read-all'); refetch(); }}>
              Mark all read
            </Button>
          </>
        }
      />

      {loading ? (
        <CardSkeleton rows={6} />
      ) : data && data.items.length > 0 ? (
        <Card>
          <div className="divide-y divide-line/60">
            {data.items.map((item) => (
              <button
                key={item.id}
                onClick={async () => {
                  await api.post(`/notifications/${item.id}/read`);
                  refetch();
                  if (item.link) navigate(item.link);
                }}
                className={cn('flex w-full items-start gap-3 px-5 py-3.5 text-start transition-colors hover:bg-elevated', !item.readAt && 'bg-brand/[0.04]')}
              >
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', item.readAt ? 'bg-transparent' : 'bg-brand')} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-fg">{item.title}</span>
                  {item.body ? <span className="mt-0.5 block text-[13px] text-muted">{item.body}</span> : null}
                  <span className="mt-1 block text-[12px] text-muted/80">{relative(item.createdAt, lang)}</span>
                </span>
                <Badge>{humanize(item.type)}</Badge>
              </button>
            ))}
          </div>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : (
        <Card><EmptyState icon={Bell} title={t('empty.notifications.title')} body={t('empty.notifications.body')} /></Card>
      )}
    </>
  );
}


// ---------------------------------------------------------------- settings

interface SettingsResponse {
  workspace: {
    id: string; name: string; currency: string; timezone: string;
    locale: 'AR' | 'EN'; logoUrl: string | null;
  };
  ai: { provider: string; model: string; configured: boolean };
  storage: { driver: string; files: number; bytes: number; megabytes: number; maxUploadMb: number };
  totals: { restaurants: number; campaigns: number; contents: number; ads: number };
}

interface AdapterInfo {
  platform: Platform;
  label: string;
  implemented: boolean;
  ready: boolean;
  missingEnv: string[];
  docsUrl: string;
}

/** Currencies offered in the picker. Any ISO code the API accepts still works. */
const CURRENCIES = ['SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'EGP', 'JOD', 'USD', 'EUR', 'GBP'];

export function SettingsPage() {
  const { t } = useI18n();
  const { user, refresh } = useAuth();
  const { push } = useToast();
  const [tab, setTab] = useState<'workspace' | 'profile' | 'security' | 'integrations'>('workspace');
  const [saving, setSaving] = useState(false);

  const settings = useQuery<SettingsResponse>('/settings');
  const catalog = useQuery<{ adapters: AdapterInfo[] }>('/integrations/catalog');

  const [workspace, setWorkspace] = useState({ name: '', currency: 'SAR', timezone: '', locale: 'EN' });
  const [name, setName] = useState(user?.name ?? '');
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });

  // Seed the form once the current settings arrive.
  useEffect(() => {
    if (settings.data) {
      const w = settings.data.workspace;
      setWorkspace({ name: w.name, currency: w.currency, timezone: w.timezone, locale: w.locale });
    }
  }, [settings.data]);

  const saveWorkspace = async () => {
    setSaving(true);
    try {
      await api.patch('/settings', workspace);
      // The currency drives every money figure in the UI, so the session is
      // refreshed rather than waiting for the next full page load.
      await refresh();
      settings.refetch();
      push({ tone: 'success', title: 'Settings saved' });
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      await api.patch('/auth/me', { name: name.trim() });
      await refresh();
      push({ tone: 'success', title: 'Profile updated' });
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setSaving(true);
    try {
      await api.post('/auth/change-password', passwords);
      push({ tone: 'success', title: 'Password changed', body: 'Sign in again with the new password.' });
      window.location.href = '/login';
    } catch (err) {
      push({ tone: 'error', title: 'Could not change password', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={t('nav.settings')} subtitle={user?.email} />

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'workspace', label: t('nav.workspace') },
          { value: 'profile', label: 'Profile' },
          { value: 'security', label: 'Security' },
          { value: 'integrations', label: t('nav.integrations') },
        ]}
      />

      {tab === 'workspace' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Workspace" subtitle="Applies across the whole application." />
            <div className="space-y-4 p-5">
              <Field label="Application name">
                <Input value={workspace.name} onChange={(e) => setWorkspace({ ...workspace, name: e.target.value })} />
              </Field>
              <Field label="Default currency" hint="Used for budgets, spend and reports.">
                <Select value={workspace.currency} onChange={(e) => setWorkspace({ ...workspace, currency: e.target.value })}>
                  {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                </Select>
              </Field>
              <Field label="Timezone">
                <Input value={workspace.timezone} onChange={(e) => setWorkspace({ ...workspace, timezone: e.target.value })} placeholder="Asia/Riyadh" />
              </Field>
              <Field label={t('common.language')}>
                <Select value={workspace.locale} onChange={(e) => setWorkspace({ ...workspace, locale: e.target.value })}>
                  <option value="EN">English</option>
                  <option value="AR">العربية</option>
                </Select>
              </Field>
              <Field label={t('theme.label')}><div><ThemeSwitch /></div></Field>
              <Button onClick={saveWorkspace} loading={saving}>{t('common.save')}</Button>
            </div>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader title="Storage" subtitle={`Driver: ${settings.data?.storage.driver ?? '—'}`} />
              <div className="space-y-3 p-5 text-[13px]">
                {[
                  { label: 'Files', value: String(settings.data?.storage.files ?? 0) },
                  { label: 'Stored', value: `${settings.data?.storage.megabytes ?? 0} MB` },
                  { label: 'Max upload', value: `${settings.data?.storage.maxUploadMb ?? 0} MB` },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3">
                    <span className="text-muted">{row.label}</span>
                    <span className="tabular font-medium text-fg">{row.value}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader title="AI" />
              <div className="p-5">
                {settings.data?.ai.configured ? (
                  <>
                    <Badge tone="ok" dot>Configured</Badge>
                    <p className="mt-3 text-[13px] leading-relaxed text-muted">
                      Generation calls {settings.data.ai.model}. The key stays server-side and never reaches the browser.
                    </p>
                  </>
                ) : (
                  <>
                    <Badge tone="warn" dot>Built-in engine</Badge>
                    <p className="mt-3 text-[13px] leading-relaxed text-muted">
                      No <code className="rounded bg-elevated px-1">OPENAI_API_KEY</code> is set, so the built-in
                      template engine writes the copy and every result is labelled as such. Generation keeps working
                      either way — the key only changes which engine answers.
                    </p>
                  </>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Contents" />
              <div className="grid grid-cols-2 gap-3 p-5 text-center">
                {[
                  { label: t('nav.restaurants'), value: settings.data?.totals.restaurants ?? 0 },
                  { label: t('nav.campaigns'), value: settings.data?.totals.campaigns ?? 0 },
                  { label: t('nav.content'), value: settings.data?.totals.contents ?? 0 },
                  { label: t('nav.ads'), value: settings.data?.totals.ads ?? 0 },
                ].map((stat) => (
                  <div key={stat.label}>
                    <p className="tabular text-2xl font-semibold text-fg">{stat.value}</p>
                    <p className="text-[12px] uppercase tracking-wide text-muted">{stat.label}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'profile' ? (
        <Card className="max-w-2xl">
          <CardHeader title="Your profile" subtitle="The one account on this system." />
          <div className="space-y-4 p-5">
            <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Email"><Input value={user?.email ?? ''} disabled /></Field>
            <Button onClick={saveProfile} loading={saving}>{t('common.save')}</Button>
          </div>
        </Card>
      ) : null}

      {tab === 'security' ? (
        <Card className="max-w-2xl">
          <CardHeader title="Change password" subtitle="Changing it signs you out of every other session." />
          <div className="space-y-4 p-5">
            <Field label="Current password">
              <Input type="password" value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="At least 10 characters, with upper case, lower case and a digit.">
              <Input type="password" value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} autoComplete="new-password" />
            </Field>
            <Button onClick={changePassword} loading={saving} disabled={!passwords.currentPassword || !passwords.newPassword}>
              Change password
            </Button>
            <p className="text-[13px] leading-relaxed text-muted">
              There is no password-reset email on this system. If you lose access, reset the password from the server
              with <code className="rounded bg-elevated px-1">npm run owner:create</code>.
            </p>
          </div>
        </Card>
      ) : null}

      {tab === 'integrations' ? (
        <Card>
          <CardHeader
            title={t('nav.integrations')}
            subtitle="Architecture only. No adapter is implemented, and none reports a connection it does not have."
          />
          <div className="divide-y divide-line/60">
            {catalog.data?.adapters.map((adapter) => (
              <div key={adapter.platform} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <PlatformChip platform={adapter.platform} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg">{adapter.label}</p>
                  <p className="text-[12px] text-muted">
                    {adapter.missingEnv.length > 0
                      ? `Needs ${adapter.missingEnv.join(', ')}`
                      : 'Credentials present; adapter not implemented'}
                  </p>
                </div>
                <Badge tone="neutral">{t('integration.notImplemented')}</Badge>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}
