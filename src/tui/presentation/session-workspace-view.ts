/**
 * M5-U-D — the ONE pure projection of the fullscreen PiTUI Session Workspace.
 *
 * This module is UI-only: it imports no backend, adapter, Agent or transport,
 * performs no IO and holds no state. It answers three questions for the ONE
 * panel that paints them, from facts the panel already received:
 *
 * 1. which single group each listed main Session belongs to
 *    (`Needs attention` → `Working` → `Recent`),
 * 2. which Sessions the current Workspace scope really lists,
 * 3. what the header may truthfully say about attention OUTSIDE that scope.
 *
 * Authority chain (all read-only, all already sampled by their owner):
 * `SessionReader.list()` is the ONLY roster; `SessionWorkspaceFactsPort.
 * readActivity()` is the ONLY activity sample; the Client-root forwarded
 * answer eligibility (G567) is the ONLY positive answerability proof. A reader
 * `attention` value alone is NEVER the permission to answer, so a pending
 * candidate this Client cannot prove it can answer is `unverified` — never a
 * Needs row and never a fabricated `No pending`.
 *
 * @module @xmoon76/dsh-pi-tui/tui/presentation/session-workspace-view
 */

import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserRow,
} from '../../app/command/session-browser-presentation.ts'
import type {
  FactState,
  SessionActivityFact,
  SessionWorkspaceFact,
} from '../../runtime/session-workspace-facts-port.ts'

/** The browse scope. `pending` means the official Workspace baseline has not
 *  arrived yet: no membership judgment is made and every listed row shows. */
export type SessionWorkspaceScope =
  | { readonly kind: 'pending' }
  | { readonly kind: 'all' }
  | { readonly kind: 'current' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unassigned' }

/** The ONE list group a Session can belong to. */
export type SessionWorkspaceGroup = 'needs' | 'working' | 'recent'

/** One row's truthful pending fact.
 *
 *  - `question`/`approval`/`plan-review` are real Host pending kinds that this
 *    Client proved it can answer;
 *  - `none` is a PROVED absence (both official sources readable and empty);
 *  - `unknown`/`unavailable`/`denied` name why no kind is proven;
 *  - `unverified` is a reviewed pending candidate without THIS Client's
 *    answerability proof — visible, never answerable, never idle.
 */
export type SessionWorkspacePending =
  | 'question'
  | 'approval'
  | 'plan-review'
  | 'none'
  | 'unknown'
  | 'unavailable'
  | 'denied'
  | 'unverified'

/** The official Workspace membership of one listed Session. `ambiguous` is a
 *  Session in two or more official Workspaces: it is never guessed into one and
 *  never becomes `unassigned`. */
export type SessionWorkspaceMembership =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unassigned' }
  | { readonly kind: 'ambiguous'; readonly workspaceIds: readonly string[] }
  | { readonly kind: 'assigned'; readonly workspaceIds: readonly string[] }

/** One classified roster row. */
export interface SessionWorkspaceRowFact {
  readonly sessionId: string
  readonly group: SessionWorkspaceGroup
  readonly pending: SessionWorkspacePending
  /** The official Host running fact; `undefined` is "not proven", never idle. */
  readonly running: boolean | undefined
  /** True only for a row whose answerability THIS Client proved. */
  readonly answerable: boolean
  /** Why the pending fact is (or is not) `known`; independent of `running`. */
  readonly source: FactState
  readonly membership: SessionWorkspaceMembership
}

/** One painted group and its ordered Session ids. Empty groups are omitted. */
export interface SessionWorkspaceGroupView {
  readonly kind: SessionWorkspaceGroup
  readonly ids: readonly string[]
}

/** What the header may claim about Sessions OUTSIDE the current scope.
 *  `unknown` means the proof of "0" is missing and no number may be painted. */
export type SessionWorkspaceOutsideAttention =
  | { readonly kind: 'none' }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'unknown' }

export interface SessionWorkspaceView {
  /** Only groups with members, in the fixed Needs → Working → Recent order. */
  readonly groups: readonly SessionWorkspaceGroupView[]
  /** The exact list order the panel paints and activates. */
  readonly listIds: readonly string[]
  readonly rowsById: ReadonlyMap<string, SessionWorkspaceRowFact>
  readonly outsideAttention: SessionWorkspaceOutsideAttention
  /** The ONE Workspace whose official membership proves `current`; undefined
   *  when sessionless, absent or ambiguous. */
  readonly currentWorkspaceId: string | undefined
}

export interface SessionWorkspaceViewInput {
  /** The read owner's main roster: the ONLY membership/order authority. */
  readonly rows: readonly SessionBrowserRow[]
  /** The LAST accepted Activity sample; `undefined` = none yet. */
  readonly activity: readonly SessionActivityFact[] | undefined
  /** The Client-root official forwarded-answer eligibility; `undefined` means
   *  this composition has NO official answer capability (Direct/TSP), so no
   *  row can ever be a proved need. */
  readonly answerEligibility: readonly SessionBrowserAnswerEligibility[] | undefined
  /** The official Workspace facts in `follow` order. */
  readonly workspaces: readonly SessionWorkspaceFact[]
  /** Whether this open received a valid official Workspace baseline. */
  readonly workspaceBaselineProven: boolean
  readonly scope: SessionWorkspaceScope
  readonly currentSessionId: string | undefined
  /** The previous list order: the deterministic tie-break after `updatedAt`. */
  readonly priorIdOrder?: readonly string[]
}

/** Resolve the ONE Workspace whose official `sessionIds` contain the current
 *  Session. `undefined` for a sessionless/absent/ambiguous membership: the
 *  caller falls back to All instead of guessing from a cwd. */
