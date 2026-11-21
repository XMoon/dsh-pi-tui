/** Direct model-selection adapter tests: the live Agent's own upstream
 *  `AgentModel` is the ONE read/write authority, and this adapter only
 *  normalizes reads, records durable selections through it, installs the
 *  official switch notice once, and owns the per-Agent admission window. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectModelSelectionOwner } from '../../src/runtime/direct/model-selection-direct.ts'
import { rawSelectionFromRequestHeader, selectionFromRequestHeader } from '../../src/domain/session/model-selection.ts'

type Selection = { provider: string; model: string; reasoningEffort?: string }

/** One Agent whose `model` mimics the upstream `AgentModel`: `current()` answers
 *  the recorded/option route and `select()` is the durable append. */
function fakeAgent(events: readonly unknown[], header: unknown) {
  const appended: unknown[] = []
  const onCalls: string[] = []
  let recorded: Selection | undefined
  const optionsRoute = (): Selection | undefined => {
    const config = (header as { config?: Partial<Selection> } | undefined)?.config
    return typeof config?.provider === 'string' && typeof config.model === 'string'
      ? {
          provider: config.provider,
          model: config.model,
          ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
        }
      : undefined
  }
  const agent = {
    ctx: { on: (name: string) => { onCalls.push(name); return () => {} } },
    model: {
      current: () => recorded ?? optionsRoute(),
      select: (next: Selection) => {
        appended.push({ type: 'model/selection', data: next })
        recorded = next
      },
    },
    // The alpha.4 Session shape: the log is served through snapshot reads.
    session: {
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => events,
      requestHeader: () => header,
      append: (type: string, data: unknown) => { appended.push({ type, data }) },
    },
  }
  return { agent, appended, onCalls }
}

const request = (provider: string, model: string, reasoningEffort: string, adapterDefault = false) => ({
  type: 'request/header',
  data: {
    header: {
      config: { provider, model, reasoningEffort },
      ...(adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {}),
    },
  },
})

