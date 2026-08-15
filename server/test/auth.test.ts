/** Login, sessions, CSRF, and the absence of every public account route. */

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { agent, app, createOwner, PASSWORD, prisma, resetDatabase } from './helpers.js';

describe('authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  /*
   * The most important thing this suite checks is what is NOT reachable.
   * Registration and password reset were removed on purpose: on a private
   * system with one account, an open registration route hands full access to
   * every restaurant to anyone who finds the URL. A test that only covered the
   * happy path would not notice them coming back.
   */
  it('exposes no route that can create or recover an account', async () => {
    const owner = await createOwner();

    const routes = [
      ['post', '/api/auth/register', { name: 'Intruder', email: 'intruder@test.test', password: 'Passw0rd!new' }],
      ['post', '/api/auth/forgot-password', { email: owner.email }],
      ['post', '/api/auth/reset-password', { token: 'x'.repeat(40), password: 'Passw0rd!new' }],
    ] as const;

    for (const [method, path, body] of routes) {
      const response = await request(app)[method](path).send(body);
      expect(response.status, `${path} should not exist`).toBe(404);
    }

    // And nothing was created as a side effect.
    expect(await prisma.user.count()).toBe(1);
  });

  it('has no user-management or admin surface', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);

    for (const path of ['/api/users', '/api/admin/dashboard', '/api/subscriptions/plans', '/api/approvals']) {
      expect((await client.get(path)).status, `${path} should not exist`).toBe(404);
    }
  });

  it('never stores the password in plain text', async () => {
    await createOwner('hash@check.test');
    const user = await prisma.user.findUnique({ where: { email: 'hash@check.test' } });
    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordHash).not.toContain(PASSWORD);
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('signs in with correct credentials and rejects wrong ones identically', async () => {
    const owner = await createOwner();

    const good = await agent().login(owner.email);
    expect(good.status).toBe(200);

    const cookies = good.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((cookie) => cookie.startsWith('mos_session='))).toBe(true);
    // The session cookie must not be readable by scripts.
    expect(cookies.find((cookie) => cookie.startsWith('mos_session='))).toMatch(/HttpOnly/i);

    const bad = await request(app).post('/api/auth/login').send({ email: owner.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);

    const missing = await request(app).post('/api/auth/login').send({ email: 'nobody@nowhere.test', password: 'wrong-password' });
    expect(missing.status).toBe(401);
    // Same message either way, so the endpoint cannot enumerate accounts.
    expect(missing.body.error.message).toBe(bad.body.error.message);
  });

  it('blocks unauthenticated access to every data route', async () => {
    for (const path of ['/api/restaurants', '/api/campaigns', '/api/content', '/api/ads', '/api/tasks', '/api/settings']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
  });

  it('returns the current user and the workspace', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);

    const response = await client.get('/api/auth/me');
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe('OWNER');
    expect(response.body.user).not.toHaveProperty('passwordHash');
    // The workspace is created on first read, so a fresh database still works.
    expect(response.body.workspace.currency).toBe('SAR');
  });

  it('ends the session on logout', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);

    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects an authenticated mutation without a CSRF header', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);

    const body = { name: 'Csrf Restaurant', businessName: 'Csrf Restaurant Ltd' };
    const blocked = await client.postWithoutCsrf('/api/restaurants', body);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/csrf/i);

    // The same call with the header succeeds, proving CSRF was the only blocker.
    expect((await client.post('/api/restaurants', body)).status).toBe(201);
  });

  it('changes a password and invalidates existing sessions', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);

    const response = await client.post('/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'Passw0rd!changed',
    });
    expect(response.status).toBe(200);

    // The old session is gone.
    expect((await client.get('/api/auth/me')).status).toBe(401);
    // And the new password works.
    expect((await agent().login(owner.email, 'Passw0rd!changed')).status).toBe(200);
  });

  it('rejects a weak password on change, with field-level detail', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);

    const response = await client.post('/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.error.details)).toMatch(/at least 10 characters/i);
  });

  it('signs out a user as soon as they are deactivated', async () => {
    const owner = await createOwner();
    const client = agent();
    await client.login(owner.email);
    expect((await client.get('/api/auth/me')).status).toBe(200);

    await prisma.user.update({ where: { id: owner.id }, data: { isActive: false } });
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });
});
