// Reasoning effort levels (xhigh / max), provider step-down on rejection, the CLI slider, and Ultracode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { normalizeReasoningEffort, REASONING_EFFORT_LEVELS } from '../src/shared/types.ts'
import {
  anthropicEffortSupport,
  buildAnthropicThinking,
  clampEffort,
  responsesEffort,
} from '../src/shared/thinking.ts'
import { chat, endpointFor } from '../src/core/providers/index.ts'
import { SettingsStore } from '../src/core/settings.ts'
import { systemPrompt } from '../src/core/prompt.ts'
import { parseSubagentInput } from '../src/core/tools/subagent.ts'
import { parseCliArgs } from '../src/cli/args.ts'
import { applyEffortSliderKey, formatEffortScale, renderEffortSliderLines } from '../src/cli/slider.ts'
import { formatEffortBadge, renderWelcomeScreen } from '../src/cli/ui.ts'
import { parseStatusBranch } from '../src/core/tools/git.ts'
import { createThemePalette, stripAnsi, visibleWidth } from '../src/cli/theme.ts'
import { gradientText, renderMeter, rgbTo256, ultraStops } from '../src/cli/fx.ts'

async function startMockHttp(
  t: { after: (fn: () => Promise<void> | void) => void },
  handler: (req: IncomingMessage, body: Record<string, any>, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      handler(req, raw ? (JSON.parse(raw) as Record<string, any>) : {}, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

test('effort levels: six slider stops and tolerant normalization', () => {
  assert.deepEqual([...REASONING_EFFORT_LEVELS], ['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(normalizeReasoningEffort('MAX'), 'max')
  assert.equal(normalizeReasoningEffort('x-high'), 'xhigh')
  assert.equal(normalizeReasoningEffort('turbo', 'medium'), 'medium')
  assert.equal(normalizeReasoningEffort(undefined), 'auto')
})

test('anthropic: xhigh and max are sent only where the model accepts them', () => {
  assert.deepEqual(anthropicEffortSupport('claude-opus-4-6'), { effort: true, xhigh: false, max: true })
  assert.deepEqual(anthropicEffortSupport('claude-sonnet-4-6'), { effort: true, xhigh: false, max: true })
  assert.deepEqual(anthropicEffortSupport('claude-opus-4-7'), { effort: true, xhigh: true, max: true })
  assert.deepEqual(anthropicEffortSupport('claude-sonnet-5-5'), { effort: true, xhigh: true, max: true })
  assert.deepEqual(anthropicEffortSupport('claude-haiku-5-5'), { effort: true, xhigh: true, max: true })
  assert.equal(anthropicEffortSupport('claude-haiku-4-5').effort, false)

  assert.deepEqual(buildAnthropicThinking('claude-opus-5-5', 64_000, 'max').outputConfig, { effort: 'max' })
  assert.deepEqual(buildAnthropicThinking('claude-opus-4-8', 64_000, 'xhigh').outputConfig, { effort: 'xhigh' })
  assert.deepEqual(buildAnthropicThinking('claude-opus-4-6', 64_000, 'max').outputConfig, { effort: 'max' })
  assert.deepEqual(buildAnthropicThinking('claude-opus-4-6', 64_000, 'xhigh').outputConfig, { effort: 'high' })
  assert.equal(buildAnthropicThinking('claude-opus-5-5', 64_000, 'auto').outputConfig, undefined)

  // Legacy budget models: max gets the biggest budget, still capped by max_tokens.
  assert.deepEqual(buildAnthropicThinking('claude-sonnet-4-5', 64_000, 'max').thinking, { type: 'enabled', budget_tokens: 49152 })
  assert.deepEqual(buildAnthropicThinking('claude-sonnet-4-5', 16_000, 'max').thinking, { type: 'enabled', budget_tokens: 13952 })

  assert.equal(clampEffort('max', { xhigh: false, max: false }), 'high')
  assert.equal(clampEffort('max', { xhigh: true, max: false }), 'xhigh')
})

test('responses: old models clamp xhigh/max to high, new models keep them', () => {
  assert.equal(responsesEffort('gpt-5', 'xhigh'), 'high')
  assert.equal(responsesEffort('o3', 'max'), 'high')
  assert.equal(responsesEffort('gpt-5.1-codex', 'xhigh'), 'high')
  assert.equal(responsesEffort('gpt-5.1-codex-max', 'xhigh'), 'xhigh')
  assert.equal(responsesEffort('gpt-5.2', 'max'), 'max')
  assert.equal(responsesEffort('gpt-6.2-astra', 'xhigh'), 'xhigh')
  assert.equal(responsesEffort('gpt-5.5', 'auto'), 'medium')
})

test('responses: a rejected max steps down to xhigh and keeps rich fields', { timeout: 20_000 }, async (t) => {
  const bodies: Array<Record<string, any>> = []
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    bodies.push(body)
    if (body.reasoning?.effort === 'max') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: "Unsupported value: 'max' for reasoning.effort" } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type: string, extra: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`)
    emit('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message' } })
    emit('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: 'ok' })
    emit('response.completed', { response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } })
    res.end()
  })
  const endpoint = endpointFor({ protocol: 'responses', baseUrl }, 'sk-test')
  const req = {
    model: 'gpt-5.4',
    system: 'sys',
    messages: [{ role: 'user' as const, text: 'go' }],
    tools: [],
    effort: 'max' as const,
    signal: new AbortController().signal,
  }
  let out = ''
  await chat('responses', endpoint, req, { onText: (d) => (out += d) })
  assert.equal(out, 'ok')
  assert.deepEqual(bodies.map((b) => b.reasoning?.effort), ['max', 'xhigh'])
  assert.equal(bodies[1]?.store, false, 'rich fields survive the step-down')

  // The accepted level is remembered, so the next round skips the failing probe.
  await chat('responses', endpoint, req, { onText: () => undefined })
  assert.equal(bodies.length, 3)
  assert.equal(bodies[2]?.reasoning?.effort, 'xhigh')
})

test('anthropic: a rejected effort steps down before dropping thinking', { timeout: 20_000 }, async (t) => {
  const bodies: Array<Record<string, any>> = []
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    bodies.push(body)
    if (body.output_config?.effort === 'xhigh') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: xhigh is not supported' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('message_start', { message: { usage: { input_tokens: 3, output_tokens: 0 } } })
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } })
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    emit('message_stop', {})
    res.end()
  })
  const endpoint = endpointFor({ protocol: 'anthropic', baseUrl }, 'sk-test')
  let out = ''
  await chat(
    'anthropic',
    endpoint,
    {
      model: 'claude-mythos-5-2-proxy',
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      tools: [],
      effort: 'xhigh',
      signal: new AbortController().signal,
    },
    { onText: (d) => (out += d) },
  )
  assert.equal(out, 'hi')
  assert.deepEqual(bodies.map((b) => b.output_config?.effort), ['xhigh', 'high'])
  assert.ok(bodies[1]?.thinking, 'thinking is kept after the step-down')
})

test('settings: effort and ultracode are normalized on load and update', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-effort-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ reasoningEffort: 'bogus', ultracode: 'yes' }))
  const store = new SettingsStore(dir)
  await store.load()
  assert.equal(store.get().reasoningEffort, 'auto')
  assert.equal(store.get().ultracode, false)
  await store.update({ reasoningEffort: 'max', ultracode: true })
  assert.equal(store.get().reasoningEffort, 'max')
  assert.equal(store.get().ultracode, true)
})

test('ultracode: prompt directive, subagent round ceiling, and plan-mode safety', () => {
  const on = systemPrompt('/ws', undefined, { mode: 'auto', ultracode: true })
  assert.match(on, /<ultracode>/)
  assert.match(on, /role="worker"/)
  assert.match(on, /explorers have no shell tools/)
  const plan = systemPrompt('/ws', undefined, { mode: 'plan', ultracode: true })
  assert.match(plan, /explorers only/)
  assert.doesNotMatch(plan, /role="worker" subagent with a precise scope/)
  assert.doesNotMatch(systemPrompt('/ws', undefined, { mode: 'auto' }), /<ultracode>/)

  assert.equal(parseSubagentInput({ task: 'x', max_rounds: 50 }, 'auto').maxRounds, 20)
  assert.equal(parseSubagentInput({ task: 'x', max_rounds: 50 }, 'auto', { ultracode: true }).maxRounds, 30)
  assert.equal(parseSubagentInput({ task: 'x' }, 'auto', { ultracode: true }).maxRounds, 15)
  assert.equal(parseSubagentInput({ task: 'x', role: 'worker' }, 'plan', { ultracode: true }).role, 'explorer')
})

test('cli: --effort max, --ultracode flags, and `--effort ultracode`', () => {
  assert.equal(parseCliArgs(['--effort', 'max', '-p', 'x']).effort, 'max')
  assert.equal(parseCliArgs(['--ultracode', '-p', 'x']).ultracode, true)
  assert.equal(parseCliArgs(['--no-ultracode', '-p', 'x']).ultracode, false)
  const alias = parseCliArgs(['--effort', 'ultracode', '-p', 'x'])
  assert.equal(alias.ultracode, true)
  assert.equal(alias.effort, undefined)
  assert.throws(() => parseCliArgs(['--effort', 'turbo']), /auto, low, medium, high, xhigh, max/)
})

test('cli slider: arrows drag, digits jump, u toggles ultracode, ends clamp', () => {
  let s = { index: 0, ultracode: false }
  s = applyEffortSliderKey('\x1b[C', s).state
  s = applyEffortSliderKey('\x1b[C', s).state
  assert.equal(s.index, 2)
  s = applyEffortSliderKey('\x1b[D', s).state
  assert.equal(s.index, 1)
  s = applyEffortSliderKey('6', s).state
  assert.equal(s.index, 5)
  s = applyEffortSliderKey('\x1b[C', s).state
  assert.equal(s.index, 5, 'clamps at max')
  s = applyEffortSliderKey('u', s).state
  assert.equal(s.ultracode, true)
  assert.equal(applyEffortSliderKey('\r', s).action, 'confirm')
  assert.equal(applyEffortSliderKey('\x1b', s).action, 'cancel')

  const palette = createThemePalette(false)
  const lines = renderEffortSliderLines({ index: 3, ultracode: true }, palette, 80).map(stripAnsi)
  assert.ok(lines.some((l) => l.includes('auto') && l.includes('max')))
  assert.ok(lines.some((l) => l.includes('●')))
  assert.ok(lines.some((l) => /ultracode on/i.test(l)))
  assert.equal(formatEffortScale('high'), 'auto ─ low ─ medium ─ [high] ─ xhigh ─ max')
  assert.equal(stripAnsi(formatEffortBadge('max', palette, true)), '◆ max ✦ ultracode')
})

test('cli fx: gradients keep the text, fall back to 256 colours, and the slider keeps its height', () => {
  const plain = createThemePalette(false)
  const color = { ...createThemePalette(true), colorDepth: 'truecolor' as const }
  const c256 = { ...color, colorDepth: '256' as const }
  const stops = ultraStops(color)

  assert.equal(gradientText('✦ ultracode', plain, stops), '✦ ultracode', 'no colour: unchanged text')
  const rich = gradientText('✦ ultracode', color, stops, { wrap: true, phase: 0.3, shine: 4, bold: true })
  assert.equal(stripAnsi(rich), '✦ ultracode')
  assert.match(rich, /\x1b\[38;2;\d+;\d+;\d+m/)
  const fallback = gradientText('ultra', c256, stops)
  assert.match(fallback, /\x1b\[38;5;\d+m/)
  assert.doesNotMatch(fallback, /38;2;/)
  assert.equal(rgbTo256([0, 0, 0]), 16)
  assert.equal(rgbTo256([255, 255, 255]), 231)

  // Five one-cell bars: always evenly spaced, whatever the level.
  for (let lit = 0; lit <= 5; lit += 1) assert.equal(visibleWidth(renderMeter(lit, color)), 5)

  const on = renderEffortSliderLines({ index: 5, ultracode: true }, color, 80, undefined, { knobPos: 4.4, tick: 7, maxShine: 0.5, ultraAge: 600 })
  const off = renderEffortSliderLines({ index: 5, ultracode: false }, color, 80)
  assert.equal(on.length, off.length, 'toggling Ultracode does not change the dock height')
  for (const line of on) assert.ok(visibleWidth(line) <= 79)
  assert.ok(on.map(stripAnsi).some((l) => l.includes('plan') && l.includes('verify')))
})

test('cli startup: one-call git status parsing and the boxed welcome screen', () => {
  assert.equal(parseStatusBranch('main...origin/main [ahead 1]'), 'main')
  assert.equal(parseStatusBranch('feat/tui'), 'feat/tui')
  assert.equal(parseStatusBranch('No commits yet on dev'), 'dev')
  assert.equal(parseStatusBranch('HEAD (no branch)'), undefined)
  assert.equal(parseStatusBranch(''), undefined)

  const palette = createThemePalette(true)
  const base = {
    version: '0.3.4', model: 'gpt-5', providerName: 'OpenAI', mode: 'auto' as const, scene: 'code' as const,
    effort: 'xhigh' as const, ultracode: true, workspace: '~/repo', accountLabel: 'x', mcpConnected: 0, mcpTotal: 0,
    skillCount: 0, contextUsed: 0, contextLimit: 200_000, palette,
  }
  const wide = stripAnsi(renderWelcomeScreen({ ...base, cols: 100 })).split('\n')
  assert.ok(wide.some((l) => l.startsWith('╭') && l.endsWith('╮')), 'card on wide terminals')
  assert.ok(wide.some((l) => l.includes('xhigh ✦ ultracode · auto mode')))
  const narrow = stripAnsi(renderWelcomeScreen({ ...base, cols: 50 })).split('\n')
  assert.ok(!narrow.some((l) => l.includes('╭')), 'no card under 60 columns')
  for (const line of narrow) assert.ok(visibleWidth(line) <= 50)
})
