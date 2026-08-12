/**
 * Builds a single self-contained HTML dashboard from the dataset.
 *
 * No build step, no dependencies, no network: everything — styles, charts,
 * numbers — is written into one file that opens from disk. Charts are inline
 * SVG generated here rather than in the browser, so the page needs no script.
 */

import { personName, campaignName } from './data.js';
import { addDays } from './dates.js';
import {
  asOfDate, quarterProgress, sumRows, withinQuarter, goalPacing,
  channelScorecard, funnel, requiredRunRate, totalsByWeek,
} from './metrics.js';
import { overdue, upcoming, workload } from './calendar.js';
import { usd, num, pct, delta, STATUS_LABEL } from './format.js';

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --border: #dfe3e8;
  --text: #16191d;
  --muted: #5c6672;
  --accent: #2f5fd0;
  --grid: #e6e9ee;
  --ahead: #147d64;
  --on-track: #2f5fd0;
  --at-risk: #9a6100;
  --behind: #b3261e;
  --ahead-bg: #e2f3ed;
  --on-track-bg: #e6ecfb;
  --at-risk-bg: #fbf0dc;
  --behind-bg: #fbe6e4;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #101317;
    --surface: #181c22;
    --surface-2: #1f242b;
    --border: #2c333c;
    --text: #e8ebef;
    --muted: #98a2b0;
    --accent: #7ba2f5;
    --grid: #262c34;
    --ahead: #4cc3a1;
    --on-track: #7ba2f5;
    --at-risk: #e0a94a;
    --behind: #f28b82;
    --ahead-bg: #17342c;
    --on-track-bg: #1b2740;
    --at-risk-bg: #362a14;
    --behind-bg: #3a2220;
  }
}
:root[data-theme="dark"] {
  --bg: #101317;
  --surface: #181c22;
  --surface-2: #1f242b;
  --border: #2c333c;
  --text: #e8ebef;
  --muted: #98a2b0;
  --accent: #7ba2f5;
  --grid: #262c34;
  --ahead: #4cc3a1;
  --on-track: #7ba2f5;
  --at-risk: #e0a94a;
  --behind: #f28b82;
  --ahead-bg: #17342c;
  --on-track-bg: #1b2740;
  --at-risk-bg: #362a14;
  --behind-bg: #3a2220;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }

header.page { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 28px; }
header.page h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.015em; }
header.page .meta { color: var(--muted); font-size: 14px; }
header.page .meta span + span::before { content: "·"; margin: 0 8px; opacity: 0.6; }

h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 36px 0 12px; font-weight: 600; }
h2:first-of-type { margin-top: 0; }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.tile .label { color: var(--muted); font-size: 13px; }
.tile .value { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; margin: 4px 0 2px; font-variant-numeric: tabular-nums; }
.tile .sub { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

.pace { position: relative; height: 6px; border-radius: 3px; background: var(--surface-2); margin: 12px 0 8px; overflow: hidden; }
.pace i { display: block; height: 100%; border-radius: 3px; }
.pace u { position: absolute; top: -3px; width: 2px; height: 12px; background: var(--muted); opacity: 0.85; }

.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pill.ahead { color: var(--ahead); background: var(--ahead-bg); }
.pill.on-track { color: var(--on-track); background: var(--on-track-bg); }
.pill.at-risk { color: var(--at-risk); background: var(--at-risk-bg); }
.pill.behind { color: var(--behind); background: var(--behind-bg); }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; min-width: 640px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
td.wide { white-space: normal; min-width: 260px; }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 10px 0 0; }
.pos { color: var(--ahead); }
.neg { color: var(--behind); }

.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; align-items: start; }
.chart { width: 100%; height: auto; display: block; }

ul.callouts { margin: 0; padding-left: 18px; }
ul.callouts li { margin-bottom: 8px; }
ul.callouts li:last-child { margin-bottom: 0; }

