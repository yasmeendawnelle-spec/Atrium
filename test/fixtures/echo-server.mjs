// A tiny stdio MCP server used by the integration test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-fixture', version: '1.2.3' })

server.registerTool(
  'echo',
  { description: 'Echo the text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
)

server.registerTool(
  'env',
  { description: 'Return an environment variable', inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] ?? '(unset)' }] }),
)

server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'it failed' }],
}))

process.stderr.write('echo-fixture ready\n')
await server.connect(new StdioServerTransport())
