import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCliBinary } from './build-cli-binary.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  let uninstall = false
  let installDir = ''
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--uninstall') uninstall = true
    else if (argv[i] === '--dir' && argv[i + 1]) installDir = argv[++i]
    else if (argv[i].startsWith('--dir=')) installDir = argv[i].slice(6)
  }
  return { uninstall, installDir }
}

const { uninstall, installDir } = parseArgs(process.argv.slice(2))

if (process.platform === 'win32') {
  const psScript = resolve(rootDir, 'scripts/install.ps1')
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript]
  if (installDir) psArgs.push('-InstallDir', installDir)
  if (uninstall) {
    psArgs.push('-Uninstall')
  } else {
    const builtBin = await buildCliBinary()
    psArgs.push('-LocalBinary', builtBin)
  }
  execFileSync('powershell.exe', psArgs, { cwd: rootDir, stdio: 'inherit' })
} else {
  const shScript = resolve(rootDir, 'scripts/install.sh')
  const shArgs = [shScript]
  if (installDir) shArgs.push('--dir', installDir)
  if (uninstall) {
    shArgs.push('--uninstall')
  } else {
    const builtBin = await buildCliBinary()
    shArgs.push('--local', builtBin)
  }
  execFileSync('sh', shArgs, { cwd: rootDir, stdio: 'inherit' })
}
