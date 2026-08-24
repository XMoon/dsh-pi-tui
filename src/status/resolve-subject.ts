/**
 * Display subject resolution (plan §4.6): the footer layout does NOT change
 * when the user enters the subagent viewer — only the DATA SOURCE switches
 * to the viewed child. This module resolves the current display subject
 * from the viewer state; M0 keeps the legacy viewer footer path, M1 removes
 * the second layout branch.
 * @module @xmoon76/dsh-pi-tui/status/resolve-subject
 */

import type { ViewStatus } from './types.ts'

/** The viewer state the runner tracks (structural — the TuiApp's
 * SubagentViewerFooter shape plus the durable child identity). */
export interface ViewerStateLike {
  readonly childSessionId: string
  readonly label?: string
  readonly mode: 'one-shot' | 'continuable'
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
    },
  }
}
