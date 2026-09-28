/**
 * The subagent viewer's identity and action gates (plan §27): the async
 * viewer-OPEN invalidation token, the session-swap teardown, the semantic
 * action capability gate while a viewer is open, and the pending-call
 * matching that decides which child an open belongs to.
 *
 * Pure and Host-free: the runner closure is not headless-drivable, so the
 * viewer lifecycle rules are pinned through these seams.
 * @module @xmoon76/dsh-pi-tui/subagent-viewer
 */

import type { TuiAction } from './extension/public-types.ts'
/** One unsettled subagent delegation, in tool/call order. */
export interface PendingSubagentCall {
  readonly callId: string
  readonly description: string
}

/**
 * The async viewer-OPEN invalidation token (pure, exported for the headless
 * suite — the runner closure itself is not drivable in the headless tests,
 * so the lifecycle rule is tested through these token semantics). An open
 * request captures a token; EVERY viewer session change — opening another
 * child, leaving the viewer (Esc), or a session swap (which routes through
 * exitView) — invalidates the token, so a slow transcript inspection can
 * never commit an obsolete child over the current surface. Invalidation is
 * unconditional: an exit that finds NO mounted viewer still invalidates,
 * because the open is exactly then still in flight (round-5 finding).
 */
export interface ViewerOpenToken {
  /** The current token value (bumped by every open and every invalidate). */
  readonly current: number
  /** Start one async open; returns the request's token. */
  open(): number
  /** Invalidate every in-flight open (a viewer session change). */
  invalidate(): void
  /** Whether a request may still commit. */
  isCurrent(request: number): boolean
}

export function createViewerOpenToken(): ViewerOpenToken {
  let value = 0
  return {
    get current(): number {
      return value
    },
    open: () => ++value,
    invalidate: () => {
      value += 1
    },
    isCurrent: (request) => request === value,
  }
}

/**
 * Session-swap viewer teardown (pure, exported for the headless suite —
 * the runner closure is not headless-drivable, so the rule is pinned
 * through this seam). A session swap must do BOTH: invalidate any
 * in-flight viewer OPEN — UNCONDITIONALLY, because the open may still be
 * loading when nothing is mounted yet, and the swap must still cancel it
 * (round-6 finding) — and close a MOUNTED viewer when there is one.
 * @param token - the shared viewer-open token.
 * @param mounted - whether a viewer is currently mounted.
 * @param closeMounted - closes the mounted viewer (a no-op when unmounted).
 * @returns whether a mounted viewer was closed.
 */
export function teardownViewerForSessionSwap(
  token: ViewerOpenToken,
  mounted: boolean,
  closeMounted: () => void,
): boolean {
  token.invalidate()
  if (!mounted) return false
  closeMounted()
  return true
}

/**
 * The viewer capability gate for SEMANTIC plugin actions (pure, exported
 * for the headless suite — the runner closure is not drivable there).
 * While a subagent viewer is open, only actions that stay CHILD- or
 * SURFACE-local are allowed; every action with PARENT-session side
 * effects (steer, cancel/interrupt, permission cycling, the main
 * transcript search) is blocked, so a plugin keybinding can never
 * interrupt/steer/reconfigure the parent from inside the viewer. The
 * raw-key viewer guard already consumes the parent chords — this gate
 * closes the plugin-keybinding path, the only other way a semantic
 * action reaches the runner.
 * @param action - the semantic action the plugin requested.
 * @param viewer - the open viewer (mode), or undefined when no viewer.
 * @returns whether the runner may execute the action.
 */
export function viewerActionCapability(
  action: TuiAction,
  viewer: { mode: 'one-shot' | 'continuable' } | undefined,
): boolean {
  if (viewer === undefined) return true
  switch (action) {
    case 'submit-draft':
    case 'queue-draft':
    case 'toggle-fullscreen':
      // Child- or surface-local: submitDraft routes to the child (and
      // hard-rejects in a one-shot viewer); fullscreen is chrome-local.
      return true
    default:
      // steer-draft / cancel-activity / cycle-permission / open-search
      // all target the parent session — never while viewing.
      return false
  }
}

/**
 * Match the child a user is about to view against the unsettled subagent
 * calls (pure, exported for the headless suite). The child's durable label
 * is the delegation's `description`; duplicate descriptions take the MOST
 * RECENT call (the one the user is most likely watching), an empty/absent
 * label falls back to a LONE pending call, and no match disables the
 * auto-pop (the user exits the viewer with Esc as before — never a wrong
 * pop). Mutates `pending` by removing the matched call.
 * @param pending - the unsettled calls, in order (oldest first).
 * @param label - the child's durable label; '' or undefined = no description.
 * @returns the matched call, or undefined when nothing matches.
 */
export function matchPendingSubagentCall(
  pending: PendingSubagentCall[],
  label: string | undefined,
): PendingSubagentCall | undefined {
  if (label !== undefined && label !== '') {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]!.description === label) {
        return pending.splice(index, 1)[0]
      }
    }
    // No description match: a lone pending call is the only remaining
    // candidate (the user can only be viewing the one unsettled child).
    if (pending.length === 1) return pending.splice(0, 1)[0]
    return undefined
  }
  // No usable label: only a lone pending call can be tied unambiguously.
  if (pending.length === 1) return pending.splice(0, 1)[0]
  return undefined
}
