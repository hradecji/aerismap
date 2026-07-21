'use client'

import { useEffect, useRef, useState } from 'react'
import type { AreaMode } from '../lib/areas'
import { NARROW_QUERY, useMediaQuery } from '../lib/useMediaQuery'
import type { KindFilter } from '../lib/views'

interface LayersPanelProps {
  kinds: KindFilter
  onKindsChange: (kinds: KindFilter) => void
  showStale: boolean
  onShowStaleChange: (show: boolean) => void
  areaMode: AreaMode
  onAreaModeChange: (mode: AreaMode) => void
  /** false → the areas snapshot couldn't be loaded; fills are off. */
  areasAvailable: boolean
}

function LayersControls({
  kinds,
  onKindsChange,
  showStale,
  onShowStaleChange,
  areaMode,
  onAreaModeChange,
  areasAvailable,
}: LayersPanelProps) {
  return (
    <>
      <h2 className="panelTitle">Stations</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={kinds.reference}
          onChange={(e) => onKindsChange({ ...kinds, reference: e.target.checked })}
        />
        Official stations
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={kinds.community}
          onChange={(e) => onKindsChange({ ...kinds, community: e.target.checked })}
        />
        Community sensors
      </label>
      <hr className="panelRule" />
      <label className="check">
        <input
          type="checkbox"
          checked={showStale}
          onChange={(e) => onShowStaleChange(e.target.checked)}
        />
        Show stale <span className="checkHint">(faded)</span>
      </label>
      <hr className="panelRule" />
      <h2 className="panelTitle">Regions</h2>
      {areasAvailable ? (
        <>
          <label className="check">
            <input
              type="radio"
              name="areaMode"
              checked={areaMode === 'auto'}
              onChange={() => onAreaModeChange('auto')}
            />
            Auto <span className="checkHint">(areas → points)</span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="areaMode"
              checked={areaMode === 'points'}
              onChange={() => onAreaModeChange('points')}
            />
            Points only
          </label>
        </>
      ) : (
        <p className="panelNote">Regional averages are unavailable right now — showing points.</p>
      )}
    </>
  )
}

/**
 * Desktop: the familiar always-visible top-right card. Phones: a single
 * 44×44 layers button; tapping it opens the same controls as an overlay card
 * (scrim tap, ✕, or Escape closes). Nothing is persisted — crossing the
 * breakpoint resets to that width's default.
 */
export default function LayersPanel(props: LayersPanelProps) {
  const isNarrow = useMediaQuery(NARROW_QUERY)
  const [open, setOpen] = useState(false)
  const fabRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!isNarrow) setOpen(false)
  }, [isNarrow])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      fabRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (!isNarrow) {
    return (
      <section className="panel layers" aria-label="Map layers">
        <LayersControls {...props} />
      </section>
    )
  }

  const close = () => {
    setOpen(false)
    fabRef.current?.focus()
  }

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className="layersFab"
        aria-label="Map layers"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Stacked-layers glyph */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3.5 21 8.5 12 13.5 3 8.5 12 3.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M3 12.5 12 17.5 21 12.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <>
          <div className="scrim" onClick={close} aria-hidden="true" />
          <section className="panel layers layersOverlay" aria-label="Map layers">
            <div className="layersHead">
              <h2 className="panelTitle layersHeadTitle">Layers</h2>
              <button type="button" className="layersClose" aria-label="Close layers" onClick={close}>
                ✕
              </button>
            </div>
            <LayersControls {...props} />
          </section>
        </>
      )}
    </>
  )
}
