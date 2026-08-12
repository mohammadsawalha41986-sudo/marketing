/** Applies migrations to the test database once before any suite runs. */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/lib/prisma.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

beforeAll(() => {
  execSync('npx prisma migrate deploy', {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
