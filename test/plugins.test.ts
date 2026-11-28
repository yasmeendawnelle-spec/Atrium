// Comprehensive tests for Plugin Bundle System: discovery, isolation, MCP linking, skills/commands, rules & GitHub import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServerConfig } from '../src/shared/types.ts'
import {
  inspectGithubTreeForPlugin,
  inspectPluginDirectory,
  parsePluginBootConfig,
  PluginManager,
  sanitizePluginCss,
} from '../src/core/plugins.ts'
import { handleMarketRequest, type MarketObjectStore } from '../deploy/market-worker/src/handler.js'
import { systemPrompt } from '../src/core/prompt.ts'
import { SkillsManager } from '../src/core/tools/skills.ts'

async function withTempDirs(fn: (dirs: { appDir: string; homeDir: string; workspace: string; outside: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'atrium-plugins-'))
  const appDir = join(root, 'app')
  const homeDir = join(root, 'home')
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([
    mkdir(appDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ])
  try {
    await fn({ appDir, homeDir, workspace, outside })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function createFakeMcpAdapter(missingSecretIds = new Set<string>()) {
  let servers: McpServerConfig[] = []
  let seq = 1
  const removed: string[] = []

  const adapter = {
    list: () => servers,
    save: async (draft: Omit<McpServerConfig, 'id'> & { id?: string }): Promise<McpServerConfig> => {
      const id = draft.id || `srv_${seq++}`
      const saved: McpServerConfig = { ...draft, id }
      const idx = servers.findIndex((s) => s.id === id)
      if (idx >= 0) servers[idx] = saved
      else servers.push(saved)
      const needsSecret =
        Boolean(saved.secretKeys?.length) ||
        Object.values(saved.env ?? {}).some((v) => v === '' || /\$\{[A-Za-z0-9_]+\}/.test(v)) ||
        Object.values(saved.headers ?? {}).some((v) => v === '' || /\$\{[A-Za-z0-9_]+\}/.test(v))
      if (needsSecret) missingSecretIds.add(id)
      return saved
    },
    remove: async (id: string): Promise<void> => {
      removed.push(id)
      servers = servers.filter((s) => s.id !== id)
    },
    setEnabled: async (id: string, enabled: boolean): Promise<void> => {
      servers = servers.map((s) => (s.id === id ? { ...s, enabled } : s))
    },
    hasMissingSecrets: async (id: string): Promise<boolean> => missingSecretIds.has(id),
    getRemoved: () => removed,
  }
  return adapter
}

test('PluginManager discovers Claude Code, Codex, Antigravity, and Workspace plugins read-only', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace }) => {
    // 1. Claude Code installed plugin with secret MCP + skill + hooks
    const ccDir = join(homeDir, '.claude', 'plugins', 'cache', 'official', 'github', '1.0.0')
    await mkdir(join(ccDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(ccDir, 'skills', 'gh-issue'), { recursive: true })
    await mkdir(join(ccDir, 'hooks'), { recursive: true })
    await writeFile(
      join(ccDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'github', version: '1.0.0', description: 'GitHub integration' }),
    )
    await writeFile(
      join(ccDir, '.mcp.json'),
      JSON.stringify({
        github: {
          type: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        },
      }),
    )
    await writeFile(join(ccDir, 'skills', 'gh-issue', 'SKILL.md'), '---\nname: gh-issue\ndescription: Manage GitHub issues\n---\nInstructions')
    await writeFile(join(ccDir, 'hooks', 'hooks.json'), '{}')
    await mkdir(join(homeDir, '.claude', 'plugins'), { recursive: true })
    await writeFile(
      join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'github@official': [{ installPath: ccDir, version: '1.0.0' }] } }),
    )

    // Hooks-only Claude Code cache plugin -> not recommended
    const hooksOnlyDir = join(homeDir, '.claude', 'plugins', 'cache', 'community', 'guard-hooks', '0.1.0')
    await mkdir(join(hooksOnlyDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(hooksOnlyDir, 'hooks'), { recursive: true })
    await writeFile(join(hooksOnlyDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'guard-hooks', version: '0.1.0' }))
    await writeFile(join(hooksOnlyDir, 'hooks', 'hooks.json'), '{"PreToolUse":[]}')

    // 2. Codex plugin with .codex-plugin/plugin.json + .app.json
    const codexDir = join(homeDir, '.codex', 'plugins', 'cache', 'openai-curated', 'gmail', '1.2.0')
    await mkdir(join(codexDir, '.codex-plugin'), { recursive: true })
    await mkdir(join(codexDir, 'skills', 'mail-draft'), { recursive: true })
    await writeFile(
      join(codexDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'gmail',
        version: '1.2.0',
        skills: './skills/',
        apps: './.app.json',
        interface: { displayName: 'Gmail Assistant', shortDescription: 'Draft and triage emails' },
      }),
    )
    await writeFile(join(codexDir, 'skills', 'mail-draft', 'SKILL.md'), '---\nname: mail-draft\ndescription: Draft Gmail replies\n---\nSteps')
    await writeFile(join(codexDir, '.app.json'), '{"appId":"gmail"}')

    // 3. Antigravity plugin with skills + commands + rules + mixed MCPs (relative stdio + agy-node)
    const agyDir = join(homeDir, '.gemini', 'config', 'plugins', 'design-kit')
    await mkdir(join(agyDir, 'skills', 'design-audit'), { recursive: true })
    await mkdir(join(agyDir, 'commands'), { recursive: true })
    await mkdir(join(agyDir, 'rules'), { recursive: true })
    await mkdir(join(agyDir, 'scripts'), { recursive: true })
    await writeFile(join(agyDir, 'plugin.json'), JSON.stringify({ name: 'design-kit', version: '2.0.0', description: 'Design suite' }))
    await writeFile(join(agyDir, 'skills', 'design-audit', 'SKILL.md'), '---\nname: design-audit\ndescription: Audit visual craft\n---\nChecklist')
    await writeFile(join(agyDir, 'commands', 'ship.md'), '---\ndescription: Pre-release check\n---\nVerify builds')
    await writeFile(join(agyDir, 'rules', 'AGENTS.md'), '# Design Standard\nAlways check contrast.')
    await writeFile(join(agyDir, 'scripts', 'srv.mjs'), 'console.log("ok")')
    await writeFile(
      join(agyDir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'design-local': { command: 'node', args: ['./scripts/srv.mjs'] },
          'agy-only': { command: 'agy-node', args: ['internal.mjs'] },
        },
      }),
    )

    // 4. Workspace plugin
    await mkdir(join(workspace, '.claude-plugin'), { recursive: true })
    await mkdir(join(workspace, 'skills', 'repo-helper'), { recursive: true })
    await writeFile(join(workspace, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'repo-helper', description: 'Workspace plugin' }))
    await writeFile(join(workspace, 'skills', 'repo-helper', 'SKILL.md'), '---\nname: repo-helper\ndescription: Repo helper\n---\nBody')

    const mcp = createFakeMcpAdapter()
    const manager = new PluginManager({ dir: appDir, homeDir, mcp })
    await manager.load()

    const candidates = await manager.discoverLocal(workspace)
    assert.equal(candidates.length, 5)
    assert.equal(manager.list().length, 0)

    const byName = new Map(candidates.map((c) => [c.name, c]))
    const gh = byName.get('github')!
    assert.equal(gh.origin, 'claude-code')
    assert.equal(gh.hasHooks, true)
    assert.equal(gh.recommended, true)
    assert.deepEqual(gh.skillNames, ['gh-issue'])
    assert.equal(gh.mcpProposals.length, 1)

    const hooksOnly = byName.get('guard-hooks')!
    assert.equal(hooksOnly.hasHooks, true)
    assert.equal(hooksOnly.recommended, false)

    const gmail = byName.get('gmail')!
    assert.equal(gmail.origin, 'codex')
    assert.equal(gmail.displayName, 'Gmail Assistant')
    assert.equal(gmail.hasAppConnector, true)
    assert.equal(gmail.recommended, true)

    const design = byName.get('design-kit')!
    assert.equal(design.origin, 'antigravity')
    assert.deepEqual(design.skillNames, ['design-audit'])
    assert.deepEqual(design.commandNames, ['ship'])
    assert.deepEqual(design.ruleFiles, ['rules/AGENTS.md'])
    assert.equal(design.mcpProposals.length, 2)
    assert.ok(design.warnings.some((w) => w.includes('agy-node')))

    const ws = byName.get('repo-helper')!
    assert.equal(ws.origin, 'workspace')
  })
})

