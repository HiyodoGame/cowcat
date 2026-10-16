import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The kernel must not know which runtime hosts it. Node-specific code lives
    // in src/adapters and reaches the kernel only through the ports.
    files: ['src/kernel/**/*.ts', 'src/policy/**/*.ts', 'src/ports/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/*', 'path', 'child_process', 'os', 'crypto'],
              message: 'kernel, policy and ports stay runtime-agnostic; put Node code in src/adapters',
            },
            {
              // A separate pattern on purpose: folding zod into the group above
              // would report it with the Node message, which points at the wrong
              // reason. Decoding is a boundary concern and belongs in src/adapters
              // (ADR-009).
              group: ['zod', 'zod/*'],
              message:
                'schemas belong to the decoding boundary; keep zod in src/adapters and let the kernel work on typed events (ADR-009)',
            },
          ],
        },
      ],
    },
  },
  {
    // node:test registers cases by returning promises nobody awaits, and the
    // fakes implement async interfaces synchronously. Both are the idiom here.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
