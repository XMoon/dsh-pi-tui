/**
 * Session Workspace PR3 — the ONE pure display projection of the selected
 * Session Inspector.
 *
 * This module is presentation-only: it imports no read owner, adapter, Host
 * port, ANSI renderer or native SDK node, performs no IO and keeps no state. It
 * answers exactly one question for the two real presenters (the PiTUI Session
 * Workspace and the TSP native Session Browser):
 *
 *   "Given the SAME typed Session row, its already-classified Workspace fact,
 *    its matching Inspector cut and the accepted Search excerpt, how are the
 *    visible facts grouped and formatted?"
 *
 * The facts themselves stay owned by their existing authorities:
 * `SessionBrowserReadOwner` owns the roster/selection/Inspector cut, the
 * official Inspector mapper owns every numeric/derived value, the roster owns
 * `title`/`cwd`/dates/format state and the Workspace facts own membership. A
 * missing value is never coerced to zero, a null goal/todo record stays a known
 * empty answer, and the roster preset is labelled as a roster hint until the
 * exact Inspector cut carries the authoritative preset.
 *
 * @module @xmoon76/dsh-pi-tui/tui/presentation/session-inspector-view
 */

import type {
  SessionBrowserRow,
  SessionInspectorSnapshot,
} from '../../app/command/session-browser-presentation.ts'
import type { SessionWorkspaceFact } from '../../runtime/session-workspace-facts-port.ts'
import { shortSessionId } from '../../domain/session/browser.ts'
import { formatSessionAge } from '../pickers/sessions.ts'
import { formatTokens } from '../token-format.ts'
import { sanitizedPhysicalLine } from './lines.ts'
import {
  SESSION_PENDING_LABEL,
  SESSION_SOURCE_LABEL,
  workspaceRowStatusLabel,
  type SessionWorkspaceRowFact,
} from './session-workspace-view.ts'

/** One read-only `label: value` display fact. Both fields are display-safe. */
export interface SessionInspectorFact {
  readonly label: string
  readonly value: string
}

/** One labelled display group. `prose` marks Host content the user reads as a
 *  complete wrapped value (the Search excerpt), never as an aligned grid row. */
export interface SessionInspectorGroup {
  readonly id: string
  readonly head: string
  readonly facts: readonly SessionInspectorFact[]
  readonly prose?: true
}

/** The Inspector's own state, mirrored from the owner's discriminated union. */
export type SessionInspectorViewState =
  | 'loading'
  | 'ready'
  | 'refreshing'
  | 'unavailable'
  | 'denied'
  | 'migration-required'
  | 'error'

/** The accepted Search hit that admitted the selected result, display-only. */
export interface SessionInspectorExcerpt {
  readonly source: 'Content' | 'Metadata' | 'Both'
  readonly snippet: string
}

export interface SessionInspectorViewInput {
  /** The ONE typed Session row this presenter already admitted and painted. */
  readonly row: SessionBrowserRow
  /** Its already-classified Workspace fact; `undefined` = not classified yet. */
  readonly fact: SessionWorkspaceRowFact | undefined
  /** The matching Inspector cut. An absent/mismatched cut is `loading`; it is
   *  never the previous Session's data and never a fabricated ready state. */
  readonly inspector: SessionInspectorSnapshot | undefined
  /** The accepted official Workspace facts of this open, in `follow` order. */
  readonly workspaces: readonly SessionWorkspaceFact[]
  readonly workspaceBaselineProven: boolean
  readonly currentSessionId: string | undefined
  /** Present ONLY while this target is the accepted Search result. */
  readonly excerpt?: SessionInspectorExcerpt
}

/** The ONE display projection of one selected Session's Inspector. */
export interface SessionInspectorView {
  readonly sessionId: string
  /** The full official Host identity (never the painted short id). */
  readonly fullId: string
  readonly shortId: string
  /** Title preference: matching ready cut title, then roster title, then id. */
  readonly title: string
  /** `Current · Persisted · Working`-style positive state facts, joined. */
  readonly stateLabel: string
  /** The printed Identity `State` value (`Persisted session · Migration required`). */
  readonly identityState: string
  /** The fixed truthful freshness line (`Updated 2m`). */
  readonly freshness: string
  /** Whether the Indicator groups below describe a settled (or last known) cut. */
  readonly state: SessionInspectorViewState
  /** The ONE fixed status sentence of a non-ready state (or `Refreshing`). */
  readonly notice: string
  /** Full reading groups, in reading order. Empty while no cut is available. */
  readonly groups: readonly SessionInspectorGroup[]
  /** The compact selected-preview subset (never a second fact authority). */
  readonly summary: readonly SessionInspectorFact[]
}

