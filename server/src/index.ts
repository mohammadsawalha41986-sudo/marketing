/** Process entry point. */

import { mkdirSync } from 'node:fs';

import { createApp } from './app.js';
import { env, hasOpenAi, uploadDir } from './env.js';
import { prisma } from './lib/prisma.js';
import { pruneExpiredSessions } from './lib/session.js';

mkdirSync(uploadDir, { recursive: true });

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.info(`[marketing-os] listening on port ${env.PORT} (${env.NODE_ENV})`);
  console.info(`[marketing-os] uploads → ${uploadDir}`);
  console.info(`[marketing-os] AI provider → ${hasOpenAi ? `openai:${env.OPENAI_MODEL}` : 'built-in template engine (no OPENAI_API_KEY set)'}`);
});

// Expired sessions are pruned hourly; `resolveSession` also drops them on read.
const pruneTimer = setInterval(() => {
  void pruneExpiredSessions().catch((error) => console.error('[session] prune failed:', error.message));
}, 60 * 60 * 1000);
pruneTimer.unref();

async function shutdown(signal: string): Promise<void> {
  console.info(`[marketing-os] ${signal} received, shutting down`);
  clearInterval(pruneTimer);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
