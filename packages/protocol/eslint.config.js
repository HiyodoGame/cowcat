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
    // This package is the seam: the TUI, the CLI and (one day) an IDE plugin all speak
    // it, so it must not know any of them (ADR-062). A renderer import would drag Node 26
    // and a native binary into a package that has to run headless; a kernel import would
    // close the loop the protocol exists to keep open (ADR-055, ADR-059 ③).
    //
    // `node:*` is allowed: a stdio transport and a process lifecycle are host-shaped by
    // definition, and this package is the only one that may say so.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opentui/*', '@opentui'],
              message: 'the protocol has no renderer; keep opentui in packages/tui (ADR-062)',
            },
            {
              group: ['@corescense/cowcat-core', '*/cowcat/src/*', '**/packages/cowcat/**'],
              message:
                'the protocol reaches the kernel only through its host port; importing the kernel would close the loop it exists to keep open (ADR-059 ③)',
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
