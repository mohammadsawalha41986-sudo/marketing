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
import { cookieSecure, env, isProd, REPO_ROOT, uploadDir } from './env.js';
import { aiHealth } from './services/ai/health.js';
import { startDatabaseProbe } from './lib/db-health.js';
import { prisma } from './lib/prisma.js';
import { runtimeReport } from './lib/runtime-report.js';
import { metaConfigDiagnostics } from './services/integrations/meta.js';
import { tiktokConfigDiagnostics } from './services/integrations/tiktok.js';
import { uploadPostConfigured } from './services/integrations/upload-post.js';
import { publishingTick } from './services/publishing/scheduler.js';
import { ingestMetricsTick } from './services/social/metrics-ingest.js';
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

/**
 * The Meta app id, described rather than shown.
 *
 * Facebook answers a malformed app id with PLATFORM_INVALID_APP_ID on its own
 * error page, which names the app id but not which of our variables carries it —
 * and appears only after the operator has already been redirected away. This
 * line puts the verdict in our own logs at boot, where it can be read without a
 * browser and without ever printing the value.
 */
function metaAppIdSummary(): string {
  const meta = metaConfigDiagnostics();
  if (!meta.appIdConfigured) return 'not configured (META_APP_ID unset)';

  const faults = [
    meta.appIdNumeric ? null : 'not numeric',
    meta.appIdEqualsConfigId ? 'same value as META_CONFIG_ID' : null,
  ].filter(Boolean);

  const shape = `${meta.appIdLength} chars, numeric=${meta.appIdNumeric}`;
  return faults.length === 0
    ? `configured (${shape})`
    : `INVALID — ${faults.join('; ')} (${shape}). Facebook will reject this.`;
}

/**
 * The TikTok line of the startup banner.
 *
 * TikTok answers a client key it does not accept with "correct the following:
 * client_key" and nothing else — no reason, no mention of which variable
 * carries it, and only after the operator has been redirected away. This line
 * puts what the server actually holds into our own logs at boot: enough of the
 * key to compare against the console at a glance, its length, whether anything
 * invisible rode along with it, and whether it is the sandbox key, which the
 * live authorization endpoint refuses.
 */
function tiktokClientKeySummary(): string {
  const tiktok = tiktokConfigDiagnostics();
  if (!tiktok.clientKeyConfigured) return 'not configured (TIKTOK_CLIENT_KEY unset)';

  const faults = [
    tiktok.clientKeyCharsetValid ? null : 'contains characters a client key cannot have',
    tiktok.clientKeyNeededCleaning ? 'arrived wrapped in quotes or whitespace (stripped)' : null,
    tiktok.clientKeyLooksSandbox ? 'looks like a sandbox key, which cannot log in live' : null,
    tiktok.redirectUriPathValid ? null : 'TIKTOK_REDIRECT_URI does not end at the callback route',
  ].filter(Boolean);

  const shape = `${tiktok.clientKeyLength} chars, ${tiktok.clientKeyRedacted}`;
  return faults.length === 0
    ? `configured (${shape})`
    : `CHECK — ${faults.join('; ')} (${shape})`;
}

/**
 * The AI line of the startup banner.
 *
 * Names the mode *and* what to do about it, because this is the line an
 * operator reads when they wonder why generated copy looks generic. The
 * template engine is a supported mode rather than a fault, and saying so stops
 * the log from reading like an error it is not.
 */
