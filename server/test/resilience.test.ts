/**
 * Startup and engine-resilience behaviour.
 *
 * These cover the machinery that keeps the app alive on constrained shared
 * hosting, where the query engine cannot spawn a thread. That shows up two
 * ways: a literal "PANIC: timer has gone away" trace, or — with the binary
 * engine, which runs the engine as its own child process — a bare
 * "connect ECONNREFUSED" once that child has died. Both need the same
 * diagnosis and the same recovery; the health-detection tests below prove the
 * second shape is actually caught, not just assumed to look like the first.
 */

import { describe, expect, it } from 'vitest';

import request from 'supertest';

import { app } from './helpers.js';
import { prisma, resetPrismaClient } from '../src/lib/prisma.js';
import { checkDatabase, dbHealth, isEnginePanic, readiness } from '../src/lib/db-health.js';
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
    await expect(prisma.restaurant.count()).resolves.toBeTypeOf('number');
    await expect(prisma.$transaction(async (tx) => tx.restaurant.count())).resolves.toBeTypeOf('number');
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

  it('serves readiness from cache so polling cannot hammer the engine', async () => {
    await checkDatabase();
    const first = (await readiness()).checkedAt;
    const second = (await readiness()).checkedAt;
    // Inside the cache window the timestamp must not move — that is the proof
    // no second query was issued.
    expect(second).toBe(first);
  });

  it('classifies a dead engine child as an engine problem, not "database unreachable"', async () => {
    // Proves the fix for a real gap: with the binary engine, a dead engine
    // child does not surface as "PANIC:" text at all — it surfaces to Node as
    // a bare `connect ECONNREFUSED` on the loopback port Prisma talks to the
    // engine over, because nothing caught and formatted it. Reproduced by
    // actually killing the engine's child process (see the session record);
    // asserted here as a unit case so the classifier's contract is pinned down
    // without the flakiness and cross-test disruption of killing a real
    // process inside the suite.
    const engineChildDied = new Error(
      "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nconnect ECONNREFUSED 127.0.0.1:42829",
    ) as Error & { code?: string };
    engineChildDied.code = 'ECONNREFUSED';

    expect(isEnginePanic(engineChildDied)).toBe(true);
  });

  it('does not confuse a genuinely unreachable database with a dead engine', async () => {
    // The distinguishing signal: a real connection failure is caught by the
    // engine and always carries this text; a dead engine child never gets that
    // far to say it. Getting this wrong either way is a real regression — one
    // direction hides a resource-exhaustion outage as a credentials problem,
    // the other panics-recovers a database that just needs its URL fixed.
    const databaseDown = new Error(
      "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `127.0.0.1:59999`\n\n" +
        'Please make sure your database server is running at `127.0.0.1:59999`.',
    );

    expect(isEnginePanic(databaseDown)).toBe(false);
  });

  it('still recognizes the original in-process panic shape', async () => {
    const libraryPanic = new Error('PANIC: timer has gone away');
    libraryPanic.name = 'PrismaClientRustPanicError';
    expect(isEnginePanic(libraryPanic)).toBe(true);

    const panicTraceOnly = new Error('some wrapper text\nPANIC: timer has gone away\nmore trace');
    expect(isEnginePanic(panicTraceOnly)).toBe(true);
  });
});

describe('/api/health', () => {
  it('reports healthy with the engine state, and leaks nothing', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
    expect(response.body.database).toBe('ok');
    expect(response.body.engine).toBe('ok');
    expect(response.body).toHaveProperty('engineRecoveries');

    // No connection string, no versions, no paths — an unauthenticated endpoint.
    expect(JSON.stringify(response.body)).not.toMatch(/postgres(ql)?:\/\/|password|secret/i);
  });
});

describe('authentication against the real engine', () => {
  it('runs user.findUnique — the exact call that panicked in production', async () => {
    // Guards the whole login path at the query layer: if the engine cannot
    // start, this is where it fails, and it fails here before users see it.
    await expect(
      prisma.user.findUnique({ where: { email: 'nobody@example.com' }, select: { id: true } }),
    ).resolves.toBeNull();
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
