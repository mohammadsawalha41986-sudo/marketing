/**
 * The report itself — the thing a client reads.
 *
 * One component for both the on-screen preview and the printed page. Two
 * renderers would drift, and the drift would only ever be discovered by a
 * customer holding a PDF that disagrees with what the operator approved. The
 * print rules live in `index.css` under `@media print`, so what you see is what
 * prints, and "export" is the browser's own PDF writer rather than a headless
 * Chrome this project would otherwise have to ship.
 *
 * The rule that governs every figure here: a metric with no measured value is
 * never rendered as a number. Phase 14 distinguishes four states and this
 * component renders four different things, because printing "0 saves" for a
 * platform that has no saves metric is a false statement in a document that
 * goes to a paying client — worse than an empty cell, because it looks
 * authoritative.
 */

import { AlertTriangle, BarChart3, Info } from 'lucide-react';

import { PLATFORM_COLORS, PLATFORM_LABELS, date, humanize, num } from '../lib/format';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { cn } from '../lib/utils';
import type {
  MetricState, QualifiedMetric, ReportData, ReportSection,
} from '../lib/report-types';

/** The four states, and how each one reads to a client. */
function StateNote({ state, note }: { state: MetricState; note: string | null }) {
  const { t } = useI18n();
  if (state === 'ZERO') return null;

  const tone = state === 'PROVIDER_ERROR' ? 'text-danger' : 'text-muted';
  return (
    <span className={cn('block text-[10.5px] leading-snug', tone)} dir="auto">
      {t(`report.state.${state}` as TranslationKey)}
      {note ? ` — ${note}` : ''}
    </span>
  );
}

/**
 * A figure, or the reason there isn't one.
 *
 * `value === null` is the whole contract: the server sets it to null for every
 * state except ZERO, so this component cannot accidentally print an absence as
 * a number even if a future caller passes a stale sum alongside it.
 */
function MetricValue({ metric, lang }: { metric: QualifiedMetric; lang: 'en' | 'ar' }) {
  const { t } = useI18n();

  if (metric.value === null) {
    return (
      <>
        <span className="text-[15px] font-semibold text-muted">
          {t(`report.short.${metric.state}` as TranslationKey)}
        </span>
        <StateNote state={metric.state} note={metric.note} />
      </>
    );
  }

  return (
    <span className="tabular text-[22px] font-semibold leading-none text-fg" dir="ltr">
      {num(metric.value, lang)}
    </span>
  );
}

function KpiCard({ metric, lang }: { metric: QualifiedMetric; lang: 'en' | 'ar' }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 print:break-inside-avoid">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {t(`report.metric.${metric.metric}` as TranslationKey)}
      </p>
      <div className="mt-1.5">
        <MetricValue metric={metric} lang={lang} />
      </div>
    </div>
  );
}

export interface ReportPreviewProps {
  title: string;
  clientName: string;
  clientLogoUrl?: string | null;
  description?: string | null;
  data: ReportData;
  sections: ReportSection[];
}

