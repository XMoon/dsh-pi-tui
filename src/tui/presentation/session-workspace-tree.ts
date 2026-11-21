/**
 * PR2 — the PiTUI-only action rows of the fullscreen Session Workspace tree.
 *
 * This module is a pure presentation projection. It imports no backend and
 * holds no state. It answers ONE question: given the SHARED official
 * Folder/Session/Show-more projection, which PiTUI-only action rows are really
 * visible in this frame?
 *
 * The shared `visibleWorkspaceBrowserRows` stays the authority for official
 * membership, expansion and the history watermark. Adding PiTUI-only nodes
 * there would change the meaning of the TSP Native Picker, which consumes the
 * same pure projection; this adapter therefore wraps it and never edits it.
 *
 * Only a REAL official Workspace (`officialIds`) in browse mode may grow the
 * first-child `New session` row. Synthetic groups (`Unassigned`,
 * `Membership ambiguous`) are browsable but never create a Session, and the
 * Sessionless Welcome `Choose workspace` intent never paints a create action:
 * its Folder activation performs the existing choose handoff instead.
 * @module @xmoon76/dsh-pi-tui/tui/presentation/session-workspace-tree
 */

import type { WorkspaceBrowserRow } from './session-workspace-view.ts'

/** One visible PiTUI Workspace tree row: a shared row or one action row. */
export type PiTuiWorkspaceTreeRow =
  | WorkspaceBrowserRow
  | { readonly kind: 'addDirectory'; readonly id: 'action:add-directory' }
  | { readonly kind: 'newSession'; readonly id: string; readonly workspaceId: string }

/** The ONE root Add directory row id. */
export const ADD_DIRECTORY_ROW_ID = 'action:add-directory' as const

/** How this open presents the tree. `choose-directory` is the Sessionless
 *  Welcome handoff: a Folder activation chooses the existing Workspace. */
export interface PiTuiWorkspaceTreeInput {
  readonly mode: 'browse' | 'choose-directory'
  /** The real Host registration capability of this open. */
  readonly canAddDirectory: boolean
  /** The real command-owned Session create entry of this open. */
  readonly canNewSession: boolean
}

/** Project the shared visible tree into the PiTUI tree. */
export function projectPiTuiWorkspaceTree(
  base: readonly WorkspaceBrowserRow[],
  officialIds: ReadonlySet<string>,
  input: PiTuiWorkspaceTreeInput,
): readonly PiTuiWorkspaceTreeRow[] {
  const rows: PiTuiWorkspaceTreeRow[] = []
  if (input.canAddDirectory) rows.push({ kind: 'addDirectory', id: ADD_DIRECTORY_ROW_ID })
  for (const row of base) {
    rows.push(row)
    if (row.kind !== 'folder') continue
    if (!officialIds.has(row.workspaceId)) continue
    if (!row.expanded) continue
    if (input.mode !== 'browse' || !input.canNewSession) continue
    rows.push({
      kind: 'newSession',
      id: `action:new-session:${row.workspaceId}`,
      workspaceId: row.workspaceId,
    })
  }
  return rows
}