test('PluginManager isolates copies, guards secrets/symlinks, feeds Skills & rules, toggles, and cleans up', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace, outside }) => {
    await writeFile(join(outside, 'secret.txt'), 'TOP_SECRET')

    const srcDir = join(homeDir, '.gemini', 'config', 'plugins', 'pro-suite')
    await mkdir(join(srcDir, 'skills', 'code-review'), { recursive: true })
    await mkdir(join(srcDir, 'commands'), { recursive: true })
    await mkdir(join(srcDir, 'rules'), { recursive: true })
    await mkdir(join(srcDir, 'scripts'), { recursive: true })
    await writeFile(join(srcDir, 'plugin.json'), JSON.stringify({ name: 'pro-suite', version: '1.0.0', description: 'Pro workflow bundle' }))
    await writeFile(join(srcDir, 'skills', 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: Thorough code review\n---\nReview checklist')
    await writeFile(join(srcDir, 'commands', 'audit.md'), '---\ndescription: Security audit prompt\n---\nAudit everything')
    await writeFile(join(srcDir, 'rules', 'style.md'), 'Prefer small pure helpers.')
    await writeFile(join(srcDir, 'scripts', 'helper.mjs'), 'console.log(1)')
    await writeFile(join(srcDir, '.app.json'), '{"ignored":true}')
    await writeFile(
      join(srcDir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          localhelper: { command: 'node', args: ['./scripts/helper.mjs'] },
          secretapi: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ${PRO_API_KEY}' } },
        },
      }),
    )

    try {
      await symlink(join(outside, 'secret.txt'), join(srcDir, 'escaped-secret.txt'))
    } catch {
      /* On Windows without Dev Mode, symlink creation may fail; skip assertion if skipped */
    }

    const mcp = createFakeMcpAdapter()
    let disabledSkills: string[] = []
    const manager = new PluginManager({
      dir: appDir,
      homeDir,
      mcp,
      getDisabledSkills: () => disabledSkills,
      setDisabledSkills: (names) => {
        disabledSkills = names
      },
    })
    await manager.load()

    const res = await manager.importLocal([srcDir])
    assert.equal(res.installed.length, 1)
    assert.equal(res.skipped.length, 0)
    const plugin = res.installed[0]!
    assert.equal(plugin.enabled, true)
    assert.equal(plugin.origin, 'antigravity')
    assert.deepEqual(plugin.skillNames, ['code-review'])
    assert.deepEqual(plugin.commandNames, ['audit'])
    assert.deepEqual(plugin.ruleFiles, ['rules/style.md'])

    // Isolated install dir does not contain skipped .app.json or escaped symlink
    await assert.rejects(() => access(join(plugin.installDir, '.app.json')))
    await assert.rejects(() => access(join(plugin.installDir, 'escaped-secret.txt')))

    // Secret-requiring MCP remains disabled while non-secret MCP is enabled with resolved script path
    const servers = mcp.list()
    assert.equal(servers.length, 2)
    const localSrv = servers.find((s) => s.name === 'localhelper')!
    const secretSrv = servers.find((s) => s.name === 'secretapi')!
    assert.equal(localSrv.enabled, true)
    assert.equal(localSrv.args?.[0], resolve(plugin.installDir, 'scripts/helper.mjs'))
    assert.equal(secretSrv.enabled, false)

    // Candidate scan now marks alreadyImported = true
    const candidates = await manager.discoverLocal(workspace)
    assert.equal(candidates[0]?.alreadyImported, true)
    assert.equal(candidates[0]?.importedPluginId, plugin.id)

    // SkillsManager discovers bundled skills + commands as scope 'plugin'
    const skillsMgr = new SkillsManager({
      appDir: join(appDir, 'empty-app'),
      homeDir,
      getDisabled: () => disabledSkills,
      setDisabled: (n) => {
        disabledSkills = n
      },
      getPluginSources: () => manager.activeSkillSources(),
    })
    const listedSkills = await skillsMgr.list(workspace)
    assert.deepEqual(listedSkills.map((s) => s.name).sort(), ['audit', 'code-review'])
    assert.ok(listedSkills.every((s) => s.scope === 'plugin' && s.pluginId === plugin.id))
    const auditDetail = await skillsMgr.get('audit', workspace)
    assert.ok(auditDetail?.content.includes('Audit everything'))

    // System prompt includes active rules
    const rulesPrompt = await manager.formatActiveRulesPrompt()
    assert.ok(rulesPrompt.includes('Prefer small pure helpers.'))
    const promptText = systemPrompt(workspace, undefined, {
      pluginRules: rulesPrompt,
    })
    assert.ok(promptText.includes('<plugin_rules>'))
    assert.ok(promptText.includes('Prefer small pure helpers.'))

    // Disabling plugin disables MCPs, excludes skills/rules, keeps files intact
    await manager.setEnabled(plugin.id, false)
    assert.equal(mcp.list().every((s) => !s.enabled), true)
    assert.equal((await manager.activeSkillSources()).length, 0)
    assert.equal(await manager.formatActiveRulesPrompt(), '')

    // Re-enabling keeps secret-missing MCP disabled, restores local MCP + skills + rules
    await manager.setEnabled(plugin.id, true)
    assert.equal(mcp.list().find((s) => s.id === localSrv.id)?.enabled, true)
    assert.equal(mcp.list().find((s) => s.id === secretSrv.id)?.enabled, false)
    assert.equal((await manager.activeSkillSources()).length, 1)
    assert.equal((await skillsMgr.list(workspace)).length, 2)
    assert.ok((await manager.formatActiveRulesPrompt()).includes('Prefer small pure helpers.'))

    // Detail returns bundled file list & README if present
    const detail = await manager.get(plugin.id)
    assert.ok(detail)
    assert.ok(detail.files.includes('rules/style.md'))

    // Remove deletes copy & linked MCPs without touching original srcDir
    await manager.remove(plugin.id)
    assert.equal(manager.list().length, 0)
    assert.equal(mcp.list().length, 0)
    await assert.rejects(() => access(plugin.installDir))
    const origStillExists = await readFile(join(srcDir, 'plugin.json'), 'utf8')
    assert.ok(origStillExists.includes('pro-suite'))
  })
})

