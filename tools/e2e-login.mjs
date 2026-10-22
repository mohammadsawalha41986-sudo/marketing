/**
 * Browser check of the sign-in path and the Super Admin console.
 *
 *   npm i --no-save playwright-core
 *   E2E_BASE_URL=https://your-host E2E_EMAIL=owner@example.com E2E_PASSWORD=... \
 *     CHROMIUM_PATH=/path/to/chrome node tools/e2e-login.mjs
 *
 * Credentials come from the environment only. Against production it is
 * non-destructive: one wrong-password attempt (recorded in the audit log), a
 * sign-in, two read-only admin pages, and a sign-out. Runs at desktop and mobile widths.
 */
/* global document, window */
import { chromium } from 'playwright-core';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('E2E_EMAIL and E2E_PASSWORD are required'); process.exit(2); }
const results = [];
const check = (name, ok, extra='') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await page.goto(`${BASE}/login`);
  check(`${label}: login form is empty (no prefilled demo creds)`, (await page.inputValue('input[type=email]')) === '' && (await page.inputValue('input[type=password]')) === '');
  check(`${label}: no demo account text`, !(await page.content()).includes('example.com') );
  await page.fill('input[type=email]', EMAIL); await page.fill('input[type=password]', 'Wrong-Passw0rd');
  await page.click('button[type=submit]'); await page.waitForSelector('text=incorrect');
  check(`${label}: wrong password rejected`, page.url().includes('/login'));
  await page.fill('input[type=password]', PASSWORD); await page.click('button[type=submit]');
  await page.waitForURL(/\/admin\/dashboard/, { timeout: 15000 });
  check(`${label}: signs in`, true, page.url());
  await page.goto(`${BASE}/admin/users`); await page.waitForSelector(`text=${EMAIL}`);
  check(`${label}: admin users page`, await page.isVisible(`text=${EMAIL}`));
  await page.goto(`${BASE}/admin/security`); await page.waitForSelector('text=Active sessions');
  check(`${label}: admin security page`, await page.isVisible('text=Failed sign-ins'));
  await page.screenshot({ path: `e2e-security-${label}.png` });
  await page.reload(); await page.waitForSelector('text=Active sessions');
  check(`${label}: session survives reload`, page.url().includes('/admin/security'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`${label}: no horizontal page overflow`, !overflow);
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': decodeURIComponent(document.cookie.split('; ').find(c=>c.startsWith('mos_csrf='))?.split('=')[1] ?? '') } }));
  await page.goto(`${BASE}/admin/users`); await page.waitForURL(/\/login/);
  check(`${label}: logout sends admin routes to login`, true);
  await page.goto(`${BASE}/reset-password`);
  check(`${label}: reset page without token explains`, await page.isVisible('text=incomplete'));
  check(`${label}: no console/page errors`, errors.filter(e=>!/401/.test(e)).length === 0, errors.join('|').slice(0,200));
  await ctx.close();
}
await browser.close();
process.exit(results.every(r => r[1]) ? 0 : 1);
