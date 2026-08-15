/**
 * Smaller routers: notifications and integrations.
 *
 * The subscriptions and users routers that used to live here are gone with the
 * SaaS layer — there are no plans to sell and no second account to manage.
 */

import { Router } from 'express';
import { IntegrationStatus, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { adapterFor, adapterReadiness, allAdapters, NotImplementedError } from '../services/integrations/index.js';
import { recordAudit } from '../services/audit.js';
import { aiStatus } from '../services/ai/index.js';

// ------------------------------------------------------------------ notifications

export const notificationsRouter: Router = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ unreadOnly: z.coerce.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { unreadOnly: boolean };

    const where: Prisma.NotificationWhereInput = {
      userId: actor.id,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: { restaurant: { select: { id: true, name: true } } },
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: actor.id, readAt: null } }),
    ]);

    res.json({ ...pageResult(items, total, query), unread });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    // Scoped by userId so one account cannot mark another's notification read.
    const { count } = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: actor.id },
      data: { readAt: new Date() },
    });
    if (count === 0) throw notFound('Notification');
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { count } = await prisma.notification.updateMany({
      where: { userId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true, count });
  }),
);

// ------------------------------------------------------------------ integrations

export const integrationsRouter: Router = Router();
integrationsRouter.use(requireAuth);

/** Catalogue of adapters and what each still needs before it can connect. */
integrationsRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    res.json({
      ai: aiStatus(),
      adapters: allAdapters().map((adapter) => {
        const readiness = adapterReadiness(adapter);
        const oauth = adapter.oauth();
        return {
          platform: adapter.platform,
          label: adapter.label,
          implemented: adapter.implemented,
          ready: readiness.ready,
          missingEnv: readiness.missingEnv,
          capabilities: adapter.capabilities,
          scopes: oauth.scopes,
          docsUrl: oauth.docsUrl,
        };
      }),
    });
  }),
);

integrationsRouter.get(
  '/',
  validateQuery(z.object({ restaurantId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const { restaurantId } = req.query as { restaurantId?: string };

    const items = await prisma.integration.findMany({
      where: restaurantId ? { restaurantId } : {},
      orderBy: { platform: 'asc' },
      // `credentials` is deliberately absent from this projection.
      select: {
        id: true, restaurantId: true, platform: true, status: true, accountName: true,
        accountId: true, scopes: true, lastSyncAt: true, lastError: true, updatedAt: true,
        restaurant: { select: { id: true, name: true } },
      },
    });

    res.json({ items });
  }),
);

/**
 * Begin a connection. Every adapter currently refuses, and says exactly which
 * environment variables and adapter work are missing — no fake "connected".
 */
integrationsRouter.post(
  '/:restaurantId/:platform/connect',
  validateParams(z.object({ restaurantId: z.string().min(1).max(40), platform: z.nativeEnum(Platform) })),
  asyncHandler(async (req, res) => {
    const { restaurantId, platform } = req.params as unknown as { restaurantId: string; platform: Platform };

    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { id: true } });
    if (!restaurant) throw notFound('Restaurant');

    const adapter = adapterFor(platform);
    const readiness = adapterReadiness(adapter);

    await prisma.integration.upsert({
      where: { restaurantId_platform: { restaurantId, platform } },
      create: { restaurantId, platform, status: IntegrationStatus.DISCONNECTED },
      update: {},
    });

    try {
      const { redirectTo } = await adapter.connect({ redirectUri: `${req.protocol}://${req.get('host')}/api/integrations/callback` });
      res.json({ redirectTo });
    } catch (error) {
      if (error instanceof NotImplementedError) {
        res.status(501).json({
          error: {
            code: 'ADAPTER_NOT_IMPLEMENTED',
            message: error.message,
            details: { platform, requiredEnv: error.requiredEnv, missingEnv: readiness.missingEnv, docsUrl: adapter.oauth().docsUrl },
          },
        });
        return;
      }
      throw error;
    }
  }),
);

integrationsRouter.post(
  '/:id/disconnect',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.integration.findUnique({
      where: { id: req.params.id },
      select: { id: true, platform: true },
    });
    if (!existing) throw notFound('Integration');

    await prisma.integration.update({
      where: { id: existing.id },
      data: { status: IntegrationStatus.DISCONNECTED, credentials: Prisma.DbNull, accountName: null, accountId: null, lastError: null },
    });

    await recordAudit({ actor, action: 'integration.disconnect', entity: 'Integration', entityId: existing.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

integrationsRouter.post(
  '/:id/sync',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const integration = await prisma.integration.findUnique({ where: { id: req.params.id } });
    if (!integration) throw notFound('Integration');

    if (integration.status !== IntegrationStatus.CONNECTED) {
      throw badRequest('This account is not connected, so there is nothing to sync');
    }

    const adapter = adapterFor(integration.platform);
    try {
      await adapter.fetchMetrics({
        accountId: integration.accountId ?? '',
        from: new Date(Date.now() - 7 * 86400000),
        to: new Date(),
      });
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof NotImplementedError) {
        res.status(501).json({ error: { code: 'ADAPTER_NOT_IMPLEMENTED', message: error.message } });
        return;
      }
      throw error;
    }
  }),
);
