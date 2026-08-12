/**
 * Smaller routers: notifications, integrations, subscriptions and users.
 * Grouped because each is a handful of endpoints over a single model.
 */

import { Router } from 'express';
import { IntegrationStatus, Language, Platform, Prisma, Role, SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth, requireManager } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId } from '../lib/scope.js';
import { adapterFor, adapterReadiness, allAdapters, NotImplementedError } from '../services/integrations/index.js';
import { hashPassword, passwordProblems } from '../lib/password.js';
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
      prisma.notification.findMany({ where, ...paginate(query), orderBy: { createdAt: 'desc' } }),
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
    // Scoped by userId so one user cannot mark another's notification read.
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
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, (req.query as { clientId?: string }).clientId);

    const items = await prisma.integration.findMany({
      where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      orderBy: { platform: 'asc' },
      // `credentials` is deliberately absent from this projection.
      select: {
        id: true, clientId: true, platform: true, status: true, accountName: true,
        accountId: true, scopes: true, lastSyncAt: true, lastError: true, updatedAt: true,
        client: { select: { id: true, name: true } },
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
  '/:clientId/:platform/connect',
  requireAgency,
  validateParams(z.object({ clientId: z.string().min(1).max(40), platform: z.nativeEnum(Platform) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { clientId, platform } = req.params as unknown as { clientId: string; platform: Platform };

    const client = await prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    const adapter = adapterFor(platform);
    const readiness = adapterReadiness(adapter);

    await prisma.integration.upsert({
      where: { clientId_platform: { clientId, platform } },
      create: { organizationId: orgId(actor), clientId, platform, status: IntegrationStatus.DISCONNECTED },
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
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
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
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const integration = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
    });
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

// ------------------------------------------------------------------ subscriptions

export const subscriptionsRouter: Router = Router();
subscriptionsRouter.use(requireAuth);

subscriptionsRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    res.json({
      plans: plans.map((plan) => ({
        ...plan,
        priceMonthly: Number(plan.priceMonthly.toString()),
        priceYearly: Number(plan.priceYearly.toString()),
      })),
    });
  }),
);

subscriptionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, undefined);

    const items = await prisma.subscription.findMany({
      where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      include: { plan: true, client: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ items });
  }),
);

/** Current usage against the plan's limits. */
subscriptionsRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const organizationId = orgId(actor);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [clients, users, campaigns, aiThisMonth, media, integrations, subscription] = await Promise.all([
      prisma.client.count({ where: { organizationId } }),
      prisma.user.count({ where: { organizationId } }),
      prisma.campaign.count({ where: { organizationId } }),
      prisma.aiUsage.count({ where: { organizationId, createdAt: { gte: monthStart } } }),
      prisma.media.aggregate({ where: { organizationId }, _sum: { sizeBytes: true } }),
      prisma.integration.count({ where: { organizationId, status: IntegrationStatus.CONNECTED } }),
      prisma.subscription.findFirst({
        where: { organizationId, clientId: null },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const plan = subscription?.plan ?? (await prisma.plan.findFirst({ orderBy: { sortOrder: 'asc' } }));

    res.json({
      plan: plan
        ? { ...plan, priceMonthly: Number(plan.priceMonthly.toString()), priceYearly: Number(plan.priceYearly.toString()) }
        : null,
      subscription,
      usage: {
        clients,
        users,
        campaigns,
        aiThisMonth,
        storageMb: Number(((media._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2)),
        integrations,
      },
      limits: plan
        ? {
            clients: plan.maxClients,
            users: plan.maxUsers,
            campaigns: plan.maxCampaigns,
            aiThisMonth: plan.maxAiPerMonth,
            storageMb: plan.maxStorageMb,
            integrations: plan.maxIntegrations,
          }
        : null,
      // Nothing here has been charged: no payment provider is configured.
      billing: { provider: null, status: 'not_configured' },
    });
  }),
);

// ------------------------------------------------------------------ users

export const usersRouter: Router = Router();
usersRouter.use(requireAuth, requireAgency);

usersRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ role: z.nativeEnum(Role).optional(), clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { role?: Role; clientId?: string };

    const where: Prisma.UserWhereInput = {
      organizationId: orgId(actor),
      ...(query.role ? { role: query.role } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { email: { contains: query.search, mode: 'insensitive' } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, email: true, role: true, isActive: true, locale: true,
          lastLoginAt: true, createdAt: true, client: { select: { id: true, name: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).superRefine((value, ctx) => {
    for (const problem of passwordProblems(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password ${problem}` });
    }
  }),
  role: z.nativeEnum(Role),
  clientId: z.string().max(40).nullish(),
  locale: z.nativeEnum(Language).default(Language.EN),
});

usersRouter.post(
  '/',
  requireManager,
  validateBody(createUserSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof createUserSchema>;

    // Only a super admin may mint another super admin.
    if (body.role === Role.SUPER_ADMIN && actor.role !== Role.SUPER_ADMIN) {
      throw badRequest('Only a super admin can create another super admin');
    }
    const needsClient = body.role === Role.CLIENT_ADMIN || body.role === Role.CLIENT_USER;
    if (needsClient && !body.clientId) throw badRequest('Client portal users must be attached to a client');

    if (body.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: body.clientId, organizationId: orgId(actor) },
        select: { id: true },
      });
      if (!client) throw notFound('Client');
    }

    if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw conflict('An account with that email already exists');
    }

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        locale: body.locale,
        organizationId: orgId(actor),
        clientId: needsClient ? body.clientId ?? null : null,
      },
      select: { id: true, name: true, email: true, role: true, isActive: true, clientId: true, createdAt: true },
    });

    await recordAudit({ actor, action: 'user.create', entity: 'User', entityId: user.id, ip: req.ip });
    res.status(201).json({ user });
  }),
);

usersRouter.patch(
  '/:id',
  requireManager,
  validateParams(idParam),
  validateBody(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      role: z.nativeEnum(Role).optional(),
      isActive: z.boolean().optional(),
      clientId: z.string().max(40).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as { role?: Role; isActive?: boolean; name?: string; clientId?: string | null };

    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true, role: true },
    });
    if (!existing) throw notFound('User');

    if (existing.id === actor.id && body.isActive === false) {
      throw badRequest('You cannot deactivate your own account');
    }
    if (body.role === Role.SUPER_ADMIN && actor.role !== Role.SUPER_ADMIN) {
      throw badRequest('Only a super admin can grant super admin');
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: body,
      select: { id: true, name: true, email: true, role: true, isActive: true, clientId: true },
    });

    // Deactivating a user ends their sessions immediately.
    if (body.isActive === false) await prisma.session.deleteMany({ where: { userId: user.id } });

    await recordAudit({ actor, action: 'user.update', entity: 'User', entityId: user.id, ip: req.ip });
    res.json({ user });
  }),
);
