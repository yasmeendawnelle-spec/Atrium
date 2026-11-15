import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const WRANGLER_TOML = join(ROOT, 'deploy', 'updates-worker', 'wrangler.toml')
const WORKER_FEED_ORIGIN = 'https://updates.rpulse.top'
const CHANNEL_PREFIX = 'win'
const CHUNK_SIZE = 16 * 1024 * 1024 // 16 MiB per KV value (well under Cloudflare 25 MiB KV limit)

function parseArgs(argv) {
  const opts = {
    bump: 'patch',
    setVersion: undefined,
    notes: undefined,
    notesFile: undefined,
    outDir: 'dist-next',
    skipBuild: false,
    skipTests: false,
    keepReleases: 1,
    keepBlockmaps: 5,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--bump' && argv[i + 1]) {
      opts.bump = argv[++i]
    } else if (arg === '--set-version' && argv[i + 1]) {
      opts.setVersion = argv[++i]
    } else if (arg === '--notes' && argv[i + 1]) {
      opts.notes = argv[++i]
    } else if (arg === '--notes-file' && argv[i + 1]) {
      opts.notesFile = argv[++i]
    } else if (arg === '--out-dir' && argv[i + 1]) {
      opts.outDir = argv[++i]
    } else if (arg === '--keep' && argv[i + 1]) {
      opts.keepReleases = Math.max(1, Number.parseInt(argv[++i], 10) || 1)
    } else if (arg === '--skip-build') {
      opts.skipBuild = true
    } else if (arg === '--skip-tests') {
      opts.skipTests = true
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    }
  }
  if (opts.setVersion) opts.bump = 'none'
  if (opts.skipBuild && !opts.setVersion && argv.indexOf('--bump') === -1) {
    opts.bump = 'none'
  }
  return opts
}

function bumpSemver(version, mode) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)?$/.exec(version.trim())
  if (!m) throw new Error(`Invalid package.json version: ${version}`)
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (mode === 'major') return `${major + 1}.0.0`
  if (mode === 'minor') return `${major}.${minor + 1}.0`
  if (mode === 'patch') return `${major}.${minor}.${patch + 1}`
  if (mode === 'none') return version
  throw new Error(`Unsupported --bump mode "${mode}" (expected patch | minor | major | none)`)
}

function resolveWranglerCommand() {
  if (process.env.WRANGLER_BIN && existsSync(process.env.WRANGLER_BIN)) {
    return { cmd: process.env.WRANGLER_BIN, prefixArgs: [] }
  }
  const shared = 'D:\\cloudflare\\node_modules\\.bin\\wrangler.cmd'
  if (existsSync(shared)) {
    return { cmd: shared, prefixArgs: [] }
  }
  const local = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
  if (existsSync(local)) {
    return { cmd: local, prefixArgs: [] }
  }
  return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', prefixArgs: ['--yes', 'wrangler'] }
}

function runProcess(cmd, args, { cwd = ROOT, capture = false, quiet = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    const child = spawn(cmd, args, {
      cwd,
      shell: useShell,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : quiet ? 'ignore' : 'inherit',
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
    }
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        const msg = capture ? `${stderr}\n${stdout}`.trim() : `exit code ${code}`
        rejectPromise(new Error(`${cmd} ${args.join(' ')} failed: ${msg}`))
      }
    })
  })
}

async function runNpm(scriptArgs) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await runProcess(npmCmd, scriptArgs, { cwd: ROOT })
}

export function injectReleaseNotesIntoLatestYml(ymlText, notesText) {
  const cleanLines = ymlText.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let skippingNotes = false
  for (const line of cleanLines) {
    if (/^releaseNotes\s*:/.test(line)) {
      skippingNotes = true
      continue
    }
    if (skippingNotes) {
      if (line === '' || /^\s+/.test(line)) {
        continue
      }
      skippingNotes = false
    }
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop()
  }
  const normalizedNotes = (notesText || '').replace(/\r\n/g, '\n').trim()
  if (normalizedNotes) {
    out.push('releaseNotes: |')
    for (const nLine of normalizedNotes.split('\n')) {
      out.push(nLine ? `  ${nLine}` : '')
    }
  }
  return `${out.join('\n')}\n`
}

async function sha512Base64(filePath) {
  const buf = await readFile(filePath)
  return createHash('sha512').update(buf).digest('base64')
}

