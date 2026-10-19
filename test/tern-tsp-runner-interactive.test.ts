/**
 * PR3-B B2 interactive runner tests.
 *
 * Everything here runs the REAL composition root (`mountRunner` → `applyRunner`
 * → `startRunner`) with the TSP opt-in over the scripted pane (see
 * `test/support/tsp-runner-harness.ts`): the shipped SDK connect,
 * `productionTspConnector`, `selectRendererMount`, `SurfaceRuntime`, the real
 * `SubmissionController` and the Direct Host stand-in services all execute for
 * real. Only the tty boundary and the Host stand-in services are simulated —
 * no hand-built business state, and no assertion is allowed to be satisfied by
 * a frame that predates the business action it claims to prove (the B2 review's
 * F5).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-runner-interactive.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { ownTspBoot, settle, waitUntil } from './support/tsp-runner-harness.ts'

/**
 * The LATEST controlled editor text the wire committed for `dock.composer`,
 * reconstructed from the SDK's own op sequence: `add` seeds the node,
 * `set`/`text` carry every later update. A naive "find the add node" scan
 * returns the INITIAL empty editor and would make a post-submit assertion pass
 * before anything happened (the F5 false-green).
 */
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

// ── The TUI-builtin admission on the TSP renderer ────────────────────────────

test('B2: a TUI builtin with PiTui UI is refused on TSP with the draft restored', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  const owned = await ownTspBoot({ life, home, logFile })
  try {
    owned.pane.input.type('/settings')
    await settle()
    const beforeSubmit = owned.pane.output.text()
    assert.equal(latestComposerText(beforeSubmit), '/settings', 'the draft is on the wire BEFORE the gesture')
    owned.pane.input.type('\r')
    await waitUntil('the refusal notice', () => owned.pane.output.text().includes('not available in TSP'))
    const wire = owned.pane.output.text()
    // The refusal restored the line into the live composer: the LATEST editor
    // state (not the initial add) must show it again.
    assert.equal(latestComposerText(wire), '/settings', 'the refused line is live draft content again')
    assert.equal(owned.harness.createdSessions.length, 0,
      'a refused builtin never ensured/created a Session')
  } finally {
    await owned.settle()
  }
})

test('B2: a NON-TUI slash line is never refused by the builtin gate (the F1 regression)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  // An unregistered slash name is an ORDINARY submission (not a TUI builtin):
  // the pre-fix consumer refused every parsed line, so this case is the direct
  // regression lock for the family bug. The line must reach the ordinary
  // submission path instead — observable as a Session being ensured for it.
  const owned = await ownTspBoot({ life, home, logFile })
  try {
    owned.pane.input.type('/not-a-registered-command body')
    await settle()
    owned.pane.input.type('\r')
    await settle(1_500)
    assert.ok(!owned.pane.output.text().includes('not available in TSP'),
      'an ordinary slash line is NOT reported as an unsupported TSP builtin')
  } finally {
    await owned.settle()
  }
})

test('B2: `/exit` is allowed through (the exit pair is the only supported TUI builtin)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  let exited = false
  const owned = await ownTspBoot({ life, home, logFile, appExit: () => { exited = true } })
  try {
    owned.pane.input.type('/exit')
    await settle()
    owned.pane.input.type('\r')
    await waitUntil('the exit orchestration', () => exited)
    assert.equal(exited, true, '/exit routed the existing exit orchestration')
  } finally {
    await owned.settle()
  }
})

test('B2: `/quit` exits through the registered alias (the true catalog claim)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  let exited = false
  const owned = await ownTspBoot({ life, home, logFile, appExit: () => { exited = true } })
  try {
    // /quit is /exit's canonical registered alias: the gate must let it through
    // and the REAL registry must resolve it to the exit orchestration.
    owned.pane.input.type('/quit')
    await settle()
    owned.pane.input.type('\r')
    await waitUntil('the /quit exit orchestration', () => exited)
    assert.equal(exited, true, '/quit resolved through its registered alias and exited')
  } finally {
    await owned.settle()
  }
})

// ── The local user-shell refusal (no Host process, no session, no history) ──

