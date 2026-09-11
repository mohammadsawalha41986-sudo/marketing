/** Calendar, media library, approvals, integrations, notifications and settings. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Bell, Building2, CalendarDays, Check, ChevronLeft, ChevronRight, Film, FileText, Image as ImageIcon,
  Link2, MessageSquare, Plug, Search, Send, ThumbsUp, Trash2, Upload, X,
} from 'lucide-react';

import { api, qs, type ApprovalStatus, type MediaType, type Paginated, type Platform } from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { bytes, cn } from '../lib/utils';
import {
  accountKindLabel, accountPickerCopy, compareAccountKinds, formatExternalId, parentAccountLine,
} from '../lib/account-picker';
import { date, dateTime, humanize, isoDate, relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, Drawer, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, Spinner, Tabs, Textarea, Toggle, useToast,
} from '../components/ui';
import { PlatformChip, StatusBadge } from '../components/domain';
import { ContentPreview } from '../components/content-preview';
import { ThemeSwitch } from '../components/layout';

// ---------------------------------------------------------------- calendar

interface CalendarItem {
  id: string;
  name: string;
  status: string;
  platform: Platform;
  type: string;
  scheduledAt: string | null;
  headline: string | null;
  client: { id: string; name: string; logoUrl: string | null };
  campaign: { id: string; name: string } | null;
}

/**
 * Peek at a scheduled post without leaving the calendar.
 *
 * The calendar endpoint returns scheduling facts — a name, a time, a status —
 * because that is what a month grid needs. It does not return the caption or
 * the creative, so this fetches the content itself and hands it to the same
 * ContentPreview every other screen uses. The alternative was a second,
 * thinner preview that would drift from the real one.
 */
function CalendarPeek({ id, base, onClose }: { id: string | null; base: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { data, loading, error } = useQuery<{
    content: {
      id: string;
      name: string;
      status: string;
      type: string;
      platform: Platform;
      headline: string | null;
      caption: string | null;
      cta: string | null;
      scheduledAt: string | null;
      client: { businessName: string; logoUrl: string | null };
      hashtags: Array<{ tag: string }>;
      mediaLinks: Array<{ media: { url: string; type: string; thumbnailUrl: string | null } }>;
    };
  }>(id ? `/content/${id}` : null, [id]);

  const content = data?.content;

  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      title={content?.name ?? 'Scheduled post'}
      footer={
        content ? (
          <Button className="w-full" onClick={() => navigate(`${base}/content/${content.id}`)}>
            Open
          </Button>
        ) : null
      }
    >
      {loading ? (
        <div className="grid place-items-center py-16"><Spinner className="h-6 w-6" /></div>
      ) : error ? (
        <ErrorState message={error} />
      ) : content ? (
        <ContentPreview
          platform={content.platform}
          surface={content.type === 'STORY' ? 'STORY' : content.type === 'REEL' ? 'REEL' : 'FEED'}
          brandName={content.client.businessName}
          logoUrl={content.client.logoUrl}
          headline={content.headline}
          caption={content.caption}
          cta={content.cta}
          hashtags={content.hashtags.map((tag) => tag.tag)}
          media={
            content.mediaLinks[0]
              ? {
                  url: content.mediaLinks[0].media.url,
                  kind: content.mediaLinks[0].media.type === 'VIDEO' ? 'VIDEO' : 'IMAGE',
                  posterUrl: content.mediaLinks[0].media.thumbnailUrl,
                }
              : null
          }
          status={content.status}
          scheduledAt={content.scheduledAt}
        />
      ) : null}
    </Drawer>
  );
}

const STATUS_DOT: Record<string, string> = {
  DRAFT: 'bg-muted',
  SUBMITTED: 'bg-warn',
  APPROVED: 'bg-ok',
  SCHEDULED: 'bg-brand',
  PUBLISHED: 'bg-accent',
  FAILED: 'bg-danger',
  REJECTED: 'bg-danger',
  CHANGES_REQUESTED: 'bg-warn',
};

export function CalendarPage({ portal = false }: { portal?: boolean }) {
  const { t, lang } = useI18n();

  const [view, setView] = useState<'month' | 'week' | 'day'>('month');
  const [anchor, setAnchor] = useState(new Date());
  const [peek, setPeek] = useState<string | null>(null);

  // The month grid shows the restaurant chosen in the top bar, or all of them.
  const { currentId: clientId, current } = useRestaurant();

  const { data, loading, error, refetch } = useQuery<{
    view: string;
    range: { from: string; to: string };
    items: CalendarItem[];
    counts: Record<string, number>;
  }>(`/calendar${qs({ view, anchor: isoDate(anchor), clientId })}`, [view, isoDate(anchor), clientId]);

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

  const base = portal ? '/client' : '/app';
  const title = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-JO-u-nu-latn' : 'en-US', {
    month: 'long', year: 'numeric',
  }).format(anchor);

  return (
    <>
      <PageHeader
        title={t('nav.calendar')}
        subtitle={
          current
            ? `Everything scheduled for ${current.businessName}, colour-coded by where it is in the workflow.`
            : 'Everything scheduled, colour-coded by where it is in the workflow.'
        }
        action={
          <>
            <div className="flex items-center gap-1 rounded-xl border border-line bg-elevated p-0.5">
              <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label="Previous">
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
              </Button>
              <button onClick={() => setAnchor(new Date())} className="px-3 text-[13px] font-medium text-fg">
                {t('common.today')}
              </button>
              <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label="Next">
                <ChevronRight className="h-4 w-4 rtl:rotate-180" />
              </Button>
            </div>
            <Select value={view} onChange={(event) => setView(event.target.value as typeof view)} className="w-32">
              <option value="month">Month</option>
              <option value="week">Week</option>
              <option value="day">Day</option>
            </Select>
          </>
        }
      />

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
                        onClick={() => setPeek(item.id)}
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
              <button
                key={item.id}
                onClick={() => setPeek(item.id)}
                className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-elevated"
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[item.status] ?? 'bg-muted')} />
                <span className="w-32 shrink-0 text-[13px] text-muted">
                  {item.scheduledAt ? dateTime(item.scheduledAt, lang) : '—'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">{item.name}</span>
                  <span className="block truncate text-[12px] text-muted">{item.client.name}</span>
                </span>
                <PlatformChip platform={item.platform} size="sm" />
                <StatusBadge status={item.status} kind="content" />
              </button>
            ))}
          </div>
        </Card>
      ) : (
        <Card><EmptyState icon={CalendarDays} title={t('empty.calendar.title')} body={t('empty.calendar.body')} /></Card>
      )}

      <CalendarPeek id={peek} base={base} onClose={() => setPeek(null)} />
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
  tags: string[];
  createdAt: string;
  client: { id: string; name: string } | null;
}

