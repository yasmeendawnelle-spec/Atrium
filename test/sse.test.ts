import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBlock, readSse } from '../src/core/providers/sse.ts'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

async function collect(chunks: string[]) {
  const out = []
  for await (const evt of readSse(streamOf(chunks))) out.push(evt)
  return out
}

test('parseBlock reads event and multi-line data', () => {
  assert.deepEqual(parseBlock('event: delta\ndata: {"a":1}\ndata: more'), { event: 'delta', data: '{"a":1}\nmore' })
  assert.equal(parseBlock(': comment only'), null)
})

test('readSse handles events split across chunks', async () => {
  const events = await collect(['data: {"x"', ':1}\n', '\ndata: two\n\n'])
  assert.deepEqual(events.map((e) => e.data), ['{"x":1}', 'two'])
})

test('readSse handles CRLF line endings and a trailing event without a blank line', async () => {
  const events = await collect(['event: a\r\ndata: 1\r\n\r\n', 'data: 2'])
  assert.deepEqual(events, [
    { event: 'a', data: '1' },
    { event: 'message', data: '2' },
  ])
})

test('readSse keeps multi-byte characters split between chunks intact', async () => {
  const bytes = new TextEncoder().encode('data: 你好\n\n')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 8))
      controller.enqueue(bytes.slice(8))
      controller.close()
    },
  })
  const out = []
  for await (const evt of readSse(stream)) out.push(evt.data)
  assert.deepEqual(out, ['你好'])
})

test('readSse splits mixed CRLF/LF delimiters and multiple trailing events cleanly', async () => {
  const events = await collect([
    'data: {"n":1}\r\n',
    '\ndata: {"n":2}\n\r\ndata: {"n":3}\r\n\ndata: [DONE]',
  ])
  assert.deepEqual(
    events.map((e) => e.data),
    ['{"n":1}', '{"n":2}', '{"n":3}', '[DONE]'],
  )
})

test('readSse drains large single-chunk bursts with 200 mixed LF/CRLF events in exact order', async () => {
  const expected: string[] = []
  let burst = ''
  for (let i = 0; i < 200; i++) {
    const payload = JSON.stringify({ seq: i, text: `token-${i}` })
    expected.push(payload)
    burst += `data: ${payload}${i % 2 === 0 ? '\r\n\r\n' : '\n\n'}`
  }
  const events = await collect([burst])
  assert.deepEqual(
    events.map((e) => e.data),
    expected,
  )
})
