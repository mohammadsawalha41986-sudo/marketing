/**
 * Database reachability, tracked out of band from HTTP startup.
 *
 * The server must bind its port immediately — a managed host that sees no
 * listener within a few seconds kills the process, and a database check in
 * front of `listen()` turns a slow or unreachable database into an
 * unrecoverable boot loop. So connectivity is probed *after* the server is
 * listening, and a failure degrades the app rather than preventing it from
 * starting.
 *
 * Nothing here hides a failure: the status is reported by /api/health, the
 * diagnostic is written to the log in full, and every route that needs the
 * database still fails loudly on its own terms.
 */

import { prisma, resetPrismaClient } from './prisma.js';
import { threadCount } from './runtime-report.js';

export type DbState = 'connecting' | 'ok' | 'unreachable';

interface DbHealth {
  state: DbState;
  /** First line of the driver error, for the log and /api/health. Never the URL. */
  lastError: string | null;
  checkedAt: string | null;
  /** True when the query engine itself is the problem, which needs a different remedy. */
  enginePanic: boolean;
  /** How many times a poisoned client has been replaced, for /api/health. */
  panicRecoveries: number;
}

const health: DbHealth = {
  state: 'connecting',
  lastError: null,
  checkedAt: null,
  enginePanic: false,
  panicRecoveries: 0,
};

export const dbHealth = (): Readonly<DbHealth> => health;

/**
 * The one line worth reporting out of a Prisma error.
 *
 * Prisma messages are multi-line, start blank, and open with a wrapper line
 * like "Invalid `prisma.$queryRaw()` invocation:" that says nothing about what
 * actually went wrong — the real cause ("Can't reach database server at …",
 * "Authentication failed against database server") is the line after it. Take
 * the first line that is not that wrapper, so the log names the fault instead
 * of naming the call that hit it.
 *
 * Nothing here reconstructs the connection string: these driver messages carry
 * host and port at most, never the password.
 */
function firstLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw.split('\n').map((part) => part.trim()).filter(Boolean);
  const meaningful = lines.find((line) => !/^Invalid `.*` invocation/.test(line));
  return meaningful ?? lines[0] ?? 'unknown driver error';
}

/**
 * The engine — not the database — is the problem. Two distinct shapes, both
 * confirmed by killing the engine's child process under load rather than by
 * reading the docs:
 *
 * 1. A literal Rust panic trace (`PrismaClientRustPanicError`, or `PANIC:`
 *    somewhere in the message — it sits several lines into the trace, so only
 *    the summary line is not enough).
 * 2. With the binary engine specifically, the engine runs as a child process
 *    that Prisma talks to over a loopback port. When that child has just died
 *    (killed by the same thread exhaustion, mid-respawn) the *parent* sees a
 *    bare `connect ECONNREFUSED 127.0.0.1:<port>` — no panic text at all,
 *    because nothing caught and formatted it. This is easy to mistake for an
 *    ordinary "database unreachable", which would point someone at
 *    credentials or SSL instead of the real cause. It is distinguished from a
 *    genuine unreachable *database* by what is absent: a real connection
 *    failure is caught by the engine and always carries "Can't reach database
 *    server" in the message; a dead engine child never gets that far.
 *
 * Confirmed empirically: repeatedly killing the engine's own child process
 * eventually produces exactly the shape in (2), and a normal bad DATABASE_URL
 * never does — it always produces "Can't reach database server at …".
 */
export function isEnginePanic(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'PrismaClientRustPanicError') return true;

  const raw = error instanceof Error ? error.message : String(error);
  if (/PANIC:/.test(raw)) return true;

  const code = (error as { code?: string } | null)?.code;
  const engineUnreachable = code === 'ECONNREFUSED' || /connect ECONNREFUSED/.test(raw);
  const realDatabaseFailure = /Can't reach database server/.test(raw);
  return engineUnreachable && !realDatabaseFailure;
}

