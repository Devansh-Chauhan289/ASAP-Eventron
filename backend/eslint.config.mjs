// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

/**
 * Architectural boundary enforcement (Section 17.9):
 *  - `domain` imports no framework (no @nestjs/*, no @prisma/client).
 *  - `interface` (controllers/dto) must NOT import Prisma (Rule 7).
 *  - No deep cross-context imports between modules/<a> and modules/<b>
 *    (only the public facade barrel is allowed). Enforced in CI.
 */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint, import: importPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/**/domain',
              from: ['./node_modules/@nestjs', './node_modules/@prisma'],
              message:
                'domain layer must be framework-free (no @nestjs/* or @prisma/client). Move framework code to infrastructure.',
            },
            {
              target: './src/**/interface',
              from: ['./src/shared/prisma'],
              message:
                'interface layer (controllers/DTOs) must not import Prisma (Foundational Rule 7). Use a use-case.',
            },
          ],
        },
      ],
    },
  },
  prettier,
  { ignores: ['dist', 'node_modules', 'coverage', 'prisma/migrations'] },
];
