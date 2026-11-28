import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AppUpdaterController,
  formatReleaseNotes,
  isPlaceholderFeedUrl,
  normalizeFeedUrl,
  readFeedUrlFromAppUpdateYml,
  resolveUpdateConfig,
  type AutoUpdaterLike,
} from '../src/main/updater.ts'
import type { UpdateState } from '../src/shared/types.ts'

class MockAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = true
  forceDevUpdateConfig = false
  logger = null

  feedHistory: unknown[] = []
  checkCalls = 0
  downloadCalls = 0
  quitAndInstallArgs: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = []
  onCheck?: () => Promise<void> | void
  onDownload?: () => Promise<void> | void

  setFeedURL(options: { provider: 'generic'; url: string; useMultipleRangeRequest?: boolean } | string): void {
    this.feedHistory.push(options)
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1
    await this.onCheck?.()
    return null
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1
    await this.onDownload?.()
    return []
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallArgs.push({ isSilent, isForceRunAfter })
  }
}

test('feed URL normalization and placeholder filtering', () => {
  assert.equal(normalizeFeedUrl('  https://cdn.example.com/win///  '), 'https://cdn.example.com/win')
  assert.equal(normalizeFeedUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
  assert.equal(
    normalizeFeedUrl('https://github.com/myorg/atrium/'),
    'https://github.com/myorg/atrium/releases/latest/download',
  )
  assert.equal(
    normalizeFeedUrl('https://github.com/myorg/atrium/releases'),
    'https://github.com/myorg/atrium/releases/latest/download',
  )
  assert.equal(normalizeFeedUrl('file:///C:/updates'), undefined)
  assert.equal(normalizeFeedUrl('   '), undefined)

  assert.equal(isPlaceholderFeedUrl('https://releases.atrium.local/win'), true)
  assert.equal(isPlaceholderFeedUrl('https://example.com/win'), true)
  assert.equal(isPlaceholderFeedUrl('http://127.0.0.1:8080'), false)
  assert.equal(isPlaceholderFeedUrl('https://updates.myteam.dev/atrium'), false)
  assert.equal(isPlaceholderFeedUrl('https://updates.rpulse.top/win'), false)
})

test('resolveUpdateConfig follows override -> env -> settings.json -> app-update.yml priority', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const ymlPath = join(dir, 'app-update.yml')
  await writeFile(ymlPath, 'provider: generic\nurl: https://releases.atrium.local/win\n', 'utf8')

  // Placeholder app-update.yml leaves updater unconfigured; default autoUpdate prompts before download
  const unconfigured = resolveUpdateConfig({ userDataDir: dir, appUpdateYmlPath: ymlPath })
  assert.equal(unconfigured.configured, false)
  assert.equal(unconfigured.feedUrl, undefined)
  assert.equal(unconfigured.autoUpdate, false)

  // Real URL in app-update.yml configures updates
  await writeFile(ymlPath, 'provider: generic\nurl: "https://dist.myorg.dev/atrium/"\n', 'utf8')
  assert.equal(readFeedUrlFromAppUpdateYml(ymlPath), 'https://dist.myorg.dev/atrium')
  const fromYml = resolveUpdateConfig({ userDataDir: dir, appUpdateYmlPath: ymlPath })
  assert.equal(fromYml.configured, true)
  assert.equal(fromYml.feedUrl, 'https://dist.myorg.dev/atrium')

  // settings.json overrides app-update.yml and sets autoUpdate
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ updateUrl: 'http://localhost:9000/win/', autoUpdate: false }))
  const fromSettings = resolveUpdateConfig({ userDataDir: dir, appUpdateYmlPath: ymlPath })
  assert.equal(fromSettings.feedUrl, 'http://localhost:9000/win')
  assert.equal(fromSettings.autoUpdate, false)

  // env and override take precedence in order
  const fromEnv = resolveUpdateConfig({ userDataDir: dir, appUpdateYmlPath: ymlPath, envUrl: 'https://env.myorg.dev/win' })
  assert.equal(fromEnv.feedUrl, 'https://env.myorg.dev/win')

  const fromOverride = resolveUpdateConfig({
    userDataDir: dir,
    appUpdateYmlPath: ymlPath,
    envUrl: 'https://env.myorg.dev/win',
    overrideUrl: 'https://manual.myorg.dev/win/',
  })
  assert.equal(fromOverride.feedUrl, 'https://manual.myorg.dev/win')
})

