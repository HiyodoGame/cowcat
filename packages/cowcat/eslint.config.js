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
