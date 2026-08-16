/**
 * /api/admin — the Super Admin surface.
 *
 * This is the only router that may read across organizations, and every handler
 * calls `crossTenant()` first. Nothing here accepts a tenant id from the body as
 * an authorization decision; ids are used to filter, never to grant.
 */

import { Router } from 'express';
import { ClientStatus, Prisma, Role, SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth, requireSuperAdmin } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { crossTenant } from '../lib/scope.js';
import { derive, sumSnapshots } from '../services/analytics.js';
import { recordAudit } from '../services/audit.js';
import { aiStatus } from '../services/ai/index.js';
import { storageStatus } from '../services/storage/index.js';
import { cookieSecure, env, hasOpenAi } from '../env.js';

export const adminRouter: Router = Router();
adminRouter.use(requireAuth, requireSuperAdmin);

adminRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const since = new Date(Date.now() - 29 * 86400000);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [orgs, users, clients, campaigns, contents, media, snapshots, aiThisMonth, subs, recent] = await Promise.all([
      prisma.organization.count(),
      prisma.user.count(),
      prisma.client.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.content.count(),
      prisma.media.aggregate({ _sum: { sizeBytes: true }, _count: { _all: true } }),
      prisma.analyticsSnapshot.findMany({
        where: { date: { gte: since } },
        select: {
          platform: true, date: true, spend: true, reach: true, impressions: true,
          clicks: true, conversions: true, revenue: true, engagements: true,
        },
      }),
      prisma.aiUsage.groupBy({ by: ['provider'], where: { createdAt: { gte: monthStart } }, _count: { _all: true } }),
      prisma.subscription.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { user: { select: { id: true, name: true, email: true } }, organization: { select: { id: true, name: true } } },
      }),
    ]);

    res.json({
      platform: {
        organizations: orgs,
        users,
        clients: Object.fromEntries(clients.map((row) => [row.status, row._count._all])),
        campaigns: Object.fromEntries(campaigns.map((row) => [row.status, row._count._all])),
        contents,
        mediaCount: media._count._all,
        storageMb: Number(((media._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2)),
        subscriptions: Object.fromEntries(subs.map((row) => [row.status, row._count._all])),
      },
      metrics30d: derive(sumSnapshots(snapshots)),
      ai: {
        ...aiStatus(),
        thisMonth: Object.fromEntries(aiThisMonth.map((row) => [row.provider, row._count._all])),
      },
      recentActivity: recent,
    });
  }),
);

adminRouter.get(
  '/organizations',
  validateQuery(paginationQuery),
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const query = req.query as unknown as z.infer<typeof paginationQuery>;

    const where: Prisma.OrganizationWhereInput = query.search
      ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { slug: { contains: query.search, mode: 'insensitive' } }] }
      : {};

    const [items, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { users: true, clients: true, campaigns: true } } },
      }),
      prisma.organization.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

adminRouter.get(
  '/clients',
  validateQuery(paginationQuery.extend({ status: z.nativeEnum(ClientStatus).optional(), organizationId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { status?: ClientStatus; organizationId?: string };

    const where: Prisma.ClientWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { businessName: { contains: query.search, mode: 'insensitive' } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.client.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          organization: { select: { id: true, name: true } },
          subscription: { include: { plan: { select: { name: true, key: true } } } },
          _count: { select: { campaigns: true, contents: true, users: true } },
        },
      }),
      prisma.client.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

adminRouter.post(
  '/clients/:id/status',
  validateParams(idParam),
  validateBody(z.object({ status: z.nativeEnum(ClientStatus) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    crossTenant(actor);
    const { status } = req.body as { status: ClientStatus };

    const client = await prisma.client.update({ where: { id: req.params.id }, data: { status } });

    // Suspension must also cut off the client's users, not just hide the UI.
    if (status === ClientStatus.SUSPENDED || status === ClientStatus.ARCHIVED) {
      const users = await prisma.user.findMany({ where: { clientId: client.id }, select: { id: true } });
      await prisma.session.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } });
    }

    await recordAudit({ actor, action: 'admin.client_status', entity: 'Client', entityId: client.id, meta: { status }, ip: req.ip });
    res.json({ client });
  }),
);

adminRouter.get(
  '/users',
  validateQuery(paginationQuery.extend({ role: z.nativeEnum(Role).optional() })),
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { role?: Role };

    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
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
          id: true, name: true, email: true, role: true, isActive: true, lastLoginAt: true, createdAt: true,
          organization: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

// ------------------------------------------------------------------ plans

const planSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9-]+$/).max(40),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullish(),
  priceMonthly: z.coerce.number().nonnegative(),
  priceYearly: z.coerce.number().nonnegative(),
  currency: z.string().trim().length(3).default('USD'),
  maxClients: z.coerce.number().int().min(-1),
  maxUsers: z.coerce.number().int().min(-1),
  maxCampaigns: z.coerce.number().int().min(-1),
  maxAiPerMonth: z.coerce.number().int().min(-1),
  maxStorageMb: z.coerce.number().int().min(-1),
  maxIntegrations: z.coerce.number().int().min(-1),
  features: z.array(z.string().trim().max(120)).max(30).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

adminRouter.get(
  '/plans',
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const plans = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { subscriptions: true } } } });
    res.json({
      plans: plans.map((plan) => ({
        ...plan,
        priceMonthly: Number(plan.priceMonthly.toString()),
        priceYearly: Number(plan.priceYearly.toString()),
      })),
    });
  }),
);

