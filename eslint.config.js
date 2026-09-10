import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const sharedGlobals = {
  ...globals.browser,
  ...globals.node,
  chrome: 'readonly',
}

const reactHooksRules = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
}

const stylisticPreset = stylistic.configs.customize({
  indent: 2,
  quotes: 'single',
  semi: false,
  jsx: true,
  arrowParens: true,
  braceStyle: '1tbs',
  blockSpacing: true,
  quoteProps: 'as-needed',
  commaDangle: 'always-multiline',
  severity: 'error',
  experimental: false,
})

const stylisticConfig = {
  ...stylisticPreset,
  name: 'tab-out/stylistic',
  files: ['**/*.{cjs,js,mjs,mts,ts,tsx}'],
  rules: {
    ...stylisticPreset.rules,
    '@stylistic/jsx-one-expression-per-line': 'off',
    '@stylistic/max-statements-per-line': 'off',
    '@stylistic/multiline-ternary': 'off',
    '@stylistic/no-mixed-operators': 'off',
    '@stylistic/operator-linebreak': 'off',
    '@stylistic/quotes': ['error', 'single', { allowTemplateLiterals: 'always', avoidEscape: true }],
  },
}

export default tseslint.config(
  {
    ignores: [
      '.playwright-mcp/**',
      '.scratch/**',
      'extension/dist/**',
      'extension/vendor/**',
      'integrations/hammerspoon/TabOut.spoon/native/build/**',
      'native/bridge-host/build/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  stylisticConfig,
  {
    files: ['**/*.{cjs,js,mjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: sharedGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{mts,ts,tsx}'],
  })),
  {
    files: ['**/*.{mts,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: sharedGlobals,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.{js,ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: reactHooksRules,
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
