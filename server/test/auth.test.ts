/** Registration, login, sessions, CSRF and password reset. */

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { agent, app, createTenant, PASSWORD, prisma, resetDatabase } from './helpers.js';

describe('authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('registers a new agency and starts a session', async () => {
    const response = await request(app).post('/api/auth/register').send({
      name: 'New Owner',
      email: 'owner@newagency.test',
      password: 'Passw0rd!new',
      organizationName: 'New Agency',
    });

    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('AGENCY_ADMIN');
    expect(response.body.user).not.toHaveProperty('passwordHash');

    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((cookie) => cookie.startsWith('mos_session='))).toBe(true);
    // The session cookie must not be readable by scripts.
    expect(cookies.find((cookie) => cookie.startsWith('mos_session='))).toMatch(/HttpOnly/i);
  });

  it('never stores the password in plain text', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Hash Check', email: 'hash@check.test', password: 'Passw0rd!hash',
    });
    const user = await prisma.user.findUnique({ where: { email: 'hash@check.test' } });
    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordHash).not.toContain('Passw0rd!hash');
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a weak password with field-level detail', async () => {
    const response = await request(app).post('/api/auth/register').send({
      name: 'Weak', email: 'weak@test.test', password: 'short',
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error.details)).toMatch(/at least 10 characters/i);
  });

  it('refuses a duplicate email', async () => {
    await request(app).post('/api/auth/register').send({ name: 'First Owner', email: 'dupe@test.test', password: 'Passw0rd!aaa' });
    const second = await request(app).post('/api/auth/register').send({ name: 'Second Owner', email: 'dupe@test.test', password: 'Passw0rd!bbb' });
    expect(second.status).toBe(409);
  });

  it('signs in with correct credentials and rejects wrong ones identically', async () => {
    const tenant = await createTenant('authco');

    const good = await agent().login(tenant.adminEmail);
    expect(good.status).toBe(200);

    const bad = await request(app).post('/api/auth/login').send({ email: tenant.adminEmail, password: 'wrong-password' });
    expect(bad.status).toBe(401);

    const missing = await request(app).post('/api/auth/login').send({ email: 'nobody@nowhere.test', password: 'wrong-password' });
    expect(missing.status).toBe(401);
    // Same message either way, so the endpoint cannot enumerate accounts.
    expect(missing.body.error.message).toBe(bad.body.error.message);
  });

  it('blocks unauthenticated access to protected routes', async () => {
    const response = await request(app).get('/api/clients');
    expect(response.status).toBe(401);
  });

  it('returns the current user with organization and client context', async () => {
    const tenant = await createTenant('meco');
    const client = agent();
    await client.login(tenant.clientAdminEmail);

    const response = await client.get('/api/auth/me');
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('CLIENT_ADMIN');
    expect(response.body.user.client.id).toBe(tenant.clientId);
    expect(response.body.user.client.brand).toBeTruthy();
  });

  it('ends the session on logout', async () => {
    const tenant = await createTenant('logoutco');
    const client = agent();
    await client.login(tenant.adminEmail);

    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects an authenticated mutation without a CSRF header', async () => {
    const tenant = await createTenant('csrfco');
    const client = agent();
    await client.login(tenant.adminEmail);

    const blocked = await client.postWithoutCsrf('/api/clients', { name: 'Csrf Client', businessName: 'Csrf Client Ltd' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/csrf/i);

    // The same call with the header succeeds, proving CSRF was the only blocker.
    const allowed = await client.post('/api/clients', { name: 'Csrf Client', businessName: 'Csrf Client Ltd' });
    expect(allowed.status).toBe(201);
  });

  it('changes a password and invalidates existing sessions', async () => {
    const tenant = await createTenant('pwco');
    const client = agent();
    await client.login(tenant.adminEmail);

    const response = await client.post('/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'Passw0rd!changed',
    });
    expect(response.status).toBe(200);

    // The old session is gone.
    expect((await client.get('/api/auth/me')).status).toBe(401);
    // And the new password works.
    expect((await agent().login(tenant.adminEmail, 'Passw0rd!changed')).status).toBe(200);
  });

  it('issues a reset token and lets it be redeemed exactly once', async () => {
    const tenant = await createTenant('resetco');

    const requested = await request(app).post('/api/auth/forgot-password').send({ email: tenant.adminEmail });
    expect(requested.status).toBe(200);
    const token = requested.body.devToken as string;
    expect(token).toBeTruthy();

    const first = await request(app).post('/api/auth/reset-password').send({ token, password: 'Passw0rd!reset' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/auth/reset-password').send({ token, password: 'Passw0rd!again' });
    expect(second.status).toBe(400);

    expect((await agent().login(tenant.adminEmail, 'Passw0rd!reset')).status).toBe(200);
  });

  it('does not reveal whether an unknown email is registered', async () => {
    const response = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@nowhere.test' });
    expect(response.status).toBe(200);
    expect(response.body.devToken).toBeUndefined();
    expect(response.body.message).toMatch(/if that email is registered/i);
  });

  it('signs out a user as soon as they are deactivated', async () => {
    const tenant = await createTenant('deactco');
    const client = agent();
    await client.login(tenant.adminEmail);
    expect((await client.get('/api/auth/me')).status).toBe(200);

    await prisma.user.update({ where: { id: tenant.adminId }, data: { isActive: false } });
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });
});
