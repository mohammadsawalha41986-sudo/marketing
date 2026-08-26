/**
 * The Marketing Command Center — the platform overview, and one workspace per
 * platform group.
 *
 * Everything about *what a platform can do* still comes from
 * `/api/marketing/capabilities`. Nothing here decides it; the page asks. That
 * remains the point: a screen holding its own opinion about whether TikTok can
 * publish becomes a second source of truth that drifts the first time an
 * integration ships or a credential is set.
 *
 * What this phase adds is the second half of the answer — *what is happening on
 * it right now*. A capability list tells an operator that Meta publishing is
 * supported; it does not tell them that four posts go out today, one failed
 * last night, and the authorisation expires in a week. So the workspace pairs
 * the matrix (what the deployment can do) with the pulse (what this project's
 * connection is actually doing), and keeps them visibly separate, because they
 * fail for different reasons and have different fixes.
 *
 * A workspace is a group, not a `Platform`. Meta is one login and one app
 * review covering Facebook and Instagram; Google is one OAuth client covering
 * Business Profile and Ads. Membership is the server's answer, fetched rather
 * than restated here.
 *
 * Tabs appear only where the section exists. A channel a platform genuinely
 * does not have — Snapchat organic, Google Ads organic — gets no tab and is
 * stated once on the Overview with the provider's actual reason, rather than an
 * empty section an operator would read as "no data yet".
 */

import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, CalendarDays, CircleSlash, ExternalLink, FileText, KeyRound,
  PenLine, Plug, ShieldCheck, Sparkles, TriangleAlert, Wallet, Wrench,
} from 'lucide-react';

import { qs, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { PLATFORM_LABELS, num, relative } from '../lib/format';
import { cn } from '../lib/utils';
import {
  FALLBACK_WORKSPACES, WORKSPACE_LABEL_KEYS, WORKSPACE_ORDER,
  workspacePath, type Workspace, type WorkspaceKey,
} from '../lib/workspaces';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader,
  Tabs, type BadgeTone,
} from '../components/ui';
import { PlatformChip } from '../components/domain';
import { MarketingCalendar } from '../components/marketing-calendar';

type CapabilityState =
  | 'SUPPORTED' | 'NOT_CONFIGURED' | 'REQUIRES_APPROVAL' | 'NOT_SUPPORTED' | 'NOT_IMPLEMENTED';

interface Capability {
  surface: string;
  state: CapabilityState;
  detail: string;
  requiredEnv: string[];
  approval: string | null;
}

interface ChannelMatrix {
  channel: 'ORGANIC' | 'PAID';
  available: boolean;
  capabilities: Capability[];
  state: CapabilityState;
}

interface PlatformMatrix {
  platform: Platform;
  label: string;
  organic: ChannelMatrix;
  paid: ChannelMatrix;
  production: CapabilityState;
}

interface AdjacentProduct {
  key: string;
  label: string;
  state: CapabilityState;
  detail: string;
}

interface CapabilitiesResponse {
  platforms: PlatformMatrix[];
  adjacent: AdjacentProduct[];
}

type IntegrationStatus =
  | 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'
  | 'TOKEN_EXPIRED' | 'REAUTH_REQUIRED' | 'ERROR' | 'EXPIRED';

interface ConnectionHealth {
  clientId: string;
  clientName: string;
  platform: Platform;
  status: IntegrationStatus;
  accountName: string | null;
  accountId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  accounts: Array<{ id: string; name: string; username: string | null; kind: string; selected: boolean }>;
}

interface PulseResponse {
  workspace: Workspace | null;
  counts: {
    scheduled: number;
    publishing: number;
    published: number;
    needsAttention: number;
    attention: { failedPosts: number; failedAds: number; brokenConnections: number };
  };
  connections: ConnectionHealth[];
}

/**
 * Colour carries meaning here, so it is assigned by what the operator can do
 * rather than by severity. `NOT_SUPPORTED` is deliberately neutral, not red:
 * nothing is wrong, and a red badge would send someone looking for a fix that
 * does not exist.
 */
