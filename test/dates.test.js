import test from 'node:test';
import assert from 'node:assert/strict';

import { isDateString, addDays, daysBetween, isWithin, weekStart, toDateString } from '../src/dates.js';

test('isDateString accepts real dates and rejects everything else', () => {
  assert.equal(isDateString('2026-08-12'), true);
  assert.equal(isDateString('2026-02-30'), false, 'February 30 rolls over, so it is not a real date');
  assert.equal(isDateString('2026-8-12'), false);
  assert.equal(isDateString('12/08/2026'), false);
  assert.equal(isDateString(20260812), false);
  assert.equal(isDateString(null), false);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-12', 1), '2026-08-13');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'leap year');
});

test('daysBetween is signed and symmetric', () => {
  assert.equal(daysBetween('2026-07-01', '2026-08-09'), 39);
  assert.equal(daysBetween('2026-08-09', '2026-07-01'), -39);
  assert.equal(daysBetween('2026-08-09', '2026-08-09'), 0);
});

test('isWithin includes both ends', () => {
  assert.equal(isWithin('2026-07-01', '2026-07-01', '2026-09-30'), true);
  assert.equal(isWithin('2026-09-30', '2026-07-01', '2026-09-30'), true);
  assert.equal(isWithin('2026-06-30', '2026-07-01', '2026-09-30'), false);
  assert.equal(isWithin('2026-10-01', '2026-07-01', '2026-09-30'), false);
});

test('weekStart returns the Monday of the containing week', () => {
  assert.equal(weekStart('2026-08-12'), '2026-08-10', 'Wednesday maps back to Monday');
  assert.equal(weekStart('2026-08-10'), '2026-08-10', 'Monday is its own week start');
  assert.equal(weekStart('2026-08-16'), '2026-08-10', 'Sunday belongs to the week that opened it');
});

test('day arithmetic does not drift across a DST boundary', () => {
  // US DST ends 2026-11-01. A local-time implementation loses or gains an hour
  // here and rounds to the wrong day.
  assert.equal(addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(daysBetween('2026-10-25', '2026-11-08'), 14);
});

test('toDateString round-trips a UTC date', () => {
  assert.equal(toDateString(new Date('2026-08-12T00:00:00Z')), '2026-08-12');
});
