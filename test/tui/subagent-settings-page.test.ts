/** Local presentation and pointer-fence tests for SubagentSettingsPage. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth, type TuiMouseEvent } from '@xmoon76/pi-tui'
import {
  HostNumericSettingsController,
  type HostNumericSettingsField,
  type HostNumericSettingsPort,
} from '../../src/app/command/host-numeric-settings.ts'
import { SubagentSettingsController } from '../../src/app/command/subagent-settings.ts'
import type { ModelDirectoryDto } from '../../src/runtime/catalog-port.ts'
import type {
  SectionMutationOutcome,
  SectionPatch,
  SectionRead,
  SubagentAllowedModelRoute,
  SubagentLimits,
  SubagentLimitsConfig,
  SubagentModelSelection,
  SubagentModelSelectionConfig,
} from '../../src/runtime/config-port.ts'
import type { OwnedTaskOptions } from '../../src/runtime/process/tasks.ts'
import { HostNumericSettingsPage } from '../../src/tui/panels/host-numeric-settings-page.ts'
import { SubagentSettingsPage } from '../../src/tui/panels/subagent-settings-page.ts'

const ENTER = '\r'
const ESC = '\x1b'
const LEFT = '\x1b[D'
const HOME = '\x1b[H'
const END = '\x1b[F'
const DOWN = '\x1b[B'
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')

function directory(): ModelDirectoryDto {
  return {
    default: { provider: 'p', model: 'm' },
    routableProviders: ['p'],
    groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }] }],
    failures: [],
  }
}

interface RigOptions {
  readonly allowedModels?: readonly SubagentAllowedModelRoute[]
  readonly directoryError?: Error
  readonly directoryValue?: ModelDirectoryDto
  readonly holdLimits?: boolean
  readonly rejectLimits?: boolean
  readonly lostAckLimits?: boolean
  readonly lostAckSelection?: boolean
  readonly holdDirectory?: boolean
}

function rig(options: RigOptions = {}) {
  let generation: object = {}
  const limitsBase: SubagentLimits = { maxDepth: 1, maxActiveSubagents: 8 }
  let limitsValue: SubagentLimits = { ...limitsBase }
  let limitsRevision = 1
  const selectionBase: SubagentModelSelection = { enabled: false, allowedModels: [] }
  let selectionValue: SubagentModelSelection = {
    enabled: false,
    allowedModels: options.allowedModels?.map(route => ({ ...route })) ?? [],
  }
  let selectionRevision = 1
  const writes: Array<{ readonly section: 'limits' | 'selection'; readonly patch: object; readonly revision: number; readonly generation: object }> = []
  const controllerTasks: Promise<unknown>[] = []
  const pageTasks: Promise<void>[] = []
  const dones: number[] = []
  let renderRequests = 0
  let refreshes = 0
  let directoryReads = 0
  const directoryHolds: Array<() => void> = []
  let markDirectoryStarted: (() => void) | undefined
  const directoryStarted = new Promise<void>(resolve => { markDirectoryStarted = resolve })
  let releaseLimits: (() => void) | undefined
  const limitsWait = options.holdLimits ? new Promise<void>(resolve => { releaseLimits = resolve }) : undefined
  let markLimitsDispatched: (() => void) | undefined
  const limitsDispatched = new Promise<void>(resolve => { markLimitsDispatched = resolve })

  const limitsRead = (): SectionRead<SubagentLimits> => ({
    kind: 'ready', generation, revision: limitsRevision,
    effective: { ...limitsValue }, inherited: { ...limitsBase },
    overridden: {
      maxDepth: limitsValue.maxDepth !== limitsBase.maxDepth,
      maxActiveSubagents: limitsValue.maxActiveSubagents !== limitsBase.maxActiveSubagents,
    },
  })
  const selectionRead = (): SectionRead<SubagentModelSelection> => ({
    kind: 'ready', generation, revision: selectionRevision,
    effective: { enabled: selectionValue.enabled, allowedModels: selectionValue.allowedModels.map(route => ({ ...route })) },
    inherited: { enabled: selectionBase.enabled, allowedModels: [] },
    overridden: {
      enabled: selectionValue.enabled !== selectionBase.enabled,
      allowedModels: JSON.stringify(selectionValue.allowedModels) !== JSON.stringify(selectionBase.allowedModels),
    },
  })
  const apply = <T extends object>(value: T, inherited: T, patch: SectionPatch<T>): T => {
    const next = { ...value } as Record<string, unknown>
    for (const [field, operation] of Object.entries(patch)) {
      const op = operation as { readonly kind: 'set'; readonly value: unknown } | { readonly kind: 'reset' }
      next[field] = op.kind === 'reset' ? inherited[field as keyof T] : op.value
    }
    return next as T
  }
  const limits: SubagentLimitsConfig = {
    read: limitsRead,
    refresh: async () => { refreshes += 1 },
    mutate: async (patch, revision, pinned): Promise<SectionMutationOutcome> => {
      markLimitsDispatched?.()
      writes.push({ section: 'limits', patch, revision, generation: pinned })
      if (pinned !== generation || revision !== limitsRevision) return { kind: 'conflict', reason: 'stale' }
      if (limitsWait !== undefined) await limitsWait
      if (options.rejectLimits === true) return { kind: 'rejected', reason: 'limits refused' }
      if (options.lostAckLimits === true) return { kind: 'outcome-unconfirmed', reason: 'reply lost' }
      limitsValue = apply(limitsValue, limitsBase, patch)
      limitsRevision += 1
      return { kind: 'accepted' }
    },
  }
  const selection: SubagentModelSelectionConfig = {
    read: selectionRead,
    refresh: async () => { refreshes += 1 },
    mutate: async (patch, revision, pinned): Promise<SectionMutationOutcome> => {
      writes.push({ section: 'selection', patch, revision, generation: pinned })
      if (pinned !== generation || revision !== selectionRevision) return { kind: 'conflict', reason: 'stale' }
      if (options.lostAckSelection === true) return { kind: 'outcome-unconfirmed', reason: 'reply lost' }
      selectionValue = apply(selectionValue, selectionBase, patch)
      selectionRevision += 1
      return { kind: 'accepted' }
    },
  }
  const controller = new SubagentSettingsController({
    limits,
    selection,
    requestRender: () => { renderRequests += 1 },
    runOwned: (_label, task) => { controllerTasks.push(Promise.resolve().then(task)) },
  })
  const page = new SubagentSettingsPage({
    controller,
    catalog: {
      loadDirectory: async signal => {
        directoryReads += 1
        markDirectoryStarted?.()
        if (options.holdDirectory === true) {
          await new Promise<void>(resolve => { directoryHolds.push(resolve) })
        }
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (options.directoryError !== undefined) throw options.directoryError
        return options.directoryValue ?? directory()
      },
    },
    requestRender: () => { renderRequests += 1 },
    done: () => { dones.push(dones.length + 1) },
    runOwned: <T,>(_label: string, task: () => T | Promise<T>, taskOptions: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
      const settled = Promise.resolve().then(task).then(
        result => taskOptions.onResult?.(result),
        error => taskOptions.onError?.(error),
      )
      pageTasks.push(settled)
    },
  })
  return {
    page, controller, writes, dones,
    releaseLimits: () => { releaseLimits?.() },
    limitsDispatched,
    refreshCount: () => refreshes,
    directoryReadCount: () => directoryReads,
    directoryStarted,
    releaseDirectory: () => { directoryHolds.shift()?.() },
    renderRequestCount: () => renderRequests,
    replaceGeneration: () => { generation = {} },
    drainTasks: async () => {
      for (let turn = 0; turn < 12; turn += 1) {
        const pending = [...controllerTasks.splice(0), ...pageTasks.splice(0)]
        if (pending.length === 0) return
        await Promise.all(pending)
      }
      assert.fail('owned page/controller tasks did not settle')
    },
  }
}

function mouse(type: 'press' | 'click', x: number, y: number, width: number, height: number): TuiMouseEvent {
  return { type, button: 'left', x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false }
}

function rowIndex(frame: readonly string[], predicate: (line: string) => boolean): number {
  return frame.findIndex(line => predicate(strip(line)))
}

function clickRow(page: SubagentSettingsPage, frame: readonly string[], row: number, width: number, text: string): void {
  const line = strip(frame[row] ?? '')
  const start = line.indexOf(text)
  assert.notEqual(start, -1, `painted row contains ${text}`)
  const x = visibleWidth(line.slice(0, start))
  assert.equal(page.handleMouse(mouse('press', x, row, width, frame.length))?.handled, true)
  // Root requests a render after a body press. An unchanged painted target
  // survives that render; semantic/geometry changes are covered separately.
  page.render(width)
  assert.equal(page.handleMouse(mouse('click', x, row, width, frame.length))?.handled, true)
}

async function started(options: RigOptions = {}) {
  const harness = rig(options)
  harness.page.setMaxRows(12)
  await harness.drainTasks()
  return harness
}

function barLine(frame: readonly string[]): string { return strip(frame.at(-1) ?? '') }
function activateBar(page: SubagentSettingsPage, id: string): void {
  const span = page.paintedBarSpans().find(candidate => candidate.id === id)
  assert.ok(span !== undefined, `expected painted bar span ${id}`)
  page.activateBarSpan(id)
}
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}
function selectField(page: SubagentSettingsPage, name: string): string[] {
  let frame = page.render(80)
  for (let step = 0; step < 4 && !strip(frame.join('\n')).includes(`> ${name}`); step += 1) {
    page.handleInput(UP)
    frame = page.render(80)
  }
  for (let step = 0; step < 4 && !strip(frame.join('\n')).includes(`> ${name}`); step += 1) {
    page.handleInput(DOWN)
    frame = page.render(80)
  }
  assert.match(strip(frame.join('\n')), new RegExp(`> ${name}`, 'u'), `field ${name} must be selected`)
  return frame
}

test('the grouped Subagent tenant browses four fields and opens the editor only on an explicit Edit', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  let frame = page.render(80)
  const plain = strip(frame.join('\n'))
  assert.match(plain, /Limits/u)
  assert.match(plain, /> Maximum depth\s+1/u, 'entering the group selects the first field, never its Input')
  assert.match(plain, /Parallelism\s+8/u)
  assert.match(plain, /Model selection/u)
  assert.match(plain, /Enabled\s+Off/u)
  assert.match(plain, /Allowed models\s+0 routes/u)
  assert.match(plain, /Changes are staged until Save\./u)
  assert.doesNotMatch(plain, /Value:\s/u, 'no editor opens on entry')
  assert.match(barLine(frame), /Edit \[Enter\].*Details \[\?\].*Back \[Esc\]/u)

  // A field row click only SELECTS: the editor stays closed.
  const parallelRow = rowIndex(frame, line => line.includes('Parallelism'))
  assert.notEqual(parallelRow, -1)
  clickRow(page, frame, parallelRow, 80, 'Parallelism')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /> Parallelism/u)
  assert.doesNotMatch(strip(frame.join('\n')), /Value:\s/u, 'a field row click never opens the editor')
  assert.equal(controller.snapshot().dirty, false)

  // The explicit Edit opens the current field's raw Input.
  activateBar(page, 'bar:edit')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Edit Subagent parallelism limit/u)
  assert.match(barLine(frame), /Stage \[Enter\].*Cancel \[Esc\]/u)
  page.handleInput('\x15')
  page.handleInput('2')
  frame = page.render(80)
  activateBar(page, 'bar:apply')
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().limits.patch.maxActiveSubagents, { kind: 'set', value: 2 })
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(h.writes.length, 0, 'Stage never writes')
  assert.match(strip(frame.join('\n')), /Current: 8 · Unsaved/u)
  assert.match(strip(frame.join('\n')), /1 unsaved change · Limits/u)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:save'), 'the grouped Save is painted for the dirty field')

  // Tab wraps field selection locally and never leaves the tenant.
  page.handleInput('\t')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /> Enabled/u)
})

test('a blank or invalid Stage stays in the raw Input with the real error and zero patch', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  let frame = page.render(80)
  activateBar(page, 'bar:edit')
  frame = page.render(80)
  page.handleInput('\x15')
  frame = page.render(80)
  assert.match(barLine(frame), /Stage \[Enter\]/u, 'an empty visible Input still offers the real Stage')
  activateBar(page, 'bar:apply')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Value is required\./u)
  assert.match(strip(frame.join('\n')), /Edit Maximum recursion depth/u, 'the refused Stage stays in the Input')
  assert.equal(controller.snapshot().dirty, false)
  assert.equal(h.writes.length, 0)

  for (const invalid of ['-1', '1.5', '1e3', '999999999999999999999']) {
    page.handleInput('\x15')
    for (const character of invalid) page.handleInput(character)
    frame = page.render(80)
    activateBar(page, 'bar:apply')
    frame = page.render(80)
    assert.match(strip(frame.join('\n')), /Enter a safe integer from 0 to/u, `${invalid} must paint the real issue`)
    assert.equal(controller.snapshot().dirty, false, `${invalid} must not stage`)
    assert.equal(h.writes.length, 0)
  }
  // A legal value stages; Cancel keeps it and never writes.
  page.handleInput('\x15')
  page.handleInput('0')
  frame = page.render(80)
  activateBar(page, 'bar:apply')
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'set', value: 0 })
  activateBar(page, 'bar:edit')
  page.handleInput('\x15')
  page.handleInput('7')
  page.render(80)
  page.handleInput(ESC)
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'set', value: 0 }, 'Cancel keeps the prior staged value')
  assert.equal(h.writes.length, 0)
})

test('a legal Stage equal to the served value removes only that field and paints No changes', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  page.render(80)
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('1')
  page.render(80)
  activateBar(page, 'bar:apply')
  const frame = page.render(80)
  assert.equal(controller.snapshot().limits.patch.maxDepth, undefined)
  assert.equal(controller.snapshot().dirty, false)
  assert.match(strip(frame.join('\n')), /^No changes\s*$/mu)
  assert.doesNotMatch(barLine(frame), /Save \[S\]/u, 'a real no-op never offers a fabricated Save')
  assert.equal(h.writes.length, 0)
})

test('the selected-field Advanced stages ONE official reset and revokes an unread action', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  page.render(80)
  page.handleInput('?')
  let frame = page.render(80)
  let plain = strip(frame.join('\n'))
  assert.match(plain, /Maximum recursion depth/u, 'the Advanced names the complete field identity')
  assert.match(plain, /Effective\s+1/u)
  assert.match(plain, /Inherited\s+1/u)
  assert.match(plain, /Matches base/u)
  assert.match(plain, /Reset stages the official unset\./u)
  assert.match(barLine(frame), /Reset \[X\].*Back \[Esc\]/u)
  page.handleInput('x')
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'reset' })
  assert.equal(controller.snapshot().dirty, true, 'an explicit reset is dirty even when effective equals inherited')
  assert.equal(h.writes.length, 0, 'Reset only stages')
  assert.match(strip(frame.join('\n')), /Reset staged/u)

  // The action is published only after THIS disclosure instance's complete
  // facts were really read; a width change revokes that receipt.
  page.setMaxRows(3)
  page.render(80)
  page.handleInput('?')
  page.render(80)
  page.handleInput('x')
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'reset' }, 'an unread short grant stages nothing')
  let paintedReset = false
  for (let step = 0; step < 80 && !paintedReset; step += 1) {
    page.handleInput(DOWN)
    page.render(80)
    paintedReset = page.paintedBarSpans().some(span => span.id === 'bar:reset')
  }
  assert.equal(paintedReset, true, 'reading the complete facts over successive frames publishes Reset')
  page.handleInput('x')
  frame = page.render(80)
  assert.doesNotMatch(strip(frame.join('\n')), /Reset to inherited…/u, 'the admitted Reset leaves the disclosure')
  assert.match(strip(frame.join('\n')), /Maximum depth\s+Reset staged/u, 'the group browse is visible again')
})

test('an explicit Toggle stages Enabled while a row click never toggles; an On+empty draft refuses Save', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  let frame = page.render(80)
  const enabledRow = rowIndex(frame, line => line.includes('Enabled'))
  assert.notEqual(enabledRow, -1)
  clickRow(page, frame, enabledRow, 80, 'Enabled')
  assert.equal(controller.snapshot().enabled, false, 'a row click only selects Enabled')
  assert.equal(controller.snapshot().dirty, false)

  frame = selectField(page, 'Enabled')
  page.handleInput(ENTER)
  frame = page.render(80)
  assert.equal(controller.snapshot().enabled, true)
  assert.equal(controller.snapshot().dirty, true)
  assert.match(strip(frame.join('\n')), /Select at least one allowed route before enabling model selection\./u)
  assert.equal(controller.canSave(), false)
  assert.doesNotMatch(barLine(frame), /Save \[S\]/u, 'an invalid draft offers no Save')
  assert.equal(h.writes.length, 0)
})

test('the directory keeps exact provider+model identity and toggles only through its explicit action', async () => {
  const h = await started({
    directoryValue: {
      default: { provider: 'p1', model: 'm1' },
      routableProviders: ['p1', 'p2'],
      groups: [
        { id: 'p1', name: 'Provider One', models: [{ id: 'm1', name: 'Model One' }] },
        { id: 'p2', name: 'Provider Two', models: [{ id: 'm1', name: 'Shared Model' }] },
      ],
      failures: [],
    },
  })
  const { page, controller, writes } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  let frame = page.render(80)
  let plain = strip(frame.join('\n'))
  assert.match(plain, /Provider One/u)
  assert.match(plain, /Provider Two/u)
  assert.match(plain, /> Model One/u, 'the first allowed/available route is selected')
  assert.match(barLine(frame), /Add route \[Enter\]/u)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'))

  // A row click only selects: the same model id under another provider keeps
  // its own full identity and does not inherit the other row's state.
  const sharedRow = rowIndex(frame, line => line.includes('Shared Model'))
  assert.notEqual(sharedRow, -1)
  clickRow(page, frame, sharedRow, 80, 'Shared Model')
  frame = page.render(80)
  plain = strip(frame.join('\n'))
  assert.match(plain, /> Shared Model/u)
  assert.match(plain, /p2 \/ m1/u)
  assert.match(plain, /Add route \[Enter\]/u)
  assert.deepEqual(controller.snapshot().allowedModels, [], 'a row click never toggles the route')

  activateBar(page, 'bar:route-toggle')
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().allowedModels, [{ provider: 'p2', model: 'm1' }])
  assert.equal(writes.length, 0, 'Add route stages only')
  assert.match(strip(frame.join('\n')), /\[allowed\]/u)

  // Last route + candidate Enabled On refuses the remove action in the page;
  // the controller remains the final validator.
  page.handleInput(ESC)
  selectField(page, 'Enabled')
  page.handleInput(ENTER)
  page.render(80)
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  frame = page.render(80)
  plain = strip(frame.join('\n'))
  assert.match(plain, /> Shared Model/u)
  assert.match(plain, /Disable model selection before removing the last route\./u)
  assert.doesNotMatch(barLine(frame), /route \[Enter\]/u)
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'), false)
  page.handleInput(ENTER)
  assert.deepEqual(controller.snapshot().allowedModels, [{ provider: 'p2', model: 'm1' }], 'a blocked remove stages nothing')

  // Enabled Off permits removing the last route.
  page.handleInput(ESC)
  selectField(page, 'Enabled')
  page.handleInput(ENTER)
  page.render(80)
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  frame = page.render(80)
  assert.match(barLine(frame), /Remove route \[Enter\]/u)
  activateBar(page, 'bar:route-toggle')
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().allowedModels, [])
  assert.equal(controller.snapshot().issues.allowedModels, undefined, 'Off + empty routes is a legal draft')
  assert.equal(writes.length, 0)
})

test('directory search, no-match and return preserve the query and the selected route', async () => {
  const h = await started({
    directoryValue: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }, { id: 'n', name: 'Other N' }] }],
      failures: [],
    },
  })
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  page.render(80)
  page.handleInput('/')
  page.handleInput('other')
  let frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Search: other/u)
  assert.match(strip(frame.join('\n')), /Other N/u)
  assert.doesNotMatch(strip(frame.join('\n')), /Model M/u)
  page.handleInput(TAB)
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Search \[\/\]\s+other/u, 'Done/Tab keeps the query in the directory')
  page.handleInput(ESC)
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /> Allowed models/u, 'Back returns to the selected group field')
  page.handleInput(ENTER)
  await h.drainTasks()
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Search \[\/\]\s+other/u, 're-entering the directory keeps the query')
  page.handleInput('/')
  page.handleInput('\x15')
  page.handleInput('zzz')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /No matching models/u)
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'), false)
  assert.equal(controller.snapshot().allowedModels.length, 0)
})

test('a failed directory keeps saved routes visible and removable and never claims absence', async () => {
  const h = await started({
    allowedModels: [{ provider: 'missing-provider', model: 'saved-model' }],
    directoryError: new Error('directory offline'),
  })
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  let frame = page.render(80)
  let plain = strip(frame.join('\n'))
  assert.match(plain, /saved-model/u)
  assert.match(plain, /Saved route; the model directory is unavailable\./u)
  assert.match(plain, /Unavailable: Model directory: directory offline/u)
  assert.doesNotMatch(plain, /not listed in the current directory/u, 'a failed catalog never claims absence')
  assert.match(barLine(frame), /Remove route \[Enter\]/u)
  activateBar(page, 'bar:route-toggle')
  frame = page.render(80)
  assert.deepEqual(controller.snapshot().allowedModels, [])
  assert.equal(h.writes.length, 0)
})

test('a late catalog result after an authority replacement or dispose never publishes', async () => {
  const h = await started({
    holdDirectory: true,
    directoryValue: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }] }],
      failures: [],
    },
  })
  const { page } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.directoryStarted
  page.render(80)
  // The authority changes while the request is in flight: the page starts ONE
  // fresh read for the new identity and drops the old answer.
  h.replaceGeneration()
  page.render(80)
  await settleMicrotasks()
  assert.equal(h.directoryReadCount(), 2, 'the authority change starts exactly ONE fresh read')
  h.releaseDirectory()
  await settleMicrotasks()
  assert.match(strip(page.render(80).join('\n')), /Loading models…/u,
    'the stale first answer never publishes over the newer in-flight request')
  assert.doesNotMatch(strip(page.render(80).join('\n')), /Provider P/u)
  h.releaseDirectory()
  await settleMicrotasks()
  assert.match(strip(page.render(80).join('\n')), /Provider P/u, 'the current request publishes its real directory')

  const disposed = await started({ holdDirectory: true })
  disposed.page.focused = true
  selectField(disposed.page, 'Allowed models')
  disposed.page.handleInput(ENTER)
  await disposed.directoryStarted
  disposed.page.render(80)
  const renders = disposed.renderRequestCount()
  disposed.page.dispose()
  disposed.releaseDirectory()
  await settleMicrotasks()
  assert.equal(disposed.renderRequestCount(), renders, 'a late directory result never republishes a disposed page')
})

test('short and zero-body grants keep only the real safe actions', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  page.render(80)
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('0')
  page.render(80)
  activateBar(page, 'bar:apply')
  page.setMaxRows(8)
  let frame = page.render(44)
  assert.equal(frame.length, 8)
  assert.ok(frame.every(line => visibleWidth(line) <= 44))
  assert.match(barLine(frame), /Save \[S\]/u, '44x8 keeps the dirty Save complete')
  assert.match(barLine(frame), /Back \[Esc\]/u)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:save'))

  // The dirty leave question needs its necessary copy in ONE frame; a grant
  // that cannot show it publishes only Keep and refuses the shortcut.
  page.setMaxRows(3)
  page.handleInput(ESC)
  frame = page.render(44)
  assert.equal(frame.length, 3)
  assert.match(barLine(frame), /^Keep \[Esc\]/u)
  page.handleInput('d')
  assert.deepEqual(h.dones, [], 'a hidden leave answer is never keyboard-admitted')
  assert.equal(controller.snapshot().dirty, true)
  page.setMaxRows(8)
  frame = page.render(44)
  assert.match(barLine(frame), /Save · Discard and leave \[D\] · Keep \[Esc\]/u, 'a sufficient grant publishes the complete leave actions')
  page.handleInput('d')
  assert.deepEqual(h.dones, [1])
  assert.equal(controller.snapshot().dirty, false)
  assert.equal(h.writes.length, 0)
})

test('the local Discard and the dirty Refresh questions keep their own stay semantics', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  page.render(80)
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('2')
  page.render(80)
  activateBar(page, 'bar:apply')
  page.render(80)
  const refreshes = h.refreshCount()
  page.handleInput('d')
  let frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Discard unsaved changes\?/u)
  assert.match(barLine(frame), /Discard \[D\].*Keep \[Esc\]/u)
  page.handleInput('d')
  frame = page.render(80)
  assert.equal(controller.snapshot().dirty, false)
  assert.deepEqual(h.dones, [], 'a local Discard stays on the page')
  assert.equal(h.writes.length, 0)
  assert.equal(h.refreshCount(), refreshes)

  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('3')
  page.render(80)
  activateBar(page, 'bar:apply')
  page.render(80)
  page.handleInput('r')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Refresh discards unsaved edits\./u)
  assert.match(barLine(frame), /Refresh \[R\].*Keep \[Esc\]/u)
  page.handleInput('r')
  await h.drainTasks()
  frame = page.render(80)
  assert.equal(controller.snapshot().dirty, false)
  assert.equal(h.refreshCount(), refreshes + 2, 'the confirmed refresh re-reads both official sections')
  assert.equal(h.dones.length, 0, 'Refresh never leaves the group')
})

test('a pointer press released on another target or a newer authority dispatches nothing', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  page.setMaxRows(12)
  let frame = page.render(80)
  const parallelRow = rowIndex(frame, line => line.includes('Parallelism'))
  const enabledRow = rowIndex(frame, line => line.includes('Enabled'))
  assert.notEqual(parallelRow, -1)
  assert.notEqual(enabledRow, -1)
  assert.equal(page.handleMouse(mouse('press', 3, parallelRow, 80, frame.length))?.handled, true)
  assert.equal(page.handleMouse(mouse('click', 3, enabledRow, 80, frame.length)), undefined,
    'a release on another target is refused')
  assert.match(strip(page.render(80).join('\n')), /> Maximum depth/u, 'the press did not select Enabled')

  frame = page.render(80)
  // The grant-sized click after a terminal-sized duplicate is still ONE gesture.
  assert.equal(page.handleMouse(mouse('press', 3, enabledRow, 80, frame.length))?.handled, true)
  assert.equal(page.handleMouse(mouse('click', 3, enabledRow, 80, 40)), undefined)
  page.render(80)
  assert.equal(page.handleMouse(mouse('click', 3, enabledRow, 80, frame.length))?.handled, true)
  assert.match(strip(page.render(80).join('\n')), /> Enabled/u)

  // A Host replacement between a NEW press and its release revokes the target.
  frame = page.render(80)
  const freshEnabledRow = rowIndex(frame, line => line.includes('Enabled'))
  assert.notEqual(freshEnabledRow, -1)
  assert.equal(page.handleMouse(mouse('press', 3, freshEnabledRow, 80, frame.length))?.handled, true)
  h.replaceGeneration()
  assert.equal(page.handleMouse(mouse('click', 3, freshEnabledRow, 80, frame.length)), undefined,
    'a Host replacement between press and release revokes the painted target')
  assert.equal(controller.snapshot().limits.current, false)
  assert.equal(controller.snapshot().dirty, false)
})

test('CJK directory rows stay cell-accurate and toggle only by their painted route identity', async () => {
  const h = await started({
    directoryValue: {
      default: { provider: '提供者', model: '模型甲' },
      routableProviders: ['提供者'],
      groups: [{ id: '提供者', name: '模型服务商', models: [{ id: '模型甲', name: '模型甲' }] }],
      failures: [],
    },
  })
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  let frame: string[] = []
  for (const width of [200, 120, 100, 80, 72, 44]) {
    frame = page.render(width)
    assert.ok(frame.every(line => visibleWidth(line) <= width), `${width}: every row fits its cells`)
    assert.match(barLine(frame), /Back \[Esc\]/u)
  }
  const routeRow = rowIndex(frame, line => line.includes('模型甲'))
  assert.notEqual(routeRow, -1)
  clickRow(page, frame, routeRow, 44, '模型甲')
  frame = page.render(44)
  assert.deepEqual(controller.snapshot().allowedModels, [], 'a row click never toggles')
  activateBar(page, 'bar:route-toggle')
  assert.deepEqual(controller.snapshot().allowedModels, [{ provider: '提供者', model: '模型甲' }])
})


test('a canonical value is shown when the raw text cannot fit, and an out-of-range value stays refused in the Input', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  page.render(80)
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  for (const character of '0'.repeat(24) + '2') page.handleInput(character)
  let frame = page.render(30)
  assert.match(strip(frame.join('\n')), /Value sends\s+2/u, 'the sent canonical stays readable when the raw text cannot')
  assert.match(barLine(frame), /Stage \[Enter\]/u)
  activateBar(page, 'bar:apply')
  frame = page.render(30)
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'set', value: 2 })

  // An out-of-range value keeps the real Stage so its own error is reported;
  // the Stage refuses it, the Input stays and the prior patch survives.
  page.render(80)
  frame = page.render(80)
  activateBar(page, 'bar:edit')
  page.render(30)
  page.handleInput('\x15')
  for (const character of '9'.repeat(40)) page.handleInput(character)
  frame = page.render(30)
  assert.match(barLine(frame), /Stage \[Enter\]/u, 'the real Stage stays reachable')
  activateBar(page, 'bar:apply')
  frame = page.render(30)
  assert.match(strip(frame.join('\n')), /Enter a safe integer from 0 to/u)
  assert.match(strip(frame.join('\n')), /Edit Maximum recursion depth/u, 'the refused Stage stays in the Input')
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'set', value: 2 }, 'the prior patch is untouched')
})

test('an unknown outcome asks Leave anyway and offers neither an ordinary Discard nor a new Save', async () => {
  const h = await started({ lostAckLimits: true })
  const { page, controller, writes } = h
  page.focused = true
  page.render(80)
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('2')
  page.render(80)
  activateBar(page, 'bar:apply')
  page.render(80)
  activateBar(page, 'bar:save')
  await h.drainTasks()
  let frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Limits: Could not confirm save/u)
  assert.equal(controller.snapshot().limits.dirty, true)
  assert.equal(writes.length, 1)
  assert.doesNotMatch(barLine(frame), /Save \[S\]|Discard \[D\]/u, 'a settled unknown offers no new Save or ordinary Discard')
  assert.match(barLine(frame), /Refresh \[R\]/u)

  page.handleInput(ESC)
  frame = page.render(80)
  const plain = strip(frame.join('\n'))
  assert.match(plain, /The Host may have applied changes\./u)
  assert.match(plain, /Leaving does not undo them\./u)
  assert.match(barLine(frame), /Leave anyway \[D\].*Keep \[Esc\]/u)
  assert.doesNotMatch(barLine(frame), /Discard and leave/u, 'an unknown leave never wears the definite discard label')
  page.handleInput('d')
  await settleMicrotasks()
  assert.deepEqual(h.dones, [1])
  assert.equal(writes.length, 1, 'acknowledging the unknown leave never replays the write')
})

test('a same-authority resize reuses the existing directory result without a new read', async () => {
  const h = await started({
    directoryValue: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider One', models: [{ id: 'm', name: 'Model One' }] }],
      failures: [],
    },
  })
  const { page } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  page.render(80)
  const reads = h.directoryReadCount()
  page.setMaxRows(8)
  page.render(100)
  page.setMaxRows(12)
  page.render(80)
  assert.equal(h.directoryReadCount(), reads, 'a same-authority resize/search/scroll only reprojects')
  assert.match(strip(page.render(80).join('\n')), /Provider One/u)
})

test('a width-only repaint revokes a press even at identical cells, and a fresh gesture works', async () => {
  const h = await started()
  const { page } = h
  page.focused = true
  let frame = page.render(80)
  const parallelRow = rowIndex(frame, line => line.includes('Parallelism'))
  assert.notEqual(parallelRow, -1)
  assert.equal(page.handleMouse(mouse('press', 3, parallelRow, 80, frame.length))?.handled, true)
  const grown = page.render(100)
  assert.equal(page.handleMouse(mouse('click', 3, parallelRow, 100, grown.length)), undefined,
    'the press-frame width no longer matches the painted frame')
  assert.match(strip(page.render(100).join('\n')), /> Maximum depth/u)
  const freshRow = rowIndex(grown, line => line.includes('Parallelism'))
  assert.equal(page.handleMouse(mouse('press', 3, freshRow, 100, grown.length))?.handled, true)
  page.render(100)
  assert.equal(page.handleMouse(mouse('click', 3, freshRow, 100, grown.length))?.handled, true)
  assert.match(strip(page.render(100).join('\n')), /> Parallelism/u)
})

test('a directory action is withheld until the complete selected route identity is readable', async () => {
  const provider = 'provider-with-a-very-long-identity'
  const model = 'model-with-a-very-long-identity'
  const h = await started({
    directoryValue: {
      default: { provider, model },
      routableProviders: [provider],
      groups: [{ id: provider, name: 'Long Provider', models: [{ id: model, name: 'Long Model' }] }],
      failures: [],
    },
  })
  const { page, controller, writes } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  page.setMaxRows(4) // 3 body rows: the complete route detail cannot fit
  let frame = page.render(44)
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'), false)
  assert.doesNotMatch(strip(frame.join('\n')), /Add route \[Enter\]/u, 'the unreadable action text is withdrawn too')
  page.handleInput(ENTER)
  assert.deepEqual(controller.snapshot().allowedModels, [], 'Enter cannot toggle an unreadable route')

  page.setMaxRows(6) // 5 body rows: the complete selected detail fits
  frame = page.render(44)
  assert.match(strip(frame.join('\n')), new RegExp(`${provider} /\\s+${model}`, 'u'))
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'), 'the complete identity admits the action')
  activateBar(page, 'bar:route-toggle')
  assert.deepEqual(controller.snapshot().allowedModels, [{ provider, model }])
  assert.equal(writes.length, 0)
})

test('the Allowed models Advanced lists complete effective and staged route identities', async () => {
  const h = await started({
    allowedModels: [{ provider: 'alpha', model: 'fast' }],
    directoryValue: {
      default: { provider: 'alpha', model: 'fast' },
      routableProviders: ['alpha', 'beta'],
      groups: [
        { id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] },
        { id: 'beta', name: 'Beta', models: [{ id: 'slow', name: 'Slow' }] },
      ],
      failures: [],
    },
  })
  const { page, controller } = h
  page.focused = true
  page.setMaxRows(16)
  selectField(page, 'Allowed models')
  page.handleInput('?')
  let frame = page.render(80)
  let plain = strip(frame.join('\n'))
  assert.match(plain, /Effective routes/u)
  assert.match(plain, /alpha \/ fast/u)
  assert.match(plain, /Inherited/u)
  page.handleInput('?')
  page.render(80)
  page.handleInput(ENTER) // Manage
  await h.drainTasks()
  page.render(80)
  page.handleInput(DOWN) // Beta / Slow
  page.render(80)
  activateBar(page, 'bar:route-toggle')
  page.render(80)
  page.handleInput(ESC) // back to the group
  page.render(80)
  page.handleInput('?')
  frame = page.render(80)
  plain = strip(frame.join('\n'))
  assert.match(plain, /Staged routes/u)
  assert.match(plain, /alpha \/ fast/u)
  assert.match(plain, /beta \/ slow/u)
  assert.deepEqual(controller.snapshot().allowedModels, [{ provider: 'alpha', model: 'fast' }, { provider: 'beta', model: 'slow' }])
})

// ── FR5-B: the shared host numeric page ──────────────────────────────────

interface NumericShellSettings {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

const positiveFiniteText = (text: string): boolean => {
  if (text.trim() === '') return false
  const value = Number(text)
  return Number.isFinite(value) && value > 0
}

function numericShellRig(options: { holdMutation?: boolean; reject?: boolean; unconfirmed?: boolean; effectiveTimeout?: number } = {}) {
  const generation = {}
  let revision = 1
  let effective: NumericShellSettings = { timeoutMs: options.effectiveTimeout ?? 60_000, maxOutputBytes: 64_000 }
  const inherited: NumericShellSettings = { timeoutMs: 120_000, maxOutputBytes: 64_000 }
  const writes: { patch: SectionPatch<NumericShellSettings>; revision: number; generation: object }[] = []
  let releaseMutation: (() => void) | undefined
  let mutationStarted!: () => void
  const started = new Promise<void>(resolve => { mutationStarted = resolve })
  const port: HostNumericSettingsPort<NumericShellSettings> = {
    read: () => ({
      kind: 'ready', generation, revision, effective: { ...effective }, inherited: { ...inherited },
      overridden: {
        timeoutMs: effective.timeoutMs !== inherited.timeoutMs,
        maxOutputBytes: effective.maxOutputBytes !== inherited.maxOutputBytes,
      },
    }),
    refresh: async () => {},
    mutate: async (patch, expectedRevision, expectedGeneration) => {
      // The ATTEMPTED batch: a refused Save is recorded too, so a case can
      // prove "no admission" (zero entries) separately from "admitted once".
      writes.push({ patch, revision: expectedRevision, generation: expectedGeneration })
      if (options.reject === true) return { kind: 'rejected', reason: 'official validator refused the caps' }
      if (expectedRevision !== revision || expectedGeneration !== generation) return { kind: 'conflict', reason: 'revision changed' }
      if (options.unconfirmed === true) {
        // The Host may have applied it: the readback is a NEWER row with the
        // requested caps, but the Client never received an accepted answer.
        const next = { ...effective }
        for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
          const edit = patch[field]
          if (edit === undefined) continue
          next[field] = edit.kind === 'reset' ? inherited[field] : edit.value
        }
        effective = next
        revision += 1
        return { kind: 'outcome-unconfirmed', reason: 'connection dropped after dispatch' }
      }
      if (options.holdMutation === true) {
        mutationStarted()
        await new Promise<void>(resolve => { releaseMutation = resolve })
      }
      const next = { ...effective }
      for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
        const edit = patch[field]
        if (edit === undefined) continue
        next[field] = edit.kind === 'reset' ? inherited[field] : edit.value
      }
      effective = next
      revision += 1
      return { kind: 'accepted' }
    },
  }
  const fields: readonly HostNumericSettingsField<NumericShellSettings>[] = [
    { key: 'timeoutMs', label: 'Command timeout (ms)', unit: 'ms', validate: positiveFiniteText, invalidHint: 'Enter a positive finite number.' },
    { key: 'maxOutputBytes', label: 'Output cap per stream (bytes)', unit: 'bytes', validate: positiveFiniteText, invalidHint: 'Enter a positive finite number.' },
  ]
  return {
    port, fields, writes, inherited,
    effective: () => ({ ...effective }),
    advanceRevision: () => { revision += 1 },
    releaseMutation: () => { releaseMutation?.() },
    mutationStarted: started,
  }
}

function numericRig(options: { holdMutation?: boolean; reject?: boolean; unconfirmed?: boolean; effectiveTimeout?: number; onRender?: () => void } = {}) {
  const shell = numericShellRig(options)
  const actions: string[] = []
  const tasks: Promise<void>[] = []
  const controller = new HostNumericSettingsController<NumericShellSettings>({
    port: shell.port,
    fields: shell.fields,
    requestRender: () => { options.onRender?.() },
    runOwned: (_label, task) => { tasks.push(Promise.resolve().then(task)) },
  })
  const page = new HostNumericSettingsPage<NumericShellSettings>({
    controller,
    fields: shell.fields,
    spec: {
      title: 'Shell execution',
      commitMode: 'grouped',
      sourceHeading: source => source.kind === 'ready'
        ? 'Host model-tool executor · POSIX Bash'
        : 'Host model-tool executor · unavailable',
      help: ['The caps belong to the Host-served executor row; the Host chooses the executor, not this client.'],
      effect: 'New shell executions use the caps; a running subprocess keeps its current timeout.',
      scope: 'DSH Host profile · Host-served model-tool shell executor',
    },
    requestRender: () => {},
    done: () => { actions.push('done') },
  })
  return {
    page, controller, writes: shell.writes, actions,
    inherited: shell.inherited,
    effective: shell.effective,
    advanceRevision: shell.advanceRevision,
    releaseMutation: shell.releaseMutation,
    mutationStarted: shell.mutationStarted,
    drain: async () => {
      for (let turn = 0; turn < 12; turn += 1) {
        const pending = tasks.splice(0)
        if (pending.length === 0) return
        await Promise.all(pending)
      }
    },
  }
}

async function startedNumeric(options: { holdMutation?: boolean; reject?: boolean; unconfirmed?: boolean; effectiveTimeout?: number; onRender?: () => void } = {}) {
  const harness = numericRig(options)
  harness.page.setMaxRows(12)
  harness.page.focused = true
  await harness.drain()
  return harness
}

function numericRowIndex(frame: readonly string[], needle: string): number {
  return frame.findIndex(line => strip(line).includes(needle))
}

function clickNumericRow(page: HostNumericSettingsPage<NumericShellSettings>, frame: readonly string[], row: number, width: number, text: string): void {
  const line = strip(frame[row] ?? '')
  const start = line.indexOf(text)
  assert.notEqual(start, -1, `painted row contains ${text}: ${JSON.stringify(line)}`)
  const x = visibleWidth(line.slice(0, start))
  assert.equal(page.handleMouse(mouse('press', x, row, width, frame.length))?.handled, true)
  page.render(width)
  assert.equal(page.handleMouse(mouse('click', x, row, width, frame.length))?.handled, true)
}

function stageNumeric(page: HostNumericSettingsPage<NumericShellSettings>, width: number, clear: string, value: string): void {
  page.handleInput(ENTER)
  page.render(width)
  page.handleInput(clear)
  for (const character of value) page.handleInput(character)
  page.render(width)
  page.handleInput(ENTER)
  page.render(width)
}

function scrollGroupedUntil(page: HostNumericSettingsPage<NumericShellSettings>, width: number, needle: string, limit = 60): string[] {
  let frame = page.render(width)
  let plain = frame.map(strip).join('\n')
  for (let step = 0; step < limit && !plain.includes(needle); step += 1) {
    page.handleInput(DOWN)
    frame = page.render(width)
    plain = frame.map(strip).join('\n')
  }
  return frame
}

const UP = '\x1b[A'
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'

test('the grouped Shell tenant browses both fields and opens the editor only on an explicit Edit', async () => {
  const h = await startedNumeric()
  let frame = h.page.render(80)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /Host model-tool executor · POSIX Bash/u, 'the real source fact heads the group')
  assert.match(plain, /^> Command timeout \(ms\)\s+60000 ms\s*$/mu, 'the FIRST field is selected with its canonical value and unit')
  assert.match(plain, /^ {2}Output cap per stream \(bytes\)\s+64000 bytes\s*$/mu, 'the second field is painted with its unit')
  assert.doesNotMatch(plain, /Value:/u, 'entering the group never opens the raw Input')
  const bar = strip(frame.at(-1) ?? '')
  assert.match(bar, /Edit \[Enter\] · Details \[\?\] · Refresh \[R\] · Back \[Esc\]/u)
  assert.match(plain, /Changes are staged until Save\./u)
  assert.match(plain, /New shell executions use the caps; a running subprocess keeps its\s+current timeout\./u)
  assert.doesNotMatch(plain, /Status: Ready/u, 'a clean group paints no permanent Ready banner')

  // A field row click only SELECTS; the editor needs the explicit Edit route.
  frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Output cap per stream (bytes)'), 80, 'Output cap per stream (bytes)')
  frame = h.page.render(80)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Output cap per stream \(bytes\)\s+64000 bytes\s*$/mu, 'the clicked field is only selected')
  assert.doesNotMatch(plain, /Value:|Edit Output cap/u, 'a field click never starts the editor')

  // Up/Down clamp at the boundaries; Tab/Shift+Tab wrap across the two fields.
  h.page.handleInput(DOWN)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Output cap per stream \(bytes\)/mu, 'Down at the last field clamps')
  h.page.handleInput(TAB)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Command timeout \(ms\)/mu, 'Tab wraps to the first field')
  h.page.handleInput(SHIFT_TAB)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Output cap per stream \(bytes\)/mu, 'Shift+Tab wraps backwards')
  h.page.handleInput(UP)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Command timeout \(ms\)/mu, 'Up walks to the previous field')
  h.page.handleInput(UP)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Command timeout \(ms\)/mu, 'Up at the first field clamps')

  // The explicit Enter/Edit opens the CURRENT field's Input, and Cancel keeps
  // the browse (and any draft) untouched.
  h.page.handleInput(ENTER)
  h.page.render(80)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /Edit Command timeout \(ms\)/u)
  assert.match(plain, /Current value\s+60000 ms/u, 'the editor paints the real current value and unit')
  assert.match(plain, /Value: 60000/u)
  assert.match(plain, /Stage \[Enter\] · Cancel \[Esc\]/u)
  h.page.handleInput(ESC)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Command timeout \(ms\)/mu, 'Cancel returns to the browse')
  assert.ok(h.page.paintedBarSpans().some(span => span.id === 'bar:edit'))
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('a grouped Stage keeps the draft local and ONE Save dispatches the whole patch', async () => {
  const h = await startedNumeric()
  h.page.handleInput(ENTER) // explicit Edit on the first field
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  let frame = h.page.render(80)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Command timeout \(ms\)\s+45000 ms\s*$/mu, 'the staged candidate is painted for the selected field')
  assert.match(plain, /Current: 60000 ms · Unsaved/u, 'the served Current stays distinguishable from the draft')
  assert.match(plain, /1 unsaved change · Shell execution/u)
  assert.equal(h.writes.length, 0, 'Stage never dispatches a Host write')
  assert.ok(h.page.paintedBarSpans().some(span => span.id === 'bar:save'))

  // The SECOND field is staged the same way; the count comes from the patch.
  h.page.handleInput(DOWN)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '128000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  frame = h.page.render(80)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Output cap per stream \(bytes\)\s+128000 bytes\s*$/mu)
  assert.match(plain, /Current: 64000 bytes · Unsaved/u)
  assert.match(plain, /2 unsaved changes · Shell execution/u)
  assert.match(plain, /Save \[S\]/u)
  assert.equal(h.writes.length, 0, 'two local stages still write nothing')

  const before = h.page.paintedBarSpans().find(span => span.id === 'bar:save')
  assert.ok(before !== undefined)
  h.page.activateBarSpan('bar:save')
  await h.drain()
  assert.equal(h.writes.length, 1, 'ONE Save is exactly ONE Host mutation')
  assert.deepEqual(h.writes[0]?.patch, {
    timeoutMs: { kind: 'set', value: 45_000 },
    maxOutputBytes: { kind: 'set', value: 128_000 },
  })
  assert.equal(h.writes[0]?.revision, 1, 'the captured revision fences the batch')
  assert.deepEqual(h.effective(), { timeoutMs: 45_000, maxOutputBytes: 128_000 })
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /^Saved\s*$/mu)
  assert.match(plain, /^> Output cap per stream \(bytes\)/mu, 'the SAME group stays mounted with its field selection')
  assert.doesNotMatch(plain, /Save \[S\]|unsaved change/u, 'a verified group advertises no second Save')
  assert.deepEqual(h.actions, [], 'Save never navigates by itself')
  h.page.dispose()
})

test('a saved numeric group demotes to Last-known when the served row moves', async () => {
  const h = await startedNumeric()
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER) // stage only
  h.page.render(80)
  h.page.activateBarSpan('bar:save')
  await h.drain()
  assert.match(h.page.render(80).map(strip).join('\n'), /^Saved\s*$/mu, 'the verified save starts as a current Saved')

  h.advanceRevision()
  const plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /^Last-known · read-only\s*$/mu, 'a stale verified settlement is no longer painted as Saved')
  assert.match(plain, /Previous save completed; refresh to review\./u, 'the history is named as history')
  assert.doesNotMatch(plain, /^Saved\s*$/mu)
  h.page.dispose()
})

test('the grouped Stage is a real stage: empty/invalid text keeps its error and the other draft, zero writes', async () => {
  const h = await startedNumeric()
  // Stage the SECOND field first: no later invalid draft may touch it.
  h.page.handleInput(DOWN)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '128000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  h.page.render(80)

  h.page.handleInput(UP)
  for (const [text, reason] of [
    ['', /Value is required\./u],
    ['   ', /Value is required\./u],
    ['0', /Enter a positive finite number\./u],
    ['-1', /Enter a positive finite number\./u],
    ['NaN', /Enter a positive finite number\./u],
    ['Infinity', /Enter a positive finite number\./u],
    ['12garbage', /Enter a positive finite number\./u],
  ] as const) {
    h.page.handleInput(ENTER)
    h.page.render(80)
    h.page.handleInput('\x15')
    for (const character of text) h.page.handleInput(character)
    h.page.render(80)
    h.page.handleInput(ENTER)
    const plain = h.page.render(80).map(strip).join('\n')
    assert.match(plain, reason, `${JSON.stringify(text)} keeps the real field error`)
    assert.match(plain, /Value:\s*/u, 'the raw Input stays open (no implicit Reset)')
    assert.deepEqual(h.writes, [], `${JSON.stringify(text)} never dispatches`)
    h.page.handleInput(ESC) // Cancel the refused Input (the staged field stays)
    assert.match(h.page.render(80).map(strip).join('\n'), /Output cap per stream \(bytes\)\s+128000 bytes/u,
      'the other staged field is preserved')
  }

  // The official positive-finite shapes stage as their canonical numbers.
  for (const [text, canonical] of [['1.5', '1.5'], ['1e3', '1000']] as const) {
    h.page.handleInput(ENTER)
    h.page.render(80)
    h.page.handleInput('\x15')
    for (const character of text) h.page.handleInput(character)
    h.page.render(80)
    h.page.handleInput(ENTER)
    assert.match(h.page.render(80).map(strip).join('\n'), new RegExp(`> Command timeout \\(ms\\)\\s+${canonical.replace('.', '\\.')} ms`, 'u'))
  }
  // A normal stage equal to the SERVED value removes only this field's patch:
  // with the other field still dirty the group never claims "no changes".
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '60000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  let plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /1 unsaved change · Shell execution/u, 'the other field stays dirty')
  assert.doesNotMatch(plain, /No changes/u, 'a partially clean group never claims the whole group is clean')
  // Removing the LAST staged value is a real no-op with the honest feedback.
  h.page.handleInput(DOWN)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '64000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /No changes/u)
  assert.doesNotMatch(plain, /unsaved change|Save \[S\]/u, 'the empty patch hides the count and Save')
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('the grouped Advanced stages the SELECTED field reset without a confirmation and without a write', async () => {
  const h = await startedNumeric()
  h.page.handleInput(DOWN) // the SECOND field
  h.page.handleInput('?')
  let plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /Output cap per stream \(bytes\)/u)
  assert.match(plain, /Effective\s+64000 bytes/u)
  assert.match(plain, /Inherited\s+64000 bytes/u, 'the inherited value is the served one')
  assert.match(plain, /Comparison\s+Matches base/u, 'effective==inherited is not a fake dirty fact')
  assert.match(plain, /Revision\s+\d+/u)
  assert.match(plain, /Scope\s+DSH Host profile/u)
  assert.match(plain, /Reset stages the official unset\./u, 'the identity/unset receipt is at the top')
  assert.match(plain, /Changes are staged until Save\./u)
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Reset \[X\](?: · Up\/Down scroll)? · Back \[Esc\]/u)
  assert.equal(h.writes.length, 0, 'opening Advanced never writes')
  // The short disclosure is scrollable: End reveals the remaining copy and the
  // explicit Reset action, which is what the reset admission reads.
  h.page.handleInput(END)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /The USER patch may retain the inherited value\./u)
  assert.match(plain, /The Host readback decides the value\./u)
  assert.match(plain, /Reset to inherited…/u)

  h.page.handleInput('x')
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /^> Output cap per stream \(bytes\)\s+Reset staged\s*$/mu, 'the selected field stages the official unset')
  assert.match(plain, /Current: 64000 bytes · Unsaved/u, 'Reset staged is NOT the inherited value')
  assert.match(plain, /1 unsaved change · Shell execution/u, 'an equal-valued Reset is still a real dirty intent')
  assert.equal(h.writes.length, 0, 'Reset staging never dispatches')

  // Cancel keeps the staged Reset; a normal Stage on another field keeps it too.
  h.page.handleInput(UP)
  h.page.handleInput(ENTER)
  h.page.render(80)
  assert.match(h.page.render(80).map(strip).join('\n'), /Value: 60000/u, 'a staged Reset stages an EMPTY raw text, not an implicit reuse')
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /2 unsaved changes · Shell execution/u)

  // ONE Save sends the mixed set + unset batch.
  h.page.handleInput('s')
  await h.drain()
  assert.deepEqual(h.writes[0]?.patch, {
    timeoutMs: { kind: 'set', value: 45_000 },
    maxOutputBytes: { kind: 'reset' },
  }, 'the batch carries the set and the selected-field reset together')
  assert.equal(h.writes.length, 1)
  assert.match(h.page.render(80).map(strip).join('\n'), /^Saved\s*$/mu)
  assert.deepEqual(h.effective(), { timeoutMs: 45_000, maxOutputBytes: 64_000 }, 'the Host readback decides the reset value')
  h.page.dispose()
})

