// OS-level Desktop Computer Use tools for AgentLoop (screen capture, mouse, keyboard, window control).
import type {
  ComputerUseHudState,
  DesktopKeyboardInput,
  DesktopMouseAction,
  DesktopMouseInput,
  DesktopSnapshot,
  DesktopWindowInput,
  ImageAttachment,
  ToolInfo,
} from '../../shared/types.ts'

const MOUSE_ACTIONS = new Set<DesktopMouseAction>([
  'move',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'down',
  'up',
])

export const COMPUTER_TOOLS: ToolInfo[] = [
  {
    name: 'desktop_screenshot',
    description:
      'Capture the current OS desktop screen image, cursor coordinates, display list, and visible application windows. Returned coordinates `(x, y)` from `0..shotWidth-1` and `0..shotHeight-1` map directly to `desktop_mouse`.',
    inputSchema: {
      type: 'object',
      properties: {
        displayIndex: { type: 'number', description: 'Display index (0 is primary display). Defaults to 0.' },
        hideAtrium: {
          type: 'boolean',
          description: 'Minimize the main Atrium window briefly so obscured desktop apps become visible (default false).',
        },
      },
    },
  },
  {
    name: 'desktop_mouse',
    description:
      'Move, click, double-click, right-click, drag, or scroll the OS mouse cursor using the screenshot pixel coordinates (`x`, `y`) reported by `desktop_screenshot`. Automatically returns an updated screenshot unless `captureAfter: false`.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'down', 'up'],
          description: 'Mouse action to perform on the OS desktop.',
        },
        x: { type: 'number', description: 'Target X coordinate inside the screenshot (`0..shotWidth-1`).' },
        y: { type: 'number', description: 'Target Y coordinate inside the screenshot (`0..shotHeight-1`).' },
        endX: { type: 'number', description: 'Destination X coordinate for `drag`.' },
        endY: { type: 'number', description: 'Destination Y coordinate for `drag`.' },
        deltaX: { type: 'number', description: 'Horizontal scroll delta in pixels (positive scrolls right).' },
        deltaY: { type: 'number', description: 'Vertical scroll delta in pixels (positive scrolls down, negative scrolls up; default 360).' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Button for `down`/`up` (default left).' },
        displayIndex: { type: 'number', description: 'Display index (0 is primary). Defaults to 0.' },
        captureAfter: { type: 'boolean', description: 'Capture updated screenshot after action (default true).' },
      },
      required: ['action', 'x', 'y'],
    },
  },
  {
    name: 'desktop_keyboard',
    description:
      'Type full Unicode text cleanly or press single keys and shortcut hotkeys on the active OS desktop window. Automatically returns an updated screenshot unless `captureAfter: false`.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['type', 'key', 'hotkey'],
          description: '`type` inputs text cleanly (including CJK/symbols); `key` presses one named key; `hotkey` presses a key chord.',
        },
        text: { type: 'string', description: 'Text to type when `action` is `type`.' },
        key: {
          type: 'string',
          description: 'Key name for `key` (e.g. "Enter", "Tab", "Escape", "Backspace", "Delete", "Up", "Down", "Left", "Right", "F5").',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key sequence held together for `hotkey`, e.g. ["ctrl", "c"], ["alt", "tab"], ["win", "r"].',
        },
        displayIndex: { type: 'number', description: 'Display index for post-action screenshot (default 0).' },
        captureAfter: { type: 'boolean', description: 'Capture updated screenshot after action (default true).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'desktop_window',
    description:
      'List visible OS desktop windows or focus, minimize, maximize, or restore a window by handle, title substring, or process name.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'focus', 'minimize', 'maximize', 'restore'],
          description: 'Window operation to perform.',
        },
        handle: { type: 'string', description: 'Exact window handle (`hwnd`) returned in the window list.' },
        title: { type: 'string', description: 'Case-insensitive substring of the window title.' },
        processName: { type: 'string', description: 'Case-insensitive substring of the process name (e.g. "notepad", "explorer").' },
        displayIndex: { type: 'number', description: 'Display index for post-action screenshot (default 0).' },
        captureAfter: { type: 'boolean', description: 'Capture updated screenshot after state change (default true except for `list`).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'desktop_wait',
    description: 'Pause briefly (0.2s–10s) for a desktop application to finish launching, loading, or animating, then return a fresh screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Wait duration in seconds (default 1.5, max 10).' },
        displayIndex: { type: 'number', description: 'Display index (default 0).' },
      },
    },
  },
]