const TONES: Record<CapabilityState, BadgeTone> = {
  SUPPORTED: 'ok',
  REQUIRES_APPROVAL: 'warn',
  NOT_CONFIGURED: 'warn',
  NOT_IMPLEMENTED: 'neutral',
  NOT_SUPPORTED: 'neutral',
};

const ICONS: Record<CapabilityState, typeof ShieldCheck> = {
  SUPPORTED: ShieldCheck,
  REQUIRES_APPROVAL: ShieldCheck,
  NOT_CONFIGURED: KeyRound,
  NOT_IMPLEMENTED: Wrench,
  NOT_SUPPORTED: CircleSlash,
};

/** Connection health, on the same principle: red only where something broke. */
const CONNECTION_TONES: Record<IntegrationStatus, BadgeTone> = {
  CONNECTED: 'ok',
  CONNECTING: 'warn',
  DISCONNECTED: 'neutral',
  TOKEN_EXPIRED: 'danger',
  REAUTH_REQUIRED: 'danger',
  ERROR: 'danger',
  EXPIRED: 'danger',
};

/**
 * `Badge` is `whitespace-nowrap` by design, which is right for a status word
 * and wrong for these: "Not available through connected API" is a whole clause,
 * and at 390px it pushed the card past the viewport and gave the page a
 * horizontal scrollbar. The wording is not ours to shorten — it is the answer
 * §38 requires — so the badge wraps instead.
 */
function StateBadge({ state }: { state: CapabilityState }) {
  const { t } = useI18n();
  return (
    <Badge tone={TONES[state]} className="whitespace-normal text-start leading-snug">
      {t(`cap.${state}` as TranslationKey)}
    </Badge>
  );
}

function ConnectionBadge({ status }: { status: IntegrationStatus }) {
  const { t } = useI18n();
  return (
    <Badge tone={CONNECTION_TONES[status]} className="whitespace-normal text-start leading-snug">
      {t(`ws.conn.${status}` as TranslationKey)}
    </Badge>
  );
}

function EnvList({ names }: { names: string[] }) {
  const { t } = useI18n();
  return (
    <p className="text-[12px] text-muted">
      <span className="font-medium text-fg">{t('pw.requiredEnv')}: </span>
      {/* Names only. The server never sends a value. Forced LTR because a
          variable name reversed inside an RTL run is unusable to paste. */}
      <code className="rounded bg-elevated px-1 py-0.5 text-[11px]" dir="ltr">
        {names.join(', ')}
      </code>
    </p>
  );
}