test('the grouped dirty leave question offers Save, Discard and leave and Keep; Save stays on the page', async () => {
  const h = await startedNumeric()
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput(ESC)
  let plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /1 unsaved change · Shell execution/u)
  assert.match(plain, /Save keeps you here\./u)
  assert.match(plain, /Discard and leave loses staged values\./u)
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Save \[S\] · Discard and leave \[D\] · Keep \[Esc\]/u)

  // Keep returns to the browse with the draft.
  h.page.handleInput(ESC)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /^> Command timeout \(ms\)\s+45000 ms\s*$/mu)
  assert.deepEqual(h.actions, [], 'Keep stays on the page')

  // Esc -> question -> Save saves and STAYS (never chases the leave target).
  h.page.handleInput(ESC)
  h.page.render(80)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.actions, [], 'Save from the leave question stays in the group')
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /^Saved\s*$/mu)
  assert.doesNotMatch(plain, /Discard and leave/u, 'the retired question never comes back')

  // A fresh dirty draft leaves only through the explicit Discard and leave.
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '7') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput(ESC)
  h.page.render(80)
  h.page.handleInput('d')
  assert.deepEqual(h.actions, ['done'], 'Discard and leave closes the group')
  assert.equal(h.writes.length, 1, 'leaving never writes')
  h.page.dispose()
})

