/**
 * PR3-B B2: the command/shell admission matrix on the OFFICIAL Direct
 * composition (see `support/direct-tsp-fixture.ts` — REAL Host services, REAL
 * live Agents, only the model scripted).
 *
 * Cases: the genuine Host-same-name winner keeps its Host sink; a failing Host
 * command rolls the draft back through the real controller; a refused `!` line
 * leaves the input-history store untouched (with an accepted prompt as the
 * positive control for the same store).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-direct-admission.test
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createDirectTspFixture, directSettle, waitFor } from './support/direct-tsp-fixture.ts'

/** Every history file written under the fixture's isolated DSH home. */
function historyFiles(workRoot: string): string[] {
  const dir = join(workRoot, 'user-history')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name))
}

/** The latest controlled editor text on the wire for `dock.composer`. */
function latestComposerText(wire: string): string | undefined {
  let text: string | undefined
  let seen = false
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
        seen = true
      } else if (op[0] === 'set' && op[1] === 'dock.composer' && (op[2] as { text?: string }).text !== undefined) {
        text = (op[2] as { text: string }).text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        text = op[2] === 'append' ? (text ?? '') + (op[3] as string) : (op[3] as string)
      }
    }
  }
  return seen ? text : undefined
}

test('B2/Direct: a GENUINE Host command with a TUI builtin name keeps its Host sink', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const calls: string[] = []
  // `/settings` is BOTH a TUI builtin (PiTui panel, refused on TSP) and, here, a
  // genuine Host command. The authoritative catalog must win: the TSP builtin
  // gate must not capture a Host-owned line, and the Host SINK must run.
  const fixture = await createDirectTspFixture(life, {
    hostCommands: [{
      name: 'settings',
      description: 'Host-owned settings',
      definitionId: 'host-settings-def',
      handler: (invocation) => { calls.push(invocation.rawInput); return { kind: 'success', text: 'host settings ran' } },
    }],
  })
  try {
    await directSettle(4_000)
    fixture.pane.input.type('/settings')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the Host command sink', () => calls.length > 0, 25_000)
    assert.equal(calls.length, 1, 'the genuine Host command handler ran exactly once')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'a Host-owned /settings is NOT refused by the TSP builtin gate')
  } finally {
    await fixture.settle()
  }
})

test('B2/Direct: a FAILING Host command rolls the draft back into the composer', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  let handlerCalls = 0
  const fixture = await createDirectTspFixture(life, {
    hostCommands: [{
      name: 'failing',
      description: 'Always fails',
      definitionId: 'host-failing-def',
      handler: () => { handlerCalls += 1; return { kind: 'error', text: 'the command failed on purpose' } },
    }],
  })
  // The exact-once writer witness (shared shape with the L6 case): a rejected
  // command line must produce ZERO prompt writes.
  const recorder = fixture.recordPrompts(() => {})
  try {
    await directSettle(4_000)
    fixture.pane.input.type('/failing')
    await directSettle()
    assert.equal(latestComposerText(fixture.pane.output.text()), '/failing')
    // NEGATIVE CONTROLS: the producer facts are all zero before the gesture —
    // so the post-gesture waits below can only be satisfied by the submit
    // actually dispatching (the round-3 fake-green: an input boundary that
    // swallows Enter leaves these at zero and FAILS this test).
    assert.equal(handlerCalls, 0, 'the Host handler has not run before the gesture')
    assert.equal(recorder.calls(), 0, 'no prompt write before the gesture')
    fixture.pane.input.type('\r')
    // STEP 1 — the submission really dispatched: the REAL Host sink ran
    // exactly once (a producer fact, not a pane substring). This is the
    // load-bearing anti-fake-green anchor: the review's mutation (the input
    // boundary swallowing Enter) leaves `handlerCalls` at 0 and fails HERE —
    // the old test's predicates were all satisfied by the never-submitted
    // draft still sitting in the composer.
    await waitFor('the failing Host command to run', () => handlerCalls === 1, 25_000)
    assert.equal(handlerCalls, 1, 'the failing Host command ran exactly once')
    // STEP 2 — the real controller RESTORED the failed line into the LIVE
    // composer (never a stale snapshot). The §3.4 snapshot→clear ordering is
    // internal to the submit gesture (the clear and a synchronous restore may
    // coalesce into one rendered frame), so the DISCRIMINATIVE state fact is
    // the restored-live-draft itself.
    await waitFor('the draft rollback', () => latestComposerText(fixture.pane.output.text()) === '/failing', 25_000)
    assert.equal(latestComposerText(fixture.pane.output.text()), '/failing',
      'the failed command line is live draft content again')
    // STEP 3 — the refusal wrote NOTHING through the session writer and
    // started NO model turn (a failed Host command is never a prompt).
    assert.equal(recorder.calls(), 0, 'a failed Host command never writes a session prompt')
    assert.equal(fixture.modelCalls(), 0, 'a failed Host command never starts a model turn')
    recorder.detach()
  } finally {
    recorder.detach()
    await fixture.settle()
  }
})