/** What the tenant's library actually contains, for the folder and tag rails. */
interface MediaFacets {
  total: number;
  untagged: number;
  /** `name: null` is the "no folder" bucket — reported, never hidden. */
  folders: Array<{ name: string | null; count: number }>;
  tags: Array<{ name: string; count: number }>;
}

/**
 * The reserved `category` the API understands as "in no folder".
 *
 * Must match `UNFILED` in the media route: an empty string cannot express it,
 * because a query string cannot tell an empty filter from an absent one.
 */
const NO_FOLDER = '__unfiled__';

export function MediaPage() {
  const { t, lang } = useI18n();
  const { canManage } = useAuth();
  const { push } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<MediaRow | null>(null);
  // Folder and tag are separate filters because they are separate questions:
  // a folder is where an asset was filed, a tag is what it is about, and an
  // asset has one of the first and many of the second.
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  // Bumped after a change that alters what folders or tags exist, so the rails
  // refetch rather than showing a folder the last asset just left.
  const [refreshKey, setRefreshKey] = useState(0);
  const [filing, setFiling] = useState(false);
  const debounced = useDebounced(search);

  // The library follows the restaurant chosen in the top bar; the picker that
  // used to sit in this filter row was a second answer to the same question.
  const { currentId: clientId } = useRestaurant();
  useEffect(() => setPage(1), [clientId, folder, tag]);

  const { data, loading, error, refetch } = useQuery<Paginated<MediaRow>>(
    `/media${qs({
      page, pageSize: 24, search: debounced, type, clientId, tag,
      category: folder,
    })}`,
    [page, debounced, type, clientId, folder, tag],
  );
  const usage = useQuery<{ totalMb: number; byType: Array<{ type: string; count: number }> }>('/media/usage/summary');
  const facets = useQuery<MediaFacets>(`/media/facets${qs({ clientId })}`, [clientId, refreshKey]);

  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      const body = new FormData();
      for (const file of Array.from(files).slice(0, 10)) body.append('files', file);
      if (clientId) body.append('clientId', clientId);
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

  /**
   * Filing an asset: its folder and its tags.
   *
   * Writes through the PATCH route that already existed and nothing in the UI
   * used, so no new endpoint and no new model. The grid and the rails both
   * refetch, because moving the last asset out of a folder means that folder
   * no longer exists and leaving it on screen would be a lie.
   */
  const saveFiling = async (id: string, category: string, tagList: string[]) => {
    setFiling(true);
    try {
      const { media } = await api.patch<{ media: MediaRow }>(`/media/${id}`, {
        // An empty box means "no folder", which is null rather than "".
        category: category.trim() === '' ? null : category.trim(),
        tags: tagList,
      });
      setPreview(media);
      push({ tone: 'success', title: 'Saved' });
      refetch();
      setRefreshKey((n) => n + 1);
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setFiling(false);
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
      <PageHeader
        title={t('nav.media')}
        subtitle={usage.data ? `${usage.data.totalMb} MB stored across ${data?.pagination.total ?? 0} files` : undefined}
        action={
          canManage ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => event.target.files && upload(event.target.files)}
              />
              <Button icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>{t('common.upload')}</Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-40">
          <option value="">{t('common.all')}</option>
          {['IMAGE', 'VIDEO', 'DOCUMENT', 'LOGO'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        {/*
          * Folders come from the data, never from a fixed list. A hard-coded
          * set would be product structure the library does not actually have,
          * and would hide every folder somebody typed that was not on it.
          */}
        <Select value={folder} onChange={(e) => setFolder(e.target.value)} className="w-48">
          <option value="">All folders</option>
          {(facets.data?.folders ?? []).map((row) => (
            <option key={row.name ?? NO_FOLDER} value={row.name ?? NO_FOLDER}>
              {(row.name ?? 'No folder')} ({row.count})
            </option>
          ))}
        </Select>
      </div>

      {(facets.data?.tags.length ?? 0) > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-muted">Tags</span>
          {/* One tag at a time: the API filters by a single tag, and offering
              multi-select here would promise an intersection it does not do. */}
          {(facets.data?.tags ?? []).map((row) => (
            <button
              key={row.name}
              type="button"
              onClick={() => setTag(tag === row.name ? '' : row.name)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                tag === row.name
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-line text-muted hover:text-fg',
              )}
            >
              {row.name} <span className="opacity-60">{row.count}</span>
            </button>
          ))}
          {tag ? (
            <button type="button" onClick={() => setTag('')} className="px-2 text-[11px] text-muted hover:text-fg">
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

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
            action={canManage ? <Button icon={Upload} onClick={() => fileRef.current?.click()}>{t('common.upload')}</Button> : undefined}
          />
        </Card>
      )}

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.originalName ?? ''}
        size="lg"
        footer={
          canManage && preview ? (
            <Button variant="danger" icon={Trash2} onClick={() => remove(preview.id)}>{t('common.delete')}</Button>
          ) : null
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
                { label: 'Client', value: preview.client?.name ?? 'Shared' },
                { label: 'Uploaded', value: date(preview.createdAt, lang) },
              ].map((row) => (
                <div key={row.label} className="flex justify-between gap-3">
                  <span className="text-muted">{row.label}</span>
                  <span className="text-fg">{row.value}</span>
                </div>
              ))}
            </div>

            {canManage ? <FilingEditor key={preview.id} media={preview} saving={filing} onSave={saveFiling} /> : (
              <div className="grid gap-3 text-[13px] sm:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Folder</span>
                  <span className="text-fg">{preview.category ?? '—'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Tags</span>
                  <span className="text-fg">{preview.tags.length > 0 ? preview.tags.join(', ') : '—'}</span>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </>
  );
}


/**
 * Where one asset is filed: its folder and its tags.
 *
 * Local state rather than saving on every keystroke — filing is a deliberate
 * act, and a PATCH per character would be a write storm for a field somebody is
 * still typing. Keyed on the media id by the caller, so opening a different
 * asset resets the boxes rather than carrying the last one's values over.
 */
function FilingEditor({ media, saving, onSave }: {
  media: MediaRow;
  saving: boolean;
  onSave: (id: string, category: string, tags: string[]) => Promise<void>;
}) {
  const [category, setCategory] = useState(media.category ?? '');
  const [tagText, setTagText] = useState(media.tags.join(', '));

  // Split on commas, trim, drop blanks, de-duplicate. The API caps the list at
  // 20 and each tag at 40 characters; sending more would just be a 400.
  const tags = useMemo(
    () => [...new Set(tagText.split(',').map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
    [tagText],
  );

  const dirty = category.trim() !== (media.category ?? '')
    || tags.join('\u0000') !== media.tags.join('\u0000');

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Folder" hint="Leave empty to keep this asset unfiled.">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} placeholder="e.g. Ramadan 2026" />
        </Field>
        <Field label="Tags" hint="Comma separated. Up to 20.">
          <Input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="e.g. hero, vertical, arabic" />
        </Field>
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span key={tag} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted">{tag}</span>
          ))}
        </div>
      ) : null}

      <Button
        variant="secondary"
        loading={saving}
        disabled={!dirty}
        onClick={() => void onSave(media.id, category, tags)}
      >
        Save filing
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- approvals

interface ApprovalRow {
  id: string;
  status: ApprovalStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: { name: string } | null;
  content: {
    id: string;
    name: string;
    platform: Platform;
    type: string;
    headline: string | null;
    caption: string | null;
    cta: string | null;
    scheduledAt: string | null;
    client: { id: string; name: string; logoUrl: string | null };
    campaign: { id: string; name: string } | null;
    hashtags: Array<{ tag: string }>;
    mediaLinks: Array<{ media: { id: string; url: string; thumbnailUrl: string | null } }>;
  };
}

export function ApprovalsPage({ portal = false }: { portal?: boolean }) {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const { push } = useToast();
  const [status, setStatus] = useState<ApprovalStatus | ''>('PENDING');
  const [active, setActive] = useState<ApprovalRow | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery<Paginated<ApprovalRow>>(
    `/approvals${qs({ status, pageSize: 30 })}`,
    [status],
  );

  const canDecide = user?.role !== 'CLIENT_USER';

  const decide = async (decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') => {
    if (!active) return;
    setBusy(true);
    try {
      await api.post(`/approvals/${active.id}/decision`, { status: decision, note: note.trim() || undefined });
      push({ tone: 'success', title: `Marked as ${humanize(decision).toLowerCase()}` });
      setActive(null);
      setNote('');
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not record the decision', body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('nav.approvals')}
        subtitle={
          portal
            ? 'Review what your agency has drafted. Nothing goes live until you approve it.'
            : 'Nothing is scheduled until the client has signed it off here.'
        }
        action={
          <Select value={status} onChange={(event) => setStatus(event.target.value as ApprovalStatus | '')} className="w-48">
            <option value="">{t('common.all')}</option>
            {(['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as ApprovalStatus[]).map((value) => (
              <option key={value} value={value}>{humanize(value)}</option>
            ))}
          </Select>
        }
      />

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => <CardSkeleton key={index} />)}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((approval) => {
            const thumb = approval.content.mediaLinks[0]?.media;
            return (
              <Card key={approval.id} hover className="cursor-pointer overflow-hidden" onClick={() => { setActive(approval); setNote(''); }}>
                <div className="flex aspect-[16/9] items-center justify-center bg-elevated">
                  {thumb ? <img src={thumb.thumbnailUrl ?? thumb.url} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-7 w-7 text-muted/40" />}
                </div>
                <div className="p-4">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <PlatformChip platform={approval.content.platform} size="sm" />
                    <StatusBadge status={approval.status} kind="approval" />
                  </div>
                  <p className="truncate text-[14px] font-medium text-fg">{approval.content.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{approval.content.headline ?? '—'}</p>
                  <p className="mt-3 border-t border-line pt-2.5 text-[12px] text-muted">
                    {approval.content.client.name} · {relative(approval.createdAt, lang)}
                  </p>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card><EmptyState icon={ThumbsUp} title={t('empty.approvals.title')} body={t('empty.approvals.body')} /></Card>
      )}

      <Modal
        open={active !== null}
        onClose={() => setActive(null)}
        title={active?.content.name ?? ''}
        subtitle={active ? `${active.content.client.name} · ${humanize(active.content.platform)}` : undefined}
        size="lg"
        footer={
          canDecide && active?.status === 'PENDING' ? (
            <>
              <Button variant="secondary" icon={MessageSquare} loading={busy} onClick={() => decide('CHANGES_REQUESTED')}>
                {t('common.requestChanges')}
              </Button>
              <Button variant="danger" icon={X} loading={busy} onClick={() => decide('REJECTED')}>{t('common.reject')}</Button>
              <Button icon={Check} loading={busy} onClick={() => decide('APPROVED')}>{t('common.approve')}</Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setActive(null)}>{t('common.close')}</Button>
          )
        }
      >
        {active ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <ContentPreview
              platform={active.content.platform}
              brandName={active.content.client.name}
              logoUrl={active.content.client.logoUrl}
              headline={active.content.headline}
              caption={active.content.caption}
              cta={active.content.cta}
              hashtags={active.content.hashtags.map((tag) => tag.tag)}
              mediaUrl={active.content.mediaLinks[0]?.media.url}
              scheduledAt={active.content.scheduledAt}
              safeZones
            />
            <div className="space-y-4">
              <div className="space-y-2 text-[13px]">
                {[
                  { label: t('common.campaign'), value: active.content.campaign?.name ?? '—' },
                  { label: 'Type', value: humanize(active.content.type) },
                  { label: 'Scheduled', value: active.content.scheduledAt ? date(active.content.scheduledAt, lang) : 'Not scheduled' },
                  { label: 'Submitted', value: date(active.createdAt, lang) },
                ].map((row) => (
                  <div key={row.label} className="flex justify-between gap-3">
                    <span className="text-muted">{row.label}</span>
                    <span className="text-fg">{row.value}</span>
                  </div>
                ))}
              </div>

              {active.status === 'PENDING' && canDecide ? (
                <Field label="Comment" hint="Shared with the agency and saved to the content history.">
                  <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} placeholder="Anything you want changed?" />
                </Field>
              ) : active.note ? (
                <div className="rounded-xl border border-line bg-elevated p-3">
                  <p className="text-[12px] uppercase tracking-wide text-muted">Decision note</p>
                  <p className="mt-1 text-[13px] text-fg">{active.note}</p>
                  {active.decidedBy ? <p className="mt-1.5 text-[12px] text-muted">— {active.decidedBy.name}</p> : null}
                </div>
              ) : null}

              {!canDecide ? (
                <p className="rounded-xl border border-line bg-elevated p-3 text-[13px] text-muted">
                  Your account can view content but not approve it. Ask a client admin to decide.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- integrations

/** What the dialog starts with, and what the operator can edit before sending. */
/**
 * What each platform publishes to, for UI copy.
 *
 * The server owns the same mapping for the resolver and its error messages
 * (`services/publishing/target.ts`); this one exists so a dialog can name the
 * target before any request is made. Both must agree, and the one they must
 * never both say is "Page" for Instagram.
 */
const PUBLISH_TARGET_NOUN: Partial<Record<Platform, string>> = {
  FACEBOOK: 'Facebook Page',
  INSTAGRAM: 'Instagram account',
  TIKTOK: 'TikTok account',
  YOUTUBE: 'YouTube channel',
  LINKEDIN: 'LinkedIn page',
  GOOGLE_BUSINESS: 'business location',
};

const TEST_POST_DEFAULT = 'Marketing OS test post';

/**
 * The outcome of one test publish, as the dialog shows it.
 *
 * Success carries the provider's own post id — the only thing that proves a post
 * exists. Failure carries the provider's own words, because a generic apology
 * would leave the operator no better off than the silence this replaces.
 */
type TestPublishResult =
  | { ok: true; externalPostId: string; permalink: string | null; accountName: string }
  | { ok: false; message: string };

interface AdapterInfo {
  platform: Platform;
  label: string;
  /** READY | NOT_CONFIGURED | NO_ENCRYPTION — never a bare "implemented" flag. */
  readiness: 'READY' | 'NOT_CONFIGURED' | 'NO_ENCRYPTION';
  readinessDetail: string;
  ready: boolean;
  missingEnv: string[];
  capabilities: { publish: boolean; metrics: boolean; audiences: boolean };
  /**
   * What we built, as opposed to what the provider offers. Readiness says the
   * deployment is configured; this says whether there is code behind the
   * button. Six of the eight adapters are ARCHITECTURE_ONLY.
   */
  implementation: {
    oauth: ImplementationState;
    accountDiscovery: ImplementationState;
    publish: ImplementationState;
    metrics: ImplementationState;
    conversions: ImplementationState;
  };
  canConnect: boolean;
  /** Organic posting, as distinct from advertising. Google Ads has none. */
  organicPublish: boolean;
  scopes: string[];
  docsUrl: string;
}

type ImplementationState = 'IMPLEMENTED' | 'PARTIALLY_IMPLEMENTED' | 'ARCHITECTURE_ONLY' | 'NOT_SUPPORTED';

interface DiscoveredAccountRow {
  id: string;
  kind: string;
  externalId: string;
  name: string;
  username: string | null;
  currency: string | null;
  timezone: string | null;
  /**
   * The account this one was reached through, by the *provider's* id, not ours
   * — the only identifier that survives re-running discovery.
   *
   * What a parent is differs per provider, which is why nothing here names one:
   * on Meta it is the Facebook Page an Instagram Professional account is linked
   * through, and on Google Ads it is the manager account a customer sits under.
   * `parentAccountLine` decides what to call it.
   */
  parentExternalId: string | null;
  selected: boolean;
}

/**
 * Turn the callback's `?error=` into something worth reading.
 *
 * Every one of these is a dead end for the operator unless it says what to do
 * next, so each case pairs the provider's own words with the one action that
 * resolves it.
 *
 * Note that invalid, expired and already-used states deliberately arrive as the
 * same sentence. `oauth-state.ts` refuses to distinguish them so that the
 * callback cannot be used to probe which states exist — so this cannot tell
 * them apart either, and does not pretend to. The precise reason is recorded
 * server-side.
 */
/**
 * The callback slug, as the provider is named to a person.
 *
 * The slug is what the route is mounted under, so it is the one thing that is
 * certainly correct about which provider redirected.
 */
const PROVIDER_LABEL: Record<string, string> = {
  meta: 'Meta',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  google: 'Google Business Profile',
  'google-ads': 'Google Ads',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
};

function describeCallbackFailure(reason: string, provider: string | null): { title: string; body: string } {
  const text = reason.toLowerCase();
  /*
   * Named from the callback's own slug. This used to say "Meta" unconditionally
   * — every provider's failure was reported against Meta, which sent an
   * operator whose Google Ads connection failed to go and check a Meta app that
   * had nothing to do with it. A provider we cannot name is reported without
   * one rather than under a guess.
   */
  const label = (provider && PROVIDER_LABEL[provider]) ?? 'The provider';

  if (/denied|cancel|not authorized|access_denied/.test(text)) {
    return {
      title: 'Authorization was declined',
      body: `${label} reported that the request was not approved. Press Connect again and accept the permissions to continue.`,
    };
  }

  if (/could not be verified/.test(text)) {
    return {
      title: 'The connection attempt could not be verified',
      body: 'It may have expired, already been used, or been started in another tab. Start the connection again from this page.',
    };
  }

  if (/no authorization code/.test(text)) {
    return {
      title: `${label} returned no authorization code`,
      body: `The login finished without the code we need. Press Connect again — if it repeats, the app configuration on ${label} needs checking.`,
    };
  }

  // Token exchange and provider API failures: the provider's message is the
  // most useful thing we have, and it never carries the code or the token.
  return {
    title: `${label} did not connect`,
    body: reason,
  };
}

interface IntegrationRow {
  id: string;
  clientId: string;
  platform: Platform;
  status: string;
  accountName: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  client: { id: string; name: string };
}


/**
 * Choosing which accounts belong to this restaurant.
 *
 * This is the step that turns an authorized token into a connection, and it is
 * deliberately manual. A provider hands back every asset the person who
 * authorized can see — Pages and ad accounts on Meta, every Google Ads customer
 * a login can reach on Google Ads — which, for anyone who manages more than one
 * business, includes accounts that have nothing to do with this restaurant.
 * Attaching them all is how one brand's ad account ends up wired into another's
 * campaigns, so discovery marks everything unselected and waits.
 *
 * Everything the operator reads here is the *connection's own* provider's
 * words, resolved from `platform` through `account-picker.ts`. This screen used
 * to be Meta's regardless of what had been connected, which is how a successful
 * Google Ads authorisation produced a drawer explaining that "publishing needs
 * one ad account and one Page" above a list of nothing.
 */
function AccountSelection({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const { data, loading, error } = useQuery<{
    integration: {
      id: string;
      /*
       * The provider this drawer is speaking for. The endpoint has always
       * returned it; nothing read it, which is the whole of this bug.
       */
      platform: Platform;
      status: string;
      accountName: string | null;
      /**
       * Why discovery found what it found, when that needs saying.
       *
       * The server writes a provider-worded note here when an authorisation
       * succeeded and returned no accounts — including the provider's own
       * refusal, where there was one. Without it an empty drawer is silent
       * about the one thing the operator needs to know.
       */
      lastError: string | null;
      accounts: DiscoveredAccountRow[];
    };
  }>(id ? `/integrations/${id}/accounts` : null, [id]);

  // Seed from whatever is already attached, so reopening does not look empty.
  useEffect(() => {
    if (data?.integration) {
      setChosen(new Set(data.integration.accounts.filter((row) => row.selected).map((row) => row.id)));
    }
  }, [data]);

  const toggle = (accountId: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });

  const save = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const result = await api.post<{ status: string; selected: number }>(`/integrations/${id}/select`, {
        accountIds: [...chosen],
      });
      push({
        tone: result.status === 'CONNECTED' ? 'success' : 'info',
        title: result.status === 'CONNECTED' ? 'Connected' : 'Detached',
        body:
          result.status === 'CONNECTED'
            ? `${result.selected} account(s) attached to this restaurant.`
            : 'Nothing is attached, so the connection is disconnected.',
      });
      onSaved();
      onClose();
    } catch (err) {
      push({ tone: 'error', title: 'Could not save the selection', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const accounts = useMemo(() => data?.integration.accounts ?? [], [data]);
  const platform = data?.integration.platform ?? null;
  const copy = useMemo(() => accountPickerCopy(platform), [platform]);

  /**
   * The "reached through X" line for each account, or null where there is none.
   *
   * Parents are resolved against every discovered account, not just the Pages:
   * a Google Ads customer's parent is the manager account it sits under, which
   * is itself an AD_ACCOUNT row. The lookup is on the *provider's* id, the only
   * identifier that survives re-running discovery.
   */
  const parentLines = useMemo(() => {
    const byExternalId = new Map(accounts.map((row) => [row.externalId, row]));
    return new Map(accounts.map((row) => [
      row.id,
      parentAccountLine({
        platform,
        parentExternalId: row.parentExternalId,
        parentName: row.parentExternalId ? byExternalId.get(row.parentExternalId)?.name : undefined,
      }),
    ]));
  }, [accounts, platform]);

  const byKind = useMemo(() => {
    const map = new Map<string, DiscoveredAccountRow[]>();
    for (const row of accounts) {
      map.set(row.kind, [...(map.get(row.kind) ?? []), row]);
    }
    return [...map.entries()].sort(([a], [b]) => compareAccountKinds(platform, a, b));
  }, [accounts, platform]);

  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      title="Choose the accounts"
      footer={
        <Button className="w-full" onClick={save} loading={saving} disabled={loading || Boolean(error)}>
          {chosen.size === 0 ? 'Detach everything' : `Attach ${chosen.size} account(s)`}
        </Button>
      }
    >
      {loading ? (
        <div className="grid place-items-center py-16"><Spinner className="h-6 w-6" /></div>
      ) : error ? (
        <ErrorState message={error} />
      ) : (
        <div className="space-y-5">
          <p className="text-[13px] leading-relaxed text-muted">
            {copy.intro(data?.integration.accountName ?? 'this login')}
          </p>

          {byKind.map(([kind, rows]) => (
            <div key={kind}>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">
                {accountKindLabel(platform, kind)}
              </p>
              <div className="space-y-1.5">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => toggle(row.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl border p-3 text-start transition-colors',
                      chosen.has(row.id) ? 'border-brand bg-brand/5' : 'border-line hover:border-brand/40',
                    )}
                  >
                    <span
                      className={cn(
                        'grid h-4 w-4 shrink-0 place-items-center rounded border',
                        chosen.has(row.id) ? 'border-brand bg-brand text-white' : 'border-line',
                      )}
                    >
                      {chosen.has(row.id) ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-[13px] font-medium text-fg">{row.name}</span>
                        {row.username ? (
                          <span className="truncate text-[11px] text-muted">@{row.username}</span>
                        ) : null}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {accountKindLabel(platform, row.kind)}
                        {' · '}
                        {/* Google Ads prints a customer id as 123-456-7890 everywhere
                            an operator will be comparing this against. */}
                        {formatExternalId(platform, row.externalId)}
                        {row.currency ? ` · ${row.currency}` : ''}
                        {row.timezone ? ` · ${row.timezone}` : ''}
                      </span>
                      {/*
                        What an account was reached through, named as this provider
                        names it: the Facebook Page an Instagram account is linked
                        to, the manager account a Google Ads customer sits under.
                        Null where the provider has no such relationship, rather
                        than the unconditional "via Page …" this used to render.
                      */}
                      {parentLines.get(row.id) ? (
                        <span className="block truncate text-[11px] text-muted">
                          {parentLines.get(row.id)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {byKind.length === 0 ? (
            /*
             * The server's note first, the provider's generic advice second.
             * When discovery came back empty because the provider refused an
             * account, the refusal is the only sentence worth reading — and it
             * is the one thing this screen could never say before.
             */
            <p className="text-[13px] text-muted">
              {data?.integration.lastError ?? copy.empty}
            </p>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/**
 * Which project these connections belong to.
 *
 * This page is the one place where "all projects" is not a usable answer: a
 * token is stored against exactly one client, so Connect cannot proceed until a
 * project is named. The picker therefore lives on the page rather than only in
 * the top bar — but it is the *same* selection, read and written through the
 * existing restaurant context, so choosing here moves the top bar too and there
 * is no second source of truth to drift.
 */
function ProjectPicker() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { restaurants, current, currentId, setCurrentId, loading, error, reload } = useRestaurant();

  if (loading) {
    return (
      <Card className="mb-4 p-4">
        <div className="skeleton h-10 w-full max-w-md" />
      </Card>
    );
  }

  // A failed list is not an empty tenant, and telling the operator to create a
  // project they already have would be the wrong instruction entirely.
  if (error) {
    return (
      <Card className="mb-4 p-4">
        <p className="text-[13px] text-danger">{error}</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={reload}>
          {t('common.retry')}
        </Button>
      </Card>
    );
  }

  if (restaurants.length === 0) {
    return (
      <Card className="mb-4">
        <EmptyState
          compact
          icon={Building2}
          title={t('integration.noProjects')}
          body={t('integration.noProjectsBody')}
          action={<Button onClick={() => navigate('/app/restaurants')}>{t('dash.addFirstProject')}</Button>}
        />
      </Card>
    );
  }

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[16rem] flex-1">
          <span className="mb-1.5 block text-[12px] font-medium text-muted">
            {t('integration.chooseProject')}
          </span>
          <Select value={currentId} onChange={(event) => setCurrentId(event.target.value)}>
            <option value="">{t('integration.chooseProject')}</option>
            {restaurants.map((row) => (
              <option key={row.id} value={row.id}>
                {row.businessName}
                {row.location ? ` — ${row.location}` : ''}
              </option>
            ))}
          </Select>
        </label>

        <p className="text-[13px] text-muted" dir="auto">
          {current ? (
            <>
              {t('integration.selected')}:{' '}
              <span className="font-medium text-fg">{current.businessName}</span>
            </>
          ) : (
            t('integration.selectFirst')
          )}
        </p>
      </div>
    </Card>
  );
}

export function IntegrationsPage() {
  const { t, lang } = useI18n();
  const { push } = useToast();
  // Connections belong to a restaurant, and which restaurant is a top-bar
  // decision now — connecting Meta for the wrong one is not a cheap mistake.
  const { currentId: clientId, current } = useRestaurant();

  const [selecting, setSelecting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  /*
   * The test-publish dialog.
   *
   * `result` is kept in the dialog rather than fired off as a toast because the
   * useful part is the provider's post id, and a toast that disappears is no
   * good to someone who needs to copy it into Facebook to check the post.
   */
  const [testing, setTesting] = useState<{ id: string; label: string; platform: Platform } | null>(null);
  const [testMessage, setTestMessage] = useState(TEST_POST_DEFAULT);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestPublishResult | null>(null);

  const catalog = useQuery<{ ai: { provider: string; model: string; configured: boolean }; adapters: AdapterInfo[] }>('/integrations/catalog');
  const { data, loading, refetch } = useQuery<{ items: IntegrationRow[] }>(
    `/integrations${qs({ clientId })}`,
    [clientId],
  );

  const connect = async (platform: Platform) => {
    if (!clientId) {
      push({ tone: 'error', title: t('common.pickProject') });
      return;
    }
    try {
      /*
       * The server answers with the provider's own authorization URL, and the
       * browser has to actually go there. This used to POST and then refetch,
       * throwing the redirect away — which is why Connect appeared to do
       * nothing even when the backend was working.
       */
      const { redirectTo } = await api.post<{ redirectTo: string; integrationId: string }>(
        `/integrations/${clientId}/${platform}/connect`,
      );
      window.location.href = redirectTo;
    } catch (err) {
      // 501 means nobody built it; 503 means it is not configured and names the
      // variables. Both are actionable, and they are different actions.
      push({
        tone: 'info',
        title: 'Cannot connect yet',
        body: err instanceof Error ? err.message : undefined,
      });
    }
  };

  /**
   * Drop the connection.
   *
   * This discards the stored tokens on the server, so it is not undoable by
   * pressing the button again — reconnecting means going back through Meta.
   * That is worth one confirmation.
   */
  const disconnect = async (integrationId: string, label: string) => {
    if (!window.confirm(`Disconnect ${label}? The stored credentials are deleted and reconnecting needs a new Meta login.`)) {
      return;
    }
    setDisconnecting(integrationId);
    try {
      await api.post(`/integrations/${integrationId}/disconnect`);
      push({ tone: 'success', title: `${label} disconnected`, body: 'The stored credentials were deleted.' });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not disconnect', body: err instanceof Error ? err.message : undefined });
    } finally {
      setDisconnecting(null);
    }
  };

  /**
   * Put one real post on the connected Page.
   *
   * This is not a dry run: it exists to answer the question no automated test
   * can, which is whether this deployment's credentials actually publish. The
   * post is real and stays on the Page until someone deletes it there.
   *
   * The Page token is never involved on this side — the request carries a
   * message and nothing else, and the server decrypts the credential, uses it
   * once, and returns only the provider's post id.
   */
  const runTestPublish = async () => {
    if (!testing) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const response = await api.post<{
        externalPostId: string; permalink: string | null; accountName: string;
      }>(`/integrations/${testing.id}/test-publish`, { message: testMessage.trim() });

      setTestResult({
        ok: true,
        externalPostId: response.externalPostId,
        permalink: response.permalink,
        accountName: response.accountName,
      });
      refetch();
    } catch (err) {
      // The 502 body carries Meta's own reason. Showing anything else would
      // hide the one piece of information worth having.
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'The publish failed for an unknown reason.',
      });
    } finally {
      setTestBusy(false);
    }
  };

  const closeTest = () => {
    setTesting(null);
    setTestResult(null);
    setTestMessage(TEST_POST_DEFAULT);
  };

  /*
   * Coming back from the provider.
   *
   * The callback redirects here with either ?connected=meta&integration=... or
   * ?error=. A successful authorization is not yet a connection — the accounts
   * still have to be chosen — so success opens the selection drawer rather than
   * declaring victory.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const integrationId = params.get('integration');
    const failure = params.get('error');

    if (failure) {
      const { title, body } = describeCallbackFailure(failure, params.get('provider'));
      push({ tone: 'error', title, body });
    }
    if (integrationId) setSelecting(integrationId);
    if (failure || integrationId) {
      // Clear the query so a refresh does not replay the toast.
      window.history.replaceState({}, '', window.location.pathname);
      refetch();
    }
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byPlatform = useMemo(() => {
    const map = new Map<string, IntegrationRow>();
    for (const row of data?.items ?? []) {
      if (!clientId || row.clientId === clientId) map.set(row.platform, row);
    }
    return map;
  }, [data, clientId]);

  return (
    <>
      <PageHeader
        title={t('nav.integrations')}
        subtitle={
          current
            ? `Connections for ${current.businessName}. A provider connects once its credentials are set.`
            : t('integration.selectFirst')
        }
      />

      <ProjectPicker />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <Badge tone={catalog.data?.ai.configured ? 'ok' : 'warn'} dot>
            AI: {catalog.data?.ai.configured ? catalog.data.ai.model : 'built-in engine'}
          </Badge>
          <span className="text-muted">
            {catalog.data?.ai.configured
              ? 'A language model is configured and will be used for generation.'
              : 'No OPENAI_API_KEY is set, so content is written by the built-in template engine and labelled as such.'}
          </span>
        </div>
      </Card>

      {!clientId ? (
        /*
         * No cards until a project is chosen.
         *
         * Showing them would mean showing a connection status merged across
         * every project — one row per platform, whichever came back first —
         * which reads as "Instagram is connected" when it is connected for a
         * different restaurant entirely.
         */
        <Card>
          <EmptyState
            compact
            icon={Plug}
            title={t('integration.chooseProject')}
            body={t('integration.selectFirst')}
          />
        </Card>
      ) : loading || catalog.loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => <CardSkeleton key={index} />)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {catalog.data?.adapters.map((adapter) => {
            const integration = byPlatform.get(adapter.platform);
            const connected = integration?.status === 'CONNECTED';
            const buildable = adapter.implementation.oauth === 'IMPLEMENTED';
            // Authorized but nothing attached yet — the flow is half done.
            const awaitingSelection = integration?.status === 'CONNECTING';
            return (
              <Card key={adapter.platform} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <PlatformChip platform={adapter.platform} />
                  {/*
                    * Three states, not two. "Not built" is not the same as "not
                    * configured", and a provider whose credentials are all
                    * present still cannot connect if nobody wrote the adapter.
                    */}
                  <Badge
                    tone={connected ? 'ok' : !buildable ? 'neutral' : adapter.ready ? 'brand' : 'warn'}
                    dot
                  >
                    {connected
                      ? t('integration.connected')
                      : !buildable
                        ? t('integration.notBuilt')
                        : adapter.ready
                          ? t('integration.readyToConnect')
                          : t('integration.notConfigured')}
                  </Badge>
                </div>

                {/*
                  * Which login this card starts.
                  *
                  * The two Meta-family cards are the ones an operator has to
                  * choose between, and the choice is not obvious from the
                  * platform name: an Instagram account with no Facebook Page
                  * can only be connected here, and one that has a Page can be
                  * connected either way.
                  */}
                {adapter.platform === 'INSTAGRAM' || adapter.platform === 'FACEBOOK' ? (
                  <p className="mt-2 text-[12px] leading-snug text-muted">
                    {adapter.platform === 'INSTAGRAM'
                      ? t('integration.instagramDirect')
                      : t('integration.metaScope')}
                  </p>
                ) : null}

                <div className="mt-4 space-y-1.5 text-[13px] text-muted">
                  <p className="flex justify-between gap-2">
                    <span>Account</span><span className="text-fg">{integration?.accountName ?? '—'}</span>
                  </p>
                  <p className="flex justify-between gap-2">
                    <span>{t('integration.lastSync')}</span>
                    <span className="text-fg">{integration?.lastSyncAt ? relative(integration.lastSyncAt, lang) : '—'}</span>
                  </p>
                  <p className="flex justify-between gap-2">
                    <span>Capabilities</span>
                    <span className="text-fg">
                      {[adapter.capabilities.publish && 'publish', adapter.capabilities.metrics && 'metrics'].filter(Boolean).join(', ') || 'none yet'}
                    </span>
                  </p>
                </div>

                {!buildable ? (
                  <div className="mt-3 rounded-lg border border-line bg-elevated p-2.5 text-[12px] text-muted">
                    Not implemented in this application yet. Its OAuth descriptor exists; the code behind it does not,
                    so credentials would not help.
                  </div>
                ) : adapter.missingEnv.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-warn/25 bg-warn/10 p-2.5 text-[12px] text-warn">
                    Needs: {adapter.missingEnv.join(', ')}
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={connected ? 'secondary' : 'primary'}
                    icon={Plug}
                    onClick={() => connect(adapter.platform)}
                    disabled={!clientId || !buildable}
                  >
                    {connected ? t('integration.reconnect') : t('integration.connect')}
                  </Button>
                  {integration && (connected || awaitingSelection) ? (
                    <Button size="sm" variant="secondary" onClick={() => setSelecting(integration.id)}>
                      {awaitingSelection ? t('integration.chooseAccounts') : t('integration.accounts')}
                    </Button>
                  ) : null}
                  {/*
                    Only on a live connection that can actually publish. Offering
                    this on a half-connected provider would put a real post on a
                    customer's Page behind a button that looks diagnostic.
                   */}
                  {integration && connected && adapter.organicPublish ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Send}
                      onClick={() => setTesting({ id: integration.id, label: adapter.label, platform: adapter.platform })}
                    >
                      Test publish
                    </Button>
                  ) : null}
                  {integration && (connected || awaitingSelection) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={disconnecting === integration.id}
                      onClick={() => disconnect(integration.id, adapter.label)}
                    >
                      {t('integration.disconnect')}
                    </Button>
                  ) : null}
                  <a
                    href={adapter.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-muted transition-colors hover:text-fg"
                  >
                    <Link2 className="h-3.5 w-3.5" />Docs
                  </a>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AccountSelection id={selecting} onClose={() => setSelecting(null)} onSaved={refetch} />

      <Modal
        open={Boolean(testing)}
        onClose={closeTest}
        title={`Test publish to ${testing?.label ?? ''}`}
        size="sm"
        footer={
          testResult?.ok ? (
            <Button className="w-full" onClick={closeTest}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={closeTest}>Cancel</Button>
              <Button
                icon={Send}
                loading={testBusy}
                disabled={testMessage.trim().length === 0}
                onClick={runTestPublish}
              >
                {testResult ? 'Try again' : 'Publish test post'}
              </Button>
            </>
          )
        }
      >
        <div className="space-y-4">
          {/* Said plainly, before the button rather than after it — and named
              for what this connection publishes to. A direct Instagram
              connection has no Page and must never be told about one. */}
          <p className="rounded-lg border border-warn/25 bg-warn/10 p-3 text-[13px] text-fg">
            This publishes a real post to the connected {testing ? PUBLISH_TARGET_NOUN[testing.platform] ?? 'account' : 'account'}.
            It stays there until you delete it on the platform.
          </p>

          {/* Instagram's API has no text-only post: every post is a media
              container. Saying so here costs one sentence; finding out from a
              provider error after pressing the button costs a round trip and
              reads like a bug in the connection. */}
          {testing?.platform === 'INSTAGRAM' ? (
            <p className="rounded-lg border border-line bg-elevated p-3 text-[13px] text-muted">
              Instagram has no text-only post — every post carries media, and the media must be at a
              publicly reachable URL. A test post here will be refused for that reason; publish through
              the content workflow with an image instead.
            </p>
          ) : null}

          <Field label="Message" hint="Sent as the post's text.">
            <Textarea
              value={testMessage}
              onChange={(event) => setTestMessage(event.target.value)}
              rows={3}
              disabled={testBusy || testResult?.ok}
            />
          </Field>

          {testResult?.ok ? (
            <div className="space-y-2 rounded-lg border border-ok/25 bg-ok/10 p-3">
              <p className="text-[13px] font-medium text-ok">
                Published to {testResult.accountName}
              </p>
              <p className="text-[13px] text-fg">
                <span className="text-muted">Post ID </span>
                {/* Selectable: this is the value worth checking on Facebook. */}
                <span className="select-all font-mono text-[12px]">{testResult.externalPostId}</span>
              </p>
              {testResult.permalink ? (
                <a
                  href={testResult.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] text-muted transition-colors hover:text-fg"
                >
                  <Link2 className="h-3.5 w-3.5" />View the post
                </a>
              ) : null}
            </div>
          ) : testResult ? (
            <div className="rounded-lg border border-danger/25 bg-danger/10 p-3">
              <p className="text-[13px] font-medium text-danger">The platform refused the post</p>
              <p className="mt-1 text-[13px] text-fg">{testResult.message}</p>
            </div>
          ) : null}
        </div>
      </Modal>

      <Card className="mt-4 p-5">
        <p className="text-[13px] leading-relaxed text-muted">
          Each platform has an adapter behind a shared interface. The routes, credential storage, connection status and
          this UI are all real — the adapters themselves refuse to connect until real API credentials and provider code
          are supplied, rather than reporting a connection that does not exist.
        </p>
      </Card>
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

export function SettingsPage() {
  const { t } = useI18n();
  const { user, refresh } = useAuth();
  const { push } = useToast();
  const [tab, setTab] = useState<'profile' | 'security' | 'plan'>('profile');
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });

  const usage = useQuery<{
    plan: { name: string; maxClients: number; maxUsers: number; maxCampaigns: number; maxAiPerMonth: number; maxStorageMb: number } | null;
    usage: { clients: number; users: number; campaigns: number; aiThisMonth: number; storageMb: number; integrations: number };
    limits: Record<string, number> | null;
    billing: { provider: string | null; status: string };
  }>('/subscriptions/usage');

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
          { value: 'profile', label: 'Profile' },
          { value: 'security', label: 'Security' },
          { value: 'plan', label: 'Plan and usage' },
        ]}
      />

      {tab === 'profile' ? (
        <Card className="max-w-2xl">
          <CardHeader title="Your profile" />
          <div className="space-y-4 p-5">
            <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Email" hint="Contact an administrator to change this."><Input value={user?.email ?? ''} disabled /></Field>
            <Field label={t('theme.label')}><div><ThemeSwitch /></div></Field>
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
          </div>
        </Card>
      ) : null}

      {tab === 'plan' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={usage.data?.plan?.name ?? 'Plan'} subtitle="Current usage against your limits" />
            <div className="space-y-4 p-5">
              {usage.data?.limits
                ? Object.entries(usage.data.usage).map(([key, value]) => {
                    const limit = usage.data!.limits![key];
                    const unlimited = limit === -1 || limit === undefined;
                    const ratio = unlimited ? 0 : Math.min(1, value / Math.max(limit, 1));
                    return (
                      <div key={key}>
                        <div className="mb-1.5 flex items-center justify-between text-[13px]">
                          <span className="text-muted">{humanize(key)}</span>
                          <span className="tabular text-fg">{value}{unlimited ? '' : ` / ${limit}`}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
                          <div
                            className={cn('h-full rounded-full', ratio > 0.9 ? 'bg-danger' : ratio > 0.7 ? 'bg-warn' : 'bg-brand')}
                            style={{ width: `${unlimited ? 4 : ratio * 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                : <p className="text-sm text-muted">No plan attached.</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Billing" />
            <div className="p-5">
              <Badge tone="warn" dot>Not configured</Badge>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                Subscriptions, plans and limits are enforced by the application, but no payment provider is connected —
                nothing has been charged and no card details are stored. The subscription model carries a
                <code className="mx-1 rounded bg-elevated px-1">providerRef</code> field ready for a provider to populate.
              </p>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
