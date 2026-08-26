/**
 * The AI advertising dashboard.
 *
 * Its job is to make a finding checkable. Every card carries what was observed,
 * why it matters, what to do about it, how sure the engine is and which
 * services it actually queried — so an operator can disagree with the reasoning
 * rather than only with the conclusion.
 *
 * Two presentational rules do most of the work:
 *
 * An INSUFFICIENT_DATA finding is rendered, not hidden. A missing "best
 * platform" card cannot tell anyone whether the engine looked and found nothing
 * or never ran; a card that says "not enough historical data, here is why" can.
 *
 * OBSERVED and INFERRED evidence are labelled differently. One is a
 * measurement and the other is a conclusion drawn from it, and a reader who
 * cannot tell them apart cannot tell which part to argue with.
 *
 * Nothing on this page changes a budget. Accepting a recommendation records
 * agreement and says so on the button's own row.
 */

import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Brain, Check, ChevronRight, Info, Lightbulb, RefreshCw, X,
} from 'lucide-react';

import { api, qs } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, Drawer, EmptyState, ErrorState,
  PageHeader, Select, useToast, type BadgeTone,
} from '../components/ui';
import { PlatformChip } from '../components/domain';

// --------------------------------------------------------------- shapes

type InsightState = 'PERFORMING' | 'UNDERPERFORMING' | 'AT_RISK' | 'INSUFFICIENT_DATA';
type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
type Priority = 'P0' | 'P1' | 'P2' | 'P3';

interface Evidence {
  kind: 'OBSERVED' | 'INFERRED';
  metric: string;
  value: string;
  comparison?: string;
  detail: string;
}

interface Insight {
  key: string;
  type: string;
  priority: Priority;
  state: InsightState;
  title: string;
  finding: string;
  reason: string;
  recommendedAction: string | null;
  confidence: Confidence;
  dataSources: string[];
  evidence: Evidence[];
  platform: string | null;
  campaignId: string | null;
  creativeId: string | null;
  location: string | null;
  proposedChange: { field: string; from: unknown; to: unknown } | null;
}

interface InsightsResponse {
  window: { from: string; to: string; days: number };
  sections: Array<{ key: string; insights: Insight[] }>;
  limitations: string[];
  dataSources: string[];
  ai: { provider: string; model: string; configured: boolean };
  persisted: { created: number; superseded: number } | null;
}

interface StoredRecommendation {
  id: string;
  type: string;
  priority: Priority;
  state: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  confidence: Confidence;
  expectedImpact: string | null;
  dataSources: string[];
  platform: string | null;
  status: string;
  createdAt: string;
}

// ---------------------------------------------------------------- atoms

const STATE_TONES: Record<InsightState, BadgeTone> = {
  PERFORMING: 'ok',
  UNDERPERFORMING: 'warn',
  AT_RISK: 'danger',
  INSUFFICIENT_DATA: 'neutral',
};

const PRIORITY_TONES: Record<Priority, BadgeTone> = {
  P0: 'danger',
  P1: 'warn',
  P2: 'brand',
  P3: 'neutral',
};

const CONFIDENCE_TONES: Record<Confidence, BadgeTone> = {
  HIGH: 'ok',
  MEDIUM: 'brand',
  LOW: 'neutral',
};

/**
 * Evidence, with its kind on its face.
 *
 * OBSERVED is a number a provider returned. INFERRED is what the engine
 * concluded from it. Rendering them identically would let a conclusion pass for
 * a measurement, which is exactly the confusion this whole engine is built to
 * avoid.
 */
function EvidenceRow({ item }: { item: Evidence }) {
  const { t } = useI18n();
  return (
    <li className="border-b border-line py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.kind === 'OBSERVED' ? 'brand' : 'neutral'}>
          {item.kind === 'OBSERVED' ? t('aia.observed') : t('aia.inferred')}
        </Badge>
        <span className="text-[12px] text-muted">{item.metric}</span>
        <span className="text-[13px] font-semibold text-fg" dir="auto">{item.value}</span>
        {item.comparison ? (
          <span className="text-[12px] text-muted" dir="auto">· {item.comparison}</span>
        ) : null}
      </div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-muted" dir="auto">{item.detail}</p>
    </li>
  );
}

