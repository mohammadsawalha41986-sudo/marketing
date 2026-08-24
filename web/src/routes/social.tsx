/**
 * The multi-platform composer, and the list of what it has produced.
 *
 * The screen is built around one claim: selecting three platforms gives you
 * three posts you can write differently, not one post copied three times. So the
 * platform strip is not a filter over shared state — each tab edits its own
 * `PlatformPost`, and the preview beside it is that platform's own chrome.
 *
 * Layout follows the same idea. Content on the left, media in the middle,
 * preview on the right at desktop width; two columns at tablet; tabs on mobile,
 * because three columns squeezed onto a phone is three unusable columns.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, FileText, Plus, Save, Send } from 'lucide-react';

import { api, qs, type Paginated, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, humanize } from '../lib/format';
import { cn } from '../lib/utils';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, Select, Textarea, useToast,
} from '../components/ui';
import { MediaPicker } from '../components/media-picker';
import { PLATFORM_VARIANTS, PlatformPreview } from '../components/platform-previews';

/** The platforms an operator can compose for, in the order the strip shows them. */
const COMPOSABLE: Platform[] = [
  'FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'LINKEDIN', 'GOOGLE_BUSINESS',
];

interface PlatformPostRow {
  id: string;
  platform: Platform;
  caption: string | null;
  headline: string | null;
  hashtags: string[];
  linkUrl: string | null;
  ctaLabel: string | null;
  config: Record<string, unknown>;
  status: string;
  scheduledAt: string | null;
  externalPostId: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  errorMessage: string | null;
  integrationAccount: { id: string; name: string; externalId: string; tokenStatus: string } | null;
  media: Array<{ position: number; media: { id: string; url: string; thumbnailUrl: string | null; type: string } }>;
}

interface PostGroupRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  updatedAt: string;
  client: { id: string; name: string; businessName: string; logoUrl: string | null };
  campaign: { id: string; name: string } | null;
  posts: PlatformPostRow[];
}

// ------------------------------------------------------------------ list

