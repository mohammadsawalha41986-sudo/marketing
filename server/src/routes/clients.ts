/** /api/clients — client records and their nested overview. */

import { Router } from 'express';
import { ClientStatus, Language, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { actorOf, requireAuth, requireManager } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, isClientUser, orgId, type Actor } from '../lib/scope.js';
import { recordAudit } from '../services/audit.js';
import { derive, sumSnapshots } from '../services/analytics.js';

export const clientsRouter: Router = Router();
clientsRouter.use(requireAuth);

/**
 * Where-clause for the Client model itself. A client user is pinned to their own
 * row by id, so listing returns exactly one record and every lookup of another
 * client reads as "not found".
 */
function clientWhere(actor: Actor): Prisma.ClientWhereInput {
  const base: Prisma.ClientWhereInput = { organizationId: orgId(actor) };
  if (isClientUser(actor)) return { ...base, id: actor.clientId ?? '__none__' };
  return base;
}

const upsertSchema = z.object({
  name: z.string().trim().min(2).max(160),
  businessName: z.string().trim().min(2).max(160),
  email: z.string().trim().toLowerCase().email().max(255).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  businessType: z.string().trim().max(120).optional().or(z.literal('')),
  industry: z.string().trim().max(120).optional().or(z.literal('')),
  website: z.string().trim().url().max(255).optional().or(z.literal('')),
  location: z.string().trim().max(200).optional().or(z.literal('')),
  notes: z.string().trim().max(4000).optional().or(z.literal('')),
  status: z.nativeEnum(ClientStatus).default(ClientStatus.ACTIVE),
  socialLinks: z.record(z.string().max(300)).default({}),
  preferredLanguage: z.nativeEnum(Language).default(Language.EN),
});

const blankToNull = <T extends Record<string, unknown>>(input: T): T => {
  const output = { ...input };
  for (const [key, value] of Object.entries(output)) {
    if (value === '') (output as Record<string, unknown>)[key] = null;
  }
  return output;
};

clientsRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ status: z.nativeEnum(ClientStatus).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { status?: ClientStatus };

    const where: Prisma.ClientWhereInput = {
      ...clientWhere(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { businessName: { contains: query.search, mode: 'insensitive' } },
              { industry: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.client.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          brand: { select: { primaryColor: true, secondaryColor: true, accentColor: true, logoUrl: true } },
          subscription: { include: { plan: { select: { name: true, key: true } } } },
          _count: { select: { campaigns: true, contents: true, media: true } },
        },
      }),
      prisma.client.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

clientsRouter.post(
  '/',
  requireManager,
  validateBody(upsertSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const body = blankToNull(req.body as z.infer<typeof upsertSchema>);
    const { preferredLanguage, ...clientData } = body;

    // Every client gets a Brand row immediately: the AI layer requires one.
    const client = await prisma.client.create({
      data: {
        ...clientData,
        organizationId: orgId(actor),
        socialLinks: clientData.socialLinks as Prisma.InputJsonValue,
        brand: {
          create: {
            organizationId: orgId(actor),
            businessName: clientData.businessName,
            businessType: clientData.businessType ?? null,
            industry: clientData.industry ?? null,
            location: clientData.location ?? null,
            preferredLanguage,
          },
        },
      },
      include: { brand: true },
    });

    await recordAudit({ actor, action: 'client.create', entity: 'Client', entityId: client.id, ip: req.ip });
    res.status(201).json({ client });
  }),
);

clientsRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const client = await prisma.client.findFirst({
      where: { ...clientWhere(actor), id: req.params.id },
      include: {
        brand: { include: { assets: true } },
        subscription: { include: { plan: true } },
        users: { select: { id: true, name: true, email: true, role: true, isActive: true, lastLoginAt: true } },
        integrations: { select: { id: true, platform: true, status: true, accountName: true, lastSyncAt: true } },
        _count: { select: { campaigns: true, contents: true, media: true, reports: true } },
      },
    });
    if (!client) throw notFound('Client');
    res.json({ client });
  }),
);

/** Headline numbers for the client overview tab. */
clientsRouter.get(
  '/:id/overview',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const client = await prisma.client.findFirst({
      where: { ...clientWhere(actor), id: req.params.id },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    const since = new Date(Date.now() - 29 * 86400000);

    const [snapshots, campaigns, pendingApprovals, scheduled, recentContent] = await Promise.all([
      prisma.analyticsSnapshot.findMany({
        where: { clientId: client.id, date: { gte: since } },
        select: {
          platform: true, date: true, spend: true, reach: true, impressions: true,
          clicks: true, conversions: true, revenue: true, engagements: true,
        },
      }),
      prisma.campaign.groupBy({ by: ['status'], where: { clientId: client.id }, _count: { _all: true } }),
      prisma.approval.count({ where: { clientId: client.id, status: 'PENDING' } }),
      prisma.content.count({ where: { clientId: client.id, status: 'SCHEDULED' } }),
      prisma.content.findMany({
        where: { clientId: client.id },
        orderBy: { updatedAt: 'desc' },
        take: 6,
        select: { id: true, name: true, status: true, platform: true, scheduledAt: true, updatedAt: true },
      }),
    ]);

    res.json({
      metrics: derive(sumSnapshots(snapshots)),
      campaignsByStatus: Object.fromEntries(campaigns.map((row) => [row.status, row._count._all])),
      pendingApprovals,
      scheduled,
      recentContent,
      window: { from: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
    });
  }),
);

clientsRouter.patch(
  '/:id',
  requireManager,
  validateParams(idParam),
  validateBody(upsertSchema.partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.client.findFirst({
      where: { ...clientWhere(actor), id: req.params.id },
      select: { id: true },
    });
    if (!existing) throw notFound('Client');

    const body = blankToNull(req.body as Partial<z.infer<typeof upsertSchema>>);
    const { preferredLanguage, socialLinks, ...rest } = body;

    const client = await prisma.client.update({
      where: { id: existing.id },
      data: {
        ...rest,
        ...(socialLinks ? { socialLinks: socialLinks as Prisma.InputJsonValue } : {}),
        ...(preferredLanguage ? { brand: { update: { preferredLanguage } } } : {}),
      },
      include: { brand: true },
    });

    await recordAudit({ actor, action: 'client.update', entity: 'Client', entityId: client.id, ip: req.ip });
    res.json({ client });
  }),
);

clientsRouter.delete(
  '/:id',
  requireManager,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.client.findFirst({
      where: { ...clientWhere(actor), id: req.params.id },
      select: { id: true, name: true },
    });
    if (!existing) throw notFound('Client');

    await prisma.client.delete({ where: { id: existing.id } });
    await recordAudit({
      actor, action: 'client.delete', entity: 'Client', entityId: existing.id,
      meta: { name: existing.name }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
