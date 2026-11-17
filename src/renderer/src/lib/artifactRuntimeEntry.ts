import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as Recharts from 'recharts'
import { transform } from 'sucrase'
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Award,
  BarChart2,
  BarChart3,
  Bell,
  BookOpen,
  Bookmark,
  Box,
  Briefcase,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cloud,
  Code,
  Code2,
  Compass,
  Copy,
  Cpu,
  CreditCard,
  Database,
  DollarSign,
  Download,
  Edit,
  Edit3,
  ExternalLink,
  Eye,
  File,
  FileCode,
  FileText,
  Filter,
  Flame,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommit,
  Globe,
  Grid,
  Hash,
  Heart,
  HelpCircle,
  Home,
  Image,
  Inbox,
  Info,
  Key,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Link,
  List,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Maximize2,
  Menu,
  MessageCircle,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  MoreVertical,
  Package,
  Paperclip,
  Pause,
  Pencil,
  Percent,
  PieChart,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Sliders,
  Sparkles,
  Star,
  Sun,
  Table,
  Tag,
  Target,
  Terminal,
  ThumbsUp,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Users,
  Video,
  Wallet,
  Wifi,
  Wrench,
  X,
  XCircle,
  Zap,
} from 'lucide-react'

const KNOWN_ICONS: Record<string, unknown> = {
  Activity,
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Award,
  BarChart2,
  BarChart3,
  Bell,
  BookOpen,
  Bookmark,
  Box,
  Briefcase,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cloud,
  Code,
  Code2,
  Compass,
  Copy,
  Cpu,
  CreditCard,
  Database,
  DollarSign,
  Download,
  Edit,
  Edit3,
  ExternalLink,
  Eye,
  File,
  FileCode,
  FileText,
  Filter,
  Flame,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommit,
  Globe,
  Grid,
  Hash,
  Heart,
  HelpCircle,
  Home,
  Image,
  Inbox,
  Info,
  Key,
  Layers,
  LayoutDashboard,
  Lightbulb,
  Link,
  List,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Maximize2,
  Menu,
  MessageCircle,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  MoreVertical,
  Package,
  Paperclip,
  Pause,
  Pencil,
  Percent,
  PieChart,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Sliders,
  Sparkles,
  Star,
  Sun,
  Table,
  Tag,
  Target,
  Terminal,
  ThumbsUp,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Users,
  Video,
  Wallet,
  Wifi,
  Wrench,
  X,
  XCircle,
  Zap,
}

function FallbackIcon(props: { size?: number; className?: string }) {
  const size = props?.size ?? 16
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: props?.className,
    },
    React.createElement('circle', { cx: 12, cy: 12, r: 9 }),
  )
}

const lucideProxy = new Proxy(KNOWN_ICONS, {
  get(target, prop) {
    if (prop === '__esModule') return true
    if (typeof prop !== 'string') return undefined
    if (prop in target) return target[prop]
    return FallbackIcon
  },
})

const modules: Record<string, unknown> = {
  react: { ...React, default: React },
  'react-dom': { ...ReactDOM, default: ReactDOM },
  'react-dom/client': { ...ReactDOMClient, default: ReactDOMClient },
  'lucide-react': lucideProxy,
  recharts: { ...Recharts, default: Recharts },
}

function resolveModule(id: string): unknown {
  if (id in modules) return modules[id]
  if (id.startsWith('@/components/ui/')) {
    return {
      Card: ({ className = '', children }: { className?: string; children?: React.ReactNode }) =>
        React.createElement('div', { className: `card ${className}` }, children),
      CardHeader: ({ className = '', children }: { className?: string; children?: React.ReactNode }) =>
        React.createElement('div', { className: `card-header ${className}` }, children),
      CardTitle: ({ className = '', children }: { className?: string; children?: React.ReactNode }) =>
        React.createElement('h3', { className: `card-title ${className}` }, children),
      CardContent: ({ className = '', children }: { className?: string; children?: React.ReactNode }) =>
        React.createElement('div', { className: `card-content ${className}` }, children),
      Button: ({ className = '', children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
        React.createElement('button', { type: 'button', className: `btn ${className}`, ...rest }, children),
      Badge: ({ className = '', children }: { className?: string; children?: React.ReactNode }) =>
        React.createElement('span', { className: `badge ${className}` }, children),
    }
  }
  throw new Error(`Unsupported import in offline React sandbox: "${id}"`)
}

function compileArtifactComponent(source: string): React.ComponentType {
  const transformed = transform(source, {
    transforms: ['jsx', 'typescript', 'imports'],
    production: true,
    jsxPragma: 'React.createElement',
    jsxFragmentPragma: 'React.Fragment',
  })

  const mod: { exports: Record<string, unknown> } = { exports: {} }
  const fn = new Function('require', 'module', 'exports', 'React', 'ReactDOM', transformed.code)
  fn(resolveModule, mod, mod.exports, React, ReactDOMClient)

  const exported = mod.exports
  const Comp =
    (exported.default as React.ComponentType | undefined) ??
    (Object.values(exported).find((v) => typeof v === 'function') as React.ComponentType | undefined)

  if (!Comp) {
    throw new Error('Export a React component (e.g. `export default function App() { ... }`) to render this artifact.')
  }
  return Comp
}

function renderArtifact(source: string, mountEl: HTMLElement): void {
  const Comp = compileArtifactComponent(source)

  class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
    constructor(props: { children: React.ReactNode }) {
      super(props)
      this.state = { err: null }
    }
    static getDerivedStateFromError(err: Error) {
      return { err }
    }
    render() {
      if (this.state.err) {
        return React.createElement(
          'div',
          { className: 'artifact-err-box' },
          React.createElement('strong', null, 'Render error'),
          React.createElement('pre', null, this.state.err.stack || this.state.err.message),
        )
      }
      return this.props.children
    }
  }

  const root = ReactDOMClient.createRoot(mountEl)
  root.render(React.createElement(ErrorBoundary, null, React.createElement(Comp)))
}

;(window as unknown as { __ATRIUM_REACT_RUNTIME__?: unknown }).__ATRIUM_REACT_RUNTIME__ = {
  compileArtifactComponent,
  renderArtifact,
}
