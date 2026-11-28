/** Internal read-only Session Browser contract shared by the app read owner and TSP presenter. */
import type { SessionSummary } from '../../runtime/session-reader-port.ts'
import type { SessionActivityFact, SessionInspectorData, SessionWorkspaceFact } from '../../runtime/session-workspace-facts-port.ts'
import type { HostDirectoryBrowsePort } from '../../runtime/host-directory-browse-port.ts'

export interface SessionBrowserWorkspaceMetadata {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
}

export type SessionBrowserRow = SessionSummary & {
  readonly title?: string
  readonly workspace?: SessionBrowserWorkspaceMetadata
}

export type SessionBrowserPriority = 'needs' | 'working' | 'recent'
export type SessionBrowserPending =
  | 'question'
  | 'approval'
  | 'plan-review'
  | 'none'
  | 'unknown'
  | 'unavailable'
  | 'denied'
  | 'unverified'

export interface SessionBrowserRowClassification {
  readonly priority: SessionBrowserPriority
  readonly pending: SessionBrowserPending
  readonly running: boolean | undefined
  readonly answerable: boolean
  readonly source: SessionActivityFact['attentionSourceState']
  readonly browseEligible: boolean
  readonly searchEligible: boolean
}

/** Whether the Client-root eligibility proves THIS Client may answer the
 * pending candidate the Host reported for `sessionId`. */
function provedAnswerable(
  fact: SessionActivityFact,
  eligibility: readonly SessionBrowserAnswerEligibility[] | undefined,
): boolean {
  if (fact.attentionSourceState !== 'known') return false
  if (fact.attention === 'approval') {
    return eligibility?.some(entry => entry.sessionId === fact.sessionId && entry.kind === 'approval') === true
  }
  if (fact.attention !== 'question' && fact.attention !== 'plan-review') return false
  if (eligibility?.some(entry => entry.sessionId === fact.sessionId && entry.kind === 'question') === true) return true
  // A `continued` Question is not a forwarded token: its official proof is the
  // `active` projection minus the inbox's queued replies, and the answer is
  // re-authorized by the existing QuestionInteractionPort after the user cuts
  // into the Session. It still requires THIS composition's answer capability.
  return eligibility !== undefined && (fact.continuedQuestionCallIds?.length ?? 0) > 0
}

function classifyPending(
  activity: SessionActivityFact | undefined,
  eligibility: readonly SessionBrowserAnswerEligibility[] | undefined,
): { readonly pending: SessionBrowserPending; readonly answerable: boolean } {
  if (activity === undefined) return { pending: 'unknown', answerable: false }
  const { attention, attentionSourceState } = activity
  if (attention === 'none') {
    return { pending: attentionSourceState === 'known' ? 'none' : attentionSourceState, answerable: false }
  }
  if (attention === 'unknown') {
    return { pending: attentionSourceState === 'known' ? 'unknown' : attentionSourceState, answerable: false }
  }
  const answerable = provedAnswerable(activity, eligibility)
  return { pending: answerable ? attention : 'unverified', answerable }
}

/** The ONE pure Session Browser admission/classification policy.
 *
 * `activity` must be the exact accepted sample for this row and roster
 * revision. Search deliberately does not use Activity: every known blank is
 * excluded from an ordinary query, while Browse retains a proved Needs/Working
 * row as a real active-session exception. */
export function classifySessionBrowserRow(
  row: Pick<SessionBrowserRow, 'id' | 'origin' | 'blank'>,
  activity: SessionActivityFact | undefined,
  eligibility: readonly SessionBrowserAnswerEligibility[] | undefined,
): SessionBrowserRowClassification {
  const exactActivity = activity?.sessionId === row.id ? activity : undefined
  const { pending, answerable } = classifyPending(exactActivity, eligibility)
  const working = exactActivity?.running === true
  const normal = row.origin !== 'subagent'
  return {
    priority: answerable ? 'needs' : working ? 'working' : 'recent',
    pending,
    running: exactActivity?.running,
    answerable,
    source: exactActivity?.attentionSourceState ?? 'unknown',
    browseEligible: normal && (row.blank !== true || answerable || working),
    searchEligible: normal && row.blank !== true,
  }
}

export type SessionBrowserListState = 'loading' | 'ready' | 'empty' | 'unavailable' | 'error'
export type SessionBrowserSearchState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

export interface SessionBrowserSearchResult {
  readonly row: SessionBrowserRow
  readonly source: 'Content' | 'Metadata' | 'Both'
  readonly snippet?: string
}

/**
 * ONE live official forwarded request THIS Client root still holds for an
 * answer (G567's transient read view). It carries identity only — never a
 * question payload, an option, an answer or a Host pending record — and it
 * vanishes the moment the official invocation settles or aborts.
 */
export interface SessionBrowserAnswerEligibility {
  readonly sessionId: string
  readonly kind: 'question' | 'approval'
  readonly live: true
}

/** The current accepted Workspace baseline and its ONE Activity sample for the open. */
export interface SessionBrowserWorkspaceSnapshot {
  readonly revision: number
  readonly state: 'loading' | 'ready' | 'unavailable'
  readonly facts: readonly SessionWorkspaceFact[]
  readonly baselineProven: boolean
  readonly activityRevision?: number
  readonly activityRosterRevision?: number
  readonly activity?: readonly SessionActivityFact[]
  readonly answerEligibility: readonly SessionBrowserAnswerEligibility[] | undefined
  readonly error?: string
  readonly activityError?: string
}

