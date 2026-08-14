#!/usr/bin/env node
/**
 * Confirm the generated Prisma Client matches what the schema asked for.
 *
 * Prisma bakes the engine type into the client at generate time and reports
 * nothing at runtime if the wrong one was produced — the failure surfaces much
 * later as a panic or a missing-engine error in production. `npm run build`
 * runs this so a mismatch stops the build instead of shipping.
 *
 * Checks, in order:
 *   1. a client was generated at all
 *   2. its engine type is the one the schema requests
 *   3. an engine exists for every binaryTarget the schema lists
 *
 * Exits non-zero with an explanation on failure. Reads only generated output —
 * no database, no network, no secrets.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = resolve(ROOT, 'node_modules/.prisma/client');
const SCHEMA = resolve(ROOT, 'prisma/schema.prisma');

const LINE = '='.repeat(72);

function fail(title, lines) {
  process.stderr.write(['', LINE, ` ${title}`, LINE, '', ...lines, '', LINE, ''].join('\n') + '\n');
  process.exit(1);
}

// --- what the schema asks for -------------------------------------------------

const schema = readFileSync(SCHEMA, 'utf8');

// The env var overrides the schema at generate time, so it decides the expectation.
const schemaEngine = schema.match(/engineType\s*=\s*"([a-z]+)"/)?.[1];
const expectedEngine = process.env.PRISMA_CLIENT_ENGINE_TYPE || schemaEngine || 'library';

const targets = (schema.match(/binaryTargets\s*=\s*\[([^\]]*)\]/)?.[1] ?? '')
  .split(',')
  .map((entry) => entry.trim().replace(/^"|"$/g, ''))
  .filter(Boolean)
  // `native` resolves to whatever built the client; it cannot be checked by name.
  .filter((target) => target !== 'native');

// --- what was actually generated ---------------------------------------------

if (!existsSync(CLIENT_DIR)) {
  fail('PRISMA CLIENT NOT GENERATED', [
    ` Expected: ${CLIENT_DIR}`,
    '',
    ' `npm install` runs `prisma generate` via postinstall. If the install was',
    ' skipped or run with --ignore-scripts, run `npx prisma generate` and rebuild.',
  ]);
}

const files = readdirSync(CLIENT_DIR);

// Prisma records the engine it generated for in the client's own config.
const indexPath = resolve(CLIENT_DIR, 'index.js');
const generatedEngine = existsSync(indexPath)
  ? readFileSync(indexPath, 'utf8').match(/engineType"?\s*:\s*"([a-z]+)"/)?.[1]
  : undefined;

if (generatedEngine && generatedEngine !== expectedEngine) {
  fail('PRISMA CLIENT GENERATED WITH THE WRONG ENGINE', [
    ` Expected: ${expectedEngine}`,
    ` Found:    ${generatedEngine}`,
    '',
    ' The engine type is fixed when the client is generated — it cannot be',
    ' changed by setting a variable at runtime. Re-run the install/build with',
    ' the intended PRISMA_CLIENT_ENGINE_TYPE, or remove it to use the schema.',
  ]);
}

// --- an engine per requested target ------------------------------------------

// Binary engines are `query-engine-<target>`; library engines are
// `libquery_engine-<target>.so.node`.
const engineFor = (target) =>
  expectedEngine === 'binary'
    ? files.includes(`query-engine-${target}`)
    : files.includes(`libquery_engine-${target}.so.node`);

const missing = targets.filter((target) => !engineFor(target));

if (missing.length > 0) {
  fail('PRISMA ENGINE MISSING FOR A REQUESTED PLATFORM', [
    ` Engine type: ${expectedEngine}`,
    ` Missing:     ${missing.join(', ')}`,
    '',
    ` Present in ${CLIENT_DIR}:`,
    ...files.filter((file) => /engine/i.test(file)).map((file) => `   ${file}`),
    '',
    ' Re-run `npx prisma generate`. If it cannot download engines, the build',
    ' machine has no route to binaries.prisma.sh.',
  ]);
}

const present = files.filter((file) => /^(query-engine-|libquery_engine-)/.test(file));
process.stdout.write(
  `[prisma] engine "${expectedEngine}" verified; ${present.length} engine file(s): ${present.join(', ')}\n`,
);