test('AppUpdaterController handles unconfigured background vs manual checks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const mock = new MockAutoUpdater()
  const ctrl = new AppUpdaterController({
    updater: mock,
    currentVersion: '0.1.0',
    userDataDir: dir,
  })
  t.after(() => ctrl.dispose())

  const bg = await ctrl.checkForUpdates({ background: true })
  assert.equal(bg.status, 'idle')
  assert.equal(bg.configured, false)
  assert.equal(mock.checkCalls, 0)

  const manual = await ctrl.checkForUpdates()
  assert.equal(manual.status, 'error')
  assert.equal(manual.error, 'NOT_CONFIGURED')
})

test('AppUpdaterController transitions through download to Restart to upgrade and shuts down core first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ updateUrl: 'https://updates.example.org/invalid-ignored' }))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ updateUrl: 'https://updates.myorg.dev/win', autoUpdate: true }))

  const events: UpdateState[] = []
  const callOrder: string[] = []
  const mock = new MockAutoUpdater()
  const origQuit = mock.quitAndInstall.bind(mock)
  mock.quitAndInstall = (isSilent?: boolean, isForceRunAfter?: boolean) => {
    callOrder.push('quitAndInstall')
    origQuit(isSilent, isForceRunAfter)
  }
  mock.onCheck = () => {
    mock.emit('checking-for-update')
    mock.emit('update-available', { version: '0.2.0', releaseNotes: '<p>Bug fixes & performance</p>' })
    mock.emit('download-progress', { percent: 42.4 })
    mock.emit('update-downloaded', { version: '0.2.0' })
  }

  const ctrl = new AppUpdaterController({
    updater: mock,
    currentVersion: '0.1.0',
    userDataDir: dir,
    onStateChange: (s) => events.push(s),
    beforeInstall: async () => {
      callOrder.push('beforeInstall')
    },
  })
  t.after(() => ctrl.dispose())

  assert.deepEqual(mock.feedHistory, [
    { provider: 'generic', url: 'https://updates.myorg.dev/win', useMultipleRangeRequest: false },
  ])
  assert.equal(mock.forceDevUpdateConfig, true)

  const finalState = await ctrl.checkForUpdates()
  assert.equal(finalState.status, 'downloaded')
  assert.equal(finalState.version, '0.2.0')
  assert.equal(finalState.percent, 100)
  assert.equal(finalState.releaseNotes, 'Bug fixes & performance')
  assert.deepEqual(
    events.map((s) => s.status),
    ['checking', 'available', 'downloading', 'downloaded'],
  )

  // Background error after download completes must preserve 'downloaded' state
  await ctrl.checkForUpdates({ background: true })
  mock.emit('error', new Error('offline'))
  assert.equal(ctrl.getState().status, 'downloaded')

  await ctrl.installUpdate()
  assert.deepEqual(callOrder, ['beforeInstall', 'quitAndInstall'])
  assert.deepEqual(mock.quitAndInstallArgs, [{ isSilent: false, isForceRunAfter: true }])
})

