/**
 * The Marketing Command Center — the overview, and one workspace per platform.
 *
 * Both screens render entirely from `/api/marketing/capabilities`. Nothing here
 * decides what a platform can do; it asks. That is the point of the phase: the
 * moment a page holds its own opinion about whether TikTok can publish, it
 * becomes a second source of truth that drifts the first time an integration
 * ships or a credential is set.
 *
 * The design rule underneath every row: an operator must never see a control
 * for something that cannot happen, and must never see an unexplained absence
 * either. So a capability that is missing says which of the four reasons
 * applies, and — where there is one — the exact next action, whether that is a
 * variable to set or an approval to request. "Not available through connected
 * API" is a finished answer; a greyed-out button is not.
 */

import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CircleSlash, KeyRound, ShieldCheck, Wrench } from 'lucide-react';

import { useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { PLATFORM_LABELS } from '../lib/format';
import type { Platform } from '../lib/api';
import {
  Badge, Card, CardHeader, CardSkeleton, ErrorState, PageHeader, type BadgeTone,
} from '../components/ui';
import { PlatformChip } from '../components/domain';

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

function ChannelCard({ channel }: { channel: ChannelMatrix }) {
  const { t } = useI18n();
  const title = channel.channel === 'ORGANIC' ? t('pw.organic') : t('pw.paid');

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

/** `/app/marketing` — every platform, with what it can do here. */
export function MarketingOverviewPage() {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useQuery<CapabilitiesResponse>('/marketing/capabilities');

  if (error) return <ErrorState message={error} onRetry={refetch} />;

  return (
    <>
      <PageHeader title={t('pw.overviewTitle')} subtitle={t('pw.overviewSubtitle')} />

      {loading || !data ? (
        <CardSkeleton rows={6} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.platforms.map((matrix) => (
              <Link
                key={matrix.platform}
                to={`/app/marketing/${matrix.platform.toLowerCase()}`}
                className="rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              >
                <Card className="h-full transition-colors hover:border-brand/40">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <PlatformChip platform={matrix.platform} />
                    <StateBadge state={matrix.production} />
                  </div>
                  {/* Both channels, always — the summary above is the better of
                      the two, and hiding the weaker one would flatter it. */}
                  <dl className="mt-4 space-y-2 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-muted">{t('pw.organic')}</dt>
                      <dd><StateBadge state={matrix.organic.state} /></dd>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-muted">{t('pw.paid')}</dt>
                      <dd><StateBadge state={matrix.paid.state} /></dd>
                    </div>
                  </dl>
                </Card>
              </Link>
            ))}
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

/** `/app/marketing/:platform` — one platform's organic and paid capabilities. */
export function PlatformWorkspacePage() {
  const { t } = useI18n();
  const params = useParams<{ platform: string }>();
  const { data, loading, error, refetch } = useQuery<CapabilitiesResponse>('/marketing/capabilities');

  const key = (params.platform ?? '').toUpperCase();
  const matrix = useMemo(
    () => data?.platforms.find((entry) => entry.platform === key) ?? null,
    [data, key],
  );

  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (loading || !data) return <CardSkeleton rows={8} />;

  if (!matrix) {
    return (
      <ErrorState
        message={t('pw.noPlatform')}
        onRetry={refetch}
      />
    );
  }

  const label = PLATFORM_LABELS[matrix.platform] ?? matrix.label;

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
        title={t('pw.title').replace('{platform}', label)}
        subtitle={t('pw.subtitle').replace('{platform}', label)}
        action={<StateBadge state={matrix.production} />}
      />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <ChannelCard channel={matrix.organic} />
        <ChannelCard channel={matrix.paid} />
      </div>
    </>
  );
}
