// Built-in Chromium browser preview & control tools for AgentLoop.
import type { BrowserActionInput, BrowserSnapshot, ImageAttachment, ToolInfo } from '../../shared/types.ts'

export const BROWSER_TOOLS: ToolInfo[] = [
  {
    name: 'browser_open',
    description:
      'Open a URL (`https://`, `http://`, or `http://localhost:...`) in the active conversation’s built-in Chromium browser, wait for rendering, and return the page title, console errors, clickable element refs (`e1`, `e2`, ...), Atrium virtual cursor status, and a rendered screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open in the built-in browser.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an interactive element in the built-in browser using Atrium’s dedicated virtual cursor (never touches the user’s physical OS mouse) by element ref (`e1`), CSS selector, OR rendered viewport pixel coordinates (`x`, `y`).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref returned by browser_open/screenshot (e.g. "e1").' },
        selector: { type: 'string', description: 'CSS selector fallback when ref is not specified.' },
        x: { type: 'number', description: 'Optional viewport X coordinate (0..screenshotWidth-1) for visual coordinate click.' },
        y: { type: 'number', description: 'Optional viewport Y coordinate (0..screenshotHeight-1) for visual coordinate click.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default "left").' },
        doubleClick: { type: 'boolean', description: 'Set true to double-click instead of single-click.' },
      },
    },
  },
  {
    name: 'browser_mouse',
    description:
      'Operate Atrium’s dedicated virtual Computer Use cursor inside the active conversation’s built-in browser without moving the user’s physical OS mouse cursor (`move`, `hover`, `click`, `double_click`, `right_click`, `drag`, or `scroll`).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'hover', 'click', 'double_click', 'right_click', 'drag', 'scroll'],
          description: 'Virtual cursor action inside the built-in browser.',
        },
        x: { type: 'number', description: 'Target viewport X coordinate (0..screenshotWidth-1).' },
        y: { type: 'number', description: 'Target viewport Y coordinate (0..screenshotHeight-1).' },
        endX: { type: 'number', description: 'Destination viewport X coordinate for `drag`.' },
        endY: { type: 'number', description: 'Destination viewport Y coordinate for `drag`.' },
        ref: { type: 'string', description: 'Optional element ref (`e1`) instead of explicit `(x, y)`.' },
        selector: { type: 'string', description: 'Optional CSS selector instead of explicit `(x, y)`.' },
        deltaX: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
        deltaY: { type: 'number', description: 'Vertical scroll delta in pixels (default 480).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_type',
    description: 'Move Atrium’s virtual cursor to an input/textarea element in the built-in browser and type text.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Target input ref (e.g. "e2").' },
        selector: { type: 'string', description: 'CSS selector fallback.' },
        x: { type: 'number', description: 'Optional viewport X coordinate to click and focus before typing.' },
        y: { type: 'number', description: 'Optional viewport Y coordinate to click and focus before typing.' },
        text: { type: 'string', description: 'Text to type into the field.' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_key',
    description: 'Press a keyboard key or shortcut inside the built-in browser (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Backspace").',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name to send to the active built-in browser page.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the active built-in browser page vertically/horizontally and return an updated screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        deltaY: {
          type: 'number',
          description: 'Vertical scroll delta in pixels (positive scrolls down, negative scrolls up; default 480).',
        },
        deltaX: {
          type: 'number',
          description: 'Optional horizontal scroll delta in pixels.',
        },
        x: { type: 'number', description: 'Optional viewport X coordinate where Atrium virtual cursor scrolls.' },
        y: { type: 'number', description: 'Optional viewport Y coordinate where Atrium virtual cursor scrolls.' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the latest rendered screenshot, Atrium virtual cursor state, and interactive element map of the active conversation’s built-in browser page.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_eval',
    description:
      'Execute a concise JavaScript expression inside the active built-in browser page to inspect DOM text, state, or layout geometry.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript expression or function IIFE to evaluate in the page.' },
      },
      required: ['script'],
    },
  },
]

export interface BrowserHostBridge {
  open(url: string, conversationId?: string): Promise<BrowserSnapshot>
  action(action: BrowserActionInput, conversationId?: string): Promise<BrowserSnapshot>
  capture(conversationId?: string): Promise<BrowserSnapshot>
  evalScript(script: string, conversationId?: string): Promise<{ value: string; isError?: boolean }>
  state?(conversationId?: string): Promise<BrowserSnapshot>
}

