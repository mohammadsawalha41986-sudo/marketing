/**
 * The Marketing Command Center's capability endpoint.
 *
 * One read, answering what every surface in the command centre needs before it
 * can render honestly: which platforms this deployment can actually publish to,
 * advertise on, or neither — and for each thing it cannot do, which of the four
 * reasons applies and what the operator would have to do about it.
 *
 * Deliberately a single endpoint rather than one per platform. The command
 * centre's navigation has to decide what to show before the operator has picked
 * anything, and nine round trips to build a sidebar is a page that renders in
 * stages and moves under the cursor.
 *
 * Nothing here is tenant-specific: the matrix describes what this *deployment*
 * has built and configured, which is identical for every organisation on it. It
 * still sits behind the authenticated router, because the variable names it
 * reports are infrastructure detail that has no business being public.
 */

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { resolveClientId } from '../lib/scope.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { adjacentProducts, fullMatrix } from '../services/marketing/capability-matrix.js';
import { pulse } from '../services/marketing/pulse.js';
import { WORKSPACE_ORDER, WORKSPACES, resolveWorkspace } from '../services/marketing/workspaces.js';

export const marketingRouter: Router = Router();

/*
 * Authentication is per-router in this application rather than applied to the
 * whole API, and omitting this line served the matrix to anyone who asked. The
 * payload is not tenant data, but it names this deployment's infrastructure
 * variables and enumerates which integrations are unconfigured — a description
 * of where the gaps are, handed out unauthenticated.
 */
marketingRouter.use(requireAuth);

marketingRouter.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    /*
     * `requiredEnv` carries variable *names* only — never values, and never a
     * hint at a value. Naming them is the point: "Google is not configured"
     * sends an operator hunting, while "GOOGLE_CLIENT_SECRET is not set" is a
     * task they can finish.
     */
    res.json({
      platforms: fullMatrix(),
      adjacent: adjacentProducts(),
    });
  }),
);

/**
 * The workspace registry — which platforms each navigable workspace covers.
 *
 * Served rather than duplicated in the client so the two cannot disagree about
 * whether Instagram belongs to Meta. The client still needs its own labels for
 * translation, but never its own opinion about membership.
 */
marketingRouter.get(
  '/workspaces',
  asyncHandler(async (_req, res) => {
    res.json({ workspaces: WORKSPACE_ORDER.map((key) => WORKSPACES[key]) });
  }),
);

/**
 * Today's pipeline and connection health, for the dashboard and each workspace.
 *
 * `from`/`to` are required and come from the browser, because "today" is the
 * operator's day and the server has no way to know which one that is. A
 * workspace slug narrows the counts to that workspace's platforms.
 */
marketingRouter.get(
  '/pulse',
  validateQuery(z.object({
    clientId: z.string().max(40).optional(),
    workspace: z.string().max(40).optional(),
    from: z.coerce.date(),
    to: z.coerce.date(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as {
      clientId?: string; workspace?: string; from: Date; to: Date;
    };

    /*
     * An unknown workspace slug is a 404 rather than a silent fall-back to
     * every platform: counting the whole account under a heading that says
     * "TikTok" is worse than saying the page does not exist.
     */
    const workspace = query.workspace ? resolveWorkspace(query.workspace) : null;
    if (query.workspace && !workspace) throw notFound('Workspace');

    const clientId = resolveClientId(actor, query.clientId);

    const result = await pulse({
      prisma,
      actor,
      clientId,
      platforms: workspace?.platforms,
      from: query.from,
      to: query.to,
    });

    res.json({
      workspace: workspace ?? null,
      ...result,
    });
  }),
);
