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
  //
  // T10 added the second half of ADR-066 ③: **only `ui/screen.ts` may import the renderer**.
  // Two blocks, because `no-restricted-imports` does not merge — the later block *replaces*
  // the rule for the files it matches, so `screen.ts` gets its own copy with the renderer
  // allowed and the kernel still banned.
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
            {
              group: ['@opentui/*', '@opentui'],
              message:
                'only src/ui/screen.ts touches the renderer; everything else produces Line[] so it can be tested without a terminal (ADR-066 ③)',
            },
          ],
        },
      ],
    },
  },
  {
    // The one renderer-aware file. The kernel ban still applies here; the renderer does not.
    files: ['src/ui/screen.ts'],
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