async function ping(timeoutMs: number): Promise<void> {
  // The engine can hang rather than reject on a wedged connection, so the probe
  // carries its own deadline and never leaves the caller waiting indefinitely.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Database did not answer within ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Single check used by /api/health. Updates the cached state as a side effect. */
export async function checkDatabase(timeoutMs = 4000): Promise<Readonly<DbHealth>> {
  try {
    await ping(timeoutMs);
    health.state = 'ok';
    health.lastError = null;
    health.enginePanic = false;
    clearRecoveryBudget();
  } catch (error) {
    health.state = 'unreachable';
    health.lastError = firstLine(error);
    health.enginePanic = isEnginePanic(error);

    // A panic poisons the instance: every later query fails identically until
    // something replaces it. Swap it out so the next attempt starts from a
    // clean engine — on a constrained host the panic is usually a transient
    // failure to spawn a thread, and the retry genuinely can succeed.
    if (health.enginePanic) recoverFromPanic();
  }
  health.checkedAt = new Date().toISOString();
  return health;
}

/**
 * Replacing the client is bounded on purpose.
 *
 * If the host genuinely has no thread budget, a fresh engine panics exactly like
 * the old one, and replacing it on every failed query would spin — burning the
 * little headroom that remains and burying the real cause in repeated traces.
 * So replacement is rate-limited and capped: past the cap the app stays degraded
 * and says why, which is the honest outcome. A successful query clears both,
 * because that means the exhaustion really was transient.
 */
const RECOVERY_COOLDOWN_MS = 30_000;
const MAX_CONSECUTIVE_RECOVERIES = 5;

let consecutiveRecoveries = 0;
let lastRecoveryAt = 0;
let capReported = false;

function recoverFromPanic(): void {
  const now = Date.now();
  if (now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;

  if (consecutiveRecoveries >= MAX_CONSECUTIVE_RECOVERIES) {
    if (!capReported) {
      capReported = true;
      process.stderr.write(
        `[marketing-os] prisma engine panicked ${consecutiveRecoveries} times in a row — ` +
          'no longer replacing the client. This is not transient: the host cannot give the ' +
          'engine a thread. See the DATABASE UNREACHABLE block above for what to change. ' +
          'Recovery resumes automatically if a query ever succeeds.\n',
      );
    }
    return;
  }

  consecutiveRecoveries += 1;
  health.panicRecoveries += 1;
  lastRecoveryAt = now;

  const threads = threadCount();
  process.stderr.write(
    `[marketing-os] prisma engine panic (#${health.panicRecoveries}) — replacing the client` +
      `${threads === null ? '' : `; process threads: ${threads}`}\n`,
  );
  resetPrismaClient();
}

/** A working query proves the engine is healthy again; allow recovery afresh. */
function clearRecoveryBudget(): void {
  consecutiveRecoveries = 0;
  capReported = false;
}

/**
 * The state for /api/health, re-checked at most every few seconds.
 *
 * The endpoint is unauthenticated and a host may poll it often. Running a live
 * query per request is wasteful when healthy and actively harmful when not —
 * against a panicking engine every call produces another panic and another
 * trace. A few seconds of staleness costs nothing: a probe that polls more
 * often than this cannot act on the difference anyway.
 */
const READINESS_MAX_AGE_MS = 5000;

export async function readiness(): Promise<Readonly<DbHealth>> {
  const age = health.checkedAt ? Date.now() - Date.parse(health.checkedAt) : Infinity;
  if (age < READINESS_MAX_AGE_MS) return health;
  return checkDatabase();
}

const LINE = '='.repeat(72);

function reportFailure(): void {
  const shared = [
    '',
    LINE,
    ' DATABASE UNREACHABLE — the app is running, but database routes will fail',
    LINE,
    '',
    ` Last error: ${health.lastError}`,
    '',
  ];

  const remedy = health.enginePanic
    ? [
        ' The Prisma query engine could not be reached. The connection was never',
        ' attempted, so this is not a credentials problem. Two log shapes mean the',
        ' same thing:',
        '   - a literal "PANIC: timer has gone away" trace, or',
        '   - a bare "connect ECONNREFUSED 127.0.0.1:<port>" with no "Can\'t reach',
        '     database server" text — that is the engine\'s own child process,',
        '     already dead, not the Postgres connection.',
        '',
        ' Root cause: the engine failed to spawn a thread. On shared hosting that',
        ' means the account\'s process/thread allowance is exhausted — the engine is',
        ' the victim, not the cause. This app already runs the engine as its own',
        ' child process (binaryTargets + engineType=binary in schema.prisma) to keep',
        ' its threads out of the Node process; if it still panics, reduce the',
        ' remaining demand, in this order:',
        '',
        ' 1. Stop other processes on the account. Old deployment versions left',
        '    running are the usual culprit — restart the app from the host panel so',
        '    only the current version is live.',
        ' 2. Set UV_THREADPOOL_SIZE=2 in the host environment (measured: 9 threads',
        '    down to 7 for the Node process).',
        ' 3. Set DATABASE_CONNECTION_LIMIT=2 (default 5; Prisma\'s own default is',
        '    CPUs * 2 + 1, sized from the whole host, not this account\'s slice).',
        '',
        ' The engine child usually respawns on its own — Prisma retries internally',
        ' before this is ever reported. The client is replaced here as a second line',
        ' of defence, bounded so a genuinely exhausted host cannot be spun on',
        ' forever. Repeated recoveries mean the ceiling is still too low.',
      ]
    : [
        ' Check, in this order:',
        '   1. DATABASE_URL is set on the host (never read from a file in production)',
        '   2. Host, port, database name, user and password are correct',
        '   3. The database accepts connections from this server',
        '   4. A hosted provider usually requires SSL: append ?sslmode=require',
        '   5. Migrations have been applied: npx prisma migrate deploy',
      ];

  process.stderr.write(
    [
      ...shared,
      ...remedy,
      '',
      ' The connection string is not printed here on purpose — it contains a password.',
      ' /api/health reports "degraded" until this clears.',
      LINE,
      '',
    ].join('\n'),
  );
}

/**
 * Probe in the background, then keep watching so the app recovers on its own if
 * the database was merely slow to come up alongside it.
 */
export function startDatabaseProbe(): void {
  const attempts = 3;

  void (async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await checkDatabase();

      if (health.state === 'ok') {
        // Report threads *after* the engine is up: that is the figure that has
        // to fit under the host's ceiling, and it is the one the panic is about.
        const threads = threadCount();
        process.stdout.write(
          `[marketing-os] database connected${threads === null ? '' : ` (process threads: ${threads})`}\n`,
        );
        scheduleWatch();
        return;
      }

      if (attempt < attempts) {
        await new Promise((done) => setTimeout(done, attempt * 1000));
      }
    }

    reportFailure();
    scheduleWatch();
  })();
}

/** Slow background re-check, so recovery is noticed without hammering a dead engine. */
function scheduleWatch(): void {
  const timer = setInterval(() => {
    const wasOk = health.state === 'ok';
    void checkDatabase().then(() => {
      if (!wasOk && health.state === 'ok') {
        process.stdout.write('[marketing-os] database recovered\n');
      } else if (wasOk && health.state === 'unreachable') {
        process.stderr.write(`[marketing-os] database became unreachable: ${health.lastError}\n`);
      }
    });
  }, 60_000);

  // Must not hold the event loop open and stop the process exiting.
  timer.unref();
}
