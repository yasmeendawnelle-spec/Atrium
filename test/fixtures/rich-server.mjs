// Stdio MCP fixture exposing multimodal image/resource tool output, resources, and prompts.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

const server = new Server(
  { name: 'rich-v03', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'inspect_ui',
      description: 'Returns text, screenshot image, embedded resource, and filters invalid mime.',
      inputSchema: { type: 'object', properties: { page: { type: 'string' } } },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'inspect_ui') {
    return {
      content: [
        { type: 'text', text: 'UI inspection complete' },
        { type: 'image', mimeType: 'image/png', data: TINY_PNG_B64 },
        { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz48L3N2Zz4=' },
        { type: 'resource', resource: { uri: 'atrium://inline/note', mimeType: 'text/plain', text: 'inline secret note' } },
      ],
    }
  }
  return { content: [{ type: 'text', text: 'unknown' }], isError: true }
})

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'atrium://docs/spec', name: 'architecture-spec', description: 'Core architecture guide', mimeType: 'text/markdown' },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'atrium://docs/spec') {
    return {
      contents: [
        { uri: req.params.uri, mimeType: 'text/markdown', text: '# Architecture Spec\nUse ConPTY cleanly.' },
      ],
    }
  }
  throw new Error('Resource not found')
})

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'review_patch',
      description: 'Structured review prompt',
      arguments: [{ name: 'target', description: 'File to inspect', required: true }],
    },
  ],
}))

server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  description: 'Review prompt result',
  messages: [
    {
      role: 'user',
      content: { type: 'text', text: `Please review changes in ${String(req.params.arguments?.target ?? 'unknown')}` },
    },
  ],
}))

await server.connect(new StdioServerTransport())
