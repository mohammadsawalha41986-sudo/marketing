#!/usr/bin/env node
/**
 * Create or update the owner account.
 *
 * This exists because the application has no public registration. That is a
 * deliberate security property, not an omission: an open registration route on
 * a private marketing system would let anyone who finds the URL mint an account
 * with full access to every restaurant. The account is therefore created out of
 * band, by someone who already has the database credentials.
 *
 * Usage:
 *   npm run owner:create -- --email you@example.com --name "Your Name"
 *
 * The password is read from the OWNER_PASSWORD environment variable, or
 * prompted for with echo off. It is never accepted as a command-line argument,
 * because argv is visible to every other process on the machine via `ps` and is
 * routinely written to shell history.
 *
 * Re-running with an existing email resets that account's password rather than
 * failing, which is the recovery path in place of a self-service reset flow.
 */

import { createInterface } from 'node:readline';
import process from 'node:process';

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

/** Read a line with terminal echo disabled, so the password is not displayed. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No terminal available. Set OWNER_PASSWORD instead.'));
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);

    // `terminal: true` echoes by default; muting the output stream is what keeps
    // the password off the screen and out of any scrollback.
    const onData = () => process.stdout.write('');
    rl.output.write = onData;

    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const email = flag('email')?.trim().toLowerCase();
  const name = flag('name')?.trim() || 'Owner';

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    process.stderr.write(
      'Usage: npm run owner:create -- --email you@example.com --name "Your Name"\n' +
        'Set OWNER_PASSWORD in the environment, or you will be prompted for it.\n',
    );
    process.exit(1);
  }

  const password = process.env.OWNER_PASSWORD ?? (await promptHidden('Password: '));

  // Imported here rather than at the top so the usage message above still
  // prints on a machine where the client has not been generated yet.
  const { PrismaClient } = await import('@prisma/client');
  const argon2 = (await import('argon2')).default;
  const { passwordProblems } = await import('../server/dist/lib/password.js').catch(() => ({
    passwordProblems: null,
  }));

  // The same strength rules the API enforces, when the build is available to
  // borrow them from. A fresh checkout has no dist yet, so fall back to the
  // minimum that matters most.
  const problems = passwordProblems
    ? passwordProblems(password)
    : password.length < 12
      ? ['must be at least 12 characters']
      : [];

  if (problems.length > 0) {
    process.stderr.write(`Password ${problems.join('; ')}\n`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });

    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name, passwordHash, role: 'OWNER' },
      update: { passwordHash, name, isActive: true },
      select: { id: true, email: true, name: true },
    });

    // A password change must not leave older sessions alive.
    if (existing) await prisma.session.deleteMany({ where: { userId: user.id } });

    // The workspace is created on first read by the API, but doing it here means
    // a freshly provisioned database is complete before anyone signs in.
    await prisma.workspace.upsert({ where: { id: 'workspace' }, create: { id: 'workspace' }, update: {} });

    process.stdout.write(
      `${existing ? 'Updated' : 'Created'} owner account ${user.email} (${user.name}).\n` +
        (existing ? 'Existing sessions were signed out.\n' : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