/** The display token for an absent optional value: unknown, never zero. */
const MISSING = '—'

/** One display duration with a real unit. This is presentation only: the raw
 *  millisecond values stay the Inspector DTO's authority. */
export function formatInspectorDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return MISSING
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 1) {
    const text = (ms / 1000).toFixed(1)
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}s`
  }
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

/** One display rate with a real unit; absent samples stay unknown. */
export function formatInspectorRate(tokensPerSec: number | undefined): string {
  if (tokensPerSec === undefined || !Number.isFinite(tokensPerSec)) return MISSING
  const text = tokensPerSec.toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text} tok/s`
}

/** Context occupancy: approximate percentage and/or used/window, independently
 *  missing. The percentage is never painted without a legal denominator. */
function contextValue(data: Extract<SessionInspectorSnapshot, { readonly state: 'ready' }>['data']): string {
  const context = data.context
  if (context === undefined) return MISSING
  const parts: string[] = []
  if (context.percent !== undefined) parts.push(`≈${context.percent}%`)
  if (context.usedTokens !== undefined) {
    parts.push(context.windowTokens === undefined
      ? `${formatTokens(context.usedTokens)} tokens`
      : `${formatTokens(context.usedTokens)} / ${formatTokens(context.windowTokens)}`)
  } else if (context.windowTokens !== undefined) {
    parts.push(`window ${formatTokens(context.windowTokens)}`)
  }
  return parts.length === 0 ? MISSING : parts.join(' · ')
}

/** One official membership label from the proven Workspace facts, never from a
 *  cwd. Unknown/unassigned/ambiguous keep their own truthful words. */
function membershipValue(
  fact: SessionWorkspaceRowFact | undefined,
  workspaces: readonly SessionWorkspaceFact[],
  baselineProven: boolean,
): string {
  if (fact === undefined || !baselineProven) return 'Unknown'
  switch (fact.membership.kind) {
    case 'unknown':
      return 'Unknown'
    case 'unassigned':
      return 'Unassigned'
    case 'ambiguous':
      return `Ambiguous (${fact.membership.workspaceIds.map(sanitizedPhysicalLine).join(', ')})`
    case 'assigned':
      return fact.membership.workspaceIds.map(id => {
        const workspace = workspaces.find(candidate => candidate.workspaceId === id)
        if (workspace === undefined) return sanitizedPhysicalLine(id)
        const title = sanitizedPhysicalLine(workspace.title)
        const path = sanitizedPhysicalLine(workspace.path)
        return path === '' ? title : `${title} · ${path}`
      }).join(' · ')
  }
}

/** The positive identity/state facts of one Session row. Only proven facts are
 *  painted; `ing`/`live`/`current` never imply one another. */
function stateParts(row: SessionBrowserRow, fact: SessionWorkspaceRowFact | undefined, currentSessionId: string | undefined): string[] {
  const parts: string[] = []
  if (row.id === currentSessionId) parts.push('Current')
  parts.push(row.live ? 'Live' : 'Persisted')
  if (fact !== undefined) {
    // Reuse the ONE wording authority; only its verbose transitional phrase is
    // shortened for the compact header.
    const status = workspaceRowStatusLabel(fact)
    if (status === 'Pending · not actionable here') parts.push('Pending unverified')
    else if (status !== '') parts.push(status)
  }
  if (row.formatStatus === 'migration-required') parts.push('Migration required')
  return parts
}

/** The official goal objective/phase, with legal null kept as 'No goal'. */
function goalFacts(data: Extract<SessionInspectorSnapshot, { readonly state: 'ready' }>['data']): SessionInspectorFact[] {
  const goal = data.goal
  if (goal === undefined) {
    return [
      { label: 'Goal', value: 'Unknown' },
      { label: 'Goal phase', value: MISSING },
    ]
  }
  if (goal === null) {
    return [
      { label: 'Goal', value: 'No goal' },
      { label: 'Goal phase', value: MISSING },
    ]
  }
  return [
    { label: 'Goal', value: sanitizedPhysicalLine(goal.objective) },
    { label: 'Goal phase', value: goal.phase },
  ]
}

