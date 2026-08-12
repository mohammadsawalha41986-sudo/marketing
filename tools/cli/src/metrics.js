/**
 * Funnel maths and pacing.
 *
 * Pacing is deliberately naive: it assumes a target accrues evenly across the
 * quarter and compares that straight line against actuals. That is wrong for
 * lumpy channels like events, which is exactly why the channel scorecard shows
 * every channel rather than a single blended number.
 */

import { daysBetween, addDays, parseDate } from './dates.js';

const MEASURES = ['spendUsd', 'visits', 'mqls', 'sqls', 'wins', 'pipelineUsd'];

export function emptyTotals() {
  return Object.fromEntries(MEASURES.map((measure) => [measure, 0]));
}

export function sumRows(rows) {
  const totals = emptyTotals();
  for (const row of rows) {
    for (const measure of MEASURES) totals[measure] += row[measure] ?? 0;
  }
  return totals;
}

/** `{ [channelId]: totals }`, including channels with no rows yet. */
export function totalsByChannel(channels, metrics) {
  const byChannel = Object.fromEntries(channels.map((channel) => [channel.id, emptyTotals()]));
  for (const row of metrics) {
    const totals = (byChannel[row.channel] ??= emptyTotals());
    for (const measure of MEASURES) totals[measure] += row[measure] ?? 0;
  }
  return byChannel;
}

/** `[{ weekStart, ...totals }]`, oldest first. */
export function totalsByWeek(metrics) {
  const weeks = new Map();
  for (const row of metrics) {
    const totals = weeks.get(row.weekStart) ?? { weekStart: row.weekStart, ...emptyTotals() };
    for (const measure of MEASURES) totals[measure] += row[measure] ?? 0;
    weeks.set(row.weekStart, totals);
  }
  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** The last day covered by the metrics: the Sunday of the most recent week. */
export function asOfDate(metrics, fallback) {
  if (metrics.length === 0) return fallback;
  const latest = metrics.reduce((max, row) => (row.weekStart > max ? row.weekStart : max), metrics[0].weekStart);
  return addDays(latest, 6);
}

/** How far through the quarter `asOf` sits, clamped to the quarter's bounds. */
export function quarterProgress(quarter, asOf) {
  const daysTotal = daysBetween(quarter.start, quarter.end) + 1;
  const raw = daysBetween(quarter.start, asOf) + 1;
  const daysElapsed = Math.min(Math.max(raw, 0), daysTotal);
  return {
    daysTotal,
    daysElapsed,
    daysRemaining: daysTotal - daysElapsed,
    ratio: daysTotal === 0 ? 0 : daysElapsed / daysTotal,
  };
}

export function paceStatus(actual, expected) {
  if (expected <= 0) return 'on-track';
  const index = actual / expected;
  if (index >= 1.05) return 'ahead';
  if (index >= 0.95) return 'on-track';
  if (index >= 0.85) return 'at-risk';
  return 'behind';
}

function pacingRow(label, key, actual, target, ratio) {
  const expected = target * ratio;
  return {
    label,
    key,
    actual,
    target,
    expected: Math.round(expected),
    attainment: target === 0 ? 0 : actual / target,
    index: expected === 0 ? 1 : actual / expected,
    status: paceStatus(actual, expected),
  };
}

/** Quarter goals against actuals, straight-lined to `ratio`. */
export function goalPacing(goals, totals, ratio) {
  return [
    pacingRow('Pipeline', 'pipelineUsd', totals.pipelineUsd, goals.pipelineUsd ?? 0, ratio),
    pacingRow('MQLs', 'mqls', totals.mqls, goals.mqls ?? 0, ratio),
    pacingRow('SQLs', 'sqls', totals.sqls, goals.sqls ?? 0, ratio),
    pacingRow('Wins', 'wins', totals.wins, goals.wins ?? 0, ratio),
  ];
}

/** Per-channel pacing plus the efficiency numbers that decide reallocation. */
export function channelScorecard(channels, metrics, ratio) {
  const byChannel = totalsByChannel(channels, metrics);
  return channels
    .map((channel) => {
      const totals = byChannel[channel.id];
      const mqls = pacingRow('MQLs', 'mqls', totals.mqls, channel.targets.mqls, ratio);
      const pipeline = pacingRow('Pipeline', 'pipelineUsd', totals.pipelineUsd, channel.targets.pipelineUsd, ratio);
      return {
        id: channel.id,
        name: channel.name,
        owner: channel.owner,
        totals,
        budgetUsd: channel.budgetUsd,
        budgetUsedRatio: channel.budgetUsd === 0 ? 0 : totals.spendUsd / channel.budgetUsd,
        mqls,
        pipeline,
        costPerMqlUsd: totals.mqls === 0 ? null : totals.spendUsd / totals.mqls,
        pipelineRoi: totals.spendUsd === 0 ? null : totals.pipelineUsd / totals.spendUsd,
        status: pipeline.status,
      };
    })
    .sort((a, b) => b.totals.pipelineUsd - a.totals.pipelineUsd);
}

/** Stage-to-stage conversion and blended efficiency. */
export function funnel(totals) {
  const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
  return {
    visitToMql: rate(totals.mqls, totals.visits),
    mqlToSql: rate(totals.sqls, totals.mqls),
    sqlToWin: rate(totals.wins, totals.sqls),
    costPerMqlUsd: rate(totals.spendUsd, totals.mqls),
    cacUsd: rate(totals.spendUsd, totals.wins),
    pipelineRoi: rate(totals.pipelineUsd, totals.spendUsd),
    pipelinePerWinUsd: rate(totals.pipelineUsd, totals.wins),
  };
}

/**
 * What the remaining weeks have to deliver to land the quarter on target.
 * Returns null once the quarter is over, when there is nothing left to run.
 */
export function requiredRunRate(goals, totals, progress) {
  if (progress.daysRemaining <= 0) return null;
  const weeksRemaining = progress.daysRemaining / 7;
  const gap = (goal, actual) => Math.max((goals[goal] ?? 0) - actual, 0);
  return {
    weeksRemaining,
    pipelineUsdPerWeek: gap('pipelineUsd', totals.pipelineUsd) / weeksRemaining,
    mqlsPerWeek: gap('mqls', totals.mqls) / weeksRemaining,
    sqlsPerWeek: gap('sqls', totals.sqls) / weeksRemaining,
    winsPerWeek: gap('wins', totals.wins) / weeksRemaining,
  };
}

/** Week-over-week change for a single measure, oldest first. */
export function trend(metrics, measure) {
  const weeks = totalsByWeek(metrics);
  return weeks.map((week, i) => {
    const previous = i === 0 ? null : weeks[i - 1][measure];
    return {
      weekStart: week.weekStart,
      value: week[measure],
      change: previous === null || previous === 0 ? null : week[measure] / previous - 1,
    };
  });
}

/** Metrics limited to the quarter window, so a rollover cannot skew totals. */
export function withinQuarter(metrics, quarter) {
  const start = parseDate(quarter.start).getTime();
  const end = parseDate(quarter.end).getTime();
  return metrics.filter((row) => {
    const rowTime = parseDate(row.weekStart).getTime();
    return rowTime >= start && rowTime <= end;
  });
}

export { MEASURES };