adminRouter.post(
  '/plans',
  validateBody(planSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    crossTenant(actor);
    const body = req.body as z.infer<typeof planSchema>;

    const plan = await prisma.plan.create({
      data: { ...body, priceMonthly: new Prisma.Decimal(body.priceMonthly), priceYearly: new Prisma.Decimal(body.priceYearly) },
    });
    await recordAudit({ actor, action: 'admin.plan_create', entity: 'Plan', entityId: plan.id, ip: req.ip });
    res.status(201).json({ plan });
  }),
);

adminRouter.patch(
  '/plans/:id',
  validateParams(idParam),
  validateBody(planSchema.partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    crossTenant(actor);
    const body = req.body as Partial<z.infer<typeof planSchema>>;

    const plan = await prisma.plan.update({
      where: { id: req.params.id },
      data: {
        ...body,
        ...(body.priceMonthly === undefined ? {} : { priceMonthly: new Prisma.Decimal(body.priceMonthly) }),
        ...(body.priceYearly === undefined ? {} : { priceYearly: new Prisma.Decimal(body.priceYearly) }),
      },
    });
    await recordAudit({ actor, action: 'admin.plan_update', entity: 'Plan', entityId: plan.id, ip: req.ip });
    res.json({ plan });
  }),
);

// ------------------------------------------------------------------ subscriptions

adminRouter.get(
  '/subscriptions',
  validateQuery(paginationQuery.extend({ status: z.nativeEnum(SubscriptionStatus).optional() })),
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { status?: SubscriptionStatus };
    const where: Prisma.SubscriptionWhereInput = query.status ? { status: query.status } : {};

    const [items, total] = await Promise.all([
      prisma.subscription.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          plan: true,
          organization: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
        },
      }),
      prisma.subscription.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

adminRouter.post(
  '/subscriptions',
  validateBody(
    z.object({
      organizationId: z.string().min(1).max(40),
      clientId: z.string().max(40).nullish(),
      planId: z.string().min(1).max(40),
      status: z.nativeEnum(SubscriptionStatus).default(SubscriptionStatus.TRIALING),
      renewalDate: z.coerce.date(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    crossTenant(actor);
    const body = req.body as { organizationId: string; clientId?: string | null; planId: string; status: SubscriptionStatus; renewalDate: Date };

    const [organization, plan] = await Promise.all([
      prisma.organization.findUnique({ where: { id: body.organizationId }, select: { id: true } }),
      prisma.plan.findUnique({ where: { id: body.planId }, select: { id: true } }),
    ]);
    if (!organization) throw notFound('Organization');
    if (!plan) throw notFound('Plan');

    if (body.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: body.clientId, organizationId: body.organizationId },
        select: { id: true },
      });
      if (!client) throw badRequest('That client does not belong to that organization');
    }

    const subscription = await prisma.subscription.create({
      data: {
        organizationId: body.organizationId,
        clientId: body.clientId ?? null,
        planId: body.planId,
        status: body.status,
        renewalDate: body.renewalDate,
        // No payment has been taken: providerRef stays null until billing exists.
        providerRef: null,
      },
      include: { plan: true, client: { select: { id: true, name: true } } },
    });

    await recordAudit({ actor, action: 'admin.subscription_create', entity: 'Subscription', entityId: subscription.id, ip: req.ip });
    res.status(201).json({ subscription });
  }),
);

adminRouter.patch(
  '/subscriptions/:id',
  validateParams(idParam),
  validateBody(z.object({ status: z.nativeEnum(SubscriptionStatus).optional(), planId: z.string().max(40).optional(), renewalDate: z.coerce.date().optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    crossTenant(actor);
    const subscription = await prisma.subscription.update({
      where: { id: req.params.id },
      data: req.body as Prisma.SubscriptionUpdateInput,
      include: { plan: true },
    });
    res.json({ subscription });
  }),
);

// ------------------------------------------------------------------ observability

adminRouter.get(
  '/audit',
  validateQuery(paginationQuery.extend({ entity: z.string().max(40).optional(), organizationId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { entity?: string; organizationId?: string };

    const where: Prisma.AuditLogWhereInput = {
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      ...(query.search ? { action: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true, email: true } }, organization: { select: { id: true, name: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

adminRouter.get(
  '/ai-usage',
  validateQuery(paginationQuery),
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    const query = req.query as unknown as z.infer<typeof paginationQuery>;

    const [items, total, byKind] = await Promise.all([
      prisma.aiUsage.findMany({
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: { organization: { select: { id: true, name: true } }, client: { select: { id: true, name: true } } },
      }),
      prisma.aiUsage.count(),
      prisma.aiUsage.groupBy({ by: ['kind', 'provider'], _count: { _all: true }, _avg: { latencyMs: true } }),
    ]);

    res.json({ ...pageResult(items, total, query), byKind, status: aiStatus() });
  }),
);

/** Effective runtime configuration. Secrets are reported as booleans only. */
adminRouter.get(
  '/system',
  asyncHandler(async (req, res) => {
    crossTenant(actorOf(req));
    res.json({
      node: process.version,
      environment: env.NODE_ENV,
      appUrl: env.APP_URL,
      uptimeSeconds: Math.round(process.uptime()),
      storage: { ...storageStatus(), maxUploadMb: env.MAX_UPLOAD_MB },
      ai: { ...aiStatus(), keyConfigured: hasOpenAi },
      session: { ttlHours: env.SESSION_TTL_HOURS, secureCookies: cookieSecure },
      rateLimit: { windowMinutes: env.RATE_LIMIT_WINDOW_MIN, max: env.RATE_LIMIT_MAX },
      database: { connected: true },
    });
  }),
);
