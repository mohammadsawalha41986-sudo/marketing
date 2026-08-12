/** Generates the weekly markdown report that the Monday review runs from. */

import { personName, campaignName } from './data.js';
import { addDays, daysBetween } from './dates.js';
import {
  asOfDate, quarterProgress, sumRows, withinQuarter, goalPacing,
  channelScorecard, funnel, requiredRunRate, totalsByWeek,
} from './metrics.js';
import { overdue, upcoming, workload, statusCounts, gaps } from './calendar.js';
import { usd, num, pct, delta, STATUS_LABEL } from './format.js';

const MARKER = { ahead: '▲', 'on-track': '●', 'at-risk': '▽', behind: '▼' };

function mdTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function goalSection(pacing) {
  return mdTable(
    ['Goal', 'Actual', 'Expected to date', 'Quarter target', 'vs plan', 'Status'],
    pacing.map((row) => {
      const format = row.key === 'pipelineUsd' ? (v) => usd(v, { compact: true }) : num;
      return [
        row.label,
        format(row.actual),
        format(row.expected),
        format(row.target),
        delta(row.index - 1),
        `${MARKER[row.status]} ${STATUS_LABEL[row.status]}`,
      ];
    }),
  );
}

function channelSection(scorecard) {
  return mdTable(
    ['Channel', 'Spend', 'MQLs', 'MQL vs plan', 'Pipeline', 'Pipeline vs plan', 'Cost/MQL', 'ROI', 'Status'],
    scorecard.map((row) => [
      row.name,
      usd(row.totals.spendUsd, { compact: true }),
      num(row.totals.mqls),
      delta(row.mqls.index - 1),
      usd(row.totals.pipelineUsd, { compact: true }),
      delta(row.pipeline.index - 1),
      usd(row.costPerMqlUsd),
      row.pipelineRoi === null ? '—' : `${row.pipelineRoi.toFixed(1)}x`,
      `${MARKER[row.status]} ${STATUS_LABEL[row.status]}`,
    ]),
  );
}

function funnelSection(rates, totals) {
  return mdTable(
    ['Stage', 'Volume', 'Conversion'],
    [
      ['Visits', num(totals.visits), '—'],
      ['MQLs', num(totals.mqls), pct(rates.visitToMql, { digits: 2 })],
      ['SQLs', num(totals.sqls), pct(rates.mqlToSql)],
      ['Wins', num(totals.wins), pct(rates.sqlToWin)],
    ],
  );
}

function calendarSection(db, today) {
  const late = overdue(db.content, today);
  const next = upcoming(db.content, today, 14);
  const lines = [];

  lines.push('### Late', '');
  lines.push(
    late.length === 0
      ? '_Nothing late._'
      : mdTable(
          ['Item', 'Owner', 'Due', 'Days late', 'Status'],
          late.map((item) => [item.title, personName(db, item.owner), item.publishDate, item.daysLate, item.status]),
        ),
  );

  lines.push('', '### Publishing in the next 14 days', '');
  lines.push(
    next.length === 0
      ? '_Nothing scheduled. That is a gap, not a break._'
      : mdTable(
          ['Date', 'Item', 'Type', 'Campaign', 'Owner', 'Status'],
          next.map((item) => [
            item.publishDate,
            item.title,
            item.type,
            campaignName(db, item.campaign),
            personName(db, item.owner),
            item.status,
          ]),
        ),
  );

  const quiet = gaps(db.content, today, 6);
  if (quiet.length > 0) {
    lines.push('', `**Weeks with nothing publishing:** ${quiet.join(', ')}`);
  }
  return lines.join('\n');
}

function callouts(pacing, scorecard, late, runRate) {
  const lines = [];
  const behind = pacing.filter((row) => row.status === 'behind' || row.status === 'at-risk');
  for (const row of behind) {
    const format = row.key === 'pipelineUsd' ? (v) => usd(v, { compact: true }) : num;
    lines.push(
      `- **${row.label} — ${STATUS_LABEL[row.status].toLowerCase()}** at ${format(row.actual)} against ${format(row.expected)} expected by now (${delta(row.index - 1)}).`,
    );
  }
  for (const channel of scorecard.filter((row) => row.status === 'behind')) {
    lines.push(
      `- **${channel.name} — behind on pipeline** at ${usd(channel.totals.pipelineUsd, { compact: true })} against ${usd(channel.pipeline.expected, { compact: true })} expected, on ${pct(channel.budgetUsedRatio, { digits: 0 })} of its budget.`,
    );
  }
  if (late.length > 0) {
    lines.push(`- **${late.length} content ${late.length === 1 ? 'item is' : 'items are'} late**, the oldest by ${late[0].daysLate} days.`);
  }
  if (runRate) {
    lines.push(
      `- **To land the quarter**, the remaining ${runRate.weeksRemaining.toFixed(1)} weeks need ${usd(runRate.pipelineUsdPerWeek, { compact: true })} of pipeline and ${Math.ceil(runRate.mqlsPerWeek)} MQLs per week.`,
    );
  }
  return lines.length === 0 ? '_Everything is on plan._' : lines.join('\n');
}

