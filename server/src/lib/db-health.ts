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
  /** True when the Rust query engine panicked, which needs a different remedy. */
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
 * A Rust panic poisons the client instance — Prisma's own guidance is that the
 * process must be restarted, so retrying the same client only reproduces it.
 * Worth naming precisely, because the remedy is completely different from an
 * ordinary connection failure.
 */
function isEnginePanic(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'PrismaClientRustPanicError') return true;
  // Match the whole message, not just the summary line: the panic text sits
  // several lines into the trace ("PANIC: timer has gone away" is the one seen
  // in production), so testing a single line would miss it.
  const raw = error instanceof Error ? error.message : String(error);
  return /PANIC:/.test(raw);
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

/** Replace the poisoned client, reporting the swap and the thread count with it. */
function recoverFromPanic(): void {
  health.panicRecoveries += 1;
  const threads = threadCount();
  process.stderr.write(
    `[marketing-os] prisma engine panic (#${health.panicRecoveries}) — replacing the client` +
      `${threads === null ? '' : `; process threads: ${threads}`}\n`,
  );
  resetPrismaClient();
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
        ' The Prisma query engine panicked while starting. The connection was never',
        ' attempted, so this is not a credentials problem.',
        '',
        ' "PANIC: timer has gone away" comes from the engine failing to spawn its',
        ' timer thread. On shared hosting that means the account\'s process/thread',
        ' allowance is exhausted — the engine is the victim, not the cause. Reduce',
        ' the demand, in this order:',
        '',
        ' 1. Stop other processes on the account. Old deployment versions left',
        '    running are the usual culprit — restart the app from the host panel so',
        '    only the current version is live.',
        ' 2. Lower the thread demand of this process. Each pool below sizes itself',
        '    from the CPU count the host reports, which on shared hosting is the',
        '    whole machine\'s, not your slice:',
        '      - `npm start` already passes --v8-pool-size=2',
        '      - DATABASE_CONNECTION_LIMIT (default 5) caps the connection pool',
        '      - UV_THREADPOOL_SIZE=2 in the host environment saves two more',
        ' 3. If it still panics, switch to the binary engine, which runs the engine',
        '    in its own process: set PRISMA_CLIENT_ENGINE_TYPE=binary in the host',
        '    environment, then redeploy so npm install / prisma generate runs WITH',
        '    it set. The engine type is baked in at generate time — setting this',
        '    variable only at runtime is silently ignored and changes nothing.',
        '',
        ' The client is replaced automatically after a panic, so a transient',
        ' exhaustion recovers without a manual restart. Repeated recoveries mean',
        ' the ceiling is genuinely too low for the current configuration.',
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
