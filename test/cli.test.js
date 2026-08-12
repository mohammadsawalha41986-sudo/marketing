import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT } from '../src/data.js';
import { parseArgs } from '../src/cli.js';

const MOS = join(ROOT, 'bin', 'mos.js');

function mos(args, { expectFailure = false } = {}) {
  try {
    return execFileSync(process.execPath, [MOS, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
  } catch (err) {
    if (expectFailure) return err.stdout ?? '';
    throw new Error(`mos ${args.join(' ')} exited ${err.status}\n${err.stdout}\n${err.stderr}`);
  }
}

test('parseArgs separates positionals from flags', () => {
  assert.deepEqual(parseArgs(['calendar', '--weeks', '8', '--json']), {
    positional: ['calendar'],
    flags: { weeks: '8', json: true },
  });
});

test('a flag followed by another flag is a boolean, not a value', () => {
  assert.deepEqual(parseArgs(['report', '--stdout', '--as-of', '2026-08-09']).flags, {
    stdout: true,
    'as-of': '2026-08-09',
  });
});

test('mos validate passes on the committed data', () => {
  assert.match(mos(['validate']), /data\/ is valid/);
});

test('mos status reports the quarter without blowing up', () => {
  const output = mos(['status', '--as-of', '2026-08-09']);
  assert.match(output, /ExampleCo — 2026-Q3/);
  assert.match(output, /day 40\/92/);
  assert.ok(output.includes('Pipeline'));
  assert.ok(!output.includes('NaN'));
});

test('mos status --json emits parseable JSON', () => {
  const parsed = JSON.parse(mos(['status', '--json', '--as-of', '2026-08-09']));
  assert.equal(parsed.asOf, '2026-08-09');
  assert.equal(parsed.progress.daysElapsed, 40);
  assert.ok(parsed.channels.length > 0);
});

test('mos report --stdout writes markdown to stdout and no file', () => {
  const output = mos(['report', '--stdout', '--as-of', '2026-08-09']);
  assert.match(output, /^# ExampleCo weekly marketing report/);
  assert.ok(output.includes('**Data through:** 2026-08-09'));
});

test('mos build --stdout writes the dashboard to stdout', () => {
  const output = mos(['build', '--stdout', '--as-of', '2026-08-09']);
  assert.match(output, /^<!doctype html>/);
});

test('mos campaign shows one campaign and its content', () => {
  const output = mos(['campaign', 'platform-3-launch']);
  assert.ok(output.includes('Platform 3.0 Launch'));
  assert.ok(output.includes('Platform 3.0 launch blog'));
});

test('mos campaign on an unknown id fails with a usable message', () => {
  const output = mos(['campaign', 'does-not-exist'], { expectFailure: true });
  assert.match(output, /No campaign "does-not-exist"/);
});

test('mos calendar groups by week and flags quiet weeks', () => {
  const output = mos(['calendar', '--weeks', '4', '--as-of', '2026-08-12']);
  assert.ok(output.includes('Week of 2026-08-10'));
  assert.ok(output.includes('Late'));
});

test('an unknown command exits non-zero and prints help', () => {
  const output = mos(['frobnicate'], { expectFailure: true });
  assert.match(output, /Unknown command "frobnicate"/);
  assert.match(output, /mos status/);
});

test('mos help works without touching data', () => {
  assert.match(mos(['help']), /Marketing OS/);
});

test('piping into a command that closes early does not crash', () => {
  // `mos calendar | head` closes stdout mid-write; that must exit quietly.
  const output = execSync(`"${process.execPath}" "${MOS}" calendar --weeks 12 | head -5`, {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ok(output.length > 0);
  assert.ok(!output.includes('EPIPE'));
});