test('B2/Direct: a refused `!` line writes NO input-history row (accepted prompt does)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'] })
  try {
    await directSettle(4_000)
    // A refused user-shell line: the refusal sits BEFORE any history write.
    fixture.pane.input.type('!echo hi')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the shell refusal', () =>
      fixture.pane.output.text().includes('User-shell UI is not available in TSP'), 25_000)
    assert.deepEqual(historyFiles(fixture.workRoot), [],
      'the refused `!` line wrote no history row')
    // The refusal RESTORED the line into the composer, so clear it first — an
    // appended prompt would otherwise submit `!echo hian accepted prompt` and
    // take the shell branch again (which is itself the rollback working).
    assert.equal(latestComposerText(fixture.pane.output.text()), '!echo hi',
      'the refused line was restored into the composer')
    for (let index = 0; index < '!echo hi'.length; index += 1) fixture.pane.input.type('\x7f')
    await directSettle()
    assert.equal(latestComposerText(fixture.pane.output.text()), '', 'the composer is clear again')
    // POSITIVE CONTROL for the same store: an accepted prompt DOES persist a row,
    // so the empty result above is a real refusal, not a missing store.
    fixture.pane.input.type('an accepted prompt')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the history row', () => historyFiles(fixture.workRoot).length > 0, 25_000)
    // Assert on the PARSED records, not a substring: the accepted prompt's own
    // text could legitimately contain anything.
    const records = historyFiles(fixture.workRoot)
      .flatMap(file => readFileSync(file, 'utf8').trim().split('\n'))
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as { content?: unknown })
    const contents = records.map(record => String(record.content ?? ''))
    assert.ok(contents.some(content => content.includes('an accepted prompt')),
      'the accepted prompt is in the history store')
    assert.ok(!contents.some(content => content === '!echo hi'),
      'the refused shell line is NOT in the history store as its own record')
  } finally {
    await fixture.settle()
  }
})

// ── The running-turn busy preference (queue vs steer) ───────────────────────

/** The ACCELERATED chord's kitty encoding — already proven to parse to the
 * `accelerated` submit gesture on the TSP path (tern-tsp-editor-input). */
const CTRL_ENTER = '\u001b[13;5u'

