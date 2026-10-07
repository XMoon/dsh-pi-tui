/**
 * The application surface's viewer-submission policy (TS8-F4): what the caller
 * must DO after a settled viewer prompt, whether a settle may still touch the
 * CURRENT viewer surface, and the Host-file scope a viewer send addresses.
 *
 * Application presentation consistency: the official `prompt()` validates Host
 * authority, but it cannot keep a settled UI surface isolated, so the
 * stale-viewer guard lives here. Pure and structural.
 * @module @xmoon76/dsh-pi-tui/app/surface/viewer-submission
 */

import type {
  SubagentPromptOutcome,
  SubagentPromptReject,
  SubagentViewerSubmitRequest,
} from '../../runtime/subagent-port.ts'

/**
 * What the caller must DO after a settled viewer prompt. `uncertain` is the
 * load-bearing case: an indeterminate delivery may already own the child, so
 * the caller must neither restore the draft as unsent nor claim it was not
 * delivered — the child's authoritative state decides.
 */
export type SubagentPromptDisposition =
  | { readonly kind: 'sent' }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly reason: SubagentPromptReject }

export function subagentPromptDisposition(outcome: SubagentPromptOutcome): SubagentPromptDisposition {
  if (outcome.kind === 'ok') return { kind: 'sent' }
  if (outcome.kind === 'indeterminate') return { kind: 'uncertain' }
  if (outcome.reason.kind === 'cancelled') return { kind: 'cancelled' }
  return { kind: 'rejected', reason: outcome.reason }
}

/** Whether a settled prompt may still touch the CURRENT surface: the
 * viewer session that started the send must be unchanged — the SAME
 * child is still being viewed, the viewer generation has not moved (a
 * viewer open/close/switch bumps it, so a close → reopen of the SAME
 * child is stale), and the live parent session is still the one the
 * viewer was opened from. Anything else is a STALE settle: the result
 * may only touch the child's OWN draft slot (map-only), never the
 * visible surface (plan §12). This is CLIENT presentation consistency —
 * the official `prompt()` validates Host authority, but it cannot keep a
 * settled UI surface isolated, so this guard stays. */
export type SubagentSettleTarget =
  | { readonly kind: 'current'; readonly label: string }
  | { readonly kind: 'stale' }

export interface SubagentSettleViewerState {
  /** The child currently being viewed (undefined = viewer closed). */
  readonly viewingChildId: string | undefined
  /** The viewed child's display label. */
  readonly viewingLabel: string | undefined
  /** The exact parent the current viewer was opened from. */
  readonly viewingParentSessionId: string | undefined
  /** The viewer generation captured when the send started. */
  readonly viewerGenerationAtSend: number
  /** The viewer generation NOW (open/close/switch bump it). */
  readonly viewerGenerationNow: number
  /** The live parent session id at settle time. */
  readonly liveParentSessionId: string | undefined
}

export function resolveSubagentSettleTarget(
  request: SubagentViewerSubmitRequest,
  view: SubagentSettleViewerState,
): SubagentSettleTarget {
  if (view.viewingChildId !== request.childSessionId) return { kind: 'stale' }
  if (view.viewingParentSessionId !== request.parentSessionId) return { kind: 'stale' }
  if (view.viewerGenerationNow !== view.viewerGenerationAtSend) return { kind: 'stale' }
  if (view.liveParentSessionId !== request.parentSessionId) return { kind: 'stale' }
  return { kind: 'current', label: view.viewingLabel ?? request.childSessionId }
}

/**
 * The Host-file scope one viewer prompt's send seam addresses: the VIEWED
 * CHILD's workspace when the viewer knows it, the live parent session
 * otherwise (an unknown cold-child cwd). Pure so the race is unit-testable
 * (review finding: parent cwd ≠ child cwd). (The official mention
 * semantics keep the text literal; the scope is bookkeeping for the seam —
 * a future official carrier, if one ever exists, would be the consumer.)
 */
export function viewerCanonicalizeScope(
  viewingCwd: string | undefined,
  liveParentSessionId: string | undefined,
): { kind: 'workspace'; cwd: string } | { kind: 'session'; sessionId: string } {
  return viewingCwd !== undefined && viewingCwd !== ''
    ? { kind: 'workspace', cwd: viewingCwd }
    : { kind: 'session', sessionId: liveParentSessionId ?? '' }
}
