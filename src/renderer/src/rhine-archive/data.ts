export interface AtriumDetailBlock {
  heading: string
  body: string
}

export interface ArchiveRecord {
  id: string
  title: string
  en: string
  department: string
  category: string
  date: string
  lead: string
  clearance: string
  abstract: string
  findings: string[]
  source: string
  code?: string
  subtitle?: string
  statusLabel?: string
  isLive?: boolean
  chatId?: string
  detailBlocks?: AtriumDetailBlock[]
  logs?: string[]
  actionLabel?: string
  openAction?: () => Promise<void> | void
}

export let archiveColumns: string[] = [
  '对话档案',
  '插件与主题',
  '技能与记忆',
  'MCP 连接器',
  '自动化与内核',
]

export let categories: string[] = ['全部档案', ...archiveColumns]

export let records: ArchiveRecord[] = [
  {
    id: 'C-001',
    code: 'C-001',
    title: 'ATRIUM // ORBITAL ARCHIVE',
    en: 'CONVERSATIONS',
    department: '对话档案 // TERMINAL SESSIONS',
    category: '对话档案',
    date: '2026-SYS',
    lead: 'Atrium Desktop',
    clearance: 'VERIFIED',
    abstract: '实时对话、插件、技能与系统核心档案初始化中。',
    findings: ['等待同步实时工作区状态'],
    source: 'ATRIUM CORE',
    isLive: false,
  },
]

export function setArchiveCatalog(nextColumns: string[], nextRecords: ArchiveRecord[]): void {
  if (nextColumns.length > 0) {
    archiveColumns = [...nextColumns]
    categories = ['全部档案', ...archiveColumns]
  }
  if (nextRecords.length > 0) {
    records = nextRecords
  }
}

export function columnFiles(lane: number): number[] {
  const category = archiveColumns[((lane % archiveColumns.length) + archiveColumns.length) % archiveColumns.length]
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === category)
    .map(({ index }) => index)
}

export function fileLocation(index: number): { lane: number; row: number; slot: number } {
  const rec = records[index] ?? records[0]!
  const foundLane = archiveColumns.indexOf(rec.category)
  const lane = foundLane >= 0 ? foundLane : 0
  const files = columnFiles(lane)
  const pos = files.indexOf(index)
  const row = 12 + (pos >= 0 ? pos : 0)
  return { lane, row, slot: lane * 32 + row }
}

export function fileAtSlot(slot: number): number {
  const colLen = Math.max(1, archiveColumns.length)
  const rawLane = Math.floor(slot / 32)
  const lane = ((rawLane % colLen) + colLen) % colLen
  const files = columnFiles(lane)
  if (files.length === 0) return 0
  const idx = Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))
  return files[idx] ?? files[0] ?? 0
}
