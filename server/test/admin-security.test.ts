/** Super Admin account-security surface: disable, sessions, reset links, login failures. */

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { agent, app, createTenant, PASSWORD, prisma, resetDatabase } from './helpers.js';
import { provisionSuperAdmin } from '../src/services/admin-account.js';

const OWNER = 'owner@platform.test';
const OWNER_PW = 'Own3r-Secret-pw';

async function ownerAgent() {
  await provisionSuperAdmin({ email: OWNER, password: OWNER_PW });
  const a = agent();
  expect((await a.login(OWNER, OWNER_PW)).status).toBe(200);
  return a;
}

describe('login failures and rate limiting', () => {
  beforeEach(async () => { await resetDatabase(); });

  it('records a failed sign-in without revealing why, and shows it to the Super Admin', async () => {
    const tenant = await createTenant('fail');
    const wrong = await request(app).post('/api/auth/login').send({ email: tenant.adminEmail, password: 'Wrong-Passw0rd' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@nowhere.test', password: 'Wrong-Passw0rd' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);

    const a = await ownerAgent();
    const report = (await a.get('/api/admin/login-failures')).body;
    expect(report.total).toBe(2);
    expect(report.byAccount.map((r: { name: string }) => r.name).sort()).toEqual([tenant.adminEmail, 'nobody@nowhere.test'].sort());
    expect(JSON.stringify(report)).not.toContain('Wrong-Passw0rd');
  });

  it('limits attempts per account, so one account cannot lock out another', async () => {
    const tenant = await createTenant('limit');
    let last = 0;
    for (let i = 0; i < 101; i += 1) {
      last = (await request(app).post('/api/auth/login').send({ email: 'victim@limit.test', password: 'Wrong-Passw0rd' })).status;
    }
    expect(last).toBe(429);
    expect((await request(app).post('/api/auth/login').send({ email: tenant.adminEmail, password: PASSWORD })).status).toBe(200);
  }, 120_000);
});

describe('super admin account controls', () => {
  beforeEach(async () => { await resetDatabase(); });

  it('disabling a user ends their sessions and blocks sign-in; enabling restores it', async () => {
    const tenant = await createTenant('disable');
    const owner = await ownerAgent();
    const victim = agent();
    await victim.login(tenant.staffEmail);
    const staff = await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } });

    expect((await owner.post(`/api/admin/users/${staff.id}/status`, { isActive: false })).status).toBe(200);
    expect((await victim.get('/api/auth/me')).status).toBe(401);
    expect((await agent().login(tenant.staffEmail)).status).toBe(401);
    expect((await owner.post(`/api/admin/users/${staff.id}/status`, { isActive: true })).status).toBe(200);
    expect((await agent().login(tenant.staffEmail)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: { in: ['admin.user_disabled', 'admin.user_enabled'] } } })).toBe(2);
  });

  it('refuses to disable yourself or the last Super Admin', async () => {
    const owner = await ownerAgent();
    const me = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    expect((await owner.post(`/api/admin/users/${me.id}/status`, { isActive: false })).status).toBe(400);

    await provisionSuperAdmin({ email: 'second@platform.test', password: 'Sec0nd-Owner-pw' });
    const second = await prisma.user.findUniqueOrThrow({ where: { email: 'second@platform.test' } });
    expect((await owner.post(`/api/admin/users/${second.id}/status`, { isActive: false })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).isActive).toBe(true);
  });

  it('issues a one-time reset link that works exactly once and never stores the token', async () => {
    const tenant = await createTenant('reset-link');
    const owner = await ownerAgent();
    const staff = await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } });

    const issued = await owner.post(`/api/admin/users/${staff.id}/password-reset`);
    expect(issued.status).toBe(201);
    const token = new URL(issued.body.path, 'http://x').searchParams.get('token')!;
    expect(JSON.stringify(await prisma.passwordResetToken.findMany())).not.toContain(token);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(token);

    const old = agent();
    await old.login(tenant.staffEmail);
    const redeem = (password: string) => request(app).post('/api/auth/reset-password').send({ token, password });
    expect((await redeem('Fresh-Passw0rd-1')).status).toBe(200);
    expect((await redeem('Fresh-Passw0rd-2')).status).toBe(400);
    expect((await old.get('/api/auth/me')).status).toBe(401);
    expect((await agent().login(tenant.staffEmail, 'Fresh-Passw0rd-1')).status).toBe(200);
  });

  it('lists active sessions and revokes one', async () => {
    const tenant = await createTenant('sessions');
    const owner = await ownerAgent();
    const other = agent();
    await other.login(tenant.staffEmail);

    const list = await owner.get('/api/admin/sessions');
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    const mine = list.body.items.find((s: { user: { email: string } }) => s.user.email === tenant.staffEmail);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash/);
    expect((await owner.delete(`/api/admin/sessions/${mine.id}`)).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });

  it('keeps every control Super Admin only', async () => {
    const tenant = await createTenant('guard');
    const staff = await prisma.user.findUniqueOrThrow({ where: { email: tenant.staffEmail } });
    for (const email of [tenant.adminEmail, tenant.clientAdminEmail]) {
      const a = agent();
      await a.login(email);
      expect((await a.post(`/api/admin/users/${staff.id}/status`, { isActive: false })).status).toBe(403);
      expect((await a.post(`/api/admin/users/${staff.id}/password-reset`)).status).toBe(403);
      expect((await a.get('/api/admin/sessions')).status).toBe(403);
      expect((await a.get('/api/admin/login-failures')).status).toBe(403);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).isActive).toBe(true);
  });
});