test('each Agent reads its own upstream selection', () => {
  const owner = new DirectModelSelectionOwner()
  const first = fakeAgent([request('provider-a', 'model-a', 'high')], {
    config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
  })
  const second = fakeAgent([request('provider-b', 'model-b', 'max')], {
    config: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' },
  })

  assert.deepEqual(owner.current(first.agent), { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
  assert.deepEqual(owner.current(second.agent), { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  owner.select(first.agent, { provider: 'p', model: 'm', reasoningEffort: 'max' })
  assert.deepEqual(owner.current(first.agent), { provider: 'p', model: 'm', reasoningEffort: 'max' })
  assert.deepEqual(owner.current(second.agent), { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' },
    'another Agent is untouched')
})

test('an Agent with no recorded or option route reads undefined', () => {
  const owner = new DirectModelSelectionOwner()
  const empty = fakeAgent([], undefined)
  assert.equal(owner.current(empty.agent), undefined)
  assert.deepEqual(empty.appended, [])
})

test('select records ONE durable model/selection through the upstream AgentModel', () => {
  const owner = new DirectModelSelectionOwner()
  const { agent, appended } = fakeAgent([], undefined)
  owner.select(agent, { provider: 'p', model: 'm', reasoningEffort: 'max' })
  assert.deepEqual(appended, [{ type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'max' } }])
  assert.deepEqual(owner.current(agent), { provider: 'p', model: 'm', reasoningEffort: 'max' })
})

test('select refuses an invalid selection before touching the Agent', () => {
  const owner = new DirectModelSelectionOwner()
  const { agent, appended } = fakeAgent([], undefined)
  assert.throws(() => owner.select(agent, { provider: '', model: 'm' } as Selection), /invalid model selection/)
  assert.deepEqual(appended, [], 'an invalid selection never reaches the Session log')
})

test('installForAgent installs the official switch notice exactly once per Agent', () => {
  const owner = new DirectModelSelectionOwner()
  const { agent, onCalls } = fakeAgent([], undefined)
  owner.installForAgent(agent as never)
  owner.installForAgent(agent as never)
  assert.deepEqual(onCalls, ['agent/pre-step'], 'the model-switch notice listener is installed once')
  const other = fakeAgent([], undefined)
  owner.installForAgent(other.agent as never)
  assert.deepEqual(other.onCalls, ['agent/pre-step'], 'each Agent gets its own listener')
})

test('serializeImageAdmission serializes per Agent and leaves another Agent independent', async () => {
  const owner = new DirectModelSelectionOwner()
  const first = fakeAgent([], undefined).agent
  const other = fakeAgent([], undefined).agent
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const one = owner.serializeImageAdmission(first, async () => { order.push('a1-start'); await gate; order.push('a1-end') })
  const two = owner.serializeImageAdmission(first, async () => { order.push('a2') })
  const three = owner.serializeImageAdmission(other, async () => { order.push('b1') })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['a1-start', 'b1'], 'the same Agent queues; another Agent is independent')
  release()
  await Promise.all([one, two, three])
  assert.deepEqual(order, ['a1-start', 'b1', 'a1-end', 'a2'])
})

test('an image admission queued on the same Agent observes the earlier model selection commit', async () => {
  // The per-Agent window is shared: a model selection and an image-bearing
  // prompt admission cannot interleave, so the admission reads the committed
  // selection rather than a racing older choice.
  const owner = new DirectModelSelectionOwner()
  const { agent } = fakeAgent([], undefined)
  const observed: unknown[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const selection = owner.serializeImageAdmission(agent, async () => {
    await gate
    owner.select(agent, { provider: 'p', model: 'm' })
  })
  const admission = owner.serializeImageAdmission(agent, async () => { observed.push(owner.current(agent)) })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(observed, [], 'the admission waits behind the model-selection window')
  release()
  await Promise.all([selection, admission])
  assert.deepEqual(observed, [{ provider: 'p', model: 'm' }], 'the admission reads the committed selection')
})

/* ── the Direct-only durable projection read (T1/T2/T9) ───────────────────────
 *
 * The `dsh-base` + TUI profile does not compose the row that registers the
 * official `modelSelection` projection unit, so the reader answers from the exact
 * Session's own latest REQUEST HEADER. Owner-approved scope (2026-10-08): the
 * latest used route only — an unconsumed pending `model/selection` intent is
 * deliberately NOT reproduced, and the compat source scans no log.
 */

const selectionEvent = (provider: string, model: string, reasoningEffort?: string) => ({
  type: 'model/selection',
  data: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
})

/** The Session's own read pair, as the real Session serves it: the header is the
 *  LATEST `request/header` event's config. The events are kept so the SAME fixture
 *  can feed the official reducer reference; the compat source consumes only
 *  `requestHeader`. */
function sessionFactsOf(events: readonly unknown[]) {
  const last = events.findLast(candidate => (candidate as { type?: unknown }).type === 'request/header')
  const header = (last as { data?: { header?: unknown } } | undefined)?.data?.header
  return { snapshotEvents: () => events, requestHeader: () => header }
}

/**
 * The installed rc.2 `modelSelection` reducer, transcribed from
 * `@deepseek-ai/dsh-api-session-controller`'s host projection: `model/selection`
 * replaces the pending intent, `request/header` sets `lastUsed` from the RAW
 * config and clears the pending intent only on an exact match, and the wire value
 * is `{ lastUsed, next: pending ?? lastUsed }`. Its `lastUsed` half is the
 * REFERENCE the Direct compat read must agree with for legal events.
 */
function officialSurface(events: readonly unknown[]): {
  lastUsed: { provider?: string; model?: string; reasoningEffort?: string } | null
  next: { provider?: string; model?: string; reasoningEffort?: string } | null
} {
  type Selection = { provider?: string; model?: string; reasoningEffort?: string }
  const same = (left: Selection | null, right: Selection | null): boolean =>
    left === right || (left !== null && right !== null
      && left.provider === right.provider
      && left.model === right.model
      && left.reasoningEffort === right.reasoningEffort)
  let state: { lastUsed: Selection | null; pending: Selection | null } = { lastUsed: null, pending: null }
  for (const raw of events) {
    const event = raw as {
      type?: unknown
      data?: { provider?: string; model?: string; reasoningEffort?: string; header?: { config?: { provider?: string; model?: string; reasoningEffort?: string } } }
    }
    if (event.type === 'model/selection') {
      const data = event.data as Selection
      if (!same(state.pending, data)) state = { lastUsed: state.lastUsed, pending: data }
      continue
    }
    if (event.type !== 'request/header') continue
    const config = event.data?.header?.config ?? {}
    const lastUsed: Selection = {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) },
    }
    const pending = same(state.pending, lastUsed) ? null : state.pending
    state = same(state.lastUsed, lastUsed) && pending === state.pending
      ? state
      : { lastUsed, pending }
  }
  return { lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }
}

test('the durable read answers from the exact Session’s own request header, without the default, a listener or an append', () => {
  let defaultReads = 0
  // The owner no longer consults any global default: DSH 0.2.2's AgentModel
  // resolves options/lastUsed itself. The counter proves the read never falls
  // back to a second source.
  const owner = new DirectModelSelectionOwner()
  const { agent, appended, onCalls } = fakeAgent([request('deepseek', 'child-model', 'high')], {
    config: { provider: 'deepseek', model: 'child-model', reasoningEffort: 'high' },
  })
  assert.deepEqual(owner.durableProjectionForSession(agent.session), {
    lastUsed: { provider: 'deepseek', model: 'child-model', reasoningEffort: 'high' },
    next: { provider: 'deepseek', model: 'child-model', reasoningEffort: 'high' },
  })
  assert.equal(defaultReads, 0, 'the Session’s own facts never consult the global default')
  assert.deepEqual(onCalls, [], 'the read installs no DSH request listener')
  assert.deepEqual(appended, [], 'the read appends no Session event')
  assert.deepEqual(
    owner.durableProjectionForSession(fakeAgent([], undefined).agent.session),
    { lastUsed: null, next: null },
    'a Session with no durable model fact reads BOTH official slots null — never the default',
  )
  assert.equal(defaultReads, 0, 'the empty read does not touch the default either')
})

test('the compat surface is the Session’s latest USED route and its lastUsed half matches the installed reducer', () => {
  const owner = new DirectModelSelectionOwner()
  const sequences: ReadonlyArray<{ name: string; events: readonly unknown[] }> = [
    { name: 'legacy request only', events: [request('p1', 'm1', 'high')] },
    { name: 'several requests: the LAST one owns the surface', events: [request('p1', 'm1', 'high'), request('p2', 'm2', 'low')] },
    { name: 'pending before its request', events: [selectionEvent('p1', 'm1', 'high'), request('p1', 'm1', 'high')] },
    { name: 'pending with a different effort', events: [selectionEvent('p1', 'm1', 'high'), request('p1', 'm1', 'low')] },
    { name: 'pending chosen AFTER the last request', events: [request('a', 'one', 'high'), selectionEvent('b', 'two', 'max')] },
    { name: 'pending intents only', events: [selectionEvent('a', 'one'), selectionEvent('b', 'two')] },
    { name: 'adapter-defaulted effort kept raw', events: [request('p', 'm', 'high', true)] },
    { name: 'pending matching only the STRIPPED value', events: [selectionEvent('p', 'm'), request('p', 'm', 'high', true)] },
  ]
  for (const sequence of sequences) {
    const surface = owner.durableProjectionForSession(sessionFactsOf(sequence.events))
    assert.deepEqual(
      surface.lastUsed,
      officialSurface(sequence.events).lastUsed,
      `the compat lastUsed must equal the rc.2 reducer's lastUsed: ${sequence.name}`,
    )
    assert.deepEqual(
      surface.next,
      surface.lastUsed,
      `the compat next mirrors lastUsed (pending out of scope): ${sequence.name}`,
    )
  }
  // The explicit shapes the sequences above must produce (a reference that
  // silently agreed with a broken read would still fail these).
  assert.deepEqual(owner.durableProjectionForSession(sessionFactsOf([
    request('p1', 'm1', 'high'), request('p2', 'm2', 'low'),
  ])), {
    lastUsed: { provider: 'p2', model: 'm2', reasoningEffort: 'low' },
    next: { provider: 'p2', model: 'm2', reasoningEffort: 'low' },
  }, 'the child’s latest request header owns the surface')
  assert.deepEqual(owner.durableProjectionForSession(sessionFactsOf([
    request('p1', 'm1', 'high'), selectionEvent('p1', 'next-model', 'max'),
  ])), {
    lastUsed: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    next: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
  }, 'DOCUMENTED REDUCTION: an unconsumed pending selection is NOT surfaced by the compat source (the official reducer would answer next=next-model here)')
  assert.deepEqual(
    owner.durableProjectionForSession({ requestHeader: () => undefined }),
    { lastUsed: null, next: null },
    'a Session that has not requested yet reads both slots null — the UI keeps `model ?`',
  )
})

test('the raw adapter-defaulted effort is preserved exactly like the official wire value', () => {
  const defaulted = {
    config: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    adapterDefaults: { reasoningEffort: true },
  }
  assert.deepEqual(rawSelectionFromRequestHeader(defaulted), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(selectionFromRequestHeader(defaulted), { provider: 'p', model: 'm' },
    'the Agent-restore policy strips an adapter default — deliberately a DIFFERENT semantic from the projection')
  const owner = new DirectModelSelectionOwner()
  assert.deepEqual(owner.durableProjectionForSession({ requestHeader: () => defaulted }), {
    lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    next: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  }, 'the official projection keeps the adapter-defaulted effort; so must the compat read')
})
