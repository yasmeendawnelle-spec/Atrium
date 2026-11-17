// Bundles the offline React + JSX/TSX + Recharts + Lucide artifact runtime into a static script string.
// Runs before build/dev so sandboxed React artifacts work cleanly under connect-src 'none'.
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const input = resolve(root, 'src/renderer/src/lib/artifactRuntimeEntry.ts')
const outFile = resolve(root, 'src/renderer/src/generated/artifact-runtime.bundle.txt')

mkdirSync(dirname(outFile), { recursive: true })

const bundle = await rolldown({
  input,
  transform: {
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  },
  onwarn(warning, defaultHandler) {
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
    defaultHandler(warning)
  },
})

try {
  await bundle.write({
    file: outFile,
    format: 'iife',
    minify: true,
    codeSplitting: false,
  })
} finally {
  await bundle.close()
}

console.log(`Built offline React artifact runtime -> ${outFile}`)
