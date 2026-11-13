/**
 * TSP Workflow native disclosure mapper: official Folder rows -> SDK nodes.
 *
 * Evidence level: pure projection + official SDK node identity on a scripted
 * shape. Real client layout, pointer/key input and the production router are
 * the separate real-pane and live-mount lanes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { View, type JsonObject, type Node, type Tree } from '@stencil-hq/tern'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { workflowPhaseKey } from '../../src/domain/transcript/workflow-projection.ts'
import {
  describeTranscriptMainBlocksForPreset,
  TranscriptNodeKeys,
  transcriptViewForPreset,
  type TranscriptPresetViewOptions,
} from '../../src/tui/tsp/transcript-view.ts'
import {
  advanceWorkflowDisclosureState,
  type WorkflowRunDisclosureState,
} from '../../src/tui/transcript/workflow-disclosure.ts'
import { TSP_WORKFLOW_BROWSE_ACTION } from '../../src/tui/tsp/workflow-actions.ts'

const T0 = 1_700_000_000_000
const ev = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
  ({ type, seq: SessionSeq(seq), time: T0 + seq * 1000, data }) as SessionEvent

function workflowEvents(runId: string, members: readonly {
  seq: number
  label: string
  phase?: string | null
  outcome?: 'completed' | 'failed' | 'cancelled'
}[], status: 'running' | 'completed' | 'failed' = 'running'): SessionEvent[] {
  const events: SessionEvent[] = [ev('turn/start', { turn: 1 }, 0), ev('tool-workflow/run-start', { runId, name: 'deploy-backend' }, 1)]
  let seq = 2
  for (const member of members) {
    events.push(ev('tool-workflow/agent-start', {
      runId,
      seq: member.seq,
      label: member.label,
      ...(member.phase === undefined ? {} : { phase: member.phase }),
      childId: `child-${member.seq}`,
    }, seq++))
    if (member.outcome !== undefined) {
      events.push(ev('tool-workflow/agent-end', { runId, seq: member.seq, outcome: member.outcome }, seq++))
    }
  }
  if (status !== 'running') {
    events.push(ev('tool-workflow/run-end', {
      runId,
      stopReason: status === 'completed' ? 'completed' : 'error',
    }, seq++))
  }
  return events
}

function folderOf(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return folder
}

function workflowOf(folder: TranscriptFolder): Extract<TranscriptMessage, { kind: 'workflow' }> {
  const message = folder.messages().find(row => row.kind === 'workflow')
  assert.ok(message !== undefined && message.kind === 'workflow')
  return message
}

function stateOf(message: Extract<TranscriptMessage, { kind: 'workflow' }>): Map<string, WorkflowRunDisclosureState> {
  return new Map([[message.runId, advanceWorkflowDisclosureState(undefined, message).state]])
}

interface FlatNode {
  readonly id: string
  readonly kind: string
  readonly props: JsonObject
  readonly parent: string | undefined
}

function flatten(root: Node): FlatNode[] {
  const view = View.from({ main: root })
  const out: FlatNode[] = []
  const visit = (tree: Tree, parent: string | undefined): void => {
    out.push({ id: tree.id, kind: tree.kind, props: tree.props, parent })
    for (const child of tree.children) visit(child, tree.id)
  }
  const region = view.regions[0]
  assert.ok(region !== undefined)
  visit(region, undefined)
  return out
}

const viewOf = (messages: readonly TranscriptMessage[], options: TranscriptPresetViewOptions): FlatNode[] =>
  flatten(transcriptViewForPreset(messages, new TranscriptNodeKeys(), options))

const textOf = (node: FlatNode): string => String(node.props['text'] ?? '')
const headOf = (node: FlatNode): string => String(node.props['head'] ?? '')
const allText = (nodes: readonly FlatNode[]): string => nodes.map(node => textOf(node)).join('\n')
const headDescendants = (nodes: readonly FlatNode[], node: FlatNode): FlatNode[] =>
  nodes.filter(candidate => candidate.id.startsWith(`${node.id}.head.`))
const descendants = (nodes: readonly FlatNode[], id: string): FlatNode[] =>
  nodes.filter(node => node.id.startsWith(`${id}.`))
const headerText = (nodes: readonly FlatNode[], node: FlatNode): string => {
  const head = headOf(node)
  if (head !== '' && !head.endsWith('.head')) return head
  return headDescendants(nodes, node).map(textOf).join('\n')
}

const optionsOf = (
  states: Map<string, WorkflowRunDisclosureState>,
  browseAvailable: boolean,
): TranscriptPresetViewOptions => ({
  preset: 'full',
  scopePrefix: 's1-',
  workflowDisclosure: { states, browseAvailable },
})

test('a run-start with no members is one open native Run Section with no Phase', () => {
  const folder = folderOf(workflowEvents('run-1', []))
  const message = workflowOf(folder)
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), false))
  const sections = nodes.filter(node => node.kind === 'section')
  assert.equal(sections.length, 1)
  assert.equal(sections[0]?.props['collapsed'], false)
  assert.match(headerText(nodes, sections[0]!), /Workflow deploy-backend \[running\]/)
  assert.equal(nodes.some(node => allText([node]).includes('agents')), false)
  assert.equal(nodes.some(node => textOf(node).includes('members')), false,
    'the static member-count card is retired when a disclosure owner is present')
})

test('a clean cold replay stays closed, keeps its real status and summary, and materializes no child', () => {
  const folder = folderOf(workflowEvents('run-clean', [
    { seq: 1, label: 'a', phase: 'Prepare', outcome: 'completed' },
  ], 'completed'))
  const message = workflowOf(folder)
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), true))
  const run = nodes.find(node => node.kind === 'section')
  assert.ok(run !== undefined)
  assert.equal(run.props['collapsed'], true)
  assert.match(headerText(nodes, run), /\[completed\]/)
  assert.ok(allText(nodes).includes('1 agent · 1 completed'))
  assert.equal(descendants(nodes, run.id).filter(node => node.kind === 'section').length, 0)
  assert.equal(nodes.some(node => node.kind === 'button'), false, 'a folded descendant owns no action')
})

test('inline members keep durable order, readable status words and a single scoped button', () => {
  const folder = folderOf(workflowEvents('run-small', [
    { seq: 1, label: 'build-1', phase: 'Prepare', outcome: 'completed' },
    { seq: 2, label: 'build-2', phase: 'Prepare', outcome: 'failed' },
    { seq: 3, label: 'verify-1', phase: 'Prepare' },
  ]))
  const message = workflowOf(folder)
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), true))
  const memberRows = nodes.filter(node => node.kind === 'text' && /^([✓●✗!])/.test(textOf(node)))
  assert.deepEqual(memberRows.map(node => textOf(node)), [
    '✓ build-1 — completed',
    '✗ build-2 — failed',
    '● verify-1 — running',
  ])
  const buttons = nodes.filter(node => node.kind === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(textOf(buttons[0]!), 'View 3 agents')
  assert.deepEqual(buttons[0]!.props['actions'], { click: TSP_WORKFLOW_BROWSE_ACTION })
  assert.equal(nodes.some(node => node.kind === 'text' && /View/.test(textOf(node))), false,
    'a dead View text row must not impersonate the button')
})

test('a six-member Phase is bounded to counts, three anomalies and the hidden count', () => {
  const members = [
    ...Array.from({ length: 3 }, (_, i) => ({ seq: i + 1, label: `done-${i}`, phase: 'Migration', outcome: 'completed' as const })),
    { seq: 4, label: 'fail-a', phase: 'Migration', outcome: 'failed' as const },
    { seq: 5, label: 'cancel-a', phase: 'Migration', outcome: 'cancelled' as const },
    { seq: 6, label: 'fail-b', phase: 'Migration', outcome: 'failed' as const },
    { seq: 7, label: 'fail-c', phase: 'Migration', outcome: 'failed' as const },
  ]
  const folder = folderOf(workflowEvents('run-large', members))
  const message = workflowOf(folder)
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), true))
  assert.ok(allText(nodes).includes('3 completed · 3 failed · 1 cancelled'))
  assert.ok(allText(nodes).includes('fail-a — failed') && allText(nodes).includes('cancel-a — cancelled'))
  assert.ok(!allText(nodes).includes('fail-c'))
  assert.ok(allText(nodes).includes('… 1 more abnormal'))
  assert.ok(!allText(nodes).includes('done-0'))
  const buttons = nodes.filter(node => node.kind === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(textOf(buttons[0]!), 'View 7 agents')
})

test('a 100-member single Phase stays bounded and has no duplicate run-level View all', () => {
  const members = Array.from({ length: 100 }, (_, i) => ({
    seq: i + 1,
    label: `node-${i}`,
    phase: 'Migration',
    outcome: i === 99 ? 'failed' as const : 'completed' as const,
  }))
  const folder = folderOf(workflowEvents('run-100', members))
  const message = workflowOf(folder)
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), true))
  assert.equal(nodes.filter(node => node.kind === 'button').length, 1)
  assert.equal(textOf(nodes.find(node => node.kind === 'button')!), 'View 100 agents')
  assert.ok(!allText(nodes).includes('View all 100 agents'))
  assert.ok(allText(nodes).includes('100 agents · 99 completed · 1 failed'))
  assert.ok(nodes.length < 25, `the node count must stay bounded: ${nodes.length}`)
})

test('a multi-Phase run over the limit adds one run-level View all action', () => {
  const members = [
    ...Array.from({ length: 3 }, (_, i) => ({ seq: i + 1, label: `prepare-${i}`, phase: 'Prepare', outcome: 'completed' as const })),
    ...Array.from({ length: 3 }, (_, i) => ({ seq: i + 4, label: `rollout-${i}`, phase: 'Rollout', outcome: 'completed' as const })),
  ]
  const folder = folderOf(workflowEvents('run-two', members))
  const message = workflowOf(folder)
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), true))
  const buttons = nodes.filter(node => node.kind === 'button')
  assert.deepEqual(buttons.map(textOf), ['View all 6 agents'],
    'clean Phases are closed, so the open Run owns the only visible scoped action')
  const run = nodes.find(node => node.kind === 'section')
  assert.ok(run !== undefined)
  const all = buttons.find(node => textOf(node) === 'View all 6 agents')
  assert.equal(all?.parent, run.id)
})

test('null and empty phases keep distinct dot-safe node keys and independent state', () => {
  const folder = folderOf(workflowEvents('run-null', [
    { seq: 1, label: 'a', phase: null, outcome: 'completed' },
    { seq: 2, label: 'b', phase: '', outcome: 'completed' },
    { seq: 3, label: 'c', phase: '验证.阶段', outcome: 'completed' },
  ], 'completed'))
  const message = workflowOf(folder)
  const states = stateOf(message)
  const state = states.get(message.runId)!
  state.userOpen = true
  state.phases.get(workflowPhaseKey(null))!.userOpen = true
  state.phases.get(workflowPhaseKey(''))!.userOpen = false
  state.phases.get(workflowPhaseKey('验证.阶段'))!.userOpen = true
  const nodes = viewOf(folder.messages(), optionsOf(states, false))
  const sections = nodes.filter(node => node.kind === 'section')
  assert.equal(sections.length, 4, 'one Run and three Phase sections')
  const heads = sections.slice(1).map(headOf)
  assert.ok(heads[0]!.startsWith('Unassigned') && heads[1]!.startsWith('Empty') && heads[2]!.startsWith('验证.阶段'))
  const childIds = sections.slice(1).map(node => node.id)
  assert.equal(new Set(childIds).size, 3, 'distinct raw phase identities never share an SDK key')
  assert.equal(new Set(sections.slice(1).map(node => node.props['collapsed'])).size, 2)
  assert.ok(nodes.every(node => node.kind !== 'button'), 'no browse capability means no dead action')
})

test('a manually closed Run retains its Phase preference without materializing children', () => {
  const folder = folderOf(workflowEvents('run-manual', [
    { seq: 1, label: 'a', phase: 'P', outcome: 'completed' },
    { seq: 2, label: 'b', phase: 'P' },
  ]))
  const message = workflowOf(folder)
  const states = stateOf(message)
  const state = states.get(message.runId)!
  state.phases.get(workflowPhaseKey('P'))!.userOpen = false
  state.userOpen = false
  const closed = viewOf(folder.messages(), optionsOf(states, true))
  const run = closed.find(node => node.kind === 'section')!
  assert.equal(run.props['collapsed'], true)
  assert.equal(descendants(closed, run.id).filter(node => node.kind === 'section').length, 0)

  state.userOpen = true
  const reopened = viewOf(folder.messages(), optionsOf(states, true))
  const phase = reopened.filter(node => node.kind === 'section')[1]
  assert.ok(phase !== undefined)
  assert.equal(phase.props['collapsed'], true, 'reopening the Run must not clear the Phase choice')
  assert.equal(reopened.some(node => node.kind === 'button'), false)
})

test('no disclosure owner preserves the historical static card and emits no action', () => {
  const folder = folderOf(workflowEvents('run-legacy', [
    { seq: 1, label: 'a', phase: 'P', outcome: 'completed' },
  ], 'completed'))
  const nodes = viewOf(folder.messages(), { preset: 'full', scopePrefix: 's1-' })
  const card = nodes.find(node => node.kind === 'card')
  assert.ok(card !== undefined)
  assert.equal(headOf(card), 'deploy-backend')
  assert.equal(nodes.filter(node => node.kind === 'section').length, 0)
  assert.equal(nodes.some(node => node.kind === 'button' || node.props['collapsible'] === true), false)
  assert.ok(allText(nodes).includes('1 members'))
})

test('an unchanged canonical row keeps its top-level descriptor and one Workflow update changes only its own stamp', () => {
  const folder = folderOf(workflowEvents('run-stamp', [
    { seq: 1, label: 'a', phase: 'P', outcome: 'completed' },
    { seq: 2, label: 'b', phase: 'P' },
  ]))
  const messages = folder.messages()
  const states = stateOf(workflowOf(folder))
  const keys = new TranscriptNodeKeys()
  const before = describeTranscriptMainBlocksForPreset(messages, keys, optionsOf(states, true))
  const unchanged = describeTranscriptMainBlocksForPreset(messages, keys, optionsOf(states, true))
  assert.deepEqual(unchanged.map(block => block.stamp), before.map(block => block.stamp))
  assert.deepEqual(unchanged.map(block => block.key), before.map(block => block.key))

  const state = states.get(workflowOf(folder).runId)!
  state.userOpen = false
  const after = describeTranscriptMainBlocksForPreset(messages, keys, optionsOf(states, true))
  assert.equal(after.length, before.length)
  assert.deepEqual(after.map(block => block.key), before.map(block => block.key))
  assert.equal(after.filter((block, index) => JSON.stringify(block.stamp) !== JSON.stringify(before[index]?.stamp)).length, 1)
  const changed = after.findIndex((block, index) => JSON.stringify(block.stamp) !== JSON.stringify(before[index]?.stamp))
  assert.equal(changed, 0, 'only this Workflow root changes; there is no unrelated row in this fixture')
})

test('two Runs with the same name and Phase labels keep different SDK node identities', () => {
  const folder = folderOf([
    ...workflowEvents('run-a', [{ seq: 1, label: 'a', phase: 'P', outcome: 'completed' }]),
    ...workflowEvents('run-b', [{ seq: 1, label: 'a', phase: 'P', outcome: 'completed' }]),
  ])
  const workflows = folder.messages().filter(row => row.kind === 'workflow')
  assert.equal(workflows.length, 2)
  const states = new Map(workflows.map(row => [row.runId, advanceWorkflowDisclosureState(undefined, row).state]))
  const nodes = viewOf(folder.messages(), optionsOf(states, true))
  const runs = nodes.filter(node => node.kind === 'section' && headerText(nodes, node).startsWith('Workflow'))
  assert.equal(runs.length, 2)
  assert.notEqual(runs[0]?.id, runs[1]?.id)
  const phaseA = descendants(nodes, runs[0]!.id).find(node => node.kind === 'section')
  const phaseB = descendants(nodes, runs[1]!.id).find(node => node.kind === 'section')
  assert.ok(phaseA !== undefined && phaseB !== undefined)
  assert.notEqual(phaseA.id, phaseB.id)
})

test('untrusted names, labels and status words never inject raw terminal controls', () => {
  const folder = folderOf(workflowEvents('run-control', [
    { seq: 1, label: '\u001b[31m危险\u0007', phase: 'P', outcome: 'failed' },
  ]))
  const message = workflowOf(folder)
  message.name = 'deploy\u001b[2Jbackend'
  const nodes = viewOf(folder.messages(), optionsOf(stateOf(message), true))
  const text = allText(nodes) + nodes.map(headOf).join('\n')
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text), 'no raw control byte reaches a native node')
  assert.ok(text.includes('危险'), 'the readable label survives sanitization')
})
