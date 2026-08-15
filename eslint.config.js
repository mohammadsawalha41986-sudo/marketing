// ESLint flat config.
//
// `npm run lint` was in package.json with no config file to back it, so it had
// never actually run. This is the missing half.
//
// Deliberately not type-aware: the type-checked rule set needs a full program
// per file and would duplicate what `npm run typecheck` already does on every
// build. This catches what tsc does not — unused values, unreachable code,
// accidental globals — and stays fast enough to run on every commit.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'web/dist/**',
      'server/dist/**',
      'tools/**',
      'storage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // The codebase marks intentionally-unused bindings with a leading
      // underscore — destructuring a field out of an object to drop it is the
      // common case, and that is what `ignoreRestSiblings` covers.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `any` is reported rather than forbidden: a handful of boundaries with
      // untyped third-party shapes legitimately need it, and failing the build
      // on those would push people towards worse escapes.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // Node scripts run before the build and are plain ESM, not TypeScript.
    // They write to stdout on purpose — that output is the whole point.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
  {
    // The seed prints a summary of what it created, which is the only way to
    // see whether it did what you expected.
    files: ['prisma/seed.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Hook dependency correctness is the one class of React bug tsc cannot see:
    // a stale closure typechecks perfectly and still renders the wrong data.
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
