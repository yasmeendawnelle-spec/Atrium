import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configsFromMarkdown, parseConfigText, stripJsonc } from '../src/core/mcp/parse.ts'

test('reads a Claude Desktop style mcpServers block', () => {
  const options = parseConfigText(`{
    "mcpServers": {
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>" }
      }
    }
  }`)
  assert.equal(options.length, 1)
  const [o] = options
  assert.equal(o!.config.name, 'github')
  assert.equal(o!.config.transport, 'stdio')
  assert.deepEqual(o!.config.args, ['-y', '@modelcontextprotocol/server-github'])
  // The placeholder becomes a required, secret input with an empty value.
  assert.equal(o!.config.env!.GITHUB_PERSONAL_ACCESS_TOKEN, '')
  assert.deepEqual(o!.inputs, [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', target: 'env', required: true, secret: true }])
  assert.deepEqual(o!.config.secretKeys, ['env:GITHUB_PERSONAL_ACCESS_TOKEN'])
})

test('reads VS Code "servers", JSONC comments and trailing commas', () => {
  const options = parseConfigText(`{
    // VS Code style
    "servers": {
      "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer \${input:token}" }, },
    },
  }`)
  assert.equal(options.length, 1)
  assert.equal(options[0]!.config.transport, 'http')
  assert.equal(options[0]!.config.url, 'https://example.com/mcp')
  assert.equal(options[0]!.inputs[0]!.key, 'Authorization')
  assert.equal(options[0]!.inputs[0]!.secret, true)
})

test('reads a bare "name": {...} fragment', () => {
  const options = parseConfigText(`"fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }`)
  assert.equal(options.length, 1)
  assert.equal(options[0]!.config.name, 'fetch')
  assert.equal(options[0]!.config.command, 'uvx')
})

test('returns nothing for text that is not a server config', () => {
  assert.deepEqual(parseConfigText('hello world'), [])
  assert.deepEqual(parseConfigText('{"name": "x"}'), [])
})

test('stripJsonc leaves // inside strings alone', () => {
  assert.equal(JSON.parse(stripJsonc('{"url": "https://a.b/c" // note\n}')).url, 'https://a.b/c')
})

test('pulls configs out of README code blocks and drops duplicates', () => {
  const md = [
    '# Server',
    '```json',
    '{ "mcpServers": { "a": { "command": "npx", "args": ["-y", "pkg"] } } }',
    '```',
    'Again:',
    '```jsonc',
    '{ "mcpServers": { "a": { "command": "npx", "args": ["-y", "pkg"] } } }',
    '```',
    '```bash',
    'npm install pkg',
    '```',
  ].join('\n')
  const options = configsFromMarkdown(md, { kind: 'github', ref: 'o/r' })
  assert.equal(options.length, 1)
  assert.deepEqual(options[0]!.config.source, { kind: 'github', ref: 'o/r' })
})

test('a json block after a shell block is still found (fences pair up correctly)', () => {
  // Shaped like the official filesystem server README, which the old
  // regex misread: it took each closing fence for an opening one.
  const md = [
    'Run it:',
    '```bash',
    'npx -y @modelcontextprotocol/server-filesystem /tmp',
    '```',
    'Some prose with "command": "not-a-config" in it.',
    '1. In a list:',
    '   ```json',
    '   { "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }',
    '   ```',
    '~~~',
    '{ "mcpServers": { "other": { "url": "https://example.com/mcp" } } }',
    '~~~',
  ].join('\n')
  const options = configsFromMarkdown(md, { kind: 'github', ref: 'o/r' })
  assert.deepEqual(options.map((o) => o.config.name), ['filesystem', 'other'])
  assert.deepEqual(options[0]!.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
})
