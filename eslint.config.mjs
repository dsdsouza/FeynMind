import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/', 'dist/', 'release/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      // The renderer must never reach Node, the database or provider SDKs.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'electron', 'better-sqlite3', 'ai', '@ai-sdk/*'], message: 'The renderer talks to the main process only through window.feynmind.' },
            { group: ['**/main/**'], message: 'Import shared types from src/shared instead.' }
          ]
        }
      ]
    }
  },
  {
    // Only the providers module may import a provider SDK.
    files: ['src/**/*.ts'],
    ignores: ['src/main/providers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['ai', '@ai-sdk/*'], message: 'All model calls go through src/main/providers.' }] }
      ]
    }
  }
)
