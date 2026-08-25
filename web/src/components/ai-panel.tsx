/**
 * The AI recommendations panel.
 *
 * Contextual rather than conversational: it sits beside the post it is talking
 * about, and every row is one decision an operator can act on. There is no chat
 * transcript and no paragraph of prose, because a recommendation the operator
 * has to read three sentences to find is one they will stop reading.
 *
 * The honesty rules the server sets are rendered, not smoothed over:
 *
 *   - `basis: HISTORICAL` earns a "from your data" mark. `CONTEXT` says so
 *     plainly, because advice from market convention is not evidence about this
 *     audience and presenting the two identically is how a default becomes a
 *     fact in someone's head.
 *   - `insufficientData` shows its message at the top rather than being hidden
 *     behind the recommendations it qualifies.
 *   - The quality score is labelled as post completeness, never as predicted
 *     performance — it scores what is in the post, not what the post will do.
 */

import { BarChart3, Info, Sparkles, TriangleAlert } from 'lucide-react';

import { cn } from '../lib/utils';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { CardSkeleton, ErrorState } from './ui';
import type { Confidence, Recommendation, RecommendationReport } from '../lib/workspace-content';

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  HIGH: 'bg-ok/12 text-ok',
  MEDIUM: 'bg-warn/12 text-warn',
  LOW: 'bg-muted/15 text-muted',
};

/** The order sections are shown in; titles come from the dictionary. */
const ORDER: Array<Recommendation['key']> = [
  'BEST_TIME', 'BEST_DAY', 'FORMAT', 'AUDIENCE', 'LOCATION',
  'HOOK', 'CTA', 'HASHTAGS', 'CAPTION', 'LANGUAGE', 'ANGLE', 'BEST_PLATFORM',
];

function Row({ item }: { item: Recommendation }) {
  const { t } = useI18n();

  return (
    <div className="border-b border-line py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {t(`ai.k.${item.key}` as TranslationKey)}
        </p>
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            CONFIDENCE_STYLE[item.confidence],
          )}
        >
          {t(`ai.conf.${item.confidence}` as TranslationKey)}
        </span>
      </div>

      {/*
        * dir="auto" rather than the page direction: these strings come from the
        * server and may be English prose or a bare time like "8:00 PM" while the
        * UI is Arabic. Letting the browser resolve direction per string keeps a
        * clock time from rendering as "PM 8:00" inside an RTL paragraph.
        */}
      <p dir="auto" className="mt-1 text-[13.5px] font-medium leading-snug text-fg">{item.value}</p>
      <p dir="auto" className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{item.reason}</p>

      {/*
        * The provenance mark. A recommendation computed from this client's own
        * published posts says how many it rests on; one from market context says
        * that instead. The two must never look the same.
        */}
      <p className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted">
        {item.basis === 'HISTORICAL' ? (
          <>
            <BarChart3 className="h-3 w-3 text-ok" />
            <span className="text-ok">
              {t('ai.fromYourData')} · <span className="tabular" dir="ltr">{item.sampleSize}</span>
            </span>
          </>
        ) : (
          <>
            <Info className="h-3 w-3" />
            {t('ai.fromContext')}
          </>
        )}
      </p>
    </div>
  );
}

export interface AiPanelProps {
  report: RecommendationReport | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}

export function AiPanel({ report, loading, error, onRetry }: AiPanelProps) {
  const { t } = useI18n();

  if (loading) return <CardSkeleton rows={4} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!report) return null;

  const ordered = [...report.recommendations].sort(
    (a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key),
  );

  const score = report.qualityScore;

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/12 text-brand">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-fg">{t('ai.title')}</p>
          <p className="text-[11px] text-muted">{t('ai.subtitle')}</p>
        </div>
      </div>

      {report.insufficientDataMessage ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-warn/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-warn">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span dir="auto">{report.insufficientDataMessage}</span>
        </p>
      ) : null}

      {/* Post completeness. Explicitly not a performance prediction — the label
          says what it measures so the number cannot be mistaken for a forecast. */}
      <div className="mt-3 rounded-lg border border-line p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t('ai.completeness')}
          </p>
          <span
            className={cn(
              'tabular text-[13px] font-semibold',
              score >= 70 ? 'text-ok' : score >= 40 ? 'text-warn' : 'text-danger',
            )}
            dir="ltr"
          >
            {score}/100
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              score >= 70 ? 'bg-ok' : score >= 40 ? 'bg-warn' : 'bg-danger',
            )}
            style={{ width: `${score}%` }}
          />
        </div>
        <p className="mt-1.5 text-[10.5px] text-muted">{t('ai.completenessHint')}</p>

        {report.qualityFindings.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {report.qualityFindings.map((finding) => (
              <li key={finding} dir="auto" className="flex items-start gap-1.5 text-[11px] text-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warn" />
                {finding}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-3">
        {ordered.map((item) => (
          <Row key={item.key} item={item} />
        ))}
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-muted">{t('ai.recDisclaimer')}</p>
    </div>
  );
}
