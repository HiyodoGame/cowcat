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
