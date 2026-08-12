/** API router assembly. */

import { Router } from 'express';

import { prisma } from '../lib/prisma.js';
import { authRouter } from './auth.js';
import { clientsRouter } from './clients.js';
import { brandsRouter } from './brands.js';
import { mediaRouter } from './media.js';
import { campaignsRouter } from './campaigns.js';
import { contentRouter } from './content.js';
import { calendarRouter } from './calendar.js';
import { approvalsRouter } from './approvals.js';
import { analyticsRouter } from './analytics.js';
import { reportsRouter } from './reports.js';
import { adminRouter } from './admin.js';
import { integrationsRouter, notificationsRouter, subscriptionsRouter, usersRouter } from './misc.js';

export const apiRouter: Router = Router();

/**
 * Liveness and readiness in one endpoint, for the host's health check.
 *
 * Deliberately unauthenticated and deliberately dull: it reveals whether the
 * process is up and whether the database answers, and nothing else. No
 * connection strings, no environment values, no versions of anything an
 * attacker could use, no stack traces.
 */
apiRouter.get('/health', (_req, res) => {
  void prisma
    .$queryRaw`SELECT 1`
    .then(() => {
      res.json({ status: 'ok', database: 'ok', uptime: Math.round(process.uptime()) });
    })
    .catch(() => {
      // 503 here is honest: the process lives but cannot serve real requests.
      res.status(503).json({ status: 'degraded', database: 'unreachable', uptime: Math.round(process.uptime()) });
    });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/clients', clientsRouter);
apiRouter.use('/brands', brandsRouter);
apiRouter.use('/media', mediaRouter);
apiRouter.use('/campaigns', campaignsRouter);
apiRouter.use('/content', contentRouter);
apiRouter.use('/calendar', calendarRouter);
apiRouter.use('/approvals', approvalsRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/integrations', integrationsRouter);
apiRouter.use('/subscriptions', subscriptionsRouter);
apiRouter.use('/admin', adminRouter);
