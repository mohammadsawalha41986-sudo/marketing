/**
 * Startup and engine-resilience behaviour.
 *
 * These cover the machinery that keeps the app alive on constrained shared
 * hosting, where the Rust query engine panics with "PANIC: timer has gone away"
 * because it cannot spawn a thread. That panic poisons the client permanently,
 * so the swap-and-continue path below is the difference between a blip and an
 * outage that needs a human to restart the process.
 */

import { describe, expect, it } from 'vitest';

import { prisma, resetPrismaClient } from '../src/lib/prisma.js';
import { checkDatabase, dbHealth } from '../src/lib/db-health.js';
import { runtimeReport, threadCount } from '../src/lib/runtime-report.js';

describe('prisma client handle', () => {
  it('queries through the proxy', async () => {
    const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 as one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('keeps working after the client is replaced', async () => {
    // Modules import `prisma` once at load time, so a swap has to be invisible
    // to every existing importer — this is the property the whole recovery path
    // depends on.
    await prisma.$queryRaw`SELECT 1`;
    resetPrismaClient();

    const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 as one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('still exposes model delegates and transactions after a replacement', async () => {
    resetPrismaClient();

    // A bound method and a delegate object take different paths through the
    // proxy, so both are worth asserting.
    await expect(prisma.organization.count()).resolves.toBeTypeOf('number');
    await expect(prisma.$transaction(async (tx) => tx.organization.count())).resolves.toBeTypeOf('number');
  });
});

describe('database health', () => {
  it('reports ok against a reachable database', async () => {
    const health = await checkDatabase();
    expect(health.state).toBe('ok');
    expect(health.enginePanic).toBe(false);
    expect(health.lastError).toBeNull();
    expect(dbHealth().state).toBe('ok');
  });

  it('never puts the connection string in the reported error', async () => {
    const health = await checkDatabase();
    expect(health.lastError ?? '').not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe('runtime report', () => {
  it('counts this process\'s threads', () => {
    const threads = threadCount();
    // Null off Linux; a real process always has at least a main thread.
    expect(threads === null || threads >= 1).toBe(true);
  });

  it('names the numbers that decide the engine panic, and no secrets', () => {
    const report = runtimeReport().join('\n');
    expect(report).toMatch(/cpus visible/);
    expect(report).toMatch(/threads now/);
    expect(report).not.toMatch(/postgres(ql)?:\/\//);
  });
});
