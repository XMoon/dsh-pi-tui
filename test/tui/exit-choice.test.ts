/**
 * Headless tests for the ONE PiTui Exit Choice seat
 * (`src/tui/interaction/exit-choice.ts`): the three real actions are always
 * painted together, Enter selects the painted focus, Esc/Ctrl+C are Stay, the
 * Stop-in-flight window is locked, an unconfirmed stop only offers the truthful
 * Keep/Stay pair, and a pointer activates only the SAME complete option segment
 * of the CURRENT painted frame.
 * @module @xmoon76/dsh-pi-tui/exit-choice.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { TuiMouseEvent } from '@xmoon76/pi-tui'
import { ExitChoicePanel } from '../../src/tui/interaction/exit-choice.ts'
import {
  exitChoiceAsking,
  exitChoiceStopping,
  exitChoiceUnconfirmed,
  type ExitChoiceModel,
  type ExitChoiceOption,
} from '../../src/app/surface/exit-choice.ts'

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/u, '')

/** Mount with an explicit model factory so the selection callback is the ONE
 *  harness recorder (the app-surface factories are copy/option builders). */
function mountRecorder(model: (select: (option: ExitChoiceOption) => void) => ExitChoiceModel): {
  readonly component: ExitChoicePanel
  readonly selections: ExitChoiceOption[]
  renders(): number
  closes(): number
} {
  const selections: ExitChoiceOption[] = []
  let renders = 0
  let closes = 0
  const component = new ExitChoicePanel({
    model: model(option => { selections.push(option) }),
    requestRender: () => { renders += 1 },
    onClosed: () => { closes += 1 },
  })
  return { component, selections, renders: () => renders, closes: () => closes }
}

function mouseEvent(type: 'press' | 'click', x: number, y: number, width: number, height: number): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    shift: false,
    alt: false,
    ctrl: false,
  } as TuiMouseEvent
}

test('asking: all three actions are painted together with the safe default focus', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  const lines = seat.component.render(60).map(stripAnsi)
  const text = lines.join('\n')
  assert.match(text, /Disconnect from dsh-pi-tui/)
  assert.match(text, /The current session is still working\./)
  const keep = lines.findIndex(line => line.includes('Keep working and disconnect'))
  const stop = lines.findIndex(line => line.includes('Stop current work and disconnect'))
  const stay = lines.findIndex(line => line.includes('Stay in the TUI'))
  assert.ok(keep >= 0 && stop >= 0 && stay >= 0, `all options are visible:\n${text}`)
  assert.ok(keep < stop && stop < stay, 'the fixed keyboard order is preserved')
  assert.match(lines[keep]!, /^❯ /, 'Keep owns the initial focus')
  assert.match(lines[stop]!, /^ {2}Stop/, 'unfocused options keep their full label')
  assert.match(text, /↑↓ Select · Enter Confirm · Esc Stay/)
  for (const line of lines) assert.ok(visibleWidth(line) <= 60, `row fits the frame: ${line}`)
})

test('narrow width keeps every action complete with the compact labels', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  const lines = seat.component.render(32).map(stripAnsi)
  const text = lines.join('\n')
  assert.match(text, /^Disconnect$/m, 'narrow title')
  assert.ok(!text.includes('Keep working and disconnect'), 'long labels are not clipped behind a clickable row')
  assert.match(text, /Keep running & disconnect/)
  assert.match(text, /Stop work & disconnect/)
  assert.match(text, /Stay/)
  for (const line of lines) assert.ok(visibleWidth(line) <= 32, `row fits the narrow frame: ${line}`)
})

test('keyboard: ↑↓ move the painted focus and Enter selects it', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  let lines = seat.component.render(60).map(stripAnsi)
  seat.component.handleInput('\x1b[B') // down
  lines = seat.component.render(60).map(stripAnsi)
  const focused = lines.find(line => line.startsWith('❯ '))
  assert.ok(focused?.includes('Stop current work and disconnect'), `focus moved to Stop:\n${lines.join('\n')}`)
  seat.component.handleInput('\r')
  assert.deepEqual(seat.selections, ['stop-and-disconnect'], 'Enter selects the EXACT painted focus')
  assert.ok(seat.renders() >= 1, 'a focus move repaints')
})

test('Esc and Ctrl+C inside the choice mean Stay (never a Host cancel)', () => {
  for (const key of ['\x1b', '\x03']) {
    const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
    seat.component.handleInput(key)
    assert.deepEqual(seat.selections, ['stay'], `${JSON.stringify(key)} is Stay`)
  }
})

