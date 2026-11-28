import './rhine-stage.css'
import { call } from '../lib/api.ts'
import { playRhineSound, unlockRhineAudio } from '../lib/rhineAudio.ts'
import { setState } from '../lib/store.ts'
import { brandHeading } from './brand.ts'
import {
  archiveColumns,
  columnFiles,
  fileLocation,
  records,
  setArchiveCatalog,
  type ArchiveRecord,
} from './data.ts'
import { DocumentDecryption } from './document-decryption.ts'
import { HudProjection } from './hud-projection.ts'
import { InspectionOverlay } from './inspection-overlay.ts'
import { ModelViewer } from './model-viewer.ts'
import { ArchiveScene } from './scene.ts'
import { ScopedThemePainter } from './theme-ui.ts'
import { viewportLayout } from './viewport-layout.ts'
import { cellKey, type ArchiveCell } from './archive-loop.ts'

export interface MountArchiveOptions {
  host: HTMLElement
  initialDark: boolean
  initialColumns: string[]
  initialRecords: ArchiveRecord[]
  onToggleTheme: (dark: boolean) => void
  onOpenChatDetail?: (chatId: string) => void
  onCloseWorkspace: () => void
}

export interface MountedRhineArchive {
  updateCatalog: (columns: string[], records: ArchiveRecord[]) => void
  setDarkTheme: (dark: boolean) => void
  requestExit: (sound?: 'back' | 'confirm') => void
  dispose: () => void
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function mountRhineArchiveStage(opts: MountArchiveOptions): MountedRhineArchive {
  const { host, onToggleTheme, onOpenChatDetail, onCloseWorkspace } = opts
  setArchiveCatalog(opts.initialColumns, opts.initialRecords)

  host.innerHTML = `
    <div class="rla-drag-strip" aria-hidden="true"></div>
    <div id="viewport">
      <div id="stage" data-mode="archive" data-layout="desktop">
        <div id="three-scene" class="three-scene"></div>
        <div class="scene-atmosphere archive-atmosphere"></div>
        <header class="brand">${brandHeading}</header>
        <nav class="system-nav" aria-label="系统导航">
          <button type="button" data-action="search"><span class="nav-glyph">⌕</span> ARCHIVE INDEX <span class="key">/</span></button>
          <button type="button" data-action="theme" title="切换日间 / 暗室极性"><span id="rla-theme-label">☾ SLATE</span></button>
          <button type="button" class="nav-workspace-btn" data-action="exit-workspace">← <span>标准工作台</span></button>
        </nav>
        <svg id="inspection-marks" viewBox="0 0 1920 1080" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
        <div id="inspection-text" aria-hidden="true">CONFIDENTIALITY:<strong>GENERAL BUSINESS USE</strong></div>
        <section id="archive-ui" class="archive-ui" aria-label="档案选择">
          <div class="archive-callout">
            <div class="eyebrow">INTERNAL DATABASE <span>／</span> <span id="archive-category">对话档案</span></div>
            <button type="button" class="file-title" data-action="open">FILE NUMBER: <span id="selected-id">C-001</span><span class="file-open">↗</span></button>
            <div class="callout-rule"><i></i></div>
            <div class="file-summary"><span id="selected-title"></span><span id="selected-clearance">VERIFIED</span></div>
            <div class="callout-actions">
              <button type="button" class="read-file" data-action="open">ACCESS FILE <span>→</span></button>
              <button type="button" class="open-workspace-mini" data-action="workspace-open">打开条目 <span>↗</span></button>
            </div>
          </div>
          <div id="hover-label" class="hover-label" hidden>X-<span id="hover-code">001</span> / <span id="hover-title"></span></div>
          <div class="archive-counter"><span class="tiny-label">ARCHIVE / SELECT</span><div><span id="selected-number">01</span><i>/</i><span class="count-total">08</span></div></div>
          <div class="archive-navigation"><button type="button" data-action="prev" aria-label="上一个档案">↑</button><div id="file-ticks" class="file-ticks"></div><button type="button" data-action="next" aria-label="下一个档案">↓</button></div>
          <div class="column-navigation"><button type="button" data-action="column-prev" aria-label="上一列">←</button><div><span id="column-number">COLUMN <span id="column-index">01</span> / 05</span><strong id="column-name">对话档案</strong></div><button type="button" data-action="column-next" aria-label="下一列">→</button></div>
          <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 切换列 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 前后档案 <span>／</span> <kbd>ENTER</kbd> 读取 <span>／</span> <kbd>ESC</kbd> 工作台</div>
        </section>
        <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
          <button type="button" class="back-button" data-action="back">← <span>ARCHIVE OVERVIEW</span><small>ESC</small></button>
          <div class="object-caption"><span id="object-id">NO.C-001</span><div>INTERNAL DATABASE</div><small>DRAG TO INSPECT <span>↔</span></small></div>
          <article class="detail-content">
            <div class="detail-kicker"><span id="detail-department"></span><i></i><span id="detail-code"></span></div>
            <div class="detail-title-cn"><h2 id="detail-title"></h2><span id="detail-date"></span></div>
            <div class="detail-subtitle" id="detail-en"></div>
            <div class="detail-rule"><i></i></div>
            <dl class="metadata">
              <div><dt>DEPARTMENT</dt><dd id="meta-dept"></dd></div>
              <div><dt>SOURCE</dt><dd id="meta-source"></dd></div>
              <div><dt>UPDATED</dt><dd id="meta-date"></dd></div>
              <div><dt>STATUS</dt><dd id="meta-clearance"></dd></div>
            </dl>
            <nav class="detail-tabs" role="tablist">
              <button type="button" data-tab="overview" class="active" aria-selected="true"><span>01</span> 概述</button>
              <button type="button" data-tab="detail" aria-selected="false"><span>02</span> 详情记录</button>
              <button type="button" data-tab="logs" aria-selected="false"><span>03</span> 操作日志</button>
              <i class="tab-indicator"></i>
            </nav>
            <section class="tab-panel" data-panel="overview"></section>
            <section class="tab-panel" data-panel="detail" hidden></section>
            <section class="tab-panel" data-panel="logs" hidden></section>
            <div class="detail-actions-row">
              <button type="button" class="atrium-open-btn" data-action="workspace-open">
                <span id="detail-open-label">在工作台打开 →</span>
              </button>
              <button type="button" class="solid-button" data-action="viewer">
                <span>360° 查看文档模型</span><span class="action-arrow">↗</span>
              </button>
            </div>
          </article>
        </section>
      </div>

      <div id="search-overlay" class="modal-backdrop" hidden>
        <section class="terminal-modal" role="dialog" aria-modal="true" aria-label="档案索引检索">
          <header class="modal-top">
            <div class="terminal-prompt"><span>RHINE LAB // ARCHIVE INDEX</span><strong>档案索引与全局检索</strong></div>
            <button type="button" class="modal-close" data-action="close-modal">CLOSE <span>ESC</span></button>
          </header>
          <div class="search-field">
            <span>SEARCH:</span>
            <input id="search-input" type="search" placeholder="输入编号 (C-001)、标题、工作区或分类..." autocomplete="off" />
          </div>
          <div class="category-filters" id="category-filters"></div>
          <div class="result-header"><span>MATCHING ARCHIVES</span><span id="result-count">40</span></div>
          <div id="search-results" class="search-results"></div>
        </section>
      </div>
      <div id="rla-exit-veil" class="rla-exit-veil" aria-hidden="true">
        <div class="rla-exit-stamp">
          <div class="rla-exit-kicker"><span class="rla-exit-pip"></span>RHINE LAB // MODE HANDOVER</div>
          <div class="rla-exit-title">RETURNING TO WORKBENCH</div>
          <div class="rla-exit-progress"><i></i></div>
        </div>
      </div>
    </div>
  `

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<T>(sel)!
  const viewportEl = q('#viewport')
  const stageEl = q('#stage')
  const sceneHost = q('#three-scene')
  const archiveUi = q('#archive-ui')
  const detailUi = q('#detail-ui')
  const searchOverlay = q('#search-overlay')
  const searchInput = q<HTMLInputElement>('#search-input')
  const searchResults = q('#search-results')
  const resultCount = q('#result-count')
  const categoryFiltersEl = q('#category-filters')
  const hoverLabel = q('#hover-label')
  const ticksEl = q('#file-ticks')
  const detailContent = q('.detail-content')
  const inspectionTextEl = q('#inspection-text')

  const painter = new ScopedThemePainter(host)
  const scene = new ArchiveScene(sceneHost)
  scene.setArchiveCoverage(true)
  const inspection = new InspectionOverlay()
  const decryption = new DocumentDecryption()
  const hud = new HudProjection(stageEl)

  let darkTheme = opts.initialDark
  let mode: 'archive' | 'detail' = 'archive'
  let current = 0
  let currentTab: 'overview' | 'detail' | 'logs' = 'overview'
  let searchCategory = '全部档案'
  let searchOpen = false
  let pointerHover = { x: 0, y: 0 }
  let disposed = false
  let exiting = false
  let exitTimer: number | null = null
  let rafId = 0
  const ac = new AbortController()
  const hydratedChatIds = new Set<string>()

  const viewer = new ModelViewer(
    viewportEl,
    () => {
      if (disposed) return
      unlockRhineAudio()
      playRhineSound('back')
      scene.setPresentationVisible(true)
    },
    (snd) => {
      unlockRhineAudio()
      if (snd === 'explode') playRhineSound('explode')
      else if (snd === 'assemble') playRhineSound('assemble')
      else playRhineSound('ui-tick')
    },
  )

  const syncThemeButton = () => {
    const label = q('#rla-theme-label')
    label.textContent = darkTheme ? '☀ DAYLIGHT' : '☾ SLATE'
    scene.setTheme(darkTheme, false)
    viewer.setTheme(darkTheme ? 1 : 0)
  }

  const updateViewportLayout = () => {
    const w = Math.max(320, host.clientWidth || window.innerWidth)
    const h = Math.max(240, host.clientHeight || window.innerHeight)
    const lay = viewportLayout(w, h, false, false)
    stageEl.style.width = `${lay.width}px`
    stageEl.style.height = `${lay.height}px`
    stageEl.style.transform = `translate(-50%, -50%) scale(${lay.scale})`
    stageEl.dataset.layout = lay.kind
    scene.resize()
    hud.invalidate()
  }

  const renderCallout = () => {
    const rec = records[current] ?? records[0]!
    const loc = fileLocation(current)
    const laneFiles = columnFiles(loc.lane)
    const posInCol = Math.max(0, laneFiles.indexOf(current))
    const code = rec.code ?? rec.id

    q('#archive-category').textContent = rec.category
    q('#selected-id').textContent = code
    q('#selected-title').textContent = rec.title
    q('#selected-clearance').textContent = rec.clearance
    q('#selected-number').textContent = String(posInCol + 1).padStart(2, '0')
    q('.count-total').textContent = String(laneFiles.length).padStart(2, '0')
    q('#column-index').textContent = String(loc.lane + 1).padStart(2, '0')
    q('#column-name').textContent = archiveColumns[loc.lane] ?? rec.category

    ticksEl.innerHTML = laneFiles
      .map((idx, i) => {
        const r = records[idx]
        const label = `${r?.code ?? String(i + 1).padStart(2, '0')} · ${r?.title ?? ''}`
        return `<button type="button" role="tab" aria-selected="${idx === current}" class="${idx === current ? 'selected' : ''}" data-tick-index="${idx}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"></button>`
      })
      .join('')
  }

  const setTab = (tab: 'overview' | 'detail' | 'logs') => {
    currentTab = tab
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('.detail-tabs button')]
    tabs.forEach((btn) => {
      const active = btn.dataset.tab === tab
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-selected', String(active))
    })
    const panels = [...host.querySelectorAll<HTMLElement>('.tab-panel')]
    panels.forEach((p) => {
      p.hidden = p.dataset.panel !== tab
    })
    const activeBtn = tabs.find((b) => b.dataset.tab === tab)
    const indicator = q('.tab-indicator')
    if (activeBtn) {
      indicator.style.width = `${activeBtn.offsetWidth}px`
      indicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`
    }
  }

  const renderDetail = () => {
    const rec = records[current] ?? records[0]!
    const code = rec.code ?? rec.id
    q('#object-id').textContent = `NO.${code}`
    q('#detail-department').textContent = rec.department
    q('#detail-code').textContent = `FILE ${code}`
    q('#detail-title').textContent = rec.title
    q('#detail-date').textContent = rec.date
    q('#detail-en').textContent = rec.en
    q('#meta-dept').textContent = rec.department.split('//')[0]?.trim() || rec.category
    q('#meta-source').textContent = rec.lead
    q('#meta-date').textContent = rec.date
    q('#meta-clearance').textContent = rec.clearance
    q('#detail-open-label').textContent = rec.actionLabel || '在工作台打开 →'
    inspectionTextEl.innerHTML = `CONFIDENTIALITY:<strong>${escapeHtml(rec.clearance)}</strong>`

    const overviewPanel = q('[data-panel="overview"]')
    overviewPanel.innerHTML = `
      <span class="panel-label">SUMMARY // 核心摘要</span>
      <p>${escapeHtml(rec.abstract)}</p>
      <ul class="research-notes">${rec.findings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
    `

    const detailPanel = q('[data-panel="detail"]')
    const blocks = rec.detailBlocks ?? [{ heading: '01 // 档案记录', body: rec.abstract }]
    detailPanel.innerHTML = blocks
      .map(
        (b) => `
      <div style="margin-bottom: 18px;">
        <span class="panel-label">${escapeHtml(b.heading)}</span>
        <p>${escapeHtml(b.body)}</p>
      </div>`,
      )
      .join('')

    const logsPanel = q('[data-panel="logs"]')
    const logs = rec.logs ?? [`${rec.date} ARCHIVE READY`]
    logsPanel.innerHTML = `
      <span class="panel-label">TELEMETRY LOGS // 系统流转记录</span>
      <div class="log-row"><pre class="detail-log-body">${escapeHtml(logs.join('\n'))}</pre></div>
    `
    setTab(currentTab)
    decryption.reset(detailContent, false)

    // Hydrate full real chat transcript lazily if opening a conversation cassette
    if (rec.chatId && !hydratedChatIds.has(rec.chatId)) {
      hydratedChatIds.add(rec.chatId)
      const chatId = rec.chatId
      onOpenChatDetail?.(chatId)
      void call('chats.get', chatId)
        .then((conv) => {
          if (!disposed && conv) {
            setState((s) => ({ conversations: { ...s.conversations, [chatId]: conv } }))
          }
        })
        .catch(() => undefined)
    }
  }

  const selectIndex = (index: number, navigation?: Parameters<ArchiveScene['select']>[1]) => {
    const safeIdx = Math.max(0, Math.min(records.length - 1, index))
    current = safeIdx
    scene.select(safeIdx, navigation)
    renderCallout()
    if (mode === 'detail') renderDetail()
  }

  const stepFile = (delta: number) => {
    const cell = scene.currentCell
    const files = columnFiles(
      ((cell.lane % archiveColumns.length) + archiveColumns.length) % archiveColumns.length,
    )
    if (files.length === 0) return
    const pos = Math.max(0, files.indexOf(current))
    const nextIdx = files[(pos + delta + files.length) % files.length] ?? 0
    unlockRhineAudio()
    playRhineSound('ui-tick')
    selectIndex(nextIdx, { axis: 'row', direction: delta })
  }

  const stepColumn = (delta: number) => {
    const cell = scene.currentCell
    const nextLane = (cell.lane + delta + archiveColumns.length) % archiveColumns.length
    const files = columnFiles(nextLane)
    const nextIdx = files[0] ?? 0
    unlockRhineAudio()
    playRhineSound('column')
    selectIndex(nextIdx, { axis: 'lane', direction: delta })
  }

  const enterDetail = () => {
    if (mode === 'detail') return
    mode = 'detail'
    stageEl.dataset.mode = 'detail'
    archiveUi.hidden = true
    detailUi.hidden = false
    currentTab = 'overview'
    scene.setMode('detail')
    renderDetail()
    unlockRhineAudio()
    playRhineSound('ui-open')
    hud.invalidate()
  }

  const leaveDetail = () => {
    if (mode === 'archive') return
    mode = 'archive'
    stageEl.dataset.mode = 'archive'
    detailUi.hidden = true
    archiveUi.hidden = false
    scene.setMode('archive')
    decryption.reset(detailContent, true)
    unlockRhineAudio()
    playRhineSound('back')
    hud.invalidate()
  }

  const renderSearch = () => {
    const cats = ['全部档案', ...archiveColumns]
    categoryFiltersEl.innerHTML = cats
      .map(
        (cat) =>
          `<button type="button" class="${cat === searchCategory ? 'active' : ''}" data-filter-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`,
      )
      .join('')

    const queryText = searchInput.value.trim().toLowerCase()
    const matched = records
      .map((rec, index) => ({ rec, index }))
      .filter(({ rec }) => {
        if (searchCategory !== '全部档案' && rec.category !== searchCategory) return false
        if (!queryText) return true
        return (
          rec.title.toLowerCase().includes(queryText) ||
          (rec.code ?? rec.id).toLowerCase().includes(queryText) ||
          rec.category.toLowerCase().includes(queryText) ||
          rec.abstract.toLowerCase().includes(queryText)
        )
      })
    resultCount.textContent = String(matched.length)
    searchResults.innerHTML =
      matched.length === 0
        ? `<div class="empty-results"><strong>未检索到匹配档案</strong><p>请尝试搜索文件编号或切换分类标签。</p></div>`
        : matched
            .map(
              ({ rec, index }) => `
            <button type="button" class="result-row" data-search-index="${index}">
              <span><strong>${escapeHtml(rec.code ?? rec.id)}</strong> ${escapeHtml(rec.title)}</span>
              <small>${escapeHtml(rec.category)}</small>
            </button>`,
            )
            .join('')
  }

  const setSearchOpen = (open: boolean) => {
    searchOpen = open
    searchOverlay.hidden = !open
    if (open) {
      renderSearch()
      window.setTimeout(() => searchInput.focus(), 20)
    }
  }

  scene.onSelect = (index: number, cell?: ArchiveCell) => {
    unlockRhineAudio()
    playRhineSound('ui-tick')
    if (cell && cellKey(cell) === cellKey(scene.currentCell)) {
      enterDetail()
      return
    }
    selectIndex(index, cell ? { cell } : undefined)
  }

  scene.onHover = (index: number | null) => {
    if (index === null || mode !== 'archive') {
      hoverLabel.hidden = true
      return
    }
    const rec = records[index]
    if (!rec) {
      hoverLabel.hidden = true
      return
    }
    q('#hover-code').textContent = rec.code ?? rec.id
    q('#hover-title').textContent = rec.title
    hoverLabel.hidden = false
  }

  scene.onNavigate = (axis, direction) => {
    if (axis === 'row') stepFile(direction)
    else stepColumn(direction)
  }

  host.addEventListener(
    'click',
    (ev) => {
      const target = ev.target as HTMLElement
      const tick = target.closest<HTMLElement>('[data-tick-index]')
      if (tick) {
        const idx = Number(tick.dataset.tickIndex)
        if (Number.isFinite(idx)) {
          unlockRhineAudio()
          playRhineSound('ui-tick')
          selectIndex(idx)
        }
        return
      }
      const tabBtn = target.closest<HTMLElement>('[data-tab]')
      if (tabBtn) {
        const tab = tabBtn.dataset.tab
        if (tab === 'overview' || tab === 'detail' || tab === 'logs') {
          unlockRhineAudio()
          playRhineSound('ui-tick')
          setTab(tab)
        }
        return
      }
      const filterBtn = target.closest<HTMLElement>('[data-filter-cat]')
      if (filterBtn) {
        searchCategory = filterBtn.dataset.filterCat ?? '全部档案'
        unlockRhineAudio()
        playRhineSound('ui-tick')
        renderSearch()
        return
      }
      const searchItem = target.closest<HTMLElement>('[data-search-index]')
      if (searchItem) {
        const idx = Number(searchItem.dataset.searchIndex)
        setSearchOpen(false)
        if (Number.isFinite(idx)) {
          unlockRhineAudio()
          playRhineSound('ui-open')
          selectIndex(idx)
          if (mode === 'detail') renderDetail()
        }
        return
      }

      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
      if (!action) return
      if (action === 'open') enterDetail()
      else if (action === 'back') leaveDetail()
      else if (action === 'prev') stepFile(-1)
      else if (action === 'next') stepFile(1)
      else if (action === 'column-prev') stepColumn(-1)
      else if (action === 'column-next') stepColumn(1)
      else if (action === 'search') {
        unlockRhineAudio()
        playRhineSound('ui-tick')
        setSearchOpen(true)
      } else if (action === 'close-modal') {
        setSearchOpen(false)
      } else if (action === 'theme') {
        unlockRhineAudio()
        playRhineSound('ui-toggle')
        darkTheme = !darkTheme
        syncThemeButton()
        onToggleTheme(darkTheme)
      } else if (action === 'exit-workspace') {
        requestExit('back')
      } else if (action === 'workspace-open') {
        const rec = records[current]
        if (rec?.openAction) {
          void rec.openAction()
        }
      } else if (action === 'viewer') {
        const rec = records[current] ?? records[0]!
        unlockRhineAudio()
        playRhineSound('ui-open')
        scene.setPresentationVisible(false)
        viewer.open(
          rec.code ?? rec.id,
          rec.title,
          () => scene.createAssemblyModel(),
          false,
        )
      }
    },
    { signal: ac.signal },
  )

  searchInput.addEventListener('input', () => renderSearch(), { signal: ac.signal })
  searchOverlay.addEventListener(
    'click',
    (ev) => {
      if (ev.target === searchOverlay) setSearchOpen(false)
    },
    { signal: ac.signal },
  )

  host.addEventListener(
    'pointermove',
    (ev) => {
      const rect = host.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        pointerHover = {
          x: ((ev.clientX - rect.left) / rect.width - 0.5) * 2,
          y: ((ev.clientY - rect.top) / rect.height - 0.5) * 2,
        }
      }
    },
    { signal: ac.signal, passive: true },
  )

  const requestExit = (sound: 'back' | 'confirm' = 'back') => {
    if (disposed || exiting) return
    exiting = true
    if (searchOpen) setSearchOpen(false)
    if (viewer.isOpen) viewer.close()
    if (mode === 'detail') scene.setMode('archive')
    unlockRhineAudio()
    playRhineSound(sound)
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      onCloseWorkspace()
      return
    }
    host.dataset.exiting = 'true'
    scene.setPresentationVisible(false)
    exitTimer = window.setTimeout(() => {
      exitTimer = null
      if (!disposed) onCloseWorkspace()
    }, 580)
  }

  window.addEventListener(
    'atrium:rhine-archive-request-exit',
    () => requestExit('back'),
    { signal: ac.signal },
  )

  window.addEventListener(
    'keydown',
    (ev) => {
      if (disposed || exiting || viewer.isOpen) return
      if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        if (searchOpen) {
          setSearchOpen(false)
          return
        }
        if (mode === 'detail') {
          leaveDetail()
          return
        }
        requestExit('back')
        return
      }
      if (searchOpen) return
      if (ev.key === '/') {
        ev.preventDefault()
        setSearchOpen(true)
        return
      }
      if (mode === 'archive') {
        if (ev.key === 'ArrowUp') {
          ev.preventDefault()
          stepFile(-1)
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault()
          stepFile(1)
        } else if (ev.key === 'ArrowLeft') {
          ev.preventDefault()
          stepColumn(-1)
        } else if (ev.key === 'ArrowRight') {
          ev.preventDefault()
          stepColumn(1)
        } else if (ev.key === 'Enter') {
          ev.preventDefault()
          enterDetail()
        }
      }
    },
    { capture: true, signal: ac.signal },
  )

  const ro = new ResizeObserver(() => updateViewportLayout())
  ro.observe(host)
  updateViewportLayout()
  syncThemeButton()
  painter.paint(darkTheme ? 1 : 0)
  scene.setTheme(darkTheme, true)
  renderCallout()

  void scene
    .load()
    .then(() => {
      if (disposed) return
      scene.enterArchiveImmediately(current)
      renderCallout()
      sceneHost.style.opacity = '1'
      hud.invalidate()
    })
    .catch((err) => {
      console.error('Failed to load Rhine Lab 3D archive assets:', err)
    })

  const tickLoop = () => {
    if (disposed) return
    rafId = requestAnimationFrame(tickLoop)
    const nowSec = performance.now() / 1000
    if (viewer.isOpen) {
      viewer.update(nowSec)
    } else if (!scene.presentationHidden) {
      scene.update(nowSec)
    }
    const curDark = scene.themeAmount
    painter.paint(curDark)
    viewer.setTheme(curDark)

    const decFrame = scene.decryptionFrame
    const showInsp = mode === 'detail' && scene.detailVisibility > 0.2
    inspection.render(
      decFrame,
      (x, y) => scene.projectCard(x, y),
      showInsp,
      mode === 'detail' && !viewer.isOpen,
    )
    if (mode === 'detail' && !viewer.isOpen) {
      decryption.update(nowSec, decFrame, false)
    }
    const vis = mode === 'detail' && !viewer.isOpen ? scene.detailVisibility : 0
    detailContent.style.opacity = String(vis)
    detailContent.style.translate = `0 ${(1 - vis) * 18}px`
    detailContent.inert = vis < 0.1
    hud.update(viewer.isOpen ? 0 : mode === 'archive' ? 0.65 : 0.35, pointerHover)
  }
  rafId = requestAnimationFrame(tickLoop)

  return {
    updateCatalog(nextColumns, nextRecords) {
      setArchiveCatalog(nextColumns, nextRecords)
      current = Math.max(0, Math.min(records.length - 1, current))
      scene.refreshSelectedLabel()
      renderCallout()
      if (mode === 'detail') renderDetail()
    },
    setDarkTheme(nextDark) {
      darkTheme = nextDark
      syncThemeButton()
    },
    requestExit,
    dispose() {
      if (disposed) return
      disposed = true
      if (exitTimer !== null) {
        window.clearTimeout(exitTimer)
        exitTimer = null
      }
      delete host.dataset.exiting
      cancelAnimationFrame(rafId)
      ac.abort()
      ro.disconnect()
      viewer.dispose()
      scene.dispose()
      host.innerHTML = ''
    },
  }
}
