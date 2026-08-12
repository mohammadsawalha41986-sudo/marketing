import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sumRows, totalsByChannel, totalsByWeek, asOfDate, quarterProgress, paceStatus,
  goalPacing, channelScorecard, funnel, requiredRunRate, trend, withinQuarter,
} from '../src/metrics.js';

const QUARTER = { id: '2026-Q3', start: '2026-07-01', end: '2026-09-30' };

const CHANNELS = [
  { id: 'a', name: 'Channel A', owner: 'x', budgetUsd: 10000, targets: { mqls: 100, pipelineUsd: 200000 } },
  { id: 'b', name: 'Channel B', owner: 'y', budgetUsd: 20000, targets: { mqls: 200, pipelineUsd: 400000 } },
];

const row = (weekStart, channel, over = {}) => ({
  weekStart, channel, spendUsd: 1000, visits: 5000, mqls: 10, sqls: 3, wins: 1, pipelineUsd: 20000, ...over,
});

const METRICS = [
  row('2026-07-06', 'a'),
  row('2026-07-06', 'b', { spendUsd: 2000, mqls: 20, pipelineUsd: 30000 }),
  row('2026-07-13', 'a', { mqls: 12, pipelineUsd: 25000 }),
  row('2026-07-13', 'b', { spendUsd: 2500, mqls: 18, pipelineUsd: 28000 }),
];

test('sumRows adds every measure and ignores nothing', () => {
  const totals = sumRows(METRICS);
  assert.equal(totals.spendUsd, 6500);
  assert.equal(totals.mqls, 60);
  assert.equal(totals.pipelineUsd, 103000);
  assert.equal(totals.wins, 4);
});

test('sumRows of an empty list is all zeroes, not NaN', () => {
  assert.deepEqual(sumRows([]), { spendUsd: 0, visits: 0, mqls: 0, sqls: 0, wins: 0, pipelineUsd: 0 });
});

test('totalsByChannel includes channels that have not reported yet', () => {
  const byChannel = totalsByChannel([...CHANNELS, { id: 'c', targets: {} }], METRICS);
  assert.equal(byChannel.a.mqls, 22);
  assert.equal(byChannel.b.mqls, 38);
  assert.equal(byChannel.c.mqls, 0, 'a silent channel reads zero rather than disappearing');
});

test('totalsByWeek rolls channels up and sorts oldest first', () => {
  const weeks = totalsByWeek(METRICS);
  assert.deepEqual(weeks.map((w) => w.weekStart), ['2026-07-06', '2026-07-13']);
  assert.equal(weeks[0].mqls, 30);
  assert.equal(weeks[1].mqls, 30);
});

test('asOfDate is the Sunday closing the latest week', () => {
  assert.equal(asOfDate(METRICS, '2026-07-01'), '2026-07-19');
  assert.equal(asOfDate([], '2026-07-01'), '2026-07-01', 'falls back when there is no data');
});

test('quarterProgress counts inclusive days and clamps to the quarter', () => {
  assert.equal(quarterProgress(QUARTER, '2026-09-30').daysTotal, 92);
  assert.equal(quarterProgress(QUARTER, '2026-07-01').daysElapsed, 1);
  assert.equal(quarterProgress(QUARTER, '2026-08-09').daysElapsed, 40);
  assert.equal(quarterProgress(QUARTER, '2026-12-31').daysElapsed, 92, 'past the end clamps to full');
  assert.equal(quarterProgress(QUARTER, '2026-01-01').daysElapsed, 0, 'before the start clamps to zero');
  assert.equal(quarterProgress(QUARTER, '2026-09-30').daysRemaining, 0);
});

test('paceStatus bands actual against expected', () => {
  assert.equal(paceStatus(110, 100), 'ahead');
  assert.equal(paceStatus(100, 100), 'on-track');
  assert.equal(paceStatus(96, 100), 'on-track');
  assert.equal(paceStatus(90, 100), 'at-risk');
  assert.equal(paceStatus(70, 100), 'behind');
  assert.equal(paceStatus(0, 0), 'on-track', 'no target cannot be missed');
});

