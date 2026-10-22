/** Super Admin provisioning: the way into a deployment that has no mail and no seed. */

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Role } from '@prisma/client';

import { agent, app, createTenant, prisma, resetDatabase } from './helpers.js';
import { AdminAccountError, bootstrapSuperAdminFromEnv, provisionSuperAdmin } from '../src/services/admin-account.js';

const EMAIL = 'owner@platform.test';
const PW = 'Own3r-Secret-pw';

describe('super admin provisioning', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates an owner who can log in, open the admin area, log out and back in', async () => {
    const result = await provisionSuperAdmin({ email: ' Owner@Platform.test ', password: PW });
    expect(result.action).toBe('created');

    const a = agent();
    expect((await a.login(EMAIL, 'wrong-Password1')).status).toBe(401);
    const login = await a.login(EMAIL, PW);
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('SUPER_ADMIN');
    expect(login.body.user.organizationId).toBeTruthy();

    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await a.get('/api/admin/dashboard')).status).toBe(200);
    expect((await a.get('/api/admin/users')).status).toBe(200);

    expect((await a.post('/api/auth/logout')).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(401);
    expect((await a.login(EMAIL, PW)).status).toBe(200);
  });

  it('stores only an argon2id hash and never writes the password to the audit log', async () => {
    await provisionSuperAdmin({ email: EMAIL, password: PW });
    await provisionSuperAdmin({ email: EMAIL, password: 'Another-Pw-123', resetPassword: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    const logs = JSON.stringify(await prisma.auditLog.findMany());
    expect(logs).not.toContain('Another-Pw-123');
    expect(logs).not.toContain(PW);
  });

  it('repairs an existing account without touching its password', async () => {
    const tenant = await createTenant('repair');
    await prisma.user.update({ where: { email: tenant.staffEmail }, data: { role: Role.AGENCY_STAFF, isActive: false, organizationId: null } });
    const before = await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } });

    const result = await provisionSuperAdmin({ email: tenant.staffEmail });
    expect(result.action).toBe('repaired');
    const after = await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } });
    expect(after).toMatchObject({ role: 'SUPER_ADMIN', isActive: true });
    expect(after.organizationId).toBe(tenant.organizationId);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect((await provisionSuperAdmin({ email: tenant.staffEmail })).action).toBe('unchanged');
  });

  it('reset changes the password, ends old sessions, and leaves other users alone', async () => {
    const tenant = await createTenant('reset');
    await provisionSuperAdmin({ email: EMAIL, password: PW });
    const old = agent();
    await old.login(EMAIL, PW);
    const othersBefore = await prisma.user.findMany({ where: { email: { not: EMAIL } }, orderBy: { id: 'asc' } });

    await provisionSuperAdmin({ email: EMAIL, password: 'Brand-New-Pw9', resetPassword: true });

    expect((await old.get('/api/auth/me')).status).toBe(401);
    expect((await agent().login(EMAIL, PW)).status).toBe(401);
    expect((await agent().login(EMAIL, 'Brand-New-Pw9')).status).toBe(200);
    const othersAfter = await prisma.user.findMany({ where: { email: { not: EMAIL } }, orderBy: { id: 'asc' } });
    expect(othersAfter).toEqual(othersBefore);
    expect(tenant.adminEmail).toBeTruthy();
  });

  it('rejects weak passwords and a missing password on create', async () => {
    await expect(provisionSuperAdmin({ email: EMAIL, password: 'short' })).rejects.toBeInstanceOf(AdminAccountError);
    await expect(provisionSuperAdmin({ email: EMAIL })).rejects.toBeInstanceOf(AdminAccountError);
    await expect(provisionSuperAdmin({ email: 'not-an-email', password: PW })).rejects.toBeInstanceOf(AdminAccountError);
    expect(await prisma.user.count()).toBe(0);
  });

  it('a restaurant admin and an agency admin cannot open the admin area', async () => {
    const tenant = await createTenant('isolation');
    for (const email of [tenant.clientAdminEmail, tenant.adminEmail]) {
      const a = agent();
      expect((await a.login(email)).status).toBe(200);
      expect((await a.get('/api/admin/users')).status).toBe(403);
    }
    expect((await request(app).get('/api/admin/users')).status).toBe(401);
  });
});

describe('environment bootstrap', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('does nothing unless both variables are set', async () => {
    expect(await bootstrapSuperAdminFromEnv({})).toBe('not configured');
    expect(await bootstrapSuperAdminFromEnv({ ADMIN_BOOTSTRAP_EMAIL: EMAIL })).toBe('not configured');
    expect(await prisma.user.count()).toBe(0);
  });

  it('creates the owner once, and never overwrites on later boots', async () => {
    const env = { ADMIN_BOOTSTRAP_EMAIL: EMAIL, ADMIN_BOOTSTRAP_PASSWORD: PW };
    expect(await bootstrapSuperAdminFromEnv(env)).toBe('Super Admin created');
    expect(await bootstrapSuperAdminFromEnv({ ...env, ADMIN_BOOTSTRAP_PASSWORD: 'Different-Pw-77' })).toMatch(/already exists/);
    expect((await agent().login(EMAIL, PW)).status).toBe(200);
  });

  it('does not promote an existing non-admin account', async () => {
    const tenant = await createTenant('nopromo');
    const outcome = await bootstrapSuperAdminFromEnv({ ADMIN_BOOTSTRAP_EMAIL: tenant.staffEmail, ADMIN_BOOTSTRAP_PASSWORD: PW });
    expect(outcome).toMatch(/skipped/);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } })).role).toBe('AGENCY_STAFF');
  });

  it('RESET mode makes the account work, sets the password once, and is a no-op on restart', async () => {
    const tenant = await createTenant('ensure');
    await provisionSuperAdmin({ email: 'root@platform.test', password: 'Existing-Root-Pw1' });
    const env = { ADMIN_BOOTSTRAP_EMAIL: tenant.staffEmail, ADMIN_BOOTSTRAP_PASSWORD: 'Chosen-Owner-Pw9', ADMIN_BOOTSTRAP_RESET: 'true' };

    const first = await bootstrapSuperAdminFromEnv(env);
    expect(first).toMatch(/password_reset/);
    expect((await agent().login(tenant.staffEmail, 'Chosen-Owner-Pw9')).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } })).role).toBe('SUPER_ADMIN');

    const live = agent();
    await live.login(tenant.staffEmail, 'Chosen-Owner-Pw9');
    expect(await bootstrapSuperAdminFromEnv(env)).toBe('Super Admin already in place');
    expect((await live.get('/api/auth/me')).status).toBe(200);
    // Other accounts, including the other Super Admin, are untouched.
    expect((await agent().login('root@platform.test', 'Existing-Root-Pw1')).status).toBe(200);
  });

  it('RESET mode creates the account when it does not exist, even if another Super Admin does', async () => {
    await provisionSuperAdmin({ email: 'root@platform.test', password: 'Existing-Root-Pw1' });
    const outcome = await bootstrapSuperAdminFromEnv({ ADMIN_BOOTSTRAP_EMAIL: 'new@platform.test', ADMIN_BOOTSTRAP_PASSWORD: 'Brand-New-Own3r', ADMIN_BOOTSTRAP_RESET: 'true' });
    expect(outcome).toMatch(/created/);
    expect((await agent().login('new@platform.test', 'Brand-New-Own3r')).status).toBe(200);
  });
});