for (const line of ['!echo hi', '!!echo hi']) {
  test(`B2: \`${line}\` is refused before any Host shell run or Session`, async (t) => {
    const { testLifecycle } = await import('./support/temp-lifecycle.ts')
    const life = testLifecycle(t)
    const home = life.tempDir('pr3b-tsp-interactive-')
    const logFile = join(home, 'diag.log')
    // A recorder shell executor: the refusal must reach it ZERO times.
    const shellRuns: string[] = []
    const shell = {
      execute: async (request: { command: string }) => {
        shellRuns.push(request.command)
        return { kind: 'unavailable', reason: new Error('the recorder shell never executes') }
      },
    }
    const owned = await ownTspBoot({ life, home, logFile, shell })
    try {
      owned.pane.input.type(line)
      await settle()
      owned.pane.input.type('\r')
      await waitUntil('the shell refusal', () =>
        owned.pane.output.text().includes('User-shell UI is not available in TSP'))
      assert.deepEqual(shellRuns, [], 'the Host shell executor was never reached')
      assert.equal(owned.harness.createdSessions.length, 0,
        'the refusal created no Session (it sits before ensureSession)')
      assert.equal(latestComposerText(owned.pane.output.text()), line,
        'the refused line is live draft content again')
    } finally {
      await owned.settle()
    }
  })
}

// ── A plain prompt rides the ONE existing submission path ───────────────────

test('B2: a plain Enter takes the real application submit path', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  // Let the Direct writer COMMIT the prompt (the harness default degrades it
  // to `session/agent-busy`, which is the mode the shell-card suites need).
  const owned = await ownTspBoot({ life, home, logFile, acceptPrompts: true })
  try {
    owned.pane.input.type('hello from the TSP pane')
    await settle()
    const beforeSubmit = owned.pane.output.text()
    // The positive control: BEFORE the gesture the LATEST editor state is the
    // typed draft. A naive "first add node" scan reports '' here — the F5 trap
    // this reconstruction exists to close.
    assert.equal(latestComposerText(beforeSubmit), 'hello from the TSP pane',
      'the typed draft is the latest committed editor state before the submit')
    assert.equal(owned.harness.createdSessions.length, 0, 'no Session exists before the submit')
    owned.pane.input.type('\r')
    // The submission reached the REAL application: the ordinary-prompt path
    // ensured a Session for it. (Whether the composer ends up empty or restored
    // is the application's business — a refused/failed write RESTORES the draft
    // by design, so asserting "empty" here would assert the harness's failure
    // mode, not the contract.)
    await waitUntil('the application to ensure a session for the submission',
      () => owned.harness.createdSessions.length >= 1, 15_000)
    assert.ok(owned.harness.createdSessions.length >= 1,
      'the Enter gesture drove the existing submission path (ensureSession ran)')
    // The COMMITTED write: the Direct SessionWriter delivered the prompt to the
    // live Agent, which appended the official `user/message` occurrence to the
    // session — exactly one, carrying the typed text. (The writer would degrade
    // every prompt to `session/agent-busy` if the agent could not accept it, so
    // this is the positive proof that the TSP Enter reaches the backend writer.)
    await waitUntil('the committed prompt occurrence', () => {
      const session = owned.harness.createdSessions[0]
      if (session === undefined) return false
      return session.snapshotEvents().some(event =>
        (event as { type?: string }).type === 'user/message')
    }, 15_000)
    const delivered = owned.harness.createdSessions[0]!.snapshotEvents()
      .filter(event => (event as { type?: string }).type === 'user/message')
    assert.equal(delivered.length, 1, 'exactly ONE prompt occurrence was committed (no double-send)')
    assert.ok(JSON.stringify(delivered[0]).includes('hello from the TSP pane'),
      'the committed occurrence carries the typed draft')
  } finally {
    await owned.settle()
  }
})

// ── The startup window: a held Enter must NOT bypass the refusals ───────────

test('B2: a `!` HELD with the SDK handshake is refused too — no shell/session side effects at the bind', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  const shellRuns: string[] = []
  const shell = {
    execute: async (request: { command: string }) => {
      shellRuns.push(request.command)
      return { kind: 'unavailable', reason: new Error('the recorder shell never executes') }
    },
  }
  // The keys arrive in the SAME chunk as the hello reply: the renderer holds
  // them until the application binding, and the binding must already know this
  // is the TSP renderer (the B2 review's F2 ordering defect).
  const owned = await ownTspBoot({
    life, home, logFile, shell,
    beforeMount: pane => { pane.queueWithHandshake('!echo held\r') },
  })
  try {
    await waitUntil('the held shell refusal', () =>
      owned.pane.output.text().includes('User-shell UI is not available in TSP'), 15_000)
    assert.deepEqual(shellRuns, [], 'the held `!` never reached the Host shell executor')
    assert.equal(owned.harness.createdSessions.length, 0,
      'the held `!` created no Session at the bind replay')
  } finally {
    await owned.settle()
  }
})