for (const busyEnter of ['queue', 'steer'] as const) {
  for (const gesture of ['enter', 'accelerated'] as const) {
    test(`B2/Direct: a ${gesture === 'enter' ? 'plain Enter' : 'Ctrl+Enter'} into a RUNNING turn takes the ${gesture === 'enter' ? 'configured' : 'OPPOSITE'} busyEnter=${busyEnter}`, async (t) => {
      const { testLifecycle } = await import('./support/temp-lifecycle.ts')
      const life = testLifecycle(t)
      let releaseStream!: () => void
      const held = new Promise<void>(resolve => { releaseStream = resolve })
      const promptCalls: Array<{ readonly mode: 'queue' | 'steer'; readonly outcome: { readonly kind: string } }> = []
      const fixture = await createDirectTspFixture(life, {
        deltas: ['LATE-REPLY'],
        streamHold: () => held,
        // The SAME volatile authority `applyRunner` reads: the busy preference
        // under test is the real configured one, not a stand-in.
        tuiConfig: { busyEnter },
      })
      const recorder = fixture.recordPrompts(call => { promptCalls.push(call) })
      try {
        await directSettle(4_000)
        // Start a real turn; its model stream is HELD so the turn stays running.
        fixture.pane.input.type('first prompt')
        await directSettle()
        fixture.pane.input.type('\r')
        await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
        await waitFor('the first committed prompt', () => recorder.calls() === 1, 25_000)
        assert.equal(recorder.calls(), 1, 'the first (idle-start) submission is the running turn')
        const beforeCalls = recorder.calls()
        // The second submission while the turn runs, with the chosen gesture.
        fixture.pane.input.type('second prompt')
        await directSettle()
        fixture.pane.input.type(gesture === 'enter' ? '\r' : CTRL_ENTER)
        // The AUTHORITATIVE delivery: the real Direct writer settled the second
        // prompt with the web-parity mode (Enter = the preference, the
        // accelerated chord = its OPPOSITE) — a producer fact, never a wire
        // regex over presentation rows.
        await waitFor(`the busy ${gesture} delivery`, () => recorder.calls() === beforeCalls + 1, 25_000)
        const second = promptCalls.at(-1)!
        const expected: 'queue' | 'steer' = gesture === 'enter'
          ? busyEnter
          : busyEnter === 'queue' ? 'steer' : 'queue'
        assert.equal(second.mode, expected,
          `${gesture} into a running turn delivered as ${expected} (busyEnter=${busyEnter})`)
        assert.equal(second.outcome.kind, 'committed', 'the busy delivery settled committed')
        assert.equal(recorder.calls(), beforeCalls + 1, 'exactly ONE write for the second submission (no double-send)')
        // Exactly ONE pending delivery row exists for the second submission.
        await directSettle(1_000)
        const wire = fixture.pane.output.text()
        assert.equal((wire.match(/queued \(/g) ?? []).length + (wire.match(/steering/g) ?? []).length, 1,
          'exactly ONE pending delivery row exists for the second submission')
        releaseStream()
        await directSettle(2_000)
        recorder.detach()
      } finally {
        releaseStream()
        recorder.detach()
        await fixture.settle()
      }
    })
  }
}

// ── Cancellation while a real turn runs ─────────────────────────────────────

test('B2/Direct: Esc during a RUNNING turn cancels the turn through the existing path (no exit)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  let releaseStream!: () => void
  const held = new Promise<void>(resolve => { releaseStream = resolve })
  let exited = false
  const fixture = await createDirectTspFixture(life, {
    deltas: ['NEVER-REACHED'],
    streamHold: () => held,
    appExit: () => { exited = true },
  })
  try {
    await directSettle(4_000)
    fixture.pane.input.type('cancel me')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
    // Escape maps to the EXISTING application cancel path (never an exit).
    // The authoritative observation is the LIVE MODEL REQUEST: the existing
    // cancellation path (Esc → onCancel → UserShell.interrupt → the scoped
    // SessionWriter.cancel → the real Agent's cancel) must abort it.
    fixture.pane.input.type('\u001b')
    await waitFor('the live model request to observe the cancel', () => fixture.cancellations() >= 1, 25_000)
    assert.ok(fixture.cancellations() >= 1,
      'Esc cancelled the running turn through the existing path (the model request was aborted)')
    assert.equal(exited, false, 'cancelling a running turn never exits the TUI')
    const wire = fixture.pane.output.text()
    assert.ok(!wire.includes('NEVER-REACHED'),
      'the cancelled turn never delivered the held model output')
  } finally {
    releaseStream()
    await fixture.settle()
  }
})

