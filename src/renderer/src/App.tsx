import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { applyLocale } from './i18n.ts'
import { errorMessage, shell } from './lib/api.ts'
import { startColumnResize } from './lib/resize.ts'
import { getState, goBack, goForward, handleCoreEvent, loadAll, requestOpenTerminalDrawer, scanLocalPlugins, setState, toggleSidebar, useStore } from './lib/store.ts'
import { Sidebar } from './components/Sidebar.tsx'
import { TopBar } from './components/TopBar.tsx'
import { UpdatePrompt } from './components/UpdatePrompt.tsx'
import { AccountGateView, AccountModal } from './components/AccountPanel.tsx'
import { Oculus } from './components/Oculus.tsx'
import { newChat, stopChat } from './lib/chats.ts'
import { ChatView } from './views/ChatView.tsx'

const CommandPalette = lazy(() => import('./components/CommandPalette.tsx').then((m) => ({ default: m.CommandPalette })))
const FleetModal = lazy(() => import('./components/FleetModal.tsx').then((m) => ({ default: m.FleetModal })))
const PolicyModal = lazy(() => import('./components/PolicyModal.tsx').then((m) => ({ default: m.PolicyModal })))
const PluginDiscoveryModal = lazy(() => import('./components/PluginDiscoveryModal.tsx').then((m) => ({ default: m.PluginDiscoveryModal })))
const AutomationsView = lazy(() => import('./views/AutomationsView.tsx').then((m) => ({ default: m.AutomationsView })))
const ConnectionsView = lazy(() => import('./views/ConnectionsView.tsx').then((m) => ({ default: m.ConnectionsView })))
const KnowledgeView = lazy(() => import('./views/KnowledgeView.tsx').then((m) => ({ default: m.KnowledgeView })))
const MarketView = lazy(() => import('./views/MarketView.tsx').then((m) => ({ default: m.MarketView })))
const SettingsModal = lazy(() => import('./views/SettingsView.tsx').then((m) => ({ default: m.SettingsModal })))
const Onboarding = lazy(() => import('./views/Onboarding.tsx').then((m) => ({ default: m.Onboarding })))

const SIDEBAR_WIDTH_KEY = 'atrium.sidebar.width'
const DEFAULT_SIDEBAR_WIDTH = 294

function minSidebarWidth(): number {
  if (typeof document !== 'undefined' && document.documentElement.dataset.platform === 'mac') return 276
  return 244
}

function maxSidebarWidth(): number {
  if (typeof window === 'undefined') return 420
  return Math.min(460, Math.max(300, Math.round(window.innerWidth * 0.36)))
}

function clampSidebarWidth(w: number): number {
  return Math.max(minSidebarWidth(), Math.min(maxSidebarWidth(), Math.round(w)))
}

function loadSavedSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const n = raw ? Number.parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? clampSidebarWidth(n) : DEFAULT_SIDEBAR_WIDTH
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