/** The official TODO status counts, preserving legal null and unknown. */
function todoFacts(data: Extract<SessionInspectorSnapshot, { readonly state: 'ready' }>['data']): SessionInspectorFact[] {
  const todos = data.todos
  if (todos === undefined) {
    return [
      { label: 'Pending', value: 'Unknown' },
      { label: 'In progress', value: 'Unknown' },
      { label: 'Completed', value: 'Unknown' },
    ]
  }
  if (todos === null) {
    return [
      { label: 'Pending', value: 'No todo record' },
      { label: 'In progress', value: MISSING },
      { label: 'Completed', value: MISSING },
    ]
  }
  return [
    { label: 'Pending', value: String(todos.pending) },
    { label: 'In progress', value: String(todos.inProgress) },
    { label: 'Completed', value: String(todos.completed) },
  ]
}

/** The complete display groups, in reading order. Roster/Activity/Workspace/
 *  Lineage facts stay available while the exact cut is loading or failed; only
 *  the cut-owned values become unknown. */
function inspectorGroups(
  input: SessionInspectorViewInput,
  data: Extract<SessionInspectorSnapshot, { readonly state: 'ready' }>['data'] | undefined,
): SessionInspectorGroup[] {
  const row = input.row
  const fact = input.fact
  const model = data?.model
  const modelValue = model === undefined
    ? MISSING
    : `${sanitizedPhysicalLine(model.provider)}/${sanitizedPhysicalLine(model.model)}`
  const rosterPreset = row.preset === undefined ? 'Unknown' : `${sanitizedPhysicalLine(row.preset)} (roster)`
  const groups: SessionInspectorGroup[] = [
    {
      id: 'session',
      head: 'Whole session',
      facts: [
        { label: 'Model', value: modelValue },
        { label: 'Effort', value: model?.reasoningEffort === undefined ? MISSING : sanitizedPhysicalLine(model.reasoningEffort) },
        // A roster preset is an explicitly labelled hint until the exact cut
        // carries the authoritative preset. The cut's own absence stays unknown.
        { label: 'Preset', value: data?.preset === undefined ? rosterPreset : sanitizedPhysicalLine(data.preset) },
        { label: 'Context', value: data === undefined ? MISSING : contextValue(data) },
      ],
    },
    {
      id: 'activity',
      head: 'Activity',
      facts: [
        { label: 'Turns', value: data?.stats === undefined ? MISSING : String(data.stats.turns) },
        { label: 'Steps', value: data?.stats === undefined ? MISSING : String(data.stats.steps) },
        { label: 'Running', value: fact?.running === true ? 'Yes' : fact?.running === false ? 'No' : 'Unknown' },
        { label: 'Pending', value: fact === undefined ? 'Unknown' : SESSION_PENDING_LABEL[fact.pending] },
        { label: 'Source', value: fact === undefined ? 'unknown' : SESSION_SOURCE_LABEL[fact.source] },
      ],
    },
    {
      id: 'usage',
      head: 'Token usage',
      facts: data?.usage === undefined
        ? [
            { label: 'Uncached input', value: MISSING },
            { label: 'Output', value: MISSING },
            { label: 'Cache read', value: MISSING },
            { label: 'Cache write', value: MISSING },
            { label: 'Total', value: MISSING },
            { label: 'Cache hit', value: MISSING },
          ]
        : [
            { label: 'Uncached input', value: formatTokens(data.usage.uncachedInputTokens) },
            { label: 'Output', value: formatTokens(data.usage.outputTokens) },
            { label: 'Cache read', value: formatTokens(data.usage.cacheReadTokens) },
            { label: 'Cache write', value: formatTokens(data.usage.cacheWriteTokens) },
            { label: 'Total', value: formatTokens(data.usage.totalTokens) },
            { label: 'Cache hit', value: data.usage.cacheHitPct === undefined ? MISSING : `${data.usage.cacheHitPct.toFixed(1)}%` },
          ],
    },
    {
      id: 'performance',
      head: 'Performance',
      facts: data?.stats === undefined
        ? [
            { label: 'LLM', value: MISSING },
            { label: 'Tool', value: MISSING },
            { label: 'Avg TTFT', value: MISSING },
            { label: 'Decode', value: MISSING },
          ]
        : [
            { label: 'LLM', value: formatInspectorDuration(data.stats.llmMs) },
            { label: 'Tool', value: formatInspectorDuration(data.stats.toolMs) },
            { label: 'Avg TTFT', value: data.stats.avgTtftMs === undefined ? MISSING : formatInspectorDuration(data.stats.avgTtftMs) },
            { label: 'Decode', value: formatInspectorRate(data.stats.decodeTokensPerSec) },
          ],
    },
    {
      id: 'workspace',
      head: 'Workspace & dates',
      facts: [
        { label: 'Workspace', value: membershipValue(fact, input.workspaces, input.workspaceBaselineProven) },
        // row.cwd is the immutable Session-header creation directory, NOT the
        // Session's current working directory and NOT a Workspace identity.
        { label: 'Created in', value: row.cwd === undefined ? 'Unknown' : sanitizedPhysicalLine(row.cwd) },
        { label: 'Effective cwd', value: data?.effectiveCwd === undefined ? 'Unknown' : sanitizedPhysicalLine(data.effectiveCwd) },
        { label: 'Created', value: row.createdAt === undefined ? 'Unknown' : new Date(row.createdAt).toISOString() },
        { label: 'Updated', value: new Date(row.updatedAt).toISOString() },
      ],
    },
    {
      id: 'goal',
      head: 'Goal & todo',
      facts: data === undefined
        ? [
            { label: 'Goal', value: 'Unknown' },
            { label: 'Goal phase', value: MISSING },
            { label: 'Pending', value: 'Unknown' },
            { label: 'In progress', value: 'Unknown' },
            { label: 'Completed', value: 'Unknown' },
          ]
        : [...goalFacts(data), ...todoFacts(data)],
    },
    {
      id: 'lineage',
      head: 'Lineage',
      facts: [
        { label: 'Parent session', value: row.parentSession === undefined ? 'No parent session' : sanitizedPhysicalLine(row.parentSession) },
      ],
    },
    ...(input.excerpt === undefined ? [] : [{
      id: 'excerpt',
      head: `Host search excerpt · ${input.excerpt.source}`,
      facts: [
        { label: 'Matching content', value: sanitizedPhysicalLine(input.excerpt.snippet) },
      ],
      prose: true as const,
    }]),
  ]
  return groups
}

