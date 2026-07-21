'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type {
  DataDrivenPropertyValueSpecification,
  GeoJSONSource,
  LngLatLike,
  Map as MapLibreMap,
  MapLayerMouseEvent,
} from 'maplibre-gl'
import {
  BOUNDARY_ASSETS,
  type AreaSnapshot,
  type StationCollection,
} from '@aerismap/shared'
import {
  AREA_CROSSFADE_END,
  AREA_CROSSFADE_START,
  NO_DATA_FILL,
  NUTS_SPLIT_ZOOM,
  areaFillColor,
  areaFillOpacity,
  areaLineColor,
  areaLineOpacity,
  areaLineWidth,
  areaStateFor,
  stationCircleOpacity,
  viewHasAreaFills,
  type AreaMode,
} from '../lib/areas'
import { BASEMAP_STYLE, INITIAL_CENTER, INITIAL_ZOOM } from '../lib/config'
import {
  hotspotCoreRadius,
  hotspotFilter,
  hotspotRingColor,
  hotspotRingRadius,
} from '../lib/hotspots'
import { parseStationProps } from '../lib/stationProps'
import {
  buildFilter,
  circleRadius,
  circleSortKey,
  NEUTRAL_DOT,
  type KindFilter,
  type ViewSpec,
} from '../lib/views'
import AreaPopup from './AreaPopup'
import StationPopup from './StationPopup'

const SOURCE_ID = 'stations'
const LAYER_ID = 'station-circles'
/** Hotspot ring/core pair — clicks/hover are handled on the ring (it spans the whole marker). */
const HOTSPOT_RING = 'hotspot-ring'
const HOTSPOT_CORE = 'hotspot-core'

const NUTS2_SOURCE = 'nuts2'
const NUTS3_SOURCE = 'nuts3'
const NUTS2_FILL = 'nuts2-fill'
const NUTS3_FILL = 'nuts3-fill'
const NUTS2_LINE = 'nuts2-line'
const NUTS3_LINE = 'nuts3-line'
const AREA_SOURCES = [NUTS2_SOURCE, NUTS3_SOURCE] as const
const AREA_FILL_LAYERS = [NUTS2_FILL, NUTS3_FILL] as const
const AREA_LAYERS = [NUTS2_FILL, NUTS3_FILL, NUTS2_LINE, NUTS3_LINE] as const

const EMPTY_FC = { type: 'FeatureCollection', features: [] } as const

/** Stale stations stay on the map but recede. */
const STALE_OPACITY = [
  'case',
  ['to-boolean', ['get', 'stale']],
  0.35,
  0.92,
] as unknown as DataDrivenPropertyValueSpecification<number>

const STROKE_WIDTH = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  0.5,
  8,
  1,
  12,
  1.5,
] as unknown as DataDrivenPropertyValueSpecification<number>

/**
 * Add sources and layers, idempotently — runs on first load and again after
 * any style reload (which wipes user sources/layers). Area layers are
 * inserted below the basemap's first symbol layer so positron labels stay on
 * top; the hotspot ring/core pair goes in after them (above the fills, still
 * below labels); the station circle layer keeps its historic slot at the
 * very top.
 */
