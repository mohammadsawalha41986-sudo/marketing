/**
 * Super Admin provisioning and recovery.
 *
 * The product has no mail transport, so the self-service "forgot password" flow
 * never reaches anyone in production, and nothing creates the first operator
 * account outside the demo seed. This is the supported way in: an operator with
 * access to the deployment supplies the credentials through the environment (or
 * a hidden prompt), and they are hashed here — never logged, never returned.
 *
 * It only ever touches the one account it is asked about.
 */

import { Language, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, passwordProblems } from '../lib/password.js';

export type AdminAccountResult =
  | { action: 'created' | 'repaired' | 'password_reset'; email: string; userId: string; changes: string[] }
  | { action: 'unchanged'; email: string; userId: string; changes: string[] };

const emailSchema = z.string().trim().toLowerCase().email().max(255);

export class AdminAccountError extends Error {}

function checkCredentials(emailInput: string, password: string | undefined): string {
  const parsed = emailSchema.safeParse(emailInput);
  if (!parsed.success) throw new AdminAccountError('A valid admin email is required');
  if (password !== undefined) {
    const problems = passwordProblems(password);
    if (problems.length > 0) throw new AdminAccountError(`Password ${problems.join(', ')}`);
  }
  return parsed.data;
}

/** The workspace the operator belongs to: the oldest one, or a new one if none exists. */
async function workspaceId(): Promise<string> {
  const existing = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.organization.create({
    data: { name: 'Marketing OS', slug: 'marketing-os', locale: Language.EN },
    select: { id: true },
  });
  return created.id;
}

/**
 * Make `email` a working Super Admin.
 *
 *  - missing            -> created (password required)
 *  - present            -> role, active flag and workspace link are repaired;
 *                          the password changes only if `password` is given
 *    and `resetPassword` is true.
 */
export async function provisionSuperAdmin(input: {
  email: string;
  password?: string;
  name?: string;
  resetPassword?: boolean;
}): Promise<AdminAccountResult> {
  const email = checkCredentials(input.email, input.password);
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    if (!input.password) throw new AdminAccountError('A password is required to create the account');
    const created = await prisma.user.create({
      data: {
        email,
        name: input.name?.trim() || 'Platform Owner',
        passwordHash: await hashPassword(input.password),
        role: Role.SUPER_ADMIN,
        organizationId: await workspaceId(),
        isActive: true,
      },
      select: { id: true },
    });
    return { action: 'created', email, userId: created.id, changes: ['account created'] };
  }

  const data: { role?: Role; isActive?: boolean; organizationId?: string; passwordHash?: string } = {};
  const changes: string[] = [];
  if (user.role !== Role.SUPER_ADMIN) { data.role = Role.SUPER_ADMIN; changes.push(`role ${user.role} -> SUPER_ADMIN`); }
  if (!user.isActive) { data.isActive = true; changes.push('account re-activated'); }
  if (!user.organizationId) { data.organizationId = await workspaceId(); changes.push('attached to workspace'); }
  const reset = Boolean(input.resetPassword);
  if (reset) {
    if (!input.password) throw new AdminAccountError('A password is required to reset it');
    data.passwordHash = await hashPassword(input.password);
    changes.push('password reset');
  }

  if (changes.length === 0) return { action: 'unchanged', email, userId: user.id, changes };

  await prisma.user.update({ where: { id: user.id }, data });
  // A changed password or role must not leave old sessions alive.
  if (reset || data.role) await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.auditLog.create({
    data: {
      organizationId: data.organizationId ?? user.organizationId,
      userId: user.id,
      action: 'admin.account_provisioned',
      entity: 'User',
      entityId: user.id,
      meta: { changes },
    },
  }).catch(() => undefined);
  return { action: reset ? 'password_reset' : 'repaired', email, userId: user.id, changes };
}

/**
 * Optional first-run bootstrap from the environment. Creates the owner account
 * only when the platform has no Super Admin at all and the email is unused; it
 * never overwrites or promotes anything, so leaving the variables set is safe.
 */
export async function bootstrapSuperAdminFromEnv(
  source: { ADMIN_BOOTSTRAP_EMAIL?: string; ADMIN_BOOTSTRAP_PASSWORD?: string; ADMIN_BOOTSTRAP_NAME?: string } = process.env,
): Promise<string> {
  const email = source.ADMIN_BOOTSTRAP_EMAIL?.trim();
  const password = source.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) return 'not configured';

  if (await prisma.user.count({ where: { role: Role.SUPER_ADMIN } }) > 0) return 'skipped: a Super Admin already exists';
  const normalized = checkCredentials(email, password);
  if (await prisma.user.findUnique({ where: { email: normalized }, select: { id: true } })) {
    return 'skipped: that email already belongs to a non-admin account (use the admin-account script to promote it)';
  }
  await provisionSuperAdmin({ email: normalized, password, name: source.ADMIN_BOOTSTRAP_NAME });
  return 'Super Admin created';
}