export function currentWorkspaceOf(
  workspaces: readonly SessionWorkspaceFact[],
  sessionId: string | undefined,
): string | undefined {
  if (sessionId === undefined) return undefined
  let found: string | undefined
  for (const workspace of workspaces) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    if (found !== undefined) return undefined
    found = workspace.workspaceId
  }
  return found
}

/** The official membership of one listed Session. Without a valid baseline the
 *  membership is `unknown` — never `unassigned`. */
export function workspaceMembershipOf(
  workspaces: readonly SessionWorkspaceFact[],
  sessionId: string,
  baselineProven: boolean,
): SessionWorkspaceMembership {
  if (!baselineProven) return { kind: 'unknown' }
  const workspaceIds = workspaces
    .filter(workspace => workspace.sessionIds.includes(sessionId))
    .map(workspace => workspace.workspaceId)
  if (workspaceIds.length === 0) return { kind: 'unassigned' }
  if (workspaceIds.length > 1) return { kind: 'ambiguous', workspaceIds }
  return { kind: 'assigned', workspaceIds }
}

/** Whether one classified row belongs to the current browse scope. */
function inScope(
  fact: SessionWorkspaceRowFact,
  scope: SessionWorkspaceScope,
  currentWorkspaceId: string | undefined,
  baselineProven: boolean,
): boolean {
  switch (scope.kind) {
    case 'pending':
    case 'all':
      return true
    case 'current':
      if (currentWorkspaceId === undefined) return false
      return fact.membership.kind !== 'unknown'
        && fact.membership.kind !== 'unassigned'
        && fact.membership.workspaceIds.includes(currentWorkspaceId)
    case 'workspace':
      return fact.membership.kind !== 'unknown'
        && fact.membership.kind !== 'unassigned'
        && fact.membership.workspaceIds.includes(scope.workspaceId)
    case 'unassigned':
      return baselineProven && fact.membership.kind === 'unassigned'
  }
}

/** Whether the Client-root eligibility proves THIS Client may answer the
 *  pending candidate the Host reported for `sessionId`. */
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
): { readonly pending: SessionWorkspacePending; readonly answerable: boolean } {
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

/** Build the ONE view of one frame. Every input is an official fact or the
 *  previous pure ordering; nothing here reads, writes or invents a Session. */
export function buildSessionWorkspaceView(input: SessionWorkspaceViewInput): SessionWorkspaceView {
  // The read owner's roster already excludes subagent children; this pure
  // projection keeps the SAME corpus contract so a child can never be
  // classified (and never becomes a main-Session row).
  const roster = input.rows.filter(row => row.origin !== 'subagent')
  const activityById = new Map<string, SessionActivityFact>()
  for (const activity of input.activity ?? []) activityById.set(activity.sessionId, activity)
  const currentWorkspaceId = currentWorkspaceOf(input.workspaces, input.currentSessionId)
  const rosterIndex = new Map<string, number>()
  roster.forEach((row, index) => { rosterIndex.set(row.id, index) })
  const priorIndex = new Map<string, number>()
  input.priorIdOrder?.forEach((id, index) => { priorIndex.set(id, index) })

  const rowsById = new Map<string, SessionWorkspaceRowFact>()
  const classified: SessionWorkspaceRowFact[] = []
  for (const row of roster) {
    const activity = activityById.get(row.id)
    const { pending, answerable } = classifyPending(activity, input.answerEligibility)
    const fact: SessionWorkspaceRowFact = {
      sessionId: row.id,
      group: answerable ? 'needs' : activity?.running === true ? 'working' : 'recent',
      pending,
      running: activity?.running,
      answerable,
      source: activity?.attentionSourceState ?? 'unknown',
      membership: workspaceMembershipOf(input.workspaces, row.id, input.workspaceBaselineProven),
    }
    rowsById.set(row.id, fact)
    classified.push(fact)
  }

  const updatedAt = new Map(roster.map(row => [row.id, row.updatedAt] as const))
  const orderOf = (left: SessionWorkspaceRowFact, right: SessionWorkspaceRowFact): number => {
    const byTime = updatedAt.get(right.sessionId)! - updatedAt.get(left.sessionId)!
    if (byTime !== 0) return byTime
    const priorLeft = priorIndex.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER
    const priorRight = priorIndex.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER
    if (priorLeft !== priorRight) return priorLeft - priorRight
    return rosterIndex.get(left.sessionId)! - rosterIndex.get(right.sessionId)!
  }

  const scoped = classified.filter(fact =>
    inScope(fact, input.scope, currentWorkspaceId, input.workspaceBaselineProven))
  const groups: SessionWorkspaceGroupView[] = []
  const listIds: string[] = []
  for (const kind of ['needs', 'working', 'recent'] as const) {
    const ids = scoped.filter(fact => fact.group === kind).sort(orderOf).map(fact => fact.sessionId)
    if (ids.length === 0) continue
    groups.push({ kind, ids })
    listIds.push(...ids)
  }

  let outsideAttention: SessionWorkspaceOutsideAttention = { kind: 'none' }
  if (input.scope.kind !== 'all' && input.scope.kind !== 'pending') {
    let count = 0
    let unknown = false
    for (const fact of classified) {
      if (inScope(fact, input.scope, currentWorkspaceId, input.workspaceBaselineProven)) continue
      if (fact.answerable) {
        count += 1
        continue
      }
      // Anything outside the scope that is not a PROVED non-pending row leaves
      // "0 outside needs attention" unproved: no number may be painted.
      if (fact.pending !== 'none') unknown = true
    }
    outsideAttention = unknown ? { kind: 'unknown' } : { kind: 'count', count }
  }

  return { groups, listIds, rowsById, outsideAttention, currentWorkspaceId }
}