export function formatBrowserSnapshotText(snap: BrowserSnapshot): string {
  const lines = [
    `Browser ${snap.open ? 'open' : 'closed'}`,
    `Title: ${snap.title || '(untitled)'}`,
    `URL: ${snap.url || 'about:blank'}`,
  ]
  if (snap.screenshotWidth && snap.screenshotHeight) {
    lines.push(`Viewport: ${snap.screenshotWidth}x${snap.screenshotHeight}`)
  }
  if (snap.cursor) {
    lines.push(
      `Atrium Cursor: (${Math.round(snap.cursor.x)}, ${Math.round(snap.cursor.y)}) [${snap.cursor.action}${snap.cursor.targetLabel ? ` · ${snap.cursor.targetLabel}` : ''}]`,
    )
  }
  if (snap.error) lines.push(`Error: ${snap.error}`)
  if (snap.consoleLogs.length > 0) {
    lines.push('Console:')
    for (const entry of snap.consoleLogs.slice(-8)) {
      lines.push(`  [${entry.level}] ${entry.text}`)
    }
  }
  if (snap.elements.length > 0) {
    lines.push(`Interactive elements (${snap.elements.length}):`)
    for (const el of snap.elements.slice(0, 32)) {
      const desc = el.text || el.placeholder || el.href || el.value || ''
      lines.push(`  [${el.ref}] <${el.tag}${el.type ? ` type="${el.type}"` : ''}> ${el.role}${desc ? `: ${JSON.stringify(desc.slice(0, 80))}` : ''}`)
    }
  } else {
    lines.push('Interactive elements: (none)')
  }
  return lines.join('\n')
}

