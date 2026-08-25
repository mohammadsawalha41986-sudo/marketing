/**
 * The content command centre.
 *
 * One screen, filtered many ways, over the platform posts that already exist —
 * this adds no model and no second source of truth. `/social/content` is the
 * feed, `/social/capabilities` says what each platform can do, and the composer
 * at /app/social remains the place a post is written. The workspace is where an
 * operator finds the post, sees what state it is in and decides what happens to
 * it next.
 *
 * Why platform is a route segment rather than only a filter: "show me
 * everything going out on Instagram" is a place an operator returns to, links a
 * colleague to and keeps a tab open on. A filter in component state cannot be
 * any of those. /app/library/instagram is that place; the toolbar's platform
 * selector navigates rather than setting state, so the two can never disagree.
 *
 * Every filter that narrows the server query is sent to the server. The AI
 * filter is the one exception and says so: recommendations are computed per
 * post on request, so filtering the whole table by them would mean scoring
 * every row on every keystroke. It filters what is on screen, and the label
 * says exactly that.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CalendarDays, Copy, Eye, LayoutGrid, List, Pencil, Plug, Plus, RotateCcw,
  Search, Send, Sparkles, Trash2,
} from 'lucide-react';

import { api, qs, type Paginated, type Platform } from '../lib/api';
import { useQuery, useDebounced } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { PLATFORM_LABELS, humanize } from '../lib/format';
import { cn } from '../lib/utils';
import {
  Button, Card, CardSkeleton, EmptyState, ErrorState, Input, Pagination,
  PageHeader, Select, useToast,
} from '../components/ui';
import { ContentCard, type ContentCardAction } from '../components/content-card';
import { PreviewDrawer } from '../components/preview-drawer';
import {
  PLATFORM_SLUGS, STATUS_GROUPS, WORKSPACE_PLATFORMS, contentTypeOf, slugFor,
  type PlatformCapability, type StatusGroup, type WorkspacePost,
} from '../lib/workspace-content';

const PAGE_SIZE = 24;

/** Date-range presets, as day offsets. `null` means no bound. */
const RANGES: Array<{ key: string; days: number | null }> = [
  { key: 'any', days: null },
  { key: '7', days: 7 },
  { key: '30', days: 30 },
  { key: '90', days: 90 },
];

/**
 * The platform's own spelling. `humanize` would give "Tiktok" and "Youtube",
 * which is a brand name spelt wrong on every card in the product.
 */
const platformLabel = (platform: Platform): string =>
  PLATFORM_LABELS[platform] ?? humanize(platform);