test('the grouped local Discard stays and the Refresh question keeps the draft until confirmed', async () => {
  const h = await startedNumeric()
  const stage = (text: string): void => {
    h.page.handleInput(ENTER)
    h.page.render(80)
    h.page.handleInput('\x15')
    for (const character of text) h.page.handleInput(character)
    h.page.render(80)
    h.page.handleInput(ENTER)
    h.page.render(80)
  }
  stage('45000')
  h.page.handleInput('d')
  let plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /Discard unsaved changes\?/u)
  assert.match(plain, /Staged values are lost; nothing is written\./u)
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Discard \[D\] · Keep \[Esc\]/u)
  h.page.handleInput(ESC)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /1 unsaved change · Shell execution/u, 'Keep preserves the draft')
  h.page.handleInput('d')
  h.page.render(80)
  h.page.handleInput('d')
  plain = h.page.render(80).map(strip).join('\n')
  assert.doesNotMatch(plain, /unsaved change|Discard unsaved/u, 'the local discard cleared the patch')
  assert.deepEqual(h.actions, [], 'a local discard never leaves the group')
  assert.deepEqual(h.writes, [])

  stage('45000')
  h.page.handleInput('r')
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /Refresh discards unsaved edits\./u)
  assert.match(plain, /The staged values are lost\./u)
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Refresh \[R\] · Keep \[Esc\]/u)
  h.page.handleInput(ESC)
  assert.match(h.page.render(80).map(strip).join('\n'), /1 unsaved change · Shell execution/u, 'Keep preserves the draft')
  h.page.handleInput('r')
  h.page.render(80)
  h.page.handleInput('r')
  await h.drain()
  plain = h.page.render(80).map(strip).join('\n')
  assert.doesNotMatch(plain, /unsaved change/u, 'the confirmed refresh discards the draft')
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.actions, [], 'Refresh never leaves the group')
  h.page.dispose()
})

