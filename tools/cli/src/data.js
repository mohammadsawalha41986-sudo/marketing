/** Loading and indexing of the JSON files under `data/`. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');

const FILES = {
  config: 'config.json',
  icp: 'icp.json',
  channels: 'channels.json',
  campaigns: 'campaigns.json',
  content: 'content.json',
  metrics: 'metrics.json',
};

function readJson(dir, file) {
  const path = join(dir, file);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

/** Read the whole dataset. Pass a directory to load a fixture instead. */
export function load(dir = DATA_DIR) {
  const db = {};
  for (const [key, file] of Object.entries(FILES)) db[key] = readJson(dir, file);
  return db;
}

export function indexById(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

export function personName(db, id) {
  return db.config.team.find((member) => member.id === id)?.name ?? id;
}

export function channelName(db, id) {
  return db.channels.find((channel) => channel.id === id)?.name ?? id;
}

export function campaignName(db, id) {
  if (!id) return '—';
  return db.campaigns.find((campaign) => campaign.id === id)?.name ?? id;
}
