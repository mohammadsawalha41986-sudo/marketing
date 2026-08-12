/** Command routing for `mos`. */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { load, ROOT, personName, campaignName } from './data.js';
import { validate } from './schema.js';
import { today as todayString, addDays } from './dates.js';
import {
  asOfDate, quarterProgress, sumRows, withinQuarter, goalPacing,
  channelScorecard, funnel, requiredRunRate, totalsByWeek,
} from './metrics.js';
import { overdue, upcoming, byWeek, workload, byCampaign, gaps } from './calendar.js';
import { usd, num, pct, delta, table, STATUS_LABEL, titleCase } from './format.js';
import { buildWeeklyReport, reportFilename } from './report.js';
import { buildDashboard } from './dashboard.js';

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const blue = paint('34');

const STATUS_PAINT = { ahead: green, 'on-track': blue, 'at-risk': yellow, behind: red };
const statusText = (status) => STATUS_PAINT[status](STATUS_LABEL[status]);

const HELP = `${bold('mos')} — Marketing OS

Usage
  mos status                    Quarter snapshot: pacing, channels, what is late
  mos validate                  Check data/ for broken references and bad values
  mos calendar [options]        Content calendar by week
  mos campaigns                 List campaigns
  mos campaign <id>             Show one campaign and its content
  mos report [options]          Write the weekly markdown report
  mos build [options]           Write the self-contained HTML dashboard
  mos new <kind> <id>           Scaffold a brief from templates/
  mos help                      This text

Options
  --weeks <n>       calendar: weeks to show (default 6)
  --owner <id>      calendar: limit to one owner
  --out <path>      report, build: output path
  --stdout          report, build: write to stdout instead of a file
  --as-of <date>    report, build, status: treat this YYYY-MM-DD as today
  --json            status, validate, calendar: machine-readable output

Examples
  mos status --as-of 2026-08-09
  mos calendar --weeks 8 --owner dana
  mos new campaign holiday-push --title "Holiday Push"
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

function heading(text) {
  return `\n${bold(text)}\n${dim('─'.repeat(text.length))}`;
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function writeOutput(content, { defaultPath, flags, label }) {
  if (flags.stdout) {
    process.stdout.write(content);
    return null;
  }
  const target = typeof flags.out === 'string' ? flags.out : defaultPath;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  out(`${green('✓')} ${label} → ${relative(ROOT, target) || target}`);
  return target;
}

/** Everything the read commands need, derived once. */
function snapshot(db, flags) {
  const { quarter, goals } = db.config;
  const metrics = withinQuarter(db.metrics, quarter);
  const asOf = typeof flags['as-of'] === 'string' ? flags['as-of'] : asOfDate(metrics, quarter.start);
  const progress = quarterProgress(quarter, asOf);
  const totals = sumRows(metrics);
  return {
    asOf,
    metrics,
    progress,
    totals,
    pacing: goalPacing(goals, totals, progress.ratio),
    scorecard: channelScorecard(db.channels, metrics, progress.ratio),
    rates: funnel(totals),
    runRate: requiredRunRate(goals, totals, progress),
    weeks: totalsByWeek(metrics),
  };
}

function cmdStatus(db, flags) {
  const view = snapshot(db, flags);
  const { config } = db;
  const late = overdue(db.content, view.asOf);

  if (flags.json) {
    out(JSON.stringify({ asOf: view.asOf, progress: view.progress, totals: view.totals, pacing: view.pacing, channels: view.scorecard, funnel: view.rates, late: late.length }, null, 2));
    return 0;
  }

  out(
    `\n${bold(`${config.company.name} — ${config.quarter.id}`)}  ${dim(
      `data through ${view.asOf} · day ${view.progress.daysElapsed}/${view.progress.daysTotal} (${pct(view.progress.ratio, { digits: 0 })})`,
    )}`,
  );

  out(heading('Goals'));
  out(
    table(
      ['Goal', 'Actual', 'Expected', 'Target', 'vs plan', 'Status'],
      view.pacing.map((row) => {
        const format = row.key === 'pipelineUsd' ? (v) => usd(v, { compact: true }) : num;
        return [row.label, format(row.actual), format(row.expected), format(row.target), delta(row.index - 1), statusText(row.status)];
      }),
      ['left', 'right', 'right', 'right', 'right', 'left'],
    ),
  );

  out(heading('Channels'));
  out(
    table(
      ['Channel', 'Spend', 'Used', 'MQLs', 'Pipeline', 'vs plan', 'Cost/MQL', 'ROI', 'Status'],
      view.scorecard.map((row) => [
        row.name,
        usd(row.totals.spendUsd, { compact: true }),
        pct(row.budgetUsedRatio, { digits: 0 }),
        num(row.totals.mqls),
        usd(row.totals.pipelineUsd, { compact: true }),
        delta(row.pipeline.index - 1),
        usd(row.costPerMqlUsd),
        row.pipelineRoi === null ? '—' : `${row.pipelineRoi.toFixed(1)}x`,
        statusText(row.status),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
    ),
  );

  out(heading('Efficiency'));
  out(
    `Cost per MQL ${bold(usd(view.rates.costPerMqlUsd))} · CAC ${bold(usd(view.rates.cacUsd))} · ` +
      `Pipeline ROI ${bold(view.rates.pipelineRoi === null ? '—' : `${view.rates.pipelineRoi.toFixed(1)}x`)} · ` +
      `Budget used ${bold(pct(view.totals.spendUsd / config.goals.budgetUsd, { digits: 0 }))}`,
  );

  if (view.runRate) {
    out(heading('Required run rate'));
    out(
      `${view.runRate.weeksRemaining.toFixed(1)} weeks left · ` +
        `${bold(usd(view.runRate.pipelineUsdPerWeek, { compact: true }))} pipeline/wk · ` +
        `${bold(Math.ceil(view.runRate.mqlsPerWeek))} MQLs/wk · ` +
        `${bold(Math.ceil(view.runRate.winsPerWeek))} wins/wk`,
    );
  }

  out(heading('Content'));
  if (late.length === 0) {
    out(dim('Nothing late.'));
  } else {
    out(`${red(`${late.length} late`)}:`);
    for (const item of late.slice(0, 5)) {
      out(`  ${red('•')} ${item.title} ${dim(`— ${personName(db, item.owner)}, due ${item.publishDate} (${item.daysLate}d)`)}`);
    }
  }
  const next = upcoming(db.content, view.asOf, 14);
  out(`${next.length} publishing in the next 14 days.`);
  out('');
  return 0;
}

function cmdValidate(db, flags) {
  const result = validate(db);
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  for (const issue of result.errors) out(`${red('error')}  ${bold(issue.where)}  ${issue.message}`);
  for (const issue of result.warnings) out(`${yellow('warn')}   ${bold(issue.where)}  ${issue.message}`);

  const counts = `${result.errors.length} error(s), ${result.warnings.length} warning(s)`;
  out(result.ok ? `${green('✓')} data/ is valid — ${counts}` : `${red('✗')} data/ has problems — ${counts}`);
  return result.ok ? 0 : 1;
}

function cmdCalendar(db, flags) {
  const weeks = Number(flags.weeks ?? 6);
  const from = typeof flags['as-of'] === 'string' ? flags['as-of'] : todayString();
  let content = db.content;
  if (typeof flags.owner === 'string') content = content.filter((item) => item.owner === flags.owner);

  const buckets = byWeek(content, from, weeks);
  if (flags.json) {
    out(JSON.stringify(buckets, null, 2));
    return 0;
  }

  const late = overdue(content, from);
  if (late.length > 0) {
    out(heading(`Late (${late.length})`));
    out(
      table(
        ['Due', 'Days', 'Item', 'Owner', 'Status'],
        late.map((item) => [item.publishDate, `${item.daysLate}d`, item.title, personName(db, item.owner), item.status]),
        ['left', 'right', 'left', 'left', 'left'],
      ),
    );
  }

  for (const bucket of buckets) {
    out(heading(`Week of ${bucket.weekStart} → ${addDays(bucket.weekStart, 6)}`));
    if (bucket.items.length === 0) {
      out(dim('  (nothing publishing)'));
      continue;
    }
    out(
      table(
        ['Date', 'Item', 'Type', 'Campaign', 'Owner', 'Status'],
        bucket.items.map((item) => [
          item.publishDate,
          item.title,
          item.type,
          campaignName(db, item.campaign),
          personName(db, item.owner),
          item.status,
        ]),
      ),
    );
  }

  const quiet = gaps(content, from, weeks);
  if (quiet.length > 0) out(`\n${yellow('!')} Weeks with nothing publishing: ${quiet.join(', ')}`);
  out('');
  return 0;
}

function cmdCampaigns(db) {
  const order = { active: 0, planned: 1, paused: 2, completed: 3, cancelled: 4 };
  const rows = [...db.campaigns]
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.start.localeCompare(b.start))
    .map((campaign) => [
      campaign.id,
      campaign.name,
      campaign.status,
      personName(db, campaign.owner),
      `${campaign.start} → ${campaign.end}`,
      usd(campaign.budgetUsd, { compact: true }),
      usd(campaign.targets?.pipelineUsd, { compact: true }),
    ]);
  out(heading('Campaigns'));
  out(table(['ID', 'Name', 'Status', 'Owner', 'Window', 'Budget', 'Target pipeline'], rows, ['left', 'left', 'left', 'left', 'left', 'right', 'right']));
  out('');
  return 0;
}

function cmdCampaign(db, id) {
  const campaign = db.campaigns.find((row) => row.id === id);
  if (!campaign) {
    out(`${red('✗')} No campaign "${id}". Run ${bold('mos campaigns')} to list them.`);
    return 1;
  }
  out(heading(campaign.name));
  out(`${dim('Status')}   ${campaign.status}`);
  out(`${dim('Owner')}    ${personName(db, campaign.owner)}`);
  out(`${dim('Window')}   ${campaign.start} → ${campaign.end}`);
  out(`${dim('Budget')}   ${usd(campaign.budgetUsd)}`);
  out(`${dim('Channels')} ${campaign.channels.join(', ')}`);
  out(`${dim('Segments')} ${(campaign.segments ?? []).join(', ') || '—'}`);
  out(`${dim('Targets')}  ${num(campaign.targets?.mqls)} MQLs · ${usd(campaign.targets?.pipelineUsd, { compact: true })} pipeline`);
  out(`${dim('Goal')}     ${campaign.goal ?? '—'}`);

  const items = byCampaign(db.content, campaign.id);
  out(heading(`Content (${items.length})`));
  if (items.length === 0) {
    out(dim('  (none)'));
  } else {
    out(
      table(
        ['Date', 'Item', 'Type', 'Owner', 'Status'],
        items.map((item) => [item.publishDate, item.title, item.type, personName(db, item.owner), item.status]),
      ),
    );
  }
  out('');
  return 0;
}

function cmdReport(db, flags) {
  const asOf = typeof flags['as-of'] === 'string' ? flags['as-of'] : undefined;
  const content = buildWeeklyReport(db, { asOf });
  const resolved = asOf ?? asOfDate(withinQuarter(db.metrics, db.config.quarter), db.config.quarter.start);
  writeOutput(content, {
    defaultPath: join(ROOT, 'reports', reportFilename(resolved)),
    flags,
    label: 'Weekly report',
  });
  return 0;
}

function cmdBuild(db, flags) {
  const asOf = typeof flags['as-of'] === 'string' ? flags['as-of'] : undefined;
  const content = buildDashboard(db, { asOf });
  writeOutput(content, {
    defaultPath: join(ROOT, 'dist', 'dashboard.html'),
    flags,
    label: 'Dashboard',
  });
  return 0;
}

const SCAFFOLDS = {
  campaign: { template: 'campaign-brief.md', dir: 'briefs/campaigns' },
  content: { template: 'content-brief.md', dir: 'briefs/content' },
  launch: { template: 'launch-checklist.md', dir: 'briefs/launches' },
};

function cmdNew(db, flags, kind, id) {
  const scaffold = SCAFFOLDS[kind];
  if (!scaffold) {
    out(`${red('✗')} Unknown kind "${kind}". Try: ${Object.keys(SCAFFOLDS).join(', ')}`);
    return 1;
  }
  if (!id) {
    out(`${red('✗')} Give the brief an id, e.g. ${bold(`mos new ${kind} holiday-push`)}`);
    return 1;
  }

  const templatePath = join(ROOT, 'templates', scaffold.template);
  if (!existsSync(templatePath)) {
    out(`${red('✗')} Missing template ${relative(ROOT, templatePath)}`);
    return 1;
  }

  const target = join(ROOT, scaffold.dir, `${id}.md`);
  if (existsSync(target) && !flags.force) {
    out(`${red('✗')} ${relative(ROOT, target)} already exists. Pass --force to overwrite.`);
    return 1;
  }

  const filled = readFileSync(templatePath, 'utf8')
    .replaceAll('{{ID}}', id)
    .replaceAll('{{TITLE}}', typeof flags.title === 'string' ? flags.title : titleCase(id))
    .replaceAll('{{OWNER}}', typeof flags.owner === 'string' ? flags.owner : 'TBD')
    .replaceAll('{{DATE}}', todayString())
    .replaceAll('{{QUARTER}}', db.config.quarter.id)
    .replaceAll('{{COMPANY}}', db.config.company.name);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, filled, 'utf8');
  out(`${green('✓')} ${titleCase(kind)} brief → ${relative(ROOT, target)}`);
  out(dim(`Next: fill it in, then add the entry to data/${kind === 'content' ? 'content' : 'campaigns'}.json and run mos validate.`));
  return 0;
}

const READS_DATA = new Set(['status', 'validate', 'calendar', 'campaigns', 'campaign', 'report', 'build', 'new']);

export function run(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command = 'help', ...rest] = positional;

  if (command === 'help' || flags.help) {
    out(HELP);
    return 0;
  }
  if (!READS_DATA.has(command)) {
    out(`${red('✗')} Unknown command "${command}".\n`);
    out(HELP);
    return 1;
  }

  let db;
  try {
    db = load();
  } catch (err) {
    out(`${red('✗')} ${err.message}`);
    return 1;
  }

  // Every command except `validate` assumes the data holds together.
  if (command !== 'validate') {
    const result = validate(db);
    if (!result.ok) {
      out(`${red('✗')} data/ has ${result.errors.length} error(s). Run ${bold('mos validate')} for details.`);
      return 1;
    }
  }

  switch (command) {
    case 'status':
      return cmdStatus(db, flags);
    case 'validate':
      return cmdValidate(db, flags);
    case 'calendar':
      return cmdCalendar(db, flags);
    case 'campaigns':
      return cmdCampaigns(db);
    case 'campaign':
      return cmdCampaign(db, rest[0]);
    case 'report':
      return cmdReport(db, flags);
    case 'build':
      return cmdBuild(db, flags);
    case 'new':
      return cmdNew(db, flags, rest[0], rest[1]);
    default:
      out(HELP);
      return 1;
  }
}

export { parseArgs, workload };