footer.page { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 13px; }
`;

function paceBar(actual, expected, target, status) {
  const scale = Math.max(target, actual, 1);
  const fill = Math.min((actual / scale) * 100, 100);
  const mark = Math.min((expected / scale) * 100, 100);
  return (
    `<div class="pace"><i style="width:${fill.toFixed(1)}%;background:var(--${status})"></i>` +
    `<u style="left:${mark.toFixed(1)}%"></u></div>`
  );
}

function pill(status) {
  return `<span class="pill ${status}">${STATUS_LABEL[status]}</span>`;
}

function signed(value) {
  const text = delta(value);
  if (text === '—') return '<span class="muted">—</span>';
  return `<span class="${value >= 0 ? 'pos' : 'neg'}">${text}</span>`;
}

function goalTiles(pacing, progress) {
  const tiles = pacing.map((row) => {
    const format = row.key === 'pipelineUsd' ? (v) => usd(v, { compact: true }) : num;
    return `
      <div class="tile">
        <div class="label">${esc(row.label)}</div>
        <div class="value">${format(row.actual)}</div>
        ${paceBar(row.actual, row.expected, row.target, row.status)}
        <div class="sub">${format(row.expected)} expected · ${format(row.target)} target · ${signed(row.index - 1)}</div>
        <div style="margin-top:8px">${pill(row.status)}</div>
      </div>`;
  });
  tiles.push(`
      <div class="tile">
        <div class="label">Quarter elapsed</div>
        <div class="value">${pct(progress.ratio, { digits: 0 })}</div>
        <div class="pace"><i style="width:${(progress.ratio * 100).toFixed(1)}%;background:var(--accent)"></i></div>
        <div class="sub">Day ${progress.daysElapsed} of ${progress.daysTotal} · ${progress.daysRemaining} left</div>
      </div>`);
  return `<div class="tiles">${tiles.join('')}</div>`;
}

/** Weekly pipeline columns with a dashed line at the pace a target implies. */
function weeklyChart(weeks, goals, progress) {
  if (weeks.length === 0) return '<p class="muted">No weekly metrics yet.</p>';

  const W = 720;
  const H = 272;
  const pad = { top: 34, right: 12, bottom: 34, left: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const weeklyTarget = goals.pipelineUsd / (progress.daysTotal / 7);
  const max = Math.max(...weeks.map((week) => week.pipelineUsd), weeklyTarget) * 1.15;
  const y = (value) => pad.top + plotH - (value / max) * plotH;
  const slot = plotW / weeks.length;
  const barW = Math.min(slot * 0.6, 54);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((step) => {
    const value = max * step;
    return (
      `<line x1="${pad.left}" y1="${y(value).toFixed(1)}" x2="${W - pad.right}" y2="${y(value).toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>` +
      `<text x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${usd(value, { compact: true })}</text>`
    );
  });

  const bars = weeks.map((week, i) => {
    const x = pad.left + slot * i + (slot - barW) / 2;
    const top = y(week.pipelineUsd);
    const color = week.pipelineUsd >= weeklyTarget ? 'var(--ahead)' : 'var(--at-risk)';
    return (
      `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${(pad.top + plotH - top).toFixed(1)}" rx="3" fill="${color}"><title>${esc(week.weekStart)}: ${usd(week.pipelineUsd)}</title></rect>` +
      `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(week.weekStart.slice(5))}</text>`
    );
  });

  const targetY = y(weeklyTarget).toFixed(1);
  // The annotation sits in the top margin rather than on the line, where it
  // would collide with the line itself and with any bar that clears it.
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pipeline created per week against the weekly pace the quarter target implies">
      ${ticks.join('')}
      ${bars.join('')}
      <line x1="${pad.left}" y1="${targetY}" x2="${W - pad.right}" y2="${targetY}" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.7"/>
      <line x1="${pad.left}" y1="14" x2="${pad.left + 22}" y2="14" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.7"/>
      <text x="${pad.left + 30}" y="18" font-size="11" fill="var(--muted)">Pace needed to hit the quarter target: ${usd(weeklyTarget, { compact: true })} per week</text>
    </svg>`;
}

/** Funnel as proportional bars — the width is the stage's share of visits. */
function funnelChart(totals, rates) {
  const stages = [
    { label: 'Visits', value: totals.visits, rate: null },
    { label: 'MQLs', value: totals.mqls, rate: rates.visitToMql },
    { label: 'SQLs', value: totals.sqls, rate: rates.mqlToSql },
    { label: 'Wins', value: totals.wins, rate: rates.sqlToWin },
  ];
  const W = 720;
  const rowH = 46;
  const H = stages.length * rowH + 12;
  const labelW = 70;
  const valueW = 150;
  const barMax = W - labelW - valueW - 16;
  // Log scale: a raw share would render wins as an invisible sliver.
  const scale = (value) => (value <= 0 ? 0 : Math.log10(value + 1) / Math.log10(totals.visits + 1));

  const rows = stages.map((stage, i) => {
    const yTop = i * rowH + 12;
    const width = Math.max(scale(stage.value) * barMax, 2);
    const conversion = stage.rate === null ? '' : ` · ${pct(stage.rate, { digits: stage.rate < 0.01 ? 2 : 1 })} from prior`;
    return `
      <text x="0" y="${yTop + 18}" font-size="13" fill="var(--muted)">${stage.label}</text>
      <rect x="${labelW}" y="${yTop}" width="${width.toFixed(1)}" height="26" rx="4" fill="var(--accent)" opacity="${(1 - i * 0.16).toFixed(2)}"/>
      <text x="${labelW + width + 10}" y="${yTop + 18}" font-size="13" fill="var(--text)">${num(stage.value)}<tspan fill="var(--muted)">${esc(conversion)}</tspan></text>`;
  });

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Funnel volumes and stage conversion rates, drawn on a log scale">
      ${rows.join('')}
    </svg>`;
}

