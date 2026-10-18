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
    // The protocol module is the part of the frontend a headless consumer would need
    // (ADR-055 keeps protocol and transport separate), so it must not need the
    // renderer — and it must not reach into the kernel, which the frontend only ever
    // sees through this protocol (ADR-059 ③). `src/serve` is held to the same rule for
    // the same reasons: it is the process a terminal-less client connects to, and it is
    // where the composition root will eventually hand the kernel over as a port rather
    // than as an import. Both are enforced here rather than left to review, because
    // "move it into its own package later" is only a mechanical move while these stay
    // true. `tools/lint-probe.mjs` verifies the rules fire.
    files: ['src/protocol/**/*.ts', 'src/serve/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opentui/*', '@opentui'],
              message:
                'the protocol must not need a renderer; keep opentui out of src/protocol (ADR-055, ADR-056)',
            },
            {
              group: ['*/cowcat/src/*', '**/packages/cowcat/**'],
              message:
                'the frontend reaches the kernel only through this protocol; do not import kernel paths (ADR-059)',
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
  // ADR-059's ban on importing the kernel and its adapters is NOT here yet: at T1
  // this package has no protocol client and therefore nothing that could import
  // them. It lands with the layer that could (T7), together with the lint probe
  // that proves the rule actually fires.
);
