/** Analytics with the AI marketing analyst, plus report generation and viewing. */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Bot, Download, FileText, Plus, Sparkles, TrendingUp } from 'lucide-react';

import { api, qs, type Metrics, type Paginated, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, isoDate, money, num, pct, ratio, humanize } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, TableWrap, Td, Th, useToast,
} from '../components/ui';
import { AiBadge, AiEmptyHint, AiNotice, KpiCard, PlatformChip, RecommendationCard, type Recommendation } from '../components/domain';
import { ComparisonBars, DonutChart, TrendChart } from '../components/charts';

interface SeriesResponse {
  range: { from: string; to: string };
  series: Array<{ date: string } & Metrics>;
  platforms: Array<{ platform: Platform; label: string } & Metrics>;
  totals: Metrics;
}

interface Analysis {
  summary: string;
  working: string[];
  failing: string[];
  recommendations: Recommendation[];
  nextActions: string[];
}

export function AnalyticsPage({ portal = false }: { portal?: boolean }) {
  const { t, lang } = useI18n();
  const { user, isAgency } = useAuth();
  const { push } = useToast();
  const [days, setDays] = useState(30);
  const [analysis, setAnalysis] = useState<{ analysis: Analysis; meta: { isFallback: boolean; notice?: string; disclaimer: string } } | null>(null);
  const [analysing, setAnalysing] = useState(false);

  // Whose numbers these are is a top-bar decision. A portal user only ever has
  // their own.
  const { currentId, restaurants } = useRestaurant();
  const clientId = portal ? user?.clientId ?? '' : currentId;

  // A different restaurant makes the previous analysis about somebody else.
  useEffect(() => setAnalysis(null), [clientId]);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    return { from: isoDate(from), to: isoDate(to) };
  }, [days]);

  const { data, loading, error, refetch } = useQuery<SeriesResponse>(
    `/analytics/series${qs({ ...range, clientId })}`,
    [range.from, range.to, clientId],
  );

  const runAnalysis = async () => {
    const target = clientId || restaurants[0]?.id;
    if (!target) {
      push({ tone: 'error', title: 'Choose a restaurant to analyse' });
      return;
    }
    setAnalysing(true);
    try {
      const response = await api.post<typeof analysis>('/analytics/analyze', { clientId: target, ...range });
      setAnalysis(response);
    } catch (err) {
      push({ tone: 'error', title: 'Analysis failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setAnalysing(false);
    }
  };

  const totals = data?.totals;

  return (
    <>
      <PageHeader
        title={t('nav.analytics')}
        subtitle="Every number here is computed from stored campaign data."
        action={
          <>
            <Select value={days} onChange={(event) => setDays(Number(event.target.value))} className="w-36">
              {[7, 30, 90].map((value) => <option key={value} value={value}>Last {value} days</option>)}
            </Select>
            {isAgency ? (
              <Button icon={Bot} onClick={runAnalysis} loading={analysing}>
                {analysing ? t('ai.analyzing') : t('ai.analyze')}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)}
          </div>
          <CardSkeleton rows={6} />
        </div>
      ) : totals && totals.impressions > 0 ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <KpiCard label={t('kpi.spend')} value={totals.spend} format="money" compact />
            <KpiCard label={t('kpi.impressions')} value={totals.impressions} compact />
            <KpiCard label={t('kpi.clicks')} value={totals.clicks} compact />
            <KpiCard label={t('kpi.conversions')} value={totals.conversions} />
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <KpiCard label={t('kpi.ctr')} value={totals.ctr} format="percent" />
            <KpiCard label={t('kpi.cpc')} value={totals.cpc} format="money" />
            <KpiCard label={t('kpi.cpa')} value={totals.cpa} format="money" />
            <KpiCard label={t('kpi.roas')} value={totals.roas} format="ratio" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Spend and revenue" icon={TrendingUp} />
              <div className="p-4">
                <TrendChart
                  data={data.series}
                  keys={[{ key: 'spend', label: t('kpi.spend') }, { key: 'revenue', label: t('kpi.revenue') }]}
                  currency
                  height={280}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Platform share" />
              <div className="p-4">
                <DonutChart data={data.platforms.map((row) => ({ label: row.label, value: row.spend, platform: row.platform }))} />
              </div>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Clicks and conversions" />
              <div className="p-4">
                <TrendChart
                  data={data.series}
                  keys={[{ key: 'clicks', label: t('kpi.clicks') }, { key: 'conversions', label: t('kpi.conversions') }]}
                  height={240}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="Conversions by platform" />
              <div className="p-4">
                <ComparisonBars data={data.platforms as never} dataKey="conversions" height={240} />
              </div>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title="Platform breakdown" />
            <TableWrap>
              <thead>
                <tr>
                  <Th>{t('common.platform')}</Th>
                  <Th align="end">{t('kpi.spend')}</Th>
                  <Th align="end">{t('kpi.impressions')}</Th>
                  <Th align="end">{t('kpi.clicks')}</Th>
                  <Th align="end">{t('kpi.ctr')}</Th>
                  <Th align="end">{t('kpi.cpc')}</Th>
                  <Th align="end">{t('kpi.conversions')}</Th>
                  <Th align="end">{t('kpi.roas')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.platforms.map((row) => (
                  <tr key={row.platform}>
                    <Td><PlatformChip platform={row.platform} size="sm" /></Td>
                    <Td align="end">{money(row.spend, lang, true)}</Td>
                    <Td align="end">{num(row.impressions, lang, true)}</Td>
                    <Td align="end">{num(row.clicks, lang, true)}</Td>
                    <Td align="end">{pct(row.ctr)}</Td>
                    <Td align="end">{money(row.cpc, lang)}</Td>
                    <Td align="end">{num(row.conversions, lang)}</Td>
                    <Td align="end">{ratio(row.roas)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>

          {/* AI analyst */}
          <Card className="mt-4">
            <CardHeader
              title={t('ai.analyst')}
              icon={Sparkles}
              action={analysis ? <AiBadge isFallback={analysis.meta.isFallback} /> : null}
            />
            <div className="p-5">
              {analysis ? (
                <div className="space-y-5">
                  <p className="text-[15px] leading-relaxed text-fg">{analysis.analysis.summary}</p>
                  <AiNotice notice={analysis.meta.notice} />

                  <div className="grid gap-4 sm:grid-cols-2">
                    {analysis.analysis.working.length > 0 ? (
                      <div>
                        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ok">{t('ai.working')}</p>
                        <ul className="space-y-1.5 text-[13px] text-muted">
                          {analysis.analysis.working.map((item) => <li key={item}>• {item}</li>)}
                        </ul>
                      </div>
                    ) : null}
                    {analysis.analysis.failing.length > 0 ? (
                      <div>
                        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-warn">{t('ai.failing')}</p>
                        <ul className="space-y-1.5 text-[13px] text-muted">
                          {analysis.analysis.failing.map((item) => <li key={item}>• {item}</li>)}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-2.5">
                    {analysis.analysis.recommendations.map((recommendation, index) => (
                      <motion.div key={recommendation.title} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }}>
                        <RecommendationCard recommendation={recommendation} />
                      </motion.div>
                    ))}
                  </div>

                  {analysis.analysis.nextActions.length > 0 ? (
                    <div>
                      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('ai.nextActions')}</p>
                      <ul className="space-y-1.5 text-[13px] text-fg">
                        {analysis.analysis.nextActions.map((item) => <li key={item}>→ {item}</li>)}
                      </ul>
                    </div>
                  ) : null}

                  <p className="border-t border-line pt-3 text-[12px] text-muted">{analysis.meta.disclaimer}</p>
                </div>
              ) : (
                <AiEmptyHint onRun={runAnalysis} loading={analysing} />
              )}
            </div>
          </Card>
        </>
      ) : (
        <Card><EmptyState icon={TrendingUp} title="No analytics for this period" body="Once campaigns start delivering, the numbers appear here." /></Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- reports

interface ReportRow {
  id: string;
  type: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  client: { id: string; name: string; logoUrl: string | null };
  campaign: { id: string; name: string } | null;
}

export function ReportsPage({ portal = false }: { portal?: boolean }) {
  const { t, lang } = useI18n();
  const { isAgency } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    clientId: '',
    type: 'MONTHLY',
    from: isoDate(new Date(Date.now() - 29 * 86400000)),
    to: isoDate(new Date()),
    includeAi: true,
  });

  const clients = useQuery<Paginated<{ id: string; name: string }>>(portal ? null : `/clients${qs({ pageSize: 100 })}`);
  const { data, loading, error, refetch } = useQuery<Paginated<ReportRow>>(`/reports${qs({ page, pageSize: 15 })}`, [page]);

  const generate = async () => {
    setBusy(true);
    try {
      const response = await api.post<{ report: { id: string } }>('/reports/generate', form);
      push({ tone: 'success', title: 'Report generated' });
      setCreating(false);
      refetch();
      navigate(`${portal ? '/client' : '/app'}/reports/${response.report.id}`);
    } catch (err) {
      push({ tone: 'error', title: 'Could not generate', body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const base = portal ? '/client' : '/app';

  return (
    <>
      <PageHeader
        title={t('nav.reports')}
        subtitle="Figures are frozen at generation time, so a report reads the same next quarter."
        action={isAgency ? <Button icon={Plus} onClick={() => setCreating(true)}>Generate report</Button> : undefined}
      />

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <CardSkeleton rows={6} />
      ) : data && data.items.length > 0 ? (
        <Card>
          <TableWrap>
            <thead>
              <tr><Th>Report</Th><Th>{t('common.client')}</Th><Th>Period</Th><Th>Type</Th><Th align="end">{t('common.actions')}</Th></tr>
            </thead>
            <tbody>
              {data.items.map((report) => (
                <tr key={report.id} className="cursor-pointer transition-colors hover:bg-elevated" onClick={() => navigate(`${base}/reports/${report.id}`)}>
                  <Td><span className="font-medium">{report.title}</span></Td>
                  <Td className="text-muted">{report.client.name}</Td>
                  <Td className="text-muted">{date(report.periodStart, lang)} → {date(report.periodEnd, lang)}</Td>
                  <Td><Badge>{humanize(report.type)}</Badge></Td>
                  <Td align="end">
                    <a
                      href={`/api/reports/${report.id}/export?format=html`}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-[13px] text-brand hover:underline"
                    >
                      <Download className="h-3.5 w-3.5" />HTML
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={FileText}
            title={t('empty.reports.title')}
            body={t('empty.reports.body')}
            action={isAgency ? <Button icon={Plus} onClick={() => setCreating(true)}>Generate report</Button> : undefined}
          />
        </Card>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Generate a report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={generate} loading={busy} disabled={!form.clientId}>Generate</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.client')} required className="sm:col-span-2">
            <Select value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} required>
              <option value="">Select a client</option>
              {clients.data?.items.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              {['CLIENT', 'CAMPAIGN', 'MONTHLY', 'PLATFORM'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
            </Select>
          </Field>
          <Field label="Include AI insights">
            <Select value={form.includeAi ? 'yes' : 'no'} onChange={(event) => setForm({ ...form, includeAi: event.target.value === 'yes' })}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Field label="From"><Input type="date" value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} /></Field>
          <Field label="To"><Input type="date" value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

interface ReportPayload {
  client: { name: string; businessName: string };
  period: { from: string; to: string };
  totals: Metrics;
  changes: Record<string, number | null>;
  series: Array<{ date: string } & Metrics>;
  platforms: Array<{ platform: Platform; label: string } & Metrics>;
  campaigns: Array<{ id: string; name: string; status: string; budget: number; spend: number }>;
  analysis: Analysis | null;
  aiMeta: { isFallback: boolean } | null;
  generatedAt: string;
  note?: string;
}

export function ReportDetailPage() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { data, loading, error, refetch } = useQuery<{ report: { id: string; title: string; payload: ReportPayload } }>(
    `/reports/${id}`,
    [id],
  );

  if (loading) return <CardSkeleton rows={8} />;
  if (error || !data) return <Card><ErrorState message={error ?? 'Report not found'} onRetry={refetch} /></Card>;

  const payload = data.report.payload;
  const hasFigures = payload.totals && Object.keys(payload.totals).length > 0;

  return (
    <>
      <PageHeader
        title={data.report.title}
        subtitle={`${payload.client?.businessName ?? ''} · ${payload.period?.from} → ${payload.period?.to}`}
        action={
          <>
            <a href={`/api/reports/${id}/export?format=html`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-elevated px-4 text-sm text-fg transition-colors hover:bg-line/60">
              <Download className="h-4 w-4" />HTML
            </a>
            <a href={`/api/reports/${id}/export?format=md`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-elevated px-4 text-sm text-fg transition-colors hover:bg-line/60">
              <Download className="h-4 w-4" />Markdown
            </a>
          </>
        }
      />

      {payload.note ? (
        <Card className="mb-4 p-4">
          <p className="text-[13px] text-muted">{payload.note}</p>
        </Card>
      ) : null}

      {hasFigures ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <KpiCard label={t('kpi.spend')} value={payload.totals.spend} format="money" compact />
            <KpiCard label={t('kpi.reach')} value={payload.totals.reach} compact />
            <KpiCard label={t('kpi.conversions')} value={payload.totals.conversions} />
            <KpiCard label={t('kpi.roas')} value={payload.totals.roas} format="ratio" />
          </div>

          {payload.series?.length ? (
            <Card className="mb-4">
              <CardHeader title="Daily performance" />
              <div className="p-4">
                <TrendChart data={payload.series} keys={[{ key: 'spend', label: t('kpi.spend') }, { key: 'revenue', label: t('kpi.revenue') }]} currency />
              </div>
            </Card>
          ) : null}

          {payload.platforms?.length ? (
            <Card className="mb-4">
              <CardHeader title="By platform" />
              <TableWrap>
                <thead>
                  <tr>
                    <Th>{t('common.platform')}</Th><Th align="end">{t('kpi.spend')}</Th>
                    <Th align="end">{t('kpi.clicks')}</Th><Th align="end">{t('kpi.ctr')}</Th>
                    <Th align="end">{t('kpi.conversions')}</Th><Th align="end">{t('kpi.roas')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {payload.platforms.map((row) => (
                    <tr key={row.platform}>
                      <Td><PlatformChip platform={row.platform} size="sm" /></Td>
                      <Td align="end">{money(row.spend, lang, true)}</Td>
                      <Td align="end">{num(row.clicks, lang, true)}</Td>
                      <Td align="end">{pct(row.ctr)}</Td>
                      <Td align="end">{num(row.conversions, lang)}</Td>
                      <Td align="end">{ratio(row.roas)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>
          ) : null}

          {payload.analysis ? (
            <Card>
              <CardHeader
                title="Insights and recommendations"
                icon={Sparkles}
                action={payload.aiMeta ? <AiBadge isFallback={payload.aiMeta.isFallback} /> : null}
              />
              <div className="space-y-5 p-5">
                <p className="text-[15px] leading-relaxed text-fg">{payload.analysis.summary}</p>
                <div className="space-y-2.5">
                  {payload.analysis.recommendations.map((recommendation) => (
                    <RecommendationCard key={recommendation.title} recommendation={recommendation} />
                  ))}
                </div>
              </div>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <EmptyState
            icon={FileText}
            title="This report has no figures"
            body="Generate a new report from the Reports page to compute it from live data."
          />
        </Card>
      )}
    </>
  );
}
