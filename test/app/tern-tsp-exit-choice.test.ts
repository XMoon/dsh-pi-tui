/**
 * M6 UX PR1 TSP contract tests: the bound raw exit keys follow the product rule
 * (working Ctrl+C cancels once, idle needs a same-key second press, unknown
 * refuses), the pre-bind Ctrl+C stays the emergency exit, and the native Exit
 * Choice layer paints real buttons whose CURRENT-epoch pointer events and
 * keyboard route the ONE selection callback while an official modal preempts it.
 *
 * The chain is the PRODUCTION mount `mountTspRenderer` over the scripted SDK
 * pane (`test/support/tsp-terminal-fixture.ts`); keys travel as real tty bytes
 * through the SDK's ONE input loop and the wire frames are the observation point.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-exit-choice.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect as sdkConnect } from '@stencil-hq/tern'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { exitChoiceAsking, type ExitChoiceModel, type ExitChoiceOption } from '../../src/app/surface/exit-choice.ts'
import type { ExitSessionActivity } from '../../src/domain/command/policy.ts'
import type { ApprovalOutcome } from '../../src/app/surface/interaction-presenter.ts'

const SURFACE_ID = 's1'

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface Harness {
  readonly pane: TspPane
  renderer: TspRenderer
  readonly cancels: number[]
  /** The session-aware exit INTENT count (the coordinator). */
  readonly exits: number[]
  /** The FINAL exit-commit count (the pre-bind emergency / fatal fallback). */
  readonly immediateExits: number[]
  readonly fatals: unknown[]
  activity: ExitSessionActivity
  readonly ops: () => readonly (readonly unknown[])[]
  dispose(): Promise<void>
}

async function mountHarness(): Promise<Harness> {
  const pane = installTspPane({ nativeInteraction: true })
  const session = await sdkConnect({ app: 'dsh-pi-tui', timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const cancels: number[] = []
  const exits: number[] = []
  const immediateExits: number[] = []
  const fatals: unknown[] = []
  const harness: Harness = {
    pane,
    renderer: undefined as unknown as TspRenderer,
    cancels,
    exits,
    immediateExits,
    fatals,
    activity: 'idle',
    ops: () => pane.frames().flatMap(frame => frame.ops),
    dispose: async () => {
      await harness.renderer.dispose()
      pane.restore()
    },
  }
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit: () => { exits.push(1) },
    requestImmediateExit: () => { immediateExits.push(1) },
    onFatal: error => { fatals.push(error) },
  })
  harness.renderer = renderer
  return harness
}