test('the grouped Save is admitted only through its really painted span', async () => {
  const h = await startedNumeric()
  stageNumeric(h.page, 80, '\x15', '45000')
  assert.equal(h.writes.length, 0, 'the stage is local')

  // 14 cells cannot host `Save [S] · Back [Esc]`: Save is dropped WHOLE and its
  // shortcut is inert; Back remains the only complete action.
  const frame = h.page.render(14)
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Save \[S\]/u, 'Save is not painted at this width')
  assert.match(strip(frame.at(-1) ?? ''), /Back \[Esc\]/u)
  h.page.handleInput('s')
  await h.drain()
  assert.deepEqual(h.writes, [], 'a dropped Save is never keyboard-admitted')

  // A complete bar admits it again.
  h.page.render(80)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1)
  h.page.dispose()
})

test('a pending grouped save blocks the exit and never repaints a closed page', async () => {
  let renders = 0
  const h = await startedNumeric({ holdMutation: true, onRender: () => { renders += 1 } })
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('s')
  await h.mutationStarted
  h.page.handleInput(ESC)
  assert.deepEqual(h.actions, [], 'the page cannot close while the Host write is unsettled')
  assert.match(h.page.render(80).map(strip).join('\n'), /Saving…/u)
  assert.match(h.page.render(80).map(strip).join('\n'), /Dispatched writes continue\./u)
  h.page.dispose()
  const rendersAtRetirement = renders
  h.releaseMutation()
  await h.drain()
  assert.deepEqual(h.actions, [], 'the disposed page stays closed')
  assert.equal(h.writes.length, 1, 'the admitted batch is still dispatched exactly once')
  assert.deepEqual(h.writes[0]?.patch, { timeoutMs: { kind: 'set', value: 45_000 } })
  assert.equal(h.effective().timeoutMs, 45_000, 'the owned write still settles the real effective sink')
  assert.equal(renders, rendersAtRetirement, 'the retired page never publishes a late frame')
  assert.equal(h.page.render(80).map(strip).join('').trim(), '', 'the retired page paints nothing')
})

test('a stale grouped pointer press cannot open an editor on a newer painted frame', async () => {
  const h = await startedNumeric()
  const frame = h.page.render(80)
  const row = numericRowIndex(frame, 'Command timeout (ms)')
  assert.equal(h.page.handleMouse(mouse('press', 1, row, 80, frame.length))?.handled, true)
  h.page.handleInput(DOWN) // a repaint with a new semantic identity
  const next = h.page.render(80)
  assert.equal(h.page.handleMouse(mouse('click', 1, row, 80, next.length)), undefined)
  assert.doesNotMatch(h.page.render(80).map(strip)[0] ?? '', /Edit Command timeout/u)
  // The stale release never re-selected the pressed field; the explicit DOWN
  // selection stands, and a FRESH click selects the other field.
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Output cap per stream \(bytes\)/mu,
    'the stale release never moved the selection')
  const fresh = h.page.render(80)
  const firstRow = numericRowIndex(fresh, 'Command timeout (ms)')
  clickNumericRow(h.page, fresh, firstRow, 80, 'Command timeout (ms)')
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Command timeout \(ms\)/mu,
    'a fresh click selects the first field')
  h.page.dispose()
})

test('a dropped grouped Stage span denies Enter, keeps the raw Input and the prior patch', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(30)
  stageNumeric(h.page, 80, '\x15', '45000') // a real prior patch
  assert.equal(h.writes.length, 0)
  h.page.handleInput(DOWN)
  h.page.render(80)
  h.page.handleInput(ENTER) // Edit the second field
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '5') h.page.handleInput(character)
  h.page.render(80)
  let frame = h.page.render(24) // too narrow for `Stage [Enter] · Cancel [Esc]`
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u, 'the Stage span is dropped WHOLE')
  h.page.handleInput(ENTER)
  frame = h.page.render(24)
  assert.match(frame.map(strip).join('\n'), /Value: 5/u, 'the denied Enter keeps the raw Input')
  assert.match(strip(frame.at(-1) ?? ''), /Cancel \[Esc\]/u)
  // The prior patch is intact; the restored grant admits a FRESH Stage.
  frame = h.page.render(80)
  assert.match(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u)
  h.page.handleInput(ENTER)
  frame = h.page.render(80)
  assert.match(frame.map(strip).join('\n'), /2 unsaved changes/u, 'the prior draft was retained, the new Stage lands')
  h.page.dispose()
})

test('a pending grouped Save refuses duplicate Save, parent/exit and Refresh', async () => {
  const h = await startedNumeric({ holdMutation: true })
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.handleInput('s')
  await h.mutationStarted
  h.page.handleInput('s') // duplicate
  h.page.handleInput('\x1b') // exit intent
  h.page.handleInput('r') // refresh intent
  h.page.handleInput('d') // discard intent
  h.page.handleInput('\r')
  const frame = h.page.render(80)
  const plain = frame.map(strip).join('\n')
  assert.match(plain, /Saving…/u)
  assert.match(plain, /Dispatched writes continue\./u)
  assert.equal(h.writes.length, 1, 'a pending save never dispatches twice')
  assert.deepEqual(h.actions, [], 'no exit, refresh or discard is admitted while pending')
  assert.doesNotMatch(plain, /Discard unsaved changes\?/u)
  assert.match(strip(frame.at(-1) ?? ''), /Saving… · Wait \[Esc\]/u)
  h.releaseMutation()
  await h.drain()
  assert.match(h.page.render(80).map(strip).join('\n'), /^Saved\s*$/mu, 'the admitted batch still settles')
  assert.equal(h.writes.length, 1)
  h.page.dispose()
})