/** The compact selected-preview subset: identity freshness plus the facts the
 *  native side hint can present without becoming a second reading page. */
function summaryOf(
  groups: readonly SessionInspectorGroup[],
  row: SessionBrowserRow,
): SessionInspectorFact[] {
  const wanted = ['Model', 'Effort', 'Preset', 'Context', 'Turns', 'Steps', 'Total', 'Cache hit']
  const facts: SessionInspectorFact[] = []
  for (const group of groups) {
    for (const fact of group.facts) {
      if (wanted.includes(fact.label)) facts.push(fact)
    }
  }
  facts.push({ label: 'Updated', value: new Date(row.updatedAt).toISOString() })
  return facts
}

/** Build the ONE display projection of the selected Session's Inspector. */
export function buildSessionInspectorView(input: SessionInspectorViewInput): SessionInspectorView {
  const row = input.row
  const inspector = input.inspector
  const matching = inspector !== undefined && inspector.sessionId === row.id
    && (inspector.state !== 'ready' || inspector.data.sessionId === row.id)
    ? inspector
    : undefined
  const rosterTitle = row.title === undefined || row.title.trim() === '' ? undefined : sanitizedPhysicalLine(row.title)
  const stateLabel = stateParts(row, input.fact, input.currentSessionId).join(' · ')
  const identityState = `${row.id === input.currentSessionId ? 'Current session' : row.live ? 'Live session' : 'Persisted session'}${
    row.formatStatus === 'migration-required' ? ' · Migration required' : ''
  }`
  const data = matching?.state === 'ready' ? matching.data : undefined
  const title = data?.title === undefined ? rosterTitle ?? sanitizedPhysicalLine(shortSessionId(row.id)) : sanitizedPhysicalLine(data.title)
  const groups = inspectorGroups(input, data)
  const base = {
    sessionId: row.id,
    fullId: sanitizedPhysicalLine(row.id),
    shortId: sanitizedPhysicalLine(shortSessionId(row.id)),
    title,
    stateLabel,
    identityState,
    freshness: `Updated ${formatSessionAge(row.updatedAt)}`,
  }
  if (matching === undefined || matching.state === 'loading') {
    return { ...base, state: 'loading', notice: 'Loading statistics…', groups, summary: [] }
  }
  if (matching.state !== 'ready') {
    const notice = matching.state === 'unavailable'
      ? 'Statistics unavailable'
      : matching.state === 'denied'
        ? 'Access denied'
        : matching.state === 'migration-required'
          ? 'Migration required'
          : `Statistics failed: ${sanitizedPhysicalLine(matching.message)}`
    return { ...base, state: matching.state, notice, groups, summary: [] }
  }
  return {
    ...base,
    state: matching.refreshing ? 'refreshing' : 'ready',
    notice: matching.refreshing ? 'Refreshing' : '',
    groups,
    summary: summaryOf(groups, row),
  }
}