export function SocialPostsPage() {
  const { currentId: clientId, current } = useRestaurant();
  const { lang } = useI18n();
  const [creating, setCreating] = useState(false);

  const { data, loading, error, refetch } = useQuery<Paginated<PostGroupRow>>(
    `/social/post-groups${qs({ clientId, pageSize: 50 })}`,
    [clientId],
  );

  return (
    <>
      <PageHeader
        title="Social posts"
        subtitle={
          current
            ? `One idea, written differently for each platform — for ${current.businessName}.`
            : 'Choose a restaurant in the top bar.'
        }
        action={
          <Button icon={Plus} onClick={() => setCreating(true)} disabled={!clientId}>
            Create post
          </Button>
        }
      />

      {loading ? (
        <CardSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={FileText}
          title="No posts yet"
          body="Create one and choose the platforms it should go out on."
        />
      ) : (
        <div className="space-y-2.5">
          {data?.items.map((group) => (
            <Link key={group.id} to={`/app/social/${group.id}`} className="block">
              <Card className="p-4 transition-colors hover:border-brand/40">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-fg">{group.name}</p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      {group.campaign ? `${group.campaign.name} · ` : ''}
                      {date(group.updatedAt, lang)}
                    </p>
                  </div>
                  <Badge tone={GROUP_TONE[group.status] ?? 'neutral'}>{humanize(group.status)}</Badge>
                </div>

                {/* One chip per platform, each showing its own state — the group
                    summary alone would hide a single platform's failure. */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {group.posts.map((post) => (
                    <span
                      key={post.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted"
                    >
                      {post.media[0] ? (
                        <img
                          src={post.media[0].media.thumbnailUrl ?? post.media[0].media.url}
                          alt=""
                          className="h-4 w-4 rounded object-cover"
                        />
                      ) : null}
                      <span className="text-fg">{humanize(post.platform)}</span>
                      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[post.status] ?? 'bg-muted/50')} />
                    </span>
                  ))}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreatePostModal
        open={creating}
        clientId={clientId}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); refetch(); }}
      />
    </>
  );
}

const GROUP_TONE: Record<string, 'brand' | 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'warn',
  CHANGES_REQUESTED: 'warn',
  APPROVED: 'ok',
  SCHEDULED: 'brand',
  PUBLISHING: 'brand',
  PARTIALLY_PUBLISHED: 'warn',
  PUBLISHED: 'accent',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

const STATUS_DOT: Record<string, string> = {
  DRAFT: 'bg-muted/50',
  IN_REVIEW: 'bg-warn',
  CHANGES_REQUESTED: 'bg-warn',
  APPROVED: 'bg-ok',
  SCHEDULED: 'bg-brand',
  QUEUED: 'bg-brand',
  PUBLISHING: 'bg-brand',
  PUBLISHED: 'bg-ok',
  FAILED: 'bg-danger',
  CANCELLED: 'bg-muted/50',
};

// ---------------------------------------------------------------- creation

function CreatePostModal({
  open, clientId, onClose, onCreated,
}: { open: boolean; clientId: string | null; onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [caption, setCaption] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>(['FACEBOOK']);
  const [saving, setSaving] = useState(false);

  const campaigns = useQuery<Paginated<{ id: string; name: string }>>(
    clientId ? `/campaigns${qs({ clientId, pageSize: 100 })}` : null,
    [clientId],
  );

  const toggle = (platform: Platform) =>
    setPlatforms((current) =>
      current.includes(platform) ? current.filter((p) => p !== platform) : [...current, platform],
    );

  const create = async () => {
    if (!clientId || !name.trim() || platforms.length === 0) return;
    setSaving(true);
    try {
      const response = await api.post<{ group: { id: string } }>('/social/post-groups', {
        clientId,
        name: name.trim(),
        campaignId: campaignId || null,
        // A starting point for every platform, not a binding. Each version is
        // editable from the moment it exists.
        shared: { caption: caption.trim() || null },
        platforms: platforms.map((platform) => ({ platform })),
      });
      onCreated();
      navigate(`/app/social/${response.group.id}`);
    } catch (err) {
      push({ tone: 'error', title: 'Could not create the post', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create post"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            icon={Check}
            loading={saving}
            disabled={!name.trim() || platforms.length === 0}
            onClick={create}
          >
            Create {platforms.length} version{platforms.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Post name" required hint="Internal — how you will find it later.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ramadan offer" />
        </Field>

        <Field label="Campaign">
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">No campaign</option>
            {campaigns.data?.items.map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </Select>
        </Field>

        <Field label="Platforms" required hint="Each one gets its own editable version.">
          <div className="flex flex-wrap gap-1.5">
            {COMPOSABLE.map((platform) => (
              <button
                key={platform}
                type="button"
                onClick={() => toggle(platform)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                  platforms.includes(platform)
                    ? 'border-brand bg-brand/12 text-brand'
                    : 'border-line text-muted hover:text-fg',
                )}
              >
                {humanize(platform)}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Starting caption" hint="Copied into each version as a starting point. Edit them separately after.">
          <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ editor

export function SocialPostPage() {
  const { id = '' } = useParams();
  const { lang } = useI18n();
  const { push } = useToast();

  const { data, loading, error, refetch } = useQuery<{ group: PostGroupRow }>(
    `/social/post-groups/${id}`,
    [id],
  );

  const group = data?.group;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [variant, setVariant] = useState<string>('FEED');
  const [mobileTab, setMobileTab] = useState<'content' | 'media' | 'preview'>('content');
  const [busy, setBusy] = useState(false);

  // Local edits, so typing does not round-trip on every keystroke.
  const [draft, setDraft] = useState<Partial<PlatformPostRow>>({});
  const [dirty, setDirty] = useState(false);

  const active = useMemo(
    () => group?.posts.find((post) => post.id === activeId) ?? group?.posts[0] ?? null,
    [group, activeId],
  );

  // Whether this version could actually publish, from the server. Refetched by
  // key so switching platform tabs asks about the right one.
  const readiness = useQuery<{
    ready: boolean;
    compatibility: 'OK' | 'WARNING' | 'INCOMPATIBLE';
    problems: Array<{ level: string; message: string }>;
  }>(active ? `/social/platform-posts/${active.id}/readiness` : null, [active?.id, group?.updatedAt]);

  useEffect(() => {
    if (!active) return;
    setActiveId(active.id);
    setDraft(active);
    setDirty(false);
    setVariant(PLATFORM_VARIANTS[active.platform]?.[0]?.key ?? 'FEED');
    // Keyed on the id: re-seeding on every `active` change would wipe the
    // operator's unsaved edits each time the group refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const set = <K extends keyof PlatformPostRow>(key: K, value: PlatformPostRow[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await api.patch(`/social/platform-posts/${active.id}`, {
        caption: draft.caption ?? null,
        headline: draft.headline ?? null,
        hashtags: draft.hashtags ?? [],
        linkUrl: draft.linkUrl || null,
        ctaLabel: draft.ctaLabel || null,
        mediaIds: (draft.media ?? []).map((row) => row.media.id),
      });
      setDirty(false);
      refetch();
      push({ tone: 'success', title: `${humanize(active.platform)} version saved` });
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: string, scope: 'post' | 'group' = 'post') => {
    if (!active || !group) return;
    setBusy(true);
    try {
      const path = scope === 'group'
        ? `/social/post-groups/${group.id}/${action}`
        : `/social/platform-posts/${active.id}/${action}`;
      await api.post(path);
      refetch();
      push({ tone: 'success', title: humanize(action) });
    } catch (err) {
      push({ tone: 'error', title: `Could not ${action}`, body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <CardSkeleton rows={6} />;
  if (error) return <ErrorState message={error} />;
  if (!group || !active) {
    return <EmptyState icon={FileText} title="Post not found" body="It may have been deleted." />;
  }

  const previewInput = {
    brandName: group.client.businessName,
    logoUrl: group.client.logoUrl,
    headline: draft.headline ?? null,
    caption: draft.caption ?? null,
    hashtags: draft.hashtags ?? [],
    ctaLabel: draft.ctaLabel ?? null,
    linkUrl: draft.linkUrl ?? null,
    media: (draft.media ?? []).map((row) => ({
      url: row.media.url,
      kind: row.media.type === 'VIDEO' ? ('VIDEO' as const) : ('IMAGE' as const),
    })),
    config: draft.config ?? {},
  };

  const variants = PLATFORM_VARIANTS[active.platform] ?? [{ key: 'FEED', label: 'Feed' }];

  return (
    <>
      <PageHeader
        title={group.name}
        subtitle={`${group.client.businessName}${group.campaign ? ` · ${group.campaign.name}` : ''}`}
        action={
          <>
            <Button variant="secondary" icon={Save} loading={busy} disabled={!dirty} onClick={save}>
              Save
            </Button>
            <Button icon={Send} loading={busy} onClick={() => act('submit', 'group')}>
              Submit all for approval
            </Button>
          </>
        }
      />

      {/* One tab per platform. Each edits its own version. */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {group.posts.map((post) => (
          <button
            key={post.id}
            type="button"
            onClick={() => setActiveId(post.id)}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] transition-colors',
              post.id === active.id
                ? 'border-brand bg-brand/12 text-brand'
                : 'border-line text-muted hover:text-fg',
            )}
          >
            {humanize(post.platform)}
            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[post.status] ?? 'bg-muted/50')} />
          </button>
        ))}
      </div>

      {/* Mobile only: three columns on a phone is three unusable columns. */}
      <div className="mb-3 flex gap-1.5 lg:hidden">
        {(['content', 'media', 'preview'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMobileTab(tab)}
            className={cn(
              'flex-1 rounded-lg border px-3 py-2 text-[12px] capitalize transition-colors',
              mobileTab === tab ? 'border-brand bg-brand/12 text-brand' : 'border-line text-muted',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,26rem)]">
        {/* Content */}
        <div className={cn('space-y-4', mobileTab !== 'content' && 'hidden lg:block')}>
          <Card>
            <CardHeader title={`${humanize(active.platform)} content`} icon={FileText} />
            <div className="space-y-4 p-4">
              {active.integrationAccount ? (
                <p className="rounded-lg border border-line bg-elevated px-3 py-2 text-[12px] text-muted">
                  Publishing to <span className="text-fg">{active.integrationAccount.name}</span>
                </p>
              ) : (
                <p className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                  No account attached for {humanize(active.platform)}. Connect one under Integrations.
                </p>
              )}

              <Field label="Headline" hint="Used by platforms that separate a title from the body.">
                <Input
                  value={draft.headline ?? ''}
                  onChange={(e) => set('headline', e.target.value)}
                />
              </Field>

              <Field label="Caption">
                <Textarea
                  value={draft.caption ?? ''}
                  onChange={(e) => set('caption', e.target.value)}
                  rows={6}
                />
              </Field>

              <Field label="Hashtags" hint="Comma separated, without the #.">
                <Input
                  value={(draft.hashtags ?? []).join(', ')}
                  onChange={(e) =>
                    set('hashtags', e.target.value.split(',').map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean))
                  }
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Link">
                  <Input value={draft.linkUrl ?? ''} onChange={(e) => set('linkUrl', e.target.value)} />
                </Field>
                <Field label="Call to action">
                  <Input value={draft.ctaLabel ?? ''} onChange={(e) => set('ctaLabel', e.target.value)} />
                </Field>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Workflow" subtitle={`This ${humanize(active.platform)} version only.`} />

            {/* What is stopping it, before the button rather than after. */}
            {readiness.data && readiness.data.problems.length > 0 ? (
              <div className="mx-4 mt-4 space-y-1.5">
                {readiness.data.problems.map((problem, index) => (
                  <p
                    key={index}
                    className={cn(
                      'rounded-lg border p-2.5 text-[12px]',
                      problem.level === 'INCOMPATIBLE'
                        ? 'border-danger/25 bg-danger/10 text-fg'
                        : 'border-warn/25 bg-warn/10 text-fg',
                    )}
                  >
                    {problem.message}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 p-4">
              <Button size="sm" variant="secondary" loading={busy} onClick={() => act('submit')}>Submit</Button>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => act('approve')}>Approve</Button>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => act('request-changes')}>
                Request changes
              </Button>
              <Button size="sm" icon={Send} loading={busy} onClick={() => act('publish-now')}>Publish now</Button>
            </div>

            {active.errorMessage ? (
              <p className="mx-4 mb-4 rounded-lg border border-danger/25 bg-danger/10 p-3 text-[13px] text-fg">
                {active.errorMessage}
              </p>
            ) : null}

            {active.externalPostId ? (
              <div className="mx-4 mb-4 rounded-lg border border-ok/25 bg-ok/10 p-3 text-[13px]">
                <p className="font-medium text-ok">Published</p>
                <p className="mt-1 text-fg">
                  <span className="text-muted">Post ID </span>
                  <span className="select-all font-mono text-[12px]">{active.externalPostId}</span>
                </p>
                {active.publishedAt ? (
                  <p className="text-[12px] text-muted">{date(active.publishedAt, lang)}</p>
                ) : null}
              </div>
            ) : null}
          </Card>
        </div>

        {/* Media */}
        <div className={cn(mobileTab !== 'media' && 'hidden lg:block')}>
          <MediaPicker
            clientId={group.client.id}
            value={(draft.media ?? []).map((row) => row.media.id)}
            onChange={(_ids, picked) => {
              set('media', picked.map((row, position) => ({
                position,
                media: { id: row.id, url: row.url, thumbnailUrl: row.thumbnailUrl, type: row.type },
              })) as PlatformPostRow['media']);
            }}
            title={`${humanize(active.platform)} media`}
            subtitle="Each platform can carry its own creative."
          />
        </div>

        {/* Preview */}
        <div className={cn('space-y-3', mobileTab !== 'preview' && 'hidden lg:block')}>
          {variants.length > 1 ? (
            <div className="flex gap-1.5">
              {variants.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setVariant(row.key)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    variant === row.key ? 'border-brand bg-brand/12 text-brand' : 'border-line text-muted',
                  )}
                >
                  {row.label}
                </button>
              ))}
            </div>
          ) : null}

          <PlatformPreview platform={active.platform} variant={variant} input={previewInput} />

          <p className="text-center text-[11px] text-muted">
            An approximation of {humanize(active.platform)}, not a live post.
          </p>
        </div>
      </div>
    </>
  );
}