test('the grouped browse stays truthful when the section is unavailable, unreadable or last-known', async () => {
  interface SectionSettings {
    readonly timeoutMs: number
  }
  const fields: readonly HostNumericSettingsField<SectionSettings>[] = [{ key: 'timeoutMs', label: 'Command timeout (ms)', unit: 'ms' }]
  const renderWith = async (read: () => SectionRead<SectionSettings>, heading: (source: SectionRead<SectionSettings>) => string): Promise<string> => {
    const controller = new HostNumericSettingsController<SectionSettings>({
      port: { read, refresh: async () => {}, mutate: async () => ({ kind: 'rejected', reason: 'n/a' }) },
      fields,
      requestRender: () => {},
      runOwned: (_label, task) => { void task() },
    })
    const page = new HostNumericSettingsPage<SectionSettings>({
      controller,
      fields,
      spec: { title: 'Test', commitMode: 'grouped', sourceHeading: heading, help: [] },
      requestRender: () => {},
      done: () => {},
    })
    page.setMaxRows(8)
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    const text = page.render(80).map(strip).join('\n')
    page.dispose()
    return text
  }
  const unavailable = await renderWith(
    () => ({ kind: 'unavailable', reason: 'not mounted' }),
    source => source.kind === 'ready' ? 'Host model-tool executor · POSIX Bash' : 'Host model-tool executor · unavailable',
  )
  assert.match(unavailable, /Host model-tool executor · unavailable/u)
  assert.match(unavailable, /not mounted/u, 'the real reason is stated')
  assert.match(unavailable, /Refresh \[R\] · Back \[Esc\]/u, 'read-only keeps the explicit refresh')
  assert.doesNotMatch(unavailable, /Edit \[Enter\]|Details \[\?\]/u, 'an unavailable group never advertises an editor')

  const unreadable = await renderWith(
    () => ({ kind: 'unreadable', reason: 'value is not readable' }),
    source => source.kind === 'ready' ? 'Host model-tool executor · POSIX Bash' : 'Host model-tool executor · unreadable',
  )
  assert.match(unreadable, /Host model-tool executor · unreadable/u)
  assert.match(unreadable, /value is not readable/u)

  const generation = {}
  let revision = 1
  const live = (): SectionRead<SectionSettings> => ({
    kind: 'ready', generation, revision,
    effective: { timeoutMs: 60_000 }, inherited: { timeoutMs: 60_000 },
    overridden: { timeoutMs: false },
  })
  const controller = new HostNumericSettingsController<SectionSettings>({
    port: { read: live, refresh: async () => {}, mutate: async () => ({ kind: 'rejected', reason: 'n/a' }) },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<SectionSettings>({
    controller,
    fields,
    spec: { title: 'Test', commitMode: 'grouped', sourceHeading: () => 'Host model-tool executor · POSIX Bash', help: [] },
    requestRender: () => {},
    done: () => {},
  })
  page.setMaxRows(8)
  await Promise.resolve()
  await Promise.resolve()
  assert.match(page.render(80).map(strip).join('\n'), /Current: 60000|Command timeout \(ms\)\s+60000 ms/u)
  revision = 2
  const stale = page.render(80).map(strip).join('\n')
  assert.match(stale, /Last-known · Host model-tool executor/u, 'an external edit is never painted as the current row')
  assert.match(strip(page.render(80).at(-1) ?? ''), /Refresh \[R\] · Back \[Esc\]/u, 'the stale group offers its real recovery')
  page.dispose()
})

test('the grouped zero-body grant keeps only Back and never changes the field', async () => {
  const h = await startedNumeric()
  h.page.handleInput(DOWN)
  h.page.render(80)
  h.page.setMaxRows(1) // ZERO body rows: the bar paints only the page's own Back
  const frame = h.page.render(44)
  assert.match(strip(frame.at(-1) ?? ''), /^Back \[Esc\]/u)
  for (const data of [TAB, SHIFT_TAB, UP, DOWN, ENTER, '\r', 'x', 's', 'd', 'r', '?']) h.page.handleInput(data)
  assert.deepEqual(h.writes, [], 'no hidden action may write')
  h.page.setMaxRows(12)
  assert.match(h.page.render(80).map(strip).join('\n'), /^> Output cap per stream \(bytes\)/mu,
    'the field selection was never changed by a hidden body key')
  h.page.dispose()
})

test('44x8 keeps the second field, its Reset and the dirty leave actions reachable', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(4) // the 44x8 body grant
  h.page.handleInput(DOWN)
  let frame = h.page.render(44)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Output cap per stream \(bytes\)/mu, 'the second field is revealed at the short grant')
  assert.match(plain, /64000 bytes/u, 'its canonical value and unit stay whole')
  h.page.handleInput('?')
  frame = h.page.render(44)
  assert.doesNotMatch(frame.map(strip).join('\n'), /Reset to inherited…/u,
    'the reset action is not published before its facts are read')
  h.page.handleInput(END)
  frame = h.page.render(44)
  assert.doesNotMatch(frame.map(strip).join('\n'), /Reset to inherited…/u,
    'jumping to the tail never authorizes the reset')
  h.page.handleInput('x')
  frame = h.page.render(44)
  assert.doesNotMatch(frame.map(strip).join('\n'), /Reset staged/u, 'an unread receipt stages nothing')
  h.page.handleInput(HOME)
  frame = scrollGroupedUntil(h.page, 44, 'Reset to inherited…')
  assert.match(frame.map(strip).join('\n'), /Reset to inherited…/u, 'the sequential read reaches the action')
  h.page.handleInput('x')
  frame = h.page.render(44)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Output cap per stream \(bytes\)/mu)
  assert.match(plain, /Reset staged/u)
  assert.match(plain, /Current: 64000 bytes · Unsaved/u,
    'the short grant keeps the staged reset, the served Current and the dirty count or block')
  h.page.handleInput(ESC)
  frame = h.page.render(44)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /Save keeps you here\./u)
  assert.match(plain, /Discard and leave loses staged values\./u)
  const compactLeaveBar = strip(frame.at(-1) ?? '').replace(/\s+$/u, '')
  assert.match(compactLeaveBar, /Save(?: \[S\])? · Discard (?:and leave )?\[D\] · Keep \[Esc\]$/u,
    `the compact leave bar keeps all three complete actions: ${JSON.stringify(compactLeaveBar)}`)
  h.page.handleInput(ESC)
  assert.match(h.page.render(44).map(strip).join('\n'), /Reset staged/u, 'Keep preserves the reset draft')
  h.page.handleInput('s')
  await h.drain()
  assert.deepEqual(h.writes[0]?.patch, { maxOutputBytes: { kind: 'reset' } })
  assert.match(h.page.render(44).map(strip).join('\n'), /^Saved\s*$/mu)
  h.page.dispose()
})

test('a grouped stage retires its Input before the controller callback and never revives it', async () => {
  let onRender: (() => void) | undefined
  const h = await startedNumeric({ onRender: () => onRender?.() })
  h.page.setMaxRows(40)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80) // the painted Stage span
  let reentered = false
  onRender = () => {
    if (reentered) return
    reentered = true
    // A synchronous render callback delivers a Save (and a second Stage) into
    // the middle of the stage handoff.
    h.page.handleInput('s')
    h.page.handleInput(ENTER)
  }
  h.page.handleInput(ENTER) // Stage
  onRender = undefined
  assert.ok(reentered, 'the callback really ran inside the handoff')
  assert.equal(h.writes.length, 0, 'the reentrant keys never stage twice or save inside the handoff')
  assert.doesNotMatch(h.page.render(80).map(strip).join('\n'), /Value:/u, 'the raw editor is retired')
  h.page.render(80)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1, 'the later explicit Save is the ONE official batch')
  assert.deepEqual(h.writes[0]?.patch, { timeoutMs: { kind: 'set', value: 45_000 } })
  h.page.dispose()
})

test('a grouped Reset staged inside its own callback stays local to the selected field', async () => {
  let onRender: (() => void) | undefined
  const h = await startedNumeric({ onRender: () => onRender?.() })
  h.page.setMaxRows(30)
  h.page.handleInput(DOWN) // the SECOND field
  h.page.handleInput('?')
  h.page.render(80)
  h.page.handleInput(END) // the receipt and the Reset action are painted
  h.page.render(80)
  let reentered = false
  onRender = () => {
    if (reentered) return
    reentered = true
    // A synchronous callback delivers Save and a second Stage into the reset.
    h.page.handleInput('s')
    h.page.handleInput(ENTER)
  }
  h.page.handleInput('x')
  onRender = undefined
  assert.ok(reentered, 'the callback really ran inside the reset stage')
  assert.equal(h.writes.length, 0, 'a local Reset never writes inside its own callback')
  const plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /Output cap per stream \(bytes\)\s+Reset staged/u, 'the exact SELECTED field stages the unset')
  assert.match(plain, /Command timeout \(ms\)\s+60000 ms/u, 'the sibling field is untouched')
  assert.match(plain, /1 unsaved change/u)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1, 'the later explicit Save is the ONE official batch')
  assert.deepEqual(h.writes[0]?.patch, { maxOutputBytes: { kind: 'reset' } })
  h.page.dispose()
})

test('a grouped page retired inside its stage callback dispatches nothing', async () => {
  let onRender: (() => void) | undefined
  const h = await startedNumeric({ onRender: () => onRender?.() })
  h.page.setMaxRows(40)
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(80)
  let disposed = false
  onRender = () => {
    if (disposed) return
    disposed = true
    h.page.dispose()
  }
  h.page.handleInput(ENTER)
  onRender = undefined
  assert.ok(disposed, 'the stage callback really retired the page')
  assert.equal(h.writes.length, 0, 'a page retired inside its stage never dispatches')
  h.page.dispose()
})

test('the single-value Agent tenant paints one value and dispatches ONE save per Confirm', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const inherited = 2
  let effective = { maxParallelToolCalls: 10 }
  let revision = 2
  const writes: SectionPatch<NumericLoopSettings>[] = []
  const port: HostNumericSettingsPort<NumericLoopSettings> = {
    read: () => ({
      kind: 'ready', generation, revision, effective: { ...effective },
      inherited: { maxParallelToolCalls: inherited },
      overridden: { maxParallelToolCalls: effective.maxParallelToolCalls !== inherited },
    }),
    refresh: async () => {},
    mutate: async (patch, expectedRevision) => {
      if (expectedRevision !== revision) return { kind: 'conflict', reason: 'revision changed' }
      writes.push(patch)
      const edit = patch.maxParallelToolCalls!
      effective = { maxParallelToolCalls: edit.kind === 'reset' ? inherited : edit.value }
      revision += 1
      return { kind: 'accepted' }
    },
  }
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const tasks: Promise<void>[] = []
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port,
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { tasks.push(Promise.resolve().then(task)) },
  })
  const dones: string[] = []
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: {
      title: 'Parallel tool calls',
      commitMode: 'single',
      sourceHeading: () => 'Host profile',
      help: [],
      effect: 'Applies to the next Agent step.',
      dispatched: 'Already dispatched calls are unchanged.',
      scope: 'Host profile · every agent on this Host',
    },
    requestRender: () => {},
    done: () => { dones.push('done') },
  })
  page.setMaxRows(10)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const plain = (): string => page.render(80).map(strip).join('\n')
  const clean = plain()
  assert.match(clean, /Current value\s+10/u, 'the clean tenant paints the ONE authoritative value')
  assert.match(clean, /Applies to the next Agent step\./u)
  assert.match(clean, /Details…/u, 'the scoped disclosure is a body affordance')
  assert.doesNotMatch(clean, /\[Reset\]|Status: Ready|Save \[S\]|Apply \[Enter\]/u,
    'the single mode paints no staged Reset, no Ready banner and no second save key')
  // Every key is followed by the frame the next key reads (the app paints
  // between keystrokes); `press` models exactly that.
  const press = (data: string): string => { page.handleInput(data); return plain() }
  // The typed entry intent opens the raw Input directly (no field picker).
  const input = press(ENTER)
  assert.match(input, /Value: 10/u)
  assert.match(input, /Confirm \[Enter\] · Cancel \[Esc\]/u)
  // Invalid text stays in the Input with the real reason and zero writes.
  press('\x15')
  press('0')
  const invalid = press(ENTER)
  assert.match(invalid, /Enter a safe positive integer \(1 or greater\)\./u)
  assert.match(invalid, /Value: 0/u)
  assert.deepEqual(writes, [], 'invalid text never stages a reset and never writes')
  // One valid Confirm dispatches exactly ONE set in the SAME call stack.
  press('\x15')
  press('4')
  const ownedBefore = tasks.length
  press(ENTER)
  assert.equal(tasks.length, ownedBefore + 1, 'stage->save happened in ONE owned handoff')
  for (let turn = 0; turn < 8; turn += 1) await Promise.all(tasks.splice(0))
  assert.deepEqual(writes, [{ maxParallelToolCalls: { kind: 'set', value: 4 } }])
  assert.match(plain(), /Current value\s+4/u)
  assert.match(plain(), /^Saved\s*$/mu)
  assert.doesNotMatch(plain(), /Save \[S\]/u, 'the Saved state never advertises a second save')
  // Equal effective text is a real no-op: zero writes, `No changes`.
  press(ENTER)
  press('\x15')
  press('0004')
  press(ENTER)
  await Promise.resolve()
  assert.equal(writes.length, 1, 'an equal value never writes')
  assert.match(plain(), /No changes/u)
  // `?` opens the SAME pane's Advanced disclosure; Reset opens a confirmation
  // whose risk copy must be painted before Confirm is admitted.
  page.handleInput('?')
  page.render(80)
  const advanced = plain()
  assert.match(advanced, /Effective\s+4/u)
  assert.match(advanced, /Inherited\s+2/u)
  assert.match(advanced, /Revision\s+\d+/u)
  assert.match(advanced, /Reset to inherited…/u)
  page.handleInput('x')
  const question = plain()
  assert.match(question, /Reset sends the official unset\./u)
  assert.match(question, /The USER patch may retain the inherited value\./u)
  assert.match(question, /The Host readback decides the value\./u)
  assert.match(question, /Confirm \[Enter\] · Cancel \[Esc\]/u)
  const ownedBeforeReset = tasks.length
  page.handleInput(ENTER)
  assert.equal(tasks.length, ownedBeforeReset + 1, 'the reset confirmation is ONE handoff')
  for (let turn = 0; turn < 8; turn += 1) await Promise.all(tasks.splice(0))
  assert.deepEqual(writes[1], { maxParallelToolCalls: { kind: 'reset' } })
  assert.match(plain(), /Current value\s+2/u, 'the Host readback decides the value')
  page.dispose()
})

test('a saved single-value Agent settlement demotes when the served row moves', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  let revision = 4
  let effective = { maxParallelToolCalls: 10 }
  const writes: SectionPatch<NumericLoopSettings>[] = []
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const tasks: Promise<void>[] = []
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision, effective: { ...effective },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      mutate: async patch => {
        writes.push(patch)
        const edit = patch.maxParallelToolCalls!
        effective = { maxParallelToolCalls: edit.kind === 'reset' ? 2 : edit.value }
        revision += 1
        return { kind: 'accepted' }
      },
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { tasks.push(Promise.resolve().then(task)) },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => {},
  })
  page.setMaxRows(10)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const plain = (): string => page.render(80).map(strip).join('\n')
  page.handleInput(ENTER)
  page.render(80)
  page.handleInput('\x15')
  page.render(80)
  page.handleInput('4')
  page.render(80)
  page.handleInput(ENTER)
  page.render(80)
  for (let turn = 0; turn < 8; turn += 1) await Promise.all(tasks.splice(0))
  assert.equal(writes.length, 1)
  assert.match(plain(), /^Saved\s*$/mu, 'the verified save starts as a current Saved')

  revision += 1
  const stale = plain()
  assert.match(stale, /^Last-known · read-only\s*$/mu, 'a stale single-value settlement is no longer painted as Saved')
  assert.match(stale, /Previous save completed; refresh to review\./u, 'the history is named as history')
  assert.doesNotMatch(stale, /^Saved\s*$/mu)
  page.dispose()
})

test('the single-value Reset confirmation requires the risk copy to be painted first', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  let revision = 1
  const writes: SectionPatch<NumericLoopSettings>[] = []
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      mutate: async patch => { writes.push(patch); return { kind: 'accepted' } },
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: {
      title: 'Parallel tool calls',
      commitMode: 'single',
      sourceHeading: () => 'Host profile',
      help: [],
      effect: 'Applies to the next Agent step.',
      scope: 'Host profile',
    },
    requestRender: () => {},
    done: () => {},
  })
  // A 3-row grant can only paint the confirmation's first facts: the necessary
  // risk copy is NOT readable yet, so Confirm is neither painted nor admitted.
  page.setMaxRows(3)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  page.handleInput('?')
  page.render(60)
  page.handleInput('x')
  const narrow = page.render(60).map(strip)
  assert.doesNotMatch(narrow.join('\n'), /Confirm \[Enter\]/u, 'a clipped risk copy never publishes Confirm')
  page.handleInput(ENTER)
  assert.deepEqual(writes, [], 'Enter cannot confirm an unread risk copy')
  page.handleInput(DOWN)
  page.render(60)
  page.handleInput(DOWN)
  page.render(60)
  page.handleInput(DOWN)
  const scrolled = page.render(60).map(strip).join('\n')
  assert.match(scrolled, /The Host readback decides the value\./u, 'scrolling reveals the remaining risk')
  assert.match(scrolled, /Confirm \[Enter\]/u, 'Confirm appears only after the whole copy was read')
  page.handleInput(ENTER)
  assert.deepEqual(writes, [{ maxParallelToolCalls: { kind: 'reset' } }])
  page.dispose()
})

