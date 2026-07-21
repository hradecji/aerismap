'use client'

import { useEffect, useMemo, useState } from 'react'
import { ATTRIBUTIONS } from '@aerismap/shared'
import { useAreaSnapshot, viewHasAreaFills, withBoundaryAttribution, type AreaMode } from '../lib/areas'
import { EMPTY_REPOLL_MS, META_STALE_MS } from '../lib/config'
import { collectionHasHotspots } from '../lib/hotspots'
import { relativeTime } from '../lib/format'
import { useSnapshot } from '../lib/snapshot'
import { VIEWS, type KindFilter, type ViewId } from '../lib/views'
import AttributionPanel from './AttributionPanel'
import LayersPanel from './LayersPanel'
import Legend from './Legend'
import MapView from './MapView'
import ViewSwitcher from './ViewSwitcher'

export default function App() {
  const snapshot = useSnapshot()
  const areaSnapshot = useAreaSnapshot()
  const [viewId, setViewId] = useState<ViewId>('eaqi')
  const [kinds, setKinds] = useState<KindFilter>({ reference: true, community: true })
  const [showStale, setShowStale] = useState(true)
  const [areaMode, setAreaMode] = useState<AreaMode>('auto')
  // Clock starts null so the prerendered HTML never bakes in a build-time date.
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // The empty card promises stations will appear — keep that promise by
  // re-checking while the first snapshot hasn't landed. The first area
  // snapshot usually lands in the same ingest run, so re-check it too
  // (a no-op unless it previously came back unavailable).
  const { status, retry } = snapshot
  const areaRetry = areaSnapshot.retry
  useEffect(() => {
    if (status !== 'empty') return
    const timer = setInterval(() => {
      retry()
      areaRetry()
    }, EMPTY_REPOLL_MS)
    return () => clearInterval(timer)
  }, [status, retry, areaRetry])

  const retryAll = () => {
    retry()
    areaRetry()
  }

  const view = VIEWS.find((v) => v.id === viewId) ?? VIEWS[0]!

  // generatedAt is a server timestamp, so judge its age with the server's
  // clock (client clock + skew measured on the meta fetch) — a client clock
  // that's hours off must not fake or hide the freshness banner.
  const serverNow = now !== null ? now + snapshot.clockSkewMs : null
  const generatedAt = snapshot.meta?.generatedAt
  const metaAge = serverNow !== null && generatedAt ? serverNow - Date.parse(generatedAt) : null
  const metaIsStale = metaAge !== null && Number.isFinite(metaAge) && metaAge > META_STALE_MS

  const areasReady = areaSnapshot.status === 'ready'
  const areaFillsOn = areaMode === 'auto' && areasReady && viewHasAreaFills(view.id)

  // One check per loaded snapshot: the ◉ legend line only appears when the
  // data actually contains corroborated hotspots.
  const hasHotspots = useMemo(() => collectionHasHotspots(snapshot.stations), [snapshot.stations])

  const baseAttribution =
    snapshot.meta && snapshot.meta.attribution.length > 0
      ? snapshot.meta.attribution
      : ATTRIBUTIONS
  // Licence obligation: the EuroGeographics notice must be present whenever
  // boundaries can render, even if a (stale) meta payload predates area mode.
  const attribution = areasReady ? withBoundaryAttribution(baseAttribution) : baseAttribution

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          AerisMap
          <span className="brandSub">Europe air quality</span>
        </div>
        <ViewSwitcher active={view.id} onChange={setViewId} />
      </header>

      {metaIsStale && generatedAt && serverNow !== null && (
        <div className="banner" role="status">
          Data last updated {relativeTime(generatedAt, serverNow)} — sources may be delayed.
        </div>
      )}

      <div className="mapWrap">
        <MapView
          stations={snapshot.stations}
          view={view}
          kinds={kinds}
          showStale={showStale}
          areas={areaSnapshot.areas}
          areaMode={areaMode}
        />

        {snapshot.status === 'loading' && (
          <div className="statusPill" role="status">
            Loading latest measurements…
          </div>
        )}
        {snapshot.status === 'empty' && (
          <div className="statusCardWrap">
            <div className="statusCard" role="status">
              <strong>No data yet</strong>
              <p>
                The first ingest run hasn&apos;t published a snapshot. The basemap is live —
                this page re-checks every few minutes and stations will appear once data
                lands.
              </p>
              <button type="button" className="retry" onClick={retryAll}>
                Check again
              </button>
            </div>
          </div>
        )}
        {snapshot.status === 'error' && (
          <div className="statusCardWrap">
            <div className="statusCard" role="alert">
              <strong>Couldn&apos;t load stations</strong>
              <p>{snapshot.error}</p>
              <button type="button" className="retry" onClick={retryAll}>
                Retry
              </button>
            </div>
          </div>
        )}

        <Legend view={view} areaNote={areaFillsOn} showHotspots={hasHotspots} />
        <LayersPanel
          kinds={kinds}
          onKindsChange={setKinds}
          showStale={showStale}
          onShowStaleChange={setShowStale}
          areaMode={areaMode}
          onAreaModeChange={setAreaMode}
          areasAvailable={areaSnapshot.status !== 'unavailable'}
        />
        <AttributionPanel attribution={attribution} />
      </div>
    </div>
  )
}
