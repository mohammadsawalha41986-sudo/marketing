/** Content list, the AI studio / ad creator, and the content detail view. */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Check, Hash, Image as ImageIcon, PenLine, Plus, Save, Search, Send, Sparkles, Wand2,
} from 'lucide-react';

import { api, qs, type ContentStatus, type Language, type Paginated, type Platform } from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, humanize } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, Tabs, Textarea, useToast,
} from '../components/ui';
import { AiBadge, AiNotice, PlatformChip, StatusBadge } from '../components/domain';
import { ContentPreview } from '../components/content-preview';
import { CreativeStudio } from '../components/creative-studio';
import { MediaPicker } from '../components/media-picker';

/**
 * The statuses whose creative the author may still change.
 *
 * Approval is approval *of a specific creative*. Once someone has signed off,
 * swapping the image without a new review would make the approval a record of
 * something that no longer exists.
 */
const MEDIA_EDITABLE = new Set<ContentStatus>(['DRAFT', 'CHANGES_REQUESTED', 'REJECTED']);

const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'SNAPCHAT', 'GOOGLE_ADS', 'GOOGLE_BUSINESS', 'LINKEDIN', 'X'];
const TYPES = ['POST', 'STORY', 'REEL', 'VIDEO', 'CAROUSEL', 'AD', 'ARTICLE', 'EMAIL'];
const STATUSES: ContentStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'SCHEDULED', 'PUBLISHED', 'FAILED'];

interface ContentRow {
  id: string;
  name: string;
  status: ContentStatus;
  platform: Platform;
  type: string;
  language: Language;
  headline: string | null;
  scheduledAt: string | null;
  updatedAt: string;
  client: { id: string; name: string };
  campaign: { id: string; name: string } | null;
  hashtags: Array<{ tag: string }>;
  mediaLinks: Array<{ media: { id: string; url: string; thumbnailUrl: string | null; type: string } }>;
}

