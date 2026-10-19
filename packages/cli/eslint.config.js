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
    // This package is the ONE place that sees both halves (ADR-062 ③): the bin decides
    // whether a verb needs `@corescense/cowcat-core` (the composition root), the protocol,
    // or the renderer. Everywhere else the boundary is enforced — `packages/tui` may not
    // import the kernel at all, and `packages/protocol` may import neither.
    //
    // What is still worth forbidding here is reaching PAST a package: the renderer is
    // reached through `@corescense/cowcat-tui`, never by importing `@opentui/core`
    // directly, so there stays exactly one door into it (the same shape ADR-059 ③ gives
    // the kernel).
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opentui/*'],
              message: 'the renderer is reached through @corescense/cowcat-tui, not directly (ADR-062 ③)',
            },
          ],
        },
      ],
    },
  },
  {
    // node:test registers cases by returning promises nobody awaits. Same carve-out as
    // the other packages, for the same reason.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
