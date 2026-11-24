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

// ── FR5-B: the shared host numeric page ──────────────────────────────────

interface NumericShellSettings {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

interface NumericLoopSettings {
  readonly maxParallelToolCalls: number
}

function numericShellRig(options: { holdMutation?: boolean; reject?: boolean } = {}) {
  const generation = {}
  const inherited: NumericShellSettings = { timeoutMs: 120_000, maxOutputBytes: 64_000 }
  let effective: NumericShellSettings = { timeoutMs: 60_000, maxOutputBytes: 64_000 }
  let revision = 5
  const writes: Array<{ readonly patch: SectionPatch<NumericShellSettings>; readonly revision: number }> = []
  let releaseMutation: (() => void) | undefined
  let markMutation: (() => void) | undefined
  const mutationStarted = new Promise<void>(resolve => { markMutation = resolve })
  const port: HostNumericSettingsPort<NumericShellSettings> = {
    read: () => ({
      kind: 'ready', generation, revision,
      effective: { ...effective }, inherited: { ...inherited },
      overridden: {
        timeoutMs: effective.timeoutMs !== inherited.timeoutMs,
        maxOutputBytes: effective.maxOutputBytes !== inherited.maxOutputBytes,
      },
    }),
    refresh: async () => {},
    mutate: async (patch, expectedRevision): Promise<SectionMutationOutcome> => {
      writes.push({ patch, revision: expectedRevision })
      markMutation?.()
      if (options.holdMutation === true) {
        await new Promise<void>(resolve => { releaseMutation = resolve })
      }
      if (options.reject === true) return { kind: 'rejected', reason: 'official validator refused the caps' }
      if (expectedRevision !== revision) return { kind: 'conflict', reason: 'revision changed' }
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
  const positiveFinite = (text: string): boolean => {
    if (text.trim() === '') return false
    const value = Number(text)
    return Number.isFinite(value) && value > 0
  }
  const fields: readonly HostNumericSettingsField<NumericShellSettings>[] = [
    { key: 'timeoutMs', label: 'Command timeout (ms)', validate: positiveFinite, invalidHint: 'Enter a positive finite number.' },
    { key: 'maxOutputBytes', label: 'Output cap per stream (bytes)', validate: positiveFinite, invalidHint: 'Enter a positive finite number.' },
  ]
  return {
    port, fields, writes,
    releaseMutation: () => { releaseMutation?.() },
    mutationStarted,
    effective: () => effective,
  }
}

function numericRig(options: { holdMutation?: boolean; reject?: boolean } = {}) {
  const shell = numericShellRig(options)
  const actions: string[] = []
  const tasks: Promise<void>[] = []
  const controller = new HostNumericSettingsController<NumericShellSettings>({
    port: shell.port,
    fields: shell.fields,
    requestRender: () => {},
    runOwned: (_label, task) => { tasks.push(Promise.resolve().then(task)) },
  })
  const page = new HostNumericSettingsPage<NumericShellSettings>({
    controller,
    fields: shell.fields,
    spec: {
      title: 'Shell execution',
      sourceHeading: source => source.kind === 'ready'
        ? 'Host model-tool executor · POSIX Bash'
        : 'Host model-tool executor · unavailable',
      help: ['Both caps save as one Host mutation.', 'Reset stages the official unset operation.'],
    },
    requestRender: () => {},
    done: () => { actions.push('done') },
  })
  return {
    page, controller, writes: shell.writes, actions,
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

async function startedNumeric(options: { holdMutation?: boolean; reject?: boolean } = {}) {
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

test('two fields paint their effective values, source fact and Reset actions', async () => {
  const h = await startedNumeric()
  const frame = h.page.render(80)
  const plain = frame.map(strip)
  assert.match(plain[0] ?? '', /Host model-tool executor · POSIX Bash/u)
  assert.ok(plain.some(line => line.includes('Command timeout (ms)') && line.includes('60000') && line.includes('[Reset]')))
  assert.ok(plain.some(line => line.includes('Output cap per stream (bytes)') && line.includes('64000') && line.includes('[Reset]')))
  assert.ok(plain.some(line => line.includes('Comparison: Differs from base')), 'effective/base deviation is stated')
  assert.ok(plain.some(line => line.includes('Comparison: Matches base')))
  assert.match(strip(frame.at(-1) ?? ''), /Back \[Esc\]/u)
  assert.ok(h.page.paintedEscapeSpan() !== undefined)
  h.page.dispose()
})

test('a field edit applies into the draft and the painted Save commits ONE Host mutation', async () => {
  const h = await startedNumeric()
  let frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
  frame = h.page.render(80)
  assert.match(strip(frame[0] ?? ''), /Edit Command timeout \(ms\)/u)
  h.page.handleInput('\x15') // clear the current draft like the real single-line editor
  for (const character of ['4', '5', '0', '0', '0']) h.page.handleInput(character)
  h.page.handleInput(ENTER) // Apply the field draft
  frame = h.page.render(80)
  assert.ok(frame.map(strip).some(line => line.includes('45000')), 'the staged value is painted')
  assert.ok(h.page.paintedBarSpans().some(span => span.id === 'bar:save'), 'the Save span is really painted')
  assert.ok(h.page.paintedBarSpans().some(span => span.id === 'bar:save'))
  h.page.activateBarSpan('bar:save')
  await h.drain()
  assert.equal(h.writes.length, 1, 'one Save is one Host mutation')
  assert.deepEqual(h.writes[0]?.patch, { timeoutMs: { kind: 'set', value: 45_000 } })
  const settled = h.page.render(80).map(strip).join('\n')
  assert.match(settled, /Status: Verified/u)
  h.page.dispose()
})

test('the painted Reset stages the official unset intent and keeps the page dirty', async () => {
  const h = await startedNumeric()
  let frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Output cap per stream (bytes)'), 80, '[Reset]')
  frame = h.page.render(80)
  const plain = frame.map(strip).join('\n')
  assert.match(plain, /Reset staged/u)
  assert.match(plain, /Status: Unsaved/u)
  assert.equal(h.writes.length, 0, 'Reset only stages; Save dispatch is separate')
  const bars = h.page.paintedBarSpans()
  assert.ok(bars.some(span => span.id === 'bar:save'))
  h.page.dispose()
})

test('an invalid non-integer never saves and keeps the field error reachable', async () => {
  const h = await startedNumeric()
  let frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
  h.page.handleInput('\x15')
  for (const character of '12garbage') h.page.handleInput(character)
  h.page.handleInput(ENTER)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 0, 'the invalid draft is refused before dispatch')
  assert.match(h.page.render(80).map(strip).join('\n'), /positive finite number/u)
  h.page.dispose()
})

test('the Shell page accepts the official positive-finite decimal shape', async () => {
  const h = await startedNumeric()
  let frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
  h.page.handleInput('\x15')
  for (const character of '1.5') h.page.handleInput(character)
  h.page.handleInput(ENTER)
  frame = h.page.render(80)
  assert.ok(frame.map(strip).some(line => line.includes('1.5')), 'the fractional draft is painted')
  assert.ok(h.page.paintedBarSpans().some(span => span.id === 'bar:save'))
  h.page.activateBarSpan('bar:save')
  await h.drain()
  assert.deepEqual(h.writes[0]?.patch, { timeoutMs: { kind: 'set', value: 1.5 } })
  assert.match(h.page.render(80).map(strip).join('\n'), /Status: Verified/u)
  h.page.dispose()
})

test('dirty Esc asks for an explicit discard; Keep keeps editing and y really leaves', async () => {
  const h = await startedNumeric()
  const frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
  h.page.handleInput('\x15')
  for (const character of ['4', '5', '0', '0', '0']) h.page.handleInput(character)
  h.page.handleInput(ENTER)
  h.page.handleInput(ESC)
  const question = h.page.render(80).map(strip).join('\n')
  assert.match(question, /Discard unsaved changes\? y\/N/u)
  h.page.handleInput('n')
  assert.deepEqual(h.actions, [], 'Keep stays on the page')
  h.page.handleInput(ESC)
  const second = h.page.render(80).map(strip).join('\n')
  assert.match(second, /Discard unsaved changes\? y\/N/u, 'the receipt question is painted before an answer counts')
  h.page.handleInput('y')
  assert.deepEqual(h.actions, ['done'], 'the explicit discard leaves the page')
  h.page.dispose()
})

test('44x8 keeps Save and the complete Esc affordance reachable without a partial bar', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(4) // the 44x8 root body grant (content + the shared bar)
  let frame = h.page.render(44)
  let bar = strip(frame.at(-1) ?? '')
  assert.match(bar, /Back \[Esc\]/u, `the complete Esc affordance is painted:\n${bar}`)
  assert.doesNotMatch(bar, /Save \[S\]…/u, 'no partial action word is painted')
  const fieldRow = numericRowIndex(frame, 'Command timeout (ms)')
  assert.ok(fieldRow >= 0, 'the body still shows the field above the bar')
  clickNumericRow(h.page, frame, fieldRow, 44, 'Command timeout (ms)')
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.handleInput(ENTER)
  frame = h.page.render(44)
  bar = strip(frame.at(-1) ?? '')
  assert.match(bar, /Save \[S\]/u, 'the dirty short page paints Save')
  assert.match(bar, /Back \[Esc\]/u, 'and keeps Esc')
  h.page.dispose()
})

test('a pending save blocks the exit and never repaints a closed page', async () => {
  const h = await startedNumeric({ holdMutation: true })
  const frame = h.page.render(80)
  clickNumericRow(h.page, frame, numericRowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
  h.page.handleInput('\x15')
  for (const character of '45000') h.page.handleInput(character)
  h.page.handleInput(ENTER)
  h.page.handleInput('s')
  await h.mutationStarted
  h.page.handleInput(ESC)
  assert.deepEqual(h.actions, [], 'the page cannot close while the Host write is unsettled')
  assert.match(h.page.render(80).map(strip).join('\n'), /Dispatched writes continue/u)
  h.page.dispose()
  h.releaseMutation()
  await h.drain()
  assert.deepEqual(h.actions, [], 'the disposed page stays closed')
})

test('a stale pointer press cannot commit against a newer painted frame', async () => {
  const h = await startedNumeric()
  const frame = h.page.render(80)
  const row = numericRowIndex(frame, 'Command timeout (ms)')
  assert.equal(h.page.handleMouse(mouse('press', 1, row, 80, frame.length))?.handled, true)
  h.page.handleInput(DOWN) // a repaint with a new semantic identity
  const next = h.page.render(80)
  assert.equal(h.page.handleMouse(mouse('click', 1, row, 80, next.length)), undefined)
  // The release is refused, so no edit input was opened.
  assert.doesNotMatch(h.page.render(80).map(strip)[0] ?? '', /Edit Command timeout/u)
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
  assert.match(plain(), /Verified/u)
  assert.doesNotMatch(plain(), /Save \[S\]/u, 'the Verified state never advertises a second save')
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

test('the numeric page status distinguishes Ready, Unavailable, Unreadable and Last-known', async () => {
  interface SectionSettings {
    readonly timeoutMs: number
  }
  const fields: readonly HostNumericSettingsField<SectionSettings>[] = [{ key: 'timeoutMs', label: 'Command timeout (ms)' }]
  const renderWith = async (read: () => SectionRead<SectionSettings>): Promise<{ text: string; dispose: () => void }> => {
    const controller = new HostNumericSettingsController<SectionSettings>({
      port: { read, refresh: async () => {}, mutate: async () => ({ kind: 'rejected', reason: 'n/a' }) },
      fields,
      requestRender: () => {},
      runOwned: (_label, task) => { void task() },
    })
    const page = new HostNumericSettingsPage<SectionSettings>({
      controller,
      fields,
      spec: { title: 'Test', sourceHeading: () => 'Host profile', help: [] },
      requestRender: () => {},
      done: () => {},
    })
    page.setMaxRows(8)
    // Let the controller's initial authoritative refresh settle.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    const text = page.render(80).map(strip).join('\n')
    void controller
    return { text, dispose: () => page.dispose() }
  }

  const unavailable = await renderWith(() => ({ kind: 'unavailable', reason: 'not mounted' }))
  assert.match(unavailable.text, /Status: Unavailable/u, 'a missing namespace is never Ready')
  unavailable.dispose()

  const unreadable = await renderWith(() => ({ kind: 'unreadable', reason: 'value is not readable' }))
  assert.match(unreadable.text, /Status: Unreadable/u)
  unreadable.dispose()

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
    spec: { title: 'Test', sourceHeading: () => 'Host profile', help: [] },
    requestRender: () => {},
    done: () => {},
  })
  page.setMaxRows(8)
  await Promise.resolve()
  await Promise.resolve()
  assert.match(page.render(80).map(strip).join('\n'), /Status: Ready/u)
  revision = 2
  assert.match(page.render(80).map(strip).join('\n'), /Status: Last-known · read-only/u,
    'an external edit never leaves the fixed status claiming Ready')
  page.dispose()
})

test('44x8 paints the SECOND field Reset whole and its pointer target stages that field', async () => {
  const h = await startedNumeric()
  h.page.setMaxRows(4) // the 44x8 body grant
  let frame = h.page.render(44)
  // Move the field focus to the second field; the short grant scrolls it in.
  h.page.handleInput(DOWN)
  frame = h.page.render(44)
  const capRow = numericRowIndex(frame, 'Output cap per stream')
  assert.ok(capRow >= 0, `the second field is reachable at 44x8:\n${frame.join('\n')}`)
  const capLine = strip(frame[capRow] ?? '')
  assert.match(capLine, /\[Reset\]$/u, `the complete Reset is painted at the right edge: ${JSON.stringify(capLine)}`)
  clickNumericRow(h.page, frame, capRow, 44, '[Reset]')
  frame = h.page.render(44)
  assert.match(frame.map(strip).join('\n'), /Output cap per stre\S*\s+Reset staged/u,
    'the painted second-field Reset target stages THAT field')
  assert.match(frame.map(strip).join('\n'), /Status: Unsaved/u)
  h.page.dispose()
})
