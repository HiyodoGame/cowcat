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
  // ADR-171 moves all renderer-aware primitives under `ui/`; feature components still produce
  // pure SceneNode data. Only that adapter directory and `run.ts` may import OpenTUI.
  // The kernel ban applies independently in both blocks because no-restricted-imports replaces
  // rather than merges when a later files block matches.
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
                'only src/ui/** (renderable adapters) and src/run.ts (renderer lifecycle) touch OpenTUI; feature components produce pure SceneNode data (ADR-171)',
            },
          ],
        },
      ],
    },
  },
  {
    // Renderer-aware adapters and lifecycle. The kernel ban still applies here.
    files: ['src/ui/**/*.ts', 'src/run.ts'],
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
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  // ADR-059's ban on importing the kernel and its adapters is in the block above, and it
  // now covers the whole package rather than the CLI directory that used to live here.
);
