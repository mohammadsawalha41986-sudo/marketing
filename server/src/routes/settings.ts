/**
 * /api/settings — workspace settings and the operator's own storage usage.
 *
 * These are application settings, not account management: there are no users to
 * invite, no roles to assign and no restaurant logins to administer.
 */

import { Router } from 'express';
import { Language } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { WORKSPACE_ID, readWorkspace } from '../lib/workspace.js';
import { recordAudit } from '../services/audit.js';
import { aiStatus } from '../services/ai/index.js';
import { env } from '../env.js';

export const settingsRouter: Router = Router();
settingsRouter.use(requireAuth);

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  // ISO 4217, uppercase. SAR is the default for the Gulf market.
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Expected a three-letter currency code such as SAR').optional(),
  timezone: z.string().trim().min(1).max(60).optional(),
  locale: z.nativeEnum(Language).optional(),
  logoUrl: z.string().trim().max(500).nullish(),
  preferences: z.record(z.unknown()).optional(),
});

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [workspace, media, counts] = await Promise.all([
      readWorkspace(),
      prisma.media.aggregate({ _sum: { sizeBytes: true }, _count: { _all: true } }),
      Promise.all([
        prisma.restaurant.count(),
        prisma.campaign.count(),
        prisma.content.count(),
        prisma.ad.count(),
      ]),
    ]);

    const [restaurants, campaigns, contents, ads] = counts;

    res.json({
      workspace,
      ai: aiStatus(),
      storage: {
        driver: env.STORAGE_DRIVER,
        files: media._count._all,
        bytes: media._sum.sizeBytes ?? 0,
        megabytes: Number(((media._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2)),
        maxUploadMb: env.MAX_UPLOAD_MB,
      },
      totals: { restaurants, campaigns, contents, ads },
    });
  }),
);

settingsRouter.patch(
  '/',
  validateBody(settingsSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof settingsSchema>;

    const workspace = await prisma.workspace.upsert({
      where: { id: WORKSPACE_ID },
      create: { id: WORKSPACE_ID, ...body, preferences: (body.preferences ?? {}) as object },
      update: { ...body, ...(body.preferences ? { preferences: body.preferences as object } : {}) },
    });

    await recordAudit({ actor, action: 'settings.update', entity: 'Workspace', entityId: workspace.id, ip: req.ip });
    res.json({ workspace });
  }),
);
