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
import { createDirectTspFixture, directSettle, waitFor, waitForInputDelivery } from '../support/direct-tsp-fixture.ts'
import { pickerNode } from '../support/tsp-picker-wire.ts'

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

test('a GENUINE Host command with a TUI builtin name keeps its Host sink', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
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
    await waitForInputDelivery(fixture.pane)
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

test('B/Direct: installed Session Browser capability never captures Host-owned command names', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const names = ['sessions', 'resume', 'search']
  const calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    hostCommands: names.map((name) => ({
      name,
      description: `Host-owned ${name}`,
      definitionId: `host-${name}-def`,
      handler: () => { calls.push(name); return { kind: 'success', text: `Host ${name} ran` } },
    })),
  })
  try {
    await waitForInputDelivery(fixture.pane)
    for (const name of names) {
      fixture.pane.input.type(`/${name}`)
      await directSettle()
      fixture.pane.input.type('\r')
      await waitFor(`the genuine Host /${name} sink`, () => calls.length === names.indexOf(name) + 1, 25_000)
    }
    assert.deepEqual(calls, names, 'all same-name Host handlers retain authoritative precedence')
    assert.equal(pickerNode(fixture.pane, 'session-browser-'), undefined,
      'Host-origin commands never open or capture a native Session Browser')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'the native capability gate does not refuse Host-origin winners')
  } finally {
    await fixture.settle()
  }
})

test('B/Direct: /sessions without a negotiated Browser is refused and restores the draft', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { sessionBrowser: false })
  const sessions = fixture.ctx.get('sessions') as unknown as { list(): unknown[] }
  const sessionsBefore = sessions.list().length
  try {
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('/sessions')
    await directSettle()
    assert.equal(latestComposerText(fixture.pane.output.text()), '/sessions',
      'the command draft is present before submission')
    fixture.pane.input.type('\r')
    await waitFor('the unsupported Session Browser refusal', () =>
      fixture.pane.output.text().includes('not available in TSP'), 25_000)
    const wire = fixture.pane.output.text()
    assert.equal(latestComposerText(wire), '/sessions',
      'the unsupported native command restores its original draft')
    assert.equal(pickerNode(fixture.pane, 'session-browser-'), undefined,
      'missing Browser capability never opens a native picker')
    assert.equal(sessions.list().length, sessionsBefore,
      'the refused command creates no Session')
    assert.equal(fixture.modelCalls(), 0, 'the refused command never reaches the model')
  } finally {
    await fixture.settle()
  }
})

