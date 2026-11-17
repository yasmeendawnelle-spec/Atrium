import { isValidElement, memo, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { shell } from '../lib/api.ts'
import { highlightCode } from '../lib/highlight.ts'
import { splitStreamingMarkdownBlocks } from '../lib/markdownBlocks.ts'

export { splitStreamingMarkdownBlocks }

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const first = Array.isArray(children) ? children[0] : children
  const className = isValidElement<{ className?: string }>(first) ? (first.props.className ?? '') : ''
  const lang = /language-([\w-]+)/.exec(className)?.[1]?.toLowerCase() || 'code'
  const raw = extractText(children).replace(/\n$/, '')
  const highlighted = highlightCode(raw, lang)

  const copy = () => {
    void navigator.clipboard.writeText(raw).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{lang}</span>
        <button type="button" className={`code-copy-btn${copied ? ' copied' : ''}`} onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('common.copied') : t('chat.copyCode')}</span>
        </button>
      </div>
      <pre>
        <code>{highlighted}</code>
      </pre>
    </div>
  )
}

const MarkdownRenderer = memo(function MarkdownRenderer({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              if (href && /^https?:\/\//.test(href)) void shell.openExternal(href)
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )
})

// Model output is untrusted: react-markdown renders no raw HTML by default,
// and links open in the user's browser instead of inside the app.
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(
    () => (streaming && text.length >= 600 ? splitStreamingMarkdownBlocks(text) : null),
    [text, streaming],
  )
  return (
    <div className="md">
      {blocks ? (
        blocks.map((block, idx) => <MarkdownRenderer key={idx} text={block} />)
      ) : (
        <MarkdownRenderer text={text} />
      )}
    </div>
  )
})