export function LibraryPage() {
  const { platform: platformSlug } = useParams<{ platform?: string }>();
  const navigate = useNavigate();
  const { currentId: clientId, current } = useRestaurant();
  const { t } = useI18n();
  const { push } = useToast();

  const platform: Platform | undefined = platformSlug ? PLATFORM_SLUGS[platformSlug] : undefined;

  const [statusGroup, setStatusGroup] = useState<StatusGroup>('ALL');
  const [type, setType] = useState('');
  const [range, setRange] = useState('any');
  const [campaignId, setCampaignId] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<WorkspacePost | null>(null);

  const debouncedSearch = useDebounced(search, 300);

  // A filter change invalidates the page number: staying on page 4 of a result
  // set that now has one page shows an empty grid over a non-empty result.
  useEffect(() => {
    setPage(1);
  }, [platform, statusGroup, type, range, campaignId, debouncedSearch, clientId]);

  const from = useMemo(() => {
    const days = RANGES.find((entry) => entry.key === range)?.days;
    if (!days) return undefined;
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString();
  }, [range]);

  /*
   * One status is sent to the server; a group of several is narrowed on the
   * client. NEEDS_ATTENTION spans two statuses and the endpoint takes a single
   * one, and widening the API to take a list for one screen's convenience is a
   * bigger change than filtering two statuses here.
   */
  const statuses = STATUS_GROUPS[statusGroup];
  const serverStatus = statuses.length === 1 ? statuses[0] : undefined;

  const path = `/social/content${qs({
    clientId: clientId ?? undefined,
    platform,
    status: serverStatus,
    campaignId: campaignId || undefined,
    search: debouncedSearch || undefined,
    from,
    page,
    pageSize: PAGE_SIZE,
  })}`;

  const feed = useQuery<Paginated<WorkspacePost>>(path, [path]);

  // Capabilities are static per deployment, so this is fetched once and reused
  // by every card and the empty states rather than per post.
  const capabilities = useQuery<{ platforms: PlatformCapability[] }>('/social/capabilities', []);

  const campaigns = useQuery<Paginated<{ id: string; name: string }>>(
    clientId ? `/campaigns${qs({ clientId, pageSize: 100 })}` : null,
    [clientId],
  );

  const rows = useMemo(() => {
    let items = feed.data?.items ?? [];
    if (statuses.length > 1) {
      items = items.filter((post) => (statuses as readonly string[]).includes(post.status));
    }
    if (type) items = items.filter((post) => contentTypeOf(post) === type);
    return items;
  }, [feed.data, statuses, type]);

  const capability = platform
    ? capabilities.data?.platforms.find((entry) => entry.platform === platform)
    : undefined;

  const refresh = feed.refetch;

  const act = useCallback(
    async (post: WorkspacePost, action: 'schedule' | 'publish' | 'cancel') => {
      try {
        await api.post(`/social/platform-posts/${post.id}/${action}`, {});
        push({ tone: 'success', title: t('library.actionDone') });
        refresh();
      } catch (error) {
        push({
          tone: 'error',
          title: t('library.actionFailed'),
          body: error instanceof Error ? error.message : undefined,
        });
      }
    },
    [push, refresh, t],
  );

  const remove = useCallback(
    async (post: WorkspacePost) => {
      // The group is the deletable unit — the API refuses to delete one that has
      // published anywhere, and that refusal is surfaced rather than pre-empted.
      try {
        await api.delete(`/social/post-groups/${post.postGroup.id}`);
        push({ tone: 'success', title: t('library.deleted') });
        setSelected(null);
        refresh();
      } catch (error) {
        push({
          tone: 'error',
          title: t('library.deleteFailed'),
          body: error instanceof Error ? error.message : undefined,
        });
      }
    },
    [push, refresh, t],
  );

  const actionsFor = useCallback(
    (post: WorkspacePost): ContentCardAction[] => {
      const published = post.status === 'PUBLISHED' || Boolean(post.externalUrl);
      return [
        { key: 'preview', label: t('library.preview'), icon: Eye, onSelect: () => setSelected(post) },
        {
          key: 'edit',
          label: t('common.edit'),
          icon: Pencil,
          onSelect: () => navigate(`/app/social/${post.postGroup.id}`),
        },
        {
          key: 'duplicate',
          label: t('library.duplicate'),
          icon: Copy,
          // Opens the composer on the idea this post belongs to, which is where
          // a new version is actually made. A silent server-side copy would put
          // an unreviewed draft in the queue with nobody looking at it.
          onSelect: () => navigate(`/app/social/${post.postGroup.id}`),
        },
        {
          key: 'schedule',
          label: t('library.schedule'),
          icon: CalendarDays,
          hidden: published || post.status === 'SCHEDULED',
          onSelect: () => void act(post, 'schedule'),
        },
        {
          key: 'publish',
          label: t('library.publish'),
          icon: Send,
          hidden: published,
          onSelect: () => void act(post, 'publish'),
        },
        {
          key: 'cancel',
          label: t('library.archive'),
          icon: RotateCcw,
          hidden: published || post.status === 'CANCELLED',
          onSelect: () => void act(post, 'cancel'),
        },
        {
          key: 'delete',
          label: t('common.delete'),
          icon: Trash2,
          danger: true,
          // Hidden rather than shown failing: the API refuses to delete a group
          // that has published anywhere.
          hidden: published,
          onSelect: () => void remove(post),
        },
      ];
    },
    [act, navigate, remove, t],
  );

  const siblings = useMemo(() => {
    if (!selected) return [];
    return (feed.data?.items ?? []).filter(
      (post) => post.postGroup.id === selected.postGroup.id,
    );
  }, [feed.data, selected]);

  const pages = feed.data?.pagination.pages ?? 1;

  return (
    <>
      <PageHeader
        title={
          platform
            ? t('library.platformTitle').replace('{platform}', platformLabel(platform))
            : t('library.title')
        }
        subtitle={current ? current.businessName : t('library.pickRestaurant')}
        action={
          <>
            <Button variant="secondary" icon={CalendarDays} onClick={() => navigate('/app/social/calendar')}>
              {t('library.calendar')}
            </Button>
            <Button icon={Plus} disabled={!clientId} onClick={() => navigate('/app/social')}>
              {t('library.create')}
            </Button>
          </>
        }
      />

      {/* Platform tabs. These navigate rather than set state, so the URL is
          always the truth about what is being shown. */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => navigate('/app/library')}
          className={cn(
            'rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
            !platform ? 'border-brand bg-brand/12 text-brand' : 'border-line text-muted hover:text-fg',
          )}
        >
          {t('library.allContent')}
        </button>
        {WORKSPACE_PLATFORMS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => navigate(`/app/library/${slugFor(entry)}`)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              platform === entry
                ? 'border-brand bg-brand/12 text-brand'
                : 'border-line text-muted hover:text-fg',
            )}
          >
            {platformLabel(entry)}
          </button>
        ))}
      </div>

      {/* Toolbar. Wraps rather than scrolls, so nothing is unreachable on a
          narrow screen. */}
      <Card className="mb-4 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('common.search')}
              className="ps-8"
              aria-label={t('common.search')}
            />
          </div>

          <Select
            value={statusGroup}
            onChange={(event) => setStatusGroup(event.target.value as StatusGroup)}
            aria-label={t('common.status')}
            className="w-auto"
          >
            {(Object.keys(STATUS_GROUPS) as StatusGroup[]).map((key) => (
              <option key={key} value={key}>
                {t(`sg.${key}` as TranslationKey)}
              </option>
            ))}
          </Select>

          <Select
            value={type}
            onChange={(event) => setType(event.target.value)}
            aria-label={t('library.type')}
            className="w-auto"
          >
            <option value="">{t('library.allTypes')}</option>
            {['IMAGE', 'VIDEO', 'CAROUSEL', 'REEL', 'LINK', 'TEXT'].map((entry) => (
              <option key={entry} value={entry}>{t(`ct.${entry}` as TranslationKey)}</option>
            ))}
          </Select>

          <Select
            value={range}
            onChange={(event) => setRange(event.target.value)}
            aria-label={t('common.date')}
            className="w-auto"
          >
            {RANGES.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.days ? t(`library.last${entry.key}` as 'library.last7') : t('library.anyDate')}
              </option>
            ))}
          </Select>

          <Select
            value={campaignId}
            onChange={(event) => setCampaignId(event.target.value)}
            aria-label={t('common.campaign')}
            className="w-auto"
          >
            <option value="">{t('library.allCampaigns')}</option>
            {campaigns.data?.items.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </Select>

          <div className="ms-auto flex items-center gap-1 rounded-lg bg-elevated p-0.5">
            {([
              { value: 'grid' as const, icon: LayoutGrid, label: t('library.grid') },
              { value: 'list' as const, icon: List, label: t('library.list') },
            ]).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setView(option.value)}
                aria-label={option.label}
                aria-pressed={view === option.value}
                className={cn(
                  'grid h-7 w-7 place-items-center rounded-md transition-colors',
                  view === option.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                <option.icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/*
        * A platform the deployment cannot publish to is worth saying out loud
        * here rather than at the moment someone presses Publish.
        */}
      {capability && !capability.publishes ? (
        <p className="mb-3 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">
          {t('library.notPublishable')}
        </p>
      ) : null}

      {!clientId ? (
        <EmptyState
          icon={Sparkles}
          title={t('library.pickRestaurantTitle')}
          body={t('library.pickRestaurant')}
        />
      ) : feed.loading ? (
        <CardSkeleton rows={6} />
      ) : feed.error ? (
        <ErrorState message={feed.error} onRetry={feed.refetch} />
      ) : rows.length === 0 ? (
        /*
          * The empty state answers the likeliest cause. A platform view with no
          * connected account is a connection problem, and sending the operator
          * to Integrations is more useful than telling them to write a post they
          * currently cannot publish.
          */
        platform && capability && !capability.publishes ? (
          <EmptyState
            icon={Plug}
            title={t('library.noAccountTitle')}
            body={t('library.noAccountBody')}
            action={<Link to="/app/integrations"><Button icon={Plug}>{t('nav.integrations')}</Button></Link>}
          />
        ) : (
          <EmptyState
            icon={Sparkles}
            title={t('library.emptyTitle')}
            body={t('library.emptyBody')}
            action={<Button icon={Plus} onClick={() => navigate('/app/social')}>{t('library.create')}</Button>}
          />
        )
      ) : (
        <>
          <div
            className={cn(
              view === 'grid'
                ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                : 'space-y-2',
            )}
          >
            {rows.map((post) => (
              <ContentCard
                key={post.id}
                post={post}
                view={view}
                actions={actionsFor(post)}
                onOpen={() => setSelected(post)}
              />
            ))}
          </div>

          <Pagination page={page} pages={pages} onChange={setPage} />
        </>
      )}

      <PreviewDrawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        post={selected}
        siblings={siblings}
        onSelectSibling={setSelected}
        logoUrl={current?.logoUrl}
        footer={
          selected ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                icon={Pencil}
                onClick={() => navigate(`/app/social/${selected.postGroup.id}`)}
              >
                {t('common.edit')}
              </Button>
              {selected.status !== 'PUBLISHED' && !selected.externalUrl ? (
                <Button className="flex-1" icon={Send} onClick={() => void act(selected, 'publish')}>
                  {t('library.publish')}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
    </>
  );
}
