/**
 * M5-U-D — the ONE pure Session Workspace projection, tested on its own.
 *
 * These cases own the CLASSIFICATION contract only: which single group a
 * listed main Session belongs to, when a pending candidate is a proved need
 * (and when it is only `unverified`), the official Workspace membership and the
 * header's outside-attention truthfulness. Rendering, focus, mouse and
 * lifecycle live in `session-workspace-panel.test.ts` /
 * `session-workspace-lifecycle.test.ts` and fail for different reasons on
 * purpose.
 * @module @xmoon76/dsh-pi-tui/session-workspace-view.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionBrowserAnswerEligibility, SessionBrowserRow } from '../../src/app/command/session-browser-presentation.ts'
import type { SessionActivityFact, SessionWorkspaceFact } from '../../src/runtime/session-workspace-facts-port.ts'
import {
  buildSessionWorkspaceView,
  visibleWorkspaceBrowserRows,
  currentWorkspaceOf,
  workspaceMembershipOf,
  type SessionWorkspaceScope,
} from '../../src/tui/presentation/session-workspace-view.ts'

const ALL: SessionWorkspaceScope = { kind: 'all' }

function row(id: string, updatedAt: number, extra: Partial<SessionBrowserRow> = {}): SessionBrowserRow {
  return { id, updatedAt, createdAt: updatedAt, cwd: '/ws', live: false, ...extra }
}

function activity(
  sessionId: string,
  extra: Partial<SessionActivityFact> = {},
): SessionActivityFact {
  return {
    sessionId,
    running: undefined,
    pendingKinds: undefined,
    continuedQuestionCallIds: undefined,
    attention: 'unknown',
    attentionSourceState: 'unknown',
    ...extra,
  }
}

function question(sessionId: string, extra: Partial<SessionActivityFact> = {}): SessionActivityFact {
  return activity(sessionId, {
    running: false,
    pendingKinds: ['question'],
    continuedQuestionCallIds: [],
    attention: 'question',
    attentionSourceState: 'known',
    ...extra,
  })
}

function live(sessionId: string, kind: 'question' | 'approval' = 'question'): SessionBrowserAnswerEligibility {
  return { sessionId, kind, live: true }
}

function workspace(
  workspaceId: string,
  sessionIds: readonly string[],
  title = workspaceId,
): SessionWorkspaceFact {
  return { workspaceId, path: `/ws/${workspaceId}`, title, sessionIds }
}

function view(input: {
  readonly rows: readonly SessionBrowserRow[]
  readonly activity?: readonly SessionActivityFact[]
  readonly eligibility?: readonly SessionBrowserAnswerEligibility[]
  readonly workspaces?: readonly SessionWorkspaceFact[]
  readonly proven?: boolean
  readonly scope?: SessionWorkspaceScope
  readonly currentSessionId?: string
  readonly priorIdOrder?: readonly string[]
}) {
  return buildSessionWorkspaceView({
    rows: input.rows,
    activity: input.activity,
    answerEligibility: input.eligibility,
    workspaces: input.workspaces ?? [],
    workspaceBaselineProven: input.proven ?? false,
    scope: input.scope ?? ALL,
    currentSessionId: input.currentSessionId,
    ...(input.priorIdOrder === undefined ? {} : { priorIdOrder: input.priorIdOrder }),
  })
}

test("manual collapse hides active and current child rows instead of overriding the user's fold", () => {
  const built = view({
    rows: [row('active', 5_000), row('current', 4_000), row('history', 3_000)],
    activity: [activity('active', { running: true, attention: 'none', attentionSourceState: 'known' })],
    workspaces: [workspace('ws-current', ['active', 'current', 'history'])],
    proven: true,
    currentSessionId: 'current',
  })
  const rows = visibleWorkspaceBrowserRows(built, {
    expanded: new Map([['ws-current', false]]),
    historyLimit: new Map(),
  }, 'active', 'current')
  assert.deepEqual(rows.map(row => row.id), ['workspace:ws-current'])
  assert.equal(rows[0]?.kind, 'folder')
  if (rows[0]?.kind === 'folder') assert.deepEqual([rows[0].needs, rows[0].working, rows[0].total], [0, 1, 3])
})


test('official Workspace groups expose active sessions and keep ordinary history behind Show more', () => {
  const built = view({
    rows: [row('current-active', 5_000), row('current-old', 4_000), row('other-old', 3_000)],
    activity: [
      activity('current-active', { running: true, attention: 'none', attentionSourceState: 'known' }),
      activity('current-old', { attention: 'none', attentionSourceState: 'known' }),
      activity('other-old', { attention: 'none', attentionSourceState: 'known' }),
    ],
    workspaces: [workspace('ws-current', ['current-active', 'current-old']), workspace('ws-other', ['other-old'])],
    proven: true,
    currentSessionId: 'current-active',
  })
  const rows = visibleWorkspaceBrowserRows(built, { expanded: new Map(), historyLimit: new Map() }, 'current-active', 'current-active')
  assert.deepEqual(rows.map(row => row.id), [
    'workspace:ws-current', 'session:current-active', 'session:current-old', 'workspace:ws-other',
  ])
  assert.equal(rows[0]!.kind, 'folder')
  assert.equal(rows[3]!.kind, 'folder')
  if (rows[3]?.kind === 'folder') assert.equal(rows[3].expanded, false, 'an inactive non-current Workspace starts as a Folder header only')
})

test('Needs attention → Working → Recent: one row per Session, ordered by official updatedAt', () => {
  const built = view({
    rows: [
      row('session-needs', 1_000),
      row('session-working', 3_000),
      row('session-recent', 2_000),
      row('session-needs-running', 500),
    ],
    activity: [
      question('session-needs', { running: false }),
      question('session-needs-running', { running: true }),
      activity('session-working', { running: true, attention: 'none', attentionSourceState: 'known' }),
      activity('session-recent', { attention: 'none', attentionSourceState: 'known' }),
    ],
    eligibility: [live('session-needs'), live('session-needs-running')],
  })
  assert.deepEqual(built.groups.map(group => group.kind), ['needs', 'working', 'recent'])
  // Within Needs the newer official updatedAt comes first even though the
  // running one is oldest: the group is ONE list, not two buckets.
  assert.deepEqual(built.groups[0]!.ids, ['session-needs', 'session-needs-running'])
  assert.deepEqual(built.groups[1]!.ids, ['session-working'])
  assert.deepEqual(built.groups[2]!.ids, ['session-recent'])
  assert.deepEqual(built.listIds, ['session-needs', 'session-needs-running', 'session-working', 'session-recent'])
  // A Needs row that is also running keeps ONE row and reports the sub-fact.
  const needsRunning = built.rowsById.get('session-needs-running')!
  assert.equal(needsRunning.group, 'needs')
  assert.equal(needsRunning.running, true)
  assert.equal(needsRunning.pending, 'question')
  assert.equal(needsRunning.answerable, true)
})

test('a pending candidate without THIS Client\'s answerability proof is unverified, never Needs', () => {
  const built = view({
    rows: [row('session-x', 1_000), row('session-y', 2_000)],
    activity: [question('session-x'), question('session-y')],
    // No eligibility view at all: no official answer composition here (Direct).
  })
  for (const id of ['session-x', 'session-y']) {
    const fact = built.rowsById.get(id)!
    assert.equal(fact.answerable, false)
    assert.equal(fact.pending, 'unverified')
    assert.equal(fact.group, 'recent')
  }
  assert.deepEqual(built.groups.map(group => group.kind), ['recent'])
  // A live eligibility for a DIFFERENT Session proves nothing about this one.
  const other = view({
    rows: [row('session-x', 1_000)],
    activity: [question('session-x')],
    eligibility: [live('session-elsewhere')],
  })
  assert.equal(other.rowsById.get('session-x')!.answerable, false)
  assert.equal(other.rowsById.get('session-x')!.pending, 'unverified')
})

test('approval needs the approval token; a continued Question candidate is a proved need', () => {
  const built = view({
    rows: [row('session-approval', 3_000), row('session-continued', 2_000), row('session-wrong-kind', 1_000)],
    activity: [
      activity('session-approval', {
        running: false,
        pendingKinds: ['approval'],
        attention: 'approval',
        attentionSourceState: 'known',
      }),
      activity('session-continued', {
        running: false,
        pendingKinds: [],
        continuedQuestionCallIds: ['call-continued'],
        attention: 'question',
        attentionSourceState: 'known',
      }),
      question('session-wrong-kind'),
    ],
    eligibility: [live('session-approval', 'approval'), live('session-wrong-kind', 'approval')],
  })
  assert.equal(built.rowsById.get('session-approval')!.answerable, true)
  assert.equal(built.rowsById.get('session-approval')!.pending, 'approval')
  // A continued call has no forwarded token: its official candidate proof plus
  // this composition's answer capability is what makes it answerable.
  assert.equal(built.rowsById.get('session-continued')!.answerable, true)
  assert.equal(built.rowsById.get('session-continued')!.pending, 'question')
  // An approval token never proves an open Question (and vice versa).
  assert.equal(built.rowsById.get('session-wrong-kind')!.answerable, false)
  assert.equal(built.rowsById.get('session-wrong-kind')!.pending, 'unverified')
})

test('a continued call with an unknown inbox stays unverified: no candidate proof, no Needs', () => {
  const built = view({
    rows: [row('session-x', 1_000)],
    activity: [activity('session-x', {
      running: false,
      pendingKinds: [],
      continuedQuestionCallIds: undefined,
      attention: 'question',
      attentionSourceState: 'known',
    })],
    eligibility: [],
  })
  assert.equal(built.rowsById.get('session-x')!.answerable, false)
  assert.equal(built.rowsById.get('session-x')!.pending, 'unverified')
})

test('running true + unknown pending is Working; running unknown stays Recent with Running unknown', () => {
  const built = view({
    rows: [row('session-working', 2_000), row('session-unknown', 1_000)],
    activity: [
      activity('session-working', { running: true }),
      activity('session-unknown', { running: undefined }),
    ],
  })
  assert.equal(built.rowsById.get('session-working')!.group, 'working')
  assert.equal(built.rowsById.get('session-working')!.pending, 'unknown')
  assert.equal(built.rowsById.get('session-unknown')!.group, 'recent')
  assert.equal(built.rowsById.get('session-unknown')!.running, undefined)
  assert.equal(built.rowsById.get('session-unknown')!.pending, 'unknown')
})

test('denied/unavailable/absent samples never become Needs and keep their own source state', () => {
  const built = view({
    rows: [row('session-denied', 4_000), row('session-unavailable', 3_000), row('session-missing', 2_000), row('session-none', 1_000)],
    activity: [
      activity('session-denied', { attention: 'unknown', attentionSourceState: 'denied' }),
      activity('session-unavailable', { attention: 'unknown', attentionSourceState: 'unavailable' }),
      activity('session-none', { attention: 'none', attentionSourceState: 'known' }),
    ],
    eligibility: [live('session-denied'), live('session-unavailable'), live('session-missing')],
  })
  assert.equal(built.rowsById.get('session-denied')!.pending, 'denied')
  assert.equal(built.rowsById.get('session-unavailable')!.pending, 'unavailable')
  assert.equal(built.rowsById.get('session-missing')!.pending, 'unknown')
  assert.equal(built.rowsById.get('session-missing')!.source, 'unknown')
  assert.equal(built.rowsById.get('session-none')!.pending, 'none')
  assert.equal(built.rowsById.get('session-none')!.source, 'known')
  assert.deepEqual(built.groups.map(group => group.kind), ['recent'])
})

test('same title/cwd/age rows keep distinct ids, and a subagent child never enters the list', () => {
  const built = view({
    rows: [
      row('session-a', 1_000, { title: 'Fix pipeline', cwd: '/app', origin: undefined }),
      row('session-b', 1_000, { title: 'Fix pipeline', cwd: '/app' }),
      row('session-child', 5_000, { title: 'Fix pipeline', cwd: '/app', origin: 'subagent' }),
    ],
    activity: [activity('session-a', { attention: 'none', attentionSourceState: 'known' })],
  })
  assert.deepEqual(built.listIds, ['session-a', 'session-b'])
  assert.equal(built.rowsById.has('session-child'), false)
})

test('the official Workspace membership is proved, ambiguous or unassigned — never guessed', () => {
  const workspaces = [
    workspace('ws-a', ['session-a', 'session-ambiguous']),
    workspace('ws-b', ['session-b', 'session-ambiguous']),
  ]
  assert.equal(currentWorkspaceOf(workspaces, 'session-a'), 'ws-a')
  assert.equal(currentWorkspaceOf(workspaces, 'session-ambiguous'), undefined)
  assert.equal(currentWorkspaceOf(workspaces, undefined), undefined)
  assert.deepEqual(workspaceMembershipOf(workspaces, 'session-a', true), { kind: 'assigned', workspaceIds: ['ws-a'] })
  assert.deepEqual(workspaceMembershipOf(workspaces, 'session-ambiguous', true), {
    kind: 'ambiguous',
    workspaceIds: ['ws-a', 'ws-b'],
  })
  assert.deepEqual(workspaceMembershipOf(workspaces, 'session-cold', true), { kind: 'unassigned' })
  // Without a valid baseline NOTHING is unassigned: the absence of membership
  // is not a proved fact.
  assert.deepEqual(workspaceMembershipOf(workspaces, 'session-cold', false), { kind: 'unknown' })

  const built = view({
    rows: [row('session-a', 4_000), row('session-ambiguous', 3_000), row('session-cold', 2_000)],
    workspaces,
    proven: true,
    scope: { kind: 'workspace', workspaceId: 'ws-a' },
  })
  assert.deepEqual(built.listIds, ['session-a', 'session-ambiguous'])

  const unassigned = view({
    rows: [row('session-a', 4_000), row('session-ambiguous', 3_000), row('session-cold', 2_000)],
    workspaces,
    proven: true,
    scope: { kind: 'unassigned' },
  })
  assert.deepEqual(unassigned.listIds, ['session-cold'])

  const unproven = view({
    rows: [row('session-cold', 2_000)],
    workspaces,
    proven: false,
    scope: { kind: 'unassigned' },
  })
  assert.deepEqual(unproven.listIds, [])
})

test('outside attention is a count only when every outside candidate is proved', () => {
  const rows = [row('session-in', 4_000), row('session-out-needs', 3_000), row('session-out-unknown', 2_000)]
  const workspaces = [workspace('ws-a', ['session-in'])]
  const base = {
    rows,
    workspaces,
    proven: true,
    scope: { kind: 'workspace', workspaceId: 'ws-a' } as const,
  }
  const counted = view({
    ...base,
    activity: [
      activity('session-in', { attention: 'none', attentionSourceState: 'known' }),
      question('session-out-needs'),
      activity('session-out-unknown', { attention: 'none', attentionSourceState: 'known' }),
    ],
    eligibility: [live('session-out-needs')],
  })
  assert.deepEqual(counted.outsideAttention, { kind: 'count', count: 1 })

  const unproved = view({
    ...base,
    activity: [
      activity('session-in', { attention: 'none', attentionSourceState: 'known' }),
      question('session-out-needs'),
      activity('session-out-unknown', { attention: 'none', attentionSourceState: 'known' }),
    ],
    // No eligibility: the outside need is only a candidate, so "0" is unproved.
    eligibility: [],
  })
  assert.deepEqual(unproved.outsideAttention, { kind: 'unknown' })

  const zero = view({
    ...base,
    activity: [
      activity('session-in', { attention: 'none', attentionSourceState: 'known' }),
      activity('session-out-needs', { attention: 'none', attentionSourceState: 'known' }),
      activity('session-out-unknown', { attention: 'none', attentionSourceState: 'known' }),
    ],
    eligibility: [],
  })
  assert.deepEqual(zero.outsideAttention, { kind: 'count', count: 0 })

  const allScope = view({ ...base, scope: ALL })
  assert.deepEqual(allScope.outsideAttention, { kind: 'none' })
})

test('equal updatedAt keeps the roster order, and the previous order breaks the tie on refresh', () => {
  const rows = [row('session-a', 5_000), row('session-b', 5_000), row('session-c', 5_000)]
  const stable = view({ rows, activity: rows.map(entry => activity(entry.id, { attention: 'none', attentionSourceState: 'known' })) })
  assert.deepEqual(stable.listIds, ['session-a', 'session-b', 'session-c'])
  const reordered = view({
    rows,
    priorIdOrder: ['session-c', 'session-a', 'session-b'],
    activity: rows.map(entry => activity(entry.id, { attention: 'none', attentionSourceState: 'known' })),
  })
  assert.deepEqual(reordered.listIds, ['session-c', 'session-a', 'session-b'])
})
