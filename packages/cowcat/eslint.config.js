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
    // Every child process and every file operation goes through ProcessPort /
    // FsPort / PlatformPort, so only the adapters may reach the host directly
    // (P2, ADR-014/017).
    //
    // `ignores` EXCLUDES the three layers the block above already owns, and that is
    // load-bearing rather than tidiness: two blocks configuring the same rule do not
    // merge, the later one wins outright — so a `files: ['src/**/*.ts']` block here
    // would silently drop the zod pattern (ADR-009) and reword the kernel message.
    // Verified with tools/lint-probe.mjs, which caught exactly that.
    //
    // `test/**` is deliberately outside every rule here: the suite legitimately uses
    // the real filesystem and spawns real processes to test the adapters themselves.
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/**', 'src/kernel/**', 'src/policy/**', 'src/ports/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:child_process', 'child_process', 'node:fs', 'fs', 'fs/*', 'node:os', 'os'],
              message:
                'child processes and file operations go through ProcessPort / FsPort / PlatformPort; put host access in src/adapters (ADR-014, ADR-017)',
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
