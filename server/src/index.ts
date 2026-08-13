/**
 * Production entry point.
 *
 * Compiled to `server/dist/index.js`, which is what `npm start` runs and what a
 * managed host should be pointed at.
 *
 * Startup order is the important thing here, and it is deliberate:
 *
 *   1. validate configuration (synchronous, instant)
 *   2. call app.listen() — nothing may come before this
 *   3. everything else, in the background
 *
 * A managed host expects a listener within a few seconds and kills the process
 * otherwise. Any `await` in front of `listen()` — a database ping above all —
 * turns a slow dependency into an unrecoverable boot loop, so no dependency is
 * allowed to gate the port being bound. There is no `require.main === module`
 * guard: this file starts the server as soon as it is loaded, however it is
 * loaded.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp } from './app.js';
import { cookieSecure, env, hasOpenAi, isProd, REPO_ROOT, uploadDir } from './env.js';
import { startDatabaseProbe } from './lib/db-health.js';
import { prisma } from './lib/prisma.js';
import { pruneExpiredSessions } from './lib/session.js';

const LINE = '='.repeat(72);

function fatal(title: string, body: string[]): never {
  process.stderr.write(['', LINE, ` ${title}`, LINE, '', ...body, '', LINE, ''].join('\n'));
  process.exit(1);
}

function warn(lines: string[]): void {
  process.stderr.write(['', ...lines, ''].join('\n'));
}

/**
 * Pre-flight checks. Every one is synchronous and instant, and none of them
 * touches the network — they must not delay `listen()`.
 */
function preflight(): { hasWebBuild: boolean } {
  try {
    mkdirSync(uploadDir, { recursive: true });
  } catch (error) {
    // Not fatal: uploads break, the rest of the app works, and refusing to boot
    // over this would take the whole site down for one feature.
    warn([
      ' WARNING — the upload directory is not writable.',
      ` Path: ${uploadDir}`,
      ` Error: ${(error as Error).message}`,
      ' File uploads will fail. Point STORAGE_LOCAL_DIR at a writable path.',
    ]);
  }

  const hasWebBuild = existsSync(resolve(REPO_ROOT, 'web/dist/index.html'));
  if (!hasWebBuild) {
    warn([
      LINE,
      ' WARNING — the front end has not been built',
      LINE,
      ` Expected: ${resolve(REPO_ROOT, 'web/dist/index.html')}`,
      '',
      ' The API will run, but every page request returns 404 because there is',
      ' nothing to serve. The build command must include `npm run build`.',
      LINE,
    ]);
  }

  if (isProd && !cookieSecure) {
    warn([
      ' WARNING — COOKIE_SECURE is off in production.',
      ' Session cookies will be sent without the Secure flag. Only do this if the',
      ' site is genuinely served over plain HTTP. Once SSL is active, remove the',
      ' override so cookies cannot be read over an unencrypted connection.',
    ]);
  }

  return { hasWebBuild };
}

const { hasWebBuild } = preflight();

const app = createApp();

/*
 * Bind the port. `0.0.0.0` explicitly: a managed host routes to the container
 * address, not to loopback, and binding 127.0.0.1 yields a healthy-looking
 * process that never receives a request. `env.PORT` comes from the host — it is
 * never hardcoded, and only falls back to 3000 for local development.
 */
const server = app.listen(env.PORT, '0.0.0.0', () => {
  process.stdout.write(
    [
      '',
      '[marketing-os] started',
      `  environment    ${env.NODE_ENV}`,
      `  node           ${process.version}`,
      `  listening      0.0.0.0:${env.PORT}`,
      `  app url        ${env.APP_URL}`,
      `  uploads        ${uploadDir}`,
      `  front end      ${hasWebBuild ? 'served from web/dist' : 'NOT BUILT'}`,
      `  ai provider    ${hasOpenAi ? `openai:${env.OPENAI_MODEL}` : 'built-in template engine (no OPENAI_API_KEY)'}`,
      `  secure cookies ${cookieSecure ? 'on' : 'off'}`,
      `  trust proxy    ${env.TRUST_PROXY}`,
      `  database       checking in the background…`,
      '',
    ].join('\n'),
  );

  // Only now — with the port bound and the host satisfied — touch the database.
  // A failure here degrades the app and is reported by /api/health; it never
  // prevents startup and never exits the process.
  startDatabaseProbe();
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    fatal('MARKETING OS FAILED TO START — port already in use', [
      ` Port ${env.PORT} is taken by another process.`,
      '',
      ' On a managed host, PORT is injected — do not set it yourself unless the',
      ' host tells you to. Locally, stop whatever is already using the port.',
    ]);
  }
  fatal('MARKETING OS FAILED TO START — listen error', [` ${error.message}`]);
});

// Expired sessions are pruned hourly; `resolveSession` also drops them on read.
const pruneTimer = setInterval(() => {
  void pruneExpiredSessions().catch((error: Error) =>
    process.stderr.write(`[marketing-os] session prune failed: ${error.message}\n`),
  );
}, 60 * 60 * 1000);
pruneTimer.unref();

function shutdown(signal: string): void {
  process.stdout.write(`[marketing-os] ${signal} received, shutting down\n`);
  clearInterval(pruneTimer);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/*
 * A rejected promise that reaches here would otherwise end the process without
 * explanation, which on a managed host reads as an unexplained 503. Log it and
 * keep serving — an individual failed request must not take the site down.
 */
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `[marketing-os] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`[marketing-os] uncaught exception: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
