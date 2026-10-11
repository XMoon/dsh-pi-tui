/** Production native /model renderer, original command and write paths.
 * Scripted tty/Host fixtures are named explicitly; only the final Direct case
 * mounts official live Agents. No decision or committed selection is injected.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { runOwned } from '../src/runtime/process/tasks.ts'
import type {
  ModelApplyOutcome,
  ModelPickerDirectory,
  ModelPickerRequest,
} from '../src/app/command/model-presentation.ts'
import { DirectModelCatalog } from '../src/runtime/direct/catalog-direct.ts'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { ownTspBoot, waitUntil, settle } from './support/tsp-runner-harness.ts'
import { createDirectTspFixture, waitFor } from './support/direct-tsp-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

test('production /model: an older pane without native kinds still refuses before the handler', async t => {
  const life = testLifecycle(t), home = life.tempDir('dsh-tsp-model-legacy-')
  let saves = 0
  const boot = await ownTspBoot({ life, home, logFile: home + '/diag.log',
    saveDefault: async () => { saves++ } })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil('capability refusal', () => boot.pane.output.text().includes("This command's UI is not available in TSP yet"))
    assert.equal(picker(boot.pane), undefined)
    assert.equal(saves, 0)
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally { await boot.settle() }
})

interface WireNode {
  id: string
  k: string
  p: Record<string, unknown>
  c?: WireNode[]
}
/** Fold actual SDK ops, so a retired receiver cannot satisfy an assertion. */
function nodes(pane: TspPane): WireNode[] {
  const live = new Map<string, WireNode>()
  const parents = new Map<string, string>()
  const remove = (id: string): void => {
    parents.delete(id)
    for (const [child, parent] of parents) if (parent === id) remove(child)
    live.delete(id)
    parents.delete(id)
  }
  const add = (node: WireNode, parent: string): void => {
    live.set(node.id, { ...node, p: { ...node.p } })
    parents.set(node.id, parent)
    for (const child of node.c ?? []) add(child, node.id)
  }
  for (const frame of pane.frames())
    for (const op of frame.ops) {
      if (op[0] === 'add') add(op[4] as unknown as WireNode, String(op[2]))
      if (op[0] === 'del') remove(String(op[1]))
      if (op[0] === 'set') {
        const node = live.get(String(op[1]))
        if (node !== undefined) Object.assign(node.p, op[2])
      }
    }
  return [...live.values()]
}
const picker = (pane: TspPane) =>
  nodes(pane).find((n) => n.k === 'picker' && n.id.includes('model-'))
const overlay = (pane: TspPane) =>
  nodes(pane).find((n) => n.k === 'overlay' && n.id.includes('model-'))
function action(pane: TspPane, act: string, item?: string, id = picker(pane)?.id): void {
  assert.ok(id)
  pane.event({
    ev: act === 'browse' ? 'activate' : 'action',
    sf: pane.frames().at(-1)!.sf,
    id,
    ...(act === 'browse' ? { item } : { act, ...(item === undefined ? {} : { value: item }) }),
  })
}
const directory: ModelPickerDirectory = {
  sessionless: true,
  current: { provider: 'a', model: 'same', reasoningEffort: 'high' },
  directory: {
    default: { provider: 'a', model: 'same', reasoningEffort: 'high' },
    routableProviders: ['a', 'b'],
    groups: [
      {
        id: 'a',
        name: 'A',
        models: [
          {
            id: 'same',
            name: 'Twin',
            description: 'A description',
            reasoning: {
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
              ],
            },
          },
        ],
      },
      { id: 'b', name: 'B', models: [{ id: 'same', name: 'Twin' }] },
    ],
    failures: [{ id: 'bad', name: 'Bad', message: 'Provider unavailable' }],
  },
}