function ensureLayers(map: MapLibreMap) {
  if (!map.getSource(NUTS2_SOURCE)) {
    map.addSource(NUTS2_SOURCE, { type: 'geojson', data: EMPTY_FC, promoteId: 'NUTS_ID' })
  }
  if (!map.getSource(NUTS3_SOURCE)) {
    map.addSource(NUTS3_SOURCE, { type: 'geojson', data: EMPTY_FC, promoteId: 'NUTS_ID' })
  }
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: EMPTY_FC,
      // Plan §6: no clustering; tile the source only up to z12.
      maxzoom: 12,
    })
  }

  const firstSymbolId = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
  const fillSpec = (id: string, source: string, zoom: { minzoom?: number; maxzoom?: number }) => {
    if (map.getLayer(id)) return
    map.addLayer(
      {
        id,
        type: 'fill',
        source,
        ...zoom,
        layout: { visibility: 'none' },
        paint: { 'fill-color': NO_DATA_FILL, 'fill-opacity': areaFillOpacity() },
      },
      firstSymbolId
    )
  }
  const lineSpec = (id: string, source: string, zoom: { minzoom?: number; maxzoom?: number }) => {
    if (map.getLayer(id)) return
    map.addLayer(
      {
        id,
        type: 'line',
        source,
        ...zoom,
        layout: { visibility: 'none' },
        paint: {
          'line-color': areaLineColor(),
          'line-width': areaLineWidth(),
          'line-opacity': areaLineOpacity(),
        },
      },
      firstSymbolId
    )
  }
  // Fills first, then borders above them — all below the basemap labels.
  fillSpec(NUTS2_FILL, NUTS2_SOURCE, { maxzoom: NUTS_SPLIT_ZOOM })
  fillSpec(NUTS3_FILL, NUTS3_SOURCE, { minzoom: NUTS_SPLIT_ZOOM })
  lineSpec(NUTS2_LINE, NUTS2_SOURCE, { maxzoom: NUTS_SPLIT_ZOOM })
  lineSpec(NUTS3_LINE, NUTS3_SOURCE, { minzoom: NUTS_SPLIT_ZOOM })

  // Hotspot overlay: above the fills, below the basemap labels, visible at
  // every zoom. Renders nothing when no station carries hotspot=true.
  if (!map.getLayer(HOTSPOT_RING)) {
    map.addLayer(
      {
        id: HOTSPOT_RING,
        type: 'circle',
        source: SOURCE_ID,
        filter: hotspotFilter(),
        paint: {
          'circle-radius': hotspotRingRadius(),
          'circle-color': hotspotRingColor(),
          'circle-opacity': 0.95,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      },
      firstSymbolId
    )
  }
  if (!map.getLayer(HOTSPOT_CORE)) {
    map.addLayer(
      {
        id: HOTSPOT_CORE,
        type: 'circle',
        source: SOURCE_ID,
        filter: hotspotFilter(),
        paint: {
          'circle-radius': hotspotCoreRadius(),
          'circle-color': '#ffffff',
        },
      },
      firstSymbolId
    )
  }

  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        'circle-color': NEUTRAL_DOT,
        'circle-radius': 3,
        'circle-opacity': STALE_OPACITY,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': STROKE_WIDTH,
        'circle-stroke-opacity': STALE_OPACITY,
      },
    })
  }
}

interface MapViewProps {
  stations: StationCollection | null
  view: ViewSpec
  kinds: KindFilter
  showStale: boolean
  /** Parsed area snapshot; null while loading or when unavailable. */
  areas: AreaSnapshot | null
  areaMode: AreaMode
}

/** What GeoJSONSource.setData accepts — avoids depending on the GeoJSON UMD global. */
type BoundaryData = Parameters<GeoJSONSource['setData']>[0]

interface BoundaryCache {
  nuts2: BoundaryData | null
  nuts3: BoundaryData | null
  inFlight: boolean
}

