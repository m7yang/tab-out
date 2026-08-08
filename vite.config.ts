import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

import { CHROME_BUILD_TARGET } from './src/extension/chrome-support.js'

const repoRoot = import.meta.dirname
const buildEntry = process.env.TAB_OUT_BUILD_ENTRY
const tldtsMinifiedEsm = resolve(repoRoot, 'node_modules/tldts/dist/index.esm.min.js')
if (!existsSync(tldtsMinifiedEsm)) {
  throw new Error('The installed tldts package no longer ships dist/index.esm.min.js')
}
const buildInputs: Record<string, string> =
  buildEntry === 'app'
    ? {
        app: resolve(repoRoot, 'src/app.tsx'),
        'filter-focus-boot': resolve(repoRoot, 'src/extension/filter-focus-boot.ts')
      }
    : buildEntry === 'background'
      ? { background: resolve(repoRoot, 'src/extension/background.ts') }
      : {
          app: resolve(repoRoot, 'src/app.tsx'),
          background: resolve(repoRoot, 'src/extension/background.ts')
        }

export default defineConfig({
  plugins: [tailwindcss(), react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(repoRoot, 'src') },
      // Keep source and TypeScript on the public `tldts` API while directing
      // both production entries to its complete, pre-minified PSL bundle.
      // The existence guard above makes an upstream packaging change fail
      // loudly instead of silently restoring ~134 kB to each entry.
      { find: /^tldts$/, replacement: tldtsMinifiedEsm }
    ]
  },
  build: {
    target: CHROME_BUILD_TARGET,
    outDir: 'extension/dist',
    emptyOutDir: buildEntry !== 'background',
    modulePreload: false,
    rolldownOptions: {
      input: buildInputs,
      output: {
        entryFileNames: '[name].js',
        ...(buildEntry === 'background' ? { codeSplitting: false } : {}),
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
