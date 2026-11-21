/**
 * Shared Workflow disclosure transition policy: the exact fact edges both
 * renderers consume. These are pure caller-owned states; the PiTui renderer
 * regressions in test/app/workflow-ui.test.ts keep proving the real product
 * path and the TSP mount keeps proving its own source-scoped owner.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { TranscriptMessage, WorkflowMemberView, WorkflowRunId, WorkflowRunStatus } from '../../src/transcript.ts'
import { workflowPhasePresentations } from '../../src/tui/transcript/workflow-presentation.ts'
import {
  advanceWorkflowDisclosureState,
  effectiveWorkflowPhaseOpen,
  effectiveWorkflowRunOpen,
  type WorkflowRunDisclosureState,
} from '../../src/tui/transcript/workflow-disclosure.ts'

type WorkflowRow = Extract<TranscriptMessage, { kind: 'workflow' }>

const member = (seq: number, label: string, phase: string | null, status: WorkflowRunStatus): WorkflowMemberView =>
  ({ seq, label, phase, childId: `child-${seq}` as never, status })

const workflow = (overrides: Partial<WorkflowRow> = {}): WorkflowRow => ({
  kind: 'workflow',
  turn: 0,
  runId: 'run-1' as WorkflowRunId,
  name: 'audit',
  status: 'running',
  members: [],
  ...overrides,
})

const phaseOf = (message: WorkflowRow, index = 0) => {
  const phase = workflowPhasePresentations(message.members)[index]
  assert.ok(phase !== undefined, `phase ${index} must exist`)
  return phase
}

test('a cold-replayed clean run starts closed without replaying a live edge', () => {
  const cold = workflow({ status: 'completed', members: [member(0, 'a', 'P', 'completed')] })
  const result = advanceWorkflowDisclosureState(undefined, cold)
  assert.equal(result.choiceChanged, false)
  assert.equal(result.state.previousMode, 'clean')
  assert.equal(result.state.phases.size, 1)
  assert.equal(effectiveWorkflowRunOpen(result.state, cold), false)
  assert.equal(effectiveWorkflowPhaseOpen(result.state, phaseOf(cold)), false)

  const failedCold = workflow({ status: 'completed', members: [member(0, 'a', 'P', 'failed')] })
  const failed = advanceWorkflowDisclosureState(undefined, failedCold)
  assert.equal(failed.state.previousMode, 'abnormal', 'a failed member makes a completed run abnormal')
  assert.equal(effectiveWorkflowRunOpen(failed.state, failedCold), true)
  assert.equal(effectiveWorkflowPhaseOpen(failed.state, phaseOf(failedCold)), true,
    'a failed member keeps the completed run and its exception visible')
})

test('an unchanged canonical fact object does not consume a later manual close', () => {
  const running = workflow({ members: [member(0, 'a', 'P', 'running')] })
  const state = advanceWorkflowDisclosureState(undefined, running).state
  state.userOpen = false
  state.phases.get(phaseOf(running).key)!.userOpen = false

  const sameObject = advanceWorkflowDisclosureState(state, running)
  assert.equal(sameObject.state, state, 'the caller-owned state is advanced in place')
  assert.equal(sameObject.choiceChanged, false)
  assert.equal(state.userOpen, false)
  assert.equal(state.phases.get(phaseOf(running).key)?.userOpen, false)
  assert.equal(effectiveWorkflowRunOpen(state, running), false)

  const sameFacts = workflow({ runId: running.runId, name: running.name, status: running.status, members: running.members })
  const repeated = advanceWorkflowDisclosureState(state, sameFacts)
  assert.equal(repeated.choiceChanged, false)
  assert.equal(effectiveWorkflowRunOpen(state, sameFacts), false)
})

test('a running-to-running member append preserves manual Run and Phase choices', () => {
  const before = workflow({ members: [member(0, 'a', 'P', 'running')] })
  const state = advanceWorkflowDisclosureState(undefined, before).state
  state.userOpen = false
  state.phases.get(phaseOf(before).key)!.userOpen = false
  const after = workflow({ members: [...before.members, member(1, 'b', 'P', 'running')] })

  const result = advanceWorkflowDisclosureState(state, after)
  assert.equal(result.choiceChanged, false)
  assert.equal(result.state.userOpen, false)
  assert.equal(result.state.phases.get(phaseOf(after).key)?.userOpen, false)
  assert.equal(effectiveWorkflowRunOpen(result.state, after), false)
  assert.equal(effectiveWorkflowPhaseOpen(result.state, phaseOf(after)), false)
})

test('the first abnormal edge reopens a closed Run and Phase exactly once', () => {
  const before = workflow({ members: [member(0, 'a', 'P', 'running')] })
  const state = advanceWorkflowDisclosureState(undefined, before).state
  state.userOpen = false
  state.phases.get(phaseOf(before).key)!.userOpen = false
  const failed = workflow({ members: [member(0, 'a', 'P', 'failed')] })

  const first = advanceWorkflowDisclosureState(state, failed)
  assert.equal(first.choiceChanged, true)
  assert.equal(state.userOpen, undefined)
  assert.equal(state.phases.get(phaseOf(failed).key)?.userOpen, undefined)
  assert.equal(effectiveWorkflowRunOpen(state, failed), true)
  assert.equal(effectiveWorkflowPhaseOpen(state, phaseOf(failed)), true)

  state.userOpen = false
  state.phases.get(phaseOf(failed).key)!.userOpen = false
  const later = workflow({ members: [...failed.members, member(1, 'b', 'P', 'failed')] })
  const second = advanceWorkflowDisclosureState(state, later)
  assert.equal(second.choiceChanged, false)
  assert.equal(effectiveWorkflowRunOpen(state, later), false)
  assert.equal(effectiveWorkflowPhaseOpen(state, phaseOf(later)), false)
})

test('entering clean consumes a manual choice; a later manual reopen persists', () => {
  const before = workflow({ members: [member(0, 'a', 'P', 'running')] })
  const state = advanceWorkflowDisclosureState(undefined, before).state
  state.userOpen = false
  state.phases.get(phaseOf(before).key)!.userOpen = true
  const clean = workflow({ status: 'completed', members: [member(0, 'a', 'P', 'completed')] })

  const settled = advanceWorkflowDisclosureState(state, clean)
  assert.equal(settled.choiceChanged, true)
  assert.equal(effectiveWorkflowRunOpen(state, clean), false)
  assert.equal(effectiveWorkflowPhaseOpen(state, phaseOf(clean)), false)

  state.userOpen = true
  state.phases.get(phaseOf(clean).key)!.userOpen = true
  const repaint = advanceWorkflowDisclosureState(state, clean)
  assert.equal(repaint.choiceChanged, false)
  assert.equal(effectiveWorkflowRunOpen(state, clean), true)
  assert.equal(effectiveWorkflowPhaseOpen(state, phaseOf(clean)), true)
})

test('a clean Phase gaining members folds itself and reopens a still-active Run', () => {
  const cleanPhase = workflow({ status: 'running', members: [member(0, 'a', 'P', 'completed')] })
  const state = advanceWorkflowDisclosureState(undefined, cleanPhase).state
  state.userOpen = false
  state.phases.get(phaseOf(cleanPhase).key)!.userOpen = true
  const grown = workflow({ status: 'running', members: [member(0, 'a', 'P', 'completed'), member(1, 'b', 'P', 'completed')] })

  const result = advanceWorkflowDisclosureState(state, grown)
  assert.equal(result.choiceChanged, true)
  assert.equal(effectiveWorkflowRunOpen(state, grown), true)
  assert.equal(effectiveWorkflowPhaseOpen(state, phaseOf(grown)), false)
})

test('a clean-to-running cycle reopens a user-closed Run and Phase', () => {
  const cleanPhase = workflow({ status: 'running', members: [member(0, 'a', 'P', 'completed')] })
  const state = advanceWorkflowDisclosureState(undefined, cleanPhase).state
  state.userOpen = false
  state.phases.get(phaseOf(cleanPhase).key)!.userOpen = false
  const nextCycle = workflow({ status: 'running', members: [member(0, 'a', 'P', 'completed'), member(1, 'b', 'P', 'running')] })

  const result = advanceWorkflowDisclosureState(state, nextCycle)
  assert.equal(result.choiceChanged, true)
  assert.equal(effectiveWorkflowRunOpen(state, nextCycle), true)
  assert.equal(effectiveWorkflowPhaseOpen(state, phaseOf(nextCycle)), true)
})

test('null and empty phase identities keep separate manual disclosure owners', () => {
  const message = workflow({
    status: 'completed',
    members: [member(0, 'a', null, 'completed'), member(1, 'b', '', 'completed')],
  })
  const state: WorkflowRunDisclosureState = advanceWorkflowDisclosureState(undefined, message).state
  const [missing, empty] = workflowPhasePresentations(message.members)
  assert.ok(missing !== undefined && empty !== undefined)
  assert.notEqual(missing.key, empty.key)
  assert.equal(state.phases.size, 2)
  state.phases.get(missing.key)!.userOpen = false
  state.phases.get(empty.key)!.userOpen = true
  assert.equal(effectiveWorkflowPhaseOpen(state, missing), false)
  assert.equal(effectiveWorkflowPhaseOpen(state, empty), true)
})
