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
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { REPO_ROOT, corsOrigins, env, isProd, isTest, uploadDir } from './env.js';
import { apiRouter } from './routes/index.js';
import { csrfGuard, loadActor } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The SPA is served from this origin; assets and API share it.
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
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

  // In production the API process also serves the built SPA, which is what makes
  // this deployable to Hostinger as a single Node app.
  const webDist = resolve(REPO_ROOT, 'web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: isProd ? '1y' : 0 }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
        next();
        return;
      }
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
