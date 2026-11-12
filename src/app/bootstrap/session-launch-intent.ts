/**
 * The CLI Session-launch decision policy (session CLI PR2): the Host
 * Workspace-scoped `-c` selection plus the re-exported UI-neutral listed-row
 * classifiers shared with the startup Browser.
 *
 * The canonical-id / legal-prefix / exact-row lookup rules live in
 * `domain/session/browser.ts` because BOTH the pre-mount decision and the
 * post-mount Session Browser direct match must apply the same strict CLI
 * policy. This module owns only the Host Workspace membership choice; it
 * performs no Host IO, holds no cache and starts no work.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/session-launch-intent
 */

import { chooseListedSession as chooseListedSessionRow, type SessionMatchRow } from '../../domain/session/browser.ts'

export {
  canonicalFullSessionId,
  cliAutoPrefix,
} from '../../domain/session/browser.ts'

/** The id form of the shared listed-row classifier (the composition root and
 *  its decision tests use ids; the Session Browser direct match uses the row). */
export function chooseListedSession(rows: readonly SessionMatchRow[], query: string): string | undefined {
  return chooseListedSessionRow(rows, query)?.id
}

/** The listed-row shape the `-c` policy reads. */
export type LaunchSessionRow = SessionMatchRow

/**
 * The `-c` choice: the FIRST row of the official main roster that is a
 * non-subagent member of the confirmed Host Workspace. The roster order is
 * kept verbatim (the Host already orders newest-first); this function never
 * re-sorts and never falls back to a different Workspace.
 */
export function chooseContinueSession(
  rows: readonly LaunchSessionRow[],
  workspaceSessionIds: readonly string[],
): string | undefined {
  const members = new Set(workspaceSessionIds)
  return rows.find(row => row.origin !== 'subagent' && members.has(row.id))?.id
}