function aiProviderSummary(): string {
  const health = aiHealth();
  return health.keyConfigured
    ? `openai:${env.OPENAI_MODEL} (unverified until the first call — POST /api/admin/ai/check to confirm)`
    : 'built-in template engine — no OPENAI_API_KEY set, so copy, hashtags, analysis and review ' +
      'replies are produced by rule and labelled as such. This is a supported mode, not a failure.';
}

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
      `  ai provider    ${aiProviderSummary()}`,
      `  secure cookies ${cookieSecure ? 'on' : 'off'}`,
      `  trust proxy    ${env.TRUST_PROXY}`,
      // Shape only, never the value. This line is what turns a Facebook-side
      // PLATFORM_INVALID_APP_ID into something diagnosable from our own logs.
      `  meta app id    ${metaAppIdSummary()}`,
      // The same, for the credential TikTok rejects by name and never explains.
      `  tiktok key     ${tiktokClientKeySummary()}`,
      /*
       * Presence only — no length, no fragment, no value.
       *
       * Upload-Post's key is the deployment's single publishing credential, and
       * the one thing an operator needs from a log is whether the container can
       * see it at all: without it every routed publish refuses, and with a
       * stale one every routed publish 401s. Neither question needs a
       * character of the key to answer, so this line prints none.
       */
      `  upload-post    ${uploadPostConfigured() ? 'configured' : 'not configured (UPLOAD_POST_API_KEY unset)'}`,
      `  database       checking in the background…`,
      // The engine panics on a constrained host when it cannot spawn a thread,
      // and the Prisma error never names the budget that caused it.
      ...runtimeReport(),
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

/*
 * The publishing worker.
 *
 * In-process and on an interval, which is the honest shape for a single-service
 * deployment: there is no Redis and no separate worker container, and inventing
 * a queue that needs both would mean scheduled posts stop going out the moment
 * this is deployed as it actually is. The safety properties that matter under
 * concurrency — the unique job per (content, platform), the claim-by-status
 * update, and the idempotency checks before any provider call — are in the
 * service rather than in the timer, so moving this to a real worker later is a
 * change of caller, not of logic.
 *
 * `PUBLISHING_INTERVAL_MS` allows a deployment to slow this down; 60s means a
 * post goes out within a minute of its scheduled time.
 */
/**
 * Run a periodic task, never concurrently with itself.
 *
 * `setInterval` fires on schedule regardless of whether the previous run has
 * finished, so a publishing pass that outruns its own interval — one resumable
 * video upload is enough — overlaps the next one. The database claims make that
 * safe rather than duplicating a post, but overlapping passes still pile up
 * provider calls and connections for no benefit, so a tick that is still
 * running simply skips the next one.
 */
function everyInterval(label: string, ms: number, run: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;

  const timer = setInterval(() => {
    if (running) {
      process.stderr.write(`[marketing-os] ${label} still running, skipping this tick\n`);
      return;
    }
    running = true;
    void run()
      // Never fatal: a failed tick must not take the web process down with it.
      .catch((error: Error) => process.stderr.write(`[marketing-os] ${label} failed: ${error.message}\n`))
      .finally(() => { running = false; });
  }, ms);

  timer.unref();
  return timer;
}

const publishIntervalMs = Number(process.env.PUBLISHING_INTERVAL_MS ?? 60_000);
const publishTimer = everyInterval('publishing tick', Math.max(15_000, publishIntervalMs), () =>
  publishingTick({ prisma, fetchImpl: fetch as never }),
);

/*
 * Organic metric ingestion.
 *
 * Its own timer rather than a step inside the publishing tick, because the two
 * have nothing in common but the word "periodic". Publishing is latency
 * sensitive — a post scheduled for 8:00pm should go out at 8:00pm, so that tick
 * runs every minute and must stay short. Reading insights is the opposite: the
 * numbers barely move within an hour, the per-post floor is six hours anyway,
 * and every call spends a provider rate limit that publishing also needs. Doing
 * it on the minute tick would put a scan in front of every publish for figures
 * that had not changed.
 *
 * Same shape as the timer above in every other respect: in-process, unref'd,
 * and never fatal — a provider having a bad morning must not take the web
 * process down with it.
 */
const metricsIntervalMs = Number(process.env.METRICS_INGEST_INTERVAL_MS ?? 15 * 60_000);
const metricsTimer = everyInterval('metrics ingestion', Math.max(60_000, metricsIntervalMs), () =>
  ingestMetricsTick({ prisma, fetchImpl: fetch as never }),
);

function shutdown(signal: string): void {
  process.stdout.write(`[marketing-os] ${signal} received, shutting down\n`);
  clearInterval(pruneTimer);
  clearInterval(publishTimer);
  clearInterval(metricsTimer);
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