test('native Model: browsing, effort, graphemes, modal and stale receiver fences', async (t) => {
  const pane = installTspPane({ modelPicker: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (e) => assert.fail(String(e)),
  })
  t.after(() => renderer.dispose())
  const cancels: number[] = []
  renderer.bindInput({
    exit() {},
    cancel: () => {
      cancels.push(1)
    },
    submit: () => assert.fail('picker must capture Enter'),
    steer() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  })
  assert.ok(renderer.modelPresentation)
  const writes: unknown[] = []
  let resolve!: (outcome: ModelApplyOutcome) => void
  const request: ModelPickerRequest = {
    isCurrent: () => true,
    apply: (selection: unknown) => {
      writes.push(selection)
      return new Promise<ModelApplyOutcome>((r) => {
        resolve = r
      })
    },
    runOwned: (label, task, options) =>
      runOwned(label, task, { ...options, diag: { debug() {}, warn() {}, error() {} } as never }),
  }
  const handle = renderer.modelPresentation.open(request)
  handle.setDirectory(directory)
  await waitUntil('native picker', () => picker(pane)?.p.state === 'ready')
  const first = picker(pane)!
  assert.deepEqual(first.p.current, [], 'sessionless never fabricates a current badge')
  assert.equal(
    (first.p.items as Array<{ disabled?: string }>).at(-1)?.disabled,
    'Unavailable provider',
  )
  action(pane, 'browse', JSON.stringify(['b', 'same']))
  await waitUntil('provider B', () => picker(pane)?.p.selected === JSON.stringify(['b', 'same']))
  assert.equal(writes.length, 0, 'activate is browsing only')
  const selected = picker(pane)!
  pane.event({ ev: 'action', sf: 'retired-surface', id: selected.id, act: 'apply' })
  action(pane, 'unknown-action')
  action(pane, 'browse', 'failure-0')
  await settle(30)
  assert.equal(writes.length, 0, 'wrong surface, unknown action and failure rows cannot write')
  action(pane, 'apply', undefined, first.id)
  await settle(30)
  assert.equal(writes.length, 0, 'a stale revision cannot apply the newly highlighted row')
  action(pane, 'browse', JSON.stringify(['a', 'same']))
  await waitUntil('provider A', () => picker(pane)?.p.selected === JSON.stringify(['a', 'same']))
  action(pane, 'apply')
  await waitUntil('effort page', () => overlay(pane) !== undefined)
  assert.equal(writes.length, 0, 'effort page admission is not a business write')
  pane.key('\u001b[D')
  pane.key('\u001b[D') // High -> Low -> provider default
  await settle(30)
  const oldEffort = overlay(pane)!.id
  const approval = renderer.interaction.showApprovalPrompt(
    { toolName: 'bash', reason: 'modal precedence' },
    false,
  )
  await settle(30)
  action(pane, 'apply', undefined, oldEffort)
  await settle(30)
  assert.equal(writes.length, 0, 'approval masks the model write seat')
  pane.key('\u001b')
  await approval
  await waitUntil(
    'model resumes',
    () => overlay(pane) !== undefined && overlay(pane)!.id !== oldEffort,
  )
  action(pane, 'apply', undefined, oldEffort)
  await settle(30)
  assert.equal(writes.length, 0, 'pre-modal receiver stays retired after resume')
  pane.key('\r')
  pane.key('\r')
  await waitUntil('one admitted write', () => writes.length === 1)
  assert.deepEqual(
    writes,
    [{ provider: 'a', model: 'same' }],
    'provider-default omits effort entirely',
  )
  pane.key('\u0003')
  await waitUntil('original interrupt', () => cancels.length === 1)
  pane.key('\u001b')
  await waitUntil('closed pending panel', () => overlay(pane) === undefined)
  const reopened = renderer.modelPresentation.open(request)
  reopened.setDirectory(directory)
  await waitUntil('reopened picker', () => picker(pane)?.p.state === 'ready')
  const reopenId = picker(pane)!.id
  resolve('committed')
  await settle(30)
  assert.equal(picker(pane)!.id, reopenId, 'old settlement cannot close/repaint the replacement')
  pane.key('👩‍💻e\u0301')
  await waitUntil('grapheme query', () => picker(pane)?.p.query === '👩‍💻e\u0301')
  pane.key('\u001b[D')
  pane.key('\u007f')
  await waitUntil('grapheme delete', () => picker(pane)?.p.query === 'e\u0301')
  assert.equal(picker(pane)?.p.cursor, 0)
  renderer.display.beginSessionHydration()
  await waitUntil('hydration retires panel', () => picker(pane) === undefined)
  action(pane, 'apply', undefined, reopenId)
  await settle(30)
  assert.equal(writes.length, 1)
})

