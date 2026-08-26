/** API router assembly. */

import { Router } from 'express';

import { readiness } from '../lib/db-health.js';
import { storageStatus } from '../services/storage/index.js';
import { ffmpegCapability } from '../services/video/ffmpeg.js';
import { authRouter } from './auth.js';
import { clientsRouter } from './clients.js';
import { brandsRouter } from './brands.js';
import { mediaRouter } from './media.js';
import { productsRouter } from './products.js';
import { campaignsRouter } from './campaigns.js';
import { ceoRouter } from './ceo.js';
import { creativesRouter } from './creatives.js';
import { videosRouter } from './videos.js';
import { publicationsRouter } from './publications.js';
import { storageRouter } from './storage.js';
import { contentRouter } from './content.js';
import { calendarRouter } from './calendar.js';
import { approvalsRouter } from './approvals.js';
import { analyticsRouter } from './analytics.js';
import { reportsRouter } from './reports.js';
import { googleRouter } from './google.js';
import { adminRouter } from './admin.js';
import { socialRouter } from './social.js';
import { oauthCallbackRouter } from './oauth-callback.js';
import { integrationsRouter, notificationsRouter, subscriptionsRouter, usersRouter } from './misc.js';

export const apiRouter: Router = Router();

/**
 * Liveness and readiness in one endpoint, for the host's health check.
 *
 * Deliberately unauthenticated and deliberately dull: it reveals whether the
 * process is up and whether the database answers, and nothing else. No
 * connection strings, no environment values, no versions of anything an
 * attacker could use, no stack traces.
 *
 * The check runs through the shared probe in `db-health`, so this endpoint and
 * the background watcher always agree and share one timeout. `degraded` is
 * returned with 503 rather than being smoothed over — the process is alive but
 * cannot serve real requests, and the host should be told so.
 *
 * `engine` is the one extra bit of detail, and it earns its place: an engine
 * panic and a refused connection look identical from outside but need opposite
 * fixes, and neither value discloses anything about the deployment.
 */
apiRouter.get('/health', (_req, res) => {
  void Promise.all([readiness(), ffmpegCapability()]).then(([health, video]) => {
    const body = {
      status: health.state === 'ok' ? 'healthy' : 'degraded',
      database: health.state === 'ok' ? 'ok' : 'unreachable',
      engine: health.enginePanic ? 'panicked' : 'ok',
      // Non-zero means panics are happening and being recovered from. A climbing
      // number is the signal that the host's thread ceiling is genuinely too low.
      engineRecoveries: health.panicRecoveries,
      /*
       * Reported, but not a reason to fail the check. Unconfigured storage
       * closes the media routes and leaves everything else working, so marking
       * the whole service unhealthy would take a running deployment down over a
       * subset of it. Named here so the state is visible without opening the app.
       */
      storage: storageStatus().driver,
      mediaPersistent: storageStatus().persistent,
      // Same treatment as storage: a capability the deployment either has or
      // does not, reported rather than discovered mid-render.
      video: video.available ? 'available' : 'unavailable',
      uptime: Math.round(process.uptime()),
    };
    res.status(health.state === 'ok' ? 200 : 503).json(body);
  });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/clients', clientsRouter);
apiRouter.use('/brands', brandsRouter);
apiRouter.use('/media', mediaRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/videos', videosRouter);
apiRouter.use('/publications', publicationsRouter);
apiRouter.use('/storage', storageRouter);
apiRouter.use('/campaigns', campaignsRouter);
apiRouter.use('/ceo', ceoRouter);
apiRouter.use('/creatives', creativesRouter);
apiRouter.use('/content', contentRouter);
apiRouter.use('/social', socialRouter);
apiRouter.use('/calendar', calendarRouter);
apiRouter.use('/approvals', approvalsRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/google', googleRouter);
apiRouter.use('/notifications', notificationsRouter);
/*
 * Order matters. The OAuth callback is a redirect from the provider and carries
 * no session, so it is mounted ahead of the authenticated integrations router —
 * its authorisation is the single-use state, not a cookie.
 */
apiRouter.use('/integrations', oauthCallbackRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/subscriptions', subscriptionsRouter);
apiRouter.use('/admin', adminRouter);