test('AppUpdaterController supports manual download when autoUpdate is disabled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ updateUrl: 'https://updates.myorg.dev/win', autoUpdate: false }))

  const mock = new MockAutoUpdater()
  mock.onCheck = () => {
    mock.emit('checking-for-update')
    mock.emit('update-available', { version: '0.3.0' })
  }
  mock.onDownload = () => {
    mock.emit('download-progress', { percent: 80 })
    mock.emit('update-downloaded', { version: '0.3.0' })
  }

  const ctrl = new AppUpdaterController({
    updater: mock,
    currentVersion: '0.1.0',
    userDataDir: dir,
  })
  t.after(() => ctrl.dispose())

  assert.equal(mock.autoDownload, false)
  const afterCheck = await ctrl.checkForUpdates()
  assert.equal(afterCheck.status, 'available')
  assert.equal(afterCheck.version, '0.3.0')

  const afterDownload = await ctrl.downloadUpdate()
  assert.equal(mock.downloadCalls, 1)
  assert.equal(afterDownload.status, 'downloaded')
  assert.equal(afterDownload.version, '0.3.0')
})

test('formatReleaseNotes preserves multiline markdown lists and HTML paragraphs', () => {
  assert.equal(formatReleaseNotes('<p>Bug fixes</p><p>Better speed</p>'), 'Bug fixes\nBetter speed')
  assert.equal(formatReleaseNotes('Atrium v0.2.0\n- Item A\n- Item B\n'), 'Atrium v0.2.0\n- Item A\n- Item B')
})

test('AppUpdaterController runs background schedule even when autoUpdate is false, extracts size/date, and throttles focus checks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({ updateUrl: 'https://updates.rpulse.top/win', autoUpdate: false, skippedUpdateVersion: '0.1.9' }),
  )

  const mock = new MockAutoUpdater()
  mock.onCheck = () => {
    mock.emit('checking-for-update')
    mock.emit('update-available', {
      version: '0.2.0',
      releaseDate: '2026-11-15T12:00:00.000Z',
      files: [{ url: 'Atrium-Setup-0.2.0.exe', size: 161_000_000 }],
      releaseNotes: '- Release A\n- Release B',
    })
  }

  const ctrl = new AppUpdaterController({
    updater: mock,
    currentVersion: '0.1.0',
    userDataDir: dir,
  })
  t.after(() => ctrl.dispose())

  ctrl.startSchedule({ initialDelayMs: 25, intervalMs: 60_000 })
  await new Promise((r) => setTimeout(r, 80))

  const state = ctrl.getState()
  assert.equal(mock.checkCalls, 1)
  assert.equal(state.status, 'available')
  assert.equal(state.version, '0.2.0')
  assert.equal(state.source, 'auto')
  assert.equal(state.downloadSize, 161_000_000)
  assert.equal(state.releaseDate, '2026-11-15T12:00:00.000Z')
  assert.equal(state.releaseNotes, '- Release A\n- Release B')

  // Focus check immediately afterwards is throttled inside 30m window
  assert.equal(ctrl.checkOnFocus(30 * 60 * 1000), false)
  // With 0ms throttle it runs immediately
  assert.equal(ctrl.checkOnFocus(0), true)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(mock.checkCalls, 2)
})

test('AppUpdaterController suppresses autoDownload when background check matches skippedUpdateVersion', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-updater-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({ updateUrl: 'https://updates.rpulse.top/win', autoUpdate: true, skippedUpdateVersion: '0.2.0' }),
  )

  const mock = new MockAutoUpdater()
  let observedAutoDownloadDuringAvailable = true
  mock.onCheck = () => {
    mock.emit('checking-for-update')
    mock.emit('update-available', { version: '0.2.0' })
    observedAutoDownloadDuringAvailable = mock.autoDownload
  }

  const ctrl = new AppUpdaterController({
    updater: mock,
    currentVersion: '0.1.0',
    userDataDir: dir,
  })
  t.after(() => ctrl.dispose())

  await ctrl.checkForUpdates({ background: true })
  assert.equal(observedAutoDownloadDuringAvailable, false)
  // Restored cleanly afterward for any newer non-skipped release
  assert.equal(mock.autoDownload, true)
})
