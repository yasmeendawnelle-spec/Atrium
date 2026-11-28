import { useCallback, useEffect, useMemo, useRef } from 'react'
import { call } from '../lib/api.ts'
import { buildRhineArchiveCatalog } from '../lib/rhineArchiveData.ts'
import { setState, useStore } from '../lib/store.ts'
import { mountRhineArchiveStage, type MountedRhineArchive } from '../rhine-archive/mount-archive.ts'

interface Props {
  onClose: () => void
}

export function RhineArchiveMode({ onClose }: Props) {
  const chats = useStore((s) => s.chats)
  const conversations = useStore((s) => s.conversations)
  const live = useStore((s) => s.live)
  const plugins = useStore((s) => s.plugins)
  const skills = useStore((s) => s.skills)
  const memories = useStore((s) => s.memories)
  const knowledge = useStore((s) => s.knowledge)
  const servers = useStore((s) => s.servers)
  const statuses = useStore((s) => s.statuses)
  const automations = useStore((s) => s.automations)
  const platformAgents = useStore((s) => s.platformAgents)
  const platformSessions = useStore((s) => s.platformSessions)
  const sandboxInfo = useStore((s) => s.sandboxInfo)
  const activeChatId = useStore((s) => s.activeChatId)
  const settings = useStore((s) => s.settings)

  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<MountedRhineArchive | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const requestExitWithConfirm = useCallback(() => {
    if (stageRef.current) {
      stageRef.current.requestExit('confirm')
    } else {
      onCloseRef.current()
    }
  }, [])

  const catalog = useMemo(
    () =>
      buildRhineArchiveCatalog(
        {
          ready: true,
          view: 'chat',
          connectionsTab: 'mcp',
          navHistory: [],
          navIndex: 0,
          sidebarOpen: true,
          paletteOpen: false,
          fleetOpen: false,
          policyOpen: false,
          sessionImportOpen: false,
          settingsOpen: false,
          settingsSection: 'general',
          settings,
          providers: [],
          account: { origin: '', connected: true },
          accountModalOpen: false,
          servers,
          statuses,
          skills,
          plugins,
          activePluginTheme: null,
          archiveModeOpen: true,
          bootReplaySeq: 0,
          discoveredPlugins: [],
          pluginDiscoveryOpen: false,
          terminalSessions: [],
          activeTerminalId: null,
          terminalRequestedOpen: 0,
          automations,
          sandboxInfo,
          memories,
          knowledge,
          knowledgeTab: 'knowledge',
          browserSnapshot: null,
          browserSnapshotsByChat: {},
          browserRequestedOpen: 0,
          previewServers: [],
          chats,
          activeChatId,
          newChatUseWorktree: false,
          conversations,
          live,
          streams: {},
          unreadChats: {},
          queued: {},
          diffComments: {},
          drafts: {},
          sessionAllows: [],
          changesRevision: 0,
          update: null,
          updatePromptForced: false,
          snoozedUpdateKey: null,
          platformAgents,
          platformSessions,
          platformSessionsById: {},
          platformActiveSessionId: null,
          toast: null,
        },
        requestExitWithConfirm,
      ),
    [
      activeChatId,
      automations,
      chats,
      conversations,
      knowledge,
      live,
      memories,
      platformAgents,
      platformSessions,
      plugins,
      requestExitWithConfirm,
      sandboxInfo,
      servers,
      settings,
      skills,
      statuses,
    ],
  )

  const initialCatalogRef = useRef(catalog)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initialDark = document.documentElement.dataset.theme === 'dark'
    const mounted = mountRhineArchiveStage({
      host,
      initialDark,
      initialColumns: initialCatalogRef.current.columns,
      initialRecords: initialCatalogRef.current.records,
      onToggleTheme: (nextDark) => {
        const nextTheme = nextDark ? 'dark' : 'light'
        void call('settings.update', { theme: nextTheme })
          .then((updated) => setState({ settings: updated }))
          .catch(() => {
            document.documentElement.dataset.theme = nextTheme
          })
      },
      onCloseWorkspace: () => onCloseRef.current(),
    })
    stageRef.current = mounted

    const mo = new MutationObserver(() => {
      mounted.setDarkTheme(document.documentElement.dataset.theme === 'dark')
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      mo.disconnect()
      stageRef.current = null
      mounted.dispose()
    }
  }, [])

  useEffect(() => {
    stageRef.current?.updateCatalog(catalog.columns, catalog.records)
  }, [catalog])

  return <div ref={hostRef} className="rla-host" role="dialog" aria-modal="true" aria-label="Rhine Lab 3D Archive OS" />
}
