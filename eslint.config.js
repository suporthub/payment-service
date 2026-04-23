// eslint.config.js — ESLint v9 flat config for payment-service
// @ts-check

import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  // ── Ignore patterns ────────────────────────────────────────────────────────
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/**'],
  },

  // ── TypeScript source files ────────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // ── TypeScript-specific ───────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any':      'warn',
      '@typescript-eslint/no-unused-vars':       ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      // Express router.get/post() callbacks are typed as returning void but async handlers
      // return Promise<void>. This is a well-known Express + TypeScript pattern; suppress it.
      '@typescript-eslint/no-misused-promises':  ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // ── General JS/TS best practices ─────────────────────────────────────
      'no-console':    'warn',
      // Allow `!= null` and `== null` — these intentionally check for both null AND undefined,
      // which is valid TypeScript idiom and more readable than `!== null && !== undefined`.
      'eqeqeq':        ['error', 'always', { null: 'ignore' }],
      'no-var':        'error',
      'prefer-const':  'error',
      'no-throw-literal': 'error',
    },
  },
];
