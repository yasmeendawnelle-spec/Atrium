import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

export interface StudioSelectOption<T extends string | number = string> {
  value: T
  label: string
  hint?: string
  badge?: string
  disabled?: boolean
}

interface StudioSelectProps<T extends string | number = string> {
  value: T
  options: readonly StudioSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  className?: string
  fullWidth?: boolean
  minMenuWidth?: number
}

interface MenuPosition {
  left: number
  width: number
  maxHeight: number
  direction: 'up' | 'down'
  top?: number
  bottom?: number
}

export function StudioSelect<T extends string | number = string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择…',
  disabled = false,
  searchable,
  searchPlaceholder = '搜索选项…',
  className = '',
  fullWidth = false,
  minMenuWidth,
}: StudioSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [pos, setPos] = useState<MenuPosition | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const listboxId = useId()

  const showSearch = searchable ?? options.length >= 10
  const selectedOption = options.find((o) => o.value === value)

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        String(o.value).toLowerCase().includes(q) ||
        (o.hint && o.hint.toLowerCase().includes(q)) ||
        (o.badge && o.badge.toLowerCase().includes(q)),
    )
  }, [options, query])

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const closeMenu = () => {
    if (!open && !closing) return
    setClosing(true)
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
      setQuery('')
    }, 150)
  }

  const openMenu = () => {
    if (disabled) return
    clearCloseTimer()
    setClosing(false)
    setOpen(true)
    const idx = Math.max(
      0,
      options.findIndex((o) => o.value === value && !o.disabled),
    )
    setActiveIndex(idx)
  }

  const toggleMenu = () => {
    if (open && !closing) closeMenu()
    else openMenu()
  }

  useEffect(() => () => clearCloseTimer(), [])

  // Position anchored floating menu safely above scroll/overflow containers
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const btn = triggerRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const margin = 12
      const gap = 6
      const availDown = window.innerHeight - rect.bottom - gap - margin
      const availUp = rect.top - gap - margin
      const desiredHeight = Math.min(340, Math.max(150, options.length * 38 + (showSearch ? 52 : 16)))
      const direction: 'up' | 'down' = availDown < Math.min(desiredHeight, 220) && availUp > availDown + 36 ? 'up' : 'down'

      const targetW = Math.max(rect.width, minMenuWidth ?? 0)
      const width = Math.min(targetW, window.innerWidth - margin * 2)
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))

      setPos({
        left,
        width,
        direction,
        maxHeight: Math.min(340, Math.max(140, direction === 'down' ? availDown : availUp)),
        ...(direction === 'down'
          ? { top: rect.bottom + gap }
          : { bottom: window.innerHeight - rect.top + gap }),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, options.length, showSearch, minMenuWidth])

  // Dismiss on outside click / Escape
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Focus search bar or scroll selected item into view when opened
  useEffect(() => {
    if (!open || closing) return
    if (showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    const activeEl = menuRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    activeEl?.scrollIntoView({ block: 'nearest' })
  }, [open, closing, showSearch])

  const selectAt = (idx: number) => {
    const opt = filteredOptions[idx]
    if (!opt || opt.disabled) return
    onChange(opt.value)
    closeMenu()
    triggerRef.current?.focus()
  }

  const moveIndex = (delta: number) => {
    if (filteredOptions.length === 0) return
    let next = activeIndex
    for (let i = 0; i < filteredOptions.length; i++) {
      next = (next + delta + filteredOptions.length) % filteredOptions.length
      if (!filteredOptions[next]?.disabled) {
        setActiveIndex(next)
        const items = menuRef.current?.querySelectorAll<HTMLElement>('.studio-select-option')
        items?.[next]?.scrollIntoView({ block: 'nearest' })
        return
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveIndex(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveIndex(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(Math.max(0, filteredOptions.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selectAt(activeIndex)
    } else if (e.key === 'Tab') {
      closeMenu()
    }
  }

  const menuVisible = open && pos !== null

  return (
    <div
      className={`studio-select${open && !closing ? ' open' : ''}${fullWidth ? ' full' : ''}${className ? ` ${className}` : ''}`}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`input studio-select-trigger${open && !closing ? ' open' : ''}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={open ? listboxId : undefined}
        onClick={toggleMenu}
      >
        <span className="studio-select-value">
          <span className="studio-select-value-label">{selectedOption?.label ?? placeholder}</span>
          {selectedOption?.badge && <span className="studio-select-value-badge">{selectedOption.badge}</span>}
        </span>
        <ChevronDown size={14} className="studio-select-chev" aria-hidden />
      </button>

      {menuVisible &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            data-state={closing ? 'closing' : 'open'}
            data-direction={pos.direction}
            className="studio-select-popover"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
            }}
          >
            {showSearch && (
              <div className="studio-select-search">
                <Search size={13} aria-hidden />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActiveIndex(0)
                  }}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                />
              </div>
            )}

            <div className="studio-select-list">
              {filteredOptions.length === 0 ? (
                <div className="studio-select-empty">没有匹配选项</div>
              ) : (
                filteredOptions.map((opt, idx) => {
                  const isSelected = opt.value === value
                  const isHighlighted = idx === activeIndex
                  return (
                    <button
                      key={String(opt.value)}
                      type="button"
                      role="option"
                      disabled={opt.disabled}
                      aria-selected={isSelected}
                      data-active={isSelected || isHighlighted ? 'true' : undefined}
                      style={{ '--opt-i': Math.min(idx, 10) } as React.CSSProperties}
                      className={`studio-select-option${isSelected ? ' selected' : ''}${isHighlighted ? ' highlighted' : ''}`}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => selectAt(idx)}
                    >
                      <span className="studio-select-opt-dot" aria-hidden />
                      <span className="studio-select-opt-main">
                        <span className="studio-select-opt-label">{opt.label}</span>
                        {opt.hint && <span className="studio-select-opt-hint">{opt.hint}</span>}
                      </span>
                      {opt.badge && <span className="studio-select-opt-badge">{opt.badge}</span>}
                      <span className="studio-select-opt-check" aria-hidden>
                        {isSelected && <Check size={14} strokeWidth={2.3} />}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
