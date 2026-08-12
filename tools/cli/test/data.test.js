/** Guards the committed dataset and the two things generated from it. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { load } from '../src/data.js';
import { validate } from '../src/schema.js';
import { buildWeeklyReport } from '../src/report.js';
import { buildDashboard } from '../src/dashboard.js';
import { withinQuarter, sumRows, asOfDate } from '../src/metrics.js';

const db = load();

test('the committed dataset validates with no errors and no warnings', () => {
  const result = validate(db);
  const describe = (issues) => issues.map((issue) => `${issue.where}: ${issue.message}`).join('\n');
  assert.equal(result.errors.length, 0, `errors:\n${describe(result.errors)}`);
  assert.equal(result.warnings.length, 0, `warnings:\n${describe(result.warnings)}`);
});

test('every metrics row falls inside the configured quarter', () => {
  assert.equal(withinQuarter(db.metrics, db.config.quarter).length, db.metrics.length);
});

test('spend to date stays inside the quarter budget', () => {
  const totals = sumRows(db.metrics);
  assert.ok(
    totals.spendUsd <= db.config.goals.budgetUsd,
    `spent ${totals.spendUsd} of ${db.config.goals.budgetUsd}`,
  );
});

test('every channel has reported at least one week', () => {
  const reporting = new Set(db.metrics.map((row) => row.channel));
  for (const channel of db.channels) {
    assert.ok(reporting.has(channel.id), `${channel.id} has no metrics rows`);
  }
});

test('the weekly report renders and states its coverage', () => {
  const asOf = asOfDate(withinQuarter(db.metrics, db.config.quarter), db.config.quarter.start);
  const markdown = buildWeeklyReport(db);

  assert.match(markdown, /^# ExampleCo weekly marketing report/);
  assert.ok(markdown.includes(`**Data through:** ${asOf}`));
  for (const section of ['## Where we stand', '## Channels', '## Funnel', '## Content calendar']) {
    assert.ok(markdown.includes(section), `missing ${section}`);
  }
  assert.ok(!markdown.includes('NaN'), 'a NaN in a report means a divide-by-zero got through');
  assert.ok(!markdown.includes('undefined'));
});

test('the dashboard renders a complete, self-contained document', () => {
  const html = buildDashboard(db);

  assert.match(html, /^<!doctype html>/);
  assert.ok(html.trimEnd().endsWith('</html>'));
  assert.ok(html.includes('<title>ExampleCo Marketing OS — 2026-Q3</title>'));
  assert.ok(html.includes('<svg'), 'charts should be inline SVG');
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
});

test('the dashboard pulls in nothing from the network', () => {
  const html = buildDashboard(db);
  assert.equal(/<script/i.test(html), false, 'the page needs no script to render');
  assert.equal(/\bsrc\s*=/i.test(html), false, 'no external assets');
  assert.equal(/https?:\/\//i.test(html.replace(/xmlns="[^"]*"/g, '')), false, 'no remote URLs');
});

test('report and dashboard agree on the numbers they both show', () => {
  const totals = sumRows(withinQuarter(db.metrics, db.config.quarter));
  const markdown = buildWeeklyReport(db);
  const html = buildDashboard(db);
  const mqls = String(totals.mqls);

  assert.ok(markdown.includes(mqls), 'report should show total MQLs');
  assert.ok(html.includes(mqls), 'dashboard should show total MQLs');
});

test('an as-of date before any data reports zero rather than throwing', () => {
  const markdown = buildWeeklyReport(db, { asOf: db.config.quarter.start });
  assert.ok(markdown.includes('# ExampleCo weekly marketing report'));
  assert.ok(!markdown.includes('NaN'));
});

test('every content item points at a channel its campaign actually runs', () => {
  const campaigns = new Map(db.campaigns.map((campaign) => [campaign.id, campaign]));
  for (const item of db.content) {
    if (!item.campaign) continue;
    const campaign = campaigns.get(item.campaign);
    assert.ok(
      campaign.channels.includes(item.channel),
      `${item.id} publishes to ${item.channel}, which "${campaign.id}" does not run`,
    );
  }
});
