/**
 * The Paid Advertising Command Center.
 *
 * Four screens over one service: the dashboard, a campaign's detail, the ads
 * creative library and the paid calendar. They share their filters, their
 * status vocabulary and — the part that matters — their refusal to print a
 * number nobody measured.
 *
 * `MetricValue` is the smallest and most important thing in this file. Every
 * figure on every one of these screens goes through it, and it renders a value
 * only when the server said the value was measured. A campaign whose insights
 * have never been fetched shows "Not fetched", not £0.00 — because the columns
 * behind it default to zero, and this is the last place that difference can be
 * lost before it reaches somebody deciding whether their advertising works.
 *
 * This phase is view, monitor and preview. Nothing here writes: drafting,
 * approving and publishing stay on `/app/meta-campaigns`, which already has the
 * approval gate around the calls that spend money.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CalendarDays, Download, ExternalLink, Eye,
  LayoutGrid, List, Wallet,
} from 'lucide-react';

import { qs } from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { date as fmtDate, money, num, pct, ratio, shortDate } from '../lib/format';
import { useRestaurant } from '../lib/restaurant';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Input,
  PageHeader, Select, Skeleton, TableWrap, Td, Th, type BadgeTone,
} from '../components/ui';
import { PlatformChip } from '../components/domain';
import { AdPreview, AdPreviewDrawer, type AdPreviewData } from '../components/ad-preview';

// --------------------------------------------------------------- shapes

type MetricState = 'ZERO' | 'UNAVAILABLE' | 'NOT_FETCHED' | 'PROVIDER_ERROR';

interface QualifiedMetric {
  metric: string;
  value: number | null;
  state: MetricState;
  note: string | null;
}

type AdStatus =
  | 'DRAFT' | 'PENDING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED'
  | 'FAILED' | 'REJECTED' | 'NEEDS_ATTENTION' | 'UNKNOWN';

interface CampaignRow {
  id: string;
  name: string;
  platform: string;
  platformLabel: string;
  objective: string;
  status: AdStatus;
  statusDetail: string;
  providerStatus: string | null;
  clientId: string;
  clientName: string;
  countries: string[];
  currency: string;
  startDate: string;
  endDate: string;
  publishedAt: string | null;
  updatedAt: string;
  managerUrl: string | null;
  error: { message: string; status: number | null } | null;
  metrics: QualifiedMetric[];
}

interface PlatformAvailability {
  platform: string;
  label: string;
  state: string;
  detail: string;
  requiredEnv: string[];
  approval: string | null;
  selectable: boolean;
}

interface Overview {
  platforms: PlatformAvailability[];
  counts: Record<string, number>;
  kpis: QualifiedMetric[];
  accounts: Array<{
    platform: string; label: string; clientId: string; clientName: string;
    connection: string; accountName: string | null;
    accounts: Array<{ name: string; externalId: string }>;
    lastError: string | null; lastSyncAt: string | null;
  }>;
  needsAttention: CampaignRow[];
  recent: CampaignRow[];
}

// ------------------------------------------------------------- metrics

/** Currency and ratio metrics format differently; the rest are counts. */
const MONEY_METRICS = new Set(['spend', 'budget', 'cpc', 'cpa', 'cpm']);
const PERCENT_METRICS = new Set(['ctr']);
const RATIO_METRICS = new Set(['roas']);

/**
 * One figure, rendered only if it was measured.
 *
 * The four states are not decoration. `UNAVAILABLE` means the provider has no
 * such metric and never will; `NOT_FETCHED` means nobody has asked yet;
 * `PROVIDER_ERROR` means we asked and were refused. Each sends the operator
 * somewhere different, and none of them is zero.
 */
function MetricValue({
  metric, currency = 'USD', className,
}: { metric: QualifiedMetric; currency?: string; className?: string }) {
  const { t, lang } = useI18n();

  if (metric.state !== 'ZERO' || metric.value === null) {
    return (
      <span
        className={['text-muted', className].filter(Boolean).join(' ')}
        title={metric.note ?? t(`report.state.${metric.state}` as TranslationKey)}
      >
        {t(`report.short.${metric.state}` as TranslationKey)}
      </span>
    );
  }

  const value = metric.value;
  const text = MONEY_METRICS.has(metric.metric)
    ? money(value, lang, true, currency)
    : PERCENT_METRICS.has(metric.metric)
      ? pct(value)
      : RATIO_METRICS.has(metric.metric)
        ? ratio(value)
        : num(value, lang, true);

  return <span className={className} dir="auto">{text}</span>;
}

