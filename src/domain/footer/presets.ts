/**
 * The builtin footer presets (plan §10): `default` composes the status
 * row plus a stats row, `compact` drops the stats row. The legacy `full`
 * name maps to `default`. The VIEWER counterparts (`VIEWER_DEFAULT_…` /
 * `VIEWER_COMPACT_…`) deduplicate the child identity the subject bar
 * already carries: no model, no view-scope, no main-session leakage.
 * @module @xmoon76/dsh-pi-tui/domain/footer/presets
 */

import type { FooterItemRef, FooterLayoutV1 } from './layout.ts'

/** Build the compact preset's status-row placements, in order. The
 * view-scope item leads: it renders nothing on the main subject and the
 * viewer identity block while viewing (the legacy viewer footer). A
 * FACTORY (never a shared object graph): each preset builds its own
 * placement objects, so no consumer can mutate one preset's refs through
 * another preset's alias. */
function compactStatusRowPlacements(): FooterItemRef[] {
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

/** The default layout's status-row LEFT placements, in order: the
 * main-subject identity facts (permission, model, tasks, cwd, branch)
 * and the extension bridge; plan state and display preset ride the RIGHT
 * zone. The view-scope item leads: it renders nothing on the main
 * subject and the viewer identity block while viewing (the legacy
 * viewer footer). A FACTORY (never a shared object graph): each preset
 * builds its own placement objects, so no consumer can mutate one
 * preset's refs through another preset's alias. */
function defaultStatusRowLeftPlacements(): FooterItemRef[] {
  return [
    { id: 'view-scope' },
    { id: 'permission-preset' },
    { id: 'model' },
    { id: 'tasks' },
    { id: 'cwd' },
    { id: 'git-branch' },
    { id: 'ext:*' },
  ]
}

/** The default layout: the status row (left = the identity facts and the
 * extension bridge, right = plan state and display preset) plus a stats row
 * (left = the stats-line facts as REAL semantic placements — session
 * cumulative usage, cache hit, and the recent model performance as two
 * `performance` placements — plus the turn/step counters; right = the
 * full context pressure). The per-ref importance overrides define the
 * narrow-width drop order (plan §3.3): cache-hit goes first, then the
 * TTFB, then the turn/step counters and the throughput (equal importance:
 * the LATER placement drops first); the session usage pair is the row's
 * floor and survives longest. The duplicated `performance` id is
 * intentional: each placement carries its own format (FooterLayoutV1
 * allows repeated placements). */
export const DEFAULT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: defaultStatusRowLeftPlacements(),
      right: [
        { id: 'plan-state' },
        { id: 'display-preset' },
      ],
    },
    {
      left: [
        { id: 'token-usage', format: 'pi', importance: 55 },
        { id: 'cache-hit', format: 'pi', importance: 30 },
        { id: 'performance', format: 'latency', importance: 40 },
        { id: 'performance', format: 'speed', importance: 45 },
        { id: 'turns-steps' },
      ],
      right: [
        { id: 'context', format: 'full' },
      ],
    },
  ],
}

/** The compact layout: the full status row only (the stats row drops). */
export const COMPACT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: compactStatusRowPlacements(),
      right: [],
    },
  ],
}

/** The builtin VIEWER default layout (viewer UX plan §4.4): the viewer
 * subject bar already carries the child label/activity/model identity, so
 * the child footer deduplicates it — row 1 is the child permission /
 * preset / workspace, row 2 the child usage stats. No model, no
 * view-scope, no main-session plan/task/extension leakage. Same
 * `FooterLayoutV1` + `FooterComposer` as every other layout — never a
 * second footer renderer. */
export const VIEWER_DEFAULT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: [
        { id: 'permission-preset' },
        { id: 'agent-preset' },
        { id: 'cwd' },
        { id: 'git-branch' },
      ],
      right: [],
    },
    {
      left: [
        { id: 'token-usage', format: 'pi', importance: 55 },
        { id: 'cache-hit', format: 'pi', importance: 30 },
        { id: 'performance', format: 'latency', importance: 40 },
        { id: 'performance', format: 'speed', importance: 45 },
        { id: 'turns-steps' },
      ],
      right: [
        { id: 'context', format: 'full' },
      ],
    },
  ],
}

/** The builtin VIEWER compact layout: one status row (child permission /
 * preset / workspace / context / counters), no stats row, no model and no
 * view-scope. */
export const VIEWER_COMPACT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: [
        { id: 'permission-preset' },
        { id: 'agent-preset' },
        { id: 'cwd' },
        { id: 'git-branch' },
        { id: 'context' },
        { id: 'turns-steps' },
      ],
      right: [],
    },
  ],
}

/** The legacy preset names → layout. `viewing` selects the builtin viewer
 * counterpart while the committed display subject is a viewed child (the
 * MAIN defaults, the user's custom layout and the command surface are
 * untouched — this is a presentation-layout selection only, never a second
 * status owner). */
export function layoutForPreset(preset: 'full' | 'compact' | 'default', viewing = false): FooterLayoutV1 {
  if (viewing) return preset === 'compact' ? VIEWER_COMPACT_FOOTER_LAYOUT : VIEWER_DEFAULT_FOOTER_LAYOUT
  return preset === 'compact' ? COMPACT_FOOTER_LAYOUT : DEFAULT_FOOTER_LAYOUT
}
