import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Strict CSP for the packaged app only. The dev server needs an inline
// React Refresh preamble, which a strict policy would block.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data: atrium-artifact:",
].join('; ')

const productionCsp: Plugin = {
  name: 'atrium-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
}

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        // `index` is the Electron main process. `core` runs in a separate utility
        // process so the agent loop and MCP pipes never block the window.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, 'src/core/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    plugins: [react(), productionCsp],
  },
})
