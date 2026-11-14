/**
 * Headless tests for the independent Agent Team OFF confirmation seat
 * (src/tui/pickers/team-disable-confirmation.ts):
 * default Cancel focus, Cancel/Esc performing zero Host writes, Confirm running
 * the captured attempt exactly once, a failed write offering Retry, an unknown
 * write offering only a read-only Recheck, and a committed write staying on
 * `Checking saved state…` until a fresh projection proves OFF before closing
 * exactly once. Mouse only complete action tokens are hit-tested from the last
 * painted frame.
 * @module @xmoon76/dsh-pi-tui/team-disable-confirmation.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TeamDisableConfirmation } from '../../src/tui/pickers/team-disable-confirmation.ts'
import type { TeamModeSnapshot, TeamModeWriteOutcome } from '../../src/runtime/team-mode-port.ts'

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/u, '')

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve))
}

/** The seat's command-owned facts: a scripted `run()`, a switchable snapshot and
 *  a listener fan-out. `run()` NEVER mutates the snapshot: a test drives the
 *  projection itself so the `Checking saved state…` phase is observable. */
class FakeSeat {
  snapshot: TeamModeSnapshot
  runCalls = 0
  closeCalls = 0
  readonly listeners = new Set<() => void>()
  private readonly runQueue: Array<{ deferred?: Deferred<TeamModeWriteOutcome>; outcome?: TeamModeWriteOutcome }> = []

  constructor(snapshot: TeamModeSnapshot) {
    this.snapshot = snapshot
  }

  read(): TeamModeSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  queueManualRun(): Deferred<TeamModeWriteOutcome> {
    const handle = deferred<TeamModeWriteOutcome>()
    this.runQueue.push({ deferred: handle })
    return handle
  }

  queueOutcome(outcome: TeamModeWriteOutcome): void {
    this.runQueue.push({ outcome })
  }

  async run(): Promise<TeamModeWriteOutcome> {
    this.runCalls += 1
    const entry = this.runQueue.shift()
    return entry?.deferred !== undefined
      ? await entry.deferred.promise
      : entry?.outcome ?? { kind: 'committed' }
  }

  setSnapshot(next: TeamModeSnapshot): void {
    this.snapshot = next
    this.emit()
  }

  mount(): TeamDisableConfirmation {
    return new TeamDisableConfirmation({
      run: () => this.run(),
      read: () => this.read(),
      subscribe: listener => this.subscribe(listener),
      requestRender: () => {},
      close: () => { this.closeCalls += 1 },
    })
  }
}

const ready = (enabled: boolean): TeamModeSnapshot =>
  ({ kind: 'ready', enabled, modelRequestHistory: 'recorded' })

const actionRowOf = (lines: readonly string[]): string => stripAnsi(lines[lines.length - 2]!)

test('the seat defaults to Cancel focus', () => {
  const seat = new FakeSeat(ready(true))
  const component = seat.mount()
  const action = actionRowOf(component.render(60))
  assert.ok(action.includes('[Cancel]'), `Cancel must be the default focused action:\n${action}`)
  assert.ok(action.includes('Disable Team'), `the confirm action is painted inactive:\n${action}`)
  assert.ok(!action.includes('[Disable Team]'), `the confirm action is NOT focused:\n${action}`)
})

test('Cancel (Enter on the default focus) performs zero writes and closes', () => {
  const seat = new FakeSeat(ready(true))
  const component = seat.mount()
  component.render(60)
  component.handleInput('\r')
  assert.equal(seat.runCalls, 0, 'Cancel never runs the write')
  assert.equal(seat.closeCalls, 1, 'Cancel closes the seat')
})

test('Esc cancels with zero writes and closes', () => {
  const seat = new FakeSeat(ready(true))
  const component = seat.mount()
  component.render(60)
  component.handleInput('\x1b')
  assert.equal(seat.runCalls, 0, 'Esc never runs the write')
  assert.equal(seat.closeCalls, 1, 'Esc closes the seat')
})

test('Confirm runs the captured attempt exactly once and closes on a proven OFF readback', async () => {
  const seat = new FakeSeat(ready(true))
  seat.queueOutcome({ kind: 'committed' })
  const component = seat.mount()
  component.render(60)
  component.handleInput('\x1b[C') // Right -> focus Confirm
  component.render(60)
  component.handleInput('\r') // act
  await flush()
  assert.equal(seat.runCalls, 1, 'exactly one write')
  // The committed write is not yet proven: the seat waits on its checking phase.
  assert.ok(stripAnsi(component.render(60).join('\n')).includes('Checking saved state…'),
    `the seat stays on Checking saved state… until a fresh read proves OFF:\n${component.render(60).map(stripAnsi).join('\n')}`)
  assert.equal(seat.closeCalls, 0, 'no close before the projection proves OFF')
  seat.setSnapshot(ready(false)) // a fresh projection proves the OFF write landed
  await flush()
  assert.equal(seat.closeCalls, 1, 'the seat closes exactly once on the proven readback')
  seat.setSnapshot(ready(false)) // a later projection must not re-close
  await flush()
  assert.equal(seat.closeCalls, 1, 'a repeated projection never double-closes')
})

test('a rejected write offers Retry, and Retry re-runs the SAME captured attempt', async () => {
  const seat = new FakeSeat(ready(true))
  seat.queueOutcome({ kind: 'rejected', reason: 'permission denied' })
  seat.queueOutcome({ kind: 'committed' })
  const component = seat.mount()
  component.render(60)
  component.handleInput('\x1b[C') // focus Confirm
  component.render(60)
  component.handleInput('\r') // first attempt -> rejected
  await flush()
  const failed = component.render(60).map(stripAnsi)
  assert.ok(failed.some(line => line.includes('Retry')), `a failed write must offer Retry:\n${failed.join('\n')}`)
  assert.ok(failed.some(line => line.includes('permission denied')), `the failure reason is shown:\n${failed.join('\n')}`)
  component.handleInput('\r') // Retry (focus already on confirm)
  await flush()
  assert.equal(seat.runCalls, 2, 'Retry re-runs the captured attempt')
  assert.equal(seat.closeCalls, 0, 'a committed retry still waits for the readback')
  seat.setSnapshot(ready(false))
  await flush()
  assert.equal(seat.closeCalls, 1, 'the committed retry closes on the proven readback')
})

