import { defineConfig } from 'vitest/config';

/**
 * Tests run against a real PostgreSQL database, not a mock. Tenant isolation is
 * the thing most worth testing here, and a mocked Prisma client would prove
 * nothing about whether the real queries are scoped.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // The suites share one database, so they must not run concurrently.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://mos:mos@127.0.0.1:5432/marketing_os_test?schema=public',
      SESSION_SECRET: 'test-secret-that-is-definitely-long-enough-0123456789',
      CORS_ORIGIN: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
      STORAGE_LOCAL_DIR: './storage/test-uploads',
      OPENAI_API_KEY: '',
    },
  },
});