function toBrowserImageAttachment(snap: BrowserSnapshot, name = 'browser-view'): ImageAttachment | undefined {
  if (!snap.screenshotDataUrl) return undefined
  const isPng = snap.screenshotDataUrl.startsWith('data:image/png')
  return {
    id: `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: `${name}.${isPng ? 'png' : 'jpg'}`,
    mimeType: isPng ? 'image/png' : 'image/jpeg',
    dataUrl: snap.screenshotDataUrl,
  }
}

async function resolveViewportSize(bridge: BrowserHostBridge, conversationId?: string): Promise<{ w: number; h: number }> {
  const cur = bridge.state ? await bridge.state(conversationId) : await bridge.capture(conversationId)
  const w = cur.screenshotWidth && cur.screenshotWidth > 0 ? cur.screenshotWidth : 960
  const h = cur.screenshotHeight && cur.screenshotHeight > 0 ? cur.screenshotHeight : 640
  return { w, h }
}

function clampRatio(val: number, span: number): number {
  return Math.max(0, Math.min(1, val / span))
}

export async function runBrowserTool(
  bridge: BrowserHostBridge,
  name: string,
  input: Record<string, unknown>,
  opts?: { conversationId?: string },
): Promise<{ output: string; isError: boolean; images?: ImageAttachment[]; snapshot?: BrowserSnapshot }> {
  const cid = opts?.conversationId
  const withCid = <T extends BrowserActionInput>(act: T): T => (cid ? { ...act, conversationId: cid } : act)
  const callOpen = (url: string) => (cid ? bridge.open(url, cid) : bridge.open(url))
  const callAction = (act: BrowserActionInput) => (cid ? bridge.action(withCid(act), cid) : bridge.action(act))
  const callCapture = () => (cid ? bridge.capture(cid) : bridge.capture())
  const callEval = (script: string) => (cid ? bridge.evalScript(script, cid) : bridge.evalScript(script))

  try {
    if (name === 'browser_open') {
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      if (!url) return { output: '`url` is required.', isError: true }
      const snap = await callOpen(url)
      const img = toBrowserImageAttachment(snap, 'browser-open')
      return {
        output: formatBrowserSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }
    if (name === 'browser_click') {
      const ref = typeof input.ref === 'string' ? input.ref.trim() : undefined
      const selector = typeof input.selector === 'string' ? input.selector.trim() : undefined
      const hasCoords = typeof input.x === 'number' && Number.isFinite(input.x) && typeof input.y === 'number' && Number.isFinite(input.y)
      if (!ref && !selector && !hasCoords) {
        return { output: 'Either `ref`, `selector`, or `(x, y)` coordinates are required.', isError: true }
      }
      const button = input.button === 'right' || input.button === 'middle' ? input.button : undefined
      const doubleClick = input.doubleClick === true
      let snap: BrowserSnapshot
      if (!ref && !selector && hasCoords) {
        const { w, h } = await resolveViewportSize(bridge, cid)
        const xRatio = clampRatio(Number(input.x), w)
        const yRatio = clampRatio(Number(input.y), h)
        const kind = doubleClick ? 'doubleClickPoint' : button === 'right' ? 'rightClickPoint' : 'clickPoint'
        snap = await callAction({
          kind,
          xRatio,
          yRatio,
          ...(button ? { button } : {}),
          ...(doubleClick ? { doubleClick: true } : {}),
        })
      } else {
        snap = await callAction({
          kind: 'click',
          ref,
          selector,
          ...(button ? { button } : {}),
          ...(doubleClick ? { doubleClick: true } : {}),
        })
      }
      const img = toBrowserImageAttachment(snap, 'browser-click')
      return {
        output: formatBrowserSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }
    if (name === 'browser_mouse') {
      const act = typeof input.action === 'string' ? input.action.trim() : ''
      const ref = typeof input.ref === 'string' ? input.ref.trim() : undefined
      const selector = typeof input.selector === 'string' ? input.selector.trim() : undefined
      const hasCoords = typeof input.x === 'number' && Number.isFinite(input.x) && typeof input.y === 'number' && Number.isFinite(input.y)
      if (act === 'scroll') {
        const deltaY = typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) ? input.deltaY : 480
        const deltaX = typeof input.deltaX === 'number' && Number.isFinite(input.deltaX) ? input.deltaX : undefined
        let coordsPayload: { xRatio?: number; yRatio?: number } = {}
        if (hasCoords) {
          const { w, h } = await resolveViewportSize(bridge, cid)
          coordsPayload = { xRatio: clampRatio(Number(input.x), w), yRatio: clampRatio(Number(input.y), h) }
        }
        const snap = await callAction({ kind: 'scroll', deltaY, ...(deltaX !== undefined ? { deltaX } : {}), ...coordsPayload })
        const img = toBrowserImageAttachment(snap, 'browser-scroll')
        return {
          output: formatBrowserSnapshotText(snap),
          isError: Boolean(snap.error),
          images: img ? [img] : undefined,
          snapshot: snap,
        }
      }
      if (!ref && !selector && !hasCoords) {
        return { output: '`browser_mouse` requires `(x, y)` coordinates or a `ref`/`selector`.', isError: true }
      }
      if (act === 'drag') {
        if (
          typeof input.x !== 'number' ||
          !Number.isFinite(input.x) ||
          typeof input.y !== 'number' ||
          !Number.isFinite(input.y) ||
          typeof input.endX !== 'number' ||
          !Number.isFinite(input.endX) ||
          typeof input.endY !== 'number' ||
          !Number.isFinite(input.endY)
        ) {
          return { output: '`drag` requires finite `x`, `y`, `endX`, and `endY` coordinates.', isError: true }
        }
        const { w, h } = await resolveViewportSize(bridge, cid)
        const snap = await callAction({
          kind: 'dragPoint',
          xRatio: clampRatio(Number(input.x), w),
          yRatio: clampRatio(Number(input.y), h),
          endXRatio: clampRatio(Number(input.endX), w),
          endYRatio: clampRatio(Number(input.endY), h),
        })
        const img = toBrowserImageAttachment(snap, 'browser-drag')
        return {
          output: formatBrowserSnapshotText(snap),
          isError: Boolean(snap.error),
          images: img ? [img] : undefined,
          snapshot: snap,
        }
      }
      if (act === 'move' || act === 'hover') {
        const coordsPayload = hasCoords
          ? await (async () => {
              const { w, h } = await resolveViewportSize(bridge, cid)
              return { xRatio: clampRatio(Number(input.x), w), yRatio: clampRatio(Number(input.y), h) }
            })()
          : { ref, selector }
        const snap = await callAction({ kind: 'movePoint', ...coordsPayload })
        const img = toBrowserImageAttachment(snap, `browser-${act}`)
        return {
          output: formatBrowserSnapshotText(snap),
          isError: Boolean(snap.error),
          images: img ? [img] : undefined,
          snapshot: snap,
        }
      }
      if (act === 'click' || act === 'double_click' || act === 'right_click') {
        if (!ref && !selector && hasCoords) {
          const { w, h } = await resolveViewportSize(bridge, cid)
          const kind = act === 'double_click' ? 'doubleClickPoint' : act === 'right_click' ? 'rightClickPoint' : 'clickPoint'
          const snap = await callAction({
            kind,
            xRatio: clampRatio(Number(input.x), w),
            yRatio: clampRatio(Number(input.y), h),
            ...(act === 'right_click' ? { button: 'right' } : {}),
            ...(act === 'double_click' ? { doubleClick: true } : {}),
          })
          const img = toBrowserImageAttachment(snap, `browser-${act}`)
          return {
            output: formatBrowserSnapshotText(snap),
            isError: Boolean(snap.error),
            images: img ? [img] : undefined,
            snapshot: snap,
          }
        }
        const snap = await callAction({
          kind: 'click',
          ref,
          selector,
          ...(act === 'right_click' ? { button: 'right' } : {}),
          ...(act === 'double_click' ? { doubleClick: true } : {}),
        })
        const img = toBrowserImageAttachment(snap, `browser-${act}`)
        return {
          output: formatBrowserSnapshotText(snap),
          isError: Boolean(snap.error),
          images: img ? [img] : undefined,
          snapshot: snap,
        }
      }
      return { output: `Unsupported browser_mouse action "${act}".`, isError: true }
    }
    if (name === 'browser_type') {
      const text = typeof input.text === 'string' ? input.text : ''
      const ref = typeof input.ref === 'string' ? input.ref.trim() : undefined
      const selector = typeof input.selector === 'string' ? input.selector.trim() : undefined
      const hasCoords = typeof input.x === 'number' && Number.isFinite(input.x) && typeof input.y === 'number' && Number.isFinite(input.y)
      if (!ref && !selector && !hasCoords) {
        return { output: 'Either `ref`, `selector`, or `(x, y)` coordinates are required.', isError: true }
      }
      const submit = input.submit === true
      let actionPayload: BrowserActionInput = { kind: 'type', ref, selector, text, ...(submit ? { submit: true } : {}) }
      if (!ref && !selector && hasCoords) {
        const { w, h } = await resolveViewportSize(bridge, cid)
        actionPayload = {
          kind: 'type',
          xRatio: clampRatio(Number(input.x), w),
          yRatio: clampRatio(Number(input.y), h),
          text,
          ...(submit ? { submit: true } : {}),
        }
      }
      const snap = await callAction(actionPayload)
      const img = toBrowserImageAttachment(snap, 'browser-type')
      return {
        output: formatBrowserSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }
    if (name === 'browser_key') {
      const key = typeof input.key === 'string' ? input.key.trim() : ''
      if (!key) return { output: '`key` is required.', isError: true }
      const snap = await callAction({ kind: 'key', key })
      const img = toBrowserImageAttachment(snap, 'browser-key')
      return {
        output: formatBrowserSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }
    if (name === 'browser_scroll') {
      const deltaY = typeof input.deltaY === 'number' && Number.isFinite(input.deltaY) ? input.deltaY : 480
      const deltaX = typeof input.deltaX === 'number' && Number.isFinite(input.deltaX) ? input.deltaX : undefined
      const hasCoords = typeof input.x === 'number' && Number.isFinite(input.x) && typeof input.y === 'number' && Number.isFinite(input.y)
      let coordsPayload: { xRatio?: number; yRatio?: number } = {}
      if (hasCoords) {
        const { w, h } = await resolveViewportSize(bridge, cid)
        coordsPayload = { xRatio: clampRatio(Number(input.x), w), yRatio: clampRatio(Number(input.y), h) }
      }
      const snap = await callAction({ kind: 'scroll', deltaY, ...(deltaX !== undefined ? { deltaX } : {}), ...coordsPayload })
      const img = toBrowserImageAttachment(snap, 'browser-scroll')
      return {
        output: formatBrowserSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }
    if (name === 'browser_screenshot') {
      const snap = await callCapture()
      const img = toBrowserImageAttachment(snap, 'browser-screenshot')
      return {
        output: formatBrowserSnapshotText(snap),
        isError: Boolean(snap.error),
        images: img ? [img] : undefined,
        snapshot: snap,
      }
    }
    if (name === 'browser_eval') {
      const script = typeof input.script === 'string' ? input.script : ''
      if (!script.trim()) return { output: '`script` is required.', isError: true }
      const res = await callEval(script)
      return { output: res.value, isError: Boolean(res.isError) }
    }
    return { output: `Unknown browser tool "${name}".`, isError: true }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }
}
