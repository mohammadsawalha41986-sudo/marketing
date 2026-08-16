#!/usr/bin/env node
/**
 * Confirm the live database actually has the schema Prisma believes it applied.
 *
 * `prisma migrate deploy` reports success from one source of truth only: the
 * `_prisma_migrations` bookkeeping table. If a migration is recorded there but
 * its objects are not in the database — a migration interrupted mid-apply, a
 * record carried over from a database that was later replaced, a manual
 * `migrate resolve` — then `deploy` prints "No pending migrations to apply" and
 * the container boots straight into a broken app. That is exactly how this
 * deployment failed every hour with:
 *
 *     The table `public.Session` does not exist in the current database.
 *
 * The bookkeeping said everything was applied; the tables were absent.
 *
 * So this checks the thing migrations exist to produce: the tables themselves.
 * It runs after `migrate deploy` in the pre-deploy step, which is the last
 * moment a bad schema can be caught before a container starts taking traffic.
 *
 * Read-only. It runs SELECTs against catalog views and nothing else — it never
 * creates, alters or drops anything, and it never touches application rows.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LINE = '='.repeat(72);

/** Every `model` in the schema is a table that must exist. */
function modelsInSchema() {
  const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
}

const prisma = new PrismaClient();

try {
  const expected = modelsInSchema();

  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;
  const present = new Set(tables.map((row) => row.tablename));

  // Reported even when everything is fine: when a schema problem does appear,
  // this is the record of what the database looked like on the last good deploy.
  const migrations = present.has('_prisma_migrations')
    ? await prisma.$queryRaw`
        SELECT migration_name, finished_at, applied_steps_count, rolled_back_at
        FROM "_prisma_migrations" ORDER BY started_at
      `
    : [];

  process.stdout.write(
    [
      '',
      `[schema-check] tables in public: ${present.size}`,
      `[schema-check] models in schema: ${expected.length}`,
      ...migrations.map(
        (row) =>
          `[schema-check] migration ${row.migration_name}` +
          ` finished=${row.finished_at ? row.finished_at.toISOString() : 'null'}` +
          ` steps=${row.applied_steps_count}` +
          ` rolledBack=${row.rolled_back_at ? row.rolled_back_at.toISOString() : 'null'}`,
      ),
      '',
    ].join('\n'),
  );

  const missing = expected.filter((model) => !present.has(model));

  if (missing.length > 0) {
    process.stderr.write(
      [
        '',
        LINE,
        ' DATABASE SCHEMA DOES NOT MATCH THE MIGRATIONS THAT ARE RECORDED',
        LINE,
        '',
        ` Missing ${missing.length} of ${expected.length} tables:`,
        ...missing.map((model) => `   ${model}`),
        '',
        ' `prisma migrate deploy` already counts them as applied, so it will not',
        ' create them and will keep reporting "No pending migrations to apply".',
        '',
        ' Repair without losing data — from a shell with DATABASE_URL set:',
        '',
        '   1. Confirm the database is the one you expect and take a backup.',
        '   2. Mark the recorded-but-unapplied migration as rolled back:',
        '        npx prisma migrate resolve --rolled-back <migration_name>',
        '   3. Re-apply it:',
        '        npx prisma migrate deploy',
        '',
        ' Never run `prisma migrate reset` on a live database: it drops every',
        ' table and every row in it.',
        '',
        LINE,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  process.stdout.write(`[schema-check] all ${expected.length} tables present\n`);
} finally {
  await prisma.$disconnect();
}