/** The renderer's ONE real painted typed Session selection, with the actual
 *  Browse/Search mode that painted it. There is one selection, never a second
 *  store: the owner uses the provenance ONLY to validate that a Search target
 *  is still an accepted result (a Browse target is validated against the main
 *  roster). A query string alone cannot prove the mode: PiTUI keeps its query
 *  when Esc returns to Browse. */
export interface SessionInspectorSelection {
  readonly sessionId: string
  readonly origin: 'browse' | 'search'
}

/** The ONE selected-Session Inspector state of an open renderer. A presenter
 *  must match `sessionId` against the CURRENT typed selection before presenting
 *  it; an old exact cut is `refreshing` rather than a current-live claim. The
 *  data is display-only: it never supplies write, Resume or lifecycle authority. */
export type SessionInspectorSnapshot =
  | { readonly sessionId: string; readonly state: 'loading' }
  | { readonly sessionId: string; readonly state: 'ready'; readonly data: SessionInspectorData; readonly refreshing: boolean }
  | { readonly sessionId: string; readonly state: 'unavailable' | 'denied' | 'migration-required' | 'error'; readonly message: string }

/** Detached state produced only by SessionReader.list/projectionBatch/search. */
export interface SessionBrowserReadSnapshot {
  readonly listState: SessionBrowserListState
  readonly rows: readonly SessionBrowserRow[]
  readonly query: string
  readonly resumePending: boolean
  readonly searchState: SessionBrowserSearchState
  readonly searchResults: readonly SessionBrowserSearchResult[]
  readonly hasMore: boolean
  /** Monotonic roster acceptance revision, starting at 0 before the first
   *  accepted `list()`. Only an accepted roster increments it; a projection
   *  batch, a search update or a repaint never does. The PiTUI Session
   *  Workspace keys its ONE Activity sample on this value. */
  readonly listRevision: number
  /** The ONE selected-Session Inspector cut, absent when no Session target is
   *  selected (never a stats map for the whole roster). */
  readonly inspector?: SessionInspectorSnapshot
  readonly workspace?: SessionBrowserWorkspaceSnapshot
  readonly listError?: string
  readonly projectionError?: string
  readonly searchError?: string
  /** A FAILED background roster refresh. The last good roster stays listed;
   *  this is a nonfatal freshness fact, cleared by the next success. */
  readonly refreshError?: string
}

/** B1-B's narrow handoff, intentionally not connected to any writer in B1-A. */
export interface SessionBrowserResumeIntent {
  readonly sessionId: string
  readonly currentSessionId: string | undefined
  readonly source: 'enter' | 'activate' | 'footer' | 'direct'
}

/** One atomically captured subject for one panel lifetime. */
export interface SessionBrowserSubject {
  readonly currentSessionId: string | undefined
  readonly currentCwd: string
  /** Host-verified next-create WorkspaceId for a truly sessionless open. */
  readonly currentWorkspaceId?: string
  readonly isCurrent: () => boolean
}

export type SessionBrowserDirectorySettlement =
  | { readonly kind: 'registered'; readonly workspaceId: string; readonly path: string }
  | { readonly kind: 'failed'; readonly message: string }

/** ONE Folder-New operation's real terminal outcome. It is supplied by the
 *  command/read-owner seam; a notice, a timer or a roster diff is never a
 *  settlement channel. */
export type SessionBrowserNewSessionSettlement =
  | { readonly kind: 'committed' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'not-committed' }
  | { readonly kind: 'cancelled' }

export interface SessionBrowserPanelRequest {
  readonly subject: SessionBrowserSubject
  readonly initialDirectoryChooser?: boolean
  readonly initialDirectoryEntry?: boolean
  readonly initialDirectoryPath?: string
  readonly onQueryChange: (query: string) => void
  readonly onResumeIntent: (intent: SessionBrowserResumeIntent) => void
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly onNewSession?: (workspaceId: string, settle?: (outcome: SessionBrowserNewSessionSettlement) => void) => void
  readonly onAddDirectory?: (path: string, settle: (outcome: SessionBrowserDirectorySettlement) => void) => void
  /** Session Workspace PR3: the ONE read-only Host directory browse seam.
   *  Present ONLY when the composing renderer really supports the inline Host
   *  completion; an absent callback is not wrapped into a fake reader. The
   *  TSP native presentation never receives it. */
  readonly onListDirectory?: HostDirectoryBrowsePort['list']
  /** The renderer's ONE real typed selection report, emitted from a committed
   *  frame's painted rows only, with Browse/Search provenance. The SAME admitted
   *  id stays reported while its read-only Inspector identity page is painted;
   *  `undefined` clears. Optional solely for presenters/fixtures without the
   *  seam; both production renderers forward it. */
  readonly onInspectorSelection?: (selection: SessionInspectorSelection | undefined) => void
  readonly onClose: () => void
}

export interface SessionBrowserPanelHandle {
  isDisposed(): boolean
  /** Ordinary snapshots update results; only this one-shot option may seed
   *  editor text. `inspectorOnly` marks a publication whose ONLY changed field
   *  is the selected-Session Inspector data: a presenter with a visible consumer
   *  repaints presentation-only (no semantic target/action revision); a presenter
   *  with nothing visibly affected need not render. */
  setSnapshot(snapshot: SessionBrowserReadSnapshot, options?: {
    readonly initialQuery?: string
    readonly inspectorOnly?: boolean
  }): void
  close(): void
}

/** Internal, renderer-neutral presenter seam. Never exposed through extensions. */
export interface SessionBrowserPresentation {
  open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle
  notify(message: string, kind?: 'info' | 'error'): void
}
