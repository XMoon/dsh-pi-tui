/**
 * The clickable Dock Queue pane (PR-Q): the ` Queue · N` header with its
 * right-aligned `Manage [Key]` affordance and one navigation-only click target
 * per queued row.
 *
 * The pane is a pinned-chrome component, so the tests drive its real
 * `render(width)` and synthetic press/click events: the click identity comes
 * from the LAST painted frame, and a repaint between press and release can
 * never retarget the gesture. PiTui enables terminal mouse reporting only on the
 * fullscreen alt screen; the regular main screen keeps keyboard-only access.
 *
 * @module @xmoon76/dsh-pi-tui/queue-dock-pointer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth, type TuiMouseEvent } from '@xmoon76/pi-tui'
import { DockQueue, type DockQueueModel } from '../../src/tui/queue/dock-queue.ts'

function model(overrides: Partial<DockQueueModel> = {}): DockQueueModel {
  return {
    rows: [
      { id: 'occ-1', text: 'check the API compatibility', local: false },
      { id: 'occ-2', text: 'run the whole suite', local: false },
    ],
    running: true,
    steerKey: 'Ctrl+S',
    recallKey: 'Alt+Up',
    manageKey: 'Alt+I',
    viewer: false,
    ...overrides,
  }
}

function pointer(y: number, x: number, width: number, type: 'press' | 'click' | 'release'): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  }
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/gu, '')
}

function harness(initial: DockQueueModel) {
  const opens: Array<string | undefined> = []
  const dock = new DockQueue({ open: id => { opens.push(id) } })
  dock.setModel(initial)
  return { dock, opens }
}

test('the header replaces the old rule with Queue · N and a right-aligned Manage label', () => {
  const { dock } = harness(model())
  for (const width of [120, 80, 64, 40]) {
    const lines = dock.render(width)
    assert.ok(lines.length > 0)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `row fits ${width}:\n${line}`)
    const header = plain(lines[0]!)
    assert.ok(header.includes('Queue · 2'), `the authoritative count is painted at ${width}:\n${header}`)
    assert.ok(header.includes('Manage [Alt+I]'), `the LIVE binding label is painted at ${width}:\n${header}`)
  }
})

test('a disabled queue-open binding paints Manage without a dead key hint', () => {
  const { dock } = harness(model({ manageKey: '' }))
  const header = plain(dock.render(80)[0]!)
  assert.ok(header.includes('Manage'))
  assert.ok(!header.includes('['), 'no dead shortcut bracket is painted')
})

test('the Manage header is a real click target that opens Browse', () => {
  const { dock, opens } = harness(model())
  const width = 80
  const lines = dock.render(width)
  const x = plain(lines[0]!).indexOf('Manage')
  assert.ok(x > 0)
  dock.handleMouse(pointer(0, x, width, 'press'))
  dock.handleMouse(pointer(0, x, width, 'release'))
  dock.handleMouse(pointer(0, x, width, 'click'))
  assert.deepEqual(opens, [undefined], 'Manage opens without an occurrence id')
})

test('a Host row click opens the manager with that exact occurrence id', () => {
  const { dock, opens } = harness(model())
  const width = 80
  const lines = dock.render(width)
  const row = lines.findIndex(line => plain(line).includes('run the whole suite'))
  assert.ok(row > 0)
  const x = plain(lines[row]!).indexOf('run the whole suite')
  dock.handleMouse(pointer(row, x, width, 'press'))
  dock.handleMouse(pointer(row, x, width, 'release'))
  dock.handleMouse(pointer(row, x, width, 'click'))
  assert.deepEqual(opens, ['occ-2'], 'the Host occurrence id is the preselection hint')
})

test('a client-local sending echo opens Browse without a fabricable occurrence id', () => {
  const { dock, opens } = harness(model({
    rows: [{ id: 'req-1', text: 'queued locally', local: true }],
  }))
  const width = 80
  const lines = dock.render(width)
  assert.ok(plain(lines[0]!).includes('Queue · 0'), 'a local echo is not counted as a Host occurrence')
  const row = lines.findIndex(line => plain(line).includes('queued locally'))
  assert.ok(row > 0)
  dock.handleMouse(pointer(row, 2, width, 'press'))
  dock.handleMouse(pointer(row, 2, width, 'release'))
  dock.handleMouse(pointer(row, 2, width, 'click'))
  assert.deepEqual(opens, [undefined], 'no fabricated Host id from a local echo')
})

test('a repaint between press and release cannot retarget the click', () => {
  const { dock, opens } = harness(model())
  const width = 80
  const lines = dock.render(width)
  const row = lines.findIndex(line => plain(line).includes('check the API compatibility'))
  assert.ok(row > 0)
  dock.handleMouse(pointer(row, 2, width, 'press'))
  dock.handleMouse(pointer(row, 2, width, 'release'))
  // The Host queue changed and the pane repainted the same physical row.
  dock.setModel(model({
    rows: [{ id: 'occ-9', text: 'a different message', local: false }],
  }))
  dock.render(width)
  dock.handleMouse(pointer(row, 2, width, 'click'))
  assert.deepEqual(opens, [], 'the press identity is gone, so the click is refused')
})

test('a stale-width pointer event and a click outside a target are ignored', () => {
  const { dock, opens } = harness(model())
  const width = 80
  dock.render(width)
  assert.equal(dock.handleMouse(pointer(1, 2, 120, 'press')), undefined)
  // The hint row (last painted) is inert.
  const lines = dock.render(width)
  assert.equal(dock.handleMouse(pointer(lines.length - 1, 0, width, 'press')), undefined)
  assert.deepEqual(opens, [])
})

test('an empty queue paints nothing (no permanent chrome row)', () => {
  const { dock } = harness(model({ rows: [] }))
  assert.deepEqual(dock.render(80), [])
  assert.equal(dock.hasRows(), false)
})


test('the real press → release → click sequence activates exactly once', () => {
  const { dock, opens } = harness(model())
  const width = 80
  const lines = dock.render(width)
  const row = lines.findIndex(line => plain(line).includes('check the API compatibility'))
  dock.handleMouse(pointer(row, 2, width, 'press'))
  assert.deepEqual(opens, [], 'press alone never activates')
  dock.handleMouse(pointer(row, 2, width, 'release'))
  assert.deepEqual(opens, [], 'release alone never activates and never drops the press identity')
  dock.handleMouse(pointer(row, 2, width, 'click'))
  assert.deepEqual(opens, ['occ-1'], 'the synthesized click activates the pressed occurrence once')
})


test('Host control sequences in a queued row never reach the terminal', () => {
  const evil = 'safe\u001b[2J \u001b]52;c;ZXZpbA==\u0007 \u009b31m file\u001b[31m.bin'
  const { dock, opens } = harness(model({ rows: [{ id: 'evil', text: evil, local: false }] }))
  const width = 80
  const lines = dock.render(width)
  const painted = lines.join('\n')
  assert.equal(painted.includes('\u001b[2J'), false, 'a CSI clear sequence is removed')
  assert.equal(painted.includes(']52;'), false, 'an OSC 52 payload is removed')
  assert.equal(painted.includes('\u009b'), false, 'a C1 CSI is removed')
  assert.equal(painted.includes('\u001b[31m'), false, 'a raw SGR from content is removed')
  // The row stays a valid click target after sanitization.
  const row = lines.findIndex(line => plain(line).includes('safe'))
  assert.ok(row > 0)
  dock.handleMouse(pointer(row, 2, width, 'press'))
  dock.handleMouse(pointer(row, 2, width, 'release'))
  dock.handleMouse(pointer(row, 2, width, 'click'))
  assert.deepEqual(opens, ['evil'])
})
