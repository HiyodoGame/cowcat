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
  // The prohibition ADR-059 ③ states, now that the CLI has moved out (T4a 3/3): the
  // whole frontend package reaches the kernel only through the protocol — not just the
  // directory that happened to hold the bin. `packages/cli` is the one package allowed to
  // import both, and it is not the frontend (ADR-062 ③).
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@corescense/cowcat-core', '*/cowcat/src/*', '**/packages/cowcat/**'],
              message:
                'the frontend reaches the kernel only through the protocol; the composition root lives in packages/cowcat and is wired by packages/cli (ADR-059 ③, ADR-062 ③)',
            },
          ],
        },
      ],
    },
  },
  {
    // node:test registers cases by returning promises nobody awaits. Same carve-out
    // as packages/cowcat, for the same reason.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  // ADR-059's ban on importing the kernel and its adapters is in the block above, and it
  // now covers the whole package rather than the CLI directory that used to live here.
);
