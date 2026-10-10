import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'coverage', 'examples/**/*.js', 'site/dist'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true },
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      // Prettier keeps blank lines but never adds them, so `eslint --fix` does: around groups of
      // declarations, after blocks, before `return` and between the cases of a `switch` (but not
      // after an empty case that falls through).
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['return', 'const', 'let'] },
        { blankLine: 'always', prev: ['const', 'let', 'block-like'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        {
          blankLine: 'always',
          prev: { selector: 'SwitchCase[consequent.length>0]' },
          next: ['case', 'default'],
        },
      ],
      // The compiler is built around `switch (node.kind)` — missing cases should be an error,
      // unless the switch has a `default` branch on purpose.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Files stay short: split one by responsibility before it grows past 400 lines (the same
      // limit for .mango, CSS and JSON is checked by tests/repository.test.ts).
      'max-lines': ['error', { max: 400 }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
