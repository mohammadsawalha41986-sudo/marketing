/**
 * The single PrismaClient for the process.
 *
 * One instance only. Each `new PrismaClient()` opens its own connection pool,
 * which against a pooled Postgres (Supabase's pooler included) exhausts the
 * connection allowance quickly. The `globalThis` cache additionally survives
 * module re-evaluation under a dev watcher, which would otherwise leak a client
 * on every reload.
 *
 * Construction is deliberately cheap and lazy: `new PrismaClient()` does not
 * connect and does not load the query engine. The engine is loaded on the first
 * query, which is what lets the HTTP server bind its port before any database
 * work happens.
 */

import { PrismaClient } from '@prisma/client';
import { isProd } from '../env.js';

const globalForPrisma = globalThis as unknown as { __marketingOsPrisma?: PrismaClient };

function createClient(): PrismaClient {
  return new PrismaClient({
    // `error` only in production: Prisma's own logger already prints engine
    // panics in full, and `query` logging would leak parameter values.
    log: isProd ? ['error'] : ['error', 'warn'],
    // Read explicitly from the environment rather than relying on Prisma's own
    // dotenv lookup, which finds nothing on a host that injects the environment
    // (the deploy log shows "tryLoadEnv: No Environment variables loaded").
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
}

export const prisma: PrismaClient = globalForPrisma.__marketingOsPrisma ?? createClient();

if (!isProd) globalForPrisma.__marketingOsPrisma = prisma;

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
