// Tests for interactive Artifact parsing, streaming handling, and versioning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/shared/types.ts'
import { extractConversationArtifacts, splitMessageSegments, suggestedFilename } from '../src/renderer/src/lib/artifacts.ts'

test('splitMessageSegments replaces explicit <artifact> and <antArtifact> tags cleanly including streaming', () => {
  const full = [
    'Here is a widget:',
    '<antArtifact identifier="counter" type="text/html" title="Counter Widget">',
    '<div id="app">0</div>',
    '</antArtifact>',
    'Enjoy!',
  ].join('\n')

  const segs = splitMessageSegments(full, 'm0')
  assert.equal(segs.length, 3)
  assert.equal(segs[0]?.kind, 'markdown')
  assert.equal(segs[1]?.kind, 'artifact')
  if (segs[1]?.kind === 'artifact') {
    assert.equal(segs[1].artifact.identifier, 'counter')
    assert.equal(segs[1].artifact.kind, 'html')
    assert.equal(segs[1].artifact.title, 'Counter Widget')
    assert.equal(segs[1].artifact.streaming, false)
  }

  // Unclosed tag mid-stream still yields streaming artifact card without leaking XML
  const partial = 'Building:\n<artifact id="arch" type="mermaid" title="System Graph">\nflowchart LR\nA-->B'
  const pSegs = splitMessageSegments(partial, 'm1')
  assert.equal(pSegs.length, 2)
  assert.equal(pSegs[1]?.kind, 'artifact')
  if (pSegs[1]?.kind === 'artifact') {
    assert.equal(pSegs[1].artifact.streaming, true)
    assert.equal(pSegs[1].artifact.kind, 'mermaid')
  }
})

test('extractConversationArtifacts versions repeated identifiers and extracts rich fenced diagrams', () => {
  const messages: Message[] = [
    { role: 'user', text: 'Create a chart and update it' },
    {
      role: 'assistant',
      text: '<artifact identifier="chart-1" type="svg" title="Chart v1"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></artifact>',
      toolCalls: [],
    },
    { role: 'user', text: 'Update color' },
    {
      role: 'assistant',
      text: [
        '<artifact identifier="chart-1" type="svg" title="Chart v2"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg></artifact>',
        '',
        '```mermaid',
        'flowchart TD',
        '  Start --> End',
        '```',
      ].join('\n'),
      toolCalls: [],
    },
  ]

  const items = extractConversationArtifacts(messages)
  assert.equal(items.length, 3)
  assert.equal(items[0]?.version, 1)
  assert.equal(items[1]?.version, 2)
  assert.equal(items[2]?.kind, 'mermaid')
  assert.equal(suggestedFilename(items[2]!), 'flowchart-diagram.mmd')
})
