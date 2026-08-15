/**
 * /api/auth — sign in, sign out, session, preferences, password change.
 *
 * There is deliberately no registration, no invitation and no password-reset
 * endpoint. This is a private application with one operator account, created by
 * `npm run owner:create` against the database. An open registration route would
 * let anyone who finds the URL mint themselves an account with full access to
 * every restaurant, and a self-service reset flow with no mail transport
 * configured would be a way in rather than a way back in.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Language } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, unauthorized } from '../lib/errors.js';
import { hashPassword, passwordProblems, verifyPassword } from '../lib/password.js';
import {
  clearSessionCookies,
  createSession,
  destroyAllSessions,
  destroySession,
  setSessionCookies,
} from '../lib/session.js';
import { validateBody } from '../middleware/validate.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { readWorkspace } from '../lib/workspace.js';
import { isProd } from '../env.js';

export const authRouter: Router = Router();

/** Tight limit on credential endpoints; the global limiter is far looser. */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProd ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

const passwordField = z.string().min(1).superRefine((value, ctx) => {
  for (const problem of passwordProblems(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password ${problem}` });
  }
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(200),
});

const publicUserSelect = {
  id: true, email: true, name: true, role: true, locale: true,
  themePref: true, avatarUrl: true,
} as const;

authRouter.post(
  '/login',
  credentialLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await prisma.user.findUnique({ where: { email } });

    // Same message and comparable timing whether the user exists or not.
    const ok = user
      ? await verifyPassword(user.passwordHash, password)
      : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$0000000000000000000000000000000000000000000', password);

    if (!user || !ok || !user.isActive) {
      throw unauthorized('Email or password is incorrect');
    }

    const { token, csrf, expiresAt } = await createSession(user.id, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setSessionCookies(res, token, csrf, expiresAt);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await recordAudit({
      actor: { id: user.id, email: user.email, name: user.name, role: user.role },
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      ip: req.ip,
    });

    res.json({
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role,
        locale: user.locale, themePref: user.themePref, avatarUrl: user.avatarUrl,
      },
    });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.sessionToken) await destroySession(req.sessionToken);
    clearSessionCookies(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const [user, workspace] = await Promise.all([
      prisma.user.findUnique({ where: { id: actor.id }, select: publicUserSelect }),
      readWorkspace(),
    ]);
    if (!user) throw unauthorized();
    res.json({ user, workspace });
  }),
);

const preferencesSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  locale: z.nativeEnum(Language).optional(),
  themePref: z.enum(['dark', 'light', 'system']).optional(),
});

authRouter.patch(
  '/me',
  requireAuth,
  validateBody(preferencesSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const user = await prisma.user.update({
      where: { id: actor.id },
      data: req.body as z.infer<typeof preferencesSchema>,
      select: publicUserSelect,
    });
    res.json({ user });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

authRouter.post(
  '/change-password',
  requireAuth,
  credentialLimiter,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

    const user = await prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw unauthorized('Current password is incorrect');
    }

    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    // Changing a password invalidates every other session.
    await destroyAllSessions(user.id);
    clearSessionCookies(res);

    await recordAudit({ actor, action: 'auth.password_changed', entity: 'User', entityId: user.id, ip: req.ip });
    res.json({ ok: true, message: 'Password changed. Please sign in again.' });
  }),
);