async function kvPutFile(wrangler, key, filePath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await runProcess(
        wrangler.cmd,
        [
          ...wrangler.prefixArgs,
          'kv',
          'key',
          'put',
          key,
          '--config',
          WRANGLER_TOML,
          '--binding',
          'ATRIUM_RELEASES_KV',
          '--remote',
          '--path',
          filePath,
        ],
        { cwd: ROOT, capture: true },
      )
      return
    } catch (err) {
      if (attempt >= retries) throw err
      console.warn(`[publish]   retry ${attempt}/${retries - 1} for ${key} (${err.message.split('\n')[0]})`)
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
}

async function kvListKeys(wrangler, prefix) {
  const { stdout } = await runProcess(
    wrangler.cmd,
    [
      ...wrangler.prefixArgs,
      'kv',
      'key',
      'list',
      '--config',
      WRANGLER_TOML,
      '--binding',
      'ATRIUM_RELEASES_KV',
      '--remote',
      '--prefix',
      prefix,
    ],
    { cwd: ROOT, capture: true },
  )
  return JSON.parse(stdout)
}

async function kvDeleteKey(wrangler, key) {
  await runProcess(
    wrangler.cmd,
    [
      ...wrangler.prefixArgs,
      'kv',
      'key',
      'delete',
      key,
      '--config',
      WRANGLER_TOML,
      '--binding',
      'ATRIUM_RELEASES_KV',
      '--remote',
    ],
    { cwd: ROOT, capture: true },
  )
}

function defaultNotesFor(version) {
  return [
    `Atrium v${version}`,
    '- 自动更新检测与升级提醒弹窗（支持立即更新、稍后提醒、跳过此版本）',
    '- 优化体验与稳定性修复',
  ].join('\n')
}

