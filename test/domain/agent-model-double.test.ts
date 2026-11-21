/** The AgentModel test double must mirror the OFFICIAL `AgentModel` +
 *  `modelSelection` projection, not an approximation: every product suite that
 *  fakes an Agent reads model selection through this double, so an edit to the
 *  reducer rules must fail here before it can weaken those suites.
 *
 *  Each scenario runs against the REAL implementation over a REAL Session and
 *  against the double: reads must agree after every step and the durable
 *  `model/selection` append counts must match.
 * @module @xmoon76/dsh-pi-tui/agent-model-double.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent/types'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { fakeAgentModel, type FakeAgentModelSelection } from '../support/agent-model-double.ts'

interface ModelSurface {
  current(): FakeAgentModelSelection | undefined
  select(selection: Readonly<ModelSelection>): void
}

type ScenarioStep = (session: Session) => (model: ModelSurface) => void

/** Fold the official projection over one Session's committed events. */
function officialStateOf(session: Session) {
  let state = modelSelectionProjectionDefinition.init(session.header, SessionLogOffset(0))
  for (const event of session.snapshotEvents() as readonly SessionEvent[]) {
    state = modelSelectionProjectionDefinition.apply(state, event)
  }
  return state
}

function officialModel(session: Session, options: { provider: string; model: string }): AgentModel {
  return new AgentModel(() => officialStateOf(session), session, options)
}

function newSession(id: string): Session {
  return Session.create(SessionId(id))
}

function appendHeader(
  session: Session,
  config: Record<string, unknown>,
  adapterDefaults?: Record<string, unknown>,
): void {
  session.append('request/header', {
    header: { config, ...adapterDefaults === undefined ? {} : { adapterDefaults } },
  } as never)
}

/** Run one scenario against the official model and the double, asserting the
 *  same read after every step and the same number of committed appends. */
function compare(label: string, steps: readonly ScenarioStep[], options = { provider: 'p', model: 'm' }): void {
  const officialSession = newSession(`official-${label}`)
  const doubleSession = newSession(`double-${label}`)
  const official = officialModel(officialSession, options)
  const double = fakeAgentModel(doubleSession, options)
  const officialSteps = steps.map(step => step(officialSession))
  const doubleSteps = steps.map(step => step(doubleSession))

  for (const [index, step] of officialSteps.entries()) {
    step({ current: () => official.current() ?? undefined, select: selection => { official.select(selection) } })
    doubleSteps[index]!({ current: () => double.current() ?? undefined, select: selection => { double.select(selection) } })
    assert.deepEqual(double.current(), official.current(),
      `${label} / step ${index + 1}: the double must read the same selection as the official AgentModel`)
    assert.equal(doubleSession.snapshotEvents().length, officialSession.snapshotEvents().length,
      `${label} / step ${index + 1}: the double must append exactly what the official AgentModel appends`)
  }
}

test('an adapter-defaulted reasoning effort is not a recorded selection', () => {
  compare('adapter-default', [
    session => () => { appendHeader(session, { provider: 'p', model: 'm', reasoningEffort: 'high' }, { reasoningEffort: true }) },
    () => model => { model.select({ provider: 'p', model: 'm' }) },
  ])
  // Sanity that the scenario is not vacuous: the real model really stripped it.
  const session = newSession('adapter-default-sanity')
  appendHeader(session, { provider: 'p', model: 'm', reasoningEffort: 'high' }, { reasoningEffort: true })
  assert.deepEqual(officialModel(session, { provider: 'p', model: 'm' }).current(),
    { provider: 'p', model: 'm' },
    'the official AgentModel must strip an adapter-defaulted effort')
})

test('an explicit reasoning effort stays part of the recorded selection', () => {
  compare('explicit-effort', [
    session => () => { appendHeader(session, { provider: 'p', model: 'm', reasoningEffort: 'high' }) },
    () => model => { model.select({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }) },
    () => model => { model.select({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('low') }) },
  ])
})

test('select skips a duplicate recorded choice but still appends a selection equal to the options fallback', () => {
  compare('dedupe', [
    () => model => { model.select({ provider: 'p', model: 'm' }) },
    () => model => { model.select({ provider: 'p', model: 'm' }) },
  ])
  const session = newSession('dedupe-sanity')
  const model = officialModel(session, { provider: 'p', model: 'm' })
  model.select({ provider: 'p', model: 'm' })
  model.select({ provider: 'p', model: 'm' })
  assert.equal(session.snapshotEvents().length, 1,
    'the official AgentModel records the options-equal selection once and skips the duplicate')
})

test('the double follows a pending selection until a matching request header retires it', () => {
  compare('pending-retire', [
    session => model => {
      appendHeader(session, { provider: 'p', model: 'm', reasoningEffort: 'high' })
      model.select({ provider: 'p', model: 'm2', reasoningEffort: ReasoningEffortId('max') })
    },
    () => model => { model.select({ provider: 'p', model: 'm2', reasoningEffort: ReasoningEffortId('max') }) },
    session => () => { appendHeader(session, { provider: 'p', model: 'm2', reasoningEffort: 'max' }) },
    () => model => { model.select({ provider: 'p', model: 'm2', reasoningEffort: ReasoningEffortId('max') }) },
  ])
})
