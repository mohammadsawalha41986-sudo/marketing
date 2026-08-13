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

import { prisma } from './prisma.js';

export type DbState = 'connecting' | 'ok' | 'unreachable';

interface DbHealth {
  state: DbState;
  /** First line of the driver error, for the log and /api/health. Never the URL. */
  lastError: string | null;
  checkedAt: string | null;
  /** True when the Rust query engine panicked, which needs a different remedy. */
  enginePanic: boolean;
}

const health: DbHealth = { state: 'connecting', lastError: null, checkedAt: null, enginePanic: false };

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
  }
  health.checkedAt = new Date().toISOString();
  return health;
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
        ' The Prisma query engine panicked while starting. This is an engine/platform',
        ' problem, not a credentials problem — the connection was never attempted.',
        '',
        ' 1. Confirm the engine for this runtime was generated. The schema requests',
        '    binaryTargets ["native", "debian-openssl-1.1.x"]; the deploy must run',
        '    `npx prisma generate` (it runs automatically via postinstall).',
        ' 2. If the panic persists, the library engine cannot be loaded into Node in',
        '    this sandbox. Switch to the binary engine, which runs as a separate',
        '    process instead of a shared library:',
        '      set PRISMA_CLIENT_ENGINE_TYPE=binary in the host environment, then',
        '      redeploy so that npm install / prisma generate runs WITH it set.',
        '    The engine type is baked into the generated client — setting this',
        '    variable only at runtime is silently ignored and changes nothing.',
        ' 3. A panic poisons the client, so the process must be restarted to recover.',
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
        process.stdout.write('[marketing-os] database connected\n');
        scheduleWatch();
        return;
      }

      // A panicked engine will panic identically on the next call, so stop
      // retrying immediately rather than flooding the log with the same trace.
      if (health.enginePanic) break;

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
