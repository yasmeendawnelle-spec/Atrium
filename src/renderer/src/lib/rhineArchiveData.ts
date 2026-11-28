import { isEmptyChatStub } from '@shared/types.ts'
import { openChat } from './chats.ts'
import { navigate, type State } from './store.ts'
import type { ArchiveRecord, AtriumDetailBlock } from '../rhine-archive/data.ts'

const SLOTS_PER_COLUMN = 8

const ARCHIVE_COLUMNS = [
  '对话档案',
  '插件与主题',
  '技能与记忆',
  'MCP 连接器',
  '自动化与内核',
] as const

function fmtTimestamp(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '2026-SYS'
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${min}`
}

function shortPath(p: string | undefined): string {
  if (!p) return 'GLOBAL WORKSPACE'
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function makeCode(prefix: string, num: number): string {
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function padColumnRecords(
  columnName: string,
  prefix: string,
  existing: ArchiveRecord[],
  templates: Array<{
    title: string
    en: string
    department: string
    clearance: string
    abstract: string
    findings: string[]
    detailBlocks: AtriumDetailBlock[]
    logs: string[]
    actionLabel: string
    openAction: () => Promise<void> | void
  }>,
): ArchiveRecord[] {
  const out = [...existing].slice(0, SLOTS_PER_COLUMN)
  let tIdx = 0
  while (out.length < SLOTS_PER_COLUMN && templates.length > 0) {
    const tpl = templates[tIdx % templates.length]!
    const num = out.length + 1
    const code = makeCode(prefix, num)
    out.push({
      id: code,
      code,
      title: tpl.title,
      en: tpl.en,
      department: tpl.department,
      category: columnName,
      date: 'ARCHIVE v4.0',
      lead: 'RHINE LAB SPEC',
      clearance: tpl.clearance,
      abstract: tpl.abstract,
      findings: tpl.findings,
      source: 'RHINE LAB // ATRIUM',
      statusLabel: tpl.clearance,
      isLive: false,
      detailBlocks: tpl.detailBlocks,
      logs: tpl.logs,
      actionLabel: tpl.actionLabel,
      openAction: tpl.openAction,
    })
    tIdx += 1
  }
  return out
}

/**
 * Projects Master's live Atrium Store state into the exact 5-column x 8-row (40-record)
 * schema expected by LBEILC/RhineLabUI's 3D CAD ArchiveScene & Detail UI.
 */
export function buildRhineArchiveCatalog(
  state: State,
  onExitArchive: () => void,
): { columns: string[]; records: ArchiveRecord[] } {
  const busyIds = new Set(
    Object.entries(state.live)
      .filter(([, turn]) => turn.busy)
      .map(([id]) => id),
  )

  // Column 01: 对话档案
  const realChats = [...state.chats]
    .filter((c) => !isEmptyChatStub(c, busyIds.has(c.id)) && !c.archived)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
    .slice(0, SLOTS_PER_COLUMN)

  const convLive: ArchiveRecord[] = realChats.map((c, idx) => {
    const loadedConv = state.conversations[c.id]
    const wsName = shortPath(c.worktreeBaseWorkspace ?? c.workspace)
    const isBusy = busyIds.has(c.id)
    const firstAssistant = loadedConv?.messages.find(
      (m): m is Extract<(typeof loadedConv.messages)[number], { role: 'assistant' }> =>
        m.role === 'assistant' && Boolean(m.text.trim()),
    )
    const code = makeCode('C', idx + 1)
    const summaryText = firstAssistant
      ? firstAssistant.text.replace(/```[\s\S]*?```/g, '[CODE]').replace(/\s+/g, ' ').trim().slice(0, 150)
      : `工作区 ${wsName} 的实时对话档案，包含完整的上下文推理链路与工具执行记录。`

    const detailBlocks: AtriumDetailBlock[] = loadedConv?.messages.length
      ? loadedConv.messages.slice(-4).map((m, mi) => ({
          heading: `${String(mi + 1).padStart(2, '0')} // ${m.role.toUpperCase()}`,
          body:
            m.role === 'tool'
              ? `[TOOL: ${m.name}] ${m.output.slice(0, 220)}`
              : m.text.trim() || '[STRUCTURED MESSAGE]',
        }))
      : [
          {
            heading: '01 // 会话摘要',
            body: `所属工作区路径：${c.workspace || '默认工作区'}。点击下方“在工作台打开对话”即可立即恢复此会话并继续交互。`,
          },
        ]

    return {
      id: code,
      code,
      title: c.title?.trim() || '未命名终端会话',
      en: `${wsName.toUpperCase()} // SESSION TRACE`,
      department: '对话档案 // CONVERSATIONS',
      category: ARCHIVE_COLUMNS[0],
      date: fmtTimestamp(c.updatedAt),
      lead: c.importedFrom?.sourceLabel || (c.pinned ? 'PINNED SESSION' : 'ATRIUM CHAT'),
      clearance: isBusy ? 'STREAMING' : 'VERIFIED',
      abstract: summaryText,
      findings: detailBlocks.map((b) => `${b.heading}：${b.body.slice(0, 96)}`),
      source: wsName,
      statusLabel: isBusy ? 'STREAMING' : 'VERIFIED',
      isLive: true,
      chatId: c.id,
      detailBlocks,
      logs: [
        `[${fmtTimestamp(c.createdAt)}] ARCHIVE INITIALIZED (${c.id})`,
        `[${fmtTimestamp(c.updatedAt)}] LAST TELEMETRY SYNC COMPLETE`,
      ],
      actionLabel: '在工作台打开对话 →',
      openAction: async () => {
        await openChat(c.id)
        onExitArchive()
      },
    }
  })

  const col0 = padColumnRecords(ARCHIVE_COLUMNS[0], 'C', convLive, [
    {
      title: '哥伦比亚轨道通信基准协议',
      en: 'ORBITAL TELEMETRY PROTOCOL',
      department: '对话档案 // CONVERSATIONS',
      clearance: 'SPEC LOCKED',
      abstract: '定义多模型协同会话的遥测校验格式、工具审批流与上下文压缩基线。',
      findings: ['支持本地事件总线异步持久化', '支持 Plan ↔ Execute 双相交接与工作区隔离'],
      detailBlocks: [{ heading: '01 // 协议说明', body: '所有实时对话均在本地异步落盘，并实时映射至 3D 档案阵列中。' }],
      logs: ['ARCHIVE INDEX CALIBRATED', 'TELEMETRY HANDSHAKE STANDBY'],
      actionLabel: '前往标准对话台 →',
      openAction: () => {
        navigate({ view: 'chat', chatId: state.activeChatId })
        onExitArchive()
      },
    },
    {
      title: '高能结构工程检索模板',
      en: 'STRUCTURAL WORKTREE TRACE',
      department: '对话档案 // CONVERSATIONS',
      clearance: 'GENERAL USE',
      abstract: '用于代码审查、仓库语义索引与多分支 Worktree 自动化测试的协同指令档案。',
      findings: ['Git Worktree 并发隔离执行', '自动化 Diff 审查与回归门禁'],
      detailBlocks: [{ heading: '01 // 能力概览', body: '返回标准工作台后可通过 Ctrl+N 随时开启新的工程协同会话。' }],
      logs: ['WORKTREE ADAPTER READY', 'TEMPLATE SEALED'],
      actionLabel: '前往标准对话台 →',
      openAction: () => {
        navigate({ view: 'chat', chatId: state.activeChatId })
        onExitArchive()
      },
    },
  ])

  // Column 02: 插件与主题
  const pluginLive: ArchiveRecord[] = state.plugins.slice(0, SLOTS_PER_COLUMN).map((p, idx) => {
    const code = makeCode('P', idx + 1)
    return {
      id: code,
      code,
      title: p.displayName || p.name,
      en: `${(p.originLabel || p.origin).toUpperCase()} // v${p.version || '1.0.0'}`,
      department: '插件与主题 // PLUGINS',
      category: ARCHIVE_COLUMNS[1],
      date: fmtTimestamp(p.updatedAt),
      lead: p.author || p.originLabel || 'LOCAL BUNDLE',
      clearance: p.enabled ? 'ENABLED' : 'STANDBY',
      abstract: p.description || '已装配的 Atrium 插件扩展包，包含自定义技能、主题光学配置或 MCP 桥接服务。',
      findings: [
        `贡献技能：${p.skillNames.join(', ') || '无'}`,
        `规则文件：${p.ruleFiles.join(', ') || '无'}`,
        `主题 / 开机动画：${p.hasTheme ? (p.hasBootAnimation ? '全套主题 + 开机 PV' : '全套主题') : '标准扩展'}`,
      ],
      source: p.installDir,
      statusLabel: p.enabled ? 'ENABLED' : 'STANDBY',
      isLive: true,
      detailBlocks: [
        {
          heading: '01 // 安装清单',
          body: `安装路径：${p.installDir}\n版本：${p.version || '1.0.0'}\n贡献技能：${p.skillNames.join(', ') || '无'}`,
        },
        {
          heading: '02 // 安全边界',
          body: '插件主题 CSS 经过严格净洗，3D 档案阵列以真实 CAD 模型与 WebGL2 着色器隔离运行。',
        },
      ],
      logs: [
        `[${fmtTimestamp(p.installedAt)}] INSTALLED FROM ${p.originLabel || p.origin}`,
        `[${fmtTimestamp(p.updatedAt)}] STATE=${p.enabled ? 'ACTIVE' : 'DISABLED'}`,
      ],
      actionLabel: '在插件面板管理 →',
      openAction: () => {
        navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
        onExitArchive()
      },
    }
  })

  const col1 = padColumnRecords(ARCHIVE_COLUMNS[1], 'P', pluginLive, [
    {
      title: 'Rhine Lab 光学档案套件 v4.0',
      en: 'RHINE LAB ARCHIVE OPTICAL MODULE',
      department: '插件与主题 // PLUGINS',
      clearance: 'CERTIFIED',
      abstract: 'Lucas Qiu 监制的莱茵生命光学档案套件：高精度 CAD 晶体卡盒、SharedDepthAO 与 6 层物理拆解视图。',
      findings: ['亚克力 IOR 1.46 真实折射率传递', '6 层装配结构独立 360° 审视与一键拆解'],
      detailBlocks: [{ heading: '01 // 光学渲染参数', body: '集成 RoomEnvironment 环境光、SharedDepthAO 环境光遮蔽与焦外景深后处理。' }],
      logs: ['OPTICAL CAD GLB MOUNTED', 'PLUGIN ENGINE VERIFIED'],
      actionLabel: '浏览插件市场 →',
      openAction: () => {
        navigate({ view: 'market', chatId: null })
        onExitArchive()
      },
    },
  ])

  // Column 03: 技能与记忆
  const skillRecords: ArchiveRecord[] = state.skills.slice(0, 5).map((sk, idx) => {
    const code = makeCode('K', idx + 1)
    return {
      id: code,
      code,
      title: sk.name,
      en: `${sk.scope.toUpperCase()} SKILL // ${sk.source || 'BUILT-IN'}`,
      department: '技能与记忆 // SKILLS & MEMORY',
      category: ARCHIVE_COLUMNS[2],
      date: 'SKILL REGISTRY',
      lead: sk.pluginName || sk.source || 'ATRIUM',
      clearance: sk.enabled ? 'ACTIVE' : 'MUTED',
      abstract: sk.description || '已注册的智能体工作流技能规范，可在任务触发时自动加载执行指引。',
      findings: [
        `作用域：${sk.scope}`,
        `附加资源：${sk.hasScripts || sk.hasReferences ? '含脚本 / 参考资料' : '纯指令规范'}`,
      ],
      source: sk.path,
      statusLabel: sk.enabled ? 'ACTIVE' : 'MUTED',
      isLive: true,
      detailBlocks: [
        { heading: '01 // 能力说明', body: sk.description || '无附加描述。' },
        { heading: '02 // 文件路径', body: sk.path },
      ],
      logs: [`SKILL REGISTERED (${sk.name})`, `ENABLED=${sk.enabled ? 'TRUE' : 'FALSE'}`],
      actionLabel: '在技能库中查看 →',
      openAction: () => {
        navigate({ view: 'connections', chatId: null, connectionsTab: 'skills' })
        onExitArchive()
      },
    }
  })

  const memRecords: ArchiveRecord[] = state.memories
    .slice(0, Math.max(0, SLOTS_PER_COLUMN - skillRecords.length))
    .map((m, idx) => {
      const n = skillRecords.length + idx + 1
      const code = makeCode('K', n)
      return {
        id: code,
        code,
        title: m.content.slice(0, 34) + (m.content.length > 34 ? '…' : ''),
        en: `MEMORY ENTRY // ${m.category.toUpperCase()}`,
        department: '长期记忆 // MEMORY BANK',
        category: ARCHIVE_COLUMNS[2],
        date: fmtTimestamp(m.updatedAt),
        lead: shortPath(m.workspace),
        clearance: m.pinned ? 'PINNED' : 'STORED',
        abstract: m.content,
        findings: [`分类：${m.category}`, `作用域：${m.scope}`, `工作区：${shortPath(m.workspace)}`],
        source: shortPath(m.workspace),
        statusLabel: 'STORED',
        isLive: true,
        detailBlocks: [{ heading: '01 // 完整记忆内容', body: m.content }],
        logs: [`[${fmtTimestamp(m.createdAt)}] MEMORY EXTRACTED`, `[${fmtTimestamp(m.updatedAt)}] INDEX VERIFIED`],
        actionLabel: '打开知识与记忆库 →',
        openAction: () => {
          navigate({ view: 'knowledge', chatId: null })
          onExitArchive()
        },
      }
    })

  const col2 = padColumnRecords(ARCHIVE_COLUMNS[2], 'K', [...skillRecords, ...memRecords], [
    {
      title: '本地语义向量知识基底',
      en: 'VECTOR KNOWLEDGE SUBSTRATE',
      department: '技能与记忆 // SKILLS & MEMORY',
      clearance: 'INDEXED',
      abstract: '持久化用户偏好记忆矩阵与本地文档 RAG 切片索引，支撑跨会话精准检索。',
      findings: [
        `记忆条目：${state.memories.length} 条`,
        `知识库文档：${state.knowledge?.sourceCount ?? 0} 份（${state.knowledge?.chunkCount ?? 0} 切片）`,
      ],
      detailBlocks: [{ heading: '01 // 检索系统', body: '全部记忆与本地文档均保留在本地沙盒，随时可在工作台编辑与置顶。' }],
      logs: ['KNOWLEDGE INDEX ONLINE', 'MEMORY CONSOLIDATION PASS'],
      actionLabel: '打开知识与记忆面板 →',
      openAction: () => {
        navigate({ view: 'knowledge', chatId: null })
        onExitArchive()
      },
    },
  ])

  // Column 04: MCP 连接器
  const mcpLive: ArchiveRecord[] = state.servers.slice(0, SLOTS_PER_COLUMN).map((srv, idx) => {
    const st = state.statuses[srv.id]
    const stateStr = st?.state ?? (srv.enabled ? 'idle' : 'disabled')
    const toolCount = st?.tools?.length ?? 0
    const code = makeCode('M', idx + 1)
    return {
      id: code,
      code,
      title: srv.name,
      en: `${srv.transport.toUpperCase()} CONNECTOR // ${toolCount} TOOLS`,
      department: 'MCP 连接器 // CONNECTIONS',
      category: ARCHIVE_COLUMNS[3],
      date: st?.state === 'connected' ? 'CONNECTED LIVE' : 'REGISTERED',
      lead: srv.source?.ref || srv.source?.kind?.toUpperCase() || 'MCP',
      clearance: stateStr.toUpperCase(),
      abstract: srv.url || (srv.command ? `${srv.command} ${(srv.args ?? []).join(' ')}` : '外部 Model Context Protocol 工具服务节点。'),
      findings: [
        `传输协议：${srv.transport.toUpperCase()}`,
        `工具列表：${st?.tools?.map((t) => t.name).slice(0, 8).join(', ') || '连接后自动发现'}`,
      ],
      source: srv.url || srv.command || 'STDIO PIPE',
      statusLabel: stateStr.toUpperCase(),
      isLive: true,
      detailBlocks: [
        {
          heading: '01 // 连接诊断',
          body: st?.error
            ? `最近错误：${st.error}`
            : `服务运行正常，已注册 ${toolCount} 个可用工具。`,
        },
      ],
      logs: [`TRANSPORT=${srv.transport.toUpperCase()}`, `STATE=${stateStr.toUpperCase()}`],
      actionLabel: '管理 MCP 连接 →',
      openAction: () => {
        navigate({ view: 'connections', chatId: null, connectionsTab: 'mcp' })
        onExitArchive()
      },
    }
  })

  const col3 = padColumnRecords(ARCHIVE_COLUMNS[3], 'M', mcpLive, [
    {
      title: '外部工具协议网关 // MCP BUS',
      en: 'MODEL CONTEXT PROTOCOL GATEWAY',
      department: 'MCP 连接器 // CONNECTIONS',
      clearance: 'PROTOCOL READY',
      abstract: '标准化的外部工具、数据源与浏览器自动化网关，支持密钥隔离托管与健康探测。',
      findings: [
        '支持 STDIO / SSE / Streamable HTTP 传输',
        `当前活跃连接：${Object.values(state.statuses).filter((x) => x.state === 'connected').length} 个节点`,
      ],
      detailBlocks: [{ heading: '01 // 网关说明', body: '可在工作台连接管理页面粘贴任意 MCP JSON 或从 GitHub 自动发现配置。' }],
      logs: ['MCP SUPERVISOR READY', 'KEYCHAIN ADAPTER VERIFIED'],
      actionLabel: '打开连接管理 →',
      openAction: () => {
        navigate({ view: 'connections', chatId: null, connectionsTab: 'mcp' })
        onExitArchive()
      },
    },
  ])

  // Column 05: 自动化与内核
  const autoLive: ArchiveRecord[] = state.automations.slice(0, 5).map((a, idx) => {
    const code = makeCode('S', idx + 1)
    return {
      id: code,
      code,
      title: a.name,
      en: a.schedule.kind === 'cron' ? `CRON // ${a.schedule.expr}` : `INTERVAL // EVERY ${a.schedule.minutes}M`,
      department: '自动化与内核 // AUTOMATIONS & OS',
      category: ARCHIVE_COLUMNS[4],
      date: fmtTimestamp(a.lastRunAt ?? a.updatedAt),
      lead: shortPath(a.workspace),
      clearance: (a.lastStatus ?? (a.enabled ? 'ARMED' : 'PAUSED')).toUpperCase(),
      abstract: a.prompt.slice(0, 160),
      findings: [
        `调度策略：${a.schedule.kind === 'cron' ? a.schedule.expr : `每 ${a.schedule.minutes} 分钟`}`,
        `执行模式：${(a.agentMode ?? 'auto').toUpperCase()}`,
      ],
      source: shortPath(a.workspace),
      statusLabel: (a.lastStatus ?? (a.enabled ? 'ARMED' : 'PAUSED')).toUpperCase(),
      isLive: true,
      detailBlocks: [
        { heading: '01 // 调度指令内容', body: a.prompt },
        ...(a.lastSummary ? [{ heading: '02 // 最近执行摘要', body: a.lastSummary }] : []),
      ],
      logs: [
        `CREATED=${fmtTimestamp(a.createdAt)}`,
        a.lastRunAt ? `LAST_RUN=${fmtTimestamp(a.lastRunAt)} STATUS=${a.lastStatus ?? 'DONE'}` : 'NEXT_RUN SCHEDULED',
      ],
      actionLabel: '打开自动化调度 →',
      openAction: () => {
        navigate({ view: 'automations', chatId: null })
        onExitArchive()
      },
    }
  })

  const col4 = padColumnRecords(ARCHIVE_COLUMNS[4], 'S', autoLive, [
    {
      title: 'RHINE LAB // ANALYSIS OS',
      en: 'SPEC.NO // RL-X-001',
      department: '自动化与内核 // AUTOMATIONS & OS',
      clearance: 'OPERATIONAL',
      abstract: '莱茵生命实验室分析终端操作系统档案：双极性光学界面、高精度实体卡盒阵列与 6 层装配拆解系统。',
      findings: [
        '工作台模式与 3D 档案提取模式随时双态热切换',
        '360° 装配结构：紧固件 / 透明盖板 / 折射环组 / 光学核心 / 信息基板 / 背板与框架',
      ],
      detailBlocks: [
        {
          heading: '01 // 双模式系统架构',
          body: '所有 3D 卡盒均实时投影自当前桌面端中的真实会话、插件、技能与连接数据，同时致敬 LBEILC/RhineLabUI（MIT）美学与交互结构。',
        },
      ],
      logs: ['COORDINATES TRIMOUNT // LOCKED', 'OPTICAL MATRIX INTEGRITY 100%'],
      actionLabel: '打开 Atrium Platform →',
      openAction: () => {
        navigate({ view: 'platform', chatId: null })
        onExitArchive()
      },
    },
    {
      title: 'ATRIUM PLATFORM // 多智能体编排台',
      en: 'MULTI-AGENT ORCHESTRATION DECK',
      department: '自动化与内核 // AUTOMATIONS & OS',
      clearance: 'ONLINE',
      abstract: '多智能体编排指挥台与 CLI / Desktop 协同总线，支持实时子代理拓扑与隔离执行。',
      findings: [
        `已注册代理：${state.platformAgents.length} 个`,
        `活跃编排流：${state.platformSessions.length} 个`,
      ],
      detailBlocks: [{ heading: '01 // 平台状态', body: '可在工作台直观监控并向各代理下发编排指令。' }],
      logs: ['PLATFORM DAEMON SYNCED', 'SANDBOX CAPABILITIES VERIFIED'],
      actionLabel: '进入 Platform 指挥台 →',
      openAction: () => {
        navigate({ view: 'platform', chatId: null })
        onExitArchive()
      },
    },
  ])

  return {
    columns: [...ARCHIVE_COLUMNS],
    records: [...col0, ...col1, ...col2, ...col3, ...col4],
  }
}
