/**
 * Which of your ads is working.
 *
 * The operator made these files. The one thing this system owes them back is
 * which one earned its money — not which campaign, which *ad*, because the
 * campaign is our structure and the ad is their work.
 *
 * Every verdict on this page carries the numbers behind it, and a creative
 * without enough delivery to judge says what it is still waiting for rather
 * than being quietly ranked last.
 */

import { useMemo, useState } from 'react';
import { Award, Filter, Image as ImageIcon, TrendingDown, TrendingUp } from 'lucide-react';

import { qs, type Metrics, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { cn } from '../lib/utils';
import { money, num, pct, ratio } from '../lib/format';
import {
  Badge, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader, Select,
  TableWrap, Td, Th, type BadgeTone,
} from '../components/ui';
import { PlatformChip } from '../components/domain';

type Verdict = 'WINNER' | 'GOOD' | 'AVERAGE' | 'WEAK' | 'INSUFFICIENT_DATA';

const VERDICT_TONE: Record<Verdict, BadgeTone> = {
  WINNER: 'ok',
  GOOD: 'brand',
  AVERAGE: 'neutral',
  WEAK: 'danger',
  INSUFFICIENT_DATA: 'neutral',
};

interface CreativeTotals extends Metrics {
  linkClicks: number;
  videoViews: number | null;
  videoCompletions: number | null;
  completionRate: number | null;
}

interface PerformanceRow {
  creativeId: string;
  platform: Platform | null;
  currency: string;
  days: number;
  firstSeen: string | null;
  lastSeen: string | null;
  totals: CreativeTotals;
  verdict: Verdict;
  verdictReason: string;
  missing: string[];
  campaigns: Array<{ id: string; name: string }>;
  trend: Array<{ date: string; spend: number; clicks: number; conversions: number }>;
  creative: {
    id: string;
    source: string;
    preset: string;
    platform: Platform;
    width: number;
    height: number;
    headline: string | null;
    url: string;
  } | null;
}

interface Response {
  range: { from: string; to: string };
  thresholds: { minImpressions: number; minClicks: number; minSpend: number; minConversions: number };
  baseline: { ctr: number | null; cpa: number | null; roas: number | null };
  items: PerformanceRow[];
  provenance: string;
}

type SortKey = 'spend' | 'ctr' | 'conversions' | 'roas';

/** A spark of the daily spend, enough to see a shape without a chart library. */
function Spark({ points }: { points: PerformanceRow['trend'] }) {
  if (points.length < 2) return <span className="text-[11px] text-muted">—</span>;
  const max = Math.max(...points.map((point) => point.spend), 1);

  return (
    <span className="flex h-6 items-end gap-[2px]" aria-hidden>
      {points.slice(-14).map((point) => (
        <span
          key={point.date}
          className="w-[3px] rounded-sm bg-brand/60"
          style={{ height: `${Math.max(8, (point.spend / max) * 100)}%` }}
          title={`${point.date}: ${point.spend}`}
        />
      ))}
    </span>
  );
}

export function CreativePerformancePage() {
  const { t, lang } = useI18n();
  const { current, currentId } = useRestaurant();

  const [days, setDays] = useState(30);
  const [verdict, setVerdict] = useState<'' | Verdict>('');
  const [sort, setSort] = useState<SortKey>('spend');

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [days]);

  const { data, loading, error, refetch } = useQuery<Response>(
    `/analytics/creatives${qs({ ...range, clientId: currentId })}`,
    [range.from, range.to, currentId],
  );

  const rows = useMemo(() => {
    const filtered = (data?.items ?? []).filter((row) => !verdict || row.verdict === verdict);
    return [...filtered].sort((a, b) => {
      // Nulls sort last: an unmeasurable ratio is not a low one.
      const pick = (row: PerformanceRow) =>
        sort === 'spend' ? row.totals.spend
          : sort === 'conversions' ? row.totals.conversions
            : sort === 'ctr' ? row.totals.ctr
              : row.totals.roas;
      const left = pick(a);
      const right = pick(b);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    });
  }, [data, verdict, sort]);

  return (
    <>
      <PageHeader
        title={t('nav.creativePerformance')}
        subtitle={
          current
            ? `Which of ${current.businessName}'s ads earned their money, over the last ${days} days.`
            : `Which ads earned their money, over the last ${days} days.`
        }
        action={
          <>
            <Select value={verdict} onChange={(event) => setVerdict(event.target.value as Verdict | '')} className="w-44">
              <option value="">{t('common.all')}</option>
              <option value="WINNER">Winners</option>
              <option value="GOOD">Good</option>
              <option value="AVERAGE">Average</option>
              <option value="WEAK">Weak</option>
              <option value="INSUFFICIENT_DATA">Not enough data</option>
            </Select>
            <Select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="w-40">
              <option value="spend">Sort by spend</option>
              <option value="ctr">Sort by CTR</option>
              <option value="conversions">Sort by conversions</option>
              <option value="roas">Sort by ROAS</option>
            </Select>
            <Select value={days} onChange={(event) => setDays(Number(event.target.value))} className="w-36">
              {[7, 30, 90].map((value) => <option key={value} value={value}>Last {value} days</option>)}
            </Select>
          </>
        }
      />

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <CardSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={ImageIcon}
            title={data?.items.length === 0 ? 'No creative measurements yet' : 'Nothing matches this filter'}
            body={data?.provenance ?? ''}
          />
        </Card>
      ) : (
        <>
          {/* The bar every verdict is measured against, stated up front. */}
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
              <span className="flex items-center gap-1.5 text-muted">
                <Filter className="h-3.5 w-3.5" />
                Judged against this account: CTR {pct(data?.baseline.ctr)} · ROAS {ratio(data?.baseline.roas)}
              </span>
              <span className="text-muted">
                A verdict needs {num(data?.thresholds.minImpressions, lang)} impressions,{' '}
                {data?.thresholds.minClicks} clicks and {money(data?.thresholds.minSpend, lang)} of spend.
              </span>
            </div>
          </Card>

          <Card>
            <CardHeader title={t('nav.creativePerformance')} subtitle={data?.provenance} icon={Award} />
            <TableWrap>
              <thead>
                <tr>
                  <Th>Creative</Th>
                  <Th>Verdict</Th>
                  <Th align="end">{t('kpi.spend')}</Th>
                  <Th align="end">{t('kpi.impressions')}</Th>
                  <Th align="end">{t('kpi.ctr')}</Th>
                  <Th align="end">{t('kpi.cpc')}</Th>
                  <Th align="end">{t('kpi.conversions')}</Th>
                  <Th align="end">{t('kpi.cpa')}</Th>
                  <Th align="end">{t('kpi.roas')}</Th>
                  <Th>Trend</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.creativeId} className="align-top">
                    <Td>
                      <span className="flex items-start gap-2.5">
                        {row.creative ? (
                          <img
                            src={row.creative.url}
                            alt=""
                            className="h-12 w-12 shrink-0 rounded-lg bg-elevated object-cover ring-1 ring-line"
                          />
                        ) : null}
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-fg">
                            {row.creative?.headline ?? row.creative?.preset.replace(/_/g, ' ').toLowerCase() ?? 'Creative'}
                          </span>
                          <span className="block text-[11px] text-muted">
                            {row.creative ? `${row.creative.width}×${row.creative.height}` : ''} · {row.days} day(s)
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1">
                            {row.platform ? <PlatformChip platform={row.platform} size="sm" /> : null}
                            {row.creative?.source === 'UPLOADED' ? <Badge tone="brand">uploaded</Badge> : null}
                          </span>
                          {/* A creative may run in several campaigns; all of them are named. */}
                          {row.campaigns.length > 0 ? (
                            <span className="mt-1 block text-[11px] text-muted">
                              {row.campaigns.map((campaign) => campaign.name).join(' · ')}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={VERDICT_TONE[row.verdict]} dot>
                        {row.verdict.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      {/* The evidence, never "CTR is good". */}
                      <span className="mt-1 block max-w-[22rem] text-[11px] leading-snug text-muted">
                        {row.verdictReason}
                      </span>
                    </Td>
                    <Td align="end"><span className="tabular">{money(row.totals.spend, lang)} {row.currency}</span></Td>
                    <Td align="end"><span className="tabular">{num(row.totals.impressions, lang, true)}</span></Td>
                    <Td align="end">
                      <span className={cn('tabular', row.totals.ctr === null && 'text-muted')} title={row.totals.reasons?.ctr}>
                        {pct(row.totals.ctr)}
                      </span>
                    </Td>
                    <Td align="end">
                      <span className={cn('tabular', row.totals.cpc === null && 'text-muted')} title={row.totals.reasons?.cpc}>
                        {money(row.totals.cpc, lang)}
                      </span>
                    </Td>
                    <Td align="end"><span className="tabular">{num(row.totals.conversions, lang)}</span></Td>
                    <Td align="end">
                      <span className={cn('tabular', row.totals.cpa === null && 'text-muted')} title={row.totals.reasons?.cpa}>
                        {money(row.totals.cpa, lang)}
                      </span>
                    </Td>
                    <Td align="end">
                      <span
                        className={cn(
                          'tabular inline-flex items-center gap-1',
                          row.totals.roas === null ? 'text-muted' : row.totals.roas >= 1 ? 'text-ok' : 'text-danger',
                        )}
                        title={row.totals.reasons?.roas}
                      >
                        {row.totals.roas !== null ? (
                          row.totals.roas >= 1 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />
                        ) : null}
                        {ratio(row.totals.roas)}
                      </span>
                    </Td>
                    <Td><Spark points={row.trend} /></Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        </>
      )}
    </>
  );
}