test('the single-value page treats Left as its own Back and ? as the disclosure toggle', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  let dones = 0
  const controller = (): HostNumericSettingsController<NumericLoopSettings> => new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision: 1, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      mutate: async () => ({ kind: 'accepted' }),
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller: controller(),
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => { dones += 1 },
  })
  page.setMaxRows(10)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const plain = (): string => page.render(80).map(strip).join('\n')
  // `?` opens Advanced, `?` closes it again (the SAME key is the toggle).
  page.handleInput('?')
  assert.match(plain(), /Effective\s+10/u)
  page.handleInput('?')
  assert.match(plain(), /Current value\s+10/u, 'the second ? closes the disclosure')
  assert.doesNotMatch(plain(), /Effective\s+10/u)
  // Left in the clean Detail is the same Back as Esc.
  page.handleInput(LEFT)
  assert.equal(dones, 1, 'Left on the clean Detail walks back')
  // Left in Advanced closes the disclosure before it walks back.
  page.handleInput('?')
  assert.match(plain(), /Effective\s+10/u)
  page.handleInput(LEFT)
  assert.match(plain(), /Current value\s+10/u, 'Left in Advanced returns to the clean Detail')
  assert.equal(dones, 1, 'the first Left never left the page')
  page.handleInput(LEFT)
  assert.equal(dones, 2, 'the next Left walks back')
  // Input still owns Left as a cursor move, never as Back.
  page.handleInput(ENTER)
  page.render(80)
  assert.match(plain(), /Value: 10/u)
  page.handleInput(LEFT)
  page.render(80)
  assert.equal(dones, 2, 'Left inside the raw Input never leaves the page')
  page.dispose()
})

test('a dropped Confirm segment is never keyboard-admitted for either main action', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const writes: SectionPatch<NumericLoopSettings>[] = []
  const controller = (): HostNumericSettingsController<NumericLoopSettings> => new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision: 1, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      mutate: async patch => { writes.push(patch); return { kind: 'accepted' } },
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller: controller(),
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => {},
  })
  // 22 cells cannot host `Confirm [Enter] · Cancel [Esc]`: the Confirm segment is
  // dropped WHOLE, so neither main action may be reached from the keyboard.
  page.setMaxRows(20)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  page.handleInput(ENTER) // the raw Input
  page.render(22)
  page.handleInput('\x15')
  page.handleInput('4')
  page.render(22)
  const inputFrame = page.render(22).map(strip).join('\n')
  assert.doesNotMatch(inputFrame, /Confirm \[Enter\]/u, 'the dropped Confirm is not painted')
  page.handleInput(ENTER)
  assert.deepEqual(writes, [], 'a dropped Confirm is never keyboard-admitted')
  // The disclosure's reset Confirm has the same admission.
  page.handleInput(ESC) // Cancel the Input
  page.render(22)
  page.handleInput('?')
  page.render(22)
  page.handleInput('x')
  const question = page.render(22).map(strip).join('\n')
  assert.match(question, /decides the value\./u, 'the whole risk copy fits this grant')
  assert.doesNotMatch(question, /Confirm \[Enter\]/u, 'the Confirm segment is dropped at 22 cells')
  page.handleInput(ENTER)
  assert.deepEqual(writes, [], 'the reset can never be confirmed through a dropped span')
  page.dispose()
})

test('a jumped-past reset risk fragment is never treated as read', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const writes: SectionPatch<NumericLoopSettings>[] = []
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision: 1, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      mutate: async patch => { writes.push(patch); return { kind: 'accepted' } },
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => {},
  })
  // TWO body rows at 44 cells: the wrapped risk sentence is split, so a jump to
  // its tail can paint one fragment while its first fragment stays unseen.
  page.setMaxRows(3)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const frame = (): string => page.render(44).map(strip).join('\n')
  page.handleInput('?')
  frame()
  page.handleInput('x')
  assert.doesNotMatch(frame(), /Confirm \[Enter\]/u, 'the copy is not read on the first frame')
  // End jumps to the tail, then Home/Down re-show earlier lines: the sentence's
  // FIRST fragment was never painted, so Confirm must stay absent.
  page.handleInput(END)
  assert.doesNotMatch(frame(), /Confirm \[Enter\]/u, 'the jumped-to tail alone proves nothing')
  page.handleInput(HOME)
  frame()
  page.handleInput(DOWN)
  const jumped = frame()
  assert.doesNotMatch(jumped, /Confirm \[Enter\]/u, 'a skipped first fragment still blocks Confirm')
  page.handleInput(ENTER)
  assert.deepEqual(writes, [], 'Enter cannot confirm a risk copy that was never fully painted')
  // Walking the copy from the top paints every fragment in order.
  page.handleInput(HOME)
  frame()
  for (let step = 0; step < 8; step += 1) {
    page.handleInput(DOWN)
    frame()
  }
  assert.match(frame(), /decides the value\./u)
  assert.match(frame(), /Confirm \[Enter\]/u, 'Confirm appears only after every fragment was painted')
  page.handleInput(ENTER)
  assert.deepEqual(writes, [{ maxParallelToolCalls: { kind: 'reset' } }])
  page.dispose()
})

test('a bar-only grant admits nothing but the page own Back', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  let refreshes = 0
  let dones = 0
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision: 1, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => { refreshes += 1 },
      mutate: async () => ({ kind: 'accepted' }),
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => { dones += 1 },
  })
  page.setMaxRows(1) // ZERO body content rows: the bar paints only Back
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const frame = (): string => page.render(44).map(strip).join('\n')
  assert.match(frame(), /Back \[Esc\]/u)
  assert.doesNotMatch(frame(), /Change \[Enter\]|Details|Refresh \[R\]/u, 'no body action is painted')
  // No key may start an Input, a disclosure or an official refresh.
  page.handleInput(ENTER)
  assert.doesNotMatch(frame(), /Value:/u, 'a hidden Input is never started')
  page.handleInput('?')
  assert.doesNotMatch(frame(), /Effective/u, 'a hidden disclosure is never opened')
  const refreshesBefore = refreshes
  page.handleInput('r')
  await Promise.resolve()
  assert.equal(refreshes, refreshesBefore, 'a hidden official refresh is never dispatched')
  page.handleInput(' ')
  assert.equal(dones, 0, 'nothing in a bar-only frame may leave the page')
  // The page's OWN Back is the one admitted action, and a restored grant works.
  page.handleInput(LEFT)
  assert.equal(dones, 1, 'Left is the same Back the bar paints')
  page.setMaxRows(10)
  page.handleInput(ENTER)
  assert.match(frame(), /Value:/u, 'a restored grant admits a fresh explicit Change')
  page.dispose()
})

test('a dropped question action is never keyboard-admitted', async () => {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  let dones = 0
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision: 1, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      // The Host refuses the write: the draft stays dirty, so leaving asks the
      // page's OWN question.
      mutate: async () => ({ kind: 'rejected', reason: 'read-only profile' }),
    },
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => { dones += 1 },
  })
  page.setMaxRows(40)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const frame = (width: number): string => page.render(width).map(strip).join('\n')
  page.handleInput(ENTER)
  frame(80)
  page.handleInput('\x15')
  page.handleInput('6')
  frame(80) // paint the typed value so its Confirm is really admitted
  page.handleInput(ENTER) // the refused write leaves the draft dirty
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  page.handleInput(ESC) // leaving a dirty page asks its own question
  const narrow = frame(30)
  assert.match(narrow, /Keep \[Esc\]/u)
  assert.doesNotMatch(narrow, /Discard and leave/u, 'the action segment is dropped WHOLE at 30 cells')
  page.handleInput('d')
  assert.equal(dones, 0, 'a dropped Discard action is never keyboard-admitted')
  const wide = frame(80)
  assert.match(wide, /Discard and leave \[D\]/u, 'a grant that can host the whole action paints it')
  page.handleInput('d')
  assert.equal(dones, 1, 'the really painted action admits its own shortcut')
  page.dispose()
})

/** A single-mode page plus its controller over a counting fake port. */
function singlePageFixture(mutate: (patch: SectionPatch<{ readonly maxParallelToolCalls: number }>) => Promise<{ kind: 'accepted' } | { kind: 'rejected'; reason: string }>) {
  interface NumericLoopSettings {
    readonly maxParallelToolCalls: number
  }
  const generation = {}
  const fields: readonly HostNumericSettingsField<NumericLoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const writes: SectionPatch<NumericLoopSettings>[] = []
  const state: { page?: HostNumericSettingsPage<NumericLoopSettings>; onRender?: () => void } = {}
  const controller = new HostNumericSettingsController<NumericLoopSettings>({
    port: {
      read: () => ({
        kind: 'ready', generation, revision: 1, effective: { maxParallelToolCalls: 10 },
        inherited: { maxParallelToolCalls: 2 }, overridden: { maxParallelToolCalls: true },
      }),
      refresh: async () => {},
      mutate: async patch => { writes.push(patch); return await mutate(patch) },
    },
    fields,
    requestRender: () => { state.onRender?.() },
    runOwned: (_label, task) => { void task() },
  })
  const page = new HostNumericSettingsPage<NumericLoopSettings>({
    controller,
    fields,
    spec: { title: 'Parallel tool calls', commitMode: 'single', sourceHeading: () => 'Host profile', help: [], scope: 'Host profile' },
    requestRender: () => {},
    done: () => {},
  })
  state.page = page
  return { page, writes, state }
}

test('the stage->save handoff refuses a key delivered by its own synchronous callback', async () => {
  const fixture = singlePageFixture(async () => ({ kind: 'accepted' }))
  const { page, writes, state } = fixture
  page.setMaxRows(40)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  page.handleInput(ENTER)
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('6')
  page.render(80) // the typed value really paints its Confirm
  let reentered = false
  state.onRender = () => {
    if (reentered) return
    reentered = true
    // A synchronous callback delivers a Confirm into the middle of the handoff.
    page.handleInput(ENTER)
  }
  page.handleInput(ENTER) // the stage -> save handoff
  state.onRender = undefined
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const frame = page.render(80).map(strip).join('\n')
  assert.ok(reentered, 'the callback really ran inside the handoff')
  assert.doesNotMatch(frame, /Value:/u, 'the reentrant key never revives the raw editor')
  assert.equal(JSON.stringify(writes), JSON.stringify([{ maxParallelToolCalls: { kind: 'set', value: 6 } }]),
    `exactly ONE official write leaves the handoff: ${JSON.stringify(writes)}`)
  page.dispose()
})

test('a page retired inside its own stage callback dispatches nothing', async () => {
  const fixture = singlePageFixture(async () => ({ kind: 'accepted' }))
  const { page, writes, state } = fixture
  page.setMaxRows(40)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  page.handleInput(ENTER)
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('6')
  page.render(80)
  let disposed = false
  state.onRender = () => {
    if (disposed) return
    disposed = true
    page.dispose()
  }
  page.handleInput(ENTER)
  state.onRender = undefined
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  assert.ok(disposed, 'the stage callback really retired the page')
  assert.deepEqual(writes, [], 'a page retired inside its stage never dispatches')
  page.dispose()
})

test('a forced close after admission lets the owned write complete exactly once', async () => {
  const fixture = singlePageFixture(async () => {
    // The admitted write keeps its own owner: closing the page mid-flight never
    // cancels or replays it.
    fixture.state.page?.dispose()
    return { kind: 'accepted' }
  })
  const { page, writes } = fixture
  page.setMaxRows(40)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  page.handleInput(ENTER)
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('6')
  page.render(80)
  page.handleInput(ENTER)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  assert.equal(JSON.stringify(writes), JSON.stringify([{ maxParallelToolCalls: { kind: 'set', value: 6 } }]),
    `the owned write completes exactly once after the close: ${JSON.stringify(writes)}`)
  assert.equal(page.render(80).map(strip).join('').trim(), '', 'the retired page paints nothing')
  page.dispose()
})

