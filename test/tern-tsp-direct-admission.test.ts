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
  const fixture = await createDirectTspFixture(life, {
    hostCommands: [{
      name: 'failing',
      description: 'Always fails',
      definitionId: 'host-failing-def',
      handler: () => ({ kind: 'error', text: 'the command failed on purpose' }),
    }],
  })
  try {
    await directSettle(4_000)
    fixture.pane.input.type('/failing')
    await directSettle()
    assert.equal(latestComposerText(fixture.pane.output.text()), '/failing')
    fixture.pane.input.type('\r')
    // The refusal/failure path restores the submitted line into the LIVE
    // composer through the real controller (never a stale snapshot).
    await waitFor('the draft rollback', () => latestComposerText(fixture.pane.output.text()) === '/failing', 25_000)
    assert.equal(latestComposerText(fixture.pane.output.text()), '/failing',
      'the failed command line is live draft content again')
  } finally {
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

for (const busyEnter of ['queue', 'steer'] as const) {
  test(`B2/Direct: a plain Enter into a RUNNING turn takes the configured busyEnter=${busyEnter}`, async (t) => {
    const { testLifecycle } = await import('./support/temp-lifecycle.ts')
    const life = testLifecycle(t)
    let releaseStream!: () => void
    const held = new Promise<void>(resolve => { releaseStream = resolve })
    const fixture = await createDirectTspFixture(life, {
      deltas: ['LATE-REPLY'],
      streamHold: () => held,
      // The SAME volatile authority `applyRunner` reads: the busy preference
      // under test is the real configured one, not a stand-in.
      tuiConfig: { busyEnter },
    })
    try {
      await directSettle(4_000)
      // Start a real turn; its model stream is HELD so the turn stays running.
      fixture.pane.input.type('first prompt')
      await directSettle()
      fixture.pane.input.type('\r')
      await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
      // A second plain Enter while the turn is running.
      fixture.pane.input.type('second prompt')
      await directSettle()
      fixture.pane.input.type('\r')
      await directSettle(2_000)
      const wire = fixture.pane.output.text()
      if (busyEnter === 'queue') {
        assert.ok(/queued \(/.test(wire),
          'the running-turn Enter QUEUED the second prompt (the configured preference)')
      } else {
        assert.ok(/steering/.test(wire),
          'the running-turn Enter STEERED the second prompt (the configured preference)')
      }
      // No duplicate pending ledger row for the same gesture.
      assert.equal((wire.match(/queued \(/g) ?? []).length + (wire.match(/steering/g) ?? []).length, 1,
        'exactly ONE pending delivery row exists for the second submission')
      releaseStream()
      await directSettle(2_000)
    } finally {
      releaseStream()
      await fixture.settle()
    }
  })
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
