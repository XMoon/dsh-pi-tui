/**
 * The ONE renderer-neutral Workflow disclosure policy.
 *
 * It answers exactly one presentation question: given the CURRENT canonical
 * Workflow run, a caller-owned manual choice and the facts observed on the last
 * advance, which Run/Phase disclosure is currently in effect, and which stored
 * choices must be consumed by an authoritative fact edge? The official
 * `TranscriptWorkflowMessage` remains the only business authority; this module
 * owns no state lifetime, cache, Session scope, Task Browser or SDK node.
 *
 * Callers keep their own run-state maps and decide when to advance one. The
 * existing state object is updated in place so both renderers can replace
 * their former local transition logic without moving manual ownership into a
 * shared global store.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/workflow-disclosure
 */

import type {
  TranscriptWorkflowMessage,
} from '../../domain/transcript/workflow-projection.ts'
import {
  workflowPhasePresentations,
  workflowRunMode,
  type WorkflowPhasePresentation,
} from './workflow-presentation.ts'

type WorkflowDisclosureMode = 'clean' | 'running' | 'abnormal'

/** One phase's manual choice and the last facts used to detect a new cycle. */
export interface WorkflowPhaseDisclosureState {
  /** The user's explicit open/closed choice (undefined = fact-driven). */
  userOpen?: boolean
  /** The phase's mode at the last advance. */
  previousMode: WorkflowDisclosureMode
  /** The phase's member count at the last advance. */
  previousActivityCount: number
}

/** One run's manual choice and its independent per-phase disclosure states. */
export interface WorkflowRunDisclosureState {
  /** The user's explicit open/closed choice (undefined = fact-driven). */
  userOpen?: boolean
  /** The run's mode at the last advance. */
  previousMode: WorkflowDisclosureMode
  /** Phase states by `workflowPhaseKey`, never by display label or index. */
  phases: Map<string, WorkflowPhaseDisclosureState>
}

/** The effective Run disclosure: an explicit choice wins, then current facts. */
export function effectiveWorkflowRunOpen(
  state: WorkflowRunDisclosureState | undefined,
  message: TranscriptWorkflowMessage,
): boolean {
  if (state?.userOpen !== undefined) return state.userOpen
  return workflowRunMode(message.status, message.members) !== 'clean'
}

/** The effective Phase disclosure. Closing a Run never changes this choice. */
export function effectiveWorkflowPhaseOpen(
  state: WorkflowRunDisclosureState | undefined,
  phase: WorkflowPhasePresentation,
): boolean {
  const phaseState = state?.phases.get(phase.key)
  if (phaseState?.userOpen !== undefined) return phaseState.userOpen
  return phase.counts.completed !== phase.members.length
}

function phaseModeOf(phase: WorkflowPhasePresentation): WorkflowDisclosureMode {
  if (phase.counts.failed + phase.counts.cancelled + phase.counts.interrupted > 0) return 'abnormal'
  return phase.counts.completed === phase.members.length ? 'clean' : 'running'
}

/**
 * Advance one caller-owned state for a real canonical fact change. First sight
 * establishes the current facts as the baseline, so a cold-replayed settled
 * run never replays its historical edges. `choiceChanged` reports only a
 * consumed manual choice; the caller owns its own repaint revision.
 */
export function advanceWorkflowDisclosureState(
  state: WorkflowRunDisclosureState | undefined,
  message: TranscriptWorkflowMessage,
): { state: WorkflowRunDisclosureState; choiceChanged: boolean } {
  const runMode = workflowRunMode(message.status, message.members)
  const phases = workflowPhasePresentations(message.members)
  if (state === undefined) {
    const baseline: WorkflowRunDisclosureState = { previousMode: runMode, phases: new Map() }
    for (const phase of phases) {
      baseline.phases.set(phase.key, {
        previousMode: phaseModeOf(phase),
        previousActivityCount: phase.members.length,
      })
    }
    return { state: baseline, choiceChanged: false }
  }

  let choiceChanged = false
  const previousRunMode = state.previousMode
  state.previousMode = runMode
  if (runMode === 'clean' && previousRunMode !== 'clean') {
    // Normal completion consumes a prior manual choice; a later manual reopen
    // while the run stays clean is an ordinary no-op.
    if (state.userOpen !== undefined) {
      state.userOpen = undefined
      choiceChanged = true
    }
  } else if (previousRunMode === 'clean' && runMode !== 'clean') {
    // A new non-clean cycle reopens a user-closed run. An explicit open stays.
    if (state.userOpen === false) { state.userOpen = undefined; choiceChanged = true }
  } else if (previousRunMode !== 'abnormal' && runMode === 'abnormal') {
    // The first abnormal edge exposes the exception once. Later abnormal facts
    // and an explicit manual open never override a newer user choice.
    if (state.userOpen === false) { state.userOpen = undefined; choiceChanged = true }
  }

  let phaseStartedCycle = false
  for (const phase of phases) {
    const phaseMode = phaseModeOf(phase)
    let phaseState = state.phases.get(phase.key)
    if (phaseState === undefined) {
      phaseState = { previousMode: phaseMode, previousActivityCount: phase.members.length }
      state.phases.set(phase.key, phaseState)
      continue
    }
    const previousPhaseMode = phaseState.previousMode
    const previousActivityCount = phaseState.previousActivityCount
    const phaseFactsChanged = previousPhaseMode !== phaseMode
      || previousActivityCount !== phase.members.length
    phaseState.previousMode = phaseMode
    phaseState.previousActivityCount = phase.members.length
    if (phaseMode === 'clean' && phaseFactsChanged) {
      // New clean facts consume the phase choice. A clean phase whose member
      // count changed is also a new cycle for the outer run.
      if (phaseState.userOpen !== undefined) {
        phaseState.userOpen = undefined
        choiceChanged = true
      }
      if (previousPhaseMode === 'clean' && phase.members.length !== previousActivityCount) {
        phaseStartedCycle = true
      }
    } else if (previousPhaseMode === 'clean' && phaseMode !== 'clean') {
      // A completed phase gained new work: reopen a user-closed phase and run.
      if (phaseState.userOpen === false) { phaseState.userOpen = undefined; choiceChanged = true }
      phaseStartedCycle = true
    } else if (previousPhaseMode !== 'abnormal' && phaseMode === 'abnormal') {
      // First abnormal edge: expose a hidden exception, but preserve an open.
      if (phaseState.userOpen === false) { phaseState.userOpen = undefined; choiceChanged = true }
    }
  }
  if (phaseStartedCycle && runMode !== 'clean' && state.userOpen === false) {
    state.userOpen = undefined
    choiceChanged = true
  }
  return { state, choiceChanged }
}
