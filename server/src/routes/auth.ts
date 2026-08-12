/** /api/auth — registration, login, session, password reset. */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Language, Role } from '@prisma/client';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { hashPassword, passwordProblems, verifyPassword } from '../lib/password.js';
import {
  clearSessionCookies,
  createSession,
  destroyAllSessions,
  destroySession,
  hashToken,
  newToken,
  setSessionCookies,
} from '../lib/session.js';
import { validateBody } from '../middleware/validate.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
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

const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  password: passwordField,
  organizationName: z.string().trim().min(2).max(160).optional(),
  locale: z.nativeEnum(Language).default(Language.EN),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(200),
});

function publicUser(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
  locale: Language;
  themePref: string;
  avatarUrl: string | null;
  organizationId: string | null;
  clientId: string | null;
}) {
  return user;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'agency';
}

// Registration creates a new agency tenant with the registrant as its admin.
authRouter.post(
  '/register',
  credentialLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, organizationName, locale } = req.body as z.infer<typeof registerSchema>;

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw conflict('An account with that email already exists');

    const orgName = organizationName?.trim() || `${name}'s workspace`;
    let slug = slugify(orgName);
    if (await prisma.organization.findUnique({ where: { slug }, select: { id: true } })) {
      slug = `${slug}-${randomBytes(3).toString('hex')}`;
    }

    const user = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: orgName, slug, locale },
      });
      return tx.user.create({
        data: {
          name,
          email,
          passwordHash: await hashPassword(password),
          role: Role.AGENCY_ADMIN,
          locale,
          organizationId: organization.id,
        },
        select: {
          id: true, email: true, name: true, role: true, locale: true,
          themePref: true, avatarUrl: true, organizationId: true, clientId: true,
        },
      });
    });

    const { token, csrf, expiresAt } = await createSession(user.id, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setSessionCookies(res, token, csrf, expiresAt);

    await recordAudit({ actor: { ...user, role: user.role }, action: 'auth.register', entity: 'User', entityId: user.id, ip: req.ip });
    res.status(201).json({ user: publicUser(user) });
  }),
);

authRouter.post(
  '/login',
  credentialLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await prisma.user.findUnique({ where: { email } });

    // Same message and comparable timing whether the user exists or not.
    const ok = user ? await verifyPassword(user.passwordHash, password) : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$0000000000000000000000000000000000000000000', password);

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
      actor: { id: user.id, email: user.email, name: user.name, role: user.role, organizationId: user.organizationId, clientId: user.clientId },
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      ip: req.ip,
    });

    res.json({
      user: publicUser({
        id: user.id, email: user.email, name: user.name, role: user.role, locale: user.locale,
        themePref: user.themePref, avatarUrl: user.avatarUrl, organizationId: user.organizationId, clientId: user.clientId,
      }),
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
    const user = await prisma.user.findUnique({
      where: { id: actor.id },
      select: {
        id: true, email: true, name: true, role: true, locale: true, themePref: true,
        avatarUrl: true, organizationId: true, clientId: true,
        organization: { select: { id: true, name: true, slug: true, logoUrl: true } },
        client: {
          select: {
            id: true, name: true, businessName: true, logoUrl: true,
            brand: {
              select: {
                primaryColor: true, secondaryColor: true, accentColor: true,
                backgroundColor: true, textColor: true, fontFamily: true, logoUrl: true,
              },
            },
          },
        },
      },
    });
    if (!user) throw unauthorized();
    res.json({ user });
  }),
);

const preferencesSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
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
      select: {
        id: true, email: true, name: true, role: true, locale: true,
        themePref: true, avatarUrl: true, organizationId: true, clientId: true,
      },
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

/**
 * Password reset. The token is returned in the response only outside production,
 * because no mail transport is configured yet — in production the token is
 * created and logged for the operator, never disclosed to the caller.
 */
authRouter.post(
  '/forgot-password',
  credentialLimiter,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email() })),
  asyncHandler(async (req, res) => {
    const { email } = req.body as { email: string };
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });

    let devToken: string | undefined;
    if (user) {
      const token = newToken();
      devToken = token;
      await prisma.passwordResetToken.create({
        data: {
          tokenHash: createHash('sha256').update(token).digest('hex'),
          userId: user.id,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      if (isProd) console.info(`[auth] password reset requested for ${email}; token issued`);
    }

    // Identical response either way, so the endpoint cannot enumerate accounts.
    res.json({
      ok: true,
      message: 'If that email is registered, a reset link has been issued.',
      ...(isProd ? {} : { devToken }),
    });
  }),
);

authRouter.post(
  '/reset-password',
  credentialLimiter,
  validateBody(z.object({ token: z.string().min(10), password: passwordField })),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as { token: string; password: string };

    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      throw badRequest('That reset link is invalid or has expired');
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(password) } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.session.deleteMany({ where: { userId: record.userId } }),
    ]);

    res.json({ ok: true, message: 'Password reset. You can sign in now.' });
  }),
);