const STATUS_TONES: Record<AdStatus, BadgeTone> = {
  ACTIVE: 'ok',
  PAUSED: 'neutral',
  DRAFT: 'neutral',
  COMPLETED: 'neutral',
  PENDING: 'brand',
  UNKNOWN: 'neutral',
  FAILED: 'danger',
  REJECTED: 'danger',
  NEEDS_ATTENTION: 'warn',
};

function StatusBadge({ status, detail }: { status: AdStatus; detail?: string }) {
  const { t } = useI18n();
  return (
    <Badge tone={STATUS_TONES[status]} className="whitespace-normal text-start leading-snug">
      <span title={detail}>{t(`adv.s.${status}` as TranslationKey)}</span>
    </Badge>
  );
}

/**
 * A provider's refusal, in full.
 *
 * Never "something went wrong": the message the provider gave is the only thing
 * that tells an operator whether to edit a budget, swap a creative or
 * reconnect an account.
 */
function ProviderError({ error }: { error: { message: string; status: number | null } }) {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-danger">
          {t('adv.e.providerError')}
          {error.status !== null ? <span className="ms-1 font-normal opacity-80">({error.status})</span> : null}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted" dir="auto">{error.message}</p>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- filters

interface Filters {
  platform: string;
  status: string;
  search: string;
}

/**
 * Platform options come from the capability matrix, never a hardcoded list.
 * A platform with no advertising integration is not offered as a filter that
 * would return nothing — it is reported separately, with its reason.
 */
function useFilters() {
  const [params, setParams] = useSearchParams();

  const filters: Filters = {
    platform: params.get('platform') ?? '',
    status: params.get('status') ?? '',
    search: params.get('search') ?? '',
  };

  const set = useCallback((key: keyof Filters, value: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);

  return { filters, set };
}

function FilterBar({
  filters, set, platforms, children,
}: {
  filters: Filters;
  set: (key: keyof Filters, value: string) => void;
  platforms: PlatformAvailability[];
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const selectable = platforms.filter((platform) => platform.selectable);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <div className="min-w-[160px] flex-1 sm:max-w-xs">
        <Input
          value={filters.search}
          onChange={(event) => set('search', event.target.value)}
          placeholder={t('adv.f.search')}
          aria-label={t('adv.f.search')}
        />
      </div>

      <Select
        value={filters.platform}
        onChange={(event) => set('platform', event.target.value)}
        aria-label={t('adv.f.platform')}
        className="w-auto"
      >
        <option value="">{t('adv.f.platform')}: {t('adv.f.all')}</option>
        {selectable.map((platform) => (
          <option key={platform.platform} value={platform.platform}>{platform.label}</option>
        ))}
      </Select>

      <Select
        value={filters.status}
        onChange={(event) => set('status', event.target.value)}
        aria-label={t('adv.f.status')}
        className="w-auto"
      >
        <option value="">{t('adv.f.status')}: {t('adv.f.all')}</option>
        {(['ACTIVE', 'PAUSED', 'PENDING', 'DRAFT', 'COMPLETED', 'FAILED', 'REJECTED', 'NEEDS_ATTENTION', 'UNKNOWN'] as AdStatus[])
          .map((status) => (
            <option key={status} value={status}>{t(`adv.s.${status}` as TranslationKey)}</option>
          ))}
      </Select>

      {children}
    </div>
  );
}

/** Platforms the matrix says we cannot advertise on, stated rather than hidden. */
function UnavailablePlatforms({ platforms }: { platforms: PlatformAvailability[] }) {
  const { t } = useI18n();
  const blocked = platforms.filter((platform) => !platform.selectable || platform.state !== 'SUPPORTED');
  if (blocked.length === 0) return null;

  return (
    <Card className="mt-6">
      <CardHeader title={t('pw.overviewTitle')} />
      <ul className="-mt-1">
        {blocked.map((platform) => (
          <li
            key={platform.platform}
            className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <PlatformChip platform={platform.platform} size="sm" />
              </div>
              <p className="text-[13px] leading-relaxed text-muted" dir="auto">{platform.detail}</p>
              {platform.requiredEnv.length > 0 ? (
                <p className="mt-1.5 text-[12px] text-muted">
                  <span className="font-medium text-fg">{t('pw.requiredEnv')}: </span>
                  <code className="rounded bg-elevated px-1 py-0.5 text-[11px]" dir="ltr">
                    {platform.requiredEnv.join(', ')}
                  </code>
                </p>
              ) : null}
              {platform.approval ? (
                <p className="mt-1.5 text-[12px] text-muted" dir="auto">
                  <span className="font-medium text-fg">{t('pw.approvalNeeded')}: </span>
                  {platform.approval}
                </p>
              ) : null}
            </div>
            <div className="shrink-0">
              <Badge
                tone={platform.state === 'NOT_CONFIGURED' ? 'warn' : 'neutral'}
                className="whitespace-normal text-start leading-snug"
              >
                {t(`cap.${platform.state}` as TranslationKey)}
              </Badge>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------ dashboard

export function AdvertisingPage() {
  const { t, lang } = useI18n();
  const { currentId: restaurantId } = useRestaurant();
  const { filters, set } = useFilters();
  const search = useDebounced(filters.search, 300);

  const query = qs({
    clientId: restaurantId || undefined,
    platform: filters.platform || undefined,
    status: filters.status || undefined,
    search: search || undefined,
  });

  const overview = useQuery<Overview>(`/advertising/overview${query}`, [query]);
  const campaigns = useQuery<{ items: CampaignRow[]; total: number }>(
    `/advertising/campaigns${query}`, [query],
  );

  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  const previewQuery = useQuery<{ preview: AdPreviewData }>(
    preview ? `/advertising/campaigns/${preview.id}/preview` : null, [preview?.id],
  );

  if (overview.error) return <ErrorState message={overview.error} onRetry={overview.refetch} />;

  const currency = campaigns.data?.items[0]?.currency ?? 'USD';

  return (
    <>
      <PageHeader
        title={t('adv.title')}
        subtitle={t('adv.subtitle')}
        action={
          <div className="flex flex-wrap gap-2">
            <Link to="/app/marketing/advertising/creatives">
              <Button variant="secondary"><LayoutGrid className="h-4 w-4" />{t('nav.adCreatives')}</Button>
            </Link>
            <Link to="/app/marketing/advertising/calendar">
              <Button variant="secondary"><CalendarDays className="h-4 w-4" />{t('nav.adCalendar')}</Button>
            </Link>
          </div>
        }
      />

      {/* KPI row. Every tile is a QualifiedMetric, so an unmeasured figure
          says so rather than showing zero. */}
      {overview.loading || !overview.data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {overview.data.kpis.slice(0, 10).map((metric) => (
            <Card key={metric.metric} className="p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {t(`adv.m.${metric.metric}` as TranslationKey)}
              </p>
              <p className="mt-1 text-lg font-semibold text-fg">
                <MetricValue metric={metric} currency={currency} />
              </p>
            </Card>
          ))}
        </div>
      )}

      {/* Status counts, as the operation's shape at a glance. */}
      {overview.data ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {(['ACTIVE', 'PAUSED', 'PENDING', 'DRAFT', 'COMPLETED', 'FAILED', 'REJECTED', 'UNKNOWN'] as AdStatus[])
            .filter((status) => (overview.data!.counts[status] ?? 0) > 0)
            .map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => set('status', filters.status === status ? '' : status)}
                className={[
                  'rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                  filters.status === status ? 'border-brand/40 bg-brand/12 text-brand' : 'border-line text-muted hover:text-fg',
                ].join(' ')}
              >
                {t(`adv.s.${status}` as TranslationKey)} · {overview.data!.counts[status]}
              </button>
            ))}
        </div>
      ) : null}

      {/* Monitoring: what needs a person, before the full table. */}
      {overview.data && overview.data.needsAttention.length > 0 ? (
        <Card className="mt-6 border-warn/25">
          <CardHeader title={t('adv.needsAttention')} action={<Badge tone="warn">{overview.data.counts.needsAttention}</Badge>} />
          <ul className="space-y-3">
            {overview.data.needsAttention.map((row) => (
              <li key={row.id} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <PlatformChip platform={row.platform} size="sm" />
                  <Link
                    to={`/app/marketing/advertising/campaigns/${row.id}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium text-fg hover:text-brand"
                    dir="auto"
                  >
                    {row.name}
                  </Link>
                  <StatusBadge status={row.status} detail={row.statusDetail} />
                </div>
                {row.error ? <ProviderError error={row.error} /> : (
                  <p className="text-[12px] text-muted" dir="auto">{row.statusDetail}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-6">
        <FilterBar filters={filters} set={set} platforms={overview.data?.platforms ?? []} />

        {campaigns.error ? (
          <ErrorState message={campaigns.error} onRetry={campaigns.refetch} />
        ) : campaigns.loading || !campaigns.data ? (
          <CardSkeleton rows={5} />
        ) : campaigns.data.items.length === 0 ? (
          <EmptyState icon={Wallet} title={t('adv.noCampaigns')} body={t('adv.subtitle')} />
        ) : (
          <>
            {/* Desktop and tablet: a table. Mobile: cards, below. */}
            <div className="hidden md:block">
              <TableWrap>
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th>{t('adv.c.campaign')}</Th>
                      <Th>{t('adv.c.status')}</Th>
                      <Th align="end">{t('adv.m.budget')}</Th>
                      <Th align="end">{t('adv.m.spend')}</Th>
                      <Th align="end">{t('adv.m.impressions')}</Th>
                      <Th align="end" className="hidden lg:table-cell">{t('adv.m.clicks')}</Th>
                      <Th align="end" className="hidden lg:table-cell">{t('adv.m.ctr')}</Th>
                      <Th align="end" className="hidden xl:table-cell">{t('adv.m.conversions')}</Th>
                      <Th align="end" className="hidden xl:table-cell">{t('adv.m.cpa')}</Th>
                      <Th className="hidden lg:table-cell">{t('adv.c.end')}</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.data.items.map((row) => {
                      const find = (name: string) => row.metrics.find((metric) => metric.metric === name)!;
                      return (
                        <tr key={row.id}>
                          <Td>
                            <div className="flex items-center gap-2">
                              <PlatformChip platform={row.platform} size="sm" />
                              <Link
                                to={`/app/marketing/advertising/campaigns/${row.id}`}
                                className="min-w-0 truncate font-medium text-fg hover:text-brand"
                                dir="auto"
                              >
                                {row.name}
                              </Link>
                            </div>
                          </Td>
                          <Td><StatusBadge status={row.status} detail={row.statusDetail} /></Td>
                          <Td align="end"><MetricValue metric={find('budget')} currency={row.currency} /></Td>
                          <Td align="end"><MetricValue metric={find('spend')} currency={row.currency} /></Td>
                          <Td align="end"><MetricValue metric={find('impressions')} /></Td>
                          <Td align="end" className="hidden lg:table-cell"><MetricValue metric={find('clicks')} /></Td>
                          <Td align="end" className="hidden lg:table-cell"><MetricValue metric={find('ctr')} /></Td>
                          <Td align="end" className="hidden xl:table-cell"><MetricValue metric={find('conversions')} /></Td>
                          <Td align="end" className="hidden xl:table-cell"><MetricValue metric={find('cpa')} currency={row.currency} /></Td>
                          <Td className="hidden lg:table-cell">{shortDate(row.endDate, lang)}</Td>
                          <Td align="end">
                            <button
                              type="button"
                              onClick={() => setPreview({ id: row.id, name: row.name })}
                              className="text-muted hover:text-brand"
                              aria-label={t('adv.p.preview')}
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </div>

            <div className="space-y-3 md:hidden">
              {campaigns.data.items.map((row) => {
                const find = (name: string) => row.metrics.find((metric) => metric.metric === name)!;
                return (
                  <Card key={row.id}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <PlatformChip platform={row.platform} size="sm" />
                      <StatusBadge status={row.status} detail={row.statusDetail} />
                    </div>
                    <Link
                      to={`/app/marketing/advertising/campaigns/${row.id}`}
                      className="mt-2 block truncate font-medium text-fg"
                      dir="auto"
                    >
                      {row.name}
                    </Link>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
                      {['spend', 'impressions', 'clicks', 'ctr'].map((name) => (
                        <div key={name}>
                          <dt className="text-[11px] uppercase tracking-wide text-muted">
                            {t(`adv.m.${name}` as TranslationKey)}
                          </dt>
                          <dd className="text-fg"><MetricValue metric={find(name)} currency={row.currency} /></dd>
                        </div>
                      ))}
                    </dl>
                    <Button
                      variant="secondary"
                      className="mt-3 w-full"
                      onClick={() => setPreview({ id: row.id, name: row.name })}
                    >
                      <Eye className="h-4 w-4" />{t('adv.p.preview')}
                    </Button>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Account health, from the existing connection records. Never a token. */}
      {overview.data && overview.data.accounts.length > 0 ? (
        <Card className="mt-6">
          <CardHeader title={t('adv.accounts')} />
          <ul className="-mt-1">
            {overview.data.accounts.map((account) => (
              <li
                key={`${account.platform}-${account.clientId}`}
                className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <PlatformChip platform={account.platform} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-fg" dir="auto">
                      {account.accounts.map((entry) => entry.name).join(', ') || account.accountName || account.clientName}
                    </p>
                    {account.lastError ? (
                      <p className="truncate text-[12px] text-danger" dir="auto">{account.lastError}</p>
                    ) : null}
                  </div>
                </div>
                <Badge tone={account.connection === 'CONNECTED' ? 'ok' : account.connection === 'ERROR' ? 'danger' : 'warn'}>
                  {account.connection}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <UnavailablePlatforms platforms={overview.data?.platforms ?? []} />

      <AdPreviewDrawer
        open={preview !== null}
        onClose={() => setPreview(null)}
        data={previewQuery.data?.preview ?? null}
        loading={previewQuery.loading}
        title={preview?.name ?? ''}
      />
    </>
  );
}

// --------------------------------------------------------------- detail

interface CampaignDetail extends CampaignRow {
  provider: {
    accountId: string | null; campaignId: string | null;
    adSetId: string | null; adId: string | null; creativeId: string | null;
  };
  copy: { headline: string; message: string; callToAction: string | null; linkUrl: string };
  media: {
    kind: 'IMAGE' | 'VIDEO' | null; url: string | null;
    width: number | null; height: number | null;
    durationSeconds: number | null; mimeType: string | null; sizeBytes: number | null;
  };
  activity: Array<{ step: string; ok: boolean; detail: string; at: string }>;
  createdAt: string;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line py-2.5 last:border-b-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg" dir="auto">{children}</dd>
    </div>
  );
}

export function CampaignDetailPage() {
  const { t, lang } = useI18n();
  const params = useParams<{ id: string }>();
  const { data, loading, error, refetch } = useQuery<{ campaign: CampaignDetail }>(
    `/advertising/campaigns/${params.id}`, [params.id],
  );
  const previewQuery = useQuery<{ preview: AdPreviewData }>(
    `/advertising/campaigns/${params.id}/preview`, [params.id],
  );

  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (loading || !data) return <CardSkeleton rows={8} />;

  const campaign = data.campaign;
  const find = (name: string) => campaign.metrics.find((metric) => metric.metric === name)!;

  return (
    <>
      <Link
        to="/app/marketing/advertising"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
        {t('adv.backToAdvertising')}
      </Link>

      <PageHeader
        title={campaign.name}
        subtitle={campaign.clientName}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={campaign.status} detail={campaign.statusDetail} />
            {campaign.managerUrl ? (
              <a href={campaign.managerUrl} target="_blank" rel="noreferrer noopener">
                <Button variant="secondary"><ExternalLink className="h-4 w-4" />{t('adv.openInManager')}</Button>
              </a>
            ) : null}
          </div>
        }
      />

      {campaign.error ? <div className="mb-4"><ProviderError error={campaign.error} /></div> : null}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div className="space-y-4">
          <Card>
            <CardHeader title={t('adv.d.overview')} />
            <dl className="-mt-1">
              <Detail label={t('adv.f.platform')}><PlatformChip platform={campaign.platform} size="sm" /></Detail>
              <Detail label={t('adv.c.objective')}>{campaign.objective}</Detail>
              <Detail label={t('adv.c.status')}>{campaign.statusDetail}</Detail>
              <Detail label={t('adv.d.schedule')}>
                {fmtDate(campaign.startDate, lang)} → {fmtDate(campaign.endDate, lang)}
              </Detail>
              <Detail label={t('adv.m.budget')}>
                {/* No middot: in RTL it reads as a stray digit beside the amount. */}
                <MetricValue metric={find('budget')} currency={campaign.currency} />{' '}
                <span className="text-muted">{t('adv.cal.perDay')}</span>
              </Detail>
              {campaign.countries.length > 0 ? (
                <Detail label={t('adv.c.location')}>{campaign.countries.join(', ')}</Detail>
              ) : null}
            </dl>
          </Card>

          <Card>
            <CardHeader title={t('adv.d.performance')} />
            <dl className="grid grid-cols-2 gap-x-4">
              {['spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'conversions', 'cpa', 'roas'].map((name) => (
                <Detail key={name} label={t(`adv.m.${name}` as TranslationKey)}>
                  <MetricValue metric={find(name)} currency={campaign.currency} />
                </Detail>
              ))}
            </dl>
          </Card>

          <Card>
            <CardHeader title={t('adv.d.targeting')} />
            <dl className="-mt-1">
              <Detail label={t('adv.c.location')}>
                {campaign.countries.length > 0 ? campaign.countries.join(', ') : '—'}
              </Detail>
            </dl>
            {/* Honest boundary: what was requested, not what delivered. */}
            <p className="mt-2 text-[12px] leading-relaxed text-muted" dir="auto">
              {t('adv.d.targetingNote')}
            </p>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title={t('adv.p.preview')} />
            {previewQuery.loading ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : previewQuery.data ? (
              <AdPreview data={previewQuery.data.preview} />
            ) : null}
          </Card>

          <Card>
            <CardHeader title={t('adv.d.creative')} />
            <dl className="-mt-1">
              <Detail label={t('adv.d.headline')}>{campaign.copy.headline}</Detail>
              <Detail label={t('adv.d.primaryText')}>{campaign.copy.message}</Detail>
              {campaign.copy.callToAction ? (
                <Detail label={t('adv.d.cta')}>{campaign.copy.callToAction}</Detail>
              ) : null}
              <Detail label={t('adv.d.destination')}>
                <span dir="ltr" className="break-all">{campaign.copy.linkUrl}</span>
              </Detail>
            </dl>
          </Card>

          <Card>
            <CardHeader title={t('adv.d.activity')} />
            {campaign.activity.length === 0 ? (
              <p className="text-[13px] text-muted">{t('adv.d.noActivity')}</p>
            ) : (
              <ol className="-mt-1">
                {campaign.activity.map((entry, index) => (
                  <li key={`${entry.step}-${index}`} className="flex gap-3 border-b border-line py-2.5 last:border-b-0">
                    <span
                      className={[
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        entry.ok ? 'bg-ok' : 'bg-danger',
                      ].join(' ')}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-fg">{entry.step}</p>
                      <p className="text-[12px] leading-relaxed text-muted" dir="auto">{entry.detail}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted">{shortDate(entry.at, lang)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {/* Provider ids, so an operator can find this in the real manager. */}
          {campaign.provider.campaignId || campaign.provider.adId ? (
            <Card>
              <CardHeader title={t('adv.d.providerIds')} />
              <dl className="-mt-1">
                {Object.entries(campaign.provider)
                  .filter(([, value]) => value)
                  .map(([key, value]) => (
                    <Detail key={key} label={key}>
                      <code className="break-all text-[12px]" dir="ltr">{value}</code>
                    </Detail>
                  ))}
              </dl>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

// -------------------------------------------------------------- library

interface CreativeCard {
  publicationId: string;
  campaignName: string;
  platform: string;
  platformLabel: string;
  clientName: string;
  status: AdStatus;
  kind: 'IMAGE' | 'VIDEO' | null;
  url: string | null;
  downloadUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  headline: string;
  primaryText: string;
  callToAction: string | null;
  destination: string;
  createdAt: string;
  metrics: QualifiedMetric[];
  error: { message: string; status: number | null } | null;
}

export function AdCreativesPage() {
  const { t, lang } = useI18n();
  const { currentId: restaurantId } = useRestaurant();
  const { filters, set } = useFilters();
  const search = useDebounced(filters.search, 300);
  const [view, setView] = useState<'GRID' | 'LIST'>('GRID');

  const query = qs({
    clientId: restaurantId || undefined,
    platform: filters.platform || undefined,
    search: search || undefined,
  });

  const platforms = useQuery<{ platforms: PlatformAvailability[] }>('/advertising/platforms');
  const library = useQuery<{ items: CreativeCard[]; total: number }>(
    `/advertising/creatives${query}`, [query],
  );

  if (library.error) return <ErrorState message={library.error} onRetry={library.refetch} />;

  return (
    <>
      <Link
        to="/app/marketing/advertising"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
        {t('adv.backToAdvertising')}
      </Link>

      <PageHeader title={t('nav.adCreatives')} subtitle={t('adv.subtitle')} />

      <FilterBar filters={filters} set={set} platforms={platforms.data?.platforms ?? []}>
        <div className="flex gap-1">
          <Button variant={view === 'GRID' ? 'primary' : 'secondary'} onClick={() => setView('GRID')} aria-label={t('adv.l.grid')}>
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button variant={view === 'LIST' ? 'primary' : 'secondary'} onClick={() => setView('LIST')} aria-label={t('adv.l.list')}>
            <List className="h-4 w-4" />
          </Button>
        </div>
      </FilterBar>

      {library.loading || !library.data ? (
        <CardSkeleton rows={4} />
      ) : library.data.items.length === 0 ? (
        <EmptyState icon={LayoutGrid} title={t('adv.noCreatives')} body={t('adv.subtitle')} />
      ) : (
        <div className={view === 'GRID' ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-3'}>
          {library.data.items.map((card) => {
            const find = (name: string) => card.metrics.find((metric) => metric.metric === name)!;
            return (
              <Card key={card.publicationId} className={view === 'LIST' ? 'flex flex-col gap-3 sm:flex-row' : ''}>
                <div className={view === 'LIST' ? 'w-full shrink-0 sm:w-40' : ''}>
                  {card.url ? (
                    card.kind === 'VIDEO' ? (
                      <video src={card.url} className="aspect-square w-full rounded-lg object-cover" preload="metadata" />
                    ) : (
                      <img src={card.url} alt="" className="aspect-square w-full rounded-lg object-cover" />
                    )
                  ) : (
                    <div className="aspect-square w-full rounded-lg bg-elevated" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 sm:mt-0">
                    <PlatformChip platform={card.platform} size="sm" />
                    <StatusBadge status={card.status} />
                  </div>

                  <Link
                    to={`/app/marketing/advertising/campaigns/${card.publicationId}`}
                    className="mt-2 block truncate text-sm font-medium text-fg hover:text-brand"
                    dir="auto"
                  >
                    {card.campaignName}
                  </Link>
                  <p className="truncate text-[12px] text-muted" dir="auto">{card.headline}</p>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
                    {['spend', 'impressions', 'ctr', 'conversions'].map((name) => (
                      <div key={name}>
                        <dt className="text-[10px] uppercase tracking-wide text-muted">
                          {t(`adv.m.${name}` as TranslationKey)}
                        </dt>
                        <dd className="text-fg"><MetricValue metric={find(name)} /></dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Link to={`/app/marketing/advertising/campaigns/${card.publicationId}`}>
                      <Button variant="secondary"><Eye className="h-4 w-4" />{t('adv.viewCampaign')}</Button>
                    </Link>
                    {/*
                      * Download only when this deployment holds the bytes. A
                      * provider-rendered asset is not downloadable through the
                      * API, and a button that 404s is worse than none.
                      */}
                    {card.downloadUrl ? (
                      <a href={card.downloadUrl} download>
                        <Button variant="ghost"><Download className="h-4 w-4" />{t('adv.l.download')}</Button>
                      </a>
                    ) : (
                      <span className="text-[11px] text-muted" dir="auto">{t('adv.l.downloadUnavailable')}</span>
                    )}
                  </div>

                  <p className="mt-2 text-[11px] text-muted">{shortDate(card.createdAt, lang)}</p>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------- calendar

interface PaidCalendarItem {
  id: string;
  name: string;
  platform: string;
  clientName: string;
  objective: string;
  status: AdStatus;
  statusDetail: string;
  dailyBudget: number;
  currency: string;
  startDate: string;
  endDate: string;
  days: string[];
}

function monthWindow(anchor: Date): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)),
    to: new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)),
  };
}

function weekWindow(anchor: Date): { from: Date; to: Date } {
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { from: start, to: end };
}

export function PaidCalendarPage() {
  const { t, lang } = useI18n();
  const { currentId: restaurantId } = useRestaurant();
  const { filters, set } = useFilters();
  const [view, setView] = useState<'WEEK' | 'MONTH'>('MONTH');
  const [anchor] = useState(() => new Date());

  const window = view === 'MONTH' ? monthWindow(anchor) : weekWindow(anchor);
  const windowFrom = window.from.getTime();
  const windowTo = window.to.getTime();
  const query = qs({
    clientId: restaurantId || undefined,
    platform: filters.platform || undefined,
    status: filters.status || undefined,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  });

  const platforms = useQuery<{ platforms: PlatformAvailability[] }>('/advertising/platforms');
  const calendar = useQuery<{ from: string; to: string; items: PaidCalendarItem[] }>(
    `/advertising/calendar${query}`, [query],
  );

  const days = useMemo(() => {
    const list: string[] = [];
    const cursor = new Date(windowFrom);
    while (cursor.getTime() <= windowTo) {
      list.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return list;
  }, [windowFrom, windowTo]);

  if (calendar.error) return <ErrorState message={calendar.error} onRetry={calendar.refetch} />;

  const byDay = new Map<string, PaidCalendarItem[]>();
  for (const item of calendar.data?.items ?? []) {
    for (const day of item.days) {
      const list = byDay.get(day) ?? [];
      list.push(item);
      byDay.set(day, list);
    }
  }

  return (
    <>
      <Link
        to="/app/marketing/advertising"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
        {t('adv.backToAdvertising')}
      </Link>

      <PageHeader
        title={t('adv.cal.title')}
        subtitle={t('adv.cal.subtitle')}
        action={
          <div className="flex gap-1">
            <Button variant={view === 'WEEK' ? 'primary' : 'secondary'} onClick={() => setView('WEEK')}>
              {t('adv.cal.week')}
            </Button>
            <Button variant={view === 'MONTH' ? 'primary' : 'secondary'} onClick={() => setView('MONTH')}>
              {t('adv.cal.month')}
            </Button>
          </div>
        }
      />

      <FilterBar filters={filters} set={set} platforms={platforms.data?.platforms ?? []} />

      {calendar.loading || !calendar.data ? (
        <CardSkeleton rows={6} />
      ) : calendar.data.items.length === 0 ? (
        <EmptyState icon={CalendarDays} title={t('adv.cal.noFlights')} body={t('adv.cal.subtitle')} />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {days.map((day) => {
            const items = byDay.get(day) ?? [];
            return (
              <div key={day} className="min-h-[96px] overflow-hidden rounded-lg border border-line bg-surface p-2">
                <p className="mb-1.5 text-[11px] font-medium text-muted">{shortDate(day, lang)}</p>
                <ul className="space-y-1">
                  {items.map((item) => (
                    <li key={`${day}-${item.id}`}>
                      <Link
                        to={`/app/marketing/advertising/campaigns/${item.id}`}
                        className="block rounded border border-line bg-elevated px-1.5 py-1 hover:border-brand/40"
                      >
                        {/* Every item is labelled paid — this grid never mixes
                            in organic posts. */}
                        {/* Wraps rather than pushing out: PlatformChip is
                            whitespace-nowrap and a calendar cell is narrow. */}
                        <span className="mb-0.5 flex flex-wrap items-center gap-1">
                          <Badge tone="brand" className="px-1 py-0 text-[9px]">{t('adv.paid')}</Badge>
                          <PlatformChip platform={item.platform} size="sm" />
                        </span>
                        <span className="block truncate text-[11px] font-medium text-fg" dir="auto">{item.name}</span>
                        <span className="block truncate text-[10px] text-muted">
                          {money(item.dailyBudget, lang, true, item.currency)} {t('adv.cal.perDay')}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