test('native Model: proven refusal stays usable, uncertain settlement closes, supersession stays silent', async t => {
  const pane = installTspPane({ modelPicker: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, { requestExit() {}, onFatal: e => assert.fail(String(e)) })
  t.after(() => renderer.dispose())
  renderer.bindInput({ exit() {}, cancel() {}, submit() {}, steer() {}, noteUserInput() {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false })
  assert.ok(renderer.modelPresentation)
  for (const outcome of ['rejected', 'cancelled', 'unsupported', 'indeterminate', 'superseded'] as const) {
    let resolve!: (outcome: ModelApplyOutcome) => void
    const handle = renderer.modelPresentation.open({
      isCurrent: () => true,
      apply: () => new Promise<ModelApplyOutcome>(r => { resolve = r }),
      runOwned: (label, task, options) => runOwned(label, task, { ...options, diag: { debug() {}, warn() {}, error() {} } as never }),
    })
    handle.setDirectory(directory)
    await waitUntil('ready for ' + outcome, () => picker(pane)?.p.state === 'ready')
    action(pane, 'browse', JSON.stringify(['b', 'same']))
    await waitUntil('plain model', () => picker(pane)?.p.selected === JSON.stringify(['b', 'same']))
    action(pane, 'apply')
    await waitUntil('pending ' + outcome, () => resolve !== undefined)
    await settle(20)
    const pendingId = picker(pane)!.id
    resolve(outcome)
    if (outcome === 'indeterminate') await waitUntil('uncertain closes', () => picker(pane) === undefined)
    else if (outcome === 'superseded') {
      await settle(30)
      assert.equal(picker(pane)!.id, pendingId)
    } else {
      await waitUntil('refusal clears pending', () => picker(pane) !== undefined && picker(pane)!.id !== pendingId)
      assert.ok(!(picker(pane)!.p.actions as Array<{ id: string; disabled?: boolean }>).find(a => a.id === 'apply')!.disabled)
      assert.deepEqual(picker(pane)!.p.current, [], 'a refusal never paints the requested model as current')
    }
    if (outcome === 'rejected') {
      action(pane, 'apply')
      await waitUntil('retry pending clears old refusal', () =>
        (picker(pane)?.p.actions as Array<{ label: string }> | undefined)?.some(a => a.label === 'Selecting…') === true)
      assert.doesNotMatch(String((picker(pane)!.p.strip as { label: string }).label), /rejected/)
      resolve('cancelled')
      await waitUntil('retry shows its own outcome', () =>
        String((picker(pane)?.p.strip as { label: string } | undefined)?.label).includes('cancelled'))
    }
    handle.close()
    await waitUntil('retired', () => picker(pane) === undefined)
  }
})

test('production /model: sessionless pending save, close/reopen and settled default', async (t) => {
  const life = testLifecycle(t),
    home = life.tempDir('dsh-tsp-model-default-')
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const saved: unknown[] = []
  const boot = await ownTspBoot({
    life,
    home,
    logFile: home + '/diag.log',
    modelPicker: true,
    saveDefault: async (next) => {
      saved.push(next)
      await gate
    },
  })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil(
      'classified /model opens native picker',
      () => picker(boot.pane)?.p.state === 'ready',
    )
    assert.equal(saved.length, 0)
    assert.equal(boot.harness.createdSessions.length, 0)
    action(boot.pane, 'browse', JSON.stringify(['p', 'm2']))
    await waitUntil(
      'm2 browse',
      () => picker(boot.pane)?.p.selected === JSON.stringify(['p', 'm2']),
    )
    assert.equal(saved.length, 0)
    action(boot.pane, 'apply')
    await waitUntil('original default persistence sink', () => saved.length === 1)
    assert.deepEqual(saved, [{ provider: 'p', model: 'm2' }])
    assert.equal(
      boot.harness.createdSessions.length,
      0,
      'default selection must not create a session',
    )
    await waitUntil(
      'pending action',
      () =>
        (picker(boot.pane)?.p.actions as Array<{ label: string }> | undefined)?.some(
          (a) => a.label === 'Selecting…',
        ) === true,
    )
    boot.pane.key('\u001b')
    await waitUntil('close picker', () => picker(boot.pane) === undefined)
    boot.pane.key('/model\r')
    await waitUntil('reopened old default', () => picker(boot.pane)?.p.state === 'ready')
    const id = picker(boot.pane)!.id
    release()
    await settle(60)
    assert.equal(picker(boot.pane)!.id, id)
    boot.pane.key('\u001b')
    await waitUntil('close again', () => picker(boot.pane) === undefined)
    boot.pane.key('/model\r')
    await waitUntil(
      'authoritative saved default',
      () => picker(boot.pane)?.p.selected === JSON.stringify(['p', 'm2']),
    )
    assert.deepEqual(picker(boot.pane)!.p.current, [])
    assert.equal(saved.length, 1)
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally {
    release()
    await boot.settle()
  }
})

test('production /model: failed default remains indeterminate and reconciles from Host read', async (t) => {
  const life = testLifecycle(t),
    home = life.tempDir('dsh-tsp-model-unknown-')
  let saves = 0
  const boot = await ownTspBoot({
    life,
    home,
    logFile: home + '/diag.log',
    modelPicker: true,
    saveDefault: async () => {
      saves++
      throw new Error('disk failure')
    },
  })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil('picker ready', () => picker(boot.pane)?.p.state === 'ready')
    action(boot.pane, 'apply')
    await waitUntil('original indeterminate notice', () =>
      boot.pane.output.text().includes('default may still land'),
    )
    await waitUntil('indeterminate dismisses', () => picker(boot.pane) === undefined)
    assert.equal(saves, 1)
    boot.pane.key('/model\r')
    await waitUntil('read reconciliation', () => picker(boot.pane)?.p.state === 'ready')
    assert.match(String((picker(boot.pane)!.p.strip as { label: string }).label), /p \/ m$/)
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally {
    await boot.settle()
  }
})

test('official Direct Agent: native /model makes exactly one durable Session selection', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    deltas: ['model-live-ok'],
  })
  const original = DirectModelCatalog.prototype.selectSessionModel
  const records: Array<{ sessionId: string; outcome: string }> = []
  DirectModelCatalog.prototype.selectSessionModel = async function (...args) {
    const result = await original.apply(this, args)
    records.push({ sessionId: args[0], outcome: result.outcome.kind })
    return result
  }
  t.after(() => {
    DirectModelCatalog.prototype.selectSessionModel = original
  })
  try {
    await waitFor('booted', () => fixture.pane.output.text().includes('dock.composer'))
    fixture.pane.key('create live session\r')
    await waitFor('real Agent turn', () => fixture.pane.output.text().includes('model-live-ok'))
    fixture.pane.key('/model\r')
    await waitFor('live native directory', () => picker(fixture.pane)?.p.state === 'ready')
    assert.equal(records.length, 0)
    action(fixture.pane, 'apply')
    await waitFor('original Direct model write settlement', () => records.length === 1)
    assert.equal(records[0]!.outcome, 'committed')
    const agent = fixture.ctx.agents.get(records[0]!.sessionId as never)
    assert.ok(agent)
    const events = agent.session.snapshotEvents().filter((e) => e.type === 'model/selection')
    assert.equal(events.length, 1, 'the real Session log contains one selection append')
    assert.deepEqual(events[0]!.data, { provider: 'scripted', model: 'scripted-model' })
    await waitFor('committed closes picker', () => picker(fixture.pane) === undefined)
    assert.equal(fixture.modelCalls(), 1, 'picking a model does not dispatch a prompt')
  } finally {
    DirectModelCatalog.prototype.selectSessionModel = original
    await fixture.settle()
  }
})

test('official Host same-name /model keeps the original Host route even with native UI enabled', async (t) => {
  const life = testLifecycle(t),
    calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    hostCommands: [
      {
        name: 'model',
        description: 'Host owns model',
        handler: (i) => {
          calls.push(i.rawInput)
          return undefined
        },
      },
    ],
  })
  try {
    await waitFor('booted', () => fixture.pane.output.text().includes('dock.composer'))
    fixture.pane.key('/model\r')
    await waitFor('original Host sink', () => calls.length === 1)
    assert.deepEqual(calls, [''], 'the Host receives the original parsed argument string')
    assert.equal(picker(fixture.pane), undefined)
  } finally {
    await fixture.settle()
  }
})
