import { VIEWS, type ViewId, type ViewSpec } from './views'

/**
 * Header hierarchy (2026-07): EAQI *is* the integrated air-quality index —
 * the worst of the five pollutant sub-indices — but a flat 8-tab row made it
 * read as just another metric. The switcher now leads with the index (renamed
 * “Air Quality”) and Temperature; every per-pollutant view plus Humidity sits
 * one tap away behind “More”.
 */
export const PRIMARY_VIEW_IDS: readonly ViewId[] = ['eaqi', 'temperature']

/** Menu order mirrors the EAQI sub-index order, then the companion metric. */
export const MORE_VIEW_IDS: readonly ViewId[] = ['pm2_5', 'pm10', 'no2', 'o3', 'so2', 'humidity']

export function isMoreView(id: ViewId): boolean {
  return MORE_VIEW_IDS.includes(id)
}

export function viewById(id: ViewId): ViewSpec {
  const view = VIEWS.find((v) => v.id === id)
  if (!view) throw new Error(`unknown view: ${id}`)
  return view
}

/**
 * The “More” trigger doubles as the active tab when a menu view is selected:
 * it shows that view's short name (and renders pressed); otherwise “More”.
 */
export function moreButtonLabel(active: ViewId): string {
  return isMoreView(active) ? viewById(active).label : 'More'
}
