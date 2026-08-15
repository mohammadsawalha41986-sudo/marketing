/**
 * The content studio: the list of everything written, and the per-item view.
 *
 * The approval workflow is gone with the client portal — the operator both
 * makes and ships the work, so the pipeline is idea → draft → ready →
 * scheduled → published, and status is set directly rather than requested.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Image as ImageIcon, PenLine, Plus, Search, Send, Sparkles } from 'lucide-react';

import {
  api, qs, CONTENT_STATUSES, CONTENT_TYPES, PLATFORMS,
  type ContentStatus, type ContentType, type Language, type Paginated, type Platform,
  type RestaurantRef,
} from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { date, dateTime, humanize } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, Tabs, Textarea, useToast,
} from '../components/ui';
import { PlatformChip, StatusBadge } from '../components/domain';
import { PlatformPreview } from '../components/domain';

interface ContentRow {
  id: string;
  name: string;
  status: ContentStatus;
  platform: Platform;
  type: ContentType;
  language: Language;
  headline: string | null;
  scheduledAt: string | null;
  updatedAt: string;
  restaurant: RestaurantRef;
  campaign: { id: string; name: string } | null;
  hashtags: Array<{ tag: string }>;
  mediaLinks: Array<{ media: { id: string; url: string; thumbnailUrl: string | null; type: string } }>;
}

function ContentForm({
  open, onClose, onSaved, restaurantId,
}: { open: boolean; onClose: () => void; onSaved: () => void; restaurantId?: string }) {
  const { t } = useI18n();
  const { push } = useToast();
  const navigate = useNavigate();
  const restaurants = useQuery<Paginated<RestaurantRef>>(`/restaurants${qs({ pageSize: 100 })}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = {
    restaurantId: restaurantId ?? '',
    campaignId: '',
    name: '',
    type: 'POST' as ContentType,
    status: 'IDEA' as ContentStatus,
    platform: 'INSTAGRAM' as Platform,
    language: 'EN' as Language,
    brief: '',
  };
  const [form, setForm] = useState(blank);

  const chosen = restaurantId ?? form.restaurantId;
  const campaigns = useQuery<Paginated<{ id: string; name: string }>>(
    chosen ? `/campaigns${qs({ restaurantId: chosen, pageSize: 100 })}` : null,
    [chosen],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ content: { id: string } }>('/content', {
        ...form,
        restaurantId: chosen,
        campaignId: form.campaignId || null,
      });
      push({ tone: 'success', title: 'Content created' });
      onSaved();
      onClose();
      setForm(blank);
      navigate(`/content/${response.content.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the content');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New content"
      subtitle="Start from an idea or a brief. Copy can be written by hand or generated in the AI Studio."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button form="content-form" type="submit" loading={busy}>{t('common.create')}</Button>
        </>
      }
    >
      <form id="content-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {restaurantId ? null : (
          <Field label={t('common.restaurant')} required>
            <Select
              value={form.restaurantId}
              onChange={(e) => setForm({ ...form, restaurantId: e.target.value, campaignId: '' })}
              required
            >
              <option value="">Select a restaurant</option>
              {restaurants.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('common.campaign')}>
          <Select value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })}>
            <option value="">{t('common.none')}</option>
            {campaigns.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Name" required className={restaurantId ? undefined : 'sm:col-span-2'}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Weekend brunch — August" />
        </Field>
        <Field label={t('common.type')}>
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ContentType })}>
            {CONTENT_TYPES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label={t('common.platform')}>
          <Select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}>
            {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label={t('common.status')}>
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ContentStatus })}>
            {CONTENT_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label={t('common.language')}>
          <Select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as Language })}>
            <option value="EN">English</option>
            <option value="AR">العربية</option>
          </Select>
        </Field>
        <Field label="Creative brief" className="sm:col-span-2" error={error ?? undefined}>
          <Textarea value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} rows={3} placeholder="What this piece needs to do." />
        </Field>
      </form>
    </Modal>
  );
}

export function ContentPage({ restaurantId, embedded = false }: { restaurantId?: string; embedded?: boolean } = {}) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [platform, setPlatform] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search);

  const scoped = restaurantId ?? params.get('restaurant') ?? undefined;

  const { data, loading, error, refetch } = useQuery<Paginated<ContentRow>>(
    `/content${qs({ page, pageSize: 12, search: debounced, status, type, platform, restaurantId: scoped })}`,
    [page, debounced, status, type, platform, scoped],
  );

  const newButton = <Button icon={Plus} onClick={() => setCreating(true)}>New content</Button>;

  return (
    <>
      {embedded ? null : (
        <PageHeader
          title={t('nav.content')}
          subtitle="Everything written for every restaurant, at every stage."
          action={
            <>
              <Button variant="secondary" icon={Sparkles} onClick={() => navigate(`/ai${scoped ? `?restaurant=${scoped}` : ''}`)}>
                {t('nav.ai')}
              </Button>
              {newButton}
            </>
          }
        />
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40">
          <option value="">{t('common.status')}</option>
          {CONTENT_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-40">
          <option value="">{t('common.type')}</option>
          {CONTENT_TYPES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.platform')}</option>
          {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        {embedded ? newButton : null}
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
            {data.items.map((item) => {
              const thumb = item.mediaLinks[0]?.media;
              return (
                <Card key={item.id} hover className="cursor-pointer overflow-hidden" onClick={() => navigate(`/content/${item.id}`)}>
                  <div className="flex aspect-[16/9] items-center justify-center bg-elevated">
                    {thumb ? (
                      <img src={thumb.thumbnailUrl ?? thumb.url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImageIcon className="h-7 w-7 text-muted/50" />
                    )}
                  </div>
                  <div className="p-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <PlatformChip platform={item.platform} size="sm" />
                      <StatusBadge status={item.status} kind="content" />
                    </div>
                    <p className="truncate text-[14px] font-medium text-fg">{item.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{item.headline ?? '—'}</p>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5 text-[12px] text-muted">
                      <span className="truncate">{embedded ? humanize(item.type) : item.restaurant.name}</span>
                      <span className="shrink-0">{item.scheduledAt ? date(item.scheduledAt, lang) : humanize(item.type)}</span>
                    </div>
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
            icon={PenLine}
            title={debounced || status ? t('empty.search.title') : t('empty.content.title')}
            body={debounced || status ? t('empty.search.body') : t('empty.content.body')}
            action={!debounced ? newButton : undefined}
          />
        </Card>
      )}

      <ContentForm open={creating} onClose={() => setCreating(false)} onSaved={refetch} restaurantId={scoped} />
    </>
  );
}

// ---------------------------------------------------------------- detail

interface ContentDetail extends ContentRow {
  caption: string | null;
  primaryText: string | null;
  shortText: string | null;
  longText: string | null;
  slogan: string | null;
  cta: string | null;
  brief: string | null;
  notes: string | null;
  timezone: string;
  publishedAt: string | null;
  aiGenerated: boolean;
  restaurant: { id: string; name: string; businessName: string; logoUrl: string | null };
}

const COPY_FIELDS = [
  ['headline', 'Headline', false],
  ['slogan', 'Slogan', false],
  ['caption', 'Caption', true],
  ['primaryText', 'Primary text', true],
  ['shortText', 'Short text', false],
  ['cta', 'Call to action', false],
  ['longText', 'Long text', true],
] as const;

export function ContentDetailPage() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { push } = useToast();
  const [tab, setTab] = useState<'copy' | 'preview' | 'details'>('copy');
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const { data, loading, error, refetch } = useQuery<{ content: ContentDetail }>(`/content/${id}`, [id]);

  const setStatus = async (status: ContentStatus) => {
    try {
      await api.patch(`/content/${id}`, { status });
      push({ tone: 'success', title: `Moved to ${humanize(status)}` });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not update', body: err instanceof Error ? err.message : undefined });
    }
  };

  const publish = async () => {
    try {
      await api.post(`/content/${id}/publish`);
      push({ tone: 'success', title: 'Marked as published' });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not publish', body: err instanceof Error ? err.message : undefined });
    }
  };

  const schedule = async () => {
    try {
      await api.post(`/content/${id}/schedule`, { scheduledAt: new Date(scheduledAt).toISOString() });
      push({ tone: 'success', title: 'Scheduled' });
      setScheduling(false);
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not schedule', body: err instanceof Error ? err.message : undefined });
    }
  };

  const saveCopy = async () => {
    setSaving(true);
    try {
      await api.patch(`/content/${id}`, draft);
      push({ tone: 'success', title: 'Copy saved' });
      setEditing(false);
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="space-y-4"><CardSkeleton rows={2} /><CardSkeleton rows={5} /></div>;
  if (error || !data) return <Card><ErrorState message={error ?? 'Content not found'} onRetry={refetch} /></Card>;

  const content = data.content;
  const isPublished = content.status === 'PUBLISHED';

  const beginEdit = () => {
    setDraft(Object.fromEntries(COPY_FIELDS.map(([key]) => [key, content[key] ?? ''])));
    setEditing(true);
  };

  return (
    <>
      <PageHeader
        title={content.name}
        subtitle={
          <>
            <Link to={`/restaurants/${content.restaurant.id}`} className="hover:text-brand">{content.restaurant.name}</Link>
            {' · '}{humanize(content.platform)}{' · '}{humanize(content.type)}
          </>
        }
        action={
          <>
            <StatusBadge status={content.status} kind="content" />
            {content.aiGenerated ? <Badge tone="brand"><Sparkles className="h-3 w-3" />AI drafted</Badge> : null}
            {!isPublished ? (
              <Select
                value={content.status}
                onChange={(e) => setStatus(e.target.value as ContentStatus)}
                className="w-36"
                aria-label={t('common.status')}
              >
                {CONTENT_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
              </Select>
            ) : null}
            {!isPublished ? (
              <Button variant="secondary" onClick={() => setScheduling(true)}>{t('common.schedule')}</Button>
            ) : null}
            {!isPublished ? <Button icon={Send} onClick={publish}>{t('common.publish')}</Button> : null}
          </>
        }
      />

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'copy', label: 'Copy' },
          { value: 'preview', label: 'Preview' },
          { value: 'details', label: 'Details' },
        ]}
      />

      {tab === 'copy' ? (
        <Card>
          <CardHeader
            title="Written copy"
            action={
              editing ? (
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
                  <Button size="sm" loading={saving} onClick={saveCopy} icon={Check}>{t('common.save')}</Button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={beginEdit}>{t('common.edit')}</Button>
              )
            }
          />
          <div className="space-y-4 p-5">
            {COPY_FIELDS.map(([key, label, multiline]) =>
              editing ? (
                <Field key={key} label={label}>
                  {multiline ? (
                    <Textarea
                      value={draft[key] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      rows={key === 'longText' ? 6 : 3}
                    />
                  ) : (
                    <Input value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
                  )}
                </Field>
              ) : (
                <div key={key}>
                  <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">{label}</p>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-fg">{content[key] || '—'}</p>
                </div>
              ),
            )}
          </div>
        </Card>
      ) : null}

      {tab === 'preview' ? (
        <div className="mx-auto max-w-md">
          <PlatformPreview
            platform={content.platform}
            brandName={content.restaurant.businessName}
            logoUrl={content.restaurant.logoUrl}
            headline={content.headline}
            caption={content.caption}
            cta={content.cta}
            hashtags={content.hashtags.map((tag) => tag.tag)}
            mediaUrl={content.mediaLinks[0]?.media.url}
          />
        </div>
      ) : null}

      {tab === 'details' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Details" />
            <div className="space-y-3 p-5 text-[13px]">
              {[
                { label: t('common.restaurant'), value: content.restaurant.name },
                { label: t('common.campaign'), value: content.campaign?.name ?? '—' },
                { label: t('common.platform'), value: humanize(content.platform) },
                { label: t('common.type'), value: humanize(content.type) },
                { label: t('common.language'), value: content.language === 'AR' ? 'العربية' : 'English' },
                { label: 'Scheduled', value: content.scheduledAt ? dateTime(content.scheduledAt, lang) : 'Not scheduled' },
                { label: 'Published', value: content.publishedAt ? dateTime(content.publishedAt, lang) : '—' },
                { label: 'Timezone', value: content.timezone },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <span className="text-muted">{row.label}</span>
                  <span className="font-medium text-fg">{row.value}</span>
                </div>
              ))}

              <div>
                <p className="mb-1.5 text-muted">Hashtags</p>
                <div className="flex flex-wrap gap-1.5">
                  {content.hashtags.length === 0 ? <span className="text-muted">—</span> : content.hashtags.map((tag) => (
                    <span key={tag.tag} className="rounded-full border border-brand/25 bg-brand/10 px-2 py-0.5 text-[12px] text-brand">{tag.tag}</span>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Brief and notes" />
            <div className="space-y-4 p-5 text-[13px]">
              <div>
                <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">Creative brief</p>
                <p className="whitespace-pre-line text-fg">{content.brief || '—'}</p>
              </div>
              <div>
                <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">Notes</p>
                <p className="whitespace-pre-line text-fg">{content.notes || '—'}</p>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      <Modal
        open={scheduling}
        onClose={() => setScheduling(false)}
        title="Schedule this content"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setScheduling(false)}>{t('common.cancel')}</Button>
            <Button onClick={schedule} disabled={!scheduledAt} icon={Check}>{t('common.schedule')}</Button>
          </>
        }
      >
        <Field label="Publish at" hint="This places it on the calendar. It does not post to any network.">
          <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
