/**
 * Snapshot assembly helpers (plan §5/§12.4): the runner composes the
 * DSH-derived sections and the TuiApp projects its own surface state into
 * the SAME StatusStore. This module owns the initial snapshot and the
 * section-level merge helpers so no caller hand-builds the full shape.
 * @module @xmoon76/dsh-pi-tui/status/snapshot
 */

import { emptyStatusSnapshot, type StatusSnapshot } from './types.ts'

/** The initial snapshot with the bundle version stamped. */
export function initialStatusSnapshot(tuiVersion: string): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return { ...base, host: { ...base.host, tuiVersion } }
}
