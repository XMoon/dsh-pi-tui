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
import { sanitizedPhysicalLine } from './lines.ts'
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

/** Priority inside one official Workspace group; never a global group axis. */
export type SessionWorkspacePriority = 'needs' | 'working' | 'recent'
export type SessionWorkspaceGroup = SessionWorkspacePriority

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
  readonly priority: SessionWorkspacePriority
  /** Compatibility projection for the pre-Workspace baseline renderer. */
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
  readonly kind?: SessionWorkspaceGroup
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly ids: readonly string[]
}

/** Display title collisions by the shortest unique Host path tail. The ID is a
 * final fallback only when Host paths themselves remain indistinguishable. */
export function workspaceDisplayLabels(
  workspaces: readonly Pick<SessionWorkspaceFact, 'workspaceId' | 'title' | 'path'>[],
): ReadonlyMap<string, string> {
  const facts = workspaces.map(workspace => ({
    workspaceId: sanitizedPhysicalLine(workspace.workspaceId),
    key: workspace.workspaceId,
    title: sanitizedPhysicalLine(workspace.title),
    segments: sanitizedPhysicalLine(workspace.path).split('/').filter(Boolean),
  }))
  const groups = new Map<string, typeof facts>()
  for (const fact of facts) {
    const title = fact.title || 'Workspace'
    const group = groups.get(title) ?? []
    group.push(fact)
    groups.set(title, group)
  }
  const labels = new Map<string, string>()
  for (const [title, group] of groups) {
    for (const fact of group) {
      if (group.length === 1) {
        labels.set(fact.key, title)
        continue
      }
      let suffix: string | undefined
      for (let count = 1; count <= Math.max(...group.map(item => item.segments.length)); count += 1) {
        const candidate = fact.segments.slice(-count).join('/')
        if (candidate !== '' && group.filter(item => item !== fact).every(item => item.segments.slice(-count).join('/') !== candidate)) {
          suffix = candidate
          break
        }
      }
      if (suffix !== undefined) {
        labels.set(fact.key, `${title} (${suffix})`)
        continue
      }
      const prefix = [...fact.workspaceId].findIndex((_, index) => group.every(item => item === fact || item.workspaceId[index] !== fact.workspaceId[index]))
      labels.set(fact.key, `${title} (${prefix < 0 ? fact.workspaceId : fact.workspaceId.slice(0, prefix + 1)})`)
    }
  }
  return labels
}

/** What the header may claim about Sessions OUTSIDE the current scope.
 *  `unknown` means the proof of "0" is missing and no number may be painted. */
export type SessionWorkspaceOutsideAttention =
  | { readonly kind: 'none' }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'unknown' }

export interface SessionWorkspaceView {
  /** Official Workspace groups in Host follow order; absent proof uses flat rows. */
  readonly groups: readonly SessionWorkspaceGroupView[]
  /** Flat fallback for a missing Workspace baseline. */
  readonly listIds: readonly string[]
  readonly rowsById: ReadonlyMap<string, SessionWorkspaceRowFact>
  readonly outsideAttention: SessionWorkspaceOutsideAttention
  /** The ONE Workspace whose official membership proves `current`; undefined
   *  when sessionless, absent or ambiguous. */
  readonly currentWorkspaceId: string | undefined
  readonly nextCreateWorkspaceId: string | undefined
  readonly workspaceBaselineProven: boolean
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
  readonly nextCreateWorkspaceId?: string
  readonly legacyGroupMode?: boolean
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

export interface WorkspaceBrowserDisplayState {
  readonly expanded: ReadonlyMap<string, boolean>
  readonly historyLimit: ReadonlyMap<string, number>
}

export type WorkspaceBrowserRow =
  | { readonly kind: 'folder'; readonly id: string; readonly workspaceId: string; readonly title: string; readonly path: string; readonly total: number; readonly needs: number; readonly working: number; readonly expanded: boolean; readonly current: boolean; readonly next: boolean }
  | { readonly kind: 'session'; readonly id: string; readonly workspaceId: string; readonly sessionId: string }
  | { readonly kind: 'showMore'; readonly id: string; readonly workspaceId: string; readonly remaining: number }

/** Project the complete authority model into one renderer-local visible row list. */
export function visibleWorkspaceBrowserRows(
  model: SessionWorkspaceView,
  display: WorkspaceBrowserDisplayState,
  selectedSessionId?: string,
  currentSessionId?: string,
): readonly WorkspaceBrowserRow[] {
  if (!model.workspaceBaselineProven) {
    return model.listIds.map(sessionId => ({ kind: 'session' as const, id: `session:${sessionId}`, workspaceId: 'unavailable', sessionId }))
  }
  const rows: WorkspaceBrowserRow[] = []
  const labels = workspaceDisplayLabels(model.groups)
  for (const group of model.groups) {
    const facts = group.ids.map(id => model.rowsById.get(id)!)
    const needs = facts.filter(fact => fact.priority === 'needs').length
    const working = facts.filter(fact => fact.priority === 'working').length
    const current = group.workspaceId === model.currentWorkspaceId
    const next = group.workspaceId === model.nextCreateWorkspaceId
    const defaultExpanded = current || next || needs + working > 0
    const expanded = display.expanded.get(group.workspaceId) ?? defaultExpanded
    const groupRows: WorkspaceBrowserRow[] = []
    rows.push({
      kind: 'folder',
      id: `workspace:${group.workspaceId}`,
      workspaceId: group.workspaceId,
      title: labels.get(group.workspaceId) ?? group.title,
      path: group.path,
      total: group.ids.length,
      needs,
      working,
      expanded,
      current,
      next,
    })
    if (!expanded) continue
    const activeIds = facts.filter(fact => fact.priority !== 'recent').map(fact => fact.sessionId)
    const recentIds = facts.filter(fact => fact.priority === 'recent').map(fact => fact.sessionId)
    const defaultLimit = group.workspaceId === model.currentWorkspaceId || group.workspaceId === model.nextCreateWorkspaceId ? 8 : 0
    const limit = display.historyLimit.get(group.workspaceId) ?? defaultLimit
    const visibleRecent = recentIds.slice(0, limit)
    const visible = new Set([...activeIds, ...visibleRecent])
    if (selectedSessionId !== undefined && group.ids.includes(selectedSessionId)) visible.add(selectedSessionId)
    if (currentSessionId !== undefined && group.ids.includes(currentSessionId)) visible.add(currentSessionId)
    for (const sessionId of group.ids) {
      if (!visible.has(sessionId)) continue
      groupRows.push({ kind: 'session', id: `session:${sessionId}`, workspaceId: group.workspaceId, sessionId })
    }
    rows.push(...groupRows)
    const remaining = recentIds.length - visibleRecent.length
    if (remaining > 0) rows.push({
      kind: 'showMore',
      id: `more:${group.workspaceId}`,
      workspaceId: group.workspaceId,
      remaining,
    })
  }
  return rows
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
      priority: answerable ? 'needs' : activity?.running === true ? 'working' : 'recent',
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
    const priority = ['needs', 'working', 'recent'] as const
    const byPriority = priority.indexOf(left.priority) - priority.indexOf(right.priority)
    if (byPriority !== 0) return byPriority
    const byTime = updatedAt.get(right.sessionId)! - updatedAt.get(left.sessionId)!
    if (byTime !== 0) return byTime
    const priorLeft = priorIndex.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER
    const priorRight = priorIndex.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER
    if (priorLeft !== priorRight) return priorLeft - priorRight
    return rosterIndex.get(left.sessionId)! - rosterIndex.get(right.sessionId)!
  }

