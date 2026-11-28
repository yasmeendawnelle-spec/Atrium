import type { CoreMethod, CoreMethods } from '@shared/ipc.ts'
import type { BrowserViewLayout } from '@shared/types.ts'

/** Typed call into the core process. Rejections carry a readable message. */
export function call<M extends CoreMethod>(method: M, ...args: Parameters<CoreMethods[M]>): Promise<Awaited<ReturnType<CoreMethods[M]>>> {
  return window.atrium.call(method, ...args) as Promise<Awaited<ReturnType<CoreMethods[M]>>>
}

export const shell = {
  pickFolder: () => window.atrium.shell.pickFolder(),
  pickFiles: (workspace?: string) => window.atrium.shell.pickFiles(workspace),
  inspectFiles: (paths: string[], workspace?: string) => window.atrium.shell.inspectFiles(paths, workspace),
  openExternal: (url: string) => window.atrium.shell.openExternal(url),
  revealPath: (targetPath: string, workspace?: string) => window.atrium.shell.revealPath(targetPath, workspace),
  openInEditor: (targetPath: string, workspace?: string) => window.atrium.shell.openInEditor(targetPath, workspace),
  info: () => window.atrium.shell.info(),
  newWindow: () => window.atrium.shell.newWindow(),
  updateState: () => window.atrium.shell.updateState(),
  checkUpdates: (feedUrl?: string) => window.atrium.shell.checkUpdates(feedUrl),
  downloadUpdate: () => window.atrium.shell.downloadUpdate(),
  installUpdate: () => window.atrium.shell.installUpdate(),
  setTitleBarTheme: (dark: boolean) => window.atrium.shell.setTitleBarTheme(dark),
  pathForFile: (file: unknown) => window.atrium.shell.pathForFile(file),
  stageArtifact: (html: string) => window.atrium.shell.stageArtifact(html),
  captureScreen: () => window.atrium.shell.captureScreen(),
  quickOpenChat: (conversationId: string) => window.atrium.shell.quickOpenChat(conversationId),
  quickHide: () => window.atrium.shell.quickHide(),
  quickResize: (height: number) => window.atrium.shell.quickResize(height),
  openBrowserWindow: (url?: string) => window.atrium.shell.openBrowserWindow(url),
  syncBrowserView: (layout: BrowserViewLayout | null) => window.atrium.shell.syncBrowserView(layout),
  dockBrowserView: () => window.atrium.shell.dockBrowserView(),
  readArchiveModel: (name: 'archive-cassette.glb' | 'archive-assembly.glb') =>
    window.atrium.shell.readArchiveModel(name),
}

export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors that crossed IPC; users don't need that part.
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
