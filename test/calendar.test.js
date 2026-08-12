import test from 'node:test';
import assert from 'node:assert/strict';

import { overdue, upcoming, byWeek, statusCounts, workload, byCampaign, gaps, inFlight } from '../src/calendar.js';

const TODAY = '2026-08-12';

const item = (id, publishDate, over = {}) => ({
  id, publishDate, title: id, type: 'blog', channel: 'organic-search',
  campaign: 'launch', owner: 'dana', status: 'planned', ...over,
});

const CONTENT = [
  item('past-published', '2026-08-03', { status: 'published' }),
  item('past-open', '2026-08-05', { status: 'in-review' }),
  item('past-open-older', '2026-07-29', { status: 'drafting', owner: 'alex' }),
  item('due-today', '2026-08-12', { status: 'scheduled' }),
  item('soon', '2026-08-19', { status: 'drafting', owner: 'alex' }),
  item('later', '2026-09-16', { campaign: null }),
];

test('overdue catches open items past their date, worst first', () => {
  const late = overdue(CONTENT, TODAY);
  assert.deepEqual(late.map((i) => i.id), ['past-open-older', 'past-open']);
  assert.equal(late[0].daysLate, 14);
});

test('overdue ignores published items and anything due today', () => {
  const ids = overdue(CONTENT, TODAY).map((i) => i.id);
  assert.ok(!ids.includes('past-published'), 'published is done, however late it was');
  assert.ok(!ids.includes('due-today'), 'due today is not yet late');
});

test('upcoming covers the window from today forward, excluding late work', () => {
  const next = upcoming(CONTENT, TODAY, 14);
  assert.deepEqual(next.map((i) => i.id), ['due-today', 'soon']);
  assert.equal(next[0].daysUntil, 0);
  assert.equal(next[1].daysUntil, 7);
});

test('upcoming respects the window length', () => {
  assert.deepEqual(upcoming(CONTENT, TODAY, 3).map((i) => i.id), ['due-today']);
  assert.equal(upcoming(CONTENT, TODAY, 60).length, 3);
});

test('byWeek buckets from the Monday of the given day and keeps empty weeks', () => {
  const buckets = byWeek(CONTENT, TODAY, 3);
  assert.deepEqual(buckets.map((b) => b.weekStart), ['2026-08-10', '2026-08-17', '2026-08-24']);
  assert.deepEqual(buckets[0].items.map((i) => i.id), ['due-today']);
  assert.deepEqual(buckets[1].items.map((i) => i.id), ['soon']);
  assert.deepEqual(buckets[2].items, []);
});

test('gaps names the weeks with nothing publishing', () => {
  assert.deepEqual(gaps(CONTENT, TODAY, 3), ['2026-08-24']);
  assert.deepEqual(gaps([], TODAY, 2), ['2026-08-10', '2026-08-17']);
});

test('statusCounts tallies the pipeline of work', () => {
  assert.deepEqual(statusCounts(CONTENT), { published: 1, 'in-review': 1, drafting: 2, scheduled: 1, planned: 1 });
});

test('workload splits open from published and flags what is late', () => {
  const load = workload(CONTENT, TODAY);
  const dana = load.find((row) => row.owner === 'dana');
  const alex = load.find((row) => row.owner === 'alex');

  assert.equal(dana.total, 4);
  assert.equal(dana.published, 1);
  assert.equal(dana.open, 3);
  assert.equal(dana.late, 1);

  assert.equal(alex.open, 2);
  assert.equal(alex.late, 1);
  assert.equal(load[0].owner, 'dana', 'sorted by open work');
});

test('byCampaign filters and orders by publish date', () => {
  assert.deepEqual(byCampaign(CONTENT, 'launch').map((i) => i.id), [
    'past-open-older', 'past-published', 'past-open', 'due-today', 'soon',
  ]);
  assert.deepEqual(byCampaign(CONTENT, null).map((i) => i.id), ['later']);
  assert.deepEqual(byCampaign(CONTENT, 'nope'), []);
});

test('inFlight is work already started but not out', () => {
  assert.deepEqual(inFlight(CONTENT).map((i) => i.id), ['past-open-older', 'past-open', 'due-today', 'soon']);
});
