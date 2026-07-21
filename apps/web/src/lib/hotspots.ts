import { EAQI_BAND_COLORS, type StationCollection } from '@aerismap/shared'
import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
} from 'maplibre-gl'
import { NEUTRAL_DOT } from './views'

/**
 * Hotspot overlay: stations ingest promoted with properties.hotspot === true
 * (worst unflagged band ≥ HOTSPOT_MIN_BAND, corroborated by a neighbor or
 * reference-grade pedigree). Rendered as a prominent ring marker — a larger
 * band-colored disc with a white contrast stroke and a white core dot — at
 * ALL zooms, choropleth zooms included: a corroborated epicenter must never
 * hide behind a regional median.
 */

/** Legend line, shown only when the loaded snapshot contains hotspots. */
export const HOTSPOT_LEGEND_LABEL = "◉ hotspot above its region's level"

/** MapLibre expression literals don't typecheck as arrays; one contained cast. */
const asExpression = (e: unknown): ExpressionSpecification => e as ExpressionSpecification

/**
 * Only corroborated hotspots that carry a band to color by, and — the
 * contrast rule — only where that band EXCEEDS the region color under them
 * at the displayed NUTS level ('n2' below the split zoom, 'n3' above). A
 * ring that repeats the fill is noise; stations in uncolored/unassigned
 * regions (no _rb* property) always show. `hotspot` rides the flattened
 * pipeline as a plain boolean; to-boolean tolerates a stringified form.
 */
export function hotspotFilter(level: 'n2' | 'n3'): FilterSpecification {
  const rbKey = level === 'n2' ? '_rb2' : '_rb3'
  return asExpression([
    'all',
    ['==', ['to-boolean', ['get', 'hotspot']], true],
    ['has', 'eaqi'],
    ['any', ['!', ['has', rbKey]], ['>', ['coalesce', ['get', 'eaqi'], 0], ['get', rbKey]]],
  ]) as FilterSpecification
}

/** Ring disc color: the station's own EAQI band via the shared band colors. */
export function hotspotRingColor(): ExpressionSpecification {
  return asExpression([
    'match',
    ['coalesce', ['get', 'eaqi'], 0],
    ...EAQI_BAND_COLORS.flatMap((color, i) => [i + 1, color]),
    NEUTRAL_DOT,
  ])
}

/** Outer disc: clearly larger than any station dot at the same zoom. */
export function hotspotRingRadius(): DataDrivenPropertyValueSpecification<number> {
  return asExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    3,
    8,
    8,
    11,
    12,
    15,
  ]) as DataDrivenPropertyValueSpecification<number>
}

/** Inner white core dot — turns the disc into a ◉ ring marker. */
export function hotspotCoreRadius(): DataDrivenPropertyValueSpecification<number> {
  return asExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    3,
    2.5,
    8,
    3.5,
    12,
    5,
  ]) as DataDrivenPropertyValueSpecification<number>
}

/** One post-load check driving the conditional legend line. */
export function collectionHasHotspots(stations: StationCollection | null): boolean {
  return stations !== null && stations.features.some((f) => f.properties?.hotspot === true)
}
