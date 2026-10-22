#!/usr/bin/env node
/**
 * Create, repair or reset the platform's Super Admin.
 *
 *   ADMIN_EMAIL=owner@example.com node scripts/admin-account.mjs            # create / repair
 *   ADMIN_EMAIL=owner@example.com node scripts/admin-account.mjs --reset    # also set a new password
 *
 * The password comes from ADMIN_PASSWORD, or is typed at a hidden prompt. It is
 * never accepted as an argument (shell history) and never printed. Run it where
 * DATABASE_URL is reachable, e.g. a Railway shell on the server service after a
 * build (it uses server/dist).
 */
import { createInterface } from 'node:readline';

function promptHidden(label) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => { if (text.includes(label)) process.stdout.write(text); };
    rl.question(label, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const { provisionSuperAdmin, AdminAccountError } = await import('../server/dist/services/admin-account.js');
const { prisma } = await import('../server/dist/lib/prisma.js');

const reset = process.argv.includes('--reset');
const email = process.env.ADMIN_EMAIL;
if (!email) { console.error('ADMIN_EMAIL is required'); process.exit(2); }

try {
  const exists = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
  let password = process.env.ADMIN_PASSWORD;
  if (!password && (!exists || reset)) password = await promptHidden('New password: ');
  const result = await provisionSuperAdmin({ email, password, name: process.env.ADMIN_NAME, resetPassword: reset });
  console.log(`[admin-account] ${result.action}: ${result.email}${result.changes.length ? ` (${result.changes.join('; ')})` : ''}`);
} catch (error) {
  console.error(`[admin-account] ${error instanceof AdminAccountError ? error.message : 'failed: ' + error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
