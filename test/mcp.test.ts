import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { McpClient, testServer } from '../src/core/mcp/client.ts'

const fixture = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url))
const base = { name: 'echo', transport: 'stdio' as const, command: process.execPath, args: [fixture] }

test('testServer connects over stdio and lists tools', { timeout: 30_000 }, async () => {
  const result = await testServer(base)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.tools.map((t) => t.name).sort(), ['echo', 'env', 'fail'])
  assert.equal(result.serverName, 'echo-fixture')
  assert.equal(result.serverVersion, '1.2.3')
  assert.match(result.stderrTail ?? '', /echo-fixture ready/)
})

test('McpClient calls tools, passes env, and reports tool errors', { timeout: 30_000 }, async (t) => {
  const client = new McpClient({ ...base, id: 'fx', enabled: true, env: { ATRIUM_TEST: 'hello' } }, () => undefined)
  t.after(() => client.close())
  await client.connect()
  assert.equal(client.status.state, 'connected', client.status.error)
  const signal = new AbortController().signal
  assert.deepEqual(await client.callTool('echo', { text: 'hi' }, signal), { output: 'echo: hi', isError: false })
  assert.deepEqual(await client.callTool('env', { name: 'ATRIUM_TEST' }, signal), { output: 'hello', isError: false })
  assert.deepEqual(await client.callTool('fail', {}, signal), { output: 'it failed', isError: true })
})

test('a missing program gives an actionable error instead of a stack trace', { timeout: 30_000 }, async () => {
  const result = await testServer({ name: 'nope', transport: 'stdio', command: 'atrium-no-such-program', args: [] })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /Couldn't find "atrium-no-such-program"/)
})
