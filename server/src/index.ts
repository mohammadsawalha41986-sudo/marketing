/**
 * Production entry point.
 *
 * Compiled to `server/dist/index.js`, which is what `npm start` runs and what a
 * managed host should be pointed at. This file owns startup verification: on a
 * platform where a crashed process shows up only as "503 Service Unavailable",
 * the runtime log has to say precisely what was wrong.
 */

import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp } from './app.js';
import { cookieSecure, env, hasOpenAi, isProd, REPO_ROOT, uploadDir } from './env.js';
import { prisma } from './lib/prisma.js';
import { pruneExpiredSessions } from './lib/session.js';

const line = '='.repeat(72);

function fatal(title: string, body: string[]): never {
  process.stderr.write(['', line, ` ${title}`, line, '', ...body, '', line, ''].join('\n'));
  process.exit(1);
}

/**
 * Confirm the database is actually reachable before accepting traffic.
 *
 * Retried briefly, because a database and an app container often come up at the
 * same time and losing that race should not take the deployment down. If it
 * still fails we exit with a diagnostic rather than starting and serving 500s
 * from every route, which is far harder to trace back to its cause.
 */
async function verifyDatabase(): Promise<void> {
  const attempts = 5;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (error) {
      // Prisma messages are multi-line and often start blank; take the first
      // line that actually says something.
      const raw = error instanceof Error ? error.message : String(error);
      const message = raw.split('\n').map((part) => part.trim()).find(Boolean) ?? 'unknown driver error';

      if (attempt === attempts) {
        fatal('MARKETING OS FAILED TO START — cannot reach the database', [
          ` After ${attempts} attempts, PostgreSQL did not answer.`,
          '',
          ` Driver error: ${message}`,
          '',
          ' Check, in this order:',
          '   1. DATABASE_URL is set on the host (it is never read from a file in production)',
          '   2. The host, port, database name, user and password in it are correct',
          '   3. The database accepts connections from this server',
          '   4. A hosted provider may require SSL: append ?sslmode=require',
          '   5. Migrations have been applied: npx prisma migrate deploy',
          '',
          ' The connection string is not printed here on purpose — it contains a password.',
        ]);
      }
      const waitMs = attempt * 1000;
      process.stdout.write(`[marketing-os] database not ready (attempt ${attempt}/${attempts}), retrying in ${waitMs}ms\n`);
      await new Promise((done) => setTimeout(done, waitMs));
    }
  }
}

async function main(): Promise<void> {
  // The upload directory must exist before anything tries to write to it.
  try {
    mkdirSync(uploadDir, { recursive: true });
  } catch (error) {
    fatal('MARKETING OS FAILED TO START — upload directory is not writable', [
      ` Path: ${uploadDir}`,
      ` Error: ${(error as Error).message}`,
      '',
      ' Set STORAGE_LOCAL_DIR to a writable directory on persistent storage.',
    ]);
  }

  const webDist = resolve(REPO_ROOT, 'web/dist');
  const hasWebBuild = existsSync(resolve(webDist, 'index.html'));

  if (!hasWebBuild) {
    // Not fatal — the API is still usable — but silence here would look like a
    // routing bug rather than a missing build step.
    process.stderr.write(
      [
        '',
        line,
        ' WARNING — the front end has not been built',
        line,
        ` Expected: ${resolve(webDist, 'index.html')}`,
        '',
        ' The API will run, but every page request will return 404 because there',
        ' is nothing to serve. Run `npm run build` before `npm start`.',
        line,
        '',
      ].join('\n'),
    );
  }

  if (isProd && !cookieSecure) {
    // Not fatal — an operator may genuinely be testing before SSL is attached —
    // but it must be stated, because the symptom otherwise is "login does
    // nothing" with no error on either side.
    process.stderr.write(
      [
        '',
        ' WARNING — COOKIE_SECURE is off in production.',
        ' Session cookies will be sent without the Secure flag. Only do this if the',
        ' site is genuinely served over plain HTTP. Once SSL is active, remove the',
        ' override so cookies cannot be read over an unencrypted connection.',
        '',
      ].join('\n'),
    );
  }

  await verifyDatabase();

  const app = createApp();

  // Bind on 0.0.0.0 explicitly: a managed host routes to the container address,
  // not to loopback, and binding 127.0.0.1 is a common cause of a healthy-looking
  // process that never receives a request.
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    process.stdout.write(
      [
        '',
        `[marketing-os] started`,
        `  environment   ${env.NODE_ENV}`,
        `  node          ${process.version}`,
        `  listening     0.0.0.0:${env.PORT}`,
        `  app url       ${env.APP_URL}`,
        `  database      connected`,
        `  uploads       ${uploadDir}`,
        `  front end     ${hasWebBuild ? 'served from web/dist' : 'NOT BUILT'}`,
        `  ai provider   ${hasOpenAi ? `openai:${env.OPENAI_MODEL}` : 'built-in template engine (no OPENAI_API_KEY)'}`,
        `  secure cookies ${cookieSecure ? 'on' : 'off'}`,
        `  trust proxy   ${env.TRUST_PROXY}`,
        '',
      ].join('\n'),
    );
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

  const shutdown = (signal: string): void => {
    process.stdout.write(`[marketing-os] ${signal} received, shutting down\n`);
    clearInterval(pruneTimer);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection that reaches here would otherwise kill the process
  // silently, which reads as an unexplained 503.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[marketing-os] unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
  });
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[marketing-os] uncaught exception: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}

void main();