test('44x8 paints the SECOND field and its complete Reset target stages THAT field', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(4) // the 44x8 body grant
  h.page.handleInput(DOWN)
  let frame = h.page.render(44)
  assert.ok(numericRowIndex(frame, 'Output cap per stream') >= 0, `the second field is reachable at 44x8:\n${frame.join('\n')}`)
  h.page.handleInput('?')
  frame = h.page.render(44)
  assert.doesNotMatch(frame.map(strip).join('\n'), /Reset to inherited…/u,
    'the reset action is not published before its facts are read')
  h.page.handleInput(END)
  frame = h.page.render(44)
  assert.doesNotMatch(frame.map(strip).join('\n'), /Reset to inherited…/u,
    'jumping to the tail never authorizes the reset')
  h.page.handleInput(HOME)
  frame = scrollGroupedUntil(h.page, 44, 'Reset to inherited…')
  const resetRow = numericRowIndex(frame, 'Reset to inherited…')
  assert.ok(resetRow >= 0, `the sequential read reaches the action:\n${frame.join('\n')}`)
  clickNumericRow(h.page, frame, resetRow, 44, 'Reset to inherited…')
  frame = h.page.render(44)
  const plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Output cap per stream \(bytes\)/u)
  assert.match(plain, /Reset staged/u, 'the painted second-field Reset target stages THAT field')
  assert.match(plain, /Current: 64000 bytes · Unsaved/u)
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('the grouped leave bar keeps all three complete actions at the medium child width', async () => {
  const h = await startedNumeric()
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.setMaxRows(20)
  h.page.handleInput(ESC)
  const frame = h.page.render(32) // the real 76-column medium Detail child bar
  const bar = strip(frame.at(-1) ?? '').replace(/\s+$/u, '')
  assert.match(bar, /^Save · Discard \[D\] · Keep \[Esc\]$/u,
    `the 32-cell child bar keeps all three complete leave actions: ${JSON.stringify(bar)}`)
  assert.match(frame.map(strip).join('\n'), /Discard and leave…/u, 'the body also carries the complete action')
  // Keep is safe; the bar's Discard really leaves without writing.
  h.page.handleInput(LEFT)
  h.page.render(32)
  h.page.handleInput(ESC)
  h.page.render(32)
  h.page.handleInput('d')
  assert.deepEqual(h.actions, ['done'])
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('a grouped question accept stays reachable in its body when the bar drops the third span', async () => {
  const h = await startedNumeric()
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.setMaxRows(20)
  h.page.handleInput(ESC)
  const frame = h.page.render(26) // narrower than Save · Discard [D] · Keep [Esc]
  const bar = strip(frame.at(-1) ?? '')
  assert.doesNotMatch(bar, /Discard/u, 'the bar cannot host the third span here')
  assert.match(bar, /Save · Keep \[Esc\]/u)
  const acceptRow = numericRowIndex(frame, 'Discard and leave…')
  assert.ok(acceptRow >= 0, `the complete accept action is painted in the body:\n${frame.join('\n')}`)
  clickNumericRow(h.page, frame, acceptRow, 26, 'Discard and leave…')
  assert.deepEqual(h.actions, ['done'])
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('a grouped Save is only published while its own dirty facts are really on screen', async () => {
  const h = await startedNumeric()
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.setMaxRows(4) // body 3: the field block fits, the count may not
  h.page.render(80) // consume the resize reveal, then really scroll away
  h.page.handleInput(END) // the explanatory tail, no dirty fact
  let frame = h.page.render(80)
  let plain = frame.map(strip).join('\n')
  assert.doesNotMatch(plain, /1 unsaved change/u)
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Save \[S\]/u, 'the bar publishes NO Save without its facts')
  h.page.handleInput('s')
  await h.drain()
  assert.deepEqual(h.writes, [], 'the refused Save span never dispatches')
  // A sufficient grant reveals the dirty block again and the fresh Save works.
  h.page.setMaxRows(12)
  frame = h.page.render(80)
  assert.match(strip(frame.at(-1) ?? ''), /Save \[S\]/u)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1)
  h.page.dispose()
})

test('a grouped leave question publishes Save only when its necessary copy is complete', async () => {
  const h = await startedNumeric()
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.setMaxRows(2) // body 1: the leave copy cannot be complete at once
  h.page.handleInput(ESC)
  let frame = h.page.render(80)
  const bar = strip(frame.at(-1) ?? '')
  assert.equal(bar, 'Keep [Esc]'.padEnd(80), 'only the safe Keep is admitted')
  h.page.handleInput('s')
  h.page.handleInput('d')
  await h.drain()
  assert.deepEqual(h.writes, [], 'no invisible Save/Discard may dispatch')
  assert.equal(strip(h.page.render(80).at(-1) ?? '').replace(/\s+$/u, ''), 'Keep [Esc]', 'the question is still open with only the safe Keep')
  // Sequential scrolling through EVERY fragment still cannot turn a one-row
  // grant into a current complete copy: the ordinary question answers from the
  // CURRENT frame, not from accumulated history.
  for (let step = 0; step < 6; step += 1) {
    h.page.handleInput(DOWN)
    const scrolled = h.page.render(80)
    assert.equal(strip(scrolled.at(-1) ?? '').replace(/\s+$/u, ''), 'Keep [Esc]',
      'an insufficient grant never publishes S/D, however far it is scrolled')
  }
  h.page.handleInput('s')
  h.page.handleInput('d')
  await h.drain()
  assert.deepEqual(h.writes, [], 'the sequential-scroll bypass never dispatches')
  assert.match(h.page.render(80).map(strip).join('\n'), /Discard and leave loses staged values\./u,
    'the question still owns the frame')
  h.page.setMaxRows(12)
  frame = h.page.render(80)
  assert.match(frame.map(strip).join('\n'), /1 unsaved change · Shell execution/u, 'the draft survives the bypass')
  assert.match(strip(frame.at(-1) ?? ''), /Save(?: \[S\])? · Discard (?:and leave )?\[D\] · Keep \[Esc\]/u)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1)
  assert.match(h.page.render(80).map(strip).join('\n'), /^Saved\s*$/mu)
  h.page.dispose()
})

test('the grouped canonical fact splits before it clips, and an unshowable value admits no Stage', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(20)
  h.page.handleInput(DOWN) // the output-cap field (bytes)
  h.page.handleInput(ENTER)
  h.page.render(44)
  h.page.handleInput('\x15')
  for (const character of '1.2345678901234567e+300') h.page.handleInput(character)
  // 34 cells: the raw editor itself shows the whole 23-cell number, so no
  // second canonical fact is required.
  let frame = h.page.render(34)
  let plain = frame.map(strip).join('\n')
  assert.doesNotMatch(plain, /Value sends/u, 'a fully visible raw number is its own proof')
  assert.match(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u)
  // 29 cells: the raw window clips, so the canonical fact appears whole, with
  // no ellipsis.
  frame = h.page.render(29)
  plain = frame.map(strip).join('\n')
  assert.ok(plain.includes('1.2345678901234567e+300 bytes'), 'the 29-cell line carries the whole canonical value')
  assert.doesNotMatch(plain, /…/u, 'no ellipsis on a complete canonical fact')
  assert.match(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u)
  // 28 cells: the FACT cannot be whole while the Stage bar still fits; no Stage.
  frame = h.page.render(28)
  plain = frame.map(strip).join('\n')
  assert.doesNotMatch(plain, /1\.2345678901234567e\+300 bytes/u)
  assert.match(plain, /…/u, 'the clipped value is visibly not the whole number')
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u)
  h.page.handleInput(ENTER)
  frame = h.page.render(28)
  assert.match(frame.map(strip).join('\n'), /Value: .*e\+300/u, 'the denied Stage keeps the raw Input (scrolled in its window)')
  assert.match(strip(frame.at(-1) ?? ''), /Cancel \[Esc\]/u)
  // A sufficient grant returns the Stage; the draft was untouched.
  frame = h.page.render(30)
  assert.match(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u)
  h.page.handleInput(ENTER)
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /1\.2345678901234567e\+300 bytes/u)
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('an unconfirmed grouped outcome keeps the captured row truthful and offers only explicit recovery', async () => {
  const h = await startedNumeric({ unconfirmed: true })
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1)
  h.page.setMaxRows(8) // the short grant must keep the settlement state first
  let frame = h.page.render(80)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /^Could not confirm save\s*$/mu)
  assert.match(plain, /The change may have been saved\. Refresh and check\./u)
  assert.match(plain, /Last-known · Host model-tool executor · POSIX Bash/u, 'the old row is named last-known')
  assert.match(plain, /Last confirmed: 60000 ms · Unsaved/u, 'the captured value is not painted as Current')
  assert.doesNotMatch(plain, /Current: 60000 ms/u)
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Save \[S\]/u, 'no blind retry is published')
  assert.doesNotMatch(plain, /Discard…/u, 'an ambiguous outcome has no ordinary local discard')
  assert.match(strip(frame.at(-1) ?? ''), /Refresh \[R\] · Back \[Esc\]/u)
  // Back opens the ambiguous leave question with the requested/last-confirmed facts.
  h.page.handleInput(ESC)
  frame = h.page.render(80)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /The Host may have applied this change\./u)
  assert.match(plain, /Leaving does not undo it\./u)
  assert.match(plain, /Leave anyway \[D\]/u)
  assert.match(plain, /Requested Command timeout \(ms\)\s+45000 ms/u)
  assert.match(plain, /Last confirmed Command timeout \(ms\)\s+60000 ms/u)
  assert.match(plain, /Last confirmed Output cap per stream \(bytes\)\s+64000 bytes/u,
    'both captured caps are disclosed, not only the dirty field')
  h.page.handleInput(LEFT) // Keep
  assert.match(h.page.render(80).map(strip).join('\n'), /Could not confirm save/u)
  // Refresh requires the explicit question, then re-reads the served row.
  h.page.handleInput('r')
  frame = h.page.render(80)
  assert.match(frame.map(strip).join('\n'), /Refresh discards unsaved edits\./u)
  h.page.handleInput('r')
  await h.drain()
  frame = h.page.render(80)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /^> Command timeout \(ms\)\s+45000 ms\s*$/mu, 'the refresh reads the new served row')
  assert.doesNotMatch(plain, /Last-known · /u, 'no stale tag survives a successful refresh')
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Save \[S\]/u, 'a refresh does not replay the lost Save')
  // A NEW explicit edit/stage/save is required.
  h.page.handleInput(ENTER)
  h.page.render(80)
  h.page.handleInput('\x15')
  for (const character of '5000') h.page.handleInput(character)
  h.page.render(80)
  h.page.handleInput(ENTER)
  h.page.render(80)
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Save \[S\]/u, 'the new staged draft publishes its Save')
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 2)
  assert.deepEqual(h.writes[1]?.patch, { timeoutMs: { kind: 'set', value: 5000 } })
  h.page.dispose()
})

test('an ambiguous leave never wears the definite discard label and keeps its body answer', async () => {
  const h = await startedNumeric({ unconfirmed: true })
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.handleInput('s')
  await h.drain()
  h.page.setMaxRows(20)
  h.page.handleInput(ESC)
  let frame = h.page.render(26)
  const bar = strip(frame.at(-1) ?? '')
  assert.doesNotMatch(bar, /Discard/u, 'an unknown outcome must never be labelled as an ordinary discard')
  assert.match(bar, /Keep \[Esc\]/u)
  assert.match(frame.map(strip).join('\n'), /Leave anyway…/u, 'the complete real answer stays in the body')
  h.page.handleInput(LEFT) // Keep
  assert.match(h.page.render(26).map(strip).join('\n'), /^Could not confirm save\s*$/mu)
  h.page.handleInput(ESC)
  frame = h.page.render(26)
  const row = numericRowIndex(frame, 'Leave anyway…')
  assert.ok(row >= 0, `the body answer is painted:\n${frame.join('\n')}`)
  clickNumericRow(h.page, frame, row, 26, 'Leave anyway…')
  assert.deepEqual(h.actions, ['done'])
  assert.equal(h.writes.length, 1, 'leaving never retries the uncertain write')
  h.page.dispose()
})

test('a scrolled optional detail never leaves an actionable question answer', async () => {
  const h = await startedNumeric({ unconfirmed: true })
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.handleInput('s')
  await h.drain()
  h.page.setMaxRows(5) // body 4: the necessary copy and the accept fit together
  h.page.handleInput(ESC)
  let frame = h.page.render(44)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /Leaving does not undo it\./u, 'the necessary copy is complete')
  const acceptRow = numericRowIndex(frame, 'Leave anyway…')
  assert.ok(acceptRow >= 0, `the body answer is painted:\n${frame.join('\n')}`)
  assert.match(strip(frame.at(-1) ?? ''), /Leave anyway \[D\] · Keep \[Esc\]/u)
  // One scroll row puts the necessary copy out of view while the accept row
  // stays inside the viewport: the action must become an inert blank there.
  h.page.handleInput(DOWN)
  frame = h.page.render(44)
  plain = frame.map(strip).join('\n')
  assert.match(plain, /The Host may have applied this change\./u, 'the detail/prelude is still readable')
  assert.doesNotMatch(plain, /Leave anyway…/u, 'the scrolled-out copy suppresses the action word itself')
  assert.equal(strip(frame.at(-1) ?? '').replace(/\s+$/u, ''), 'Keep [Esc]', 'the bar drops its accept with the copy')
  const oldAcceptRow = acceptRow
  assert.notEqual(h.page.handleMouse(mouse('press', 0, oldAcceptRow, 44, frame.length))?.handled, true,
    'the reserved blank row is not an actionable target')
  h.page.handleInput('d')
  await h.drain()
  assert.deepEqual(h.actions, [], 'no hidden answer while the copy is scrolled away')
  assert.equal(h.writes.length, 1, 'the uncertain write is never retried')
  // HOME restores the complete copy and the genuine fresh answer.
  h.page.handleInput(HOME)
  frame = h.page.render(44)
  const freshRow = numericRowIndex(frame, 'Leave anyway…')
  assert.ok(freshRow >= 0, `the action returns with the copy:\n${frame.join('\n')}`)
  clickNumericRow(h.page, frame, freshRow, 44, 'Leave anyway…')
  assert.deepEqual(h.actions, ['done'])
  assert.equal(h.writes.length, 1)
  h.page.dispose()
})

test('a refused grouped Save is read-only until Refresh, and its local Discard stays a real body action', async () => {
  const h = await startedNumeric({ reject: true })
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.handleInput('s')
  await h.drain()
  let frame = h.page.render(80)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /^Could not save\s*$/mu)
  assert.match(plain, /refresh to review\./u)
  assert.match(plain, /Last-known · Host model-tool executor · POSIX Bash/u,
    'a refused capture is not reprinted as the current row')
  assert.match(plain, /Last confirmed: 60000 ms · Unsaved/u)
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Save \[S\]|Edit \[Enter\]/u, 'a refused capture publishes no retry/edit')
  assert.match(strip(frame.at(-1) ?? ''), /Refresh \[R\] · Back \[Esc\]/u)
  const discardRow = numericRowIndex(frame, 'Discard…')
  assert.ok(discardRow >= 0, 'the local Discard is a real body action')
  clickNumericRow(h.page, frame, discardRow, 80, 'Discard…')
  frame = h.page.render(80)
  assert.match(frame.map(strip).join('\n'), /Discard unsaved changes\?/u)
  h.page.handleInput('d')
  frame = h.page.render(80)
  plain = frame.map(strip).join('\n')
  assert.doesNotMatch(plain, /1 unsaved change/u, 'the local discard clears the draft')
  assert.doesNotMatch(plain, /^Could not save\s*$/mu)
  assert.doesNotMatch(plain, /Save \[S\]|Edit \[Enter\]/u, 'the stale capture is still read-only')
  assert.equal(h.writes.length, 1, 'discarding never dispatches another write')
  h.page.handleInput('r')
  await h.drain()
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Edit \[Enter\]/u, 'an explicit Refresh re-enables editing')
  h.page.dispose()
})

test('a width-only reflow revokes the grouped Reset until its facts are read again', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(4)
  h.page.handleInput(DOWN)
  h.page.handleInput('?')
  h.page.render(44)
  let frame = scrollGroupedUntil(h.page, 44, 'Reset to inherited…')
  assert.match(strip(frame.at(-1) ?? ''), /Reset \[X\]/u, 'the sequential read publishes the bar action')
  // Width-only reflow: the facts' receipt is invalidated even though the row
  // grant is unchanged; neither the bar nor the key may advertise the old one.
  frame = h.page.render(72)
  assert.doesNotMatch(strip(frame.at(-1) ?? ''), /Reset \[X\]/u, 'a width reflow revokes the bar Reset')
  h.page.handleInput('x')
  frame = h.page.render(72)
  assert.doesNotMatch(frame.map(strip).join('\n'), /Reset staged/u, 'the stale key cannot stage')
  assert.deepEqual(h.writes, [])
  // The fresh sequential read at the new width publishes a genuine action.
  h.page.handleInput(HOME)
  frame = scrollGroupedUntil(h.page, 72, 'Reset to inherited…')
  assert.match(strip(frame.at(-1) ?? ''), /Reset \[X\]/u)
  const resetRow = numericRowIndex(frame, 'Reset to inherited…')
  assert.ok(resetRow >= 0)
  clickNumericRow(h.page, frame, resetRow, 72, 'Reset to inherited…')
  assert.match(h.page.render(72).map(strip).join('\n'), /Reset staged/u)
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('a legal draft with trailing whitespace still requires a readable sent value', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(20)
  h.page.handleInput(ENTER)
  h.page.render(44)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  for (let index = 0; index < 40; index += 1) h.page.handleInput(' ')
  const frame = h.page.render(44)
  const plain = frame.map(strip).join('\n')
  assert.match(plain, /Value sends/u, 'a clipped full buffer requires the canonical fact')
  assert.match(plain, /45000 ms/u)
  assert.match(strip(frame.at(-1) ?? ''), /Stage \[Enter\]/u)
  h.page.handleInput(ENTER)
  assert.match(h.page.render(80).map(strip).join('\n'), /45000 ms/u)
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('the dirty block receipt measures the real composed Current line', async () => {
  const h = await startedNumeric({ effectiveTimeout: 123_456_789 })
  h.page.setMaxRows(4)
  h.page.handleInput(ENTER)
  h.page.render(32)
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.render(32)
  h.page.handleInput(ENTER)
  const frame = h.page.render(32)
  const plain = frame.map(strip).join('\n')
  assert.match(plain, /Current: 123456789 ms/u, 'the current value is whole')
  assert.doesNotMatch(plain, /Current: 123456789 ms · /u, 'the 33-cell one-line form is never composed into a clip')
  assert.match(plain, /^\s*· Unsaved\s*$/mu, 'the separate Unsaved marker proves the split block')
  assert.match(strip(frame.at(-1) ?? ''), /Save \[S\]/u, 'the complete split block is a real Save receipt')
  h.page.handleInput('s')
  await h.drain()
  assert.deepEqual(h.writes[0]?.patch, { timeoutMs: { kind: 'set', value: 45_000 } })
  h.page.dispose()
})

function scrollSubagentUntil(page: SubagentSettingsPage, width: number, needle: string, limit = 60): string[] {
  let frame = page.render(width)
  for (let step = 0; step < limit && !strip(frame.join('\n')).includes(needle); step += 1) {
    page.handleInput(DOWN)
    frame = page.render(width)
  }
  return frame
}

test('a complete dirty count alone admits Save while the dirty field block is offscreen', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Parallelism')
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  page.handleInput('4')
  page.render(80)
  activateBar(page, 'bar:apply')
  page.render(80)
  assert.equal(controller.snapshot().dirty, true)
  page.setMaxRows(4) // body 3: the count and section heading fit, the dirty block does not
  page.render(80)
  page.handleInput(HOME)
  const frame = page.render(80)
  const plain = strip(frame.join('\n'))
  assert.match(plain, /1 unsaved change/u, 'the real total is complete')
  assert.doesNotMatch(plain, /> Parallelism/u, 'the dirty field block is offscreen at the home position')
  assert.match(barLine(frame), /Save \[S\]/u, 'the complete count alone admits its Save')
  activateBar(page, 'bar:save')
  await h.drainTasks()
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0]?.section, 'limits')
  assert.deepEqual(h.writes[0]?.patch, { maxActiveSubagents: { kind: 'set', value: 4 } })
  h.page.dispose()
})

