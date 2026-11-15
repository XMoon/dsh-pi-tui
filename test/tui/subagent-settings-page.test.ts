/** Local presentation and pointer-fence tests for SubagentSettingsPage. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth, type TuiMouseEvent } from '@xmoon76/pi-tui'
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
import { SubagentSettingsPage } from '../../src/tui/panels/subagent-settings-page.ts'

const ENTER = '\r'
const ESC = '\x1b'
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

test('numeric Apply and Reset stage controller operations while Cancel keeps the staged draft', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.focused = true
  let frame = page.render(80)
  let depthRow = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  assert.notEqual(depthRow, -1)
  clickRow(page, frame, depthRow, 80, 'Maximum recursion depth')
  frame = page.render(80)
  assert.match(strip(frame[frame.length - 1] ?? ''), /Apply \[Enter\].*Cancel \[Esc\]/u)
  assert.ok(page.paintedEscapeSpan(), 'the Root receives a painted Cancel/Esc target')
  page.handleInput('2')
  frame = page.render(80)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:apply'))
  page.activateBarSpan('bar:apply')
  assert.equal(controller.snapshot().depthText, '12')
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(harness.writes.length, 0)

  frame = page.render(80)
  const resetRow = rowIndex(frame, line => line.includes('Source: Inherited') && line.includes('Reset'))
  assert.notEqual(resetRow, -1)
  clickRow(page, frame, resetRow, 80, 'Reset')
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'reset' })
  assert.equal(controller.snapshot().depthText, '')
  assert.equal(harness.writes.length, 0)

  frame = page.render(80)
  depthRow = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  clickRow(page, frame, depthRow, 80, 'Maximum recursion depth')
  page.render(80)
  page.handleInput('9')
  page.render(80)
  page.handleInput(ESC)
  assert.equal(controller.snapshot().depthText, '')
  assert.deepEqual(controller.snapshot().limits.patch.maxDepth, { kind: 'reset' })
  assert.equal(harness.writes.length, 0)
})

test('directory toggles and search text stay in the draft without Host writes', async () => {
  const harness = await started({ allowedModels: [{ provider: 'p', model: 'saved-model' }] })
  const { page, controller } = harness
  page.focused = true
  for (let index = 0; index < 3; index += 1) page.handleInput(DOWN)
  page.handleInput(ENTER)
  await harness.drainTasks()
  let frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Provider P/u)
  assert.match(frame.map(strip).join('\n'), /saved-model/u)

  const savedRow = rowIndex(frame, line => line.includes('saved-model'))
  clickRow(page, frame, savedRow, 80, 'saved-model')
  assert.deepEqual(controller.snapshot().allowedModels, [])
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(harness.writes.length, 0)

  page.handleInput('/')
  page.handleInput('s')
  frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Search: s/u)
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(harness.writes.length, 0)
  page.handleInput(ESC)
  frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Allowed models/u)
  assert.deepEqual(controller.snapshot().allowedModels, [])
  assert.equal(harness.writes.length, 0)
})

test('failed directory reads keep saved routes visible and removable', async () => {
  const harness = await started({
    allowedModels: [{ provider: 'missing-provider', model: 'saved-model' }],
    directoryError: new Error('directory offline'),
  })
  const { page } = harness
  page.focused = true
  for (let index = 0; index < 3; index += 1) page.handleInput(DOWN)
  page.handleInput(ENTER)
  await harness.drainTasks()
  const frame = page.render(80)
  const painted = frame.map(strip).join('\n')
  assert.match(painted, /saved-model/u)
  assert.match(painted, /catalog unavailable/u)
  assert.doesNotMatch(painted, /not in the current catalog/u)
  assert.equal(harness.writes.length, 0)
})

test('dirty Escape requires a newly painted confirmation before Discard returns to Agent', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.focused = true
  page.handleInput(ENTER)
  page.handleInput('2')
  page.handleInput(ENTER)
  assert.equal(controller.snapshot().dirty, true)

  page.handleInput(ESC)
  page.handleInput('y')
  assert.equal(controller.snapshot().dirty, true, 'an answer before the new question frame is refused')
  assert.equal(harness.dones.length, 0)

  let frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Discard unsaved changes\? y\/N/u)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:discard'))
  page.handleInput('n')
  assert.equal(controller.snapshot().dirty, true, 'No keeps the staged value')

  page.handleInput(ESC)
  page.handleInput('y')
  assert.equal(controller.snapshot().dirty, true, 'the second question also requires its own painted fact')
  frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Discard unsaved changes\? y\/N/u)
  page.activateBarSpan('bar:discard')
  assert.equal(controller.snapshot().dirty, false)
  assert.deepEqual(harness.dones, [1])
  assert.equal(harness.writes.length, 0)
})

test('dirty Refresh asks before discard and refreshes only after the painted answer', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.focused = true
  page.handleInput(ENTER)
  page.handleInput('2')
  page.handleInput(ENTER)
  const initialRefreshes = harness.refreshCount()

  page.handleInput('r')
  assert.equal(harness.refreshCount(), initialRefreshes)
  let frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Discard unsaved changes\? y\/N/u)
  page.handleInput('y')
  await harness.drainTasks()
  assert.equal(controller.snapshot().dirty, false)
  assert.equal(harness.refreshCount(), initialRefreshes + 2)
  assert.equal(controller.snapshot().loading, false)
  assert.equal(harness.writes.length, 0)
})

test('Save freezes edits and a rejected section does not hide the independently verified section', async () => {
  const harness = await started({
    allowedModels: [{ provider: 'p', model: 'm' }],
    holdLimits: true,
    rejectLimits: true,
  })
  const { page, controller } = harness
  page.focused = true
  page.handleInput(ENTER)
  page.handleInput('2')
  page.handleInput(ENTER)
  page.handleInput(DOWN)
  page.handleInput(DOWN)
  page.handleInput(ENTER)
  assert.equal(controller.snapshot().enabled, true)
  assert.equal(controller.snapshot().dirty, true)

  let frame = page.render(80)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:save'))
  page.activateBarSpan('bar:save')
  assert.equal(controller.snapshot().saving, true)
  await harness.limitsDispatched
  assert.deepEqual(harness.writes.map(write => write.section), ['limits'])
  page.activateBarSpan('bar:save')
  page.handleInput(DOWN)
  page.handleInput(ENTER)
  assert.equal(controller.snapshot().enabled, true, 'input cannot change a saving draft')
  assert.equal(harness.writes.length, 1, 'repeated Save never dispatches a second section write')

  frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Limits: Saving/u)
  assert.doesNotMatch(frame.map(strip).at(-1) ?? '', /Save \[S\]/u)
  harness.releaseLimits()
  await harness.drainTasks()
  assert.deepEqual(harness.writes.map(write => write.section), ['limits', 'selection'])
  assert.equal(controller.snapshot().limits.status?.kind, 'not-saved')
  assert.equal(controller.snapshot().selection.status?.kind, 'verified')
  assert.equal(controller.snapshot().limits.dirty, true)
  assert.equal(controller.snapshot().selection.dirty, false)
  frame = page.render(80)
  assert.match(frame.map(strip).join('\n'), /Limits: Not saved/u)
  assert.match(frame.map(strip).join('\n'), /Selection: Verified/u)
})

test('a terminal-sized duplicate click does not consume the admitted body press', async () => {
  const harness = await started()
  const { page } = harness
  page.focused = true
  page.setMaxRows(12)
  const frame = page.render(80)
  const row = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  assert.notEqual(row, -1)
  const x = 3
  assert.equal(page.handleMouse(mouse('press', x, row, 80, frame.length))?.handled, true)
  // The screen can forward the release once with the terminal dimensions before
  // the Root's body grant dimensions. The first must be inert AND must not
  // consume the press; the grant-sized event is the ONE real activation.
  assert.equal(page.handleMouse(mouse('click', x, row, 80, 40)), undefined)
  page.render(80)
  assert.equal(page.handleMouse(mouse('click', x, row, 80, frame.length))?.handled, true)
  let opened = false
  for (let step = 0; step < 8 && !opened; step += 1) {
    opened = page.render(80).map(strip).some(line => line.includes('Edit Maximum recursion depth'))
  }
  assert.equal(opened, true, 'the grant-sized release really activated the field')
  assert.equal(harness.writes.length, 0)
})

test('a valid body click released outside the pressed target retires that gesture', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.focused = true
  page.setMaxRows(12)
  const frame = page.render(80)
  const row = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  assert.notEqual(row, -1)
  assert.equal(page.handleMouse(mouse('press', 3, row, 80, frame.length))?.handled, true)
  assert.equal(page.handleMouse(mouse('click', 79, row, 80, frame.length)), undefined)
  assert.equal(page.handleMouse(mouse('click', 3, row, 80, frame.length)), undefined,
    'a later same-cell click cannot inherit a press released outside its target')
  assert.equal(controller.snapshot().dirty, false)
  assert.equal(harness.writes.length, 0)
})

test('a Host generation replacement after pointer press revokes the painted field target', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.focused = true
  page.setMaxRows(12)
  const frame = page.render(80)
  const row = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  assert.notEqual(row, -1)
  const x = 3
  assert.equal(page.handleMouse(mouse('press', x, row, 80, frame.length))?.handled, true)
  const identity = page.gestureIdentity()
  harness.replaceGeneration()
  assert.notEqual(page.gestureIdentity(), identity)
  assert.equal(page.handleMouse(mouse('click', x, row, 80, frame.length)), undefined)
  assert.equal(controller.snapshot().limits.current, false)
  assert.equal(controller.snapshot().dirty, false)
  assert.equal(harness.writes.length, 0)
})

test('keyboard, scrolling, resize and replacement question frames revoke old pointer targets', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.focused = true
  let frame = page.render(80)
  let row = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  assert.equal(page.handleMouse(mouse('press', 3, row, 80, frame.length))?.handled, true)
  page.handleInput(DOWN)
  assert.equal(page.handleMouse(mouse('click', 3, row, 80, frame.length)), undefined)
  assert.equal(controller.snapshot().dirty, false)

  frame = page.render(80)
  row = rowIndex(frame, line => line.includes('Maximum recursion depth'))
  assert.equal(page.handleMouse(mouse('press', 3, row, 80, frame.length))?.handled, true)
  page.handleMouse({ ...mouse('press', 3, row, 80, frame.length), type: 'wheel', wheelDelta: 1 })
  assert.equal(page.handleMouse(mouse('click', 3, row, 80, frame.length)), undefined)
  assert.equal(controller.snapshot().dirty, false)

  frame = page.render(80)
  row = rowIndex(frame, line => line.includes('Subagent parallelism'))
  assert.equal(page.handleMouse(mouse('press', 3, row, 80, frame.length))?.handled, true)
  page.setMaxRows(8)
  assert.equal(page.handleMouse(mouse('click', 3, row, 80, frame.length)), undefined)
  assert.equal(controller.snapshot().dirty, false)

  controller.reset('maxDepth')
  page.handleInput(ESC)
  page.setMaxRows(1)
  frame = page.render(44)
  assert.equal(frame.length, 1)
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:discard'), false)
  page.handleInput('y')
  assert.equal(controller.snapshot().dirty, true, 'an unpainted discard fact stays blocked at the physical floor')
  page.handleInput(ESC)
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(harness.writes.length, 0)
})

test('CJK provider and model rows stay cell-accurate and toggle by their painted route identity', async () => {
  const harness = await started({
    directoryValue: {
      default: { provider: '提供者', model: '模型甲' },
      routableProviders: ['提供者'],
      groups: [{ id: '提供者', name: '模型服务商', models: [{ id: '模型甲', name: '模型甲' }] }],
      failures: [],
    },
  })
  const { page, controller } = harness
  page.focused = true
  page.setMaxRows(8)
  for (let index = 0; index < 3; index += 1) page.handleInput(DOWN)
  page.handleInput(ENTER)
  await harness.drainTasks()
  let frame: string[] = []
  for (const width of [200, 120, 100, 80, 72, 44]) {
    frame = page.render(width)
    assert.equal(frame.length, 8)
    assert.ok(frame.every(line => visibleWidth(line) <= width))
    assert.match(strip(frame[frame.length - 1] ?? ''), /Back \[Esc\]/u)
  }
  const routeRow = rowIndex(frame, line => line.includes('模型甲'))
  assert.notEqual(routeRow, -1)
  clickRow(page, frame, routeRow, 44, '模型甲')
  assert.deepEqual(controller.snapshot().allowedModels, [{ provider: '提供者', model: '模型甲' }])
  assert.equal(harness.writes.length, 0)
})

test('44 by 8 keeps a truthful pinned status and a complete reachable action bar', async () => {
  const harness = await started()
  const { page, controller } = harness
  page.setMaxRows(8)
  controller.setNumber('maxDepth', '999999999999999999999')
  const frame = page.render(44)
  assert.equal(frame.length, 8)
  assert.ok(frame.every(line => visibleWidth(line) <= 44))
  const plain = frame.map(strip)
  assert.ok(plain.slice(0, -1).some(line => line.includes('Enter a safe integer')))
  const bar = plain[plain.length - 1] ?? ''
  assert.match(bar, /Save \[S\]/u, 'the short-screen dirty page keeps Save painted')
  assert.match(bar, /Back \[Esc\]/u)
  assert.equal(visibleWidth(bar), 44)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:save'), 'Save has a live hit span at 44 by 8')
  page.activateBarSpan('bar:save')
  assert.match(strip(page.render(44).join('\n')), /Enter a safe integer/u, 'Save leaves the field error visible')
  assert.equal(harness.writes.length, 0)
})
