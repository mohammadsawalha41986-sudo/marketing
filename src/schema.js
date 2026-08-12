/**
 * Validation for the dataset under `data/`.
 *
 * Errors are things that would make the reports wrong: a broken reference, a
 * malformed date, a negative spend. Warnings are things that are legal but
 * usually a mistake, such as channel budgets that no longer add up to the
 * quarter budget.
 */

import { isDateString, daysBetween, weekStart } from './dates.js';

const CAMPAIGN_STATUSES = ['planned', 'active', 'paused', 'completed', 'cancelled'];
const CONTENT_STATUSES = ['idea', 'planned', 'drafting', 'in-review', 'scheduled', 'published'];
const CONTENT_TYPES = [
  'blog', 'case-study', 'webinar', 'email', 'social', 'video',
  'whitepaper', 'landing-page', 'press-release', 'newsletter',
];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class Issues {
  constructor() {
    this.list = [];
  }

  error(where, message) {
    this.list.push({ level: 'error', where, message });
  }

  warn(where, message) {
    this.list.push({ level: 'warning', where, message });
  }
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function checkUniqueIds(issues, rows, file) {
  const seen = new Set();
  rows.forEach((row, i) => {
    if (typeof row.id !== 'string' || !SLUG.test(row.id)) {
      issues.error(`${file}[${i}]`, `id must be a lowercase slug, got ${JSON.stringify(row.id)}`);
      return;
    }
    if (seen.has(row.id)) issues.error(`${file}[${i}]`, `duplicate id "${row.id}"`);
    seen.add(row.id);
  });
}

function checkConfig(issues, config) {
  if (!config?.company?.name) issues.error('config.json', 'company.name is required');
  const quarter = config?.quarter;
  if (!quarter) {
    issues.error('config.json', 'quarter is required');
  } else {
    for (const field of ['start', 'end']) {
      if (!isDateString(quarter[field])) {
        issues.error('config.json', `quarter.${field} must be a YYYY-MM-DD date`);
      }
    }
    if (isDateString(quarter.start) && isDateString(quarter.end) && daysBetween(quarter.start, quarter.end) <= 0) {
      issues.error('config.json', 'quarter.end must fall after quarter.start');
    }
  }
  for (const [goal, value] of Object.entries(config?.goals ?? {})) {
    if (!isNonNegativeNumber(value)) issues.error('config.json', `goals.${goal} must be a non-negative number`);
  }
  for (const [i, member] of (config?.team ?? []).entries()) {
    if (!member.id || !member.name) issues.error(`config.json team[${i}]`, 'team members need an id and a name');
  }
}

function checkChannels(issues, channels, teamIds) {
  checkUniqueIds(issues, channels, 'channels.json');
  for (const channel of channels) {
    const where = `channels.json "${channel.id}"`;
    if (!channel.name) issues.error(where, 'name is required');
    if (!teamIds.has(channel.owner)) issues.error(where, `owner "${channel.owner}" is not on config.team`);
    if (!isNonNegativeNumber(channel.budgetUsd)) issues.error(where, 'budgetUsd must be a non-negative number');
    for (const target of ['mqls', 'pipelineUsd']) {
      if (!isNonNegativeNumber(channel.targets?.[target])) {
        issues.error(where, `targets.${target} must be a non-negative number`);
      }
    }
  }
}

function checkCampaigns(issues, campaigns, { channelIds, segmentIds, teamIds }) {
  checkUniqueIds(issues, campaigns, 'campaigns.json');
  for (const campaign of campaigns) {
    const where = `campaigns.json "${campaign.id}"`;
    if (!campaign.name) issues.error(where, 'name is required');
    if (!CAMPAIGN_STATUSES.includes(campaign.status)) {
      issues.error(where, `status must be one of ${CAMPAIGN_STATUSES.join(', ')}`);
    }
    if (!teamIds.has(campaign.owner)) issues.error(where, `owner "${campaign.owner}" is not on config.team`);
    if (!isNonNegativeNumber(campaign.budgetUsd)) issues.error(where, 'budgetUsd must be a non-negative number');
    if (!campaign.goal) issues.warn(where, 'no goal stated — a campaign without a goal cannot be called off');

    for (const field of ['start', 'end']) {
      if (!isDateString(campaign[field])) issues.error(where, `${field} must be a YYYY-MM-DD date`);
    }
    if (isDateString(campaign.start) && isDateString(campaign.end) && daysBetween(campaign.start, campaign.end) < 0) {
      issues.error(where, 'end falls before start');
    }

    if (!Array.isArray(campaign.channels) || campaign.channels.length === 0) {
      issues.error(where, 'channels must list at least one channel');
    } else {
      for (const id of campaign.channels) {
        if (!channelIds.has(id)) issues.error(where, `unknown channel "${id}"`);
      }
    }
    for (const id of campaign.segments ?? []) {
      if (!segmentIds.has(id)) issues.error(where, `unknown segment "${id}"`);
    }
  }
}

function checkContent(issues, content, { channelIds, campaignIds, teamIds }) {
  checkUniqueIds(issues, content, 'content.json');
  for (const item of content) {
    const where = `content.json "${item.id}"`;
    if (!item.title) issues.error(where, 'title is required');
    if (!CONTENT_TYPES.includes(item.type)) issues.error(where, `type must be one of ${CONTENT_TYPES.join(', ')}`);
    if (!CONTENT_STATUSES.includes(item.status)) issues.error(where, `status must be one of ${CONTENT_STATUSES.join(', ')}`);
    if (!teamIds.has(item.owner)) issues.error(where, `owner "${item.owner}" is not on config.team`);
    if (!channelIds.has(item.channel)) issues.error(where, `unknown channel "${item.channel}"`);
    if (item.campaign !== null && !campaignIds.has(item.campaign)) {
      issues.error(where, `unknown campaign "${item.campaign}" — use null for standing content`);
    }
    if (!isDateString(item.publishDate)) issues.error(where, 'publishDate must be a YYYY-MM-DD date');
  }
}

function checkMetrics(issues, metrics, channelIds) {
  const seen = new Set();
  metrics.forEach((row, i) => {
    const where = `metrics.json[${i}]`;
    if (!isDateString(row.weekStart)) {
      issues.error(where, 'weekStart must be a YYYY-MM-DD date');
    } else if (weekStart(row.weekStart) !== row.weekStart) {
      issues.error(where, `weekStart ${row.weekStart} is not a Monday`);
    }
    if (!channelIds.has(row.channel)) issues.error(where, `unknown channel "${row.channel}"`);

    const key = `${row.weekStart}::${row.channel}`;
    if (seen.has(key)) issues.error(where, `duplicate row for ${row.channel} in the week of ${row.weekStart}`);
    seen.add(key);

    for (const field of ['spendUsd', 'visits', 'mqls', 'sqls', 'wins', 'pipelineUsd']) {
      if (!isNonNegativeNumber(row[field])) issues.error(where, `${field} must be a non-negative number`);
    }
    if (row.sqls > row.mqls) issues.warn(where, `sqls (${row.sqls}) exceed mqls (${row.mqls})`);
    if (row.wins > row.sqls) issues.warn(where, `wins (${row.wins}) exceed sqls (${row.sqls})`);
  });
}

function checkRollups(issues, db) {
  const budget = db.channels.reduce((sum, c) => sum + (c.budgetUsd ?? 0), 0);
  if (budget !== db.config.goals?.budgetUsd) {
    issues.warn(
      'channels.json',
      `channel budgets total ${budget} but config.goals.budgetUsd is ${db.config.goals?.budgetUsd}`,
    );
  }
  const mqlTargets = db.channels.reduce((sum, c) => sum + (c.targets?.mqls ?? 0), 0);
  if (mqlTargets !== db.config.goals?.mqls) {
    issues.warn(
      'channels.json',
      `channel MQL targets total ${mqlTargets} but config.goals.mqls is ${db.config.goals?.mqls}`,
    );
  }
  const pipelineTargets = db.channels.reduce((sum, c) => sum + (c.targets?.pipelineUsd ?? 0), 0);
  if (pipelineTargets !== db.config.goals?.pipelineUsd) {
    issues.warn(
      'channels.json',
      `channel pipeline targets total ${pipelineTargets} but config.goals.pipelineUsd is ${db.config.goals?.pipelineUsd}`,
    );
  }

  for (const item of db.content) {
    if (!item.campaign || !isDateString(item.publishDate)) continue;
    const campaign = db.campaigns.find((c) => c.id === item.campaign);
    if (!campaign || !isDateString(campaign.start) || !isDateString(campaign.end)) continue;
    if (daysBetween(campaign.start, item.publishDate) < 0 || daysBetween(item.publishDate, campaign.end) < 0) {
      issues.warn(
        `content.json "${item.id}"`,
        `publishes ${item.publishDate}, outside "${campaign.id}" (${campaign.start} to ${campaign.end})`,
      );
    }
  }
}

/** Validate a loaded dataset. Returns `{ ok, errors, warnings, issues }`. */
export function validate(db) {
  const issues = new Issues();

  for (const [key, value] of Object.entries(db)) {
    if (key !== 'config' && !Array.isArray(value)) issues.error(`${key}.json`, 'expected a JSON array');
  }
  if (issues.list.length > 0) {
    return summarize(issues);
  }

  checkConfig(issues, db.config);
  const teamIds = new Set((db.config.team ?? []).map((member) => member.id));
  const channelIds = new Set(db.channels.map((channel) => channel.id));
  const campaignIds = new Set(db.campaigns.map((campaign) => campaign.id));
  const segmentIds = new Set(db.icp.map((segment) => segment.id));

  checkChannels(issues, db.channels, teamIds);
  checkCampaigns(issues, db.campaigns, { channelIds, segmentIds, teamIds });
  checkContent(issues, db.content, { channelIds, campaignIds, teamIds });
  checkMetrics(issues, db.metrics, channelIds);
  checkRollups(issues, db);

  return summarize(issues);
}

function summarize(issues) {
  const errors = issues.list.filter((issue) => issue.level === 'error');
  const warnings = issues.list.filter((issue) => issue.level === 'warning');
  return { ok: errors.length === 0, errors, warnings, issues: issues.list };
}

export const enums = { CAMPAIGN_STATUSES, CONTENT_STATUSES, CONTENT_TYPES };
