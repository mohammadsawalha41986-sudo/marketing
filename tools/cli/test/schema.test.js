import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../src/schema.js';

function fixture(overrides = {}) {
  const db = {
    config: {
      company: { name: 'Test Co' },
      currency: 'USD',
      quarter: { id: '2026-Q3', start: '2026-07-01', end: '2026-09-30' },
      goals: { pipelineUsd: 100000, mqls: 100, sqls: 20, wins: 5, budgetUsd: 10000 },
      team: [{ id: 'dana', name: 'Dana', role: 'Lifecycle' }],
    },
    icp: [{ id: 'smb', name: 'SMB' }],
    channels: [
      { id: 'email', name: 'Email', owner: 'dana', budgetUsd: 10000, targets: { mqls: 100, pipelineUsd: 100000 } },
    ],
    campaigns: [
      {
        id: 'launch', name: 'Launch', status: 'active', owner: 'dana', segments: ['smb'],
        channels: ['email'], start: '2026-07-01', end: '2026-09-30', budgetUsd: 5000,
        goal: 'Ship it', targets: { mqls: 50, pipelineUsd: 50000 },
      },
    ],
    content: [
      {
        id: 'c-001', title: 'Post', type: 'blog', channel: 'email',
        campaign: 'launch', owner: 'dana', status: 'published', publishDate: '2026-07-09',
      },
    ],
    metrics: [
      { weekStart: '2026-07-06', channel: 'email', spendUsd: 100, visits: 500, mqls: 10, sqls: 3, wins: 1, pipelineUsd: 9000 },
    ],
  };
  return { ...db, ...overrides };
}

const messages = (result) => result.issues.map((issue) => issue.message);
const hasMessage = (result, needle) => messages(result).some((message) => message.includes(needle));

test('a well-formed dataset validates clean', () => {
  const result = validate(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a collection that is not an array fails fast', () => {
  const result = validate(fixture({ channels: { email: {} } }));
  assert.equal(result.ok, false);
  assert.ok(hasMessage(result, 'expected a JSON array'));
});

test('duplicate ids are an error', () => {
  const db = fixture();
  db.content.push({ ...db.content[0] });
  assert.ok(hasMessage(validate(db), 'duplicate id "c-001"'));
});

test('ids must be lowercase slugs', () => {
  const db = fixture();
  db.channels[0].id = 'Email Channel';
  assert.equal(validate(db).ok, false);
});

test('unknown references are caught across every collection', () => {
  const campaignRef = fixture();
  campaignRef.campaigns[0].channels = ['carrier-pigeon'];
  assert.ok(hasMessage(validate(campaignRef), 'unknown channel "carrier-pigeon"'));

  const segmentRef = fixture();
  segmentRef.campaigns[0].segments = ['whales'];
  assert.ok(hasMessage(validate(segmentRef), 'unknown segment "whales"'));

  const contentRef = fixture();
  contentRef.content[0].campaign = 'ghost';
  assert.ok(hasMessage(validate(contentRef), 'unknown campaign "ghost"'));

  const metricRef = fixture();
  metricRef.metrics[0].channel = 'ghost';
  assert.ok(hasMessage(validate(metricRef), 'unknown channel "ghost"'));

  const owner = fixture();
  owner.content[0].owner = 'nobody';
  assert.ok(hasMessage(validate(owner), 'is not on config.team'));
});

test('null campaign is allowed for standing content', () => {
  const db = fixture();
  db.content[0].campaign = null;
  assert.equal(validate(db).ok, true);
});

test('enums are enforced', () => {
  const status = fixture();
  status.campaigns[0].status = 'vibing';
  assert.equal(validate(status).ok, false);

  const type = fixture();
  type.content[0].type = 'interpretive-dance';
  assert.equal(validate(type).ok, false);
});

test('metric weeks must start on a Monday and cannot repeat', () => {
  const notMonday = fixture();
  notMonday.metrics[0].weekStart = '2026-07-07';
  assert.ok(hasMessage(validate(notMonday), 'is not a Monday'));

  const duplicate = fixture();
  duplicate.metrics.push({ ...duplicate.metrics[0] });
  assert.ok(hasMessage(validate(duplicate), 'duplicate row'));
});

test('negative measures are rejected', () => {
  const db = fixture();
  db.metrics[0].spendUsd = -1;
  assert.ok(hasMessage(validate(db), 'spendUsd must be a non-negative number'));
});

test('impossible funnel shapes warn without failing the run', () => {
  const db = fixture();
  db.metrics[0].sqls = 99;
  const result = validate(db);
  assert.equal(result.ok, true, 'a warning does not block the reports');
  assert.ok(hasMessage(result, 'exceed mqls'));
});

test('a campaign end before its start is an error', () => {
  const db = fixture();
  db.campaigns[0].end = '2026-06-01';
  assert.ok(hasMessage(validate(db), 'end falls before start'));
});

test('rollups warn when channel plans stop adding up to the quarter goals', () => {
  const db = fixture();
  db.channels[0].budgetUsd = 999;
  const result = validate(db);
  assert.equal(result.ok, true);
  assert.ok(hasMessage(result, 'channel budgets total 999'));
});

test('content publishing outside its campaign window warns', () => {
  const db = fixture();
  db.content[0].publishDate = '2026-12-25';
  assert.ok(hasMessage(validate(db), 'outside "launch"'));
});
