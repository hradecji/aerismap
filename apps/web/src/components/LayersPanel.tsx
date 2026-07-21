import type { AreaMode } from '../lib/areas'
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

export default function LayersPanel({
  kinds,
  onKindsChange,
  showStale,
  onShowStaleChange,
  areaMode,
  onAreaModeChange,
  areasAvailable,
}: LayersPanelProps) {
  return (
    <section className="panel layers" aria-label="Map layers">
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
    </section>
  )
}