test('PluginManager.importFolder supports a standalone single-SKILL folder', async () => {
  await withTempDirs(async ({ appDir, homeDir, outside }) => {
    const bareSkill = join(outside, 'my-bare-skill')
    await mkdir(join(bareSkill, 'references'), { recursive: true })
    await writeFile(join(bareSkill, 'SKILL.md'), '---\nname: bare-craft\ndescription: Single folder skill\n---\nFollow these steps.')
    await writeFile(join(bareSkill, 'references', 'notes.md'), 'Ref notes')

    const inspected = await inspectPluginDirectory(bareSkill)
    assert.ok(inspected)
    assert.equal(inspected.isBareSingleSkill, true)
    assert.deepEqual(inspected.skillNames, ['bare-craft'])

    const manager = new PluginManager({ dir: appDir, homeDir, mcp: createFakeMcpAdapter() })
    await manager.load()
    const res = await manager.importFolder(bareSkill)
    assert.equal(res.installed.length, 1)
    assert.deepEqual(res.installed[0]?.skillNames, ['bare-craft'])
    assert.equal(res.installed[0]?.origin, 'local')

    const skillsMgr = new SkillsManager({
      appDir: join(appDir, 'empty-app'),
      homeDir,
      getDisabled: () => [],
      setDisabled: () => {},
      getPluginSources: () => manager.activeSkillSources(),
    })
    const loaded = await skillsMgr.get('bare-craft')
    assert.ok(loaded?.content.includes('Follow these steps.'))
  })
})