function channelTable(scorecard) {
  const rows = scorecard.map(
    (row) => `
      <tr>
        <td>${esc(row.name)}</td>
        <td class="n">${usd(row.totals.spendUsd, { compact: true })}</td>
        <td class="n">${pct(row.budgetUsedRatio, { digits: 0 })}</td>
        <td class="n">${num(row.totals.mqls)}</td>
        <td class="n">${signed(row.mqls.index - 1)}</td>
        <td class="n">${usd(row.totals.pipelineUsd, { compact: true })}</td>
        <td class="n">${signed(row.pipeline.index - 1)}</td>
        <td class="n">${usd(row.costPerMqlUsd)}</td>
        <td class="n">${row.pipelineRoi === null ? '—' : `${row.pipelineRoi.toFixed(1)}x`}</td>
        <td>${pill(row.status)}</td>
      </tr>`,
  );
  return `
    <div class="card scroll">
      <table>
        <thead><tr>
          <th>Channel</th><th class="n">Spend</th><th class="n">Budget used</th>
          <th class="n">MQLs</th><th class="n">vs plan</th>
          <th class="n">Pipeline</th><th class="n">vs plan</th>
          <th class="n">Cost/MQL</th><th class="n">ROI</th><th>Pipeline pace</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

function calloutList(pacing, scorecard, late, runRate) {
  const items = [];
  for (const row of pacing.filter((r) => r.status === 'behind' || r.status === 'at-risk')) {
    const format = row.key === 'pipelineUsd' ? (v) => usd(v, { compact: true }) : num;
    items.push(
      `<strong>${esc(row.label)} ${STATUS_LABEL[row.status].toLowerCase()}</strong> — ${format(row.actual)} against ${format(row.expected)} expected by now (${delta(row.index - 1)}).`,
    );
  }
  for (const channel of scorecard.filter((row) => row.status === 'behind')) {
    items.push(
      `<strong>${esc(channel.name)} behind on pipeline</strong> — ${usd(channel.totals.pipelineUsd, { compact: true })} against ${usd(channel.pipeline.expected, { compact: true })} expected, on ${pct(channel.budgetUsedRatio, { digits: 0 })} of budget.`,
    );
  }
  if (late.length > 0) {
    items.push(
      `<strong>${late.length} content ${late.length === 1 ? 'item is' : 'items are'} late</strong> — oldest by ${late[0].daysLate} days (${esc(late[0].title)}).`,
    );
  }
  if (runRate) {
    items.push(
      `<strong>To land the quarter</strong> — the remaining ${runRate.weeksRemaining.toFixed(1)} weeks need ${usd(runRate.pipelineUsdPerWeek, { compact: true })} of pipeline and ${Math.ceil(runRate.mqlsPerWeek)} MQLs per week.`,
    );
  }
  if (items.length === 0) return '<div class="card"><p class="muted" style="margin:0">Everything is on plan.</p></div>';
  return `<div class="card"><ul class="callouts">${items.map((item) => `<li>${item}</li>`).join('')}</ul></div>`;
}

function calendarCard(db, late, next) {
  const lateRows =
    late.length === 0
      ? '<tr><td colspan="4" class="muted">Nothing late.</td></tr>'
      : late
          .map(
            (item) => `
        <tr>
          <td class="wide">${esc(item.title)}</td>
          <td>${esc(personName(db, item.owner))}</td>
          <td>${esc(item.publishDate)}</td>
          <td class="n neg">${item.daysLate}d</td>
        </tr>`,
          )
          .join('');

  const nextRows =
    next.length === 0
      ? '<tr><td colspan="5" class="muted">Nothing scheduled in the next 14 days.</td></tr>'
      : next
          .map(
            (item) => `
        <tr>
          <td>${esc(item.publishDate)}</td>
          <td class="wide">${esc(item.title)}</td>
          <td class="muted">${esc(item.type)}</td>
          <td class="muted">${esc(campaignName(db, item.campaign))}</td>
          <td>${esc(personName(db, item.owner))}</td>
        </tr>`,
          )
          .join('');

  return `
    <div class="card scroll">
      <table>
        <thead><tr><th>Late</th><th>Owner</th><th>Due</th><th class="n">Late by</th></tr></thead>
        <tbody>${lateRows}</tbody>
      </table>
    </div>
    <div class="card scroll" style="margin-top:14px">
      <table>
        <thead><tr><th>Date</th><th>Publishing next 14 days</th><th>Type</th><th>Campaign</th><th>Owner</th></tr></thead>
        <tbody>${nextRows}</tbody>
      </table>
    </div>`;
}

function campaignTable(db, today) {
  const order = { active: 0, planned: 1, paused: 2, completed: 3, cancelled: 4 };
  const rows = [...db.campaigns]
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.start.localeCompare(b.start))
    .map((campaign) => {
      const live = campaign.start <= today && today <= campaign.end;
      return `
        <tr>
          <td class="wide">${esc(campaign.name)}${live ? ' <span class="pill on-track">Live</span>' : ''}</td>
          <td class="muted">${esc(campaign.status)}</td>
          <td>${esc(personName(db, campaign.owner))}</td>
          <td class="muted">${esc(campaign.start)} → ${esc(campaign.end)}</td>
          <td class="n">${usd(campaign.budgetUsd, { compact: true })}</td>
          <td class="n">${num(campaign.targets?.mqls)}</td>
          <td class="n">${usd(campaign.targets?.pipelineUsd, { compact: true })}</td>
        </tr>`;
    });
  return `
    <div class="card scroll">
      <table>
        <thead><tr>
          <th>Campaign</th><th>Status</th><th>Owner</th><th>Window</th>
          <th class="n">Budget</th><th class="n">Target MQLs</th><th class="n">Target pipeline</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

function workloadTable(db, load) {
  const rows = load.map(
    (row) => `
      <tr>
        <td>${esc(personName(db, row.owner))}</td>
        <td class="n">${row.open}</td>
        <td class="n">${row.late > 0 ? `<span class="neg">${row.late}</span>` : '0'}</td>
        <td class="n">${row.published}</td>
        <td class="n">${row.total}</td>
      </tr>`,
  );
  return `
    <div class="card scroll">
      <table>
        <thead><tr><th>Owner</th><th class="n">Open</th><th class="n">Late</th><th class="n">Published</th><th class="n">Total</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

/** Render the dashboard. Returns a complete HTML document as a string. */
export function buildDashboard(db, { asOf, today } = {}) {
  const { quarter, goals, company } = db.config;
  const metrics = withinQuarter(db.metrics, quarter);
  const viewAsOf = asOf ?? asOfDate(metrics, quarter.start);
  const viewToday = today ?? viewAsOf;

  const progress = quarterProgress(quarter, viewAsOf);
  const totals = sumRows(metrics);
  const pacing = goalPacing(goals, totals, progress.ratio);
  const scorecard = channelScorecard(db.channels, metrics, progress.ratio);
  const rates = funnel(totals);
  const runRate = requiredRunRate(goals, totals, progress);
  const weeks = totalsByWeek(metrics);
  const late = overdue(db.content, viewToday);
  const next = upcoming(db.content, viewToday, 14);
  const load = workload(db.content, viewToday);

  const title = `${company.name} Marketing OS — ${quarter.id}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="page">
    <h1>${esc(company.name)} Marketing OS</h1>
    <div class="meta">
      <span>${esc(quarter.id)}</span>
      <span>${esc(quarter.start)} → ${esc(quarter.end)}</span>
      <span>Data through ${esc(viewAsOf)}</span>
      <span>${esc(usd(totals.spendUsd, { compact: true }))} of ${esc(usd(goals.budgetUsd, { compact: true }))} spent</span>
    </div>
  </header>

  <h2>Quarter to date</h2>
  ${goalTiles(pacing, progress)}

  <h2>What needs a decision</h2>
  ${calloutList(pacing, scorecard, late, runRate)}

  <h2>Pipeline created per week</h2>
  <div class="card">${weeklyChart(weeks, goals, progress)}</div>

  <div class="two" style="margin-top:14px">
    <div>
      <h2 style="margin-top:0">Funnel</h2>
      <div class="card">
        ${funnelChart(totals, rates)}
        <p class="note">Bar length is log-scaled: these stages span four orders of magnitude, so a linear funnel would draw wins as an invisible sliver. Read the percentages, not the widths.</p>
      </div>
    </div>
    <div>
      <h2 style="margin-top:0">Efficiency</h2>
      <div class="tiles" style="grid-template-columns:repeat(2,1fr)">
        <div class="tile"><div class="label">Cost per MQL</div><div class="value">${usd(rates.costPerMqlUsd)}</div></div>
        <div class="tile"><div class="label">CAC</div><div class="value">${usd(rates.cacUsd)}</div></div>
        <div class="tile"><div class="label">Pipeline ROI</div><div class="value">${rates.pipelineRoi === null ? '—' : `${rates.pipelineRoi.toFixed(1)}x`}</div></div>
        <div class="tile"><div class="label">Pipeline per win</div><div class="value">${usd(rates.pipelinePerWinUsd, { compact: true })}</div></div>
      </div>
    </div>
  </div>

  <h2>Channels</h2>
  ${channelTable(scorecard)}

  <h2>Campaigns</h2>
  ${campaignTable(db, viewToday)}

  <h2>Content calendar</h2>
  ${calendarCard(db, late, next)}

  <h2>Load by owner</h2>
  ${workloadTable(db, load)}

  <footer class="page">
    Generated by <code>mos build</code> from <code>data/</code>. Week of ${esc(addDays(viewAsOf, -6))} to ${esc(viewAsOf)}.
    Pacing straight-lines each target across the quarter, so lumpy channels read low between their spikes.
  </footer>
</div>
</body>
</html>
`;
}
