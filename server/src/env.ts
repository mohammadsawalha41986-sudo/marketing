/** Validated environment. The process refuses to start on a bad config. */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Resolved from this module's own location, so every path below is correct no
// matter what working directory the host starts the process in.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');

/*
 * A .env file is a local-development convenience only. dotenv never overwrites
 * a variable that is already set and does nothing at all when the file is
 * absent, so on a managed host the injected environment is what takes effect
 * and no .env file needs to exist.
 */
loadEnv({ path: resolve(REPO_ROOT, '.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Must be long enough that a stolen cookie cannot be brute-forced offline.
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24 * 7),

  APP_URL: z.string().url().default('http://localhost:3000'),
  // Optional: front end and API are same-origin in production, so this is only
  // needed for a split-origin dev setup. It defaults from APP_URL below.
  CORS_ORIGIN: z.string().optional(),
  /*
   * Whether session cookies carry the Secure flag.
   *
   * Left unset it defaults to on in production and off elsewhere, which is the
   * right answer almost always. It stays overridable because forcing it on
   * regardless would silently break login on a deployment that is not yet on
   * HTTPS: the browser accepts the response, drops the cookie, and every later
   * request looks like a fresh unauthenticated visitor with no error anywhere.
   */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage/uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),

  RATE_LIMIT_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  /*
   * Fail loudly and legibly rather than throwing a stack trace.
   *
   * On a managed host a startup crash surfaces only as "503 Service
   * Unavailable"; the runtime log is the single place an operator can find out
   * why. This block is written to be the first thing they see, and to name the
   * exact variables that are wrong.
   */
  const missing = parsed.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);

  process.stderr.write(
    [
      '',
      '='.repeat(72),
      ' MARKETING OS FAILED TO START — invalid environment configuration',
      '='.repeat(72),
      '',
      ...missing,
      '',
      ' Set these as environment variables on the host. In Hostinger this is',
      ' hPanel → Advanced → Node.js → your app → Environment variables.',
      ' The application does NOT read a .env file in production; .env.example',
      ' in the repository lists every variable and what it is for.',
      '',
      ' Generate a session secret with:',
      '   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
      '',
      '='.repeat(72),
      '',
    ].join('\n'),
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Effective Secure-cookie setting: explicit if given, otherwise on in production. */
export const cookieSecure = env.COOKIE_SECURE === undefined ? isProd : env.COOKIE_SECURE === 'true';

/** Where uploads land. Absolute, so it does not depend on the working directory. */
export const uploadDir = resolve(REPO_ROOT, env.STORAGE_LOCAL_DIR);

/**
 * Origins allowed to call the API with credentials.
 *
 * In production the SPA is served by this same process, so requests are
 * same-origin and CORS is not involved at all. When CORS_ORIGIN is unset we
 * therefore default to APP_URL rather than to a development origin — a
 * leftover `localhost:5173` default in production would be both useless and
 * misleading. In development we also allow the Vite dev server.
 */
export const corsOrigins = (
  env.CORS_ORIGIN ?? (isProd ? env.APP_URL : `${env.APP_URL},http://localhost:5173`)
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/** True when a real model is configured; otherwise AI runs on the local generator. */
export const hasOpenAi = Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0);
