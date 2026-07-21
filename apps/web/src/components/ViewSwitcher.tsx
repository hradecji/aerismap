'use client'

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { MORE_VIEW_IDS, isMoreView, moreButtonLabel, viewById } from '../lib/viewMenu'
import type { ViewId } from '../lib/views'

interface ViewSwitcherProps {
  active: ViewId
  onChange: (id: ViewId) => void
}

/**
 * Primary segmented control (Air Quality · Temperature · More ▾). “More”
 * opens a menu with the per-pollutant views + humidity — a popover on
 * desktop, a bottom-sheet card on phones (same markup, CSS decides). While a
 * menu view is active the trigger wears its name and renders pressed.
 */
export default function ViewSwitcher({ active, onChange }: ViewSwitcherProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Open menu: close on tap/click outside; Escape closes and restores focus.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const menuItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []
    )

  // Focus follows the menu: the checked (or first) item on open.
  useEffect(() => {
    if (!open) return
    const items = menuItems()
    const checked = items.find((el) => el.getAttribute('aria-checked') === 'true')
    ;(checked ?? items[0])?.focus()
  }, [open])

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = menuItems()
    if (items.length === 0) return
    e.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const delta = e.key === 'ArrowDown' ? 1 : -1
    items[(current + delta + items.length) % items.length]!.focus()
  }

  const pickFromMenu = (id: ViewId) => {
    onChange(id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="seg" role="group" aria-label="Map view">
      <button type="button" aria-pressed={active === 'eaqi'} onClick={() => onChange('eaqi')}>
        Air Quality <span className="segBadge">EAQI</span>
      </button>
      <button
        type="button"
        aria-pressed={active === 'temperature'}
        onClick={() => onChange('temperature')}
      >
        Temperature
      </button>
      <div className="moreWrap" ref={wrapRef}>
        <button
          ref={triggerRef}
          type="button"
          aria-pressed={isMoreView(active)}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {moreButtonLabel(active)}{' '}
          <span className="moreCaret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <>
            {/* Bottom-sheet backdrop; display:none on desktop. */}
            <div className="moreScrim" onClick={() => setOpen(false)} aria-hidden="true" />
            <div
              className="moreMenu"
              role="menu"
              aria-label="More views"
              ref={menuRef}
              onKeyDown={onMenuKeyDown}
            >
              <div className="moreMenuTitle" aria-hidden="true">
                More views
              </div>
              {MORE_VIEW_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={id === active}
                  onClick={() => pickFromMenu(id)}
                >
                  {viewById(id).label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
