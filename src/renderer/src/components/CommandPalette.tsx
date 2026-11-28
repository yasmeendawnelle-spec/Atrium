import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FolderInput, FolderOpen, GitCompareArrows, GitFork, MessageSquare, Minimize2, Moon, Network, Package, Plug, Plus, RefreshCw, RotateCw, Search, Settings, ShieldCheck, Sparkles, Store, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isEmptyChatStub } from '@shared/types.ts'
import { resolveOrchestratorExecutor, shortModelLabel } from '@shared/orchestrator.ts'
import { call, shell } from '../lib/api.ts'
import { compactChat, newChat, openChat } from '../lib/chats.ts'
import { checkForUpdates, installAppUpdate, navigate, openFleetModal, openPolicyModal, openSessionImportModal, openSettings, setState, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { folderName, setWorkspace } from './WorkspacePicker.tsx'

interface PaletteItem {
  id: string
  group: 'action' | 'chat' | 'model' | 'workspace'
  label: string
  sub?: string
  icon: typeof Plus
  active?: boolean
  run: () => void | Promise<void>
}

export function CommandPalette() {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const open = useStore((s) => s.paletteOpen)
  const chats = useStore((s) => s.chats)
  const live = useStore((s) => s.live)
  const activeChatId = useStore((s) => s.activeChatId)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.update)
  const conversations = useStore((s) => s.conversations)
  const activeConv = activeChatId ? conversations[activeChatId] : undefined

  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = () => setState({ paletteOpen: false })

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIdx(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = []
    if (update?.status === 'downloaded') {
      out.push({
        id: 'act:upgrade',
        group: 'action',
        label: t('updates.restartToUpgrade'),
        sub: update.version ? `v${update.version}` : undefined,
        icon: RotateCw,
        active: true,
        run: () => void installAppUpdate(),
      })
    }
    out.push(
      {
        id: 'act:new',
        group: 'action',
        label: t('nav.newChat'),
        sub: 'Ctrl+N',
        icon: Plus,
        run: () => void newChat(),
      },
      {
        id: 'act:window',
        group: 'action',
        label: t('nav.newWindow'),
        icon: ExternalLink,
        run: () => void shell.newWindow(),
      },
    )
    if (activeChatId && (activeConv?.messages.length ?? 0) >= 4) {
      out.push({
        id: 'act:compact',
        group: 'action',
        label: t('chat.compact'),
        sub: '/compact',
        icon: Minimize2,
        run: async () => {
          toast(t('chat.compacting'))
          await compactChat(activeChatId)
          toast(t('chat.compactDone'))
        },
      })
    }
    const isDark = document.documentElement.dataset.theme === 'dark'
    out.push(
      {
        id: 'act:theme',
        group: 'action',
        label: isDark ? t('settings.themeLight') : t('settings.themeDark'),
        icon: isDark ? Sun : Moon,
        run: async () => setState({ settings: await call('settings.update', { theme: isDark ? 'light' : 'dark' }) }),
      },
      {
        id: 'act:conn',
        group: 'action',
        label: t('nav.connections'),
        icon: Plug,
        run: () => navigate({ view: 'connections', chatId: null }),
      },
      {
        id: 'act:plugins',
        group: 'action',
        label: t('plugins.tab'),
        icon: Package,
        run: () => navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' }),
      },
      {
        id: 'act:market',
        group: 'action',
        label: t('nav.marketplace'),
        icon: Store,
        run: () => navigate({ view: 'market', chatId: null }),
      },
      {
        id: 'act:settings',
        group: 'action',
        label: t('nav.settings'),
        sub: 'Ctrl+,',
        icon: Settings,
        run: () => openSettings('general'),
      },
      {
        id: 'act:orchestrator',
        group: 'action',
        label: ft('orchestrator.title'),
        sub: (() => {
          const on = settings?.orchestratorEnabled === true
          if (!on) return ft('orchestrator.off')
          const activeP = providers.find((p) => p.id === (settings?.activeProviderId ?? providers[0]?.id)) ?? providers[0]
          if (!activeP) return ft('orchestrator.on')
          const resolved = resolveOrchestratorExecutor(providers, activeP, settings ?? {})
          return `${shortModelLabel(activeP.model)} → ${shortModelLabel(resolved.model)}`
        })(),
        icon: GitCompareArrows,
        active: settings?.orchestratorEnabled === true,
        run: async () => {
          const next = !(settings?.orchestratorEnabled === true)
          setState({ settings: await call('settings.update', { orchestratorEnabled: next }) })
        },
      },
      {
        id: 'act:ultracode',
        group: 'action',
        label: 'Ultracode',
        sub: settings?.ultracode === true ? t('ultracode.on') : t('ultracode.off'),
        icon: Sparkles,
        active: settings?.ultracode === true,
        run: async () => {
          const next = !(settings?.ultracode === true)
          setState({ settings: await call('settings.update', { ultracode: next }) })
        },
      },
      {
        id: 'act:fleet',
        group: 'action',
        label: ft('fleet.navLabel'),
        sub: 'Worktrees',
        icon: GitFork,
        run: () => openFleetModal(),
      },
      {
        id: 'act:platform',
        group: 'action',
        label: ft('platform.paletteLabel'),
        sub: ft('platform.paletteSub'),
        icon: Network,
        run: () => navigate({ view: 'platform', chatId: null }),
      },
      {
        id: 'act:policy',
        group: 'action',
        label: ft('policy.navLabel'),
        sub: '.atrium/policy.json',
        icon: ShieldCheck,
        run: () => openPolicyModal(),
      },
      {
        id: 'act:import-sessions',
        group: 'action',
        label: ft('sessionImport.paletteLabel'),
        sub: 'Claude Code · Codex · DSH · Cursor · Antigravity',
        icon: FolderInput,
        run: () => openSessionImportModal(),
      },
      {
        id: 'act:check-updates',
        group: 'action',
        label: t('updates.check'),
        icon: RefreshCw,
        run: () => {
          openSettings('system')
          void checkForUpdates()
        },
      },
    )

    for (const c of chats.filter((m) => !isEmptyChatStub(m, Boolean(live[m.id]?.busy))).slice(0, 12)) {
      out.push({
        id: `chat:${c.id}`,
        group: 'chat',
        label: c.title || t('chat.untitled'),
        sub: c.workspace ? folderName(c.workspace) : undefined,
        icon: MessageSquare,
        active: c.id === activeChatId,
        run: () => void openChat(c.id),
      })
    }

    const activeProviderId = settings?.activeProviderId ?? providers[0]?.id
    for (const p of providers) {
      const list = p.models?.length ? p.models : [p.model]
      for (const model of list.filter(Boolean)) {
        out.push({
          id: `prov:${p.id}:${model}`,
          group: 'model',
          label: model || p.name,
          sub: p.name,
          icon: Sparkles,
          active: p.id === activeProviderId && model === p.model,
          run: async () => setState(await call('providers.selectModel', p.id, model)),
        })
      }
    }

    const activeMeta = activeChatId ? chats.find((c) => c.id === activeChatId) : undefined
    for (const ws of settings?.recentWorkspaces ?? []) {
      const activeLocked = Boolean(
        activeChatId &&
          ((activeConv?.messages.length ?? activeMeta?.messageCount ?? 0) > 0 ||
            Boolean(activeConv?.worktreeBranch ?? activeMeta?.worktreeBranch) ||
            Boolean(activeConv?.workspace ?? activeMeta?.workspace)),
      )
      out.push({
        id: `ws:${ws}`,
        group: 'workspace',
        label: folderName(ws) ?? ws,
        sub: ws,
        icon: FolderOpen,
        active: ws === settings?.workspace,
        run: () => void (activeLocked ? newChat(ws) : setWorkspace(ws)),
      })
    }

    const q = query.trim().toLowerCase()
    if (!q) return out
    return out.filter((item) => item.label.toLowerCase().includes(q) || (item.sub && item.sub.toLowerCase().includes(q)))
  }, [open, query, chats, live, activeChatId, activeConv, providers, settings, update, t])

  useEffect(() => {
    if (idx >= items.length) setIdx(0)
  }, [items.length, idx])

  if (!open) return null

  const activate = (item: PaletteItem | undefined) => {
    if (!item) return
    close()
    void item.run()
  }

  const groupLabel: Record<PaletteItem['group'], string> = {
    action: t('palette.groupActions'),
    chat: t('palette.groupChats'),
    model: t('palette.groupModels'),
    workspace: t('palette.groupWorkspaces'),
  }

  let lastGroup: PaletteItem['group'] | null = null

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.commandPalette')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (e.key === 'ArrowDown' && items.length > 0) {
            e.preventDefault()
            setIdx((i) => (i + 1) % items.length)
          } else if (e.key === 'ArrowUp' && items.length > 0) {
            e.preventDefault()
            setIdx((i) => (i - 1 + items.length) % items.length)
          } else if (e.key === 'Enter' && items.length > 0) {
            e.preventDefault()
            activate(items[idx])
          }
        }}
      >
        <div className="palette-search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIdx(0)
            }}
            placeholder={t('palette.placeholder')}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </div>
        <div className="palette-list">
          {items.length === 0 ? (
            <div className="palette-empty">{t('palette.empty')}</div>
          ) : (
            items.map((item, i) => {
              const Icon = item.icon
              const showGroup = item.group !== lastGroup
              lastGroup = item.group
              return (
                <div key={item.id}>
                  {showGroup && <div className="palette-group">{groupLabel[item.group]}</div>}
                  <button
                    type="button"
                    className={`palette-item${i === idx ? ' selected' : ''}${item.active ? ' current' : ''}`}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => activate(item)}
                  >
                    <Icon size={14} className="palette-icon" />
                    <span className="palette-label">{item.label}</span>
                    {item.sub && <span className="palette-sub">{item.sub}</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <footer className="palette-foot">{t('palette.hint')}</footer>
      </div>
    </div>,
    document.body,
  )
}
