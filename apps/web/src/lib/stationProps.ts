import { PARAMS, type Param, type StationProperties } from '@aerismap/shared'

/**
 * queryRenderedFeatures flattens feature properties: nested objects AND
 * arrays come back as JSON strings. `values` (object) and `qc` (array of
 * params) both need defensive re-parsing; scalars (`hotspot`, `stale`, …)
 * arrive as-is.
 */

const isParam = (v: unknown): v is Param =>
  typeof v === 'string' && (PARAMS as readonly string[]).includes(v)

/** JSON-parse a stringified blob; undefined on corrupt input. */
function maybeJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export function parseStationProps(raw: Record<string, unknown>): StationProperties {
  const props = { ...(raw as unknown as StationProperties) }

  const valuesRaw = maybeJson(raw.values)
  props.values =
    valuesRaw && typeof valuesRaw === 'object' && !Array.isArray(valuesRaw)
      ? (valuesRaw as StationProperties['values'])
      : // corrupt values blob: render the popup without readings
        {}

  // qc is a Param[] and arrives JSON-stringified like values; anything that
  // isn't a list of known params (corrupt JSON, junk entries) is dropped so
  // a bad blob can't fake or break the warning UI.
  const qcRaw = maybeJson(raw.qc)
  const qc = Array.isArray(qcRaw) ? qcRaw.filter(isParam) : []
  if (qc.length > 0) props.qc = qc
  else delete (props as { qc?: Param[] }).qc

  return props
}