export function ContentPage({ portal = false }: { portal?: boolean }) {
  const { t, lang } = useI18n();
  const { isAgency } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  // The restaurant comes from the top bar, which still honours a ?client= in
  // the URL — so a link to one restaurant's content keeps working.
  const { currentId: clientId } = useRestaurant();
  useEffect(() => setPage(1), [clientId]);

  const { data, loading, error, refetch } = useQuery<Paginated<ContentRow>>(
    `/content${qs({ page, pageSize: 12, search: debounced, status, platform, clientId })}`,
    [page, debounced, status, platform, clientId],
  );

  const base = portal ? '/client' : '/app';

  return (
    <>
      <PageHeader
        title={t('nav.content')}
        subtitle="Everything written for every client, at every stage of review."
        action={isAgency && !portal ? <Button icon={Sparkles} onClick={() => navigate('/app/studio')}>Open AI Studio</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.all')}</option>
          {STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.all')}</option>
          {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
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
            {data.items.map((item) => {
              const thumb = item.mediaLinks[0]?.media;
              return (
                <Card key={item.id} hover className="cursor-pointer overflow-hidden" onClick={() => navigate(`${base}/content/${item.id}`)}>
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
                    <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5 text-[12px] text-muted">
                      <span className="truncate">{item.client.name}</span>
                      <span>{item.scheduledAt ? date(item.scheduledAt, lang) : humanize(item.type)}</span>
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
            action={isAgency && !portal ? <Button icon={Sparkles} onClick={() => navigate('/app/studio')}>Open AI Studio</Button> : undefined}
          />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- AI studio

interface Generated {
  headline: string;
  caption: string;
  primaryText: string;
  shortText: string;
  longText: string;
  slogan: string;
  cta: string;
  hashtags: string[];
  keywords: string[];
}

interface GenerateMeta {
  provider: string;
  model: string;
  isFallback: boolean;
  notice?: string;
}

const EMPTY: Generated = {
  headline: '', caption: '', primaryText: '', shortText: '',
  longText: '', slogan: '', cta: '', hashtags: [], keywords: [],
};

export function StudioPage() {
  const { t } = useI18n();
  const { push } = useToast();
  const navigate = useNavigate();
  // The studio writes for one restaurant, so it starts on the one being worked
  // on. It keeps its own picker: which restaurant a draft is for is part of the
  // brief, not just a filter over a list.
  const { restaurants, currentId } = useRestaurant();

  const [brief, setBrief] = useState({
    clientId: currentId,
    campaignId: '',
    name: '',
    platform: 'INSTAGRAM' as Platform,
    contentType: 'POST',
    language: 'EN' as Language,
    tone: '',
    productService: '',
    offer: '',
    audience: '',
  });

  const [copy, setCopy] = useState<Generated>(EMPTY);
  const [meta, setMeta] = useState<GenerateMeta | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewPlatform, setPreviewPlatform] = useState<Platform>('INSTAGRAM');
  // Lifted so the live preview shows the same source the creative renders from.
  const [studioMediaUrl, setStudioMediaUrl] = useState<string | null>(null);
  /*
   * Attached media, as ids.
   *
   * `studioMediaUrl` above is a rendering source that exists only in this
   * component — useful for the preview, worthless to the database. These ids are
   * what get written to ContentMedia, which is why the preview prefers them: what
   * the operator sees before saving is then what every later screen reads back.
   */
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);

  const campaigns = useQuery<Paginated<{ id: string; name: string }>>(
    brief.clientId ? `/campaigns${qs({ clientId: brief.clientId, pageSize: 100 })}` : null,
    [brief.clientId],
  );

  // Fall back to the first restaurant so the studio is usable straight away.
  useEffect(() => {
    const fallback = currentId || restaurants[0]?.id;
    if (!brief.clientId && fallback) {
      setBrief((current) => ({ ...current, clientId: fallback }));
    }
  }, [restaurants, currentId, brief.clientId]);

  useEffect(() => setPreviewPlatform(brief.platform), [brief.platform]);

  const client = useMemo(
    () => restaurants.find((row) => row.id === brief.clientId),
    [restaurants, brief.clientId],
  );

  const generate = async () => {
    if (!brief.clientId) {
      push({ tone: 'error', title: 'Choose a restaurant first' });
      return;
    }
    setGenerating(true);
    try {
      const response = await api.post<{ generated: Generated; meta: GenerateMeta }>('/content/generate', {
        clientId: brief.clientId,
        platform: brief.platform,
        contentType: brief.contentType,
        language: brief.language,
        tone: brief.tone || undefined,
        productService: brief.productService || undefined,
        offer: brief.offer || undefined,
        audience: brief.audience || undefined,
        adName: brief.name || undefined,
      });
      setCopy(response.generated);
      setMeta(response.meta);
      push({ tone: 'success', title: 'Draft ready', body: t('ai.editable') });
    } catch (err) {
      push({ tone: 'error', title: 'Generation failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setGenerating(false);
    }
  };

  const regenerateHashtags = async () => {
    if (!brief.clientId) return;
    try {
      const response = await api.post<{ hashtags: string[] }>('/content/hashtags', {
        clientId: brief.clientId,
        platform: brief.platform,
        contentType: brief.contentType,
        language: brief.language,
        productService: brief.productService || undefined,
        offer: brief.offer || undefined,
      });
      setCopy((current) => ({ ...current, hashtags: response.hashtags }));
    } catch (err) {
      push({ tone: 'error', title: 'Could not generate hashtags', body: err instanceof Error ? err.message : undefined });
    }
  };

  const save = async () => {
    if (!brief.clientId || !brief.name.trim()) {
      push({ tone: 'error', title: 'A restaurant and a name are required' });
      return;
    }
    setSaving(true);
    try {
      const response = await api.post<{ content: { id: string } }>('/content', {
        clientId: brief.clientId,
        campaignId: brief.campaignId || null,
        name: brief.name.trim(),
        type: brief.contentType,
        platform: brief.platform,
        language: brief.language,
        tone: brief.tone || null,
        productService: brief.productService || null,
        offer: brief.offer || null,
        audience: brief.audience || null,
        headline: copy.headline || null,
        caption: copy.caption || null,
        primaryText: copy.primaryText || null,
        shortText: copy.shortText || null,
        longText: copy.longText || null,
        slogan: copy.slogan || null,
        cta: copy.cta || null,
        hashtags: copy.hashtags,
        // The attachment, not a preview URL. Without this the row saves clean and
        // every screen downstream reports it has no creative.
        mediaIds,
      });
      push({
        tone: 'success',
        title: 'Saved as a draft',
        body: mediaIds.length === 0 ? 'No media attached yet — add one before scheduling.' : undefined,
      });
      navigate(`/app/content/${response.content.id}`);
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('ai.studio')}
        subtitle={t('ai.studioSub')}
        action={
          <>
            <Button variant="secondary" onClick={generate} loading={generating} icon={Wand2}>
              {generating ? t('ai.generating') : t('ai.generate')}
            </Button>
            <Button onClick={save} loading={saving} icon={Save}>{t('common.save')}</Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {/* Brief */}
          <Card>
            <CardHeader title="The brief" subtitle="What the AI is given. Nothing else leaves this page." icon={PenLine} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t('common.client')} required>
                <Select value={brief.clientId} onChange={(e) => setBrief({ ...brief, clientId: e.target.value, campaignId: '' })} required>
                  <option value="">Select a restaurant</option>
                  {restaurants.map((row) => <option key={row.id} value={row.id}>{row.businessName}</option>)}
                </Select>
              </Field>
              <Field label={t('common.campaign')}>
                <Select value={brief.campaignId} onChange={(e) => setBrief({ ...brief, campaignId: e.target.value })}>
                  <option value="">{t('common.none')}</option>
                  {campaigns.data?.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </Select>
              </Field>
              <Field label="Ad or content name" required>
                <Input value={brief.name} onChange={(e) => setBrief({ ...brief, name: e.target.value })} placeholder="Weekend brunch — August" required />
              </Field>
              <Field label={t('common.platform')}>
                <Select value={brief.platform} onChange={(e) => setBrief({ ...brief, platform: e.target.value as Platform })}>
                  {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </Select>
              </Field>
              <Field label="Content type">
                <Select value={brief.contentType} onChange={(e) => setBrief({ ...brief, contentType: e.target.value })}>
                  {TYPES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </Select>
              </Field>
              <Field label={t('common.language')}>
                <Select value={brief.language} onChange={(e) => setBrief({ ...brief, language: e.target.value as Language })}>
                  <option value="EN">English</option>
                  <option value="AR">العربية</option>
                </Select>
              </Field>
              <Field label="Product or service">
                <Input value={brief.productService} onChange={(e) => setBrief({ ...brief, productService: e.target.value })} />
              </Field>
              <Field label="Offer">
                <Input value={brief.offer} onChange={(e) => setBrief({ ...brief, offer: e.target.value })} placeholder="20% off this week" />
              </Field>
              <Field label="Audience">
                <Input value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} />
              </Field>
              <Field label="Tone" hint="Defaults to the brand's tone of voice.">
                <Input value={brief.tone} onChange={(e) => setBrief({ ...brief, tone: e.target.value })} />
              </Field>
            </div>
          </Card>

          {/* Generated copy */}
          <Card>
            <CardHeader
              title="Copy"
              subtitle={t('ai.editable')}
              icon={Sparkles}
              action={meta ? <AiBadge isFallback={meta.isFallback} /> : null}
            />
            <div className="space-y-4 p-5">
              {meta?.notice ? <AiNotice notice={meta.notice} /> : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Headline"><Input value={copy.headline} onChange={(e) => setCopy({ ...copy, headline: e.target.value })} /></Field>
                <Field label="Slogan"><Input value={copy.slogan} onChange={(e) => setCopy({ ...copy, slogan: e.target.value })} /></Field>
              </div>
              <Field label="Caption"><Textarea value={copy.caption} onChange={(e) => setCopy({ ...copy, caption: e.target.value })} rows={4} /></Field>
              <Field label="Primary text"><Textarea value={copy.primaryText} onChange={(e) => setCopy({ ...copy, primaryText: e.target.value })} rows={3} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Short text"><Input value={copy.shortText} onChange={(e) => setCopy({ ...copy, shortText: e.target.value })} /></Field>
                <Field label="Call to action"><Input value={copy.cta} onChange={(e) => setCopy({ ...copy, cta: e.target.value })} /></Field>
              </div>
              <Field label="Long text"><Textarea value={copy.longText} onChange={(e) => setCopy({ ...copy, longText: e.target.value })} rows={6} /></Field>

              <Field label="Hashtags">
                <div className="rounded-xl border border-line bg-elevated p-3">
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {copy.hashtags.length === 0 ? (
                      <span className="text-[13px] text-muted">None yet.</span>
                    ) : (
                      copy.hashtags.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => setCopy({ ...copy, hashtags: copy.hashtags.filter((value) => value !== tag) })}
                          className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[12px] text-brand transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
                          title="Remove"
                        >
                          {tag}
                        </button>
                      ))
                    )}
                  </div>
                  <Button variant="secondary" size="sm" icon={Hash} onClick={regenerateHashtags}>{t('ai.hashtags')}</Button>
                </div>
              </Field>
            </div>
          </Card>
        </div>

        {/* Live preview */}
        <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader title="Live preview" />
            <div className="p-4">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {/*
                  Every platform the preview can actually render, rather than a
                  hardcoded five — ContentPreview has surface specs for all of
                  these, so leaving LinkedIn and X out only hid working previews.
                 */}
                {PLATFORMS.map((value) => (
                  <button
                    key={value}
                    onClick={() => setPreviewPlatform(value)}
                    className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                      previewPlatform === value ? 'border-brand bg-brand/12 text-brand' : 'border-line text-muted hover:text-fg'
                    }`}
                  >
                    {humanize(value)}
                  </button>
                ))}
              </div>
              <ContentPreview
                platform={previewPlatform}
                brandName={client?.businessName ?? 'Your brand'}
                logoUrl={client?.logoUrl}
                headline={copy.headline}
                caption={copy.caption}
                cta={copy.cta}
                hashtags={copy.hashtags}
                /*
                 * Attached media wins over the studio's render source: it is the
                 * one that will still be there after the save.
                 */
                mediaUrl={mediaPreviewUrl ?? studioMediaUrl}
              />
            </div>
          </Card>

          <MediaPicker
            clientId={brief.clientId}
            campaignId={brief.campaignId || undefined}
            value={mediaIds}
            onChange={(ids, picked) => {
              setMediaIds(ids);
              setMediaPreviewUrl(picked[0]?.url ?? null);
            }}
          />

          <CreativeStudio
            clientId={brief.clientId}
            campaignId={brief.campaignId || undefined}
            platform={previewPlatform}
            headline={copy.headline}
            ctaLabel={copy.cta}
            onSourceChange={setStudioMediaUrl}
          />

          <Card className="p-4">
            <p className="text-[13px] leading-relaxed text-muted">
              The AI receives only this client's Brand DNA and the brief above — it has no database access and cannot
              read other clients.
            </p>
          </Card>
        </div>
      </div>
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
  timezone: string;
  aiGenerated: boolean;
  client: { id: string; name: string; businessName: string; logoUrl: string | null };
  approvals: Array<{ id: string; status: string; note: string | null; decidedAt: string | null; decidedBy: { name: string } | null }>;
  comments: Array<{ id: string; body: string; createdAt: string; author: { name: string } | null }>;
}

export function ContentDetailPage({ portal = false }: { portal?: boolean }) {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { isAgency } = useAuth();
  const { push } = useToast();
  const [tab, setTab] = useState<'copy' | 'preview' | 'history'>('copy');
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');

  const { data, loading, error, refetch } = useQuery<{ content: ContentDetail }>(`/content/${id}`, [id]);

  /**
   * Change what is attached to an existing piece of content.
   *
   * PATCH replaces the whole set rather than merging, which is what makes
   * "remove the last image" expressible at all — an empty array is a real
   * instruction here, not a missing field.
   */
  const saveMedia = async (mediaIds: string[]) => {
    try {
      await api.patch(`/content/${id}`, { mediaIds });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not update the media', body: err instanceof Error ? err.message : undefined });
    }
  };

  const submit = async () => {
    try {
      await api.post(`/content/${id}/submit`);
      push({ tone: 'success', title: 'Sent for approval' });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not submit', body: err instanceof Error ? err.message : undefined });
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

  if (loading) return <div className="space-y-4"><CardSkeleton rows={2} /><CardSkeleton rows={5} /></div>;
  if (error || !data) return <Card><ErrorState message={error ?? 'Content not found'} onRetry={refetch} /></Card>;

  const content = data.content;
  const canSubmit = isAgency && ['DRAFT', 'REJECTED', 'CHANGES_REQUESTED'].includes(content.status);
  const canSchedule = isAgency && ['APPROVED', 'SCHEDULED'].includes(content.status);

  return (
    <>
      <PageHeader
        title={content.name}
        subtitle={`${content.client.name} · ${humanize(content.platform)} · ${humanize(content.type)}`}
        action={
          <>
            <StatusBadge status={content.status} kind="content" />
            {content.aiGenerated ? <Badge tone="brand"><Sparkles className="h-3 w-3" />AI drafted</Badge> : null}
            {canSubmit ? <Button icon={Send} onClick={submit}>{t('common.submit')}</Button> : null}
            {canSchedule ? <Button variant="secondary" onClick={() => setScheduling(true)}>{t('common.schedule')}</Button> : null}
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
          { value: 'history', label: 'History', count: content.approvals.length + content.comments.length },
        ]}
      />

      {tab === 'copy' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Written copy" />
            <div className="space-y-4 p-5">
              {[
                { label: 'Headline', value: content.headline },
                { label: 'Slogan', value: content.slogan },
                { label: 'Caption', value: content.caption },
                { label: 'Primary text', value: content.primaryText },
                { label: 'Short text', value: content.shortText },
                { label: 'Call to action', value: content.cta },
              ].map((row) => (
                <div key={row.label}>
                  <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">{row.label}</p>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-fg">{row.value || '—'}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <div className="space-y-3 p-5 text-[13px]">
              {[
                { label: t('common.client'), value: content.client.name },
                { label: t('common.campaign'), value: content.campaign?.name ?? '—' },
                { label: t('common.platform'), value: humanize(content.platform) },
                { label: t('common.language'), value: content.language === 'AR' ? 'العربية' : 'English' },
                { label: 'Scheduled', value: content.scheduledAt ? date(content.scheduledAt, lang) : 'Not scheduled' },
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
        </div>
      ) : null}

      {tab === 'preview' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          {/*
            Editable while the content is still the author's to change. Once it is
            approved or later, the creative is part of what was approved, so
            swapping it silently would invalidate the approval.
           */}
          {isAgency && MEDIA_EDITABLE.has(content.status) ? (
            <MediaPicker
              clientId={content.client.id}
              value={content.mediaLinks.map((link) => link.media.id)}
              onChange={(ids) => void saveMedia(ids)}
              title="Media / Creative"
              subtitle="Attach, replace or remove what gets published."
            />
          ) : (
            <Card className="p-4">
              <p className="text-[13px] leading-relaxed text-muted">
                {content.mediaLinks.length === 0
                  ? 'No media is attached to this content.'
                  : 'The creative is locked because this content has already been approved or published. Request changes to edit it.'}
              </p>
            </Card>
          )}

          <div className="mx-auto w-full max-w-md">
          <ContentPreview
            platform={content.platform}
            // The content's own type decides the surface, so a Reel is never
            // previewed as a square feed post.
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
            // Both come from the server. Nothing here decides that something is
            // published or scheduled on its own.
            status={content.status}
            scheduledAt={content.scheduledAt}
            safeZones
          />
          </div>
        </div>
      ) : null}

      {tab === 'history' ? (
        <Card>
          <CardHeader title="Approvals and comments" />
          <div className="divide-y divide-line/60">
            {content.approvals.map((approval) => (
              <div key={approval.id} className="flex items-start gap-3 px-5 py-3.5">
                <span className="mt-0.5"><StatusBadge status={approval.status} kind="approval" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-fg">
                    {approval.decidedBy?.name ?? 'Pending review'}
                    {approval.decidedAt ? ` · ${date(approval.decidedAt, lang)}` : ''}
                  </p>
                  {approval.note ? <p className="mt-0.5 text-[13px] text-muted">{approval.note}</p> : null}
                </div>
              </div>
            ))}
            {content.comments.map((comment) => (
              <div key={comment.id} className="px-5 py-3.5">
                <p className="text-[13px] font-medium text-fg">{comment.author?.name ?? 'Unknown'}</p>
                <p className="mt-0.5 text-[13px] text-muted">{comment.body}</p>
                <p className="mt-1 text-[12px] text-muted/80">{date(comment.createdAt, lang)}</p>
              </div>
            ))}
            {content.approvals.length === 0 && content.comments.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted">Nothing yet.</p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Modal
        open={scheduling}
        onClose={() => setScheduling(false)}
        title="Schedule this content"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setScheduling(false)}>Cancel</Button>
            <Button onClick={schedule} disabled={!scheduledAt} icon={Check}>Schedule</Button>
          </>
        }
      >
        <Field label="Publish at" hint="Only approved content can be scheduled.">
          <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </Field>
      </Modal>

      {!portal && isAgency ? (
        <div className="mt-6 text-center">
          <Link to="/app/content" className="text-[13px] text-brand hover:underline">
            <Plus className="me-1 inline h-3.5 w-3.5" />Back to all content
          </Link>
        </div>
      ) : null}
    </>
  );
}