test('a FAILING Host command rolls the draft back into the composer', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
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

test('a refused `!` line writes NO input-history row (accepted prompt does)', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'] })
  try {
    await waitForInputDelivery(fixture.pane)
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
      const { testLifecycle } = await import('../support/temp-lifecycle.ts')
      const life = testLifecycle(t)
      let releaseStream!: () => void
      const held = new Promise<void>(resolve => { releaseStream = resolve })
      const promptCalls: Array<{ readonly mode: 'queue' | 'steer'; readonly message: unknown; readonly outcome: { readonly kind: string } }> = []
      const fixture = await createDirectTspFixture(life, {
        deltas: ['LATE-REPLY'],
        streamHold: () => held,
        // The SAME volatile authority `applyRunner` reads: the busy preference
        // under test is the real configured one, not a stand-in.
        tuiConfig: { busyEnter },
      })
      const recorder = fixture.recordPrompts(call => { promptCalls.push(call) })
      try {
        await waitForInputDelivery(fixture.pane)
        // Start a real turn; its model stream is HELD so the turn stays running.
        fixture.pane.input.type('first prompt')
        await directSettle()
        fixture.pane.input.type('\r')
        await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
        await waitFor('the first settled prompt', () => recorder.calls() === 1 && promptCalls.length === 1, 25_000)
        assert.equal(promptCalls.length, recorder.calls(), 'the settled records and the count agree (a settled-only recorder)')
        const beforeSettled = recorder.calls()
        // The second submission while the turn runs, with the chosen gesture.
        fixture.pane.input.type('second prompt')
        await directSettle()
        fixture.pane.input.type(gesture === 'enter' ? '\r' : CTRL_ENTER)
        // The AUTHORITATIVE delivery: wait for THE SECOND WRITE'S OWN SETTLED
        // RECORD (index `beforeSettled` — never `at(-1)` of a possibly-still
        // warm-up-only tail), then assert on THAT record: its prepared
        // message identifies the second submission, its mode is the
        // web-parity delivery (Enter = the preference, the accelerated chord
        // = its OPPOSITE) and its outcome is the ORIGINAL's (a delayed
        // rejection surfaces here and FAILS the committed assertion — the
        // round-4 fake-green shape).
        await waitFor(`the busy ${gesture} delivery to SETTLE`,
          () => promptCalls.length === beforeSettled + 1 && recorder.calls() === beforeSettled + 1, 25_000)
        const second = promptCalls[beforeSettled]!
        assert.ok(JSON.stringify(second.message).includes('second prompt'),
          'the settled record under assertion IS the second submission (identified by its prepared message)')
        const expected: 'queue' | 'steer' = gesture === 'enter'
          ? busyEnter
          : busyEnter === 'queue' ? 'steer' : 'queue'
        assert.equal(second.mode, expected,
          `${gesture} into a running turn delivered as ${expected} (busyEnter=${busyEnter})`)
        assert.equal(second.outcome.kind, 'committed', 'the busy delivery settled committed')
        assert.equal(promptCalls.length, beforeSettled + 1, 'exactly ONE settled write for the second submission (no double-send)')
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

test('Esc during a RUNNING turn cancels the turn through the existing path (no exit)', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
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
    await waitForInputDelivery(fixture.pane)
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

test('a REJECTED session cancel surfaces a renderer-neutral error notice (never an exit)', async (t) => {
  // The cancel-ERROR qualification: when the semantic `SessionWriter.cancel`
  // settles `rejected` (or errors), the user-shell owner's `onResult` must
  // surface the structural message through the RENDERER-NEUTRAL notice sink
  // (`surface.display.notify`) — the same seam the TSP dock renders — and the
  // TUI must stay up. The recorder patches the production writer's `cancel`
  // (unbound original, one-to-one) to return a typed rejection.
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
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
    await waitForInputDelivery(fixture.pane)
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

test('a registered extension contribution runs (never refused by the TSP builtin gate)', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    extensionCommands: [{
      id: 'ext-probe',
      name: 'extprobe',
      description: 'An extension contribution',
      sessionless: true,
      handler: () => { calls.push('extprobe'); return { kind: 'success', text: 'ext ran' } },
    }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('/extprobe')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the extension contribution handler', () => calls.length > 0, 25_000)
    assert.deepEqual(calls, ['extprobe'], 'the registered extension contribution ran exactly once')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'a client-extension command is NOT refused by the TSP TUI-builtin gate')
    assert.equal(pickerNode(fixture.pane, 'session-browser-'), undefined,
      'the mounted Session Browser capability does not capture the extension route')
  } finally {
    await fixture.settle()
  }
})

// ── The advertised-miss path (a name the standing catalog promised) ─────────

test('an advertised Skill that is gone at execution is consumed with an explicit error, never a plain message or a TSP refusal', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // The GENUINE "advertised at submit, missing at execution" shape: the provider
  // still ADVERTISES the name to the composer (`list()`), while `get()` can no
  // longer resolve it once the Session is created. The TUI keeps its own wrapper
  // for an advertised Skill (it no longer collides with the Direct self-mirror),
  // so the wrapper owns the line and reports the truthful failure itself: the
  // submitted line is consumed — never re-sent to the model as a plain message —
  // and never mislabelled as an unsupported TSP TUI builtin. The advertised-miss
  // notice route belongs to names the TUI's own catalog does not own and stays
  // covered by `test/app/submit-hot-path.test.ts`.
  const fixture = await createDirectTspFixture(life, {
    deltas: ['UNUSED'],
    skills: [{ name: 'fixture-skill', description: 'A fixture skill', body: 'Do the fixture thing.', unresolved: true }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('/fixture-skill')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the explicit error for the vanished Skill', () =>
      fixture.pane.output.text().includes('unknown skill'), 25_000)
    const wire = fixture.pane.output.text()
    assert.ok(wire.includes('fixture-skill'), 'the error names the submitted line')
    assert.ok(!wire.includes('UNUSED'),
      'the consumed line never reaches the model as a plain user message')
    assert.ok(!wire.includes('not available in TSP'),
      'a vanished advertised Skill is never mislabelled as an unsupported TSP TUI builtin')
  } finally {
    await fixture.settle()
  }
})

test('B/Direct: a resolvable Skill invocation keeps its agent-facing route while Browser capability is mounted', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  // A real non-colliding Skill invocation exercises the production classifier
  // and command plane with the native Browser capability live.
  const fixture = await createDirectTspFixture(life, {
    sessionBrowser: true,
    deltas: ['skill turn ran'],
    skills: [{ name: 'fixture-skill', description: 'A fixture skill', body: 'Do the fixture thing.' }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('/fixture-skill')
    await directSettle()
    fixture.pane.input.type('\r')
    await waitFor('the skill invocation to reach the model', () =>
      fixture.pane.output.text().includes('skill turn ran'), 25_000)
    const wire = fixture.pane.output.text()
    assert.ok(!wire.includes('unknown skill'), 'the resolvable Skill must not fail')
    assert.ok(!wire.includes('is not available in the created session'),
      'the Skill wrapper stays on its real agent-facing route')
    assert.ok(!wire.includes('not available in TSP'), 'the Browser builtin gate does not refuse a Skill wrapper')
    assert.equal(pickerNode(fixture.pane, 'session-browser-'), undefined,
      'the Skill invocation does not open the Session Browser')
  } finally {
    await fixture.settle()
  }
})
