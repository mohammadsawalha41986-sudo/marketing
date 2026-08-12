/** API router assembly. */

import { Router } from 'express';

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

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'marketing-os', time: new Date().toISOString() });
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
