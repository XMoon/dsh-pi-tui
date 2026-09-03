/**
 * The builtin footer presets (plan §10): `default` composes the status
 * row plus a stats row built from REAL semantic placements (session
 * cumulative usage, cache hit, and the recent model performance as two
 * `performance` placements — latency then speed), `compact` drops the
 * stats row. The legacy `full` name maps to `default`.
 * @module @xmoon76/dsh-pi-tui/footer/presets
 */

import type { FooterItemRef, FooterLayoutV1 } from './types.ts'

/** Build the status row's placements, in order. The view-scope item leads:
 * it renders nothing on the main subject and the viewer identity block
 * while viewing (the legacy viewer footer). A FACTORY (never a shared
 * object graph): each preset builds its own placement objects, so no
 * consumer can mutate one preset's refs through another preset's alias. */
function statusRowPlacements(): FooterItemRef[] {
  return [
    { id: 'view-scope' },
    { id: 'permission-preset' },
    { id: 'plan-state' },
    { id: 'model' },
    { id: 'tasks' },
    { id: 'cwd' },
    { id: 'git-branch' },
    { id: 'context' },
    { id: 'turns-steps' },
    { id: 'ext:*' },
  ]
}

/** The default layout's second row: semantic placements instead of the
 * legacy composite `stats-line`. Left group = session cumulative usage
 * (tokens + cache), right = recent model performance (TTFB, effective
 * throughput). The per-ref importance overrides define the narrow-width
 * drop order (plan §3.3): cache-hit goes first, then the TTFB, then the
 * throughput; the session usage pair survives longest — at least one
 * usage signal and one speed signal outlive everything else on the row.
 * The duplicated `performance` id is intentional: each placement carries
 * its own format (FooterLayoutV1 allows repeated placements). */
export const DEFAULT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: statusRowPlacements(),
      right: [],
    },
    {
      left: [
        { id: 'token-usage', format: 'pi', importance: 55 },
        { id: 'cache-hit', format: 'pi', importance: 30 },
        { id: 'performance', format: 'latency', importance: 40 },
        { id: 'performance', format: 'speed', importance: 45 },
      ],
      right: [],
      separator: { text: ' · ' },
    },
  ],
}

/** The compact layout: the status row only (the stats row drops). */
export const COMPACT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: statusRowPlacements(),
      right: [],
    },
  ],
}

/** The legacy preset names → layout. */
export function layoutForPreset(preset: 'full' | 'compact' | 'default'): FooterLayoutV1 {
  return preset === 'compact' ? COMPACT_FOOTER_LAYOUT : DEFAULT_FOOTER_LAYOUT
}