test('inspectGithubTreeForPlugin & PluginManager.importGithub import GitHub subdir plugin bundle', async () => {
  await withTempDirs(async ({ appDir, homeDir }) => {
    const files: Record<string, string> = {
      'plugins/cool-pack/plugin.json': JSON.stringify({
        name: 'cool-pack',
        version: '0.4.0',
        description: 'Remote GitHub bundle',
      }),
      'plugins/cool-pack/skills/api-helper/SKILL.md': '---\nname: api-helper\ndescription: API helper skill\n---\nCheck docs.',
      'plugins/cool-pack/commands/check.md': '---\ndescription: Run API check\n---\nVerify API',
      'plugins/cool-pack/rules/policy.md': 'Keep payloads small.',
      'plugins/cool-pack/.mcp.json': JSON.stringify({
        remote: { type: 'http', url: 'https://mcp.acme.test/sse', headers: { Authorization: 'Bearer ${ACME_KEY}' } },
      }),
    }

    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://api.github.com/repos/acme/tools') {
        return new Response(JSON.stringify({ default_branch: 'main', description: 'Acme Tools' }), { status: 200 })
      }
      if (url === 'https://api.github.com/repos/acme/tools/git/trees/main?recursive=1') {
        return new Response(
          JSON.stringify({
            tree: Object.keys(files).map((path) => ({ path, type: 'blob' })),
          }),
          { status: 200 },
        )
      }
      const prefix = 'https://raw.githubusercontent.com/acme/tools/main/'
      if (url.startsWith(prefix)) {
        const rel = url.slice(prefix.length)
        if (files[rel] !== undefined) {
          return new Response(files[rel], { status: 200 })
        }
      }
      return new Response('Not Found', { status: 404 })
    }

    const subPrefix = 'plugins/cool-pack/'
    const subTreePaths = Object.keys(files)
      .filter((p) => p.startsWith(subPrefix))
      .map((p) => p.slice(subPrefix.length))
    const proposal = await inspectGithubTreeForPlugin(
      'https://github.com/acme/tools/tree/main/plugins/cool-pack',
      subTreePaths,
      async (rel) => files[`${subPrefix}${rel}`] ?? null,
    )
    assert.ok(proposal)
    assert.equal(proposal.name, 'cool-pack')
    assert.deepEqual(proposal.skillNames, ['api-helper'])
    assert.deepEqual(proposal.commandNames, ['check'])
    assert.deepEqual(proposal.ruleFiles, ['rules/policy.md'])
    assert.equal(proposal.mcpCount, 1)

    const mcp = createFakeMcpAdapter()
    const manager = new PluginManager({
      dir: appDir,
      homeDir,
      mcp,
      fetchImpl: mockFetch as any,
    })
    await manager.load()
    const res = await manager.importGithub('https://github.com/acme/tools/tree/main/plugins/cool-pack')
    assert.equal(res.installed.length, 1)
    const installed = res.installed[0]!
    assert.equal(installed.origin, 'github')
    assert.equal(installed.version, '0.4.0')
    assert.deepEqual(installed.skillNames, ['api-helper'])
    assert.deepEqual(installed.commandNames, ['check'])
    assert.deepEqual(installed.ruleFiles, ['rules/policy.md'])
    assert.equal(mcp.list().length, 1)
    assert.equal(mcp.list()[0]?.enabled, false)
  })
})

