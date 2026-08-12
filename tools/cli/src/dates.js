/**
 * Date helpers. Every date in this repo is a plain `YYYY-MM-DD` string and is
 * treated as UTC midnight, so day arithmetic never drifts with the local zone.
 */

const DAY_MS = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toDateString(parsed) === value;
}

export function parseDate(value) {
  if (!isDateString(value)) throw new TypeError(`Not a YYYY-MM-DD date: ${value}`);
  return new Date(`${value}T00:00:00Z`);
}

export function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(value, days) {
  return toDateString(new Date(parseDate(value).getTime() + days * DAY_MS));
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from, to) {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);
}

/** Inclusive on both ends, matching how a quarter or campaign window reads. */
export function isWithin(value, start, end) {
  const t = parseDate(value).getTime();
  return t >= parseDate(start).getTime() && t <= parseDate(end).getTime();
}

/** Monday of the week containing `value`. */
export function weekStart(value) {
  const date = parseDate(value);
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -offset);
}

export function today() {
  return toDateString(new Date());
}
