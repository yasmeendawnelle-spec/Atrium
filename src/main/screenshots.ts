// Development aid: when ATRIUM_SHOTS is set to a folder, walk the main screens and save PNGs there.
// It runs against a throwaway profile inside that folder, so real settings and keys are never loaded.
//   ATRIUM_SHOTS_DEMO=1    seed that profile with a finished chat, a few connections and a model,
//                          so the busy screens can be photographed without a key.
//   ATRIUM_SHOTS_LOCALE    zh (default) or en, for the demo profile.
import { app, BrowserWindow as ElectronBrowserWindow, nativeTheme, WebContentsView, type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const dir = process.env.ATRIUM_SHOTS
// ATRIUM_SHOTS_LIVE=1 runs one real chat turn instead. It needs a saved key, so it uses the real profile
// (keys are encrypted against it) and leaves one new chat behind in the history.
const live = process.env.ATRIUM_SHOTS_LIVE === '1'
const demo = process.env.ATRIUM_SHOTS_DEMO === '1'
const locale = process.env.ATRIUM_SHOTS_LOCALE === 'en' ? 'en' : 'zh'

/** Call before app is ready. Returns true when a screenshot run was requested. */
export function prepareScreenshots(): boolean {
  if (!dir) return false
  mkdirSync(dir, { recursive: true })
  if (!live) {
    const profile = join(dir, 'profile')
    rmSync(profile, { recursive: true, force: true })
    app.setPath('userData', profile)
    if (demo) seedDemoProfile(profile)
  }
  return true
}

function write(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

function seedDemoProfile(profile: string): void {
  const zh = locale === 'zh'
  const now = Date.now()
  const demoWs = join(profile, 'atrium-notes')
  mkdirSync(join(demoWs, 'src'), { recursive: true })
  writeFileSync(join(demoWs, 'src', 'index.ts'), '// entry\n')
  writeFileSync(join(demoWs, 'src', 'agent.ts'), '// agent\n')
  mkdirSync(join(demoWs, 'notes'), { recursive: true })
  writeFileSync(join(demoWs, 'notes', 'roadmap.md'), '# Roadmap\n')
  mkdirSync(join(demoWs, '.agents', 'skills', 'code-review', 'references'), { recursive: true })
  mkdirSync(join(demoWs, '.agents', 'skills', 'code-review', 'scripts'), { recursive: true })
  writeFileSync(
    join(demoWs, '.agents', 'skills', 'code-review', 'SKILL.md'),
    zh
      ? '---\nname: code-review\ndescription: 严格审查架构边界、安全性与测试完备度的工作流技能\n---\n\n# 代码审查规范\n\n1. 先使用 `search` 与 `run_subagent(explorer)` 定位影响面。\n2. 检查输入校验、路径边界与错误兜底。\n3. 补充自动化回归测试并验证覆盖率。\n'
      : '---\nname: code-review\ndescription: Rigorous code review checklist for boundary safety, state integrity, and test coverage\n---\n\n# Code Review Workflow\n\n1. Dispatch parallel explorer subagents to map affected modules.\n2. Audit input validation, path containment, and error paths.\n3. Verify regression tests cover all changed branches.\n',
  )
  writeFileSync(join(demoWs, '.agents', 'skills', 'code-review', 'references', 'checklist.md'), '# Security & Diff Checklist\n- Verify path containment\n- Confirm zero unguarded async side-effects\n')
  writeFileSync(join(demoWs, '.agents', 'skills', 'code-review', 'scripts', 'verify.sh'), '#!/usr/bin/env bash\nnpm run typecheck && npm test\n')
  mkdirSync(join(demoWs, '.claude', 'skills', 'api-design'), { recursive: true })
  writeFileSync(
    join(demoWs, '.claude', 'skills', 'api-design', 'SKILL.md'),
    zh
      ? '---\nname: api-design\ndescription: 设计幂等 REST/RPC 接口契约、错误码与兼容性迁移方案\n---\n\n# 接口设计原则\n\n- 保持向后兼容与清晰分页。\n- 所有错误响应返回结构化 code/message。\n'
      : '---\nname: api-design\ndescription: Design idempotent API contracts, error schemas, and backwards-compatible migrations\n---\n\n# API Guidelines\n\n- Prefer cursor pagination and structured errors.\n',
  )
  write(join(demoWs, 'package.json'), { name: 'atrium-notes', scripts: { start: 'node src/index.ts' } })
  writeFileSync(join(demoWs, 'README.md'), '# atrium-notes\n')
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: demoWs, windowsHide: true, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'demo@atrium.local'], { cwd: demoWs, windowsHide: true, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Atrium Demo'], { cwd: demoWs, windowsHide: true, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: demoWs, windowsHide: true, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'chore: initial workspace'], { cwd: demoWs, windowsHide: true, stdio: 'ignore' })
  } catch {
    /* ignore if git unavailable */
  }
  writeFileSync(
    join(demoWs, 'README.md'),
    '# atrium-notes\n\nMinimal local workspace note indexer with fast ripgrep search and checkpoint rollback.\n\n## Commands\n\n```bash\nnpm install\nnpm start\n```\n',
  )
  const demoHome = join(profile, 'demo-home')
  process.env.ATRIUM_PLUGIN_HOME = demoHome

  const demoUiPluginSrc = join(demoHome, '.gemini', 'config', 'plugins', 'ui-ux-pro-max')
  const demoUiPluginInstall = join(profile, 'plugins', 'ui-ux-pro-max')
  for (const dir of [demoUiPluginSrc, demoUiPluginInstall]) {
    mkdirSync(join(dir, 'skills', 'ui-ux-pro-max'), { recursive: true })
    mkdirSync(join(dir, 'skills', 'design-system'), { recursive: true })
    mkdirSync(join(dir, 'rules'), { recursive: true })
    write(join(dir, 'plugin.json'), {
      name: 'ui-ux-pro-max',
      displayName: 'UI/UX Pro Max',
      version: '2.4.0',
      description: zh
        ? '设计系统 Token、排版配色与高审美前端组件工程规范套件'
        : 'UI/UX design intelligence, color palettes, font pairings, and craft rules',
    })
    writeFileSync(
      join(dir, 'skills', 'ui-ux-pro-max', 'SKILL.md'),
      zh
        ? '---\nname: ui-ux-pro-max\ndescription: 构建与审计高质感界面、排版系统与交互细节\n---\n始终核对明暗对比度与留白层次。'
        : '---\nname: ui-ux-pro-max\ndescription: UI/UX design craft audit, typography & component polish\n---\nVerify spacing rhythm and light/dark contrast.',
    )
    writeFileSync(
      join(dir, 'skills', 'design-system', 'SKILL.md'),
      zh
        ? '---\nname: design-system\ndescription: 生成三层设计 Token 与组件规范\n---\n优先复用语义 Token。'
        : '---\nname: design-system\ndescription: Generate 3-layer design tokens and component specs\n---\nUse semantic tokens consistently.',
    )
    writeFileSync(
      join(dir, 'rules', 'AGENTS.md'),
      zh
        ? '# 设计工艺规范\n保持 Warm Alabaster 与 Deep Slate 视觉层级一致，不堆砌高饱和色块。'
        : '# Design Craft Rules\nPreserve calm hierarchy and legible typographic contrast.',
    )
  }

  const demoGhSrc = join(demoHome, '.claude', 'plugins', 'cache', 'official', 'github', '1.0.0')
  mkdirSync(join(demoGhSrc, '.claude-plugin'), { recursive: true })
  mkdirSync(join(demoGhSrc, 'skills', 'gh-triage'), { recursive: true })
  mkdirSync(join(demoGhSrc, 'hooks'), { recursive: true })
  write(join(demoGhSrc, '.claude-plugin', 'plugin.json'), {
    name: 'github',
    version: '1.3.0',
    description: zh
      ? 'Claude Code 官方 GitHub 插件：Issue 分诊技能、PR 工作流与 GitHub MCP'
      : 'Official GitHub integration with issue triage skills and GitHub MCP',
  })
  writeFileSync(
    join(demoGhSrc, 'skills', 'gh-triage', 'SKILL.md'),
    zh
      ? '---\nname: gh-triage\ndescription: 自动分类与总结仓库 Issue 及 PR 变更\n---\n读取上下文并归纳优先级。'
      : '---\nname: gh-triage\ndescription: Triage repository issues and summarize PR diffs\n---\nReview context cleanly.',
  )
  write(join(demoGhSrc, '.mcp.json'), {
    github: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    },
  })
  write(join(demoGhSrc, 'hooks', 'hooks.json'), { hooks: {} })
  write(join(demoHome, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'github@claude-plugins-official': [{ installPath: demoGhSrc, version: '1.3.0' }] },
  })

  const demoCodexGmailSrc = join(demoHome, '.codex', 'plugins', 'cache', 'openai-curated', 'gmail', '1.0.0')
  mkdirSync(join(demoCodexGmailSrc, '.codex-plugin'), { recursive: true })
  mkdirSync(join(demoCodexGmailSrc, 'skills', 'mail-draft'), { recursive: true })
  write(join(demoCodexGmailSrc, '.codex-plugin', 'plugin.json'), {
    name: 'gmail',
    version: '1.0.0',
    skills: './skills/',
    apps: './.app.json',
    interface: {
      displayName: zh ? 'Gmail 邮件助手' : 'Gmail Assistant',
      shortDescription: zh
        ? 'Codex 生态邮件撰写与重要线程归纳插件'
        : 'Search threads and draft polished replies cleanly',
    },
  })
  writeFileSync(
    join(demoCodexGmailSrc, 'skills', 'mail-draft', 'SKILL.md'),
    zh
      ? '---\nname: mail-draft\ndescription: 根据上下文草拟简洁得体的邮件回复\n---\n保持礼貌清晰的行动项。'
      : '---\nname: mail-draft\ndescription: Draft concise email replies from thread context\n---\nHighlight action items clearly.',
  )
  write(join(demoCodexGmailSrc, '.app.json'), { appId: 'gmail' })

  write(join(profile, 'plugins.json'), [
    {
      id: 'ui-ux-pro-max',
      name: 'ui-ux-pro-max',
      displayName: 'UI/UX Pro Max',
      version: '2.4.0',
      description: zh
        ? '设计系统 Token、排版配色与高审美前端组件工程规范套件'
        : 'UI/UX design intelligence, color palettes, font pairings, and craft rules',
      origin: 'antigravity',
      originLabel: 'Antigravity',
      sourcePath: demoUiPluginSrc,
      installDir: demoUiPluginInstall,
      enabled: true,
      installedAt: now - 86_400_000,
      updatedAt: now - 86_400_000,
      skillNames: ['ui-ux-pro-max', 'design-system'],
      commandNames: [],
      ruleFiles: ['rules/AGENTS.md'],
      mcpServerIds: [],
    },
  ])

  write(join(profile, 'settings.json'), {
    onboarded: true,
    locale,
    activeProviderId: 'prov_demo',
    workspace: demoWs,
    recentWorkspaces: [demoWs, 'D:\\projects\\agent-studio', 'D:\\notes\\research'],
    pluginDiscoveryDismissed: true,
    shellSandbox: 'workspace_write',
    memoryEnabled: true,
    quickEntryShortcut: 'Alt+Space',
    voiceMode: 'auto',
  })
  write(join(profile, 'providers.json'), [
    { id: 'prov_demo', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', presetId: 'deepseek', hasKey: true },
    { id: 'prov_demo2', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', presetId: 'anthropic', hasKey: true },
  ])
  write(join(profile, 'relaypulse-account.json'), {
    origin: 'https://api.rpulse.top',
    connected: true,
    email: 'demo@gmail.com',
    balanceCny: 68.5,
    specialBalanceUsd: 5.0,
    keyGroup: 'claude-kiro',
    subscriptions: {
      gpt: {
        category: 'gpt',
        level: 'standard',
        planId: 'gpt_standard',
        weeklyLimitUsd: 9.5,
        weeklyUsedUsd: 2.18,
        monthlyLimitUsd: 38,
        monthlyUsedUsd: 6.5,
        cycleResetAt: new Date(now + 4 * 86_400_000).toISOString(),
        startedAt: new Date(now - 6 * 86_400_000).toISOString(),
        expiresAt: new Date(now + 24 * 86_400_000).toISOString(),
        source: 'atrium',
      },
      claude: {
        category: 'claude',
        level: 'pro',
        planId: 'claude_pro',
        weeklyLimitUsd: 34,
        weeklyUsedUsd: 7.48,
        monthlyLimitUsd: 136,
        monthlyUsedUsd: 19.2,
        cycleResetAt: new Date(now + 4 * 86_400_000).toISOString(),
        startedAt: new Date(now - 9 * 86_400_000).toISOString(),
        expiresAt: new Date(now + 21 * 86_400_000).toISOString(),
        source: 'remote',
      },
    },
  })
  // Disabled, so nothing is spawned while the screenshots run.
  write(join(profile, 'mcp-servers.json'), [
    { id: 'mcp_a', name: 'filesystem', enabled: false, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\projects'] },
    { id: 'mcp_b', name: 'github', enabled: false, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    { id: 'mcp_c', name: 'context7', enabled: false, transport: 'http', url: 'https://mcp.context7.com/mcp' },
    { id: 'mcp_d', name: 'linear', enabled: false, transport: 'http', url: 'https://mcp.linear.app/mcp', authMode: 'oauth', oauth: { scopes: 'read write', authorized: false } },
  ])
  write(join(profile, 'automations.json'), [
    {
      id: 'auto_demo1',
      name: zh ? '每日仓库改动与待办早报' : 'Daily Repo Commit & Task Digest',
      prompt: zh ? '总结最近 24 小时 Git 提交与待办改动。' : 'Summarize git commits and workspace updates from the last 24h.',
      workspace: demoWs,
      useWorktree: true,
      agentMode: 'auto',
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      enabled: true,
      notifyOnComplete: true,
      createdAt: now - 172_800_000,
      updatedAt: now - 3_600_000,
      lastRunAt: now - 3_600_000,
      nextRunAt: now + 79_200_000,
      lastStatus: 'done',
      lastConversationId: 'chat_demo1',
      lastSummary: zh
        ? '已梳理 README 与 src/agent.ts 的近期变更，无未提交冲突或失败测试。'
        : 'Reviewed README and src/agent.ts updates; repository checks and workspace health are green.',
      history: [
        {
          runId: 'run_demo1',
          startedAt: now - 3_600_000,
          finishedAt: now - 3_540_000,
          status: 'done',
          conversationId: 'chat_demo1',
          summary: zh ? '每日巡检完成：索引检索与检查点测试通过。' : 'Daily check complete: indexer & checkpoint tests passed.',
        },
      ],
    },
    {
      id: 'auto_demo2',
      name: zh ? '周期性安全与密钥卫生巡检' : 'Periodic Secret & Lint Sweep',
      prompt: zh ? '只读扫描仓库中潜在的明文密钥与高风险依赖。' : 'Read-only scan for exposed credentials and risky config changes.',
      workspace: demoWs,
      useWorktree: false,
      agentMode: 'plan',
      schedule: { kind: 'interval', minutes: 360 },
      enabled: false,
      notifyOnComplete: true,
      createdAt: now - 86_400_000,
      updatedAt: now - 43_200_000,
    },
  ])

  write(join(profile, 'memory.json'), [
    {
      id: 'mem_demo1',
      content: zh
        ? '修改 TypeScript 源码后务必主动执行 npm run typecheck 确认前后端类型零报错。'
        : 'Always run `npm run typecheck` after modifying TypeScript files to verify node and web targets.',
      category: 'workflow',
      scope: 'global',
      pinned: true,
      createdAt: now - 172_800_000,
      updatedAt: now - 3_600_000,
    },
    {
      id: 'mem_demo2',
      content: zh
        ? 'atrium-notes 使用文件 pre-image 检查点与原子多文件补丁 apply_patch，禁止跳过撤销记录直接改写核心索引文件。'
        : 'atrium-notes uses CheckpointStore pre-image snapshots and atomic `apply_patch`; never mutate core index files without checkpoint capture.',
      category: 'decision',
      scope: 'workspace',
      workspace: demoWs,
      pinned: true,
      createdAt: now - 86_400_000,
      updatedAt: now - 7_200_000,
    },
    {
      id: 'mem_demo3',
      content: zh
        ? '图表与架构预览统一优先采用内嵌 `<artifact type="react">` 或 Mermaid 语法，不引用外部 CDN。'
        : 'Prefer offline `<artifact type="react">` Recharts components or Mermaid diagrams with zero external CDNs.',
      category: 'preference',
      scope: 'global',
      pinned: false,
      createdAt: now - 43_200_000,
      updatedAt: now - 43_200_000,
    },
  ])

  const normDemoWs = resolve(demoWs).replace(/[\\/]+$/, '')
  const kbScope = process.platform === 'win32' ? normDemoWs.toLowerCase() : normDemoWs
  const kbHash = createHash('sha1').update(kbScope).digest('hex').slice(0, 16)
  write(join(profile, 'data', 'knowledge', `${kbHash}.json`), {
    workspace: demoWs,
    sources: [
      {
        id: 'kb_demo1',
        title: 'architecture-spec.pdf',
        kind: 'file',
        path: 'docs/architecture-spec.pdf',
        docKind: 'pdf',
        chunkCount: 6,
        charCount: 4820,
        updatedAt: now - 7_200_000,
      },
      {
        id: 'kb_demo2',
        title: zh ? '索引吞吐与 BM25 分词设计约束' : 'Indexing Throughput & BM25 Tokenizer Invariants',
        kind: 'note',
        docKind: 'text',
        chunkCount: 2,
        charCount: 1240,
        updatedAt: now - 3_600_000,
      },
    ],
    chunks: [
      {
        id: 'kb_demo1_1',
        sourceId: 'kb_demo1',
        title: 'architecture-spec.pdf',
        path: 'docs/architecture-spec.pdf',
        section: 'Page 2 · Rollback Engine',
        text: zh
          ? 'Atrium 检查点系统（CheckpointStore）在每次 Edit / Write / Patch 前保存目标文件 pre-image 快照，支持按文件粒度和按轮次一键 rewind 回滚，且在 gitCommit 后自动标记已提交。'
          : 'CheckpointStore records exact file pre-images prior to Edit/Write/Patch mutations, enabling per-file revert and per-turn conversation rewind with clean gitCommit state tracking.',
        length: 28,
        tf: { checkpointstore: 1, atrium: 1, pre: 1, image: 1, 检查: 1, 查点: 1, 点系: 1, 系统: 1, 回滚: 1, bm25: 1 },
      },
      {
        id: 'kb_demo2_1',
        sourceId: 'kb_demo2',
        title: zh ? '索引吞吐与 BM25 分词设计约束' : 'Indexing Throughput & BM25 Tokenizer Invariants',
        section: 'Hybrid Tokenizer',
        text: zh
          ? '项目知识库索引采用中英文双语分词器（英文标识符拆词 + 中文 unigram/bigram），配合 BM25 (k1=1.5, b=0.75) 实现完全离线毫秒级精确引用。'
          : 'Hybrid EN + CJK BM25 tokenizer splits code identifiers alongside Chinese unigram/bigram tokens for sub-10ms offline passage citation.',
        length: 24,
        tf: { bm25: 1, hybrid: 1, tokenizer: 1, 知识: 1, 识库: 1, 索引: 1, 分词: 1, 检索: 1, 离线: 1 },
      },
    ],
  })

  const main = {
    id: 'chat_demo1',
    title: zh ? '看看工作区里有什么，写个 README' : 'Look through the workspace and draft a README',
    createdAt: now - 600_000,
    updatedAt: now - 60_000,
    workspace: demoWs,
    messages: [
      {
        role: 'user',
        text: zh ? '结合这份架构说明书，帮我看看工作区里有什么并起草一份 README。' : 'Using this architecture spec, inspect the workspace and draft a README.',
        documents: [
          {
            id: 'doc_demo_pdf',
            name: 'architecture-spec.pdf',
            docKind: 'pdf',
            pageCount: 8,
            content: '## Page 1\nAtrium Notes Indexing & Rollback Spec\n- Ripgrep fast search\n- Checkpoint pre-image store',
          },
        ],
      },
      {
        role: 'assistant',
        text: zh ? '好的，我先看看工作区里有哪些文件。' : "Sure. I'll start by looking at which files are here.",
        reasoning: zh ? '用户想先了解工作区，再写 README。先列目录，再读 package.json 确认项目名称和脚本。' : 'They want an overview first, then a README. List the folder, then read package.json for the name and scripts.',
        toolCalls: [{ id: 'call_1', name: 'list_dir', input: { path: '.' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'list_dir', output: 'file package.json\ndir src\nfile notes.md', isError: false },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call_2', name: 'read_file', input: { path: 'package.json' } }] },
      { role: 'tool', toolCallId: 'call_2', name: 'read_file', output: '{\n  "name": "atrium-notes",\n  "scripts": { "start": "node src/index.js" }\n}', isError: false },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'call_3', name: 'load_skill', input: { name: 'code-review' } },
          {
            id: 'call_4',
            name: 'run_subagent',
            input: { role: 'explorer', task: zh ? '并行的调研 src/index.ts 与 src/agent.ts 的模块边界' : 'Inspect module boundaries in src/index.ts and src/agent.ts' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'call_3', name: 'load_skill', output: '# Skill: code-review (.agents/skills)\nLoaded checklist.md and verify.sh', isError: false },
      {
        role: 'tool',
        toolCallId: 'call_4',
        name: 'run_subagent',
        output: '[Subagent (explorer) · 3 tool steps]\nSteps: list_dir(src) -> read_file(src/index.ts) -> read_file(src/agent.ts)\nConfirmed entry point delegates core tool loop to src/agent.ts.',
        isError: false,
      },
      {
        role: 'assistant',
        mode: 'plan',
        workScene: 'code',
        usage: { inputTokens: 1840, outputTokens: 420, cacheReadTokens: 1200 },
        text: zh
          ? '看完了，这是一个结构清晰的 Node 项目，我已经起草并整理好了 README 与模块交互概览：\n\n- 入口文件是 `src/index.ts`\n- 代理循环与工具调度位于 `src/agent.ts`\n\n<artifact identifier="module-diagram" type="mermaid" title="模块调用流转图">\nflowchart LR\n  User["用户请求"] --> Agent["Agent Loop"]\n  Agent --> Search["Ripgrep 检索"]\n  Agent --> Patch["多文件原子补丁"]\n  Patch --> Studio["工作台变更对比"]\n</artifact>\n\n我也同步准备了一个交互式健康度面板：\n\n<artifact identifier="notes-widget" type="text/html" title="Notes Studio 概览卡片">\n<div style="font-family:system-ui,sans-serif;padding:4px">\n  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">\n    <h3 style="margin:0;font-size:16px">atrium-notes 状态总览</h3>\n    <span style="padding:3px 10px;border-radius:99px;background:rgba(46,122,82,0.14);color:#2e7a52;font-size:12px;font-weight:600">运行正常</span>\n  </div>\n  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">\n    <div style="padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.2)">\n      <div style="font-size:11px;opacity:0.7">源文件</div>\n      <div style="font-size:20px;font-weight:700;margin-top:4px">4</div>\n    </div>\n    <div style="padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.2)">\n      <div style="font-size:11px;opacity:0.7">已检索引擎</div>\n      <div style="font-size:20px;font-weight:700;margin-top:4px">rg 15.2</div>\n    </div>\n    <div style="padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.2)">\n      <div style="font-size:11px;opacity:0.7">检查点保护</div>\n      <div style="font-size:20px;font-weight:700;margin-top:4px">100%</div>\n    </div>\n  </div>\n</div>\n</artifact>\n\n<artifact identifier="notes-react-chart" type="react" title="索引吞吐量看板 (React)">\nimport { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"\nimport { Sparkles } from "lucide-react"\nconst data = [{ day: "Mon", files: 18 }, { day: "Tue", files: 34 }, { day: "Wed", files: 27 }, { day: "Thu", files: 46 }, { day: "Fri", files: 39 }]\nexport default function App() {\n  return (\n    <div className="space-y-4">\n      <div className="flex items-center justify-between">\n        <div className="flex items-center gap-2">\n          <Sparkles size={16} className="text-orange-600" />\n          <h3 className="m-0 text-base font-semibold">每日索引文件吞吐量</h3>\n        </div>\n        <span className="badge">Recharts · 离线沙盒</span>\n      </div>\n      <div className="card h-64">\n        <ResponsiveContainer width="100%" height={210}>\n          <BarChart data={data}>\n            <XAxis dataKey="day" />\n            <YAxis />\n            <Tooltip />\n            <Bar dataKey="files" fill="#c46342" radius={[6, 6, 0, 0]} />\n          </BarChart>\n        </ResponsiveContainer>\n      </div>\n    </div>\n  )\n}\n</artifact>'
          : "That's a clean Node project. I inspected the entry points and drafted the README alongside a live architecture flow:\n\n- Entry point: `src/index.ts`\n- Core loop & tools: `src/agent.ts`\n\n<artifact identifier=\"module-diagram\" type=\"mermaid\" title=\"Module Architecture\">\nflowchart LR\n  User[\"User Prompt\"] --> Agent[\"Agent Loop\"]\n  Agent --> Search[\"Ripgrep Search\"]\n  Agent --> Patch[\"Atomic Patch\"]\n  Patch --> Studio[\"Studio Changes\"]\n</artifact>\n\n<artifact identifier=\"notes-widget\" type=\"text/html\" title=\"Notes Health Card\">\n<div style=\"font-family:system-ui,sans-serif;padding:4px\">\n  <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px\">\n    <h3 style=\"margin:0;font-size:16px\">atrium-notes Workspace</h3>\n    <span style=\"padding:3px 10px;border-radius:99px;background:rgba(46,122,82,0.14);color:#2e7a52;font-size:12px;font-weight:600\">Healthy</span>\n  </div>\n  <div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:10px\">\n    <div style=\"padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.2)\"><div style=\"font-size:11px;opacity:0.7\">Files</div><div style=\"font-size:20px;font-weight:700;margin-top:4px\">4</div></div>\n    <div style=\"padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.2)\"><div style=\"font-size:11px;opacity:0.7\">Search</div><div style=\"font-size:20px;font-weight:700;margin-top:4px\">rg</div></div>\n    <div style=\"padding:12px;border-radius:10px;border:1px solid rgba(128,128,128,0.2)\"><div style=\"font-size:11px;opacity:0.7\">Checkpoints</div><div style=\"font-size:20px;font-weight:700;margin-top:4px\">Ready</div></div>\n  </div>\n</div>\n</artifact>\n\n<artifact identifier=\"notes-react-chart\" type=\"react\" title=\"Throughput Chart (React)\">\nimport { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from \"recharts\"\nimport { Sparkles } from \"lucide-react\"\nconst data = [{ day: \"Mon\", files: 18 }, { day: \"Tue\", files: 34 }, { day: \"Wed\", files: 27 }, { day: \"Thu\", files: 46 }, { day: \"Fri\", files: 39 }]\nexport default function App() {\n  return (\n    <div className=\"space-y-4\">\n      <div className=\"flex items-center justify-between\">\n        <div className=\"flex items-center gap-2\">\n          <Sparkles size={16} className=\"text-orange-600\" />\n          <h3 className=\"m-0 text-base font-semibold\">Daily Indexed Files</h3>\n        </div>\n        <span className=\"badge\">Recharts · Offline</span>\n      </div>\n      <div className=\"card h-64\">\n        <ResponsiveContainer width=\"100%\" height={210}>\n          <BarChart data={data}>\n            <XAxis dataKey=\"day\" />\n            <YAxis />\n            <Tooltip />\n            <Bar dataKey=\"files\" fill=\"#c46342\" radius={[6, 6, 0, 0]} />\n          </BarChart>\n        </ResponsiveContainer>\n      </div>\n    </div>\n  )\n}\n</artifact>",
        toolCalls: [],
      },
    ],
  }
  const others = [
    {
      id: 'chat_demo2',
      title: zh ? '重构索引并发队列' : 'Refactor index worker queue',
      workspace: demoWs,
      worktreeBaseWorkspace: demoWs,
      worktreeBranch: 'atrium/feat-indexing',
      worktreeBaseBranch: 'main',
      at: now - 3_600_000,
      messages: [
        { role: 'user', text: zh ? '帮我拆分索引队列的背压控制' : 'Split backpressure controls for the index worker queue' },
        {
          role: 'assistant',
          workScene: 'code',
          usage: { inputTokens: 1380, outputTokens: 460, cacheReadTokens: 640 },
          text: zh ? '已完成队列拆分并补充背压限制。' : 'Split the queue stages and added bounded backpressure.',
          toolCalls: [],
        },
      ],
    },
    {
      id: 'chat_demo3',
      title: zh ? '把 CSV 转成 Markdown 表格' : 'Turn a CSV into a Markdown table',
      workspace: 'D:\\projects\\agent-studio',
      at: now - 86_400_000,
      messages: [
        { role: 'user', text: zh ? '把这份季度汇报 CSV 整理成可读的汇总表与结论' : 'Format this quarterly report CSV into a clean summary table and takeaways' },
        {
          role: 'assistant',
          workScene: 'work',
          usage: { inputTokens: 1620, outputTokens: 540, cacheReadTokens: 520 },
          text: zh ? '已整理完成并对齐表头汇总指标。' : 'Formatted the CSV summary table with key takeaways.',
          toolCalls: [],
        },
        { role: 'user', text: zh ? '再补充一列环比变化' : 'Add a MoM change column as well' },
        {
          role: 'assistant',
          workScene: 'work',
          usage: { inputTokens: 920, outputTokens: 310, cacheReadTokens: 380 },
          text: zh ? '已补充环比变化百分比列。' : 'Added the month-over-month percentage column.',
          toolCalls: [],
        },
      ],
    },
    {
      id: 'chat_demo4',
      title: zh ? '解释一下 MCP 是什么' : 'What is MCP, in plain words?',
      workspace: 'D:\\notes\\research',
      at: now - 172_800_000,
      messages: [
        { role: 'user', text: zh ? '解释一下 MCP 是什么，能带来什么帮助？' : 'Explain what MCP is in plain words.' },
        {
          role: 'assistant',
          workScene: 'work',
          text: zh ? 'MCP 是模型上下文协议，让桌面助手安全连接本地工具与外部数据源。' : 'MCP is the Model Context Protocol, connecting assistants safely to local tools and external data.',
          toolCalls: [],
        },
      ],
    },
  ]
  const data = join(profile, 'data')
  write(join(data, 'chats', `${main.id}.json`), main)
  write(join(data, 'checkpoints', `${main.id}.json`), [
    {
      path: 'README.md',
      beforeExists: true,
      beforeContent: '# atrium-notes\n',
      updatedAt: now - 30_000,
    },
  ])
  write(join(data, 'chats.json'), [
    { id: main.id, title: main.title, workspace: main.workspace, createdAt: main.createdAt, updatedAt: main.updatedAt },
    ...others.map((c) => ({
      id: c.id,
      title: c.title,
      workspace: c.workspace,
      ...(c.worktreeBaseWorkspace ? { worktreeBaseWorkspace: c.worktreeBaseWorkspace } : {}),
      ...(c.worktreeBranch ? { worktreeBranch: c.worktreeBranch } : {}),
      ...(c.worktreeBaseBranch ? { worktreeBaseBranch: c.worktreeBaseBranch } : {}),
      createdAt: c.at,
      updatedAt: c.at,
    })),
  ])
  for (const c of others) {
    write(join(data, 'chats', `${c.id}.json`), {
      id: c.id,
      title: c.title,
      workspace: c.workspace,
      ...(c.worktreeBaseWorkspace ? { worktreeBaseWorkspace: c.worktreeBaseWorkspace } : {}),
      ...(c.worktreeBranch ? { worktreeBranch: c.worktreeBranch } : {}),
      ...(c.worktreeBaseBranch ? { worktreeBaseBranch: c.worktreeBaseBranch } : {}),
      createdAt: c.at,
      updatedAt: c.at,
      messages: 'messages' in c && c.messages ? c.messages : [],
    })
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function click(win: BrowserWindow, selector: string, index = 0): Promise<void> {
  const ok = await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return false; el.click(); return true })()`,
  )
  if (!ok) console.warn(`[shots] nothing matched ${selector}[${index}]`)
  await wait(500)
}

async function shot(win: BrowserWindow, name: string): Promise<void> {
  const image = await win.webContents.capturePage()
  writeFileSync(join(dir!, `${name}.png`), image.toPNG())
  console.log(`[shots] saved ${name}.png`)
}

async function waitFor(win: BrowserWindow, test: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(`Boolean(${test})`)) return true
    await wait(400)
  }
  console.warn(`[shots] timed out waiting for ${test}`)
  return false
}

const idle = `document.querySelector('.send-btn:not(.stop)')`

async function runLive(win: BrowserWindow): Promise<void> {
  nativeTheme.themeSource = 'light'
  await wait(2500)
  await click(win, '.new-chat')
  const prompt = process.env.ATRIUM_SHOTS_PROMPT ??
    '先列出工作区里有哪些文件，然后创建 notes/hello.md，写一段三行的 Markdown：一个标题、一句介绍、一个代码块。'
  // React tracks the textarea value itself, so set it through the native setter and fire input.
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(prompt)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await wait(200)
  await click(win, '.send-btn')
  await wait(1500)
  await shot(win, 'live-streaming')
  // Approve every request until the turn ends; photograph the first one.
  let approvals = 0
  while (await waitFor(win, `document.querySelector('.approval .btn-approve:not(:disabled)') || ${idle}`, 180_000)) {
    const asking = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.approval .btn-approve:not(:disabled)'))`)
    if (!asking) break
    if (approvals++ === 0) {
      await wait(600)
      await shot(win, 'live-approval')
    }
    await click(win, '.approval .btn-approve:not(:disabled)')
  }
  await wait(800)
  await shot(win, 'live-done')
  await win.webContents.executeJavaScript(`document.querySelectorAll('.tool-head').forEach((b) => b.click())`)
  await wait(400)
  await shot(win, 'live-tools-open')
  nativeTheme.themeSource = 'dark'
  await wait(600)
  await shot(win, 'live-done-dark')
  nativeTheme.themeSource = 'system'
  app.quit()
}

/** The permission card and thinking indicator are live-only states, so for pictures we draw the same markup into the page. */
const oculusSvg = (size: number, kind: 'thinking' | 'approval' = 'thinking') => {
  const blade = 'M 6.63 5.1 L 10.61 2.8 Q 12 2 13.39 2.8 L 19.45 6.3 Q 20.66 7 20.66 8.4 L 20.66 9.2 L 17.2 11.2 L 17.2 9 L 12 6 L 10.09 7.1 Z'
  const coreLeft = 'M 12 7.2 L 8.15 13.5 L 12 11.95 Z'
  const coreRight = 'M 12 7.2 L 15.85 13.5 L 12 11.95 Z'
  const coreBase = 'M 8.15 13.5 L 12 11.95 L 15.85 13.5 L 12 16.3 Z'
  const pal = kind === 'approval'
    ? { a1: '#FCE09B', a2: '#E19D2B', b1: '#E19C28', b2: '#B4710B', c1: '#C27A10', c2: '#854D03', cl: '#FDEAB8', cr: '#D68C16', cb: '#8D5405' }
    : { a1: '#F7B796', a2: '#DE7B58', b1: '#DF7A55', b2: '#B55132', c1: '#C05837', c2: '#89341B', cl: '#FAD0BA', cr: '#D46B48', cb: '#923A20' }
  const ga = `shots-pa-${kind}`
  const gb = `shots-pb-${kind}`
  const gc = `shots-pc-${kind}`
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="${ga}" x1="7" y1="2" x2="20" y2="11" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${pal.a1}"/><stop offset="100%" stop-color="${pal.a2}"/></linearGradient><linearGradient id="${gb}" x1="20" y1="9" x2="9" y2="21" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${pal.b1}"/><stop offset="100%" stop-color="${pal.b2}"/></linearGradient><linearGradient id="${gc}" x1="9" y1="20" x2="6" y2="5" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="${pal.c1}"/><stop offset="100%" stop-color="${pal.c2}"/></linearGradient></defs><circle class="oculus-glow" cx="12" cy="12" r="10.6"/><g class="oculus-prism"><path d="${blade}" fill="url(#${ga})"/><path d="${blade}" fill="url(#${gb})" transform="rotate(120 12 12)"/><path d="${blade}" fill="url(#${gc})" transform="rotate(240 12 12)"/></g><g class="oculus-core"><path d="${coreLeft}" fill="${pal.cl}"/><path d="${coreRight}" fill="${pal.cr}"/><path d="${coreBase}" fill="${pal.cb}"/></g></svg>`
}

const thinkingMarkup = (zh: boolean) => `
<div class="working" id="shots-thinking">
  <div class="thinking-bar thinking-thinking" role="status">
    <span class="oculus oculus-thinking" style="width:22px;height:22px">${oculusSvg(22, 'thinking')}</span>
    <span class="thinking-label">${zh ? '正在深入推演…' : 'Atrium is thinking…'}</span>
    <span class="thinking-wave" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
  </div>
</div>`

const approvalMarkup = (zh: boolean) => `
<section class="approval" id="shots-approval">
  <h3><span class="oculus oculus-approval" style="width:18px;height:18px">${oculusSvg(18, 'approval')}</span>${zh ? 'Atrium 想要运行命令' : 'Atrium wants to run a command'}</h3>
  <code class="approval-summary">npm install &amp;&amp; npm test -- --reporter=spec</code>
  <div class="approval-actions"><button class="btn">${zh ? '不允许' : "Don't allow"}</button><button class="btn">${zh ? '本次会话都允许' : 'Allow for this session'}</button><button class="btn">${zh ? '始终允许此类' : 'Always allow'}</button><button class="btn btn-approve">${zh ? '允许' : 'Allow'}</button></div>
</section>`

async function runDemo(win: BrowserWindow, theme: 'light' | 'dark', suffix: string, _createNewChat: boolean, demoBrowserUrl: string): Promise<void> {
  const zh = locale === 'zh'
  nativeTheme.themeSource = theme
  await wait(300)
  await click(win, '.new-chat')
  await shot(win, `1-start${suffix}`)
  await click(win, '.model-pick')
  await wait(350)
  await shot(win, `1b-model-menu${suffix}`)
  await click(win, '.model-pick')
  await click(win, '[data-composer-plus]')
  await wait(300)
  await shot(win, `1g-plus-menu${suffix}`)
  await click(win, '[data-plus-submenu="connectors"]')
  await wait(250)
  await shot(win, `1h-plus-connectors${suffix}`)
  await click(win, '[data-plus-submenu="plugins"]')
  await wait(250)
  await shot(win, `1i-plus-plugins${suffix}`)
  await click(win, '[data-composer-plus]')
  await click(win, '.topbar-btn')
  await wait(450)
  await shot(win, `1e-workspace-drawer${suffix}`)
  await click(win, '.topbar-btn')
  await click(win, '.chat-item-act.danger', 0)
  await wait(300)
  await shot(win, `8-confirm-dialog${suffix}`)
  await click(win, '.dialog .btn')
  await click(win, '.chat-item-open', 0)
  await waitFor(win, 'document.querySelector(".chat-scroll")', 5_000)
  await wait(400)
  await shot(win, `2-chat${suffix}`)
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelectorAll('.ws-group-head')[0];
    if (el) {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width * 0.5), clientY: Math.round(r.top + r.height * 0.5), button: 2 }));
    }
  })()`)
  await waitFor(win, 'document.querySelector(".ctx-menu")', 3_000)
  await wait(160)
  await shot(win, `1c-ws-context-menu${suffix}`)
  await win.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const el = document.querySelectorAll('.chat-item')[0];
    if (el) {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width * 0.55), clientY: Math.round(r.top + r.height * 0.5), button: 2 }));
    }
  })()`)
  await waitFor(win, 'document.querySelector(".ctx-menu")', 3_000)
  await wait(160)
  await shot(win, `1d-chat-context-menu${suffix}`)
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(120)
  await click(win, '.context-ring-btn', 0)
  await wait(260)
  await shot(win, `2c-context-popover${suffix}`)
  await click(win, '.context-breakdown-btn', 0)
  await wait(240)
  await shot(win, `2d-context-breakdown${suffix}`)
  await click(win, '.context-ring-btn', 0)
  await win.webContents.executeJavaScript(
    `document.querySelector('.chat-scroll').insertAdjacentHTML('beforeend', ${JSON.stringify(thinkingMarkup(zh))}); document.querySelector('.chat-scroll').scrollTop = 1e6`,
  )
  await wait(450)
  await shot(win, `2b-thinking${suffix}`)
  await win.webContents.executeJavaScript(
    `document.getElementById('shots-thinking')?.remove(); document.querySelector('.chat-scroll').insertAdjacentHTML('beforeend', ${JSON.stringify(approvalMarkup(zh))}); document.querySelector('.chat-scroll').scrollTop = 1e6`,
  )
  await wait(400)
  await shot(win, `3-approval${suffix}`)
  await win.webContents.executeJavaScript(`document.getElementById('shots-approval')?.remove(); document.querySelectorAll('.tool-head').forEach((b) => b.click()); document.querySelector('.reasoning')?.setAttribute('open', '')`)
  await wait(300)
  await shot(win, `4-chat-open${suffix}`)
  await click(win, '.perm-pick', 0) // open 5-mode Permissions popover
  await wait(250)
  await shot(win, `1f-permissions-menu${suffix}`)
  await click(win, '.perm-option.mode-plan', 0) // switch to Plan mode
  await wait(250)
  await shot(win, `4d-plan-mode${suffix}`)
  await click(win, '.perm-pick', 0) // reopen Permissions popover
  await wait(200)
  await click(win, '.perm-option.mode-auto', 0) // restore Auto mode
  await wait(200)
  await click(win, '.scene-btn', 0) // toggle Work scene
  await wait(200)
  await shot(win, `4e-work-scene${suffix}`)
  await click(win, '.scene-btn', 1) // restore Code scene
  await wait(150)
  await click(win, '.artifact-card', 0)
  await waitFor(win, 'document.querySelector(".artifact-mermaid-stage svg")', 8_000)
  await wait(250)
  await shot(win, `4b-studio-artifacts${suffix}`)
  await click(win, '.studio-art-pill', 1)
  await wait(800) // allow sandboxed HTML artifact iframe render
  await shot(win, `4b2-studio-artifact-html${suffix}`)
  await click(win, '.studio-art-pill', 2)
  await wait(1100) // allow offline React + Recharts TSX artifact compilation & SVG chart mount
  await shot(win, `4b3-studio-artifact-react${suffix}`)
  await click(win, '.studio-tab', 1) // Changes tab
  await wait(550)
  await win.webContents.executeJavaScript(`(() => {
    if (!document.querySelector('.studio-inline-comment')) {
      const trig = document.querySelector('.diff-comment-trigger');
      if (trig) {
        trig.click();
        setTimeout(() => {
          const ta = document.querySelector('.studio-inline-editor textarea');
          if (ta) {
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            set?.call(ta, ${JSON.stringify(zh ? '请补充环境变量说明与示例配置' : 'Add env var config examples here')});
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => document.querySelector('.studio-inline-editor .btn-primary')?.click(), 60);
          }
        }, 60);
      }
    }
    const ci = document.querySelector('.studio-commit-input');
    if (ci && !ci.value) {
      const setIn = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setIn?.call(ci, 'docs: add README & architecture notes');
      ci.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`)
  await wait(350)
  await shot(win, `4c-studio-changes${suffix}`)
  await click(win, '.studio-tab', 2) // Files tab
  await waitFor(win, 'document.querySelector(".ws-file-row")', 4_000)
  await wait(220)
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelectorAll('.ws-file-row')[0];
    if (el) {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width * 0.45), clientY: Math.round(r.top + r.height * 0.5), button: 2 }));
    }
  })()`)
  await waitFor(win, 'document.querySelector(".ctx-menu")', 3_000)
  await wait(160)
  await shot(win, `4i-file-context-menu${suffix}`)
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(120)
  await click(win, '.studio-tab', 3) // Terminal tab
  await wait(300)
  await win.webContents.executeJavaScript(`document.querySelector('.terminal-panel .btn-primary, .terminal-new-btn')?.click()`)
  await wait(900)
  await shot(win, `4g-studio-terminal${suffix}`)
  await click(win, '.studio-tab', 4) // Browser tab
  await wait(300)
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.querySelector('.browser-url-input');
    if (inp) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(inp, ${JSON.stringify(demoBrowserUrl)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setTimeout(() => document.querySelector('.browser-toolbar .btn-primary')?.click(), 60);
  })()`)
  await waitFor(win, 'document.querySelector(".browser-stage img")', 10_000)
  await wait(350)
  await shot(win, `4h-studio-browser${suffix}`)
  // Simulate user clicking & focusing inside the live embedded WebContentsView, then dragging both resizers.
  const childViews = win.contentView.children.filter((v): v is WebContentsView => v instanceof WebContentsView)
  const embedded = childViews.find((v) => v.webContents !== win.webContents)
  if (embedded) {
    embedded.webContents.focus()
    embedded.webContents.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'left', clickCount: 1 })
    embedded.webContents.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'left', clickCount: 1 })
    await wait(100)
  }
  const verifyDrag = async (resizerSel: string, panelSel: string, deltaX: number, label: string) => {
    const info = (await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector(${JSON.stringify(resizerSel)})?.getBoundingClientRect();
      const p = document.querySelector(${JSON.stringify(panelSel)})?.getBoundingClientRect();
      const stage = document.querySelector('.browser-stage')?.getBoundingClientRect();
      if (!r || !p) return null;
      const hitX = Math.round(r.left + r.width / 2);
      const hitY = Math.round(r.top + r.height / 2);
      const hitEl = document.elementFromPoint(hitX, hitY);
      return {
        x: hitX,
        y: hitY,
        beforeW: Math.round(p.width),
        hitMatched: Boolean(hitEl && hitEl.closest(${JSON.stringify(resizerSel)})),
        overlapsBrowserStage: Boolean(stage && hitX >= stage.left + 3),
      };
    })()`)) as { x: number; y: number; beforeW: number; hitMatched: boolean; overlapsBrowserStage: boolean } | null
    if (!info) throw new Error(`[shots] missing ${resizerSel} or ${panelSel}`)
    if (!info.hitMatched || info.overlapsBrowserStage) {
      throw new Error(`[shots] resizer ${label} hit test failed: ${JSON.stringify(info)}`)
    }
    const embedBefore = embedded ? embedded.getBounds().width : 0
    win.webContents.sendInputEvent({ type: 'mouseDown', x: info.x, y: info.y, button: 'left', clickCount: 1 })
    await wait(30)
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: info.x + Math.round(deltaX / 2),
      y: info.y,
      modifiers: ['leftbuttondown'],
    })
    await wait(40)
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: info.x + deltaX,
      y: info.y,
      modifiers: ['leftbuttondown'],
    })
    await wait(40)
    const midVisible = embedded ? embedded.getVisible() : false
    const embedAfter = embedded ? embedded.getBounds().width : 0
    win.webContents.sendInputEvent({ type: 'mouseUp', x: info.x + deltaX, y: info.y, button: 'left', clickCount: 1 })
    await wait(120)
    const afterW = (await win.webContents.executeJavaScript(
      `Math.round(document.querySelector(${JSON.stringify(panelSel)})?.getBoundingClientRect().width ?? 0)`,
    )) as number
    console.log(
      `[shots] resize ${label}: ${info.beforeW} -> ${afterW} (deltaX=${deltaX}, embeddedVisible=${midVisible}, embeddedW=${embedBefore}->${embedAfter})`,
    )
    if (Math.abs(afterW - info.beforeW) < 15) {
      throw new Error(`[shots] resizer ${label} did not resize (${info.beforeW} -> ${afterW})`)
    }
    if (label.startsWith('studio') && embedded) {
      if (!midVisible || Math.abs(embedAfter - embedBefore) < 15) {
        throw new Error(
          `[shots] embedded browser should stretch live without hiding: visible=${midVisible}, width=${embedBefore}->${embedAfter}`,
        )
      }
    }
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(resizerSel)})?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`,
    )
    await wait(120)
  }
  await verifyDrag('.studio-resizer', '.workspace-drawer', -100, 'studio')
  await verifyDrag('.studio-resizer', '.workspace-drawer', 60, 'studio-narrow')
  await verifyDrag('.sidebar-resizer', '.sidebar', 48, 'sidebar')
  await click(win, '.studio-head .studio-close-btn') // close studio before switching views
  await wait(250)
  await click(win, '.side-top-acts > .icon-btn', 0) // collapse sidebar to verify header controls
  await wait(250)
  await shot(win, `4f-sidebar-collapsed${suffix}`)
  await click(win, '.topbar-left > .icon-btn', 0) // restore sidebar open
  await wait(200)
  await click(win, '[data-view="connections"]')
  await shot(win, `5-connections${suffix}`)
  await click(win, '.conn-tabs .seg-btn', 1)
  await wait(300)
  await win.webContents.executeJavaScript(`document.querySelector('.row-toggle')?.click()`)
  await wait(300)
  await shot(win, `5b-skills${suffix}`)
  await click(win, '.conn-tabs .seg-btn', 2)
  await wait(300)
  await click(win, '.page-actions .btn-primary')
  await wait(350)
  await shot(win, `5d-plugin-discover${suffix}`)
  await click(win, '.plugin-discover-foot-right .btn', 0)
  await wait(250)
  await win.webContents.executeJavaScript(`document.querySelector('.row-toggle')?.click()`)
  await wait(300)
  await shot(win, `5c-plugins${suffix}`)
  await click(win, '.conn-tabs .seg-btn', 0)
  await click(win, '[data-view="market"]')
  await wait(4000) // live registry search
  await shot(win, `6-market${suffix}`)
  await click(win, '[data-view="automations"]')
  await wait(300)
  await win.webContents.executeJavaScript(`document.querySelector('.auto-row .row-toggle')?.click()`)
  await wait(250)
  await shot(win, `5e-automations${suffix}`)
  await click(win, '[data-view="knowledge"]')
  await wait(250)
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.querySelector('.kb-search-bar input');
    if (inp) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(inp, ${JSON.stringify(zh ? 'BM25 离线 检索' : 'BM25 tokenizer')});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('.kb-search-bar .btn-primary')?.click();
  })()`)
  await wait(350)
  await shot(win, `5f-knowledge${suffix}`)
  await click(win, '.conn-tabs .seg-btn', 1)
  await wait(250)
  await shot(win, `5g-memory${suffix}`)
  await click(win, '.conn-tabs .seg-btn', 0)
  await click(win, '.chat-item-open', 0) // return to chat canvas so Settings Modal floats over workspace
  await wait(250)
  await click(win, '[data-view="settings"]')
  await wait(250)
  await shot(win, `7-settings${suffix}`)
  await click(win, '[data-settings-tab="code"]')
  await wait(250)
  await shot(win, `7a-settings-code${suffix}`)
  await click(win, '[data-settings-tab="usage"]')
  await wait(550)
  await shot(win, `7d-settings-usage${suffix}`)
  win.webContents.send('app:updater', {
    status: 'downloaded',
    currentVersion: '0.1.0',
    version: '0.2.0',
    percent: 100,
    downloadSize: 161_400_000,
    releaseDate: '2026-11-15T12:00:00.000Z',
    feedUrl: 'https://releases.atrium.local/win',
    configured: true,
    releaseNotes: zh
      ? '- 新增更新提醒弹窗（支持立即更新、稍后提醒、跳过此版本）\n- 接入官方增量发布源'
      : '- Interactive update reminder dialog (Update now / Later / Skip version)\n- Connected live release feed',
  })
  await click(win, '[data-settings-tab="system"]')
  await wait(350)
  await shot(win, `7b-settings-updates${suffix}`)
  await click(win, '[data-settings-close]')
  await wait(200)
  win.webContents.send('app:updater', {
    status: 'available',
    currentVersion: '0.1.0',
    version: '0.2.0',
    downloadSize: 161_400_000,
    releaseDate: '2026-11-15T12:00:00.000Z',
    source: 'auto',
    feedUrl: 'https://releases.atrium.local/win',
    configured: true,
    releaseNotes: zh
      ? '- 新增更新提醒弹窗（支持立即更新、稍后提醒、跳过此版本）\n- 接入官方增量发布源\n- 优化后台检查与焦点自动检测节流'
      : '- Interactive update reminder dialog (Update now / Later / Skip)\n- Connected live release feed\n- Startup and throttled focus update checks',
  })
  await wait(350)
  await shot(win, `7c-update-reminder${suffix}`)
  win.webContents.send('app:updater', {
    status: 'idle',
    currentVersion: '0.1.0',
    configured: false,
  })
  await click(win, '.rp-side-account')
  await wait(350)
  await shot(win, `8-account-subscriptions${suffix}`)
  await click(win, '.rp-avatar-btn')
  await wait(250)
  await shot(win, `8b-account-avatar-picker${suffix}`)
  await click(win, '.dialog-close')
  await wait(200)
  // Capture standalone Quick Entry floating window appearance
  const qWin = new ElectronBrowserWindow({
    width: 660,
    height: 196,
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  try {
    if (process.env.ELECTRON_RENDERER_URL) await qWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}#quick`)
    else await qWin.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'quick' })
    await wait(550)
    await qWin.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('.quick-input-wrap textarea');
      if (ta) {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        set?.call(ta, ${JSON.stringify(zh ? '帮我总结刚才终端里的测试输出' : 'Summarize the latest test output in my terminal')});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`)
    await wait(250)
    const img = await qWin.webContents.capturePage()
    writeFileSync(join(dir!, `9-quick-entry${suffix}.png`), img.toPNG())
    console.log(`[shots] saved 9-quick-entry${suffix}.png`)
  } finally {
    if (!qWin.isDestroyed()) qWin.destroy()
  }
}

export async function runScreenshots(win: BrowserWindow): Promise<void> {
  win.webContents.on('console-message', (ev) => {
    if (ev.level === 'error' || ev.level === 'warning') {
      console.log(`[shots:renderer:${ev.level}] ${ev.message}`)
    }
  })
  const demoSrv = demo
    ? createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#faf8f4;color:#22211f;padding:28px;margin:0">
          <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e5e0d5;padding-bottom:14px;margin-bottom:18px">
            <h2 style="margin:0;font-size:20px">atrium-notes · Local Dev Server</h2>
            <span style="padding:4px 10px;border-radius:99px;background:#e6f4ea;color:#1e7e34;font-size:12px;font-weight:600">HTTP 200 OK</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px">
            <div style="padding:14px;background:#fff;border:1px solid #e5e0d5;border-radius:10px"><div style="font-size:12px;color:#6c6a64">Indexed Docs</div><strong style="font-size:22px">128</strong></div>
            <div style="padding:14px;background:#fff;border:1px solid #e5e0d5;border-radius:10px"><div style="font-size:12px;color:#6c6a64">P95 Latency</div><strong style="font-size:22px">4.2 ms</strong></div>
            <div style="padding:14px;background:#fff;border:1px solid #e5e0d5;border-radius:10px"><div style="font-size:12px;color:#6c6a64">Sandbox MIC</div><strong style="font-size:22px">Low</strong></div>
          </div>
          <button style="padding:8px 14px;border-radius:8px;border:0;background:#c46342;color:#fff;font-weight:600">Run Health Check</button>
          <a href="#docs" style="margin-left:12px;color:#c46342">API Reference</a>
        </body></html>`)
      })
    : null
  try {
    let demoBrowserUrl = 'https://example.com'
    if (demoSrv) {
      await new Promise<void>((r) => demoSrv.listen(0, '127.0.0.1', r))
      const addr = demoSrv.address() as { port: number }
      demoBrowserUrl = `http://127.0.0.1:${addr.port}/`
    }
    if (live) {
      await runLive(win)
      return
    }
    await waitFor(win, '!document.querySelector(".splash")', 15_000)
    await wait(400)
    if (demo) {
      await runDemo(win, 'light', '', true, demoBrowserUrl)
      await runDemo(win, 'dark', '-dark', false, demoBrowserUrl)
      return
    }
    nativeTheme.themeSource = 'light'
    await wait(300)
    await shot(win, 'onboarding')
    await click(win, '.later')
    await shot(win, 'settings')
    await click(win, '.new-chat')
    await shot(win, 'chat-empty')
    await click(win, '[data-view="connections"]')
    await shot(win, 'connections')
    await click(win, '[data-view="market"]')
    await wait(4000) // live registry search
    await shot(win, 'market')
    nativeTheme.themeSource = 'dark'
    await click(win, '.new-chat')
    await wait(400)
    await shot(win, 'chat-empty-dark')
    await click(win, '[data-view="market"]')
    await shot(win, 'market-dark')
  } finally {
    demoSrv?.closeAllConnections?.()
    demoSrv?.close()
    nativeTheme.themeSource = 'system'
    app.quit()
  }
}