test('sanitizePluginCss and parsePluginBootConfig enforce strict declarative boundaries', () => {
  const dirtyCss = [
    '@import url("https://evil.example/leak.css");',
    ':root[data-plugin-theme="x"] { --bg: #090d14; background: url(https://track.example/p.png); }',
    '.a { width: expression(alert(1)); background-image: url("data:image/svg+xml;utf8,<svg></svg>"); behavior: url(foo.htc); }',
    '.b { background: javascript:alert(1); }',
  ].join('\n')
  const clean = sanitizePluginCss(dirtyCss)
  assert.ok(!clean.includes('@import url'))
  assert.ok(!clean.includes('https://track.example'))
  assert.ok(!clean.includes('expression('))
  assert.ok(!clean.includes('behavior:'))
  assert.ok(!clean.includes('javascript:'))
  assert.ok(clean.includes('--bg: #090d14'))
  assert.ok(clean.includes('data:image/svg+xml'))

  assert.equal(parsePluginBootConfig('{bad json'), null)
  assert.equal(parsePluginBootConfig(JSON.stringify({ style: 'rhine-lab-orbital' })), null)

  const parsedBoot = parsePluginBootConfig(
    JSON.stringify({
      style: 'rhine-lab-access',
      durationMs: 99999,
      brand: '  RHINE LAB \x00 ',
      telemetryLines: ['  [01] OK  ', 123, ''],
      palette: {
        bg: '#e8e5e1',
        brass: '#9b7247',
        accent: 'rgb(242, 116, 56)',
        accent2: 'expression(alert(1))',
      },
    }),
  )
  assert.ok(parsedBoot)
  assert.equal(parsedBoot.style, 'rhine-lab-access')
  assert.equal(parsedBoot.durationMs, 4500)
  assert.equal(parsedBoot.brand, 'RHINE LAB')
  assert.deepEqual(parsedBoot.telemetryLines, ['[01] OK'])
  assert.equal(parsedBoot.palette?.bg, '#e8e5e1')
  assert.equal(parsedBoot.palette?.brass, '#9b7247')
  assert.equal(parsedBoot.palette?.accent, 'rgb(242, 116, 56)')
  assert.equal(parsedBoot.palette?.accent2, undefined)
})