test('bar Toggle and Enter converge on one reveal-only decision for a hidden selected field', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Enabled')
  page.setMaxRows(6)
  page.render(80)
  page.handleInput(END)
  let frame = page.render(80)
  assert.doesNotMatch(strip(frame.join('\n')), /> Enabled/u, 'the selected field is really hidden')
  assert.match(barLine(frame), /Toggle \[Enter\]/u, 'the bar still names the selected field action')
  activateBar(page, 'bar:toggle')
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /> Enabled/u, 'the bar reveals instead of staging a hidden field')
  assert.equal(controller.snapshot().dirty, false, 'the bar gesture staged nothing')
  page.handleInput(END)
  page.render(80)
  page.handleInput(ENTER)
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /> Enabled/u, 'the keyboard uses the same reveal-only decision')
  assert.equal(controller.snapshot().dirty, false, 'the keyboard gesture staged nothing')
  activateBar(page, 'bar:toggle')
  await settleMicrotasks()
  assert.equal(controller.snapshot().selection.patch.enabled?.kind, 'set', 'the fresh visible frame stages the chosen action')
  assert.deepEqual(h.writes, [])
  h.page.dispose()
})

test('a height-only Advanced reflow retires the read receipt until its facts are read again', async () => {
  const h = await started()
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Maximum depth')
  page.handleInput('?')
  let frame = page.render(80)
  assert.match(barLine(frame), /Reset \[X\]/u, 'the full grant reads the short disclosure')
  assert.equal(controller.snapshot().limits.patch.maxDepth, undefined)
  page.setMaxRows(3)
  frame = page.render(80)
  assert.doesNotMatch(barLine(frame), /Reset \[X\]/u, 'a new height grant has no read receipt')
  page.handleInput('x')
  frame = page.render(80)
  assert.equal(controller.snapshot().limits.patch.maxDepth, undefined, 'the stale Reset is inert')
  page.handleInput(HOME)
  frame = scrollSubagentUntil(page, 80, 'Reset [X]')
  assert.match(barLine(frame), /Reset \[X\]/u, 'the fresh grant re-reads the same disclosure')
  page.handleInput('x')
  await settleMicrotasks()
  assert.equal(controller.snapshot().limits.patch.maxDepth?.kind, 'reset')
  h.page.dispose()
})

test('a narrow ambiguous question reserves its answer before long optional route identities', async () => {
  const longRoute = { provider: 'provider-with-a-very-long-identity', model: 'model-with-a-very-long-identity' }
  const h = await started({
    lostAckSelection: true,
    directoryValue: {
      default: { provider: longRoute.provider, model: longRoute.model },
      routableProviders: [longRoute.provider],
      groups: [{ id: longRoute.provider, name: 'Provider Long', models: [{ id: longRoute.model, name: 'Model Long' }] }],
      failures: [],
    },
  })
  const { page, controller } = h
  page.focused = true
  controller.toggleEnabled()
  controller.toggleRoute(longRoute)
  page.render(80)
  activateBar(page, 'bar:save')
  await h.drainTasks()
  assert.equal(controller.snapshot().selection.status?.kind, 'outcome-unconfirmed')
  page.setMaxRows(8) // body 7: the full mandatory copy + complete answer; optional detail does not fit
  page.render(80)
  page.handleInput(ESC)
  let frame = page.render(26)
  let plain = strip(frame.join('\n'))
  assert.match(plain, /The Host may have applied\s+changes\./u, 'the necessary ambiguous copy is complete')
  const acceptRow = rowIndex(frame, line => line.includes('Leave anyway…'))
  assert.ok(acceptRow >= 0, `the body answer is reserved before optional details:\n${frame.join('\n')}`)
  assert.ok(acceptRow < 7, 'the reserved answer is inside the grant')
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:leave'), false,
    'the 26-cell bar cannot supply the accept')
  assert.equal(page.handleMouse(mouse('press', 0, acceptRow, 26, frame.length))?.handled, true,
    'the body answer is a real press target')
  // One scroll puts the first necessary fact outside while the reserved answer
  // row is still physically inside; the final viewport predicate must blank its
  // text and withdraw its target at the SHIFTED physical row.
  page.handleInput(DOWN)
  frame = page.render(26)
  plain = strip(frame.join('\n'))
  assert.doesNotMatch(plain, /Leave anyway…/u, 'the answer text is blank once necessary copy is scrolled out')
  const blankRow = acceptRow - 1
  assert.notEqual(page.handleMouse(mouse('press', 0, blankRow, 26, frame.length))?.handled, true,
    'the shifted blank is not a press target')
  assert.notEqual(page.handleMouse(mouse('click', 0, blankRow, 26, frame.length))?.handled, true,
    'the shifted blank is not a release target')
  page.handleInput('d')
  await h.drainTasks()
  assert.equal(h.dones.length, 0, 'the hidden key never leaves')
  assert.equal(h.writes.length, 1, 'the uncertain write is not replayed')
  assert.equal(controller.snapshot().selection.dirty, true, 'the draft is unchanged')
  // Home restores the complete copy; the actual fresh press/release leaves once.
  page.handleInput(HOME)
  frame = page.render(26)
  assert.match(strip(frame.join('\n')), /Leave anyway…/u)
  clickRow(page, frame, acceptRow, 26, 'Leave anyway…')
  assert.equal(h.dones.length, 1, 'the fresh answer leaves exactly once')
  assert.equal(h.writes.length, 1, 'leaving never replays the uncertain write')
  h.page.dispose()
})

test('a stale formerly Saved section paints Last-known, never a current Saved', async () => {
  const h = await started()
  const { page } = h
  page.focused = true
  selectField(page, 'Maximum depth')
  activateBar(page, 'bar:edit')
  page.render(80)
  page.handleInput('\x15')
  for (const character of '2') page.handleInput(character)
  page.render(80)
  activateBar(page, 'bar:apply')
  page.render(80)
  activateBar(page, 'bar:save')
  await h.drainTasks()
  let plain = strip(page.render(80).join('\n'))
  assert.match(plain, /Limits:\s+Saved/u)
  h.replaceGeneration()
  plain = strip(page.render(80).join('\n'))
  assert.match(plain, /Limits:?\s+Last-known · read-only/u)
  assert.match(plain, /Previous save completed; refresh to review\./u)
  assert.doesNotMatch(plain, /Limits:\s+Saved/u)
  h.page.dispose()
})

test('directory search suppresses route targets/actions and Done republishes them', async () => {
  const h = await started({
    directoryValue: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }, { id: 'n', name: 'Other N' }] }],
      failures: [],
    },
  })
  const { page, controller } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  page.render(80)
  page.handleInput('/')
  page.handleInput('other')
  let frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Search: other/u)
  assert.equal(barLine(frame).replace(/\s+$/u, ''), 'Done [Enter] · Back [Esc]')
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'), false)
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:refresh'), false)
  assert.doesNotMatch(strip(frame.join('\n')), /Add route \[Enter\]|Remove route \[Enter\]/u)
  const otherRow = rowIndex(frame, line => line.includes('Other N'))
  assert.ok(otherRow >= 0)
  assert.notEqual(page.handleMouse(mouse('press', 2, otherRow, 80, frame.length))?.handled, true,
    'a filtered search row is not a route hit target')
  assert.equal(controller.snapshot().allowedModels.length, 0)
  page.handleInput(ENTER)
  frame = page.render(80)
  assert.match(strip(frame.join('\n')), /Search \[\/\]\s+other/u)
  assert.match(barLine(frame), /Add route \[Enter\]/u, 'Done republishes the route action on a fresh frame')
  assert.equal(controller.snapshot().allowedModels.length, 0)
  h.page.dispose()
})

test('a clean directory refresh invalidates the old read and never publishes its late answer', async () => {
  const h = await started({
    holdDirectory: true,
    directoryValue: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }] }],
      failures: [],
    },
  })
  const { page } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.directoryStarted
  page.render(80)
  assert.match(barLine(page.render(80)), /Refresh/u)
  page.handleInput('r')
  h.releaseDirectory() // release the aborted first read; it must never publish
  await h.drainTasks()
  page.render(80) // start the post-refresh current request (held)
  await settleMicrotasks() // let the scheduled loader really enter its hold
  assert.equal(h.directoryReadCount(), 2, 'the refresh starts exactly one current read')
  const stale = strip(page.render(80).join('\n'))
  assert.match(stale, /Loading models…/u, 'the aborted first read never publishes')
  assert.doesNotMatch(stale, /Provider P/u)
  h.releaseDirectory()
  await settleMicrotasks()
  let published = strip(page.render(80).join('\n'))
  for (let step = 0; step < 5 && !published.includes('Provider P'); step += 1) {
    await settleMicrotasks()
    published = strip(page.render(80).join('\n'))
  }
  assert.match(published, /Provider P/u, 'the current request publishes its real directory')
  assert.equal(h.directoryReadCount(), 2, 'the accepted refresh starts exactly ONE fresh read')
  h.page.dispose()
})

test('a dirty directory refresh keeps its state on Keep and re-reads once on the accepted path', async () => {
  const models = Array.from({ length: 18 }, (_, index) => ({ id: `m${index + 1}`, name: `Model ${index + 1}` }))
  const h = await started({
    directoryValue: {
      default: { provider: 'p', model: 'm1' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider P', models }],
      failures: [],
    },
  })
  const { page, controller } = h
  const firstModel = (lines: readonly string[]): string | undefined =>
    lines.map(strip).find(line => /\bModel \d+\b/u.test(line))
  page.focused = true
  page.setMaxRows(12)
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  page.render(80)
  page.handleInput('/')
  page.handleInput('model')
  page.handleInput(ENTER)
  let frame = page.render(34)
  const plain = strip(frame.join('\n'))
  assert.match(plain, /Search \[\/\]\s+model/u)
  // A real 34-cell Detail bar keeps the complete Refresh receipt and drops the
  // longer route span; the route action remains a complete body target.
  assert.match(barLine(frame), /Refresh/u)
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:route-toggle'), false,
    'the 34-cell bar drops the route action')
  const addRow = rowIndex(frame, line => line.includes('Add route [Enter]'))
  assert.ok(addRow >= 0, `the complete body Add remains:\n${frame.join('\n')}`)
  clickRow(page, frame, addRow, 34, 'Add route [Enter]')
  await settleMicrotasks()
  assert.equal(controller.snapshot().selection.patch.allowedModels?.kind, 'set')
  frame = page.render(34)
  assert.match(strip(frame.join('\n')), /Remove route \[Enter\]/u,
    'the body action flips to Remove without a bar span')
  const reads = h.directoryReadCount()
  // Manually scroll away from the selected first route (nonzero actual offset).
  page.handleInput('\x1b[6~')
  frame = page.render(34)
  const anchor = firstModel(frame)
  assert.ok(anchor !== undefined, 'the scrolled directory paints a model anchor')
  assert.doesNotMatch(strip(frame.join('\n')), /> Model 1/u, 'the selected route is offscreen')
  // r opens the dirty refresh question; Keep preserves the query/key/actual
  // manually scrolled offset and starts no read.
  page.handleInput('r')
  frame = page.render(34)
  assert.match(strip(frame.join('\n')), /Refresh discards unsaved edits\./u)
  page.handleInput(ESC)
  frame = page.render(34)
  assert.equal(h.directoryReadCount(), reads, 'Keep starts no new read')
  assert.equal(firstModel(frame), anchor, 'Keep preserves the manually scrolled anchor')
  assert.match(strip(frame.join('\n')), /Search \[\/\]\s+model/u, 'Keep preserves the query')
  assert.doesNotMatch(strip(frame.join('\n')), /> Model 1/u, 'Keep does not re-anchor the selected route')
  // Same-authority Back -> Manage reuses the same projection and offset.
  page.handleInput(ESC)
  page.render(34)
  // At the narrow dirty group the bar keeps Save+Back, so the field's complete
  // body Manage is the explicit pointer action; use it for the same-authority
  // re-entry.
  page.handleInput(END)
  frame = page.render(34)
  const manageRow = rowIndex(frame, line => line.includes('Manage [Enter]'))
  assert.ok(manageRow >= 0, `the complete body Manage remains:\n${frame.join('\n')}`)
  clickRow(page, frame, manageRow, 34, 'Manage [Enter]')
  await settleMicrotasks()
  frame = page.render(34)
  assert.equal(h.directoryReadCount(), reads, 'same-authority reuse starts no read')
  assert.equal(firstModel(frame), anchor, 'same-authority reuse preserves the anchor')
  assert.match(strip(frame.join('\n')), /Search \[\/\]\s+model/u)
  // The selected key survives; Home reveals it without a new read.
  page.handleInput(HOME)
  frame = page.render(34)
  assert.match(strip(frame.join('\n')), /> Model 1/u, 'the same selected key survives')
  // The accepted dirty refresh discards the draft, aborts the old projection
  // and reloads exactly once.
  page.handleInput('r')
  frame = page.render(34)
  assert.match(strip(frame.join('\n')), /Refresh discards unsaved edits\./u)
  page.handleInput('r')
  await h.drainTasks()
  page.render(34)
  await h.drainTasks()
  page.render(34)
  assert.equal(h.directoryReadCount(), reads + 1, 'the accepted refresh reads the current authority once')
  h.page.dispose()
})

test('route identities are sanitized in Advanced and a narrow body never paints a clipped primary verb', async () => {
  const h = await started({
    allowedModels: [{ provider: 'provider\u001b]0;OWNED\u0007', model: 'model-with-a-long-name' }],
  })
  const { page } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput('?')
  const raw = page.render(80).join('')
  assert.ok(raw.includes('provider'), 'the visible route identity remains readable')
  assert.equal(raw.includes('\u001b]0;'), false, 'the OSC identity/control introducer is stripped')
  assert.equal(raw.includes('OWNED\u0007'), false, 'the BEL-terminated control payload is stripped')
  page.handleInput(LEFT)
  page.render(80)
  const narrow = strip(page.render(8).join('\n'))
  assert.doesNotMatch(narrow, /Search \[|Add route|Remove route|Edit \[|Toggle \[|Manage \[|Details \[|Refresh \[/u,
    'a width that cannot host a primary verb paints no clipped action word')
  h.page.dispose()
})

test('a zero-body authority drift starts no directory read until a real body grant returns', async () => {
  const h = await started({
    directoryValue: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }] }],
      failures: [],
    },
  })
  const { page } = h
  page.focused = true
  selectField(page, 'Allowed models')
  page.handleInput(ENTER)
  await h.drainTasks()
  page.render(80)
  const reads = h.directoryReadCount()
  page.setMaxRows(1) // body 0: only the page's own Back
  h.replaceGeneration()
  page.render(80)
  await settleMicrotasks()
  assert.equal(h.directoryReadCount(), reads, 'a bar-only grant starts no new directory read')
  page.setMaxRows(12)
  page.render(80)
  await settleMicrotasks()
  assert.equal(h.directoryReadCount(), reads + 1, 'the returned body grant reads the current authority once')
  assert.match(strip(page.render(80).join('\n')), /Provider P/u)
  h.page.dispose()
})
