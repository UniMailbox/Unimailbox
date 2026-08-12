// ESLint flat config — see .claude/rules/coding.md
// CAP-001 enables the boundary rules named in .claude/rules/architecture.md
// §Dependency direction. The full per-pair module dependency table is
// deferred to CAP-003 (`pnpm scaffold doctor`); for now we enforce the
// three hard edges that catch the large majority of §Forbidden violations.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/.tsbuildinfo',
      '**/worker-configuration.d.ts',
      '.tmp/**',
      'work/archive/**',
      'work/handoffs/**',
      'work/investigations/**',
      'work/reviews/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Cloudflare Workers
        caches: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        TransformStream: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        console: 'readonly',
        // Browser / DOM
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        location: 'readonly',
        history: 'readonly',
        CustomEvent: 'readonly',
        // Node test
        process: 'readonly',
      },
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: { project: ['apps/worker/tsconfig.json', 'apps/web/tsconfig.json'] },
        node: true,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',

      // Boundary enforcement — see .claude/rules/architecture.md §Dependency direction.
      // 'import/no-restricted-paths' matches only path-based imports; bare module
      // names ('hono') require 'no-restricted-imports' (see overrides below).
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            // integrations/* may not import modules/*, http/*, or entrypoints/*.
            {
              target: './apps/worker/src/integrations',
              from: [
                './apps/worker/src/modules',
                './apps/worker/src/http',
                './apps/worker/src/entrypoints',
              ],
              message:
                'integrations/* may not depend on modules/*, http/*, or entrypoints/*.',
            },
            // modules/* may not import entrypoints/* or http/*.
            {
              target: './apps/worker/src/modules',
              from: [
                './apps/worker/src/entrypoints',
                './apps/worker/src/http',
              ],
              message:
                'modules/* may not depend on entrypoints/* or http/*.',
            },
            // platform/* may not import entrypoints/* or http/* (no cycle upward).
            {
              target: './apps/worker/src/platform',
              from: [
                './apps/worker/src/entrypoints',
                './apps/worker/src/http',
              ],
              message:
                'platform/* may not depend on entrypoints/* or http/*.',
            },
          ],
        },
      ],
    },
  },
  // Bare-module restrictions — 'hono' (and future provider SDKs / drizzle) may
  // not be imported from modules/*, platform/*, or packages/*. They belong to
  // entrypoints/ and http/ only. R-INBOUND-005 + ADR-002 + .claude/rules/architecture.md §Forbidden.
  {
    files: [
      'apps/worker/src/modules/**/*.{ts,tsx}',
      'apps/worker/src/platform/**/*.{ts,tsx}',
      'packages/**/src/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'hono',
              message:
                'modules/*, platform/*, and packages/* may not import hono — it belongs to entrypoints/ and http/. See .claude/rules/architecture.md §Forbidden.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.config.{js,ts,mjs,cjs}', 'scripts/**/*.{js,ts,mjs,cjs}'],
    rules: {
      'no-console': 'off',
    },
  },
];