/**
 * The PrismaClient for the process, with recovery from engine panics.
 *
 * Two problems are handled here, both learned from production on shared hosting.
 *
 * 1. Pool sizing. Prisma's default connection pool is `cpus * 2 + 1`, and the
 *    CPU count it sees on a shared host is the *physical machine's*, not the
 *    slice the account is allowed. On a 32-core host that is a 65-connection
 *    pool from one process — which exhausts a hosted Postgres' connection
 *    allowance and inflates the engine's thread usage for no benefit. A modest
 *    explicit limit is applied unless the URL already states one.
 *
 * 2. Engine panics. A Rust panic (`PANIC: timer has gone away`) permanently
 *    poisons the client instance: every later query on it fails the same way,
 *    so a single panic would otherwise take the database down until somebody
 *    restarts the process by hand. On a constrained host the panic is usually a
 *    *transient* resource failure — the engine could not spawn a thread at that
 *    moment — so the instance is replaced and the next attempt is allowed to
 *    succeed. The panic is still reported in full; nothing is swallowed.
 *
 * Construction stays lazy: `new PrismaClient()` neither connects nor loads the
 * query engine, which is what lets the HTTP server bind its port before any
 * database work happens.
 */

import { PrismaClient } from '@prisma/client';
import { isProd } from '../env.js';

/**
 * Connections per process. Deliberately small: this app is one process serving
 * a modest number of users, and a hosted Postgres (Supabase's pooler included)
 * charges for connections. Override with DATABASE_CONNECTION_LIMIT, or by
 * putting `connection_limit` in DATABASE_URL, which always wins.
 */
const DEFAULT_CONNECTION_LIMIT = 5;

/**
 * Add `connection_limit` unless the URL already carries one.
 *
 * Returns the input untouched if it cannot be parsed — an invalid URL is the
 * datasource's problem to report, with a far better message than anything this
 * function could produce.
 */
function withConnectionLimit(raw: string | undefined): string | undefined {
  if (!raw) return raw;

  try {
    const url = new URL(raw);
    if (url.searchParams.has('connection_limit')) return raw;

    const configured = Number(process.env.DATABASE_CONNECTION_LIMIT);
    const limit = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CONNECTION_LIMIT;
    url.searchParams.set('connection_limit', String(limit));
    return url.toString();
  } catch {
    return raw;
  }
}

function createClient(): PrismaClient {
  return new PrismaClient({
    // `error` only in production: Prisma's own logger already prints engine
    // panics in full, and `query` logging would leak parameter values.
    log: isProd ? ['error'] : ['error', 'warn'],
    // Read explicitly from the environment rather than relying on Prisma's own
    // dotenv lookup, which finds nothing on a host that injects the environment
    // (the deploy log shows "tryLoadEnv: No Environment variables loaded").
    datasources: { db: { url: withConnectionLimit(process.env.DATABASE_URL) } },
  });
}

/**
 * One instance per process, cached on `globalThis` so a dev watcher re-running
 * this module reuses it instead of leaking a client (and its pool) per reload.
 */
const globalForPrisma = globalThis as unknown as { __marketingOsPrisma?: PrismaClient };

let current: PrismaClient = globalForPrisma.__marketingOsPrisma ?? createClient();
if (!isProd) globalForPrisma.__marketingOsPrisma = current;

/**
 * Replace the poisoned client after a panic.
 *
 * The old instance is disconnected in the background: it has already panicked,
 * so the call may itself reject, and waiting on it would block recovery. The
 * caller gets a usable client immediately.
 */
export function resetPrismaClient(): void {
  const dead = current;
  current = createClient();
  if (!isProd) globalForPrisma.__marketingOsPrisma = current;

  void dead.$disconnect().catch(() => {
    // Expected — a panicked engine frequently cannot shut down cleanly. There
    // is nothing useful to report and nothing to be done about it.
  });
}

/**
 * Stable handle over a swappable instance.
 *
 * Every module imports `prisma` once at load time, so replacing the client has
 * to be invisible to them — a plain `export let` would leave every importer
 * holding the dead instance. Methods are bound to the live client because
 * Prisma's own methods depend on their receiver.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(current, property, receiver) as unknown;
    return typeof value === 'function' ? value.bind(current) : value;
  },
  has: (_target, property) => property in current,
  ownKeys: () => Reflect.ownKeys(current),
  getOwnPropertyDescriptor: (_target, property) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
    // A proxy may only report a non-existent property as configurable.
    return descriptor && { ...descriptor, configurable: true };
  },
});

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