export function ReportPreview({
  title, clientName, clientLogoUrl, description, data, sections,
}: ReportPreviewProps) {
  const { lang, t } = useI18n();
  const has = (section: ReportSection) => sections.includes(section);

  const engagementMetrics = data.totals.filter((entry) =>
    ['engagements', 'likes', 'comments', 'shares', 'saves', 'clicks'].includes(entry.metric));
  const reachMetrics = data.totals.filter((entry) =>
    ['reach', 'impressions'].includes(entry.metric));

  return (
    <article className="report-sheet mx-auto w-full max-w-[880px] bg-surface text-fg">
      {/* ---------------------------------------------------------- header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight" dir="auto">{title}</h1>
          <p className="mt-1 text-[13px] text-muted" dir="auto">{clientName}</p>
          {description ? (
            <p className="mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-muted" dir="auto">{description}</p>
          ) : null}
        </div>

        <div className="text-end">
          {clientLogoUrl ? (
            <img src={clientLogoUrl} alt="" className="mb-2 ms-auto h-10 w-10 rounded-lg object-cover" />
          ) : null}
          <p className="text-[11px] uppercase tracking-wide text-muted">{t('report.period')}</p>
          <p className="text-[12.5px] font-medium" dir="ltr">
            {date(data.period.from, lang)} — {date(data.period.to, lang)}
          </p>
        </div>
      </header>

      {/* ------------------------------------------------------- overview */}
      {has('OVERVIEW') ? (
        <section className="mt-6 print:break-inside-avoid">
          <h2 className="text-[15px] font-semibold">{t('report.overview')}</h2>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {data.platforms.length === 0 ? (
              <span className="text-[12px] text-muted">{t('report.noPlatforms')}</span>
            ) : (
              data.platforms.map((platform) => {
                const color = PLATFORM_COLORS[platform] ?? '#94a3b8';
                return (
                  <span
                    key={platform}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                    style={{ borderColor: `${color}44`, background: `${color}18`, color }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                    {PLATFORM_LABELS[platform] ?? humanize(platform)}
                  </span>
                );
              })
            )}
          </div>

          <p className="mt-2 text-[12.5px] text-muted" dir="auto">
            {t('report.postsSummary')
              .replace('{published}', String(data.publishedPosts))
              .replace('{total}', String(data.totalPosts))}
          </p>

          {/*
            * Said once, at the top, rather than repeated under every empty
            * figure. An operator who reads this knows to expect blanks below.
            */}
          {data.insufficientData ? (
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span dir="auto">{t('report.insufficient')}</span>
            </p>
          ) : null}

          <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {data.totals.map((metric) => (
              <KpiCard key={metric.metric} metric={metric} lang={lang} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------ platforms */}
      {has('PLATFORMS') ? (
        <section className="mt-7 print:break-inside-avoid">
          <h2 className="text-[15px] font-semibold">{t('report.platformPerformance')}</h2>

          {data.breakdown.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted">{t('report.noPlatformData')}</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-line text-start text-[11px] uppercase tracking-wide text-muted">
                    <th className="py-2 text-start font-medium">{t('common.platform')}</th>
                    <th className="py-2 text-end font-medium">{t('report.published')}</th>
                    {data.totals.map((metric) => (
                      <th key={metric.metric} className="py-2 text-end font-medium">
                        {t(`report.metric.${metric.metric}` as TranslationKey)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown.map((row) => (
                    <tr key={row.platform} className="border-b border-line/60 last:border-b-0">
                      <td className="py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: PLATFORM_COLORS[row.platform] ?? '#94a3b8' }}
                          />
                          {PLATFORM_LABELS[row.platform] ?? row.label}
                        </span>
                      </td>
                      <td className="py-2 text-end tabular" dir="ltr">{row.publishedCount}</td>
                      {row.metrics.map((metric) => (
                        <td key={metric.metric} className="py-2 text-end align-top">
                          {metric.value === null ? (
                            <span className="text-[11.5px] text-muted">
                              {t(`report.short.${metric.state}` as TranslationKey)}
                            </span>
                          ) : (
                            <span className="tabular" dir="ltr">{num(metric.value, lang)}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* ---------------------------------------------------- top content */}
      {has('TOP_CONTENT') ? (
        <section className="mt-7">
          <h2 className="text-[15px] font-semibold">{t('report.topContent')}</h2>
          <p className="mt-0.5 text-[11.5px] text-muted" dir="auto">{t('report.topContentNote')}</p>

          {data.topPosts.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted">{t('report.noTopContent')}</p>
          ) : (
            <ol className="mt-2 space-y-1.5">
              {data.topPosts.map((post, index) => (
                <li
                  key={post.platformPostId}
                  className="flex items-start gap-3 rounded-lg border border-line p-2.5 print:break-inside-avoid"
                >
                  <span className="tabular mt-0.5 w-5 shrink-0 text-[12px] font-semibold text-muted" dir="ltr">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[12.5px] leading-snug" dir="auto">
                      {post.caption?.trim() || <span className="text-muted">{t('report.noCaption')}</span>}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted">
                      <span
                        className="inline-flex items-center gap-1"
                        style={{ color: PLATFORM_COLORS[post.platform] ?? undefined }}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: PLATFORM_COLORS[post.platform] ?? '#94a3b8' }}
                        />
                        {PLATFORM_LABELS[post.platform] ?? post.platformLabel}
                      </span>
                      {post.publishedAt ? <span dir="ltr">{date(post.publishedAt, lang)}</span> : null}
                    </p>
                  </div>

                  {/* The post's own engagement, in its own state. */}
                  <div className="shrink-0 text-end">
                    {post.metrics.engagements.value === null ? (
                      <span className="text-[11px] text-muted">
                        {t(`report.short.${post.metrics.engagements.state}` as TranslationKey)}
                      </span>
                    ) : (
                      <>
                        <span className="tabular block text-[14px] font-semibold" dir="ltr">
                          {num(post.metrics.engagements.value, lang)}
                        </span>
                        <span className="text-[10px] text-muted">
                          {t('report.metric.engagements')}
                        </span>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------------------ engagement */}
      {has('ENGAGEMENT') && engagementMetrics.length > 0 ? (
        <section className="mt-7 print:break-inside-avoid">
          <h2 className="text-[15px] font-semibold">{t('report.engagement')}</h2>
          <div className="mt-2 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {engagementMetrics.map((metric) => (
              <KpiCard key={metric.metric} metric={metric} lang={lang} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ----------------------------------------------------------- reach */}
      {has('REACH') && reachMetrics.length > 0 ? (
        <section className="mt-7 print:break-inside-avoid">
          <h2 className="text-[15px] font-semibold">{t('report.reach')}</h2>
          <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
            {reachMetrics.map((metric) => (
              <KpiCard key={metric.metric} metric={metric} lang={lang} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- legend */}
      {/*
        * The legend earns its place only when a state actually appears above.
        * A glossary of four states under a report where every figure is a
        * number is clutter that makes the document look defensive.
        */}
      <StateLegend data={data} />

      <footer className="mt-7 border-t border-line pt-3 text-[10.5px] leading-relaxed text-muted">
        <p className="inline-flex items-start gap-1.5" dir="auto">
          <BarChart3 className="mt-px h-3 w-3 shrink-0" />
          {t('report.sourceNote')}
        </p>
      </footer>
    </article>
  );
}

function StateLegend({ data }: { data: ReportData }) {
  const { t } = useI18n();

  const present = new Set<MetricState>();
  for (const metric of data.totals) if (metric.state !== 'ZERO') present.add(metric.state);
  for (const row of data.breakdown) {
    for (const metric of row.metrics) if (metric.state !== 'ZERO') present.add(metric.state);
  }

  if (present.size === 0) return null;

  return (
    <section className="mt-7 rounded-lg border border-line bg-elevated/40 p-3 print:break-inside-avoid">
      <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Info className="h-3 w-3" />
        {t('report.legend')}
      </p>
      <dl className="mt-1.5 space-y-1">
        {[...present].map((state) => (
          <div key={state} className="flex flex-wrap gap-x-2 text-[11.5px]">
            <dt className="font-medium">{t(`report.short.${state}` as TranslationKey)}</dt>
            <dd className="text-muted" dir="auto">{t(`report.state.${state}` as TranslationKey)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