export interface ComputerHostBridge {
  screenshot(opts?: { displayIndex?: number; hideAtrium?: boolean }): Promise<DesktopSnapshot>
  mouse(input: DesktopMouseInput): Promise<DesktopSnapshot>
  keyboard(input: DesktopKeyboardInput): Promise<DesktopSnapshot>
  window(input: DesktopWindowInput): Promise<DesktopSnapshot>
  wait(opts?: { seconds?: number; displayIndex?: number }): Promise<DesktopSnapshot>
  setHud(state: ComputerUseHudState): Promise<void>
}

export function formatDesktopSnapshotText(snap: DesktopSnapshot): string {
  const activeDisplay = snap.displays.find((d) => d.index === snap.displayIndex) ?? snap.displays[0]
  const lines: string[] = []
  if (activeDisplay) {
    lines.push(
      `Display #${activeDisplay.index}${activeDisplay.primary ? ' (Primary)' : ''}: screenshot ${snap.shotWidth}x${snap.shotHeight} ` +
        `(valid x: 0..${Math.max(0, snap.shotWidth - 1)}, y: 0..${Math.max(0, snap.shotHeight - 1)}; ` +
        `logical ${activeDisplay.bounds.width}x${activeDisplay.bounds.height} @ ${Math.round(activeDisplay.scaleFactor * 100)}%)`,
    )
  } else {
    lines.push(`Display #${snap.displayIndex}: screenshot ${snap.shotWidth}x${snap.shotHeight}`)
  }
  if (snap.displays.length > 1) {
    lines.push(
      `All displays (${snap.displays.length}): ` +
        snap.displays.map((d) => `#${d.index}${d.primary ? '*' : ''} ${d.shotWidth}x${d.shotHeight}`).join(', '),
    )
  }
  lines.push(
    snap.cursor.inDisplay
      ? `Cursor: (${snap.cursor.x}, ${snap.cursor.y})`
      : `Cursor: (${snap.cursor.x}, ${snap.cursor.y}) [outside display #${snap.displayIndex}]`,
  )
  if (snap.error) lines.push(`Error: ${snap.error}`)
  if (snap.windows.length > 0) {
    lines.push(`Open windows (${snap.windows.length}):`)
    for (const win of snap.windows.slice(0, 16)) {
      const flags = [
        win.foreground ? 'ACTIVE' : null,
        win.minimized ? 'minimized' : null,
        win.maximized ? 'maximized' : null,
      ]
        .filter(Boolean)
        .join(',')
      const stateTag = flags ? ` [${flags}]` : ''
      const shortTitle = win.title.length > 72 ? `${win.title.slice(0, 69)}...` : win.title
      lines.push(
        `  [hwnd=${win.hwnd}]${stateTag} "${shortTitle}" (${win.processName || 'app'}, x=${win.x} y=${win.y} w=${win.width} h=${win.height})`,
      )
    }
  } else {
    lines.push('Open windows: (none detected)')
  }
  return lines.join('\n')
}

export function toDesktopImageAttachment(snap: DesktopSnapshot, label = 'desktop'): ImageAttachment | undefined {
  if (!snap.screenshotDataUrl) return undefined
  const isPng = snap.screenshotDataUrl.startsWith('data:image/png')
  return {
    id: `desktop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: `${label}-${snap.shotWidth}x${snap.shotHeight}.${isPng ? 'png' : 'jpg'}`,
    mimeType: isPng ? 'image/png' : 'image/jpeg',
    dataUrl: snap.screenshotDataUrl,
  }
}

export function describeComputerAction(name: string, input: Record<string, unknown>): string {
  if (name === 'desktop_screenshot') {
    const d = typeof input.displayIndex === 'number' ? input.displayIndex : 0
    return `Screenshot display #${d}`
  }
  if (name === 'desktop_mouse') {
    const action = String(input.action ?? 'click')
    const x = Math.round(Number(input.x ?? 0))
    const y = Math.round(Number(input.y ?? 0))
    if (action === 'drag') {
      return `Mouse drag (${x},${y}) -> (${Math.round(Number(input.endX ?? 0))},${Math.round(Number(input.endY ?? 0))})`
    }
    if (action === 'scroll') return `Mouse scroll at (${x},${y})`
    return `Mouse ${action} at (${x},${y})`
  }
  if (name === 'desktop_keyboard') {
    const action = String(input.action ?? 'type')
    if (action === 'hotkey' && Array.isArray(input.keys)) {
      return `Hotkey ${input.keys.map((k) => String(k)).join('+')}`
    }
    if (action === 'key') return `Key ${String(input.key ?? '')}`
    const text = String(input.text ?? '').replace(/\s+/g, ' ').trim()
    return `Type "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`
  }
  if (name === 'desktop_window') {
    const action = String(input.action ?? 'list')
    const target = String(input.title ?? input.processName ?? input.handle ?? '').trim()
    return target ? `Window ${action}: ${target}` : `Window ${action}`
  }
  if (name === 'desktop_wait') {
    return `Wait ${Number(input.seconds ?? 1.5)}s`
  }
  return name
}