test('an unknown write offers only a read-only Recheck (never a re-send)', async () => {
  const seat = new FakeSeat(ready(true))
  seat.queueOutcome({ kind: 'indeterminate', reason: 'connection lost' })
  const component = seat.mount()
  component.render(60)
  component.handleInput('\x1b[C')
  component.render(60)
  component.handleInput('\r')
  await flush()
  const unknown = component.render(60).map(stripAnsi)
  assert.ok(unknown.some(line => line.includes('Recheck')), `the unknown state offers Recheck:\n${unknown.join('\n')}`)
  assert.ok(unknown.some(line => line.includes('Close')), `the unknown state offers Close:\n${unknown.join('\n')}`)
  // R performs a READ-ONLY recheck. A still-ON projection does NOT prove the
  // dispatched write failed, so the seat must stay `unknown` with NO Retry.
  seat.snapshot = ready(true)
  component.handleInput('R')
  await flush()
  assert.equal(seat.runCalls, 1, 'Recheck never re-sends the write')
  const afterRecheck = component.render(60).map(stripAnsi)
  assert.match(afterRecheck.join(' ').replace(/\s+/gu, ' '), /may still land/u,
    `a still-On recheck stays unknown:\n${afterRecheck.join('\n')}`)
  assert.ok(afterRecheck.some(line => line.includes('Recheck')) && afterRecheck.some(line => line.includes('Close')),
    `the unknown state keeps only Recheck/Close:\n${afterRecheck.join('\n')}`)
  assert.ok(!afterRecheck.some(line => line.includes('Retry')), 'an unknown write must never offer Retry')
  component.handleInput('\r')
  await flush()
  assert.equal(seat.runCalls, 1, 'Enter in the unknown state never re-sends')
})

test('Esc during Saving does not close the seat or relinquish the write', async () => {
  const seat = new FakeSeat(ready(true))
  const pending = seat.queueManualRun()
  const component = seat.mount()
  component.render(60)
  component.handleInput('\x1b[C') // focus Confirm
  component.render(60)
  component.handleInput('\r') // Confirmed -> run() stays pending (Saving…)
  await flush()
  assert.equal(seat.runCalls, 1)
  assert.ok(stripAnsi(component.render(60).join('\n')).includes('Saving…'))
  component.handleInput('\x1b') // Esc must be swallowed while the write owns the seat
  await flush()
  assert.equal(seat.closeCalls, 0, 'Esc during Saving must not close the seat')
  assert.equal(component.requestClose(), false, 'the owner may not tear down a saving seat')
  pending.resolve({ kind: 'committed' })
  await flush()
  assert.ok(stripAnsi(component.render(60).join('\n')).includes('Checking saved state…'))
  component.handleInput('\x1b') // still owned while checking
  assert.equal(seat.closeCalls, 0, 'Esc during Checking must not close the seat')
  seat.setSnapshot(ready(false))
  await flush()
  assert.equal(seat.closeCalls, 1, 'the proven readback closes the seat once')
})

test('a mouse click on a complete action token acts; an incomplete token never hits', () => {
  // Complete tokens: a click on Cancel closes with no write.
  const cancelSeat = new FakeSeat(ready(true))
  const cancelComponent = cancelSeat.mount()
  const cancelLines = cancelComponent.render(60).map(stripAnsi)
  const cancelAction = actionRowOf(cancelLines)
  const cancelX = 1
  assert.ok(cancelAction.startsWith('[Cancel]'), `Cancel is the first complete token:\n${cancelAction}`)
  assert.equal(cancelComponent.handleMouse({ type: 'press', button: 'left', x: cancelX, y: cancelLines.length - 2, screenX: cancelX, screenY: cancelLines.length - 2, width: 60, height: cancelLines.length, shift: false, alt: false, ctrl: false })?.handled, true)
  assert.equal(cancelComponent.handleMouse({ type: 'click', button: 'left', x: cancelX, y: cancelLines.length - 2, screenX: cancelX, screenY: cancelLines.length - 2, width: 60, height: cancelLines.length, clickCount: 1, shift: false, alt: false, ctrl: false })?.handled, true)
  assert.equal(cancelSeat.closeCalls, 1, 'a complete Cancel token click closes the seat')
  assert.equal(cancelSeat.runCalls, 0, 'a complete Cancel token click writes nothing')

  // A width too narrow to paint the whole focused token registers NO hit.
  const narrowSeat = new FakeSeat(ready(true))
  const narrowComponent = narrowSeat.mount()
  const narrowLines = narrowComponent.render(4)
  const narrowAction = narrowLines.length - 2
  assert.equal(narrowComponent.handleMouse({ type: 'press', button: 'left', x: 2, y: narrowAction, screenX: 2, screenY: narrowAction, width: 4, height: narrowLines.length, shift: false, alt: false, ctrl: false }), undefined,
    'an incomplete token has no hit segment')
  assert.equal(narrowSeat.closeCalls, 0, 'an incomplete token never acts')

  // Sanity: the narrow action row is genuinely truncated below the token width.
  assert.ok(visibleWidth(stripAnsi(narrowLines[narrowAction]!)) <= 4, 'the narrow row fits the grant')
})
