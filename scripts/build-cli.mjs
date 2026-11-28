import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = resolve(rootDir, 'dist-cli/atrium.cjs')
const pkgBinFile = resolve(rootDir, 'packages/cli/bin/atrium.cjs')
const cliPkgFile = resolve(rootDir, 'packages/cli/package.json')

export async function buildCliBundle() {
  const pkg = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'))
  const cliPkg = JSON.parse(await readFile(cliPkgFile, 'utf8'))
  if (pkg.version !== cliPkg.version) {
    throw new Error(
      `Version mismatch: root package.json is ${pkg.version} but packages/cli/package.json is ${cliPkg.version}. Keep them aligned.`,
    )
  }
  await mkdir(dirname(outFile), { recursive: true })
  await mkdir(dirname(pkgBinFile), { recursive: true })

  const bundle = await rolldown({
    input: resolve(rootDir, 'src/cli/index.ts'),
    platform: 'node',
    transform: {
      define: {
        'process.env.ATRIUM_CLI_VERSION': JSON.stringify(pkg.version || '1.0.0'),
      },
    },
  })

  try {
    await bundle.write({
      file: outFile,
      format: 'cjs',
      codeSplitting: false,
      banner: '#!/usr/bin/env node\n',
    })
  } finally {
    await bundle.close()
  }

  await copyFile(outFile, pkgBinFile)

  if (process.platform !== 'win32') {
    await chmod(outFile, 0o755)
    await chmod(pkgBinFile, 0o755)
  }

  const info = await stat(outFile)
  console.log(`Built CLI bundle: ${outFile} (${(info.size / 1024).toFixed(1)} kB) -> synced ${pkgBinFile}`)
  return outFile
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  await buildCliBundle()
}
