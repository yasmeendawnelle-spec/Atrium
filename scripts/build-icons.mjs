import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(rootDir, 'build', 'icon.svg')
const outPngPath = join(rootDir, 'build', 'icon.png')
const outIcnsPath = join(rootDir, 'build', 'icon.icns')

const require = createRequire(import.meta.url)
const electronBinary = require('electron')

const WORKER_SCRIPT = `'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const htmlPath = process.env.ATRIUM_HTML_PATH
const outDir = process.env.ATRIUM_OUT_DIR

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 128,
    height: 128,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  try {
    await win.loadFile(htmlPath)
    const rendered = await win.webContents.executeJavaScript('window.renderAtriumIcons()', true)
    for (const [size, dataB64] of Object.entries(rendered)) {
      fs.writeFileSync(path.join(outDir, 'icon-' + size + '.png'), Buffer.from(dataB64, 'base64'))
    }
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
`

function buildRenderHtml(svgB64) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;background:transparent">
<script>
window.renderAtriumIcons = async function () {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(svgB64)};
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Failed to decode SVG icon'));
  });
  const sizes = [256, 512, 1024];
  const out = {};
  for (const size of sizes) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    out[size] = canvas.toDataURL('image/png').split(',')[1];
  }
  return out;
};
</script>
</body>
</html>`
}

function buildIcnsBuffer(chunks) {
  const parts = []
  let payloadBytes = 0
  for (const { type, png } of chunks) {
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(8 + png.length, 4)
    parts.push(header, png)
    payloadBytes += 8 + png.length
  }
  const rootHeader = Buffer.alloc(8)
  rootHeader.write('icns', 0, 4, 'ascii')
  rootHeader.writeUInt32BE(8 + payloadBytes, 4)
  return Buffer.concat([rootHeader, ...parts])
}

const tempDir = mkdtempSync(join(tmpdir(), 'atrium-icons-'))
try {
  const svgB64 = readFileSync(svgPath).toString('base64')
  const htmlPath = join(tempDir, 'render.html')
  const scriptPath = join(tempDir, 'render-icons.cjs')
  writeFileSync(htmlPath, buildRenderHtml(svgB64), 'utf8')
  writeFileSync(scriptPath, WORKER_SCRIPT, 'utf8')

  const extraArgs = process.platform === 'linux' ? ['--no-sandbox', '--headless', '--disable-gpu'] : []
  execFileSync(electronBinary, [...extraArgs, scriptPath], {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      ATRIUM_HTML_PATH: htmlPath,
      ATRIUM_OUT_DIR: tempDir,
    },
  })

  const png256 = readFileSync(join(tempDir, 'icon-256.png'))
  const png512 = readFileSync(join(tempDir, 'icon-512.png'))
  const png1024 = readFileSync(join(tempDir, 'icon-1024.png'))

  writeFileSync(outPngPath, png512)
  const icns = buildIcnsBuffer([
    { type: 'ic08', png: png256 },
    { type: 'ic09', png: png512 },
    { type: 'ic10', png: png1024 },
  ])
  writeFileSync(outIcnsPath, icns)
  console.log(`Built ${outPngPath} (512x512, ${png512.length} bytes) and ${outIcnsPath} (${icns.length} bytes)`)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
