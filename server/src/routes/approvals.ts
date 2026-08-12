/** /api/approvals — the client-side review queue. */

import { Router } from 'express';
import { ApprovalStatus, ContentStatus, NotificationType, Prisma, Role } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, forbidden, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { orgId, resolveClientId } from '../lib/scope.js';
import { recordAudit } from '../services/audit.js';
import { notify } from '../services/notify.js';

export const approvalsRouter: Router = Router();
approvalsRouter.use(requireAuth);

/** Content status implied by an approval decision. */
const RESULTING_STATUS: Record<Exclude<ApprovalStatus, 'PENDING'>, ContentStatus> = {
  APPROVED: ContentStatus.APPROVED,
  REJECTED: ContentStatus.REJECTED,
  CHANGES_REQUESTED: ContentStatus.CHANGES_REQUESTED,
};

approvalsRouter.get(
  '/',
  validateQuery(
    paginationQuery.extend({
      status: z.nativeEnum(ApprovalStatus).optional(),
      clientId: z.string().max(40).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & {
      status?: ApprovalStatus; clientId?: string;
    };
    const clientId = resolveClientId(actor, query.clientId);

    const where: Prisma.ApprovalWhereInput = {
      organizationId: orgId(actor),
      ...(clientId ? { clientId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.approval.findMany({
        where,
        ...paginate(query),
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: {
          decidedBy: { select: { id: true, name: true } },
          content: {
            select: {
              id: true, name: true, platform: true, type: true, language: true, status: true,
              headline: true, caption: true, primaryText: true, cta: true, scheduledAt: true,
              client: { select: { id: true, name: true, logoUrl: true } },
              campaign: { select: { id: true, name: true } },
              hashtags: { select: { tag: true } },
              mediaLinks: {
                orderBy: { position: 'asc' },
                include: { media: { select: { id: true, url: true, thumbnailUrl: true, type: true } } },
              },
            },
          },
        },
      }),
      prisma.approval.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

const decisionSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  note: z.string().trim().max(2000).optional(),
});

/**
 * Record a decision. Agency staff can act on behalf of a client, but a client
 * user can only ever decide on their own client's content — enforced by the
 * scoped lookup below rather than by the role alone.
 */
approvalsRouter.post(
  '/:id/decision',
  validateParams(idParam),
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { status, note } = req.body as z.infer<typeof decisionSchema>;

    if (actor.role === Role.CLIENT_USER) {
      throw forbidden('Only a client admin can approve or reject content');
    }

    const clientId = resolveClientId(actor, undefined);
    const approval = await prisma.approval.findFirst({
      where: {
        id: req.params.id,
        organizationId: orgId(actor),
        ...(clientId ? { clientId } : {}),
      },
      include: { content: { select: { id: true, name: true, clientId: true } } },
    });
    if (!approval) throw notFound('Approval');

    const [updated] = await prisma.$transaction([
      prisma.approval.update({
        where: { id: approval.id },
        data: { status, note: note ?? null, decidedById: actor.id, decidedAt: new Date() },
        include: { decidedBy: { select: { id: true, name: true } } },
      }),
      prisma.content.update({
        where: { id: approval.contentId },
        data: { status: RESULTING_STATUS[status] },
      }),
      ...(note
        ? [prisma.comment.create({ data: { contentId: approval.contentId, authorId: actor.id, body: note } })]
        : []),
    ]);

    const typeByStatus = {
      APPROVED: NotificationType.CONTENT_APPROVED,
      REJECTED: NotificationType.CONTENT_REJECTED,
      CHANGES_REQUESTED: NotificationType.CHANGES_REQUESTED,
    } as const;

    await notify({
      organizationId: orgId(actor),
      clientId: approval.clientId,
      type: typeByStatus[status],
      title: `${approval.content.name}: ${status.toLowerCase().replace('_', ' ')}`,
      body: note ?? undefined,
      link: `/app/content/${approval.contentId}`,
      audience: 'agency',
    });

    await recordAudit({
      actor, action: `approval.${status.toLowerCase()}`, entity: 'Approval', entityId: approval.id,
      meta: { contentId: approval.contentId }, ip: req.ip,
    });

    res.json({ approval: updated });
  }),
);

approvalsRouter.post(
  '/:id/comment',
  validateParams(idParam),
  validateBody(z.object({ body: z.string().trim().min(1).max(2000) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, undefined);

    const approval = await prisma.approval.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      select: { contentId: true },
    });
    if (!approval) throw notFound('Approval');

    const comment = await prisma.comment.create({
      data: { contentId: approval.contentId, authorId: actor.id, body: (req.body as { body: string }).body },
      include: { author: { select: { id: true, name: true } } },
    });

    res.status(201).json({ comment });
  }),
);