test('B2/Direct: a REJECTED session cancel surfaces a renderer-neutral error notice (never an exit)', async (t) => {
  // The cancel-ERROR qualification: when the semantic `SessionWriter.cancel`
  // settles `rejected` (or errors), the user-shell owner's `onResult` must
  // surface the structural message through the RENDERER-NEUTRAL notice sink
  // (`surface.display.notify`) — the same seam the TSP dock renders — and the
  // TUI must stay up. The recorder patches the production writer's `cancel`
  // (unbound original, one-to-one) to return a typed rejection.
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  let releaseStream!: () => void
  const held = new Promise<void>(resolve => { releaseStream = resolve })
  let exited = false
  const fixture = await createDirectTspFixture(life, {
    deltas: ['NEVER-REACHED'],
    streamHold: () => held,
    appExit: () => { exited = true },
  })
  const rejectionMessage = 'the session refuses cancellation right now'
  const recorder = fixture.recordCancels(() => ({
    kind: 'rejected',
    error: { code: 'session/agent-busy', message: rejectionMessage, details: {} },
  }))
  try {
    await directSettle(4_000)
    fixture.pane.input.type('cancel rejection case')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
    fixture.pane.input.type('\u001b')
    await waitFor('the rejected cancel notice', () =>
      fixture.pane.output.text().includes(rejectionMessage), 25_000)
    assert.ok(fixture.pane.output.text().includes(rejectionMessage),
      'the rejected cancel surfaced its structural message through the renderer-neutral notice sink')
    assert.equal(exited, false, 'a rejected cancel never exits the TUI')
    recorder.detach()
  } finally {
    releaseStream()
    recorder.detach()
    await fixture.settle()
  }
})

// ── The CLIENT-EXTENSION command family ─────────────────────────────────────

test('B2/Direct: a registered extension contribution runs (never refused by the TSP builtin gate)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    extensionCommands: [{
      id: 'ext-probe',
      name: 'extprobe',
      description: 'An extension contribution',
      sessionless: true,
      handler: () => { calls.push('extprobe'); return { kind: 'success', text: 'ext ran' } },
    }],
  })
  try {
    await directSettle(4_000)
    fixture.pane.input.type('/extprobe')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the extension contribution handler', () => calls.length > 0, 25_000)
    assert.deepEqual(calls, ['extprobe'], 'the registered extension contribution ran exactly once')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'a client-extension command is NOT refused by the TSP TUI-builtin gate')
  } finally {
    await fixture.settle()
  }
})

// ── The advertised-miss path (a name the standing catalog promised) ─────────

test('B2/Direct: an advertised name missing from the created session is consumed as an advertised-miss, not a TSP refusal', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // A fixture skill provider makes the name visible to the STANDING catalog
  // (it is advertised to the composer), while the session-scoped catalog this
  // fixture composes does not resolve it after the session is created — the
  // exact advertised-miss shape. The gate under test is that the EXISTING
  // advertised-miss consumption owns the line (with its own truthful notice)
  // and it is never mislabelled as an unsupported TSP TUI builtin.
  const fixture = await createDirectTspFixture(life, {
    deltas: ['UNUSED'],
    skills: [{ name: 'fixture-skill', description: 'A fixture skill', body: 'Do the fixture thing.' }],
  })
  try {
    await directSettle(4_000)
    fixture.pane.input.type('/fixture-skill')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the advertised-miss notice', () =>
      fixture.pane.output.text().includes('is not available in the created session'), 25_000)
    const wire = fixture.pane.output.text()
    assert.ok(wire.includes('is not available in the created session'),
      'the existing advertised-miss path consumed the line with its own notice')
    assert.ok(!wire.includes('not available in TSP'),
      'an advertised-miss is never mislabelled as an unsupported TSP TUI builtin')
  } finally {
    await fixture.settle()
  }
})