async function uploadReleaseToKv(wrangler, { version, outPath, notesText }) {
  const exeName = `Atrium-Setup-${version}.exe`
  const blockmapName = `${exeName}.blockmap`
  const exePath = join(outPath, exeName)
  const blockmapPath = join(outPath, blockmapName)
  const latestYmlPath = join(outPath, 'latest.yml')

  if (!existsSync(exePath)) throw new Error(`Missing installer binary: ${exePath}`)
  if (!existsSync(latestYmlPath)) throw new Error(`Missing latest.yml manifest: ${latestYmlPath}`)

  const rawLatestYml = await readFile(latestYmlPath, 'utf8')
  const updatedLatestYml = injectReleaseNotesIntoLatestYml(rawLatestYml, notesText)
  await writeFile(latestYmlPath, updatedLatestYml, 'utf8')

  const exeSize = statSync(exePath).size
  const exeSha512 = await sha512Base64(exePath)
  const chunkCount = Math.ceil(exeSize / CHUNK_SIZE)

  const scratch = await mkdtemp(join(tmpdir(), 'atrium-release-'))
  try {
    console.log(`[publish] Uploading ${exeName} (${(exeSize / 1048576).toFixed(1)} MB) in ${chunkCount} chunks...`)
    const fd = openSync(exePath, 'r')
    try {
      const buf = Buffer.allocUnsafe(CHUNK_SIZE)
      for (let i = 0; i < chunkCount; i += 1) {
        const offset = i * CHUNK_SIZE
        const bytesToRead = Math.min(CHUNK_SIZE, exeSize - offset)
        let readTotal = 0
        while (readTotal < bytesToRead) {
          const n = readSync(fd, buf, readTotal, bytesToRead - readTotal, offset + readTotal)
          if (n <= 0) break
          readTotal += n
        }
        const chunkFile = join(scratch, `chunk-${i}.bin`)
        await writeFile(chunkFile, buf.subarray(0, readTotal))
        await kvPutFile(wrangler, `chunk:${CHANNEL_PREFIX}:${exeName}:${i}`, chunkFile)
        rmSync(chunkFile, { force: true })
        console.log(`[publish]   chunk ${i + 1}/${chunkCount} uploaded`)
      }
    } finally {
      closeSync(fd)
    }

    const exeMetaFile = join(scratch, 'meta-exe.json')
    await writeFile(
      exeMetaFile,
      JSON.stringify({
        kind: 'chunked',
        contentType: 'application/octet-stream',
        size: exeSize,
        sha512: exeSha512,
        chunkSize: CHUNK_SIZE,
        chunkCount,
        version,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    )
    await kvPutFile(wrangler, `meta:${CHANNEL_PREFIX}:${exeName}`, exeMetaFile)

    if (existsSync(blockmapPath)) {
      const bmSize = statSync(blockmapPath).size
      const bmSha = await sha512Base64(blockmapPath)
      await kvPutFile(wrangler, `blob:${CHANNEL_PREFIX}:${blockmapName}`, blockmapPath)
      const bmMetaFile = join(scratch, 'meta-blockmap.json')
      await writeFile(
        bmMetaFile,
        JSON.stringify({
          kind: 'inline',
          contentType: 'application/octet-stream',
          size: bmSize,
          sha512: bmSha,
          version,
          updatedAt: new Date().toISOString(),
        }),
        'utf8',
      )
      await kvPutFile(wrangler, `meta:${CHANNEL_PREFIX}:${blockmapName}`, bmMetaFile)
      console.log(`[publish] Uploaded ${blockmapName} (${(bmSize / 1024).toFixed(1)} KB)`)
    }

    // Atomic flip: write latest.yml last after all binary chunks + metadata are present.
    const ymlBuf = Buffer.from(updatedLatestYml, 'utf8')
    const ymlFile = join(scratch, 'latest.yml')
    await writeFile(ymlFile, ymlBuf)
    await kvPutFile(wrangler, `blob:${CHANNEL_PREFIX}:latest.yml`, ymlFile)

    const ymlMetaFile = join(scratch, 'meta-latest.json')
    await writeFile(
      ymlMetaFile,
      JSON.stringify({
        kind: 'inline',
        contentType: 'text/yaml; charset=utf-8',
        size: ymlBuf.byteLength,
        sha512: createHash('sha512').update(ymlBuf).digest('base64'),
        version,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    )
    await kvPutFile(wrangler, `meta:${CHANNEL_PREFIX}:latest.yml`, ymlMetaFile)

    const indexFile = join(scratch, 'index.json')
    await writeFile(
      indexFile,
      JSON.stringify({
        latest: version,
        artifact: exeName,
        size: exeSize,
        sha512: exeSha512,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    )
    await kvPutFile(wrangler, `index:${CHANNEL_PREFIX}`, indexFile)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function verifyLiveFeed(version, expectedExePath) {
  const ymlRes = await fetch(`${WORKER_FEED_ORIGIN}/${CHANNEL_PREFIX}/latest.yml?t=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache' },
  })
  if (!ymlRes.ok) {
    throw new Error(`Live verification failed: GET latest.yml returned ${ymlRes.status}`)
  }
  const ymlText = await ymlRes.text()
  if (!ymlText.includes(`version: ${version}`)) {
    throw new Error(`Live latest.yml did not reflect version ${version}:\n${ymlText}`)
  }

  const exeUrl = `${WORKER_FEED_ORIGIN}/${CHANNEL_PREFIX}/Atrium-Setup-${version}.exe`
  const headRes = await fetch(exeUrl, { method: 'HEAD' })
  if (!headRes.ok) {
    throw new Error(`Live verification failed: HEAD ${exeUrl} returned ${headRes.status}`)
  }
  const remoteSize = Number(headRes.headers.get('content-length'))
  const localSize = statSync(expectedExePath).size
  if (remoteSize !== localSize) {
    throw new Error(`Content-Length mismatch: remote=${remoteSize} vs local=${localSize}`)
  }

  const rangeRes = await fetch(exeUrl, { headers: { Range: 'bytes=0-63' } })
  if (rangeRes.status !== 206) {
    throw new Error(`Expected 206 Partial Content for Range probe, got ${rangeRes.status}`)
  }
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer())
  if (rangeBuf.byteLength !== 64) {
    throw new Error(`Expected 64 bytes from Range probe, got ${rangeBuf.byteLength}`)
  }
  console.log(`[verify] Live feed verified at ${WORKER_FEED_ORIGIN}/${CHANNEL_PREFIX}/latest.yml (v${version}, ${localSize} bytes, Range 206 OK)`)
}

async function pruneOldReleases(wrangler, currentVersion, keepReleases, keepBlockmaps) {
  const metaEntries = await kvListKeys(wrangler, `meta:${CHANNEL_PREFIX}:Atrium-Setup-`)
  const exeVersions = []
  const blockmapVersions = []
  for (const item of metaEntries) {
    const exeMatch = /^meta:win:Atrium-Setup-(.+)\.exe$/.exec(item.name)
    if (exeMatch) exeVersions.push(exeMatch[1])
    const bmMatch = /^meta:win:Atrium-Setup-(.+)\.exe\.blockmap$/.exec(item.name)
    if (bmMatch) blockmapVersions.push(bmMatch[1])
  }

  const compareSemverDesc = (a, b) => {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
    for (let i = 0; i < 3; i += 1) {
      if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
    }
    return 0
  }

  const sortedExes = [...new Set([currentVersion, ...exeVersions])].sort(compareSemverDesc)
  const obsoleteExes = sortedExes.slice(keepReleases).filter((v) => v !== currentVersion)
  for (const oldVer of obsoleteExes) {
    const oldExe = `Atrium-Setup-${oldVer}.exe`
    const chunkKeys = await kvListKeys(wrangler, `chunk:${CHANNEL_PREFIX}:${oldExe}:`)
    for (const k of chunkKeys) {
      await kvDeleteKey(wrangler, k.name)
    }
    await kvDeleteKey(wrangler, `meta:${CHANNEL_PREFIX}:${oldExe}`)
    console.log(`[prune] Removed superseded installer chunks for v${oldVer} (${chunkKeys.length} chunks)`)
  }

  const sortedBlockmaps = [...new Set([currentVersion, ...blockmapVersions])].sort(compareSemverDesc)
  const obsoleteBms = sortedBlockmaps.slice(keepBlockmaps).filter((v) => v !== currentVersion)
  for (const oldVer of obsoleteBms) {
    const oldBm = `Atrium-Setup-${oldVer}.exe.blockmap`
    await kvDeleteKey(wrangler, `blob:${CHANNEL_PREFIX}:${oldBm}`)
    await kvDeleteKey(wrangler, `meta:${CHANNEL_PREFIX}:${oldBm}`)
    console.log(`[prune] Removed old blockmap for v${oldVer}`)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const pkgPath = join(ROOT, 'package.json')
  const pkgRaw = await readFile(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgRaw)

  const targetVersion = opts.setVersion ?? bumpSemver(pkg.version, opts.bump)
  const versionChanged = targetVersion !== pkg.version
  if (versionChanged) {
    pkg.version = targetVersion
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    console.log(`[publish] Bumped package.json version -> ${targetVersion}`)
  } else {
    console.log(`[publish] Publishing current version ${targetVersion}`)
  }

  const outPath = resolve(ROOT, opts.outDir)
  mkdirSync(outPath, { recursive: true })

  if (!opts.skipBuild) {
    if (!opts.skipTests) {
      console.log('[publish] Running typecheck + unit tests...')
      await runNpm(['run', 'typecheck'])
      await runNpm(['test'])
    }
    console.log('[publish] Building bundle (electron-vite build)...')
    await runNpm(['run', 'build'])
    console.log(`[publish] Packaging NSIS installer into ${opts.outDir}...`)
    await runProcess(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['electron-builder', '--win', 'nsis', '--publish', 'never', `--config.directories.output=${opts.outDir}`],
      { cwd: ROOT },
    )
  }

  let notesText = opts.notes
  if (!notesText && opts.notesFile) {
    notesText = await readFile(resolve(ROOT, opts.notesFile), 'utf8')
  }
  if (!notesText) {
    notesText = defaultNotesFor(targetVersion)
  }

  const exePath = join(outPath, `Atrium-Setup-${targetVersion}.exe`)
  if (opts.dryRun) {
    console.log(`[dry-run] Built ${exePath} cleanly (skipping Cloudflare KV upload).`)
    return
  }

  const wrangler = resolveWranglerCommand()
  await uploadReleaseToKv(wrangler, { version: targetVersion, outPath, notesText })
  await verifyLiveFeed(targetVersion, exePath)
  await pruneOldReleases(wrangler, targetVersion, opts.keepReleases, opts.keepBlockmaps)
  console.log(`[publish] Atrium v${targetVersion} is now live at ${WORKER_FEED_ORIGIN}/${CHANNEL_PREFIX}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[publish] Failed:', err)
    process.exit(1)
  })
}
