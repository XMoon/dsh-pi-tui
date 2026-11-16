/** The FR5-B per-open numeric controller: staged drafts, explicit Reset,
 * validation, one revision-checked write per Save and currentness fences. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HostNumericSettingsController,
  type HostNumericSettingsField,
  type HostNumericSettingsPort,
} from '../../src/app/command/host-numeric-settings.ts'
import type {
  SectionMutationOutcome,
  SectionPatch,
  SectionRead,
} from '../../src/runtime/config-port.ts'

interface CapSettings {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

type Ready<T extends object> = Extract<SectionRead<T>, { kind: 'ready' }>

interface RecordedMutation<T extends object> {
  readonly patch: SectionPatch<T>
  readonly revision: number
  readonly generation: object
  readonly base: Ready<T>
}

function fixture(options: { mutate?: (patch: SectionPatch<CapSettings>) => Promise<SectionMutationOutcome> | SectionMutationOutcome } = {}) {
  const generation = {}
  let revision = 3
  let effective: CapSettings = { timeoutMs: 60_000, maxOutputBytes: 64_000 }
  const inherited: CapSettings = { timeoutMs: 120_000, maxOutputBytes: 64_000 }
  const mutations: RecordedMutation<CapSettings>[] = []
  let readFailure: string | undefined
  let refreshFailure: Error | undefined
  const port: HostNumericSettingsPort<CapSettings> = {
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
    externalWrite(next: Partial<CapSettings>) {
      effective = { ...effective, ...next }
      revision += 1
    },
  }
}

const FIELDS: readonly HostNumericSettingsField<CapSettings>[] = [
  { key: 'timeoutMs', label: 'Command timeout (ms)' },
  { key: 'maxOutputBytes', label: 'Output cap per stream (bytes)' },
]

function makeController(
  state: ReturnType<typeof fixture>,
  options: { runOwned?: (label: string, task: () => Promise<void>) => void } = {},
) {
  let renders = 0
  const controller = new HostNumericSettingsController<CapSettings>({
    port: state.port,
    fields: FIELDS,
    requestRender: () => { renders += 1 },
    runOwned: options.runOwned ?? ((_label, task) => { void task() }),
  })
  return { controller, renders: () => renders }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

test('start loads the current section and syncs both drafts from the effective values', async () => {
  const fixtureState = fixture()
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()
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
  const fixtureState = fixture()
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()

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
  const fixtureState = fixture()
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()
  controller.setNumber('timeoutMs', '45000')
  controller.setNumber('maxOutputBytes', '128000')
  controller.save()
  await settle()
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
  const fixtureState = fixture()
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()
  controller.reset('timeoutMs')
  controller.save()
  await settle()
  assert.deepEqual(fixtureState.mutations[0]?.patch, { timeoutMs: { kind: 'reset' } })
  assert.equal(controller.snapshot().status?.kind, 'verified')
  // The host materialized its inherited value; the page shows the readback.
  assert.equal(controller.textOf('timeoutMs'), '120000')
  controller.dispose()
})

test('an invalid draft is refused before dispatch and keeps the field error reachable', async () => {
  const fixtureState = fixture()
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()
  for (const invalid of ['0', '-1', '1.5', '12garbage', 'NaN', 'Infinity']) {
    controller.setNumber('timeoutMs', invalid)
    controller.save()
    await settle()
    assert.equal(fixtureState.mutations.length, 0, `${JSON.stringify(invalid)} must never dispatch`)
    assert.match(controller.snapshot().issues.timeoutMs ?? '', /safe positive integer/u)
  }
  assert.equal(controller.snapshot().dirty, true, 'the invalid draft is retained')
  // A whitespace-only field is the documented empty-field Reset, not a set.
  controller.setNumber('timeoutMs', '  ')
  controller.save()
  await settle()
  assert.equal(fixtureState.mutations.length, 1)
  assert.deepEqual(fixtureState.mutations[0]?.patch, { timeoutMs: { kind: 'reset' } })
  controller.dispose()
})

test('an external revision change makes the captured page read-only until an explicit refresh', async () => {
  const fixtureState = fixture()
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()
  controller.setNumber('timeoutMs', '30000')
  fixtureState.externalWrite({ timeoutMs: 20_000 })
  const snapshot = controller.snapshot()
  assert.equal(snapshot.current, false)
  controller.setNumber('maxOutputBytes', '1000')
  assert.match(controller.snapshot().notice ?? '', /refresh before editing/u)
  controller.save()
  await settle()
  assert.equal(fixtureState.mutations.length, 0, 'a stale captured page never dispatches')
  assert.equal(controller.snapshot().status?.kind, 'not-saved')

  controller.discard()
  assert.equal(controller.refresh(), true)
  await settle()
  const refreshed = controller.snapshot()
  assert.equal(refreshed.current, true)
  assert.equal(refreshed.dirty, false)
  assert.equal(controller.textOf('timeoutMs'), '20000')
  controller.dispose()
})

test('a dirty refresh refuses until the explicit discard, and a refresh failure keeps the section read-only', async () => {
  const fixtureState = fixture()
  fixtureState.failRefresh(new Error('settings read lost'))
  const { controller } = makeController(fixtureState)
  controller.start()
  await settle()
  assert.match(controller.snapshot().notice ?? '', /Refresh failed/u)
  assert.equal(controller.snapshot().source.kind, 'ready')
  assert.equal(controller.snapshot().current, false, 'a failed refresh marks the captured read non-current')
  controller.setNumber('timeoutMs', '30000')
  assert.match(controller.snapshot().notice ?? '', /refresh before editing/u)

  fixtureState.failRefresh(undefined)
  controller.discard()
  assert.equal(controller.refresh(), true)
  await settle()
  assert.equal(controller.snapshot().current, true)
  controller.dispose()
})

test('refused and unconfirmed outcomes keep the draft and never claim Verified', async () => {
  for (const outcome of [
    { kind: 'rejected' as const, reason: 'the official validator refused the value' },
    { kind: 'outcome-unconfirmed' as const, reason: 'transport lost after dispatch' },
    { kind: 'conflict' as const, reason: 'revision changed' },
  ]) {
    const fixtureState = fixture({ mutate: () => outcome })
    const { controller } = makeController(fixtureState)
    controller.start()
    await settle()
    controller.setNumber('timeoutMs', '30000')
    controller.save()
    await settle()
    const snapshot = controller.snapshot()
    assert.notEqual(snapshot.status?.kind, 'verified')
    assert.equal(snapshot.dirty, true, `${outcome.kind}: the draft is retained`)
    assert.match(snapshot.status?.text ?? '', outcome.kind === 'outcome-unconfirmed' ? /Outcome unconfirmed/u : /Not saved/u)
    controller.dispose()
  }
})

test('a disposed page never publishes a late settlement', async () => {
  const fixtureState = fixture()
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
  const { controller, renders } = makeController(fixtureState)
  controller.start()
  await settle()
  controller.setNumber('timeoutMs', '30000')
  controller.save()
  await started
  const rendersBeforeDispose = renders()
  controller.dispose()
  release()
  await settle()
  assert.equal(renders(), rendersBeforeDispose, 'no repaint is published after dispose')
  controller.dispose()
})
