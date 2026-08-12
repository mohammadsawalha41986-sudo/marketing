/** /api/calendar — scheduled content by month, week or day. */

import { Router } from 'express';
import { ContentStatus, Platform, Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { dateString, idParam } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId, scopeWhere } from '../lib/scope.js';
import { recordAudit } from '../services/audit.js';

export const calendarRouter: Router = Router();
calendarRouter.use(requireAuth);

const viewQuery = z.object({
  view: z.enum(['month', 'week', 'day']).default('month'),
  anchor: dateString.optional(),
  clientId: z.string().max(40).optional(),
  platform: z.nativeEnum(Platform).optional(),
  status: z.nativeEnum(ContentStatus).optional(),
});

/** Inclusive window for the requested view, anchored on a UTC date. */
function windowFor(view: 'month' | 'week' | 'day', anchor: Date): { from: Date; to: Date } {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();

  if (view === 'day') {
    return { from: new Date(Date.UTC(year, month, day)), to: new Date(Date.UTC(year, month, day, 23, 59, 59, 999)) };
  }
  if (view === 'week') {
    // Weeks run Monday to Sunday.
    const offset = (anchor.getUTCDay() + 6) % 7;
    const from = new Date(Date.UTC(year, month, day - offset));
    const to = new Date(from.getTime() + 6 * 86400000 + 86399999);
    return { from, to };
  }
  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
  };
}

calendarRouter.get(
  '/',
  validateQuery(viewQuery),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof viewQuery>;
    const { from, to } = windowFor(query.view, query.anchor ?? new Date());
    const clientId = resolveClientId(actor, query.clientId);

    const where: Prisma.ContentWhereInput = {
      organizationId: orgId(actor),
      scheduledAt: { gte: from, lte: to },
      ...(clientId ? { clientId } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const items = await prisma.content.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true, name: true, status: true, platform: true, type: true, language: true,
        scheduledAt: true, timezone: true, headline: true, publishedAt: true, failureReason: true,
        client: { select: { id: true, name: true, logoUrl: true } },
        campaign: { select: { id: true, name: true } },
        mediaLinks: {
          take: 1,
          orderBy: { position: 'asc' },
          include: { media: { select: { id: true, url: true, thumbnailUrl: true, type: true } } },
        },
      },
    });

    // Counts drive the legend, and stay accurate when a filter is applied.
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      view: query.view,
      range: { from: from.toISOString(), to: to.toISOString() },
      items,
      counts,
    });
  }),
);

/** Drag-and-drop rescheduling from the calendar. */
calendarRouter.patch(
  '/:id/reschedule',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ scheduledAt: z.coerce.date(), timezone: z.string().trim().max(60).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { scheduledAt, timezone } = req.body as { scheduledAt: Date; timezone?: string };

    const existing = await prisma.content.findFirst({
      where: { id: req.params.id, ...scopeWhere(actor) },
      select: { id: true, status: true, timezone: true },
    });
    if (!existing) throw notFound('Content');
    if (existing.status === ContentStatus.PUBLISHED) throw badRequest('Published content cannot be rescheduled');

    const content = await prisma.content.update({
      where: { id: existing.id },
      data: { scheduledAt, timezone: timezone ?? existing.timezone },
      select: { id: true, name: true, scheduledAt: true, timezone: true, status: true, platform: true, organizationId: true, clientId: true },
    });

    await prisma.calendarEvent.upsert({
      where: { contentId: content.id },
      create: {
        contentId: content.id,
        organizationId: content.organizationId,
        clientId: content.clientId,
        title: content.name,
        platform: content.platform,
        startAt: scheduledAt,
        timezone: content.timezone,
      },
      update: { startAt: scheduledAt, timezone: content.timezone },
    });

    await recordAudit({ actor, action: 'content.reschedule', entity: 'Content', entityId: content.id, ip: req.ip });
    res.json({ content });
  }),
);
