/** Views over the content calendar: what is late, what is next, who is loaded. */

import { addDays, daysBetween, weekStart, isWithin } from './dates.js';

const SHIPPED = new Set(['published']);
const IN_FLIGHT = ['drafting', 'in-review', 'scheduled'];

const byDate = (a, b) => a.publishDate.localeCompare(b.publishDate) || a.id.localeCompare(b.id);

/** Past its publish date and still not out. The list that runs the standup. */
export function overdue(content, today) {
  return content
    .filter((item) => !SHIPPED.has(item.status) && daysBetween(item.publishDate, today) > 0)
    .map((item) => ({ ...item, daysLate: daysBetween(item.publishDate, today) }))
    .sort((a, b) => b.daysLate - a.daysLate || a.id.localeCompare(b.id));
}

/** Everything due in the next `days` days, late items excluded. */
export function upcoming(content, from, days = 14) {
  const until = addDays(from, days);
  return content
    .filter((item) => !SHIPPED.has(item.status) && isWithin(item.publishDate, from, until))
    .map((item) => ({ ...item, daysUntil: daysBetween(from, item.publishDate) }))
    .sort(byDate);
}

/** `[{ weekStart, items }]` for `weeks` weeks starting the Monday of `from`. */
export function byWeek(content, from, weeks = 6) {
  const first = weekStart(from);
  const buckets = Array.from({ length: weeks }, (_, i) => ({ weekStart: addDays(first, i * 7), items: [] }));
  const index = new Map(buckets.map((bucket) => [bucket.weekStart, bucket]));
  for (const item of [...content].sort(byDate)) {
    index.get(weekStart(item.publishDate))?.items.push(item);
  }
  return buckets;
}

export function statusCounts(content) {
  const counts = {};
  for (const item of content) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

/** Per-owner load, sorted by how much is still open. */
export function workload(content, today) {
  const owners = new Map();
  for (const item of content) {
    const row = owners.get(item.owner) ?? { owner: item.owner, total: 0, open: 0, published: 0, late: 0 };
    row.total += 1;
    if (SHIPPED.has(item.status)) {
      row.published += 1;
    } else {
      row.open += 1;
      if (daysBetween(item.publishDate, today) > 0) row.late += 1;
    }
    owners.set(item.owner, row);
  }
  return [...owners.values()].sort((a, b) => b.open - a.open || a.owner.localeCompare(b.owner));
}

/** Content grouped by campaign, so a launch can be checked for holes. */
export function byCampaign(content, campaignId) {
  return content.filter((item) => item.campaign === campaignId).sort(byDate);
}

/**
 * Weeks inside the window with nothing publishing. A quiet week is not always a
 * problem, but it should be a decision rather than an accident.
 */
export function gaps(content, from, weeks = 6) {
  return byWeek(content, from, weeks)
    .filter((bucket) => bucket.items.length === 0)
    .map((bucket) => bucket.weekStart);
}

export function inFlight(content) {
  return content.filter((item) => IN_FLIGHT.includes(item.status)).sort(byDate);
}

export { SHIPPED, IN_FLIGHT };
