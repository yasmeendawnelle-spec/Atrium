// Agent tools for managed local dev-server previews integrated with Atrium's built-in Chromium browser.
import type { ImageAttachment, ToolInfo } from '../../shared/types.ts'
import type { PreviewServerManager } from '../preview.ts'
import { formatBrowserSnapshotText, type BrowserHostBridge } from './browser_tools.ts'

export const PREVIEW_TOOLS: ToolInfo[] = [
  {
    name: 'preview_start',
    description:
      'Start a local development server (e.g. `npm run dev`, `vite`, `next dev`) in the workspace, auto-detect its listening localhost URL, wait until HTTP responds, open it in the conversation’s built-in Chromium browser, and return server logs, console errors, interactive refs, and a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to launch the local dev server.' },
        url: { type: 'string', description: 'Optional explicit local URL if the server does not print one.' },
        port: { type: 'number', description: 'Optional explicit local port fallback.' },
        readyTimeoutSeconds: { type: 'number', description: 'Seconds to wait for server readiness (default 20).' },
        openBrowser: { type: 'boolean', description: 'Automatically open the detected URL in the built-in browser (default true).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'preview_logs',
    description:
      'Inspect recent stdout/stderr logs from a running preview server, along with the latest built-in browser console errors, DOM element refs, and optional screenshot after code edits.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'Optional serverId returned by preview_start (defaults to active conversation server).' },
        tailChars: { type: 'number', description: 'Max characters of server logs to return (default 4000).' },
        reloadBrowser: { type: 'boolean', description: 'Reload the built-in browser page before capturing logs/screenshot (default false).' },
        includeScreenshot: { type: 'boolean', description: 'Include current browser console logs and screenshot (default true).' },
      },
    },
  },
  {
    name: 'preview_stop',
    description: 'Stop a managed local preview dev server started by preview_start.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'Optional serverId to stop (defaults to all servers in this conversation).' },
      },
    },
  },
]

function snapshotToImage(dataUrl: string | undefined, name: string): ImageAttachment | undefined {
  if (!dataUrl) return undefined
  const isPng = dataUrl.startsWith('data:image/png')
  return {
    id: `preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: `${name}.${isPng ? 'png' : 'jpg'}`,
    mimeType: isPng ? 'image/png' : 'image/jpeg',
    dataUrl,
  }
}

export async function runPreviewTool(
  manager: PreviewServerManager,
  browser: BrowserHostBridge | undefined,
  name: string,
  input: Record<string, unknown>,
  opts: {
    workspace: string
    conversationId?: string
    signal?: AbortSignal
  },
): Promise<{ output: string; isError: boolean; images?: ImageAttachment[] }> {
  try {
    if (name === 'preview_start') {
      const command = typeof input.command === 'string' ? input.command.trim() : ''
      if (!command) return { output: '`command` is required.', isError: true }
      const url = typeof input.url === 'string' ? input.url.trim() || undefined : undefined
      const port = typeof input.port === 'number' && Number.isFinite(input.port) ? input.port : undefined
      const readySeconds = typeof input.readyTimeoutSeconds === 'number' && Number.isFinite(input.readyTimeoutSeconds)
        ? input.readyTimeoutSeconds
        : 20

      const res = await manager.start({
        workspace: opts.workspace,
        command,
        conversationId: opts.conversationId,
        url,
        port,
        readyTimeoutMs: readySeconds * 1000,
        signal: opts.signal,
      })

      const lines = [
        `Preview Server ${res.server.id} [${res.server.status}]`,
        `Command: ${res.server.command}`,
        `URL: ${res.server.url ?? '(not detected yet)'}`,
        `Ready: ${res.ready ? 'yes' : 'no'}`,
      ]
      if (res.server.error) lines.push(`Server Error: ${res.server.error}`)
      if (res.logTail.trim()) {
        lines.push('Server Logs (tail):')
        lines.push(res.logTail.trim())
      }

      if (res.server.status === 'error') {
        return { output: lines.join('\n'), isError: true }
      }

      const shouldOpen = input.openBrowser !== false
      let images: ImageAttachment[] | undefined
      if (shouldOpen && browser && res.server.url && res.ready) {
        try {
          const snap = await browser.open(res.server.url, opts.conversationId)
          lines.push('', '--- Built-in Browser Snapshot ---', formatBrowserSnapshotText(snap))
          const img = snapshotToImage(snap.screenshotDataUrl, 'preview-start')
          if (img) images = [img]
        } catch (err) {
          lines.push('', `Browser open warning: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return {
        output: lines.join('\n'),
        isError: false,
        ...(images ? { images } : {}),
      }
    }

    if (name === 'preview_logs') {
      const serverId = typeof input.serverId === 'string' ? input.serverId.trim() || undefined : undefined
      const tailChars = typeof input.tailChars === 'number' && Number.isFinite(input.tailChars) ? input.tailChars : 4000
      const record = manager.logs({
        serverId,
        conversationId: opts.conversationId,
        tailChars,
      })

      const lines: string[] = []
      if (record) {
        lines.push(
          `Preview Server ${record.server.id} [${record.server.status}]`,
          `URL: ${record.server.url ?? '(unknown)'}`,
        )
        if (record.server.error) lines.push(`Server Error: ${record.server.error}`)
        lines.push('Server Logs:', record.logs.trim() || '(no output yet)')
      } else {
        lines.push('No managed preview server found for this conversation.')
      }

      let images: ImageAttachment[] | undefined
      if (browser && input.includeScreenshot !== false) {
        try {
          const reload = input.reloadBrowser === true
          const snap = reload
            ? await browser.action({ kind: 'reload', conversationId: opts.conversationId }, opts.conversationId)
            : await browser.capture(opts.conversationId)
          if (snap.open) {
            lines.push('', '--- Built-in Browser Snapshot ---', formatBrowserSnapshotText(snap))
            const img = snapshotToImage(snap.screenshotDataUrl, 'preview-logs')
            if (img) images = [img]
          }
        } catch {
          /* browser not active yet; return server logs cleanly */
        }
      }

      return {
        output: lines.join('\n'),
        isError: !record && (!images || images.length === 0),
        ...(images ? { images } : {}),
      }
    }

    if (name === 'preview_stop') {
      const serverId = typeof input.serverId === 'string' ? input.serverId.trim() || undefined : undefined
      if (serverId) {
        const stopped = await manager.stop(serverId)
        return {
          output: stopped ? `Stopped preview server ${serverId}.` : `Preview server "${serverId}" was not found.`,
          isError: !stopped,
        }
      }
      if (opts.conversationId) {
        const count = await manager.stopForConversation(opts.conversationId)
        return {
          output: count > 0 ? `Stopped ${count} preview server(s).` : 'No running preview server in this conversation.',
          isError: false,
        }
      }
      return { output: 'Provide `serverId` to stop a preview server.', isError: true }
    }

    return { output: `Unknown preview tool "${name}".`, isError: true }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }
}
