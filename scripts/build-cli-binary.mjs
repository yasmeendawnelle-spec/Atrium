import { execFileSync } from 'node:child_process'
import { access, chmod, copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCliBundle } from './build-cli.mjs'

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distCliDir = resolve(rootDir, 'dist-cli')
const require = createRequire(import.meta.url)

function parseOutFlag(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      return resolve(rootDir, argv[i + 1])
    }
    if (argv[i].startsWith('--out=')) {
      return resolve(rootDir, argv[i].slice(6))
    }
  }
  const ext = process.platform === 'win32' ? '.exe' : ''
  return resolve(distCliDir, `atrium-${process.platform}-${process.arch}${ext}`)
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function quoteWinCmdArg(arg) {
  if (!arg || /[\s"&|<>^()]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`
  }
  return arg
}

function runPostject(postjectArgs) {
  try {
    const cliEntry = require.resolve('postject/dist/cli.js')
    execFileSync(process.execPath, [cliEntry, ...postjectArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    })
    return
  } catch {
    // Fall back to npx if postject is not installed directly in node_modules.
  }

  if (process.platform === 'win32') {
    const line = ['npx.cmd', '--yes', 'postject', ...postjectArgs].map(quoteWinCmdArg).join(' ')
    execFileSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd: rootDir,
      stdio: 'inherit',
      windowsVerbatimArguments: true,
    })
    return
  }

  execFileSync('npx', ['--yes', 'postject', ...postjectArgs], {
    cwd: rootDir,
    stdio: 'inherit',
  })
}

export async function buildCliBinary({ outPath, noBuild = false } = {}) {
  const bundlePath = resolve(distCliDir, 'atrium.cjs')
  if (!noBuild || !(await exists(bundlePath))) {
    await buildCliBundle()
  }

  const ext = process.platform === 'win32' ? '.exe' : ''
  const targetBin = outPath
    ? resolve(rootDir, outPath)
    : resolve(distCliDir, `atrium-${process.platform}-${process.arch}${ext}`)
  await mkdir(dirname(targetBin), { recursive: true })

  const seaBlobPath = resolve(distCliDir, 'sea-prep.blob')
  const seaConfigPath = resolve(distCliDir, 'sea-config.json')
  await writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        // V8 code cache: the binary skips compiling the 7 MB bundle on every launch (~100 ms on Windows).
        // The cache is built by this same Node on the target OS; each CI job builds natively, and a
        // mismatched cache is just ignored by V8, never an error.
        useCodeCache: true,
      },
      null,
      2,
    ),
  )

  console.log('Generating Node SEA blob...')
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    cwd: rootDir,
    stdio: 'inherit',
  })

  await copyFile(process.execPath, targetBin)
  if (process.platform !== 'win32') {
    await chmod(targetBin, 0o755)
  }

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', targetBin], { stdio: 'inherit' })
  }

  console.log(`Injecting SEA payload into ${targetBin}...`)
  const postjectArgs = [
    targetBin,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    SEA_FUSE,
    '--overwrite',
  ]
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA')
  }

  runPostject(postjectArgs)

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', targetBin], { stdio: 'inherit' })
  }
  if (process.platform !== 'win32') {
    await chmod(targetBin, 0o755)
  }

  const info = await stat(targetBin)
  console.log(`Built native CLI binary: ${targetBin} (${(info.size / (1024 * 1024)).toFixed(1)} MB)`)

  execFileSync(targetBin, ['--version'], { cwd: rootDir, stdio: 'inherit' })
  return targetBin
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  const argv = process.argv.slice(2)
  await buildCliBinary({
    outPath: parseOutFlag(argv),
    noBuild: argv.includes('--no-build'),
  })
}
