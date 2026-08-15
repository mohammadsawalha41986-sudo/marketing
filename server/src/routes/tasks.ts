/** /api/tasks — the operator's marketing to-do list and follow-ups. */

import { Router } from 'express';
import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { recordAudit } from '../services/audit.js';

export const tasksRouter: Router = Router();
tasksRouter.use(requireAuth);

const upsertSchema = z.object({
  title: z.string().trim().min(2).max(300),
  details: z.string().trim().max(4000).nullish(),
  // Both optional: a task may be general workspace work with no restaurant.
  restaurantId: z.string().max(40).nullish(),
  campaignId: z.string().max(40).nullish(),
  status: z.nativeEnum(TaskStatus).default(TaskStatus.TODO),
  priority: z.nativeEnum(TaskPriority).default(TaskPriority.MEDIUM),
  dueAt: z.coerce.date().nullish(),
});

const taskInclude = {
  restaurant: { select: { id: true, name: true, logoUrl: true } },
  campaign: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;

/** A campaign may only be attached to a task that names its own restaurant. */
async function assertRefs(restaurantId?: string | null, campaignId?: string | null) {
  if (restaurantId) {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { id: true } });
    if (!restaurant) throw notFound('Restaurant');
  }
  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, ...(restaurantId ? { restaurantId } : {}) },
      select: { id: true },
    });
    if (!campaign) throw notFound('Campaign');
  }
}

tasksRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      restaurantId: z.string().max(40).optional(),
      campaignId: z.string().max(40).optional(),
      status: z.nativeEnum(TaskStatus).optional(),
      priority: z.nativeEnum(TaskPriority).optional(),
      overdue: z.coerce.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      restaurantId?: string; campaignId?: string; status?: TaskStatus;
      priority?: TaskPriority; overdue?: boolean;
    };

    const where: Prisma.TaskWhereInput = {
      ...(query.restaurantId ? { restaurantId: query.restaurantId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.overdue ? { dueAt: { lt: new Date() }, status: { not: TaskStatus.DONE } } : {}),
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total, openCount, overdueCount] = await Promise.all([
      prisma.task.findMany({
        where,
        ...paginate(query),
        // Undated tasks sort last rather than first, which is what `nulls: 'last'`
        // buys over a plain ascending sort on a nullable column.
        orderBy: [{ status: 'asc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
        include: taskInclude,
      }),
      prisma.task.count({ where }),
      prisma.task.count({ where: { status: { not: TaskStatus.DONE } } }),
      prisma.task.count({ where: { status: { not: TaskStatus.DONE }, dueAt: { lt: new Date() } } }),
    ]);

    res.json({ ...pageResult(items, total, query), summary: { open: openCount, overdue: overdueCount } });
  }),
);

tasksRouter.post(
  '/',
  validateBody(upsertSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof upsertSchema>;
    await assertRefs(body.restaurantId, body.campaignId);

    const task = await prisma.task.create({
      data: {
        ...body,
        assigneeId: actor.id,
        completedAt: body.status === TaskStatus.DONE ? new Date() : null,
      },
      include: taskInclude,
    });

    await recordAudit({ actor, action: 'task.create', entity: 'Task', entityId: task.id, ip: req.ip });
    res.status(201).json({ task });
  }),
);

tasksRouter.get(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: taskInclude });
    if (!task) throw notFound('Task');
    res.json({ task });
  }),
);

tasksRouter.patch(
  '/:id',
  validateParams(idParam),
  validateBody(upsertSchema.partial()),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.task.findUnique({
      where: { id: req.params.id },
      select: { id: true, restaurantId: true, status: true },
    });
    if (!existing) throw notFound('Task');

    const body = req.body as Partial<z.infer<typeof upsertSchema>>;
    if (body.restaurantId !== undefined || body.campaignId !== undefined) {
      await assertRefs(
        body.restaurantId === undefined ? existing.restaurantId : body.restaurantId,
        body.campaignId,
      );
    }

    const task = await prisma.task.update({
      where: { id: existing.id },
      data: {
        ...body,
        // completedAt tracks status so "when was this finished" stays answerable.
        ...(body.status === undefined
          ? {}
          : { completedAt: body.status === TaskStatus.DONE ? new Date() : null }),
      },
      include: taskInclude,
    });

    await recordAudit({ actor, action: 'task.update', entity: 'Task', entityId: task.id, ip: req.ip });
    res.json({ task });
  }),
);

tasksRouter.delete(
  '/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const existing = await prisma.task.findUnique({ where: { id: req.params.id }, select: { id: true, title: true } });
    if (!existing) throw notFound('Task');

    await prisma.task.delete({ where: { id: existing.id } });
    await recordAudit({
      actor, action: 'task.delete', entity: 'Task', entityId: existing.id,
      meta: { title: existing.title }, ip: req.ip,
    });
    res.json({ ok: true });
  }),
);
