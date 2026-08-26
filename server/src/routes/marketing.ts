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

import { asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { adjacentProducts, fullMatrix } from '../services/marketing/capability-matrix.js';

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
