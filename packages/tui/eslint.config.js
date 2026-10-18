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
  // The protocol's layering rules (no renderer, no kernel) moved with it into
  // `packages/protocol/eslint.config.js` (ADR-062) — that package is the seam now, and
  // the rule that used to protect a directory protects a package instead. What stays here
  // is the inverse: the frontend must not reach into the kernel, which is still the whole
  // point of speaking a protocol (ADR-059 ③).
  {
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@corescense/cowcat-core', '*/cowcat/src/*', '**/packages/cowcat/**'],
              message:
                'the frontend reaches the kernel only through the protocol; the composition root is T4a and it will inject the host (ADR-059 ③, ADR-062)',
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
