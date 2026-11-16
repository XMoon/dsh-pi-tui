/** Application-controller evidence over typed ConfigPort fakes; persistence and wire are qualified separately. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { HostNumericSettingsController, type HostNumericSettingsField, type HostNumericSettingsPort } from '../../src/app/command/host-numeric-settings.ts'
import { SubagentSettingsController } from '../../src/app/command/subagent-settings.ts'
import type {
  FieldPatch,
  SectionMutationOutcome,
  SectionPatch,
  SectionRead,
  SubagentLimits,
  SubagentModelSelection,
  SubagentAllowedModelRoute,
} from '../../src/runtime/config-port.ts'

const HOST_A = Object.freeze({ id: 'host-a' })
const HOST_B = Object.freeze({ id: 'host-b' })
const ROUTE: SubagentAllowedModelRoute = { provider: 'provider-a', model: 'model-a' }

type Ready<T extends object> = Extract<SectionRead<T>, { kind: 'ready' }>

function ready<T extends object>(generation: object, revision: number, effective: T, inherited: T): Ready<T> {
  const fields = new Set([...Object.keys(effective), ...Object.keys(inherited)])
  const overridden = Object.fromEntries([...fields].map(field => [
    field,
    !isDeepStrictEqual((effective as Record<string, unknown>)[field], (inherited as Record<string, unknown>)[field]),
  ])) as Readonly<Record<keyof T, boolean>>
  return { kind: 'ready', generation, revision, effective, inherited, overridden }
}

function held() {
  return { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }
}

type Held = ReturnType<typeof held>
interface MutationPlan {
  readonly hold?: Held
  readonly outcome?: SectionMutationOutcome
  readonly apply?: boolean
  readonly afterMutation?: () => void
}

class SettingsSection<T extends object> {
  state: SectionRead<T>
  readonly calls: Array<{ readonly patch: SectionPatch<T>; readonly revision: number; readonly generation: object }> = []
  readonly plans: MutationPlan[] = []
  refreshCalls = 0

  constructor(state: SectionRead<T>) { this.state = state }
  read(): SectionRead<T> { return this.state }
  async refresh(): Promise<void> { this.refreshCalls += 1 }

  async mutate(patch: SectionPatch<T>, revision: number, generation: object): Promise<SectionMutationOutcome> {
    this.calls.push({ patch: structuredClone(patch), revision, generation })
    const plan = this.plans.shift() ?? {}
    const outcome = plan.outcome ?? { kind: 'accepted' as const }
    if (plan.hold !== undefined) {
      plan.hold.entered.resolve()
      await plan.hold.released.promise
    }
    if (plan.afterMutation !== undefined) plan.afterMutation()
    else if ((plan.apply ?? outcome.kind === 'accepted') && this.state.kind === 'ready') {
      const next: Record<string, unknown> = Object.create(null)
      for (const [field, value] of Object.entries(this.state.effective as object)) next[field] = value
      for (const [field, value] of Object.entries(patch)) {
        const edit = value as FieldPatch<unknown>
        next[field] = edit.kind === 'reset'
          ? (this.state.inherited as Record<string, unknown>)[field]
          : edit.value
      }
      this.state = ready(this.state.generation, revision + 1, next as T, this.state.inherited)
    }
    return outcome
  }
}

async function harness(options: {
  readonly limits?: SectionRead<SubagentLimits>
  readonly selection?: SectionRead<SubagentModelSelection>
} = {}) {
  const limits = new SettingsSection<SubagentLimits>(options.limits ?? ready(HOST_A, 41,
    { maxDepth: 1, maxActiveSubagents: 8 }, { maxDepth: 1, maxActiveSubagents: 8 }))
  const selection = new SettingsSection<SubagentModelSelection>(options.selection ?? ready(HOST_A, 82,
    { enabled: false, allowedModels: [ROUTE] }, { enabled: false, allowedModels: [ROUTE] }))
  const tasks: Array<{ readonly label: string; readonly promise: Promise<void> }> = []
  const errors: unknown[] = []
  const renders = { count: 0 }
  const changes = { count: 0 }
  const controller = new SubagentSettingsController({
    limits,
    selection,
    requestRender: () => { renders.count += 1 },
    onAuthoritativeChange: () => { changes.count += 1 },
    runOwned: (label, task) => {
      const promise = task()
      promise.catch(error => { errors.push(error) })
      tasks.push({ label, promise })
    },
  })
  controller.start()
  await tasks[0]!.promise
  return { controller, limits, selection, tasks, errors, renders, changes }
}

type Harness = Awaited<ReturnType<typeof harness>>
function latest(h: Harness, label = 'subagent settings save'): Promise<void> {
  const task = [...h.tasks].reverse().find(item => item.label === label)
  assert.ok(task, `expected owned task "${label}"`)
  return task.promise
}

function stageBoth(h: Harness, depth = '2'): void {
  h.controller.setNumber('maxDepth', depth)
  h.controller.toggleEnabled()
}

test('Limits dispatches first at the captured revision and pending Save freezes duplicate writes and edits', async t => {
  const h = await harness()
  const first = held()
  const second = held()
  t.after(() => { first.released.resolve(); second.released.resolve() })
  h.limits.plans.push({ hold: first })
  h.selection.plans.push({ hold: second })
  stageBoth(h, '0')
  h.controller.save()
  await first.entered.promise
  assert.equal(h.limits.calls.length, 1)
  assert.equal(h.selection.calls.length, 0)
  assert.equal(h.controller.snapshot().saving, true)
  assert.equal(h.controller.snapshot().selection.status?.kind, 'saving')
  const before = h.controller.snapshot()
  h.controller.save()
  h.controller.setNumber('maxDepth', '7')
  h.controller.toggleEnabled()
  assert.equal(h.tasks.filter(task => task.label === 'subagent settings save').length, 1)
  assert.deepEqual(h.controller.snapshot().limits.patch, before.limits.patch)
  assert.deepEqual(h.controller.snapshot().selection.patch, before.selection.patch)
  assert.deepEqual(h.limits.calls[0], {
    patch: { maxDepth: { kind: 'set', value: 0 } }, revision: 41, generation: HOST_A,
  })

  first.released.resolve()
  await second.entered.promise
  assert.equal(h.controller.snapshot().limits.status?.kind, 'verified')
  assert.equal(h.controller.snapshot().limits.dirty, false)
  assert.equal(h.controller.snapshot().selection.status?.kind, 'saving')
  assert.equal(h.controller.snapshot().saving, true)
  assert.deepEqual(h.selection.calls[0], {
    patch: { enabled: { kind: 'set', value: true } }, revision: 82, generation: HOST_A,
  })
  h.controller.save()
  assert.equal(h.selection.calls.length, 1)
  second.released.resolve()
  await latest(h)
  assert.equal(h.controller.snapshot().saved, true)
  assert.equal(h.controller.snapshot().dirty, false)
  assert.deepEqual(h.errors, [])
})

for (const failed of ['limits', 'selection'] as const) {
  test(`${failed === 'limits' ? 'Limits rejection still permits Selection success' : 'Selection rejection preserves Limits success'} and retains only the failed draft`, async t => {
    const h = await harness()
    const first = held()
    const second = held()
    t.after(() => { first.released.resolve(); second.released.resolve() })
    h.limits.plans.push({ hold: first, ...(failed === 'limits' ? { outcome: { kind: 'rejected', reason: 'Limits policy refused' } as const } : {}) })
    h.selection.plans.push({ hold: second, ...(failed === 'selection' ? { outcome: { kind: 'rejected', reason: 'Selection policy refused' } as const } : {}) })
    stageBoth(h)
    h.controller.save()
    await first.entered.promise
    assert.equal(h.selection.calls.length, 0)
    first.released.resolve()
    await second.entered.promise
    const between = h.controller.snapshot()
    assert.equal(between.limits.status?.kind, failed === 'limits' ? 'not-saved' : 'verified')
    assert.equal(between.limits.dirty, failed === 'limits')
    assert.equal(between.selection.status?.kind, 'saving')
    assert.equal(between.saved, false)
    assert.equal(h.limits.calls[0]?.revision, 41)
    assert.equal(h.selection.calls[0]?.revision, 82)
    second.released.resolve()
    await latest(h)
    const snapshot = h.controller.snapshot()
    assert.equal(snapshot.limits.dirty, failed === 'limits')
    assert.equal(snapshot.selection.dirty, failed === 'selection')
    assert.equal(snapshot.limits.status?.kind, failed === 'limits' ? 'not-saved' : 'verified')
    assert.equal(snapshot.selection.status?.kind, failed === 'selection' ? 'not-saved' : 'verified')
    assert.equal(snapshot.saved, false)
    assert.deepEqual(snapshot[failed].patch, failed === 'limits'
      ? { maxDepth: { kind: 'set', value: 2 } }
      : { enabled: { kind: 'set', value: true } })
  })
}

test('removing the last allowed route while enabled retains the route and dispatches no write', async () => {
  const h = await harness({ selection: ready(HOST_A, 82,
    { enabled: true, allowedModels: [ROUTE] }, { enabled: true, allowedModels: [] }) })
  h.controller.toggleRoute(ROUTE)
  assert.match(h.controller.snapshot().issues.allowedModels ?? '', /Disable model selection/u)
  assert.deepEqual(h.controller.snapshot().allowedModels, [ROUTE])
  assert.equal(h.controller.snapshot().dirty, false)
  assert.equal(h.limits.calls.length, 0)
  assert.equal(h.selection.calls.length, 0)
})

test('an invalid numeric limit blocks Save before either typed section dispatches', async () => {
  const h = await harness()
  h.controller.setNumber('maxActiveSubagents', '0')
  const taskCount = h.tasks.length
  h.controller.save()
  assert.equal(h.tasks.length, taskCount)
  assert.equal(h.limits.calls.length, 0)
  assert.equal(h.selection.calls.length, 0)
  assert.match(h.controller.snapshot().issues.maxActiveSubagents ?? '', /safe integer/u)
  assert.equal(h.controller.snapshot().dirty, true)
})

test('Resetting the only allowed route while enabled blocks Save without a Host write', async () => {
  const h = await harness({ selection: ready(HOST_A, 82,
    { enabled: true, allowedModels: [ROUTE] }, { enabled: true, allowedModels: [] }) })
  h.controller.reset('allowedModels')
  const taskCount = h.tasks.length
  h.controller.save()
  assert.equal(h.tasks.length, taskCount)
  assert.equal(h.limits.calls.length, 0)
  assert.equal(h.selection.calls.length, 0)
  assert.match(h.controller.snapshot().issues.allowedModels ?? '', /at least one/u)
  assert.equal(h.controller.snapshot().dirty, true)
})


test('a Host replacement during the first settlement preserves drafts and never sends Selection to Host B', async t => {
  const h = await harness()
  const first = held()
  t.after(() => first.released.resolve())
  h.limits.plans.push({ hold: first, afterMutation: () => {
    h.limits.state = ready(HOST_B, 41, { maxDepth: 1, maxActiveSubagents: 8 }, { maxDepth: 1, maxActiveSubagents: 8 })
    h.selection.state = ready(HOST_B, 82, { enabled: false, allowedModels: [ROUTE] }, { enabled: false, allowedModels: [ROUTE] })
  } })
  stageBoth(h)
  h.controller.save()
  await first.entered.promise
  assert.equal(h.selection.calls.length, 0)
  first.released.resolve()
  await latest(h)
  assert.equal(h.limits.calls.length, 1)
  assert.equal(h.selection.calls.length, 0)
  assert.equal(h.controller.snapshot().limits.status?.kind, 'unverified')
  assert.equal(h.controller.snapshot().selection.status?.kind, 'not-saved')
  assert.equal(h.controller.snapshot().limits.dirty, true)
  assert.equal(h.controller.snapshot().selection.dirty, true)
})

test('an accepted ACK without a readable readback is Unverified and a later Save cannot replay it', async () => {
  const h = await harness()
  h.limits.plans.push({ afterMutation: () => { h.limits.state = { kind: 'unreadable', reason: 'describe failed' } } })
  h.controller.setNumber('maxDepth', '2')
  h.controller.save()
  await latest(h)
  assert.equal(h.controller.snapshot().limits.status?.kind, 'unverified')
  assert.equal(h.controller.snapshot().limits.dirty, true)
  h.controller.save()
  await latest(h)
  assert.equal(h.limits.calls.length, 1)
})

test('a lost ACK after the edit landed keeps the draft and a later Save never automatically replays it', async () => {
  const h = await harness()
  h.limits.plans.push({ outcome: { kind: 'outcome-unconfirmed', reason: 'reply lost' }, apply: true })
  h.controller.setNumber('maxDepth', '5')
  h.controller.save()
  await latest(h)
  assert.equal(h.controller.snapshot().limits.status?.kind, 'outcome-unconfirmed')
  assert.equal(h.controller.snapshot().limits.dirty, true)
  const observed = h.limits.read()
  assert.equal(observed.kind, 'ready')
  if (observed.kind === 'ready') assert.equal(observed.effective.maxDepth, 5)
  h.controller.save()
  await latest(h)
  assert.equal(h.limits.calls.length, 1)
})

test('closing while Limits is held retires page publication and prevents the second section dispatch', async t => {
  const h = await harness()
  const first = held()
  t.after(() => first.released.resolve())
  h.limits.plans.push({ hold: first })
  stageBoth(h)
  h.controller.save()
  await first.entered.promise
  h.controller.dispose()
  const renderCount = h.renders.count
  const changeCount = h.changes.count
  first.released.resolve()
  await latest(h)
  assert.equal(h.limits.calls.length, 1)
  assert.equal(h.selection.calls.length, 0)
  assert.equal(h.renders.count, renderCount)
  assert.equal(h.changes.count, changeCount)
  assert.deepEqual(h.errors, [])
})

test('dirty Refresh preserves the draft until an explicit discard refresh replaces it', async () => {
  const h = await harness()
  h.controller.setNumber('maxDepth', '3')
  const taskCount = h.tasks.length
  assert.equal(h.controller.refresh(), false)
  assert.equal(h.tasks.length, taskCount)
  assert.equal(h.limits.refreshCalls, 1)
  assert.equal(h.controller.snapshot().limits.dirty, true)
  assert.match(h.controller.snapshot().notice ?? '', /Unsaved changes retained/u)
  assert.equal(h.controller.refresh(true), true)
  assert.equal(h.controller.snapshot().loading, true)
  await latest(h, 'subagent settings refresh')
  assert.equal(h.limits.refreshCalls, 2)
  assert.equal(h.selection.refreshCalls, 2)
  assert.equal(h.controller.snapshot().depthText, '1')
  assert.equal(h.controller.snapshot().dirty, false)
})

test('discarding edits clears drafts without writing either namespace', async () => {
  const h = await harness()
  stageBoth(h)
  h.controller.discard()
  assert.equal(h.controller.snapshot().dirty, false)
  assert.equal(h.controller.snapshot().depthText, '1')
  assert.equal(h.controller.snapshot().enabled, false)
  assert.equal(h.limits.calls.length, 0)
  assert.equal(h.selection.calls.length, 0)
})

test('an unavailable Limits section leaves independently dirty Selection writable', async () => {
  const h = await harness({ limits: { kind: 'unavailable', reason: 'not mounted' } })
  h.controller.toggleEnabled()
  h.controller.save()
  await latest(h)
  assert.equal(h.limits.calls.length, 0)
  assert.equal(h.selection.calls.length, 1)
  assert.equal(h.controller.snapshot().selection.status?.kind, 'verified')
})

test('a Limits section lost during editing still dispatches the current Selection', async () => {
  const h = await harness()
  stageBoth(h)
  h.limits.state = { kind: 'unavailable', reason: 'Limits row removed while editing' }
  h.controller.save()
  await latest(h)
  assert.equal(h.limits.calls.length, 0, 'the removed Limits descriptor dispatches nothing')
  assert.equal(h.selection.calls.length, 1, 'the still-current Selection keeps its own dispatch')
  assert.equal(h.controller.snapshot().limits.status?.kind, 'not-saved')
  assert.equal(h.controller.snapshot().selection.status?.kind, 'verified')
  assert.equal(h.controller.snapshot().limits.dirty, true)
  assert.equal(h.controller.snapshot().selection.dirty, false)
  assert.deepEqual(h.errors, [])
})

test('a Selection section lost during editing still dispatches the current Limits', async () => {
  const h = await harness()
  stageBoth(h)
  h.selection.state = { kind: 'unavailable', reason: 'Selection row removed while editing' }
  h.controller.save()
  await latest(h)
  assert.equal(h.limits.calls.length, 1, 'the still-current Limits keeps its own dispatch')
  assert.equal(h.selection.calls.length, 0, 'the removed Selection descriptor dispatches nothing')
  assert.equal(h.controller.snapshot().limits.status?.kind, 'verified')
  assert.equal(h.controller.snapshot().selection.status?.kind, 'not-saved')
  assert.equal(h.controller.snapshot().limits.dirty, false)
  assert.equal(h.controller.snapshot().selection.dirty, true)
  assert.deepEqual(h.errors, [])
})

test('a stale Limits revision retains its draft while independent Selection saves at its own revision', async () => {
  const h = await harness()
  stageBoth(h)
  h.limits.state = ready(HOST_A, 42, { maxDepth: 1, maxActiveSubagents: 8 }, { maxDepth: 1, maxActiveSubagents: 8 })
  h.controller.save()
  await latest(h)
  assert.equal(h.limits.calls.length, 0)
  assert.equal(h.selection.calls.length, 1)
  assert.equal(h.selection.calls[0]?.revision, 82)
  assert.equal(h.controller.snapshot().limits.dirty, true)
  assert.equal(h.controller.snapshot().selection.dirty, false)
})

test('an accepted Reset verifies the new current descriptor and a repeated Reset uses its new revision', async () => {
  const oldBase = [{ provider: 'old-provider', model: 'old-model' }]
  const newBase = [{ provider: 'new-provider', model: 'new-model' }]
  const h = await harness({ selection: ready(HOST_A, 82,
    { enabled: true, allowedModels: [ROUTE] }, { enabled: true, allowedModels: oldBase }) })
  h.selection.plans.push({ afterMutation: () => {
    h.selection.state = ready(HOST_A, 83,
      { enabled: true, allowedModels: newBase }, { enabled: true, allowedModels: newBase })
  } })
  h.controller.reset('allowedModels')
  h.controller.save()
  await latest(h)
  assert.deepEqual(h.selection.calls[0], {
    patch: { allowedModels: { kind: 'reset' } }, revision: 82, generation: HOST_A,
  })
  assert.equal(h.controller.snapshot().selection.status?.kind, 'verified')
  assert.equal(h.controller.snapshot().selection.dirty, false)
  assert.deepEqual(h.controller.snapshot().allowedModels, newBase)
  h.controller.reset('allowedModels')
  h.controller.save()
  await latest(h)
  assert.equal(h.selection.calls.length, 2)
  assert.equal(h.selection.calls[1]?.revision, 83)
})

// ── FR5-B: the shared host numeric controller ─────────────────────────────

interface NumericCapSettings {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

type NumericReady<T extends object> = Extract<SectionRead<T>, { kind: 'ready' }>

interface NumericRecordedMutation<T extends object> {
  readonly patch: SectionPatch<T>
  readonly revision: number
  readonly generation: object
  readonly base: NumericReady<T>
}

function numericFixture(options: { mutate?: (patch: SectionPatch<NumericCapSettings>) => Promise<SectionMutationOutcome> | SectionMutationOutcome } = {}) {
  const generation = {}
  let revision = 3
  let effective: NumericCapSettings = { timeoutMs: 60_000, maxOutputBytes: 64_000 }
  const inherited: NumericCapSettings = { timeoutMs: 120_000, maxOutputBytes: 64_000 }
  const mutations: NumericRecordedMutation<NumericCapSettings>[] = []
  let readFailure: string | undefined
  let refreshFailure: Error | undefined
  const port: HostNumericSettingsPort<NumericCapSettings> = {
    read: () => readFailure === undefined
      ? {
          kind: 'ready',
          generation,
          revision,
          effective: { ...effective },
          inherited: { ...inherited },
          overridden: {
            timeoutMs: effective.timeoutMs !== inherited.timeoutMs,
            maxOutputBytes: effective.maxOutputBytes !== inherited.maxOutputBytes,
          },
        }
      : { kind: 'unreadable', reason: readFailure },
    refresh: async () => {
      if (refreshFailure !== undefined) throw refreshFailure
    },
    mutate: async (patch, expectedRevision, expectedGeneration, base) => {
      mutations.push({ patch, revision: expectedRevision, generation: expectedGeneration, base })
      const outcome = options.mutate === undefined ? { kind: 'accepted' as const } : await options.mutate(patch)
      if (outcome.kind !== 'accepted') return outcome
      if (expectedRevision !== revision || expectedGeneration !== generation) return { kind: 'conflict', reason: 'revision changed' }
      const next = { ...effective }
      for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
        const edit = patch[field]
        if (edit === undefined) continue
        next[field] = edit.kind === 'reset' ? inherited[field] : edit.value
      }
      effective = next
      revision += 1
      return outcome
    },
  }
  return {
    port,
    mutations,
    get generation() { return generation },
    get revision() { return revision },
    get effective() { return effective },
    setReadFailure(reason: string | undefined) { readFailure = reason },
    failRefresh(error: Error | undefined) { refreshFailure = error },
    externalWrite(next: Partial<NumericCapSettings>) {
      effective = { ...effective, ...next }
      revision += 1
    },
  }
}

const NUMERIC_FIELDS: readonly HostNumericSettingsField<NumericCapSettings>[] = [
  { key: 'timeoutMs', label: 'Command timeout (ms)' },
  { key: 'maxOutputBytes', label: 'Output cap per stream (bytes)' },
]

function makeNumericController(
  state: ReturnType<typeof numericFixture>,
  options: { runOwned?: (label: string, task: () => Promise<void>) => void } = {},
) {
  let renders = 0
  const controller = new HostNumericSettingsController<NumericCapSettings>({
    port: state.port,
    fields: NUMERIC_FIELDS,
    requestRender: () => { renders += 1 },
    runOwned: options.runOwned ?? ((_label, task) => { void task() }),
  })
  return { controller, renders: () => renders }
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

test('start loads the current section and syncs both drafts from the effective values', async () => {
  const fixtureState = numericFixture()
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  const snapshot = controller.snapshot()
  assert.equal(snapshot.loading, false)
  assert.equal(snapshot.current, true)
  assert.equal(snapshot.dirty, false)
  assert.deepEqual(snapshot.texts, { timeoutMs: '60000', maxOutputBytes: '64000' })
  assert.deepEqual(snapshot.source.kind === 'ready' ? snapshot.source.overridden : undefined,
    { timeoutMs: true, maxOutputBytes: false })
  controller.dispose()
})

test('editing stages only; blank stages an explicit Reset that stays dirty when effective matches inherited', async () => {
  const fixtureState = numericFixture()
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()

  controller.setNumber('timeoutMs', '30000')
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(fixtureState.mutations.length, 0, 'editing never writes')

  controller.reset('maxOutputBytes')
  const snapshot = controller.snapshot()
  assert.deepEqual(snapshot.resetFields, ['maxOutputBytes'])
  assert.equal(controller.textOf('maxOutputBytes'), '')
  // An explicit Reset is an intent even when the effective value equals base.
  controller.discard()
  controller.reset('maxOutputBytes')
  assert.equal(controller.snapshot().dirty, true)
  controller.dispose()
})

test('Save dispatches one exact-revision mutation and verifies from the same-generation readback', async () => {
  const fixtureState = numericFixture()
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  controller.setNumber('timeoutMs', '45000')
  controller.setNumber('maxOutputBytes', '128000')
  controller.save()
  await drainMicrotasks()
  assert.equal(fixtureState.mutations.length, 1)
  assert.deepEqual(fixtureState.mutations[0]?.patch, {
    timeoutMs: { kind: 'set', value: 45_000 },
    maxOutputBytes: { kind: 'set', value: 128_000 },
  })
  assert.equal(fixtureState.mutations[0]?.revision, 3)
  assert.equal(fixtureState.mutations[0]?.generation, fixtureState.generation)
  assert.equal(fixtureState.mutations[0]?.base.revision, 3, 'the captured base fences the ACTIVE row')
  const snapshot = controller.snapshot()
  assert.equal(snapshot.saving, false)
  assert.equal(snapshot.dirty, false)
  assert.equal(snapshot.saved, true)
  assert.equal(snapshot.status?.kind, 'verified')
  assert.deepEqual(snapshot.texts, { timeoutMs: '45000', maxOutputBytes: '128000' })
  assert.deepEqual(fixtureState.effective, { timeoutMs: 45_000, maxOutputBytes: 128_000 })
  controller.dispose()
})

test('a staged Reset dispatches the official unset and the next readback decides the shown value', async () => {
  const fixtureState = numericFixture()
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  controller.reset('timeoutMs')
  controller.save()
  await drainMicrotasks()
  assert.deepEqual(fixtureState.mutations[0]?.patch, { timeoutMs: { kind: 'reset' } })
  assert.equal(controller.snapshot().status?.kind, 'verified')
  // The host materialized its inherited value; the page shows the readback.
  assert.equal(controller.textOf('timeoutMs'), '120000')
  controller.dispose()
})

test('an invalid draft is refused before dispatch and keeps the field error reachable', async () => {
  const fixtureState = numericFixture()
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  for (const invalid of ['0', '-1', '1.5', '12garbage', 'NaN', 'Infinity']) {
    controller.setNumber('timeoutMs', invalid)
    controller.save()
    await drainMicrotasks()
    assert.equal(fixtureState.mutations.length, 0, `${JSON.stringify(invalid)} must never dispatch`)
    assert.match(controller.snapshot().issues.timeoutMs ?? '', /safe positive integer/u)
  }
  assert.equal(controller.snapshot().dirty, true, 'the invalid draft is retained')
  // A whitespace-only field is the documented empty-field Reset, not a set.
  controller.setNumber('timeoutMs', '  ')
  controller.save()
  await drainMicrotasks()
  assert.equal(fixtureState.mutations.length, 1)
  assert.deepEqual(fixtureState.mutations[0]?.patch, { timeoutMs: { kind: 'reset' } })
  controller.dispose()
})

test('an external revision change makes the captured page read-only until an explicit refresh', async () => {
  const fixtureState = numericFixture()
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  controller.setNumber('timeoutMs', '30000')
  fixtureState.externalWrite({ timeoutMs: 20_000 })
  const snapshot = controller.snapshot()
  assert.equal(snapshot.current, false)
  controller.setNumber('maxOutputBytes', '1000')
  assert.match(controller.snapshot().notice ?? '', /refresh before editing/u)
  controller.save()
  await drainMicrotasks()
  assert.equal(fixtureState.mutations.length, 0, 'a stale captured page never dispatches')
  assert.equal(controller.snapshot().status?.kind, 'not-saved')

  controller.discard()
  assert.equal(controller.refresh(), true)
  await drainMicrotasks()
  const refreshed = controller.snapshot()
  assert.equal(refreshed.current, true)
  assert.equal(refreshed.dirty, false)
  assert.equal(controller.textOf('timeoutMs'), '20000')
  controller.dispose()
})

test('a dirty refresh refuses until the explicit discard, and a refresh failure keeps the section read-only', async () => {
  const fixtureState = numericFixture()
  fixtureState.failRefresh(new Error('settings read lost'))
  const { controller } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  assert.match(controller.snapshot().notice ?? '', /Refresh failed/u)
  assert.equal(controller.snapshot().source.kind, 'ready')
  assert.equal(controller.snapshot().current, false, 'a failed refresh marks the captured read non-current')
  controller.setNumber('timeoutMs', '30000')
  assert.match(controller.snapshot().notice ?? '', /refresh before editing/u)

  fixtureState.failRefresh(undefined)
  controller.discard()
  assert.equal(controller.refresh(), true)
  await drainMicrotasks()
  assert.equal(controller.snapshot().current, true)
  controller.dispose()
})

test('refused and unconfirmed outcomes keep the draft and never claim Verified', async () => {
  for (const outcome of [
    { kind: 'rejected' as const, reason: 'the official validator refused the value' },
    { kind: 'outcome-unconfirmed' as const, reason: 'transport lost after dispatch' },
    { kind: 'conflict' as const, reason: 'revision changed' },
  ]) {
    const fixtureState = numericFixture({ mutate: () => outcome })
    const { controller } = makeNumericController(fixtureState)
    controller.start()
    await drainMicrotasks()
    controller.setNumber('timeoutMs', '30000')
    controller.save()
    await drainMicrotasks()
    const snapshot = controller.snapshot()
    assert.notEqual(snapshot.status?.kind, 'verified')
    assert.equal(snapshot.dirty, true, `${outcome.kind}: the draft is retained`)
    assert.match(snapshot.status?.text ?? '', outcome.kind === 'outcome-unconfirmed' ? /Outcome unconfirmed/u : /Not saved/u)
    controller.dispose()
  }
})

test('a disposed page never publishes a late settlement', async () => {
  const fixtureState = numericFixture()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  fixtureState.port.mutate = async (patch, revision, generation, base) => {
    fixtureState.mutations.push({ patch, revision, generation, base })
    entered()
    await gate
    return { kind: 'accepted' }
  }
  const { controller, renders } = makeNumericController(fixtureState)
  controller.start()
  await drainMicrotasks()
  controller.setNumber('timeoutMs', '30000')
  controller.save()
  await started
  const rendersBeforeDispose = renders()
  controller.dispose()
  release()
  await drainMicrotasks()
  assert.equal(renders(), rendersBeforeDispose, 'no repaint is published after dispose')
  controller.dispose()
})

test('the numeric controller treats the served Shell executor identity as currentness', async () => {
  interface ExecutorSection {
    readonly executor: 'bash' | 'pwsh'
    readonly timeoutMs: number
  }
  const generation = {}
  let revision = 1
  let effective: ExecutorSection = { executor: 'bash', timeoutMs: 60_000 }
  const mutations: Array<{ readonly patch: SectionPatch<ExecutorSection> }> = []
  const port: HostNumericSettingsPort<ExecutorSection> = {
    read: () => ({
      kind: 'ready', generation, revision,
      effective: { ...effective },
      inherited: { executor: 'bash', timeoutMs: 60_000 },
      overridden: { executor: false, timeoutMs: effective.timeoutMs !== 60_000 },
    }),
    refresh: async () => {},
    mutate: async (patch) => {
      mutations.push({ patch })
      return { kind: 'accepted' }
    },
  }
  const fields: readonly HostNumericSettingsField<ExecutorSection>[] = [
    { key: 'timeoutMs', label: 'Command timeout (ms)' },
  ]
  const controller = new HostNumericSettingsController<ExecutorSection>({
    port,
    fields,
    valueIdentity: value => value.executor,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  controller.start()
  await drainMicrotasks()
  assert.equal(controller.snapshot().current, true)

  // The same Host generation/revision now serves the OTHER executor row. A
  // revision-only fence would let the stale bash page write pwsh's row.
  effective = { executor: 'pwsh', timeoutMs: 60_000 }
  assert.equal(controller.snapshot().current, false, 'the served row identity is part of the fence')
  controller.setNumber('timeoutMs', '2')
  assert.match(controller.snapshot().notice ?? '', /refresh before editing/u)
  controller.save()
  await drainMicrotasks()
  assert.equal(mutations.length, 0, 'the stale executor page never dispatches')
  controller.dispose()
})