function InsightCard({ insight, onOpen }: { insight: Insight; onOpen: () => void }) {
  const { t } = useI18n();

  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {insight.platform ? <PlatformChip platform={insight.platform} size="sm" /> : null}
          <Badge tone={PRIORITY_TONES[insight.priority]}>{insight.priority}</Badge>
        </div>
        <Badge tone={STATE_TONES[insight.state]} className="whitespace-normal text-start leading-snug">
          {t(`aia.state.${insight.state}` as TranslationKey)}
        </Badge>
      </div>

      <h3 className="mt-2.5 text-sm font-semibold text-fg" dir="auto">{insight.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-fg" dir="auto">{insight.finding}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted" dir="auto">{insight.reason}</p>

      {insight.recommendedAction ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-brand/25 bg-brand/10 px-2.5 py-2">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
          <p className="text-[12px] leading-relaxed text-fg" dir="auto">{insight.recommendedAction}</p>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <Badge tone={CONFIDENCE_TONES[insight.confidence]}>
          {t('aia.confidence')}: {t(`ai.conf.${insight.confidence}` as TranslationKey)}
        </Badge>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline"
        >
          {t('aia.why')}
          <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
        </button>
      </div>
    </Card>
  );
}

/** §25 — the explanation, in the order a reader can follow it. */
function InsightDetail({ insight }: { insight: Insight }) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {insight.platform ? <PlatformChip platform={insight.platform} size="sm" /> : null}
        <Badge tone={PRIORITY_TONES[insight.priority]}>{insight.priority}</Badge>
        <Badge tone={STATE_TONES[insight.state]} className="whitespace-normal text-start leading-snug">
          {t(`aia.state.${insight.state}` as TranslationKey)}
        </Badge>
        <Badge tone={CONFIDENCE_TONES[insight.confidence]}>
          {t(`ai.conf.${insight.confidence}` as TranslationKey)}
        </Badge>
      </div>

      <h3 className="text-base font-semibold text-fg" dir="auto">{insight.title}</h3>

      <section>
        <p className="text-[11px] uppercase tracking-wide text-muted">{t('aia.observation')}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-fg" dir="auto">{insight.finding}</p>
      </section>

      {insight.evidence.length > 0 ? (
        <section>
          <p className="text-[11px] uppercase tracking-wide text-muted">{t('aia.evidence')}</p>
          <ul className="mt-1">
            {insight.evidence.map((item, index) => (
              <EvidenceRow key={`${item.metric}-${index}`} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <p className="text-[11px] uppercase tracking-wide text-muted">{t('aia.interpretation')}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted" dir="auto">{insight.reason}</p>
      </section>

      {insight.recommendedAction ? (
        <section>
          <p className="text-[11px] uppercase tracking-wide text-muted">{t('aia.action')}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-fg" dir="auto">{insight.recommendedAction}</p>
        </section>
      ) : null}

      <section>
        <p className="text-[11px] uppercase tracking-wide text-muted">{t('aia.dataSources')}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {insight.dataSources.map((source) => (
            <Badge key={source} tone="neutral">{source}</Badge>
          ))}
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------ dashboard

export function AdvertisingAiPage() {
  const { t } = useI18n();
  const { currentId: restaurantId } = useRestaurant();
  const [params, setParams] = useSearchParams();
  const toast = useToast();

  const platform = params.get('platform') ?? '';
  const priority = params.get('priority') ?? '';

  const setFilter = useCallback((key: string, value: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);

  const query = qs({
    clientId: restaurantId || undefined,
    platform: platform || undefined,
  });

  const insights = useQuery<InsightsResponse>(`/advertising/ai/insights${query}`, [query]);
  const stored = useQuery<{ items: StoredRecommendation[] }>(
    `/advertising/ai/recommendations${query}`, [query],
  );

  const [open, setOpen] = useState<Insight | null>(null);
  const [saving, setSaving] = useState(false);

  /** Persisting needs one client: a recommendation row belongs to one. */
  const persist = async () => {
    if (!restaurantId) {
      toast.push({ tone: 'info', title: t('aia.saved') });
      return;
    }
    setSaving(true);
    try {
      await api.get(`/advertising/ai/insights${qs({ clientId: restaurantId, persist: 'true' })}`);
      stored.refetch();
      toast.push({ tone: 'success', title: t('aia.saved') });
    } finally {
      setSaving(false);
    }
  };

  const decide = async (id: string, decision: 'REVIEWED' | 'ACCEPTED' | 'DISMISSED') => {
    await api.post(`/advertising/ai/recommendations/${id}/decision`, { decision });
    stored.refetch();
  };

  if (insights.error) return <ErrorState message={insights.error} onRetry={insights.refetch} />;

  const sections = (insights.data?.sections ?? []).filter(
    (section) => !priority || section.insights.some((insight) => insight.priority === priority),
  );

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
        title={t('aia.title')}
        subtitle={t('aia.subtitle')}
        action={
          <Button variant="secondary" onClick={persist} disabled={saving || !restaurantId}>
            <RefreshCw className="h-4 w-4" />
            {t('aia.refresh')}
          </Button>
        }
      />

      {/* §28 — say plainly whether a model was involved at all. */}
      {insights.data && !insights.data.ai.configured ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-elevated/50 px-3 py-2">
          <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-fg">
              {t('aia.provider')}: {t('aia.ruleBased')}
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted" dir="auto">{t('aia.noModel')}</p>
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Select
          value={platform}
          onChange={(event) => setFilter('platform', event.target.value)}
          aria-label={t('adv.f.platform')}
          className="w-auto"
        >
          <option value="">{t('adv.f.platform')}: {t('adv.f.all')}</option>
          {['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'GOOGLE_ADS'].map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </Select>

        <Select
          value={priority}
          onChange={(event) => setFilter('priority', event.target.value)}
          aria-label={t('aia.priority')}
          className="w-auto"
        >
          <option value="">{t('aia.priority')}: {t('adv.f.all')}</option>
          {(['P0', 'P1', 'P2', 'P3'] as Priority[]).map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </Select>
      </div>

      {insights.loading || !insights.data ? (
        <CardSkeleton rows={6} />
      ) : sections.length === 0 ? (
        <EmptyState icon={Brain} title={t('aia.noInsights')} body={t('aia.subtitle')} />
      ) : (
        <div className="space-y-6">
          {sections.map((section) => {
            const visible = priority
              ? section.insights.filter((insight) => insight.priority === priority)
              : section.insights;
            if (visible.length === 0) return null;

            return (
              <section key={section.key}>
                <h2 className="mb-2.5 text-sm font-semibold text-fg">
                  {t(`aia.sec.${section.key}` as TranslationKey)}
                </h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {visible.map((insight) => (
                    <InsightCard key={insight.key} insight={insight} onOpen={() => setOpen(insight)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* What the engine could not analyse — shown, never swallowed. */}
      {insights.data && insights.data.limitations.length > 0 ? (
        <Card className="mt-6">
          <CardHeader title={t('aia.limitations')} />
          <ul className="space-y-1.5">
            {insights.data.limitations.map((limitation) => (
              <li key={limitation} className="flex items-start gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="text-[13px] leading-relaxed text-muted" dir="auto">{limitation}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Saved recommendations, with the decisions people have made. */}
      {stored.data && stored.data.items.length > 0 ? (
        <Card className="mt-6">
          <CardHeader title={t('aia.recommendations')} />
          <p className="mb-3 text-[12px] leading-relaxed text-muted" dir="auto">
            {t('aia.act.noFinancial')}
          </p>
          <ul className="-mt-1">
            {stored.data.items.map((item) => (
              <li key={item.id} className="border-b border-line py-3 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  {item.platform ? <PlatformChip platform={item.platform} size="sm" /> : null}
                  <Badge tone={PRIORITY_TONES[item.priority] ?? 'neutral'}>{item.priority}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" dir="auto">
                    {item.title}
                  </span>
                  <Badge tone={item.status === 'APPROVED' ? 'ok' : item.status === 'REJECTED' ? 'neutral' : 'brand'}>
                    {t(`aia.st.${item.status}` as TranslationKey)}
                  </Badge>
                </div>

                {item.status === 'PENDING' || item.status === 'REVIEWED' ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => decide(item.id, 'ACCEPTED')}>
                      <Check className="h-4 w-4" />{t('aia.act.accept')}
                    </Button>
                    <Button variant="ghost" onClick={() => decide(item.id, 'DISMISSED')}>
                      <X className="h-4 w-4" />{t('aia.act.dismiss')}
                    </Button>
                    {item.status === 'PENDING' ? (
                      <Button variant="ghost" onClick={() => decide(item.id, 'REVIEWED')}>
                        {t('aia.act.review')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Drawer open={open !== null} onClose={() => setOpen(null)} title={t('aia.detail')}>
        {open ? <InsightDetail insight={open} /> : null}
      </Drawer>
    </>
  );
}