function CapabilityRow({
  capability, showEnv,
}: { capability: Capability; showEnv: boolean }) {
  const { t } = useI18n();
  const Icon = ICONS[capability.state];

  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">
            {t(`surface.${capability.surface}` as TranslationKey)}
          </p>
          {/* Server-authored, and may be English inside an RTL page. */}
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted" dir="auto">
            {capability.detail}
          </p>

          {showEnv && capability.requiredEnv.length > 0 ? (
            <div className="mt-1.5"><EnvList names={capability.requiredEnv} /></div>
          ) : null}

          {capability.approval ? (
            <p className="mt-1.5 text-[12px] text-muted" dir="auto">
              <span className="font-medium text-fg">{t('pw.approvalNeeded')}: </span>
              {capability.approval}
            </p>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 ps-7 sm:ps-0">
        <StateBadge state={capability.state} />
      </div>
    </li>
  );
}

function ChannelCard({ channel, title }: { channel: ChannelMatrix; title: string }) {
  const { t } = useI18n();

  /*
   * A channel the platform does not have is stated once and closed, rather than
   * listing a dozen identical "not available" rows. Google Ads has no organic
   * channel and Business Profile is not an ads product; twelve repetitions of
   * that reads as a fault rather than as a fact.
   */
  if (!channel.available) {
    return (
      <Card>
        <CardHeader title={title} action={<StateBadge state={channel.state} />} />
        <p className="text-[13px] leading-relaxed text-muted" dir="auto">
          {channel.capabilities[0]?.detail
            ?? t('pw.channelUnavailable').replace('{channel}', title)}
        </p>
      </Card>
    );
  }

  /*
   * When every blocked capability is waiting on the *same* credentials — which
   * is the normal case, because a credential group gates a whole channel — the
   * variable names are stated once above the list rather than on all twelve
   * rows. Repeated verbatim down the card they read as twelve separate
   * problems, and the one useful instruction gets lost in its own echo.
   */
  const envLists = new Set(
    channel.capabilities
      .filter((capability) => capability.requiredEnv.length > 0)
      .map((capability) => capability.requiredEnv.join(',')),
  );
  const sharedEnv = envLists.size === 1 ? [...envLists][0]!.split(',') : null;

  return (
    <Card>
      <CardHeader title={title} action={<StateBadge state={channel.state} />} />
      {sharedEnv ? (
        <div className="mb-3 rounded-lg border border-line bg-elevated/50 px-3 py-2">
          <EnvList names={sharedEnv} />
        </div>
      ) : null}
      <ul className="-mt-1">
        {channel.capabilities.map((capability) => (
          <CapabilityRow
            key={capability.surface}
            capability={capability}
            showEnv={sharedEnv === null}
          />
        ))}
      </ul>
    </Card>
  );
}

// --------------------------------------------------------------- overview

/** `/app/marketing` — every workspace, with what it can do here. */
export function MarketingOverviewPage() {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useQuery<CapabilitiesResponse>('/marketing/capabilities');
  const registry = useQuery<{ workspaces: Workspace[] }>('/marketing/workspaces');

  const workspaces = registry.data?.workspaces
    ?? WORKSPACE_ORDER.map((key) => FALLBACK_WORKSPACES[key]);

  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const matrixFor = (platform: Platform) =>
    data?.platforms.find((entry) => entry.platform === platform) ?? null;

  /**
   * A workspace's summary is the *best* state across its platforms, because
   * "can I advertise on Meta" is answered yes when either Facebook or Instagram
   * can. The workspace page below shows each platform separately, so nothing is
   * hidden by the roll-up — it only decides which badge the card wears.
   */
  const RANK: CapabilityState[] = [
    'SUPPORTED', 'REQUIRES_APPROVAL', 'NOT_CONFIGURED', 'NOT_IMPLEMENTED', 'NOT_SUPPORTED',
  ];
  const best = (states: CapabilityState[]): CapabilityState =>
    RANK.find((candidate) => states.includes(candidate)) ?? 'NOT_IMPLEMENTED';

  return (
    <>
      <PageHeader title={t('pw.overviewTitle')} subtitle={t('pw.overviewSubtitle')} />

      {loading || !data ? (
        <CardSkeleton rows={6} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {workspaces.map((workspace) => {
              const matrices = workspace.platforms
                .map(matrixFor)
                .filter((entry): entry is PlatformMatrix => entry !== null);
              if (matrices.length === 0) return null;

              const key = workspace.key as WorkspaceKey;
              return (
                <Link
                  key={workspace.key}
                  to={workspacePath(key)}
                  className="rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <Card className="h-full transition-colors hover:border-brand/40">
                    {/*
                      * The workspace's own name leads. It previously opened
                      * with a member platform's chip, so the Meta card read
                      * "Facebook / Meta / Facebook + Instagram" — the group
                      * introduced by one of its members. The members are drawn
                      * below as marks, which is what they are here.
                      */}
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-fg">
                          {t(WORKSPACE_LABEL_KEYS[key] ?? 'nav.platforms')}
                        </p>
                        {workspace.sublabel ? (
                          <p className="text-[12px] text-muted" dir="auto">{workspace.sublabel}</p>
                        ) : null}
                      </div>
                      <StateBadge state={best(matrices.map((entry) => entry.production))} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {workspace.platforms.map((platform) => (
                        <PlatformChip key={platform} platform={platform} size="sm" />
                      ))}
                    </div>
                    {/* Both channels, always — the summary above is the better
                        of the two, and hiding the weaker one would flatter it. */}
                    <dl className="mt-4 space-y-2 text-[13px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-muted">{t('pw.organic')}</dt>
                        <dd><StateBadge state={best(matrices.map((entry) => entry.organic.state))} /></dd>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-muted">{t('pw.paid')}</dt>
                        <dd><StateBadge state={best(matrices.map((entry) => entry.paid.state))} /></dd>
                      </div>
                    </dl>
                  </Card>
                </Link>
              );
            })}
          </div>

          {data.adjacent.length > 0 ? (
            <Card className="mt-6">
              <CardHeader title={t('pw.adjacent')} />
              <ul className="-mt-1">
                {data.adjacent.map((product) => (
                  <li
                    key={product.key}
                    className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-fg">{product.label}</p>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-muted" dir="auto">
                        {product.detail}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <StateBadge state={product.state} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

// -------------------------------------------------------------- workspace

type Tab = 'overview' | 'organic' | 'paid' | 'calendar' | 'analytics' | 'reports' | 'connection';

/** One "today" counter. The needs-attention card names its parts. */
function PulseCard({
  label, value, icon: Icon, tone = 'neutral', detail,
}: {
  label: string; value: number; icon: typeof Activity; tone?: 'neutral' | 'danger'; detail?: string | null;
}) {
  const { lang } = useI18n();
  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] font-medium text-muted">{label}</p>
        <Icon
          className={cn('h-4 w-4 shrink-0', tone === 'danger' && value > 0 ? 'text-danger' : 'text-muted')}
          aria-hidden
        />
      </div>
      <p className={cn(
        'mt-1 text-[26px] font-semibold tabular leading-none',
        tone === 'danger' && value > 0 ? 'text-danger' : 'text-fg',
      )}
      >
        {num(value, lang)}
      </p>
      {detail ? <p className="mt-1.5 text-[11px] leading-snug text-muted" dir="auto">{detail}</p> : null}
    </Card>
  );
}

/**
 * One project's connection to one platform.
 *
 * The project is in the header, not implied. An `Integration` belongs to a
 * project rather than to the deployment, so the roll-up view has one row per
 * project per platform — this rendered four identical "Facebook — Not
 * connected" cards with nothing to distinguish them, which is a list nobody
 * can act on. The project name is what makes each row a different thing.
 */
function ConnectionCard({ health, showProject }: { health: ConnectionHealth; showProject: boolean }) {
  const { t, lang } = useI18n();
  const selected = health.accounts.filter((account) => account.selected);

  return (
    <Card>
      <CardHeader
        title={PLATFORM_LABELS[health.platform] ?? health.platform}
        subtitle={showProject ? health.clientName : undefined}
        action={<ConnectionBadge status={health.status} />}
      />

      {/*
        * The provider's own words, never replaced with a generic apology. An
        * operator can act on "the token was revoked"; they cannot act on
        * "something went wrong".
        */}
      {health.lastError ? (
        <p className="mb-3 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2 text-[12px] leading-relaxed text-fg" dir="auto">
          {health.lastError}
        </p>
      ) : null}

      <dl className="space-y-1.5 text-[13px]">
        {health.accountName ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted">{t('ws.accounts')}</dt>
            <dd className="min-w-0 truncate font-medium text-fg" dir="auto">{health.accountName}</dd>
          </div>
        ) : null}
        {health.lastSyncAt ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted">{t('common.lastSync')}</dt>
            <dd className="text-muted">{relative(health.lastSyncAt, lang)}</dd>
          </div>
        ) : null}
      </dl>

      {selected.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {selected.map((account) => (
            <li key={account.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
              <span className="min-w-0 truncate text-[13px] text-fg" dir="auto">{account.name}</span>
              <Badge tone="neutral" className="ms-auto">{account.kind}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[12px] text-muted">{t('ws.noAccounts')}</p>
      )}
    </Card>
  );
}

/** `/app/marketing/:workspace` — one platform group's whole surface. */
export function PlatformWorkspacePage() {
  const { t, lang } = useI18n();
  const params = useParams<{ platform: string }>();
  const [search, setSearch] = useSearchParams();
  const { currentId: clientId, current } = useRestaurant();

  const slug = (params.platform ?? '').toLowerCase();

  const capabilities = useQuery<CapabilitiesResponse>('/marketing/capabilities');
  const registry = useQuery<{ workspaces: Workspace[] }>('/marketing/workspaces');

  /*
   * The operator's own day, computed in the browser. The server refuses to
   * guess a timezone, and a UTC midnight is nobody's "today".
   */
  const dayWindow = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const pulse = useQuery<PulseResponse>(
    `/marketing/pulse${qs({ workspace: slug, clientId, ...dayWindow })}`,
    [slug, clientId, dayWindow.from],
  );

  const workspace = useMemo<Workspace | null>(() => {
    const fromServer = pulse.data?.workspace ?? null;
    if (fromServer) return fromServer;
    const listed = registry.data?.workspaces.find(
      (entry) => entry.key.toLowerCase() === slug,
    );
    if (listed) return listed;
    const fallbackKey = WORKSPACE_ORDER.find((key) => key.toLowerCase() === slug);
    return fallbackKey ? FALLBACK_WORKSPACES[fallbackKey] : null;
  }, [pulse.data, registry.data, slug]);

  const matrices = useMemo(
    () => (workspace && capabilities.data
      ? workspace.platforms
        .map((platform) => capabilities.data!.platforms.find((entry) => entry.platform === platform))
        .filter((entry): entry is PlatformMatrix => entry !== undefined)
      : []),
    [workspace, capabilities.data],
  );

  /*
   * A channel counts towards this workspace's sections when there is something
   * an operator could do about it — it works, or it needs a credential or an
   * approval they can go and get. NOT_IMPLEMENTED and NOT_SUPPORTED are not
   * that: nothing on a Paid tab for Snapchat would ever be actionable, and a
   * Calendar tab that can only ever be empty is worse than no tab, because an
   * empty grid reads as "nothing scheduled" rather than "this cannot exist".
   *
   * Found by opening the Snapchat workspace: it offered Paid, Calendar and
   * Analytics tabs and an "Open the advertising centre" button for a platform
   * this deployment has no advertising integration for. The Overview still
   * states every channel's real state and reason, so nothing is hidden — the
   * reason is simply given once, where it is a finished answer, instead of
   * behind a tab that promises a workspace and delivers an apology.
   */
  const ACTIONABLE: CapabilityState[] = ['SUPPORTED', 'NOT_CONFIGURED', 'REQUIRES_APPROVAL'];
  const usable = (channel: ChannelMatrix) =>
    channel.available && ACTIONABLE.includes(channel.state);

  const organicPlatforms = matrices.filter((entry) => usable(entry.organic));
  const paidPlatforms = matrices.filter((entry) => usable(entry.paid));

  /*
   * Tabs are the sections that exist, not the sections we wish existed. A
   * channel the platform genuinely does not have gets no tab; the Overview
   * states the provider's own reason instead, which is a finished answer where
   * an empty tab is not.
   */
  const tabs = useMemo(() => {
    const list: Array<{ value: Tab; label: string }> = [
      { value: 'overview', label: t('ws.tab.overview') },
    ];
    if (organicPlatforms.length > 0) list.push({ value: 'organic', label: t('ws.tab.organic') });
    if (paidPlatforms.length > 0) list.push({ value: 'paid', label: t('ws.tab.paid') });
    if (organicPlatforms.length > 0 || paidPlatforms.length > 0) {
      list.push({ value: 'calendar', label: t('ws.tab.calendar') });
      list.push({ value: 'analytics', label: t('ws.tab.analytics') });
      list.push({ value: 'reports', label: t('ws.tab.reports') });
    }
    list.push({ value: 'connection', label: t('ws.tab.connection') });
    return list;
  }, [t, organicPlatforms.length, paidPlatforms.length]);

  /*
   * The tab is a URL parameter rather than component state: "the Meta paid tab"
   * is a place an operator links a colleague to, and state cannot be linked.
   */
  const requested = (search.get('tab') ?? 'overview') as Tab;
  const tab = tabs.some((entry) => entry.value === requested) ? requested : 'overview';
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(search);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearch(params, { replace: true });
  };

  if (capabilities.error) {
    return <ErrorState message={capabilities.error} onRetry={capabilities.refetch} />;
  }
  if (capabilities.loading || !capabilities.data) return <CardSkeleton rows={8} />;
  if (!workspace) return <ErrorState message={t('pw.noPlatform')} onRetry={capabilities.refetch} />;

  const key = workspace.key as WorkspaceKey;
  const label = t(WORKSPACE_LABEL_KEYS[key] ?? 'nav.platforms');
  const counts = pulse.data?.counts;
  const connections = pulse.data?.connections ?? [];

  /**
   * The worst connection state across the workspace: one broken is broken.
   *
   * No integration row at all is DISCONNECTED rather than nothing. Silence in
   * the header reads as "fine" — this workspace showed no badge while Meta
   * beside it showed NOT CONNECTED, which said the two were in different
   * states when they were in the same one.
   */
  const worstConnection: IntegrationStatus = pulse.loading
    ? 'CONNECTING'
    : connections.length === 0
      ? 'DISCONNECTED'
      : (['ERROR', 'TOKEN_EXPIRED', 'REAUTH_REQUIRED', 'EXPIRED', 'DISCONNECTED', 'CONNECTING', 'CONNECTED'] as IntegrationStatus[])
        .find((candidate) => connections.some((row) => row.status === candidate)) ?? 'DISCONNECTED';

  const attentionDetail = counts && counts.needsAttention > 0
    ? [
      counts.attention.failedPosts > 0 ? `${num(counts.attention.failedPosts, lang)} ${t('ws.attention.posts')}` : null,
      counts.attention.failedAds > 0 ? `${num(counts.attention.failedAds, lang)} ${t('ws.attention.ads')}` : null,
      counts.attention.brokenConnections > 0 ? `${num(counts.attention.brokenConnections, lang)} ${t('ws.attention.connections')}` : null,
    ].filter(Boolean).join(' · ')
    : counts ? t('ws.attention.none') : null;

  const platformList = workspace.platforms;
  const projectQuery = clientId ? `?client=${clientId}` : '';

  return (
    <>
      <Link
        to="/app/marketing"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        {/* Logical rotation so the arrow points back in both directions. */}
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
        {t('pw.backToOverview')}
      </Link>

      <PageHeader
        title={label}
        subtitle={workspace.sublabel ?? undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionBadge status={worstConnection} />
            <Link to="/app/integrations">
              <Button variant="ghost" icon={Plug}>{t('ws.manage')}</Button>
            </Link>
          </div>
        }
      >
        {/*
          * §38 — the active project, on every screen. This states the context
          * rather than duplicating the picker: the top bar owns that choice,
          * and a second control for it could disagree with the first.
          */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {platformList.map((platform) => (
            <PlatformChip key={platform} platform={platform} size="sm" />
          ))}
          <span className="text-[13px] text-muted" dir="auto">
            {current ? current.businessName : t('restaurant.all')}
          </span>
        </div>
      </PageHeader>

      <Tabs tabs={tabs} value={tab} onChange={setTab} className="mb-5" />

      {tab === 'overview' ? (
        <div className="space-y-5">
          {/* Today */}
          <section>
            <p className="mb-2 text-[13px] font-medium text-muted">{t('ws.today')}</p>
            {pulse.loading || !counts ? (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <PulseCard label={t('ws.scheduled')} value={counts.scheduled} icon={CalendarDays} />
                <PulseCard label={t('ws.publishing')} value={counts.publishing} icon={Activity} />
                <PulseCard label={t('ws.published')} value={counts.published} icon={ShieldCheck} />
                <PulseCard
                  label={t('ws.needsAttention')}
                  value={counts.needsAttention}
                  icon={TriangleAlert}
                  tone="danger"
                  detail={attentionDetail}
                />
              </div>
            )}
          </section>

          {/* Channels, each stated once with its own reason. */}
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            {matrices.map((matrix) => (
              <Card key={matrix.platform}>
                <CardHeader
                  title={PLATFORM_LABELS[matrix.platform] ?? matrix.label}
                  action={<StateBadge state={matrix.production} />}
                />
                <dl className="space-y-2 text-[13px]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <dt className="text-muted">{t('pw.organic')}</dt>
                    <dd><StateBadge state={matrix.organic.state} /></dd>
                  </div>
                  {!matrix.organic.available ? (
                    <p className="text-[12px] leading-relaxed text-muted" dir="auto">
                      {matrix.organic.capabilities[0]?.detail ?? t('ws.organicUnavailable')}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <dt className="text-muted">{t('pw.paid')}</dt>
                    <dd><StateBadge state={matrix.paid.state} /></dd>
                  </div>
                  {!matrix.paid.available ? (
                    <p className="text-[12px] leading-relaxed text-muted" dir="auto">
                      {matrix.paid.capabilities[0]?.detail ?? t('ws.paidUnavailable')}
                    </p>
                  ) : null}
                </dl>
              </Card>
            ))}
          </div>

          {/* Where the work actually happens. Links, never copies. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {organicPlatforms.length > 0 ? (
              <Link to={`/app/library${projectQuery}`}>
                <Card className="h-full p-3.5 transition-colors hover:border-brand/40">
                  <PenLine className="h-4 w-4 text-muted" aria-hidden />
                  <p className="mt-2 text-[13px] font-medium text-fg">{t('ws.openOrganic')}</p>
                </Card>
              </Link>
            ) : null}
            {paidPlatforms.length > 0 ? (
              <Link to={`/app/marketing/advertising${projectQuery}`}>
                <Card className="h-full p-3.5 transition-colors hover:border-brand/40">
                  <Wallet className="h-4 w-4 text-muted" aria-hidden />
                  <p className="mt-2 text-[13px] font-medium text-fg">{t('ws.openPaid')}</p>
                </Card>
              </Link>
            ) : null}
            <Link to={`/app/analytics${projectQuery}`}>
              <Card className="h-full p-3.5 transition-colors hover:border-brand/40">
                <Activity className="h-4 w-4 text-muted" aria-hidden />
                <p className="mt-2 text-[13px] font-medium text-fg">{t('ws.openAnalytics')}</p>
              </Card>
            </Link>
            <Link to="/app/marketing/advertising/ai">
              <Card className="h-full p-3.5 transition-colors hover:border-brand/40">
                <Sparkles className="h-4 w-4 text-muted" aria-hidden />
                <p className="mt-2 text-[13px] font-medium text-fg">{t('ws.aiRecs')}</p>
              </Card>
            </Link>
          </div>
        </div>
      ) : null}

      {tab === 'organic' ? (
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {organicPlatforms.map((matrix) => (
            <ChannelCard
              key={matrix.platform}
              channel={matrix.organic}
              title={`${PLATFORM_LABELS[matrix.platform] ?? matrix.label} · ${t('pw.organic')}`}
            />
          ))}
          <Card className="lg:col-span-2">
            <CardHeader title={t('ws.compose')} icon={PenLine} />
            <div className="flex flex-wrap gap-2">
              <Link to="/app/social"><Button icon={PenLine}>{t('nav.composer')}</Button></Link>
              <Link to={`/app/library${projectQuery}`}>
                <Button variant="ghost" icon={ExternalLink}>{t('nav.commandCenter')}</Button>
              </Link>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'paid' ? (
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {paidPlatforms.map((matrix) => (
            <ChannelCard
              key={matrix.platform}
              channel={matrix.paid}
              title={`${PLATFORM_LABELS[matrix.platform] ?? matrix.label} · ${t('pw.paid')}`}
            />
          ))}
          <Card className="lg:col-span-2">
            <CardHeader title={t('ws.openPaid')} icon={Wallet} />
            <div className="flex flex-wrap gap-2">
              <Link to={`/app/marketing/advertising${projectQuery}`}>
                <Button icon={Wallet}>{t('nav.advertising')}</Button>
              </Link>
              <Link to="/app/marketing/advertising/creatives">
                <Button variant="ghost" icon={ExternalLink}>{t('nav.adCreatives')}</Button>
              </Link>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'calendar' ? (
        /* The same component the unified calendar uses, filtered. §28. */
        <MarketingCalendar platforms={platformList} clientId={clientId} initialView="month" />
      ) : null}

      {tab === 'analytics' ? (
        <Card>
          <CardHeader title={t('ws.openAnalytics')} icon={Activity} subtitle={t('dash.combinedNote')} />
          <div className="flex flex-wrap gap-2">
            <Link to={`/app/analytics${projectQuery}`}><Button icon={Activity}>{t('nav.analytics')}</Button></Link>
            <Link to="/app/social/analytics">
              <Button variant="ghost">{t('nav.socialAnalytics')}</Button>
            </Link>
            <Link to="/app/creative-performance">
              <Button variant="ghost">{t('nav.creativePerformance')}</Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {tab === 'reports' ? (
        <Card>
          {/* §36 — this opens the Report Builder rather than repeating it. */}
          <CardHeader title={t('ws.openReports')} icon={FileText} subtitle={t('ws.reportsBody')} />
          <div className="flex flex-wrap gap-2">
            <Link to="/app/reports/builders"><Button icon={FileText}>{t('nav.reportBuilder')}</Button></Link>
            <Link to="/app/reports"><Button variant="ghost">{t('nav.savedReports')}</Button></Link>
          </div>
        </Card>
      ) : null}

      {tab === 'connection' ? (
        <div className="space-y-4">
          {pulse.loading ? (
            <CardSkeleton rows={4} />
          ) : connections.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
              {connections.map((health) => (
                <ConnectionCard
                  key={`${health.clientId}-${health.platform}`}
                  health={health}
                  // Only when the view spans more than one project. With one
                  // selected the name is already in the page header.
                  showProject={!clientId}
                />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={Plug}
                title={t('ws.conn.DISCONNECTED')}
                body={clientId ? t('ws.notConnectedBody') : t('common.pickProject')}
                action={<Link to="/app/integrations"><Button icon={Plug}>{t('ws.manage')}</Button></Link>}
              />
            </Card>
          )}

          {/* The deployment's own capability, beside the project's connection.
              They answer different questions and fail for different reasons. */}
          <p className="text-[13px] font-medium text-muted">{t('ws.capabilities')}</p>
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            {matrices.map((matrix) => (
              <ChannelCard
                key={`${matrix.platform}-organic`}
                channel={matrix.organic}
                title={`${PLATFORM_LABELS[matrix.platform] ?? matrix.label} · ${t('pw.organic')}`}
              />
            ))}
            {matrices.map((matrix) => (
              <ChannelCard
                key={`${matrix.platform}-paid`}
                channel={matrix.paid}
                title={`${PLATFORM_LABELS[matrix.platform] ?? matrix.label} · ${t('pw.paid')}`}
              />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** `/app/marketing/calendar` — the unified grid, every platform. §27. */
export function MarketingCalendarPage() {
  const { t } = useI18n();
  const { currentId: clientId } = useRestaurant();

  return (
    <>
      <PageHeader title={t('cal.title')} subtitle={t('cal.subtitle')} />
      <MarketingCalendar clientId={clientId} initialView="month" />
    </>
  );
}
