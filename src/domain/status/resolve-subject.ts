/**
 * Display subject resolution (plan §4.6): entering the subagent viewer
 * switches the displayed Session, not the status OWNER — the footer, the
 * viewer subject bar and every derived surface read the SAME committed
 * StatusSnapshot. The builtin footer PRESENTATION layout may select a
 * viewer counterpart (it drops the retired `view-scope` identity block but
 * keeps the model placement), and the subject bar additionally shows the
 * child identity — both are views over one snapshot, never a second child
 * status owner.
 * This module resolves the current display subject from the mounted
 * viewer's identity — the ONE selector StatusRuntime's display-subject
 * derivation uses (M3-5 PR1).
 * @module @xmoon76/dsh-pi-tui/domain/status/resolve-subject
 */

import type { ViewStatus } from './types.ts'

/** The viewer identity the selector reads (the ViewerRuntime read model's
 * structural subset: the durable child identity, never its Session facts). */
export interface ViewerStateLike {
  readonly childSessionId: string
  readonly label?: string
  readonly mode: 'one-shot' | 'continuable'
  readonly activity?: 'running' | 'inactive'
}

/**
 * Resolve the display subject.
 * @param viewer - the open viewer's target, undefined when none.
 * @returns the view section.
 */
export function resolveDisplaySubject(viewer: ViewerStateLike | undefined): ViewStatus {
  if (viewer === undefined) return { subject: { kind: 'main' } }
  return {
    subject: {
      kind: 'subagent',
      id: viewer.childSessionId,
      ...viewer.label === undefined || viewer.label === '' ? {} : { label: viewer.label },
      mode: viewer.mode,
      ...viewer.activity === undefined ? {} : { activity: viewer.activity },
    },
  }
}