function useTheme(theme: 'system' | 'light' | 'dark' | undefined) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || ((theme ?? 'system') === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      shell.setTitleBarTheme(dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}

export function App() {
  const { t } = useTranslation()
  const ready = useStore((s) => s.ready)
  const settings = useStore((s) => s.settings)
  const account = useStore((s) => s.account)
  const view = useStore((s) => s.view)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const fleetOpen = useStore((s) => s.fleetOpen)
  const policyOpen = useStore((s) => s.policyOpen)
  const pluginDiscoveryOpen = useStore((s) => s.pluginDiscoveryOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toast = useStore((s) => s.toast)
  const loadError = useStore((s) => (s.ready ? null : s.toast?.text))
  const scannedPluginsRef = useRef(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSavedSidebarWidth)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarDragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const onResize = () => setSidebarWidth((prev) => clampSidebarWidth(prev))
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      sidebarDragCleanupRef.current?.()
    }
  }, [])

  useEffect(() => {
    document.body.classList.toggle('is-resizing-sidebar', resizingSidebar)
    return () => document.body.classList.remove('is-resizing-sidebar')
  }, [resizingSidebar])

  const startSidebarResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !sidebarOpen) return
    e.preventDefault()
    sidebarDragCleanupRef.current?.()
    sidebarDragCleanupRef.current = startColumnResize({
      event: e,
      startWidth: sidebarWidth,
      computeWidth: (base, deltaX) => clampSidebarWidth(base + deltaX),
      onStart: () => setResizingSidebar(true),
      onMove: (w) => setSidebarWidth(w),
      onEnd: (finalWidth) => {
        sidebarDragCleanupRef.current = null
        setResizingSidebar(false)
        try {
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(finalWidth))
        } catch {
          /* ignore storage error */
        }
      },
    })
  }

  const resetSidebarWidth = () => {
    const def = clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    setSidebarWidth(def)
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(def))
    } catch {
      /* ignore storage error */
    }
  }

  useEffect(() => {
    document.documentElement.dataset.platform = navigator.userAgent.includes('Mac') ? 'mac' : 'other'
    const off = window.atrium.onEvent(handleCoreEvent)
    loadAll().catch((err) => setState({ toast: { id: 0, text: errorMessage(err), tone: 'error' } }))
    return off
  }, [])

  useEffect(() => {
    if (!ready || !settings?.onboarded || scannedPluginsRef.current) return
    scannedPluginsRef.current = true
    void scanLocalPlugins({ autoPrompt: true, workspace: settings.workspace })
  }, [ready, settings?.onboarded, settings?.workspace])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setState((s) => ({ paletteOpen: !s.paletteOpen }))
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newChat()
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault()
        requestOpenTerminalDrawer()
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setState((s) => ({
          settingsOpen: !s.settingsOpen,
          settingsSection: s.settingsOpen ? s.settingsSection : 'general',
          paletteOpen: false,
        }))
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        void goBack()
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        void goForward()
      } else if (e.key === 'Escape') {
        const s = getState()
        if (s.paletteOpen || document.querySelector('[role="dialog"], .ctx-menu, .mention-popover, .open > .model-popover, .open > .tools-popover, .open > .workspace-popover, .open > .perm-popover, .open > .context-popover, .open > .plus-popover')) return
        const id = s.activeChatId
        if (id && s.live[id]?.busy) void stopChat(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useTheme(settings?.theme)
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    root.dataset.transcriptWidth = settings.transcriptWidth ?? 'default'
    root.dataset.codeThemeLight = settings.codeThemeLight ?? 'atrium'
    root.dataset.codeThemeDark = settings.codeThemeDark ?? 'atrium'
    root.style.setProperty('--code-size', `${settings.codeFontSize ?? 13}px`)
    const font = settings.codeFont?.replace(/[;"'\\]/g, '').trim()
    if (font) {
      root.style.setProperty('--font-code', `'${font}', 'IBM Plex Mono', 'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace`)
    } else {
      root.style.removeProperty('--font-code')
    }
  }, [settings?.transcriptWidth, settings?.codeThemeLight, settings?.codeThemeDark, settings?.codeFontSize, settings?.codeFont])
  useEffect(() => {
    if (settings) applyLocale(settings.locale)
  }, [settings?.locale])

  if (!ready || !settings) {
    return (
      <div className="splash">
        <div className="drag-strip drag" />
        <Oculus state={loadError ? 'error' : 'thinking'} size={44} />
        <p>{loadError ?? t('common.loading')}</p>
      </div>
    )
  }

  if (!account.connected) return <AccountGateView />
  if (!settings.onboarded) {
    return (
      <Suspense fallback={null}>
        <Onboarding />
      </Suspense>
    )
  }

  return (
    <div
      className={`app${sidebarOpen ? '' : ' collapsed'}${resizingSidebar ? ' is-resizing-sidebar' : ''}`}
      style={sidebarOpen ? ({ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties) : undefined}
    >
      <Sidebar
        open={sidebarOpen}
        sidebarWidth={sidebarWidth}
        resizing={resizingSidebar}
        onStartResize={startSidebarResize}
        onResetWidth={resetSidebarWidth}
      />
      <main className="main">
        {view !== 'chat' && <TopBar />}
        {view === 'chat' && <ChatView />}
        {view !== 'chat' && (
          <Suspense fallback={null}>
            {view === 'connections' && <ConnectionsView />}
            {view === 'market' && <MarketView />}
            {view === 'automations' && <AutomationsView />}
            {view === 'knowledge' && <KnowledgeView />}
          </Suspense>
        )}
      </main>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      <AccountModal />
      {toast && (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
      {fleetOpen && (
        <Suspense fallback={null}>
          <FleetModal />
        </Suspense>
      )}
      {policyOpen && (
        <Suspense fallback={null}>
          <PolicyModal />
        </Suspense>
      )}
      <UpdatePrompt />
      {pluginDiscoveryOpen && (
        <Suspense fallback={null}>
          <PluginDiscoveryModal />
        </Suspense>
      )}
    </div>
  )
}