export async function runComputerTool(
  bridge: ComputerHostBridge,
  name: string,
  input: Record<string, unknown>,
): Promise<{ output: string; isError: boolean; images?: ImageAttachment[]; snapshot?: DesktopSnapshot }> {
  try {
    const displayIndex =
      typeof input.displayIndex === 'number' && Number.isFinite(input.displayIndex) ? Math.max(0, Math.floor(input.displayIndex)) : undefined

    if (name === 'desktop_screenshot') {
      const snap = await bridge.screenshot({
        displayIndex,
        hideAtrium: Boolean(input.hideAtrium),
      })
      const img = toDesktopImageAttachment(snap, 'desktop-screen')
      return {
        output: formatDesktopSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }

    if (name === 'desktop_mouse') {
      const action = String(input.action ?? '') as DesktopMouseAction
      if (!MOUSE_ACTIONS.has(action)) {
        return { output: `Unsupported mouse action "${action}".`, isError: true }
      }
      const x = Number(input.x)
      const y = Number(input.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { output: '`x` and `y` coordinates are required.', isError: true }
      }
      const snap = await bridge.mouse({
        action,
        x,
        y,
        ...(typeof input.endX === 'number' && Number.isFinite(input.endX) ? { endX: input.endX } : {}),
        ...(typeof input.endY === 'number' && Number.isFinite(input.endY) ? { endY: input.endY } : {}),
        ...(typeof input.deltaX === 'number' && Number.isFinite(input.deltaX) ? { deltaX: input.deltaX } : {}),
        ...(typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) ? { deltaY: input.deltaY } : {}),
        ...(input.button === 'left' || input.button === 'right' || input.button === 'middle' ? { button: input.button } : {}),
        displayIndex,
        captureAfter: input.captureAfter !== false,
      })
      const img = toDesktopImageAttachment(snap, `desktop-${action}`)
      return {
        output: formatDesktopSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }

    if (name === 'desktop_keyboard') {
      const action = String(input.action ?? '')
      if (action !== 'type' && action !== 'key' && action !== 'hotkey') {
        return { output: '`action` must be `type`, `key`, or `hotkey`.', isError: true }
      }
      if (action === 'type' && (typeof input.text !== 'string' || input.text.length === 0)) {
        return { output: '`text` is required for `type`.', isError: true }
      }
      if (action === 'key' && (typeof input.key !== 'string' || !input.key.trim())) {
        return { output: '`key` is required for `key`.', isError: true }
      }
      const keys = Array.isArray(input.keys) ? input.keys.map((k) => String(k).trim()).filter(Boolean) : undefined
      if (action === 'hotkey' && (!keys || keys.length === 0)) {
        return { output: '`keys` array is required for `hotkey`.', isError: true }
      }
      const snap = await bridge.keyboard({
        action,
        ...(typeof input.text === 'string' ? { text: input.text } : {}),
        ...(typeof input.key === 'string' ? { key: input.key.trim() } : {}),
        ...(keys ? { keys } : {}),
        displayIndex,
        captureAfter: input.captureAfter !== false,
      })
      const img = toDesktopImageAttachment(snap, `desktop-${action}`)
      return {
        output: formatDesktopSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }

    if (name === 'desktop_window') {
      const action = String(input.action ?? 'list')
      if (action !== 'list' && action !== 'focus' && action !== 'minimize' && action !== 'maximize' && action !== 'restore') {
        return { output: `Unsupported window action "${action}".`, isError: true }
      }
      const handle = typeof input.handle === 'string' ? input.handle.trim() : undefined
      const title = typeof input.title === 'string' ? input.title.trim() : undefined
      const processName = typeof input.processName === 'string' ? input.processName.trim() : undefined
      if (action !== 'list' && !handle && !title && !processName) {
        return { output: 'Specify `handle`, `title`, or `processName` to target a window.', isError: true }
      }
      const snap = await bridge.window({
        action,
        handle,
        title,
        processName,
        displayIndex,
        captureAfter: typeof input.captureAfter === 'boolean' ? input.captureAfter : action !== 'list',
      })
      const img = toDesktopImageAttachment(snap, `desktop-win-${action}`)
      return {
        output: formatDesktopSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }

    if (name === 'desktop_wait') {
      const rawSec = typeof input.seconds === 'number' && Number.isFinite(input.seconds) ? input.seconds : 1.5
      const seconds = Math.max(0.2, Math.min(10, rawSec))
      const snap = await bridge.wait({ seconds, displayIndex })
      const img = toDesktopImageAttachment(snap, 'desktop-wait')
      return {
        output: formatDesktopSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }

    return { output: `Unknown computer tool "${name}".`, isError: true }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }
}