/**
 * Build the weekly report. `asOf` defaults to the last day the metrics cover,
 * so the report never claims coverage the data does not have.
 */
export function buildWeeklyReport(db, { asOf, today } = {}) {
  const { quarter, goals, company } = db.config;
  const metrics = withinQuarter(db.metrics, quarter);
  const reportAsOf = asOf ?? asOfDate(metrics, quarter.start);
  const reportToday = today ?? reportAsOf;

  const progress = quarterProgress(quarter, reportAsOf);
  const totals = sumRows(metrics);
  const pacing = goalPacing(goals, totals, progress.ratio);
  const scorecard = channelScorecard(db.channels, metrics, progress.ratio);
  const rates = funnel(totals);
  const runRate = requiredRunRate(goals, totals, progress);
  const late = overdue(db.content, reportToday);
  const weeks = totalsByWeek(metrics);
  const lastWeek = weeks.at(-1);
  const priorWeek = weeks.at(-2);

  const sections = [];
  sections.push(`# ${company.name} weekly marketing report`);
  sections.push('');
  sections.push(
    `**Quarter:** ${quarter.id} (${quarter.start} to ${quarter.end}) · **Data through:** ${reportAsOf} · ` +
      `**Elapsed:** day ${progress.daysElapsed} of ${progress.daysTotal} (${pct(progress.ratio, { digits: 0 })})`,
  );
  sections.push('');

  sections.push('## Where we stand', '');
  sections.push(goalSection(pacing), '');

  sections.push('## What needs a decision', '');
  sections.push(callouts(pacing, scorecard, late, runRate), '');

  if (lastWeek) {
    const change = (measure) =>
      priorWeek && priorWeek[measure] !== 0 ? delta(lastWeek[measure] / priorWeek[measure] - 1) : '—';
    sections.push(`## Last week (${lastWeek.weekStart} to ${addDays(lastWeek.weekStart, 6)})`, '');
    sections.push(
      mdTable(
        ['Measure', 'Last week', 'Week before', 'Change'],
        [
          ['Spend', usd(lastWeek.spendUsd), priorWeek ? usd(priorWeek.spendUsd) : '—', change('spendUsd')],
          ['MQLs', num(lastWeek.mqls), priorWeek ? num(priorWeek.mqls) : '—', change('mqls')],
          ['SQLs', num(lastWeek.sqls), priorWeek ? num(priorWeek.sqls) : '—', change('sqls')],
          ['Wins', num(lastWeek.wins), priorWeek ? num(priorWeek.wins) : '—', change('wins')],
          [
            'Pipeline',
            usd(lastWeek.pipelineUsd),
            priorWeek ? usd(priorWeek.pipelineUsd) : '—',
            change('pipelineUsd'),
          ],
        ],
      ),
      '',
    );
  }

  sections.push('## Channels', '');
  sections.push(channelSection(scorecard), '');
  sections.push(
    `Blended: ${usd(totals.spendUsd, { compact: true })} spent of ${usd(goals.budgetUsd, { compact: true })} ` +
      `(${pct(totals.spendUsd / goals.budgetUsd, { digits: 0 })}), ` +
      `cost per MQL ${usd(rates.costPerMqlUsd)}, CAC ${usd(rates.cacUsd)}, ` +
      `pipeline ROI ${rates.pipelineRoi === null ? '—' : `${rates.pipelineRoi.toFixed(1)}x`}.`,
    '',
  );

  sections.push('## Funnel', '');
  sections.push(funnelSection(rates, totals), '');

  sections.push('## Content calendar', '');
  sections.push(calendarSection(db, reportToday), '');

  const load = workload(db.content, reportToday);
  sections.push('## Load by owner', '');
  sections.push(
    mdTable(
      ['Owner', 'Open', 'Late', 'Published', 'Total'],
      load.map((row) => [personName(db, row.owner), row.open, row.late, row.published, row.total]),
    ),
    '',
  );

  const counts = statusCounts(db.content);
  sections.push(
    `Pipeline of work: ${Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')}.`,
    '',
  );

  sections.push('---', '');
  sections.push(`_Generated by \`mos report\` from \`data/\`. Days remaining in quarter: ${progress.daysRemaining}._`);

  return sections.join('\n');
}

/** Suggested filename for a report, keyed to the week it covers. */
export function reportFilename(asOf) {
  return `weekly-${asOf}.md`;
}

export { daysBetween };