test('Rhine Lab theme & boot plugin loads cleanly, toggles activeTheme, and packs for Official Marketplace', async () => {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const pluginDir = join(repoRoot, 'plugins', 'rhine-lab-theme')

  const inspected = await inspectPluginDirectory(pluginDir)
  assert.ok(inspected)
  assert.equal(inspected.id, 'rhine-lab-theme')
  assert.equal(inspected.author, 'Lucas Qiu')
  assert.equal(inspected.hasTheme, true)
  assert.equal(inspected.hasBootAnimation, true)
  assert.equal(inspected.recommended, true)

  await withTempDirs(async ({ appDir, homeDir }) => {
    const manager = new PluginManager({ dir: appDir, homeDir, mcp: createFakeMcpAdapter() })
    await manager.load()
    assert.equal(await manager.getActiveTheme(), null)

    const res = await manager.importFolder(pluginDir)
    assert.equal(res.installed.length, 1)
    assert.equal(res.installed[0]?.hasTheme, true)
    assert.equal(res.installed[0]?.hasBootAnimation, true)

    const active = await manager.getActiveTheme()
    assert.ok(active)
    assert.equal(active.themeId, 'rhine-lab')
    assert.equal(active.chrome, 'rhine-lab')
    assert.deepEqual(active.effects, {
      clickReticle: true,
      telemetryHud: true,
      rollingClock: true,
      tactileAudio: true,
      redactionReveal: true,
      archiveBackdrop: true,
      archiveMode: true,
    })
    assert.ok(active.css.includes('--bg: #e8e5e1'))
    assert.ok(active.css.includes('--rl-olive: #565c46'))
    assert.ok(active.css.includes('--accent: #9b7247'))
    assert.ok(active.css.includes(":root[data-plugin-theme='rhine-lab'][data-theme='dark']"))
    assert.ok(active.css.includes('@keyframes rl-redaction-wipe'))
    assert.ok(active.css.length < 128 * 1024)
    assert.equal(active.boot?.brand, 'RHINE LAB')
    assert.equal(active.boot?.style, 'rhine-lab-access')
    assert.equal(active.boot?.confirmEntry, true)
    assert.equal(active.boot?.entryReadyText, 'INTERNAL DATABASE / READY')
    assert.equal(active.boot?.accessPrompt, 'ACCESS PERMISSION REQUIRED')
    assert.equal(active.boot?.companyTag, 'RHINE LAB.LLC.')
    assert.equal(active.boot?.palette?.olive, '#565c46')
    assert.equal(active.boot?.palette?.brass, '#9b7247')
    assert.equal(active.boot?.palette?.accent, '#ed821b')
    assert.equal(active.boot?.specCode, 'SPEC.NO // RL-X-001')

    await manager.setEnabled('rhine-lab-theme', false)
    assert.equal(await manager.getActiveTheme(), null)

    await manager.setEnabled('rhine-lab-theme', true)
    assert.equal((await manager.getActiveTheme())?.themeId, 'rhine-lab')

    // Verify packed bundle passes Cloudflare Worker Official Co-contributor submission validation
    const packed = await manager.packLocalFolder(pluginDir)
    assert.equal(packed.hasTheme, true)
    assert.equal(packed.hasBootAnimation, true)
    assert.equal(packed.hasScripts, false)

    const kv = new Map<string, unknown>()
    const store: MarketObjectStore = {
      async getJson(k) {
        return kv.has(k) ? structuredClone(kv.get(k)) : null
      },
      async putJson(k, v) {
        kv.set(k, structuredClone(v))
      },
      async delete(k) {
        kv.delete(k)
      },
    }
    const submitRes = await handleMarketRequest(
      new Request('https://market.example.com/api/market/plugins', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-co', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: packed.name,
          displayName: packed.displayName,
          version: packed.version,
          description: packed.description,
          submissionKind: 'bundle',
          targetSection: 'official',
          hasTheme: packed.hasTheme,
          hasBootAnimation: packed.hasBootAnimation,
          files: packed.files,
        }),
      }),
      store,
      {
        authOrigin: 'https://auth.example.com',
        coContributorEmails: 'lucas@example.com',
        reviewerEmails: 'lucas@example.com',
        githubRepo: '',
        fetchImpl: (async (input: string | URL | Request) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          if (url.endsWith('/api/user/profile')) {
            return new Response(
              JSON.stringify({
                user: { email: 'lucas@example.com', display_name: 'Lucas Qiu', avatar: 'https://example.com/lucas.png' },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          return new Response('Not Found', { status: 404 })
        }) as typeof fetch,
      },
    )
    assert.equal(submitRes.status, 201)
    const submitJson = (await submitRes.json()) as {
      plugin: { status: string; section: string; hasTheme: boolean; hasBootAnimation: boolean; author: { name: string } }
    }
    assert.equal(submitJson.plugin.status, 'approved')
    assert.equal(submitJson.plugin.section, 'official')
    assert.equal(submitJson.plugin.hasTheme, true)
    assert.equal(submitJson.plugin.hasBootAnimation, true)
    assert.equal(submitJson.plugin.author.name, 'Lucas Qiu')

    await manager.remove('rhine-lab-theme')
    assert.equal(await manager.getActiveTheme(), null)
  })
})