test('the Stop-in-flight window is locked: no key selects or closes', () => {
  const seat = mountRecorder(select => exitChoiceStopping(select, () => {}))
  const lines = seat.component.render(60).map(stripAnsi).join('\n')
  assert.match(lines, /Stopping current work…/)
  assert.match(lines, /Waiting for the current session to become idle\./)
  assert.match(lines, /No other session will be stopped\./)
  assert.match(lines, /Waiting for the Host…/)
  for (const key of ['\r', '\x1b', '\x03', '\x1b[B']) seat.component.handleInput(key)
  assert.deepEqual(seat.selections, [], 'the locked window dispatches nothing')
})

test('unconfirmed: only Disconnect/Stay remain and the refusal detail is painted', () => {
  const seat = mountRecorder(select => exitChoiceUnconfirmed('The daemon refused the stop.', select, () => {}))
  const lines = seat.component.render(60).map(stripAnsi)
  const text = lines.join('\n')
  assert.match(text.replace(/\n/g, ' '), /Stop could not be confirmed\. The daemon may still be working\./)
  assert.match(text, /The daemon refused the stop\./)
  assert.ok(!text.includes('Stop current work'), 'no unprovable Stop action is offered')
  const disconnect = lines.findIndex(line => line.includes('Disconnect without stopping'))
  assert.match(lines[disconnect]!, /^❯ /, 'Disconnect owns the focus')
  seat.component.handleInput('\r')
  assert.deepEqual(seat.selections, ['disconnect-without-stop'])
})

test('mouse: press+click on the SAME complete option activates it once', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  const lines = seat.component.render(60).map(stripAnsi)
  const row = lines.findIndex(line => line.includes('Stop current work and disconnect'))
  const width = 60
  const height = lines.length
  assert.equal(seat.component.handleMouse(mouseEvent('press', 4, row, width, height))?.handled, true)
  assert.equal(seat.component.handleMouse(mouseEvent('click', 4, row, width, height))?.handled, true)
  assert.deepEqual(seat.selections, ['stop-and-disconnect'], 'the click routes the SAME callback as Enter')
})

test('mouse: press and release on different segments never act; a foreign frame is rejected', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  const lines = seat.component.render(60).map(stripAnsi)
  const stopRow = lines.findIndex(line => line.includes('Stop current work and disconnect'))
  const stayRow = lines.findIndex(line => line.includes('Stay in the TUI'))
  const height = lines.length
  assert.equal(seat.component.handleMouse(mouseEvent('press', 4, stopRow, 60, height))?.handled, true)
  // Release on a DIFFERENT option row: the press identity is not the hit.
  assert.equal(seat.component.handleMouse(mouseEvent('click', 4, stayRow, 60, height)), undefined)
  assert.deepEqual(seat.selections, [], 'a split press/release performs no action')
  // A pointer event painted for another width is a foreign frame.
  assert.equal(seat.component.handleMouse(mouseEvent('press', 4, stayRow, 58, height)), undefined)
})

test('mouse: a clipped option registers no clickable segment', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  // 4 columns cannot paint ANY full option (even the compact `Stay`); no row
  // may claim a target that is not fully readable.
  const lines = seat.component.render(4).map(stripAnsi)
  assert.ok(lines.some(line => line.includes('…')), 'the frame is genuinely clipped')
  for (const [index, line] of lines.entries()) {
    assert.equal(seat.component.handleMouse(mouseEvent('press', 0, index, 4, lines.length)), undefined,
      `no hit on a clipped row: ${line}`)
  }
})

test('a phase update drops a focus the new options no longer offer', () => {
  const seat = mountRecorder(select => exitChoiceAsking('daemon-busy', select, () => {}))
  seat.component.render(60)
  seat.component.handleInput('\x1b[B') // focus Stop
  // The unconfirmed phase offers only Disconnect/Stay: the stale Stop focus
  // must not survive onto an option that no longer exists.
  seat.component.setModel(exitChoiceUnconfirmed(undefined, option => { seat.selections.push(option) }, () => {}))
  const lines = seat.component.render(60).map(stripAnsi)
  const focused = lines.find(line => line.startsWith('❯ '))
  assert.ok(focused?.includes('Disconnect without stopping'), 'the new phase owns its safe default')
})
