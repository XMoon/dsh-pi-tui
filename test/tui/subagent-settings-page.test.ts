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

const positiveFiniteText = (text: string): boolean => {
  if (text.trim() === '') return false
  const value = Number(text)
  return Number.isFinite(value) && value > 0
}

function numericShellRig(options: { holdMutation?: boolean; reject?: boolean; unconfirmed?: boolean } = {}) {
  const generation = {}
  let revision = 1
  let effective: NumericShellSettings = { timeoutMs: 60_000, maxOutputBytes: 64_000 }
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
  return { port, fields, writes, inherited, effective: () => ({ ...effective }), releaseMutation: () => { releaseMutation?.() }, mutationStarted: started }
}

function numericRig(options: { holdMutation?: boolean; reject?: boolean; unconfirmed?: boolean; onRender?: () => void } = {}) {
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

async function startedNumeric(options: { holdMutation?: boolean; reject?: boolean; unconfirmed?: boolean; onRender?: () => void } = {}) {
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
  assert.equal(h.writes[0]?.generation, (h.page.render(80), h.writes[0]?.generation))
  assert.deepEqual(h.effective(), { timeoutMs: 45_000, maxOutputBytes: 128_000 })
  plain = h.page.render(80).map(strip).join('\n')
  assert.match(plain, /Status\s+Verified/u)
  assert.match(plain, /^> Output cap per stream \(bytes\)/mu, 'the SAME group stays mounted with its field selection')
  assert.doesNotMatch(plain, /Save \[S\]|unsaved change/u, 'a verified group advertises no second Save')
  assert.deepEqual(h.actions, [], 'Save never navigates by itself')
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
  assert.match(h.page.render(80).map(strip).join('\n'), /Status\s+Verified/u)
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
  assert.match(plain, /Status\s+Verified/u)
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
  assert.match(h.page.render(80).map(strip).join('\n'), /Status\s+Verified/u, 'the admitted batch still settles')
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
  assert.match(h.page.render(44).map(strip).join('\n'), /Status\s+Verified/u)
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
  h.page.setMaxRows(12)
  frame = h.page.render(80)
  assert.match(strip(frame.at(-1) ?? ''), /Save(?: \[S\])? · Discard (?:and leave )?\[D\] · Keep \[Esc\]/u)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 1)
  assert.match(h.page.render(80).map(strip).join('\n'), /Status\s+Verified/u)
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
  assert.match(plain, /Status\s+Outcome unconfirmed/u)
  assert.match(plain, /possibly saved;\s+refresh before retrying/u)
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
  assert.match(h.page.render(80).map(strip).join('\n'), /Outcome unconfirmed/u)
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
  assert.match(h.page.render(26).map(strip).join('\n'), /Status\s+Outcome unconfirmed/u)
  h.page.handleInput(ESC)
  frame = h.page.render(26)
  const row = numericRowIndex(frame, 'Leave anyway…')
  assert.ok(row >= 0, `the body answer is painted:\n${frame.join('\n')}`)
  clickNumericRow(h.page, frame, row, 26, 'Leave anyway…')
  assert.deepEqual(h.actions, ['done'])
  assert.equal(h.writes.length, 1, 'leaving never retries the uncertain write')
  h.page.dispose()
})

test('a refused grouped Save is read-only until Refresh, and its local Discard stays a real body action', async () => {
  const h = await startedNumeric({ reject: true })
  stageNumeric(h.page, 80, '\x15', '45000')
  h.page.handleInput('s')
  await h.drain()
  let frame = h.page.render(80)
  let plain = frame.map(strip).join('\n')
  assert.match(plain, /Status\s+Not saved/u)
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
  assert.doesNotMatch(plain, /Status\s+Not saved/u)
  assert.doesNotMatch(plain, /Save \[S\]|Edit \[Enter\]/u, 'the stale capture is still read-only')
  assert.equal(h.writes.length, 1, 'discarding never dispatches another write')
  h.page.handleInput('r')
  await h.drain()
  assert.match(strip(h.page.render(80).at(-1) ?? ''), /Edit \[Enter\]/u, 'an explicit Refresh re-enables editing')
  h.page.dispose()
})
