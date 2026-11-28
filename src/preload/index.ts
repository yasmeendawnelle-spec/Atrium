// Exposes `window.atrium` to the renderer. The renderer never gets Node or
// Electron objects: only these functions, and only plain data crosses.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { RpcPeer } from '../shared/rpc.ts'
import type { AtriumApi, CoreEvent, CoreMethod } from '../shared/ipc.ts'
import type { BrowserSnapshot, BrowserViewLayout, UpdateState } from '../shared/types.ts'

// The DOM MessagePort that Electron hands the preload. Declared locally
// because the preload is typechecked with the Node config (no DOM lib).
interface WindowPort {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  start(): void
  close(): void
}

const listeners = new Set<(event: CoreEvent) => void>()
let peer: RpcPeer | null = null
let port: WindowPort | null = null
let connected = 0
let resolveReady: (peer: RpcPeer) => void = () => undefined
let ready = new Promise<RpcPeer>((resolve) => (resolveReady = resolve))

function dispatch(event: CoreEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error(err)
    }
  }
}

ipcRenderer.on('core:port', (event) => {
  const next = event.ports[0] as unknown as WindowPort | undefined
  if (!next) return
  peer?.dispose('Atrium restarted its background process. Try again.')
  port?.close()
  port = next
  const current = new RpcPeer(next, {}, (channel, payload) => dispatch({ channel, payload } as CoreEvent))
  peer = current
  next.onmessage = (e) => void current.receive(e.data)
  next.start()
  resolveReady(current)
  ready = Promise.resolve(current)
  // The first port is the initial connection; later ones follow a restart.
  if (connected++ > 0) dispatch({ channel: 'core', payload: { state: 'reconnected' } })
})

ipcRenderer.on('app:updater', (_event, payload: UpdateState) => {
  dispatch({ channel: 'updater', payload })
})

ipcRenderer.on('app:event', (_event, payload: { action: 'open_chat'; conversationId: string } | { action: 'focus_quick_input' }) => {
  dispatch({ channel: 'app', payload })
})

ipcRenderer.on('app:browser', (_event, payload: BrowserSnapshot) => {
  dispatch({ channel: 'browser', payload })
})

ipcRenderer.send('core:connect')

const api: AtriumApi = {
  async call(method: CoreMethod, ...args: unknown[]) {
    const p = await ready
    return p.call(method, ...args)
  },
  shell: {
    pickFolder: () => ipcRenderer.invoke('app.pickFolder'),
    pickFiles: (workspace?: string) => ipcRenderer.invoke('app.pickFiles', workspace),
    inspectFiles: (paths: string[], workspace?: string) => ipcRenderer.invoke('app.inspectFiles', paths, workspace),
    openExternal: (url: string) => ipcRenderer.invoke('app.openExternal', url),
    revealPath: (targetPath: string, workspace?: string) => ipcRenderer.invoke('app.revealPath', targetPath, workspace),
    openInEditor: (targetPath: string, workspace?: string) => ipcRenderer.invoke('app.openInEditor', targetPath, workspace),
    stageArtifact: (html: string) => ipcRenderer.invoke('app.stageArtifact', html),
    info: () => ipcRenderer.invoke('app.info'),
    newWindow: () => ipcRenderer.invoke('app.newWindow'),
    updateState: () => ipcRenderer.invoke('app.updateState'),
    checkUpdates: (feedUrl?: string) => ipcRenderer.invoke('app.checkUpdates', feedUrl),
    downloadUpdate: () => ipcRenderer.invoke('app.downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('app.installUpdate'),
    captureScreen: () => ipcRenderer.invoke('app.captureScreen'),
    quickOpenChat: (conversationId: string) => ipcRenderer.invoke('app.quickOpenChat', conversationId),
    quickHide: () => ipcRenderer.invoke('app.quickHide'),
    quickResize: (height: number) => ipcRenderer.invoke('app.quickResize', height),
    openBrowserWindow: (url?: string) => ipcRenderer.invoke('app.openBrowserWindow', url),
    syncBrowserView: (layout: BrowserViewLayout | null) => ipcRenderer.invoke('app.syncBrowserView', layout),
    dockBrowserView: () => ipcRenderer.invoke('app.dockBrowserView'),
    readArchiveModel: (name: 'archive-cassette.glb' | 'archive-assembly.glb') =>
      ipcRenderer.invoke('app.readArchiveModel', name),
    setTitleBarTheme: (dark: boolean) => ipcRenderer.send('app.titleBarTheme', dark),
    pathForFile: (file: unknown) => {
      try {
        return file ? webUtils.getPathForFile(file as never) : ''
      } catch {
        return ''
      }
    },
  },
  onEvent(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
} as AtriumApi

contextBridge.exposeInMainWorld('atrium', api)
