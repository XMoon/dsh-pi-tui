/** The FR5-B shared numeric Settings page: one/two-field rendering, Reset,
 * Save/Esc reachability (including 44x8), dirty discard and pointer fencing. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth, type TuiMouseEvent } from '@xmoon76/pi-tui'
import {
  HostNumericSettingsController,
  type HostNumericSettingsField,
  type HostNumericSettingsPort,
} from '../../src/app/command/host-numeric-settings.ts'
import type { SectionMutationOutcome, SectionPatch, SectionRead } from '../../src/runtime/config-port.ts'
import { HostNumericSettingsPage } from '../../src/tui/panels/host-numeric-settings-page.ts'

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')

interface ShellSettings {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

interface LoopSettings {
  readonly maxParallelToolCalls: number
}

function shellRig(options: { holdMutation?: boolean; reject?: boolean } = {}) {
  const generation = {}
  const inherited: ShellSettings = { timeoutMs: 120_000, maxOutputBytes: 64_000 }
  let effective: ShellSettings = { timeoutMs: 60_000, maxOutputBytes: 64_000 }
  let revision = 5
  const writes: Array<{ readonly patch: SectionPatch<ShellSettings>; readonly revision: number }> = []
  let releaseMutation: (() => void) | undefined
  let markMutation: (() => void) | undefined
  const mutationStarted = new Promise<void>(resolve => { markMutation = resolve })
  const port: HostNumericSettingsPort<ShellSettings> = {
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
  const fields: readonly HostNumericSettingsField<ShellSettings>[] = [
    { key: 'timeoutMs', label: 'Command timeout (ms)' },
    { key: 'maxOutputBytes', label: 'Output cap per stream (bytes)' },
  ]
  return {
    port, fields, writes,
    releaseMutation: () => { releaseMutation?.() },
    mutationStarted,
    effective: () => effective,
  }
}

function rig(options: { holdMutation?: boolean; reject?: boolean } = {}) {
  const shell = shellRig(options)
  const actions: string[] = []
  const tasks: Promise<void>[] = []
  const controller = new HostNumericSettingsController<ShellSettings>({
    port: shell.port,
    fields: shell.fields,
    requestRender: () => {},
    runOwned: (_label, task) => { tasks.push(Promise.resolve().then(task)) },
  })
  const page = new HostNumericSettingsPage<ShellSettings>({
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

async function started(options: { holdMutation?: boolean; reject?: boolean } = {}) {
  const harness = rig(options)
  harness.page.setMaxRows(12)
  harness.page.focused = true
  await harness.drain()
  return harness
}

function mouse(type: 'press' | 'click', x: number, y: number, width: number, height: number): TuiMouseEvent {
  return { type, button: 'left', x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false }
}

function rowIndex(frame: readonly string[], needle: string): number {
  return frame.findIndex(line => strip(line).includes(needle))
}

function clickRow(page: HostNumericSettingsPage<ShellSettings>, frame: readonly string[], row: number, width: number, text: string): void {
  const line = strip(frame[row] ?? '')
  const start = line.indexOf(text)
  assert.notEqual(start, -1, `painted row contains ${text}: ${JSON.stringify(line)}`)
  const x = visibleWidth(line.slice(0, start))
  assert.equal(page.handleMouse(mouse('press', x, row, width, frame.length))?.handled, true)
  page.render(width)
  assert.equal(page.handleMouse(mouse('click', x, row, width, frame.length))?.handled, true)
}

test('two fields paint their effective values, source fact and Reset actions', async () => {
  const h = await started()
  const frame = h.page.render(80)
  const plain = frame.map(strip)
  assert.match(plain[0] ?? '', /Host model-tool executor · POSIX Bash/u)
  assert.ok(plain.some(line => line.includes('Command timeout (ms)') && line.includes('60000') && line.includes('[Reset]')))
  assert.ok(plain.some(line => line.includes('Output cap per stream (bytes)') && line.includes('64000') && line.includes('[Reset]')))
  assert.ok(plain.some(line => line.includes('Source: Overridden')), 'effective/base deviation is stated')
  assert.ok(plain.some(line => line.includes('Source: Inherited')))
  assert.match(strip(frame.at(-1) ?? ''), /Back \[Esc\]/u)
  assert.ok(h.page.paintedEscapeSpan() !== undefined)
  h.page.dispose()
})

test('a field edit applies into the draft and the painted Save commits ONE Host mutation', async () => {
  const h = await started()
  let frame = h.page.render(80)
  clickRow(h.page, frame, rowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
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
  const h = await started()
  let frame = h.page.render(80)
  clickRow(h.page, frame, rowIndex(frame, 'Output cap per stream (bytes)'), 80, '[Reset]')
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
  const h = await started()
  let frame = h.page.render(80)
  clickRow(h.page, frame, rowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
  h.page.handleInput('\x15')
  for (const character of '12garbage') h.page.handleInput(character)
  h.page.handleInput(ENTER)
  h.page.handleInput('s')
  await h.drain()
  assert.equal(h.writes.length, 0, 'the invalid draft is refused before dispatch')
  assert.match(h.page.render(80).map(strip).join('\n'), /safe positive integer/u)
  h.page.dispose()
})

test('dirty Esc asks for an explicit discard; Keep keeps editing and y really leaves', async () => {
  const h = await started()
  const frame = h.page.render(80)
  clickRow(h.page, frame, rowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
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
  const h = await started()
  h.page.setMaxRows(4) // the 44x8 root body grant (content + the shared bar)
  let frame = h.page.render(44)
  let bar = strip(frame.at(-1) ?? '')
  assert.match(bar, /Back \[Esc\]/u, `the complete Esc affordance is painted:\n${bar}`)
  assert.doesNotMatch(bar, /Save \[S\]…/u, 'no partial action word is painted')
  const fieldRow = rowIndex(frame, 'Command timeout (ms)')
  assert.ok(fieldRow >= 0, 'the body still shows the field above the bar')
  clickRow(h.page, frame, fieldRow, 44, 'Command timeout (ms)')
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
  const h = await started({ holdMutation: true })
  const frame = h.page.render(80)
  clickRow(h.page, frame, rowIndex(frame, 'Command timeout (ms)'), 80, 'Command timeout (ms)')
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
  const h = await started()
  const frame = h.page.render(80)
  const row = rowIndex(frame, 'Command timeout (ms)')
  assert.equal(h.page.handleMouse(mouse('press', 1, row, 80, frame.length))?.handled, true)
  h.page.handleInput(DOWN) // a repaint with a new semantic identity
  const next = h.page.render(80)
  assert.equal(h.page.handleMouse(mouse('click', 1, row, 80, next.length)), undefined)
  // The release is refused, so no edit input was opened.
  assert.doesNotMatch(h.page.render(80).map(strip)[0] ?? '', /Edit Command timeout/u)
  h.page.dispose()
})

test('the same page renders and saves the single-field Agent-loop shape', async () => {
  const generation = {}
  let effective = { maxParallelToolCalls: 10 }
  let revision = 2
  const writes: SectionPatch<LoopSettings>[] = []
  const port: HostNumericSettingsPort<LoopSettings> = {
    read: () => ({
      kind: 'ready', generation, revision, effective: { ...effective },
      inherited: { maxParallelToolCalls: 10 },
      overridden: { maxParallelToolCalls: effective.maxParallelToolCalls !== 10 },
    }),
    refresh: async () => {},
    mutate: async (patch, expectedRevision) => {
      writes.push(patch)
      if (expectedRevision !== revision) return { kind: 'conflict', reason: 'revision changed' }
      const edit = patch.maxParallelToolCalls!
      effective = { maxParallelToolCalls: edit.kind === 'reset' ? 10 : edit.value }
      revision += 1
      return { kind: 'accepted' }
    },
  }
  const fields: readonly HostNumericSettingsField<LoopSettings>[] = [
    { key: 'maxParallelToolCalls', label: 'Parallel tool calls' },
  ]
  const tasks: Promise<void>[] = []
  const controller = new HostNumericSettingsController<LoopSettings>({
    port,
    fields,
    requestRender: () => {},
    runOwned: (_label, task) => { tasks.push(Promise.resolve().then(task)) },
  })
  const actions: string[] = []
  const page = new HostNumericSettingsPage<LoopSettings>({
    controller,
    fields,
    spec: {
      title: 'Agent loop',
      sourceHeading: source => source.kind === 'ready' ? 'Host profile · effective settings' : 'Host profile · unavailable',
      help: ['The next Agent step reads the new cap.'],
    },
    requestRender: () => {},
    done: () => { actions.push('done') },
  })
  page.setMaxRows(10)
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const rendered = page.render(80).map(strip).join('\n')
  assert.match(rendered, /Host profile · effective settings/u)
  assert.match(rendered, /Parallel tool calls/u)
  assert.equal((rendered.match(/\[Reset\]/gu) ?? []).length, 1, 'the single numeric field exposes ONE Reset')
  page.handleInput(ENTER) // open the only field
  page.handleInput('\x15')
  for (const character of '4') page.handleInput(character)
  page.handleInput(ENTER)
  page.handleInput('s')
  for (let turn = 0; turn < 8; turn += 1) await Promise.all(tasks.splice(0))
  assert.deepEqual(writes, [{ maxParallelToolCalls: { kind: 'set', value: 4 } }])
  page.dispose()
})
