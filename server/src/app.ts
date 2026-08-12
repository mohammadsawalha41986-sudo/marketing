/**
 * Express app assembly. Exported separately from the listener so tests can drive
 * it with supertest without binding a port.
 */

import express, { type Express } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { REPO_ROOT, corsOrigins, env, isProd, isTest, uploadDir } from './env.js';
import { apiRouter } from './routes/index.js';
import { csrfGuard, loadActor } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

/**
 * CSP hashes for the inline scripts in the built index.html.
 *
 * The app bootstraps theme and text direction from an inline script so the page
 * cannot flash the wrong theme before React mounts. A strict `script-src 'self'`
 * blocks that, which only shows up once NODE_ENV=production turns the CSP on.
 *
 * Hashing the script keeps the policy strict — the alternative, 'unsafe-inline',
 * would permit every injected script on the page. The hashes are computed from
 * the actual built file at startup, so editing the bootstrap never leaves a
 * stale hash behind.
 */
function inlineScriptHashes(indexHtmlPath: string): string[] {
  if (!existsSync(indexHtmlPath)) return [];

  try {
    const html = readFileSync(indexHtmlPath, 'utf8');
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    const hashes: string[] = [];

    for (const match of html.matchAll(inlineScript)) {
      const source = match[1];
      if (!source) continue;
      hashes.push(`'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

export function createApp(): Express {
  const app = express();
  const indexHtmlPath = resolve(REPO_ROOT, 'web/dist/index.html');

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The SPA is served from this origin; assets and API share it.
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", ...inlineScriptHashes(indexHtmlPath)],
              // Vite emits a small inline style block for critical CSS.
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'blob:'],
              mediaSrc: ["'self'", 'blob:'],
              connectSrc: ["'self'"],
              fontSrc: ["'self'", 'data:'],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(compression());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  if (!isTest) {
    app.use(
      '/api',
      rateLimit({
        windowMs: env.RATE_LIMIT_WINDOW_MIN * 60 * 1000,
        limit: env.RATE_LIMIT_MAX,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } },
      }),
    );
  }

  app.use(loadActor);
  app.use(csrfGuard);
  app.use('/api', apiRouter);

  // Uploaded media. Served with a restrictive disposition so a stored file can
  // never execute in the app's origin.
  app.use(
    '/uploads',
    express.static(uploadDir, {
      maxAge: isProd ? '30d' : 0,
      index: false,
      dotfiles: 'deny',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'");
      },
    }),
  );

  /*
   * The same process serves the built SPA, which is what makes this deployable
   * as a single Node app with no reverse proxy in front of two services.
   *
   * Paths are resolved from REPO_ROOT (derived from this module's own location),
   * never from process.cwd(), because a host is free to start the process from
   * any directory.
   */
  const webDist = resolve(REPO_ROOT, 'web/dist');
  const indexHtml = indexHtmlPath;

  if (existsSync(indexHtml)) {
    // Vite emits content-hashed filenames, so assets are safe to cache forever.
    app.use(
      express.static(webDist, {
        index: false,
        maxAge: isProd ? '1y' : 0,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );

    app.get('*', (req, res, next) => {
      // API and upload routes must fall through to their own handlers, so a
      // wrong API path returns JSON 404 rather than a page.
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
        next();
        return;
      }

      /*
       * Anything that looks like a file request and was not found by the static
       * handler above is genuinely missing. Returning index.html for it would
       * answer 200 with HTML where the browser expects JavaScript or CSS, which
       * surfaces as a confusing MIME-type error instead of a plain 404.
       */
      if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
        next();
        return;
      }

      // Everything else is a client-side route: hand back the app shell.
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
