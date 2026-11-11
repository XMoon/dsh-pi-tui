/**
 * The ONE pure navigation-admission policy for a REFUSED Host Workspace
 * pre-selection.
 *
 * This module answers exactly one question: may the local UI guide the user to
 * choose a different Workspace after a Host `resolveWorkspace` rejection? It
 * never answers whether a Workspace exists, whether the Host wrote one, or what
 * the current connection/auth state is. The only inputs are the typed
 * `WorkspaceSelectionError` the Host lifecycle port already produced, so no
 * error message, HTTP status, Browser snapshot or next-intent status can be
 * re-classified into a recovery.
 *
 * - `refused` is a proven Host business refusal BEFORE any Session create.
 * - `unavailable` and `superseded` never navigate: a disconnected Host is not
 *   a directory error, and a new generation must not revive an expired one.
 * - An unknown refusal code is deliberately not navigable: the official Host
 *   taxonomy is closed here, and a future code needs its own contract.
 *
 * @module @xmoon76/dsh-pi-tui/app/session/workspace-selection-recovery
 */

import { WorkspaceSelectionError } from '../../runtime/session-lifecycle-port.ts'

/** The ONE recovery decision for one typed pre-selection failure. */
export type WorkspaceRecoveryDecision =
  | { readonly kind: 'select-workspace'; readonly reason: 'refused'; readonly code?: string }
  | { readonly kind: 'none' }

/**
 * The official pre-create refusal codes that prove the USER can fix the target
 * by choosing another directory. Anything else is not this UI's decision.
 */
const NAVIGABLE_REFUSALS: ReadonlySet<string> = new Set([
  'workspace/invalid-path',
  'workspace/not-found',
  'workspace/name-conflict',
])

/** True only for an authoritative, human-reselectable PRE-CREATE refusal. */
export function recoverableWorkspaceSelection(error: unknown): WorkspaceRecoveryDecision {
  if (!(error instanceof WorkspaceSelectionError) || error.kind !== 'refused') return { kind: 'none' }
  if (error.code !== undefined && !NAVIGABLE_REFUSALS.has(error.code)) return { kind: 'none' }
  return {
    kind: 'select-workspace',
    reason: 'refused',
    ...(error.code === undefined ? {} : { code: error.code }),
  }
}