  if (input.legacyGroupMode) {
    const scoped = classified.filter(fact => inScope(fact, input.scope, currentWorkspaceId, input.workspaceBaselineProven))
    const groups: SessionWorkspaceGroupView[] = []
    const listIds: string[] = []
    for (const kind of ['needs', 'working', 'recent'] as const) {
      const ids = scoped.filter(fact => fact.priority === kind).sort(orderOf).map(fact => fact.sessionId)
      if (ids.length === 0) continue
      groups.push({ kind, workspaceId: kind, title: kind === 'needs' ? 'Needs attention' : kind === 'working' ? 'Working' : 'Recent', path: '', ids })
      listIds.push(...ids)
    }
    return { groups, listIds, rowsById, outsideAttention: { kind: 'none' }, currentWorkspaceId, nextCreateWorkspaceId: input.nextCreateWorkspaceId, workspaceBaselineProven: input.workspaceBaselineProven }
  }

  if (!input.workspaceBaselineProven) {
    const scoped = classified.filter(fact => inScope(fact, input.scope, currentWorkspaceId, false))
    const legacyGroups: SessionWorkspaceGroupView[] = []
    const legacyListIds: string[] = []
    for (const kind of ['needs', 'working', 'recent'] as const) {
      const ids = scoped.filter(fact => fact.priority === kind).sort(orderOf).map(fact => fact.sessionId)
      if (ids.length === 0) continue
      legacyGroups.push({ kind, workspaceId: kind, title: kind === 'needs' ? 'Needs attention' : kind === 'working' ? 'Working' : 'Recent', path: '', ids })
      legacyListIds.push(...ids)
    }
    return { groups: legacyGroups, listIds: legacyListIds, rowsById, outsideAttention: { kind: 'none' }, currentWorkspaceId, nextCreateWorkspaceId: input.nextCreateWorkspaceId, workspaceBaselineProven: false }
  }


  const listIds = classified
    .filter(fact => inScope(fact, input.scope, currentWorkspaceId, input.workspaceBaselineProven))
    .sort(orderOf)
    .map(fact => fact.sessionId)


  const groups: SessionWorkspaceGroupView[] = []
  if (input.workspaceBaselineProven) {
    for (const workspace of input.workspaces) {
      const ids = classified
        .filter(fact => fact.membership.kind === 'assigned' && fact.membership.workspaceIds[0] === workspace.workspaceId)
        .sort(orderOf)
        .map(fact => fact.sessionId)
      groups.push({ workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path, ids })
    }
    const ambiguous = classified.filter(fact => fact.membership.kind === 'ambiguous').sort(orderOf).map(fact => fact.sessionId)
    const unassigned = classified.filter(fact => fact.membership.kind === 'unassigned').sort(orderOf).map(fact => fact.sessionId)
    if (ambiguous.length > 0) groups.push({ workspaceId: 'ambiguous', title: 'Membership ambiguous', path: '', ids: ambiguous })
    if (unassigned.length > 0) groups.push({ workspaceId: 'unassigned', title: 'Unassigned', path: '', ids: unassigned })
  const priorityWorkspaceId = currentWorkspaceId ?? input.nextCreateWorkspaceId
  if (priorityWorkspaceId !== undefined) {
    const priorityIndex = groups.findIndex(group => group.workspaceId === priorityWorkspaceId)
    if (priorityIndex > 0) groups.unshift(...groups.splice(priorityIndex, 1))
  }
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
      if (fact.pending !== 'none') unknown = true
    }
    outsideAttention = unknown ? { kind: 'unknown' } : { kind: 'count', count }
  }

  return { groups, listIds, rowsById, outsideAttention, currentWorkspaceId, nextCreateWorkspaceId: input.nextCreateWorkspaceId, workspaceBaselineProven: input.workspaceBaselineProven }
}
