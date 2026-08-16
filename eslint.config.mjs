// ESLint flat configuration.
//
// `npm run lint` is part of `npm run verify`, so it has to be runnable on a
// clean clone. ESLint 9 looks for this file by name and errors out entirely
// when it is absent — the lint step was failing on configuration, not on code.
//
// Scope is deliberately narrow: the type-checked rule sets require a program
// per workspace and would slow the check to the point of being skipped. What
// is here catches the mistakes a compiler does not — unused code, unreachable
// branches, accidental globals — and leaves type correctness to `tsc`, which
// already runs over both workspaces in `npm run typecheck`.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, dependencies and generated engines are never linted.
    ignores: ['**/node_modules/**', 'web/dist/**', 'server/dist/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything outside the browser bundle runs on Node: the server, the
    // Prisma seed, the build scripts and the CLI all reach for `process`.
    files: ['**/*.{ts,mjs,js}'],
    ignores: ['web/src/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    // The SPA carries `eslint-disable react-hooks/*` comments where a
    // dependency list is deliberately partial. Without the plugin loaded those
    // comments reference a rule that does not exist, which is itself an error.
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // The compiler reports unused locals already; this adds the argument
      // case, with the conventional leading-underscore escape hatch for
      // parameters a signature forces us to accept (Express error handlers
      // must take four).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