test('goalPacing straight-lines the target across the quarter', () => {
  const totals = { pipelineUsd: 100000, mqls: 50, sqls: 10, wins: 2, spendUsd: 0, visits: 0 };
  const pacing = goalPacing({ pipelineUsd: 400000, mqls: 200, sqls: 40, wins: 8 }, totals, 0.5);
  const pipeline = pacing.find((p) => p.key === 'pipelineUsd');
  assert.equal(pipeline.expected, 200000);
  assert.equal(pipeline.index, 0.5);
  assert.equal(pipeline.status, 'behind');
  assert.equal(pipeline.attainment, 0.25);
});

test('channelScorecard sorts by pipeline and computes efficiency', () => {
  const scorecard = channelScorecard(CHANNELS, METRICS, 0.5);
  assert.deepEqual(scorecard.map((c) => c.id), ['b', 'a']);

  const a = scorecard.find((c) => c.id === 'a');
  assert.equal(a.totals.spendUsd, 2000);
  assert.equal(a.costPerMqlUsd, 2000 / 22);
  assert.equal(a.pipelineRoi, 45000 / 2000);
  assert.equal(a.budgetUsedRatio, 0.2);
});

test('funnel returns null rather than dividing by zero', () => {
  const rates = funnel({ spendUsd: 0, visits: 0, mqls: 0, sqls: 0, wins: 0, pipelineUsd: 0 });
  assert.equal(rates.visitToMql, null);
  assert.equal(rates.cacUsd, null);
  assert.equal(rates.pipelineRoi, null);
});

test('funnel computes stage conversion', () => {
  const rates = funnel({ spendUsd: 10000, visits: 10000, mqls: 100, sqls: 25, wins: 5, pipelineUsd: 50000 });
  assert.equal(rates.visitToMql, 0.01);
  assert.equal(rates.mqlToSql, 0.25);
  assert.equal(rates.sqlToWin, 0.2);
  assert.equal(rates.cacUsd, 2000);
  assert.equal(rates.pipelineRoi, 5);
});

test('requiredRunRate spreads the remaining gap over the weeks left', () => {
  const progress = quarterProgress(QUARTER, '2026-08-09');
  const runRate = requiredRunRate({ pipelineUsd: 400000, mqls: 200, sqls: 40, wins: 8 }, sumRows(METRICS), progress);
  assert.equal(runRate.weeksRemaining, progress.daysRemaining / 7);
  assert.ok(runRate.pipelineUsdPerWeek > 0);

  const remainingPipeline = 400000 - 103000;
  assert.equal(runRate.pipelineUsdPerWeek, remainingPipeline / runRate.weeksRemaining);
});

test('requiredRunRate never asks for negative work, and stops at quarter end', () => {
  const progress = quarterProgress(QUARTER, '2026-08-09');
  const overshot = requiredRunRate({ pipelineUsd: 1, mqls: 1, sqls: 1, wins: 1 }, sumRows(METRICS), progress);
  assert.equal(overshot.pipelineUsdPerWeek, 0);
  assert.equal(requiredRunRate({}, sumRows(METRICS), quarterProgress(QUARTER, '2026-09-30')), null);
});

test('trend reports week-over-week change with no baseline on the first week', () => {
  const points = trend(METRICS, 'pipelineUsd');
  assert.equal(points[0].change, null);
  assert.equal(points[1].value, 53000);
  assert.equal(points[1].change, 53000 / 50000 - 1);
});

test('withinQuarter drops rows outside the window', () => {
  const rows = [...METRICS, row('2026-06-29', 'a'), row('2026-10-05', 'a')];
  assert.equal(withinQuarter(rows, QUARTER).length, METRICS.length);
});
