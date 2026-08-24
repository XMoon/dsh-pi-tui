/**
 * The builtin footer presets (plan §10): `default` reproduces the legacy
 * full footer EXACTLY (M1 parity — no beautification), `compact` drops the
 * stats row. The legacy `full` name maps to `default`; `custom` arrives in
 * M2.
 * @module @xmoon76/dsh-pi-tui/footer/presets
 */

import type { FooterLayoutV1 } from './types.ts'

/** The default (legacy full) layout: one status row + the stats row. The
 * view-scope item leads: it renders nothing on the main subject and the
 * viewer identity block while viewing (the legacy viewer footer). */
export const DEFAULT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: [
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
      ],
      right: [],
    },
    {
      left: [{ id: 'stats-line' }],
      right: [],
    },
  ],
}

/** The compact layout: the status row only (the stats row drops). */
export const COMPACT_FOOTER_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    {
      left: [
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
      ],
      right: [],
    },
  ],
}

/** The legacy preset names → layout. */
export function layoutForPreset(preset: 'full' | 'compact' | 'default'): FooterLayoutV1 {
  return preset === 'compact' ? COMPACT_FOOTER_LAYOUT : DEFAULT_FOOTER_LAYOUT
}