export default function MapView({ stations, view, kinds, showStale, areas, areaMode }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const closePopupRef = useRef<(() => void) | null>(null)
  const boundariesRef = useRef<BoundaryCache>({ nuts2: null, nuts3: null, inFlight: false })
  const [mapReady, setMapReady] = useState(false)
  const [boundariesReady, setBoundariesReady] = useState(false)
  // Bumped after a style reload so data/paint/feature-state effects reapply
  // (style changes wipe sources, layers, and feature-state).
  const [styleEpoch, setStyleEpoch] = useState(0)

  const fillsEnabled = areaMode === 'auto' && areas !== null && viewHasAreaFills(view.id)
  const fillsShown = fillsEnabled && boundariesReady

  // Live values for map event handlers registered once at init.
  const uiRef = useRef({ fillsShown, areas })
  useEffect(() => {
    uiRef.current = { fillsShown, areas }
  }, [fillsShown, areas])

  useEffect(() => {
    let disposed = false
    void (async () => {
      // maplibre-gl touches browser globals, and static export still prerenders
      // this page — import it only in the browser, inside the effect.
      const maplibregl = (await import('maplibre-gl')).default
      if (disposed || !containerRef.current) return

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: BASEMAP_STYLE,
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        // attributionControl stays enabled (default) — required by the basemap.
      })
      mapRef.current = map
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')

      map.on('load', () => {
        if (disposed) return
        ensureLayers(map)
        setMapReady(true)
      })
      // Fires on every style (re)load. Re-add our sources/layers and nudge the
      // effects that restore data, paint, and feature-state.
      map.on('style.load', () => {
        if (disposed) return
        ensureLayers(map)
        setStyleEpoch((n) => n + 1)
      })

      // With fills shown, circles only become clickable once they start
      // fading in; below that the choropleth owns the map.
      const stationsInteractive = () =>
        !uiRef.current.fillsShown || map.getZoom() > AREA_CROSSFADE_START
      const areasInteractive = () =>
        uiRef.current.fillsShown && map.getZoom() < AREA_CROSSFADE_END

      const openPopup = (content: ReactElement, lngLat: LngLatLike) => {
        closePopupRef.current?.()
        const container = document.createElement('div')
        const root = createRoot(container)
        // Synchronous render: MapLibre picks the popup's auto-anchor from its
        // measured size when added, so the content must exist before addTo —
        // an async render leaves it measuring an empty box and the popup can
        // overflow the viewport edge instead of flipping.
        flushSync(() => root.render(content))
        const popup = new maplibregl.Popup({ maxWidth: '340px', offset: 10 })
          .setLngLat(lngLat)
          .setDOMContent(container)
          .addTo(map)
        const unmount = () => {
          closePopupRef.current = null
          // async: never unmount a React root from inside an event dispatch
          setTimeout(() => root.unmount(), 0)
        }
        popup.on('close', unmount)
        closePopupRef.current = () => {
          popup.off('close', unmount)
          popup.remove()
          setTimeout(() => root.unmount(), 0)
          closePopupRef.current = null
        }
      }

      map.on('mousemove', LAYER_ID, () => {
        if (!stationsInteractive()) return
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', LAYER_ID, () => {
        map.getCanvas().style.cursor = ''
      })

      const openStationPopup = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0]
        if (!feature || feature.geometry.type !== 'Point') return
        const [lng, lat] = feature.geometry.coordinates
        if (lng === undefined || lat === undefined) return
        openPopup(
          <StationPopup station={parseStationProps(feature.properties)} now={Date.now()} />,
          [lng, lat]
        )
      }

      map.on('click', LAYER_ID, (e) => {
        if (!stationsInteractive()) return
        openStationPopup(e)
      })

      // Hotspot markers are interactive at ALL zooms — the ring spans the
      // whole marker, so the pair needs handlers on the ring layer only.
      map.on('mousemove', HOTSPOT_RING, () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', HOTSPOT_RING, () => {
        map.getCanvas().style.cursor = ''
      })
      map.on('click', HOTSPOT_RING, openStationPopup)

      // ---- Area interactions (hover emphasis via feature-state; popup) ----
      let hovered: { source: string; id: string | number } | null = null
      const clearHover = () => {
        if (!hovered) return
        map.removeFeatureState(hovered, 'hover')
        hovered = null
      }
      const onAreaMove = (e: MapLayerMouseEvent) => {
        if (!areasInteractive()) {
          clearHover()
          return
        }
        const feature = e.features?.[0]
        if (!feature || feature.id === undefined) return
        if (hovered && hovered.id === feature.id && hovered.source === feature.source) {
          map.getCanvas().style.cursor = 'pointer'
          return
        }
        clearHover()
        hovered = { source: feature.source, id: feature.id }
        map.setFeatureState(hovered, { hover: true })
        map.getCanvas().style.cursor = 'pointer'
      }
      const onAreaLeave = () => {
        clearHover()
        map.getCanvas().style.cursor = ''
      }
      const onAreaClick = (e: MapLayerMouseEvent) => {
        if (!areasInteractive()) return
        // Hotspot markers win at any zoom — their station popup must not be
        // replaced by the region popup underneath.
        if (map.queryRenderedFeatures(e.point, { layers: [HOTSPOT_RING] }).length > 0) return
        // Station circles win whenever they're visible/interactive.
        if (
          stationsInteractive() &&
          map.queryRenderedFeatures(e.point, { layers: [LAYER_ID] }).length > 0
        ) {
          return
        }
        const feature = e.features?.[0]
        if (!feature || feature.id === undefined) return
        const props = feature.properties as Record<string, unknown>
        const nutsId = String(feature.id)
        const name =
          typeof props.NAME_LATN === 'string' && props.NAME_LATN.trim() !== ''
            ? props.NAME_LATN
            : nutsId
        const levelRaw = Number(props.LEVL_CODE)
        const stats = uiRef.current.areas?.areas[nutsId] ?? null
        openPopup(
          <AreaPopup
            nutsId={nutsId}
            name={name}
            level={Number.isFinite(levelRaw) ? levelRaw : undefined}
            stats={stats}
          />,
          e.lngLat
        )
      }
      for (const layerId of AREA_FILL_LAYERS) {
        map.on('mousemove', layerId, onAreaMove)
        map.on('mouseleave', layerId, onAreaLeave)
        map.on('click', layerId, onAreaClick)
      }
    })()

    return () => {
      disposed = true
      closePopupRef.current?.()
      mapRef.current?.remove()
      mapRef.current = null
      setMapReady(false)
      setBoundariesReady(false)
    }
  }, [])

  // Station data (re)applied after load and after any style reload.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !stations) return
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
    source?.setData(stations)
  }, [stations, mapReady, styleEpoch])

  // Boundary GeoJSONs: fetched lazily the first time fills are wanted, cached
  // for the session, and never blocking station rendering. A failed fetch
  // leaves the map in points mode; the next activation retries.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !fillsEnabled) return
    const cache = boundariesRef.current
    const apply = () => {
      const m = mapRef.current
      if (!m) return
      if (cache.nuts2) (m.getSource(NUTS2_SOURCE) as GeoJSONSource | undefined)?.setData(cache.nuts2)
      if (cache.nuts3) (m.getSource(NUTS3_SOURCE) as GeoJSONSource | undefined)?.setData(cache.nuts3)
    }
    if (cache.nuts2 && cache.nuts3) {
      apply()
      setBoundariesReady(true)
      return
    }
    if (cache.inFlight) return
    cache.inFlight = true
    const fetchBoundary = async (url: string): Promise<BoundaryData> => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return (await res.json()) as BoundaryData
    }
    void (async () => {
      try {
        const [nuts2, nuts3] = await Promise.all([
          fetchBoundary(BOUNDARY_ASSETS.nuts2),
          fetchBoundary(BOUNDARY_ASSETS.nuts3),
        ])
        cache.nuts2 = nuts2
        cache.nuts3 = nuts3
        apply()
        setBoundariesReady(true)
      } catch {
        // Missing/broken boundaries: stay points-only, no error UI.
      } finally {
        cache.inFlight = false
      }
    })()
  }, [fillsEnabled, mapReady, styleEpoch])

  // Join: area stats → feature-state on BOTH sources, keyed by NUTS_ID.
  // Feature-state survives setData but not style reloads — styleEpoch reruns
  // this after any reload; a fresh snapshot replaces all previous state.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !areas) return
    for (const source of AREA_SOURCES) {
      if (!map.getSource(source)) continue
      map.removeFeatureState({ source })
      for (const [id, stats] of Object.entries(areas.areas)) {
        map.setFeatureState({ source, id }, areaStateFor(stats))
      }
    }
  }, [areas, mapReady, boundariesReady, styleEpoch])

  // Area layer visibility + per-view fill color.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visibility = fillsShown ? 'visible' : 'none'
    for (const id of AREA_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    }
    if (!fillsShown) return
    const color = areaFillColor(view.id)
    if (!color) return
    for (const id of AREA_FILL_LAYERS) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'fill-color', color)
    }
  }, [fillsShown, view, mapReady, styleEpoch])

  // Station circle styling; opacity picks up the crossfade when fills show.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !map.getLayer(LAYER_ID)) return
    const opacity = stationCircleOpacity(fillsShown, STALE_OPACITY)
    map.setPaintProperty(LAYER_ID, 'circle-color', view.circleColor)
    map.setPaintProperty(LAYER_ID, 'circle-stroke-color', view.strokeColor)
    map.setPaintProperty(LAYER_ID, 'circle-radius', circleRadius(view.id))
    map.setPaintProperty(LAYER_ID, 'circle-opacity', opacity)
    map.setPaintProperty(LAYER_ID, 'circle-stroke-opacity', opacity)
    map.setLayoutProperty(LAYER_ID, 'circle-sort-key', circleSortKey(view))
    map.setFilter(LAYER_ID, buildFilter(view, kinds, showStale))
  }, [view, kinds, showStale, fillsShown, mapReady, styleEpoch])

  return <div ref={containerRef} className="map" role="application" aria-label="Station map" />
}