function bindInput(harness: Harness): void {
  harness.renderer.bindInput({
    exit: () => { harness.exits.push(1) },
    cancel: () => { harness.cancels.push(1) },
    sessionActivity: () => harness.activity,
    submit: () => {},
    steer: () => {},
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true,
    shouldRememberInput: () => true,
    noteUserInput: () => {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {},
    openModelQuick() {},
    openSessionBrowser() {},
    sessionBrowserAvailable: () => false,
    openTasksBrowserUi() {},
    tasksBrowserUiAvailable: () => false,
  })
}

/** The `layer.exit-choice-<epoch>.opt-<n>` ids currently on the wire. */
function exitOptionIds(harness: Harness): string[] {
  return wireNodes(harness.pane)
    .map(node => node.id)
    .filter(id => /^layer\.exit-choice-\d+\.options\.opt-\d+$/.test(id))
}

const EXIT_ACTION = 'exit-choice'

test('TSP bound: working Ctrl+C cancels once and never exits', async () => {
  const h = await mountHarness()
  try {
    h.activity = 'working'
    bindInput(h)
    h.pane.key('\x03')
    await waitFor(() => h.cancels.length === 1, 'the cancel intent reached the application')
    assert.equal(h.exits.length, 0, 'a working Ctrl+C never exits')
    h.pane.key('\x03')
    await waitFor(() => h.cancels.length === 2, 'a second press cancels again')
    assert.equal(h.exits.length, 0)
    assert.deepEqual(h.fatals, [])
  } finally {
    await h.dispose()
  }
})

test('TSP bound: idle Ctrl+C needs the same-key second press', async () => {
  const h = await mountHarness()
  try {
    h.activity = 'idle'
    bindInput(h)
    h.pane.key('\x03')
    await waitFor(() => h.pane.frames().length > 0, 'the renderer processed the first key')
    assert.equal(h.exits.length, 0, 'one idle press never exits')
    assert.equal(h.cancels.length, 0, 'an idle press never cancels either')
    h.pane.key('\x03')
    await waitFor(() => h.exits.length === 1, 'the second idle press routes the exit intent')
  } finally {
    await h.dispose()
  }
})

test('TSP bound: empty-draft Ctrl+D needs the same-key second press', async () => {
  const h = await mountHarness()
  try {
    h.activity = 'idle'
    bindInput(h)
    h.pane.key('\x04')
    await waitFor(() => h.pane.frames().length > 0, 'the first Ctrl+D was processed')
    assert.equal(h.exits.length, 0, 'the first Ctrl+D only arms')
    h.pane.key('\x04')
    await waitFor(() => h.exits.length === 1, 'the same key confirms the exit')
  } finally {
    await h.dispose()
  }
})

test('TSP bound: C→D→C never confirms across the two exit keys', async () => {
  const h = await mountHarness()
  try {
    h.activity = 'idle'
    bindInput(h)
    h.pane.key('a')
    await waitFor(() => h.pane.frames().length > 0, 'the draft key was processed')
    h.pane.key('\x03') // idle Ctrl+C: clears the draft and arms the interrupt key
    // reason: a non-exiting arm has no positive sink; the bounded window
    // covers the one dispatched key before the next gesture.
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(h.exits.length, 0)
    h.pane.key('\x04') // a DIFFERENT exit key disarms, even as an editor no-op/arm
    await new Promise(resolve => setTimeout(resolve, 60))
    h.pane.key('\x03') // arms interrupt again, never confirms the old Ctrl+C
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(h.exits.length, 0, 'the third press re-armed instead of confirming across keys')
    h.pane.key('\x03')
    await waitFor(() => h.exits.length === 1, 'the same interrupt key confirms after re-arming')
  } finally {
    await h.dispose()
  }
})

test('TSP bound: D→C→D never confirms across the two exit keys', async () => {
  const h = await mountHarness()
  try {
    h.activity = 'idle'
    bindInput(h)
    h.pane.key('\x04') // arm exit
    await new Promise(resolve => setTimeout(resolve, 60))
    h.pane.key('\x03') // arms interrupt, disarms exit
    await new Promise(resolve => setTimeout(resolve, 60))
    h.pane.key('\x04') // arms exit again, disarms interrupt
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(h.exits.length, 0, 'no cross-key confirmation')
    h.pane.key('\x04')
    await waitFor(() => h.exits.length === 1, 'the same exit key confirms after re-arming')
  } finally {
    await h.dispose()
  }
})

test('TSP bound: unknown Ctrl+C refuses to arm and states the unobservable state', async () => {
  const h = await mountHarness()
  try {
    h.activity = 'unknown'
    bindInput(h)
    h.pane.key('\x03')
    await waitFor(
      () => JSON.stringify(h.ops()).includes('running state cannot be verified'),
      'the refusal reached the dock',
    )
    assert.equal(h.exits.length, 0, 'unknown is never an exit')
    assert.equal(h.cancels.length, 0, 'unknown is not a cancel either')
    h.pane.key('\x03')
    // reason: bounded negative-observation window — a refused press has no
    // positive sink, so the absence covers exactly one input dispatch.
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(h.exits.length, 0, 'a repeated unknown press still cannot exit')
  } finally {
    await h.dispose()
  }
})

test('TSP pre-bind: Ctrl+C is the FINAL emergency exit, never a session intent', async () => {
  // RFL-010: a busy/unknown startup has no mounted choice surface; the
  // pre-bind emergency must reach the exit controller directly, without
  // latching the session intent or the fatal lifecycle.
  const h = await mountHarness()
  try {
    h.activity = 'working'
    h.pane.key('\x03')
    await waitFor(() => h.immediateExits.length === 1, 'the pre-bind emergency reached the final commit')
    assert.equal(h.exits.length, 0, 'the session-aware coordinator was never asked for a choice')
    assert.equal(h.cancels.length, 0, 'no business cancel exists before the bind')
  } finally {
    await h.dispose()
  }
})

function choiceModel(select: (option: ExitChoiceOption) => void): ExitChoiceModel {
  return exitChoiceAsking('daemon-busy', select, () => {})
}

test('TSP native choice: real buttons paint and keyboard selects through the ONE callback', async () => {
  const h = await mountHarness()
  const selections: ExitChoiceOption[] = []
  try {
    bindInput(h)
    h.renderer.exitChoice.open(choiceModel(option => { selections.push(option) }))
    await waitFor(() => exitOptionIds(h).length === 3, 'three real option buttons reached the wire')
    const wire = JSON.stringify(h.ops())
    assert.ok(wire.includes('Disconnect from dsh-pi-tui'), 'the overlay title is on the wire')
    assert.ok(wire.includes('The current session is still working.'), 'the risk line is on the wire')
    assert.ok(wire.includes('Keep working and disconnect'), 'the default option is painted')
    assert.ok(wire.includes('Stop current work and disconnect'))
    assert.ok(wire.includes('Stay in the TUI'))
    // ↓ moves the highlight to Stop; Enter routes the SAME selection callback.
    h.pane.key('\x1b[B')
    await waitFor(() => JSON.stringify(h.ops()).includes('❯ Stop current work and disconnect'),
      'the focus marker moved to Stop')
    h.pane.key('\r')
    await waitFor(() => selections.length === 1, 'Enter selected the painted focus')
    assert.deepEqual(selections, ['stop-and-disconnect'])
  } finally {
    await h.dispose()
  }
})

test('TSP native choice: Esc means Stay and a stale-epoch pointer event is dropped', async () => {
  const h = await mountHarness()
  const selections: ExitChoiceOption[] = []
  try {
    bindInput(h)
    const select = (option: ExitChoiceOption): void => { selections.push(option) }
    h.renderer.exitChoice.open(choiceModel(select))
    await waitFor(() => exitOptionIds(h).length === 3, 'the choice opened')
    const staleId = exitOptionIds(h).find(id => id.endsWith('.opt-1'))!
    // A phase update bumps the frame epoch: the old button id is unreachable.
    h.renderer.exitChoice.update(choiceModel(select))
    await waitFor(() => exitOptionIds(h).every(id => id !== staleId), 'the repaint minted new ids')
    h.pane.event({ ev: 'action', sf: SURFACE_ID, id: staleId, act: EXIT_ACTION })
    // reason: bounded negative-observation window — a dropped stale action has
    // no positive sink to await; the window covers one event dispatch.
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(selections, [], 'a superseded frame click performs no action')
    const currentStop = exitOptionIds(h).find(id => id.endsWith('.opt-1'))!
    // External review P2: a real button is an action, not a focus-then-confirm
    // list row. The FIRST current-epoch click must activate.
    h.pane.event({ ev: 'action', sf: SURFACE_ID, id: currentStop, act: EXIT_ACTION })
    await waitFor(() => selections.length === 1, 'ONE current-epoch button click activates')
    assert.deepEqual(selections, ['stop-and-disconnect'])

    h.renderer.exitChoice.open(choiceModel(select))
    await waitFor(() => JSON.stringify(h.ops()).includes('Keep working and disconnect'), 'the choice reopened')
    h.pane.key('\x1b')
    await waitFor(() => selections.length === 2, 'Esc selected Stay')
    assert.deepEqual(selections, ['stop-and-disconnect', 'stay'])
  } finally {
    await h.dispose()
  }
})

test('TSP native choice: an official modal withdraws the choice with zero business action', async () => {
  const h = await mountHarness()
  const selections: ExitChoiceOption[] = []
  let dismissed = 0
  try {
    bindInput(h)
    h.renderer.exitChoice.open({
      ...exitChoiceAsking('daemon-busy', option => { selections.push(option) }, () => { dismissed += 1 }),
    })
    await waitFor(() => exitOptionIds(h).length === 3, 'the choice opened')
    const pending: Promise<ApprovalOutcome> = h.renderer.interaction.showApprovalPrompt(
      { toolName: 'bash', reason: 'needs a shell', arguments: '{}' },
      true,
    )
    await waitFor(() => dismissed === 1, 'the Client choice was withdrawn by the Host modal')
    assert.deepEqual(selections, [], 'withdrawal is not a decision')
    h.pane.key('n')
    assert.equal(await pending, 'rejected', 'the official approval keeps its own outcome')
  } finally {
    await h.dispose()
  }
})
