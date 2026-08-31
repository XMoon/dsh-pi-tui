/**
 * Headless tests for the `!` shell context submission (kimi parity): the
 * mode classification, the model-facing submit text, and the TOCTOU
 * races — a session switch mid-send aborts `stale`, the transition fence
 * refuses the write, and only an accepted send clears the card.
 * @module @xmoon76/dsh-pi-tui/shell-context.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatShellSubmitText,
  localShellSandboxPreferenceOf,
  shellCommandOf,
  shellModeOf,
  submitShellResult,
  type ShellSubmitAgentLike,
  type ShellSubmitDeps,
} from '../src/shell-context.ts'
import { TransitionInProgressError, type SessionOperationBarrier } from '../src/session-operation-barrier.ts'

interface FakeAgent extends ShellSubmitAgentLike {
  followed: { id: string; text: string }[]
}

function fakeAgent(id = 'session-shell'): FakeAgent {
  const followed: { id: string; text: string }[] = []
  return {
    session: { id },
    followup: (message) => { followed.push(message as { id: string; text: string }) },
    followed,
  }
}

function makeDeps(options: {
  agent: () => ShellSubmitAgentLike | undefined
  generation?: () => number
}): {
  deps: ShellSubmitDeps
  notices: { message: string; kind: 'info' | 'error' }[]
  /** Mutable counter (AGENTS.md trap: a number would be copied by value). */
  cleared: { count: number }
} {
  const notices: { message: string; kind: 'info' | 'error' }[] = []
  const cleared = { count: 0 }
  const deps: ShellSubmitDeps = {
    currentAgent: options.agent,
    currentGeneration: options.generation ?? (() => 1),
    notify: (message, kind) => { notices.push({ message, kind }) },
    staleNotice: () => 'stale',
    createMessage: (text) => ({ id: `msg-${text.length}`, text }),
    onSubmitted: () => { cleared.count += 1 },
  }
  return { deps, notices, cleared }
}

/** A fake barrier whose runWriter waits on a manual resolve: the write is
 * IN FLIGHT (draining) until the test releases it. */
function stallingBarrier(): { barrier: SessionOperationBarrier; release: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  const barrier = {
    runWriter: (_sessionId: string, task: () => unknown) => promise.then(task),
  } as unknown as SessionOperationBarrier
  return { barrier, release: () => resolve() }
}

// --- classification ---

test('shellModeOf: `!` is context, `!!` is local, non-bang is undefined', () => {
  assert.equal(shellModeOf('!ls -la'), 'context')
  assert.equal(shellModeOf('!'), 'context')
  assert.equal(shellModeOf('!!ls -la'), 'local')
  assert.equal(shellModeOf('!!!ls'), 'local')
  assert.equal(shellModeOf('ls -la'), undefined)
  assert.equal(shellModeOf('/status'), undefined)
})

test('shellCommandOf strips every leading bang and trims', () => {
  assert.equal(shellCommandOf('!ls -la'), 'ls -la')
  assert.equal(shellCommandOf('!!ls'), 'ls')
  assert.equal(shellCommandOf('!!!ls'), 'ls')
  assert.equal(shellCommandOf('!  ls  '), 'ls')
  assert.equal(shellCommandOf('!'), '')
  assert.equal(shellCommandOf('!!   '), '')
})

test('formatShellSubmitText echoes the command $ -style above the result', () => {
  assert.equal(formatShellSubmitText('ls -la', 'total 8\n[exit 0]'), '$ ls -la\ntotal 8\n[exit 0]')
  assert.equal(formatShellSubmitText('false', 'failed: boom'), '$ false\nfailed: boom')
})

// --- submitShellResult: happy path ---

test('submitShellResult: accepted send follows up and clears the card', async () => {
  const agent = fakeAgent()
  const { deps, cleared } = makeDeps({ agent: () => agent })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'ok')
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.followed[0]!.text, '$ ls\n[exit 0]')
  assert.equal(cleared.count, 1, 'the settled card is cleared once the send is accepted')
})

test('submitShellResult: no agent is a no-op (no card to clear)', async () => {
  const { deps, cleared } = makeDeps({ agent: () => undefined })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'ok')
  assert.equal(cleared.count, 0)
})

// --- submitShellResult: TOCTOU session switch ---

test('submitShellResult: a session switch mid-send aborts stale', async () => {
  const agentA = fakeAgent('session-a')
  const agentB = fakeAgent('session-b')
  // The send reads the surface three times: the wrapper's sessionId probe
  // and the core's capture (both see session-a), then the re-validation
  // (session-b) — the deterministic model of a session switch in between.
  // The identity check must refuse.
  let reads = 0
  const { deps, notices, cleared } = makeDeps({
    agent: () => (reads += 1) <= 2 ? agentA : agentB,
  })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(agentA.followed.length, 0, 'nothing is written to the session the identity checked')
  assert.equal(agentB.followed.length, 0, 'nothing is written to the new session either')
  assert.equal(cleared.count, 0, 'the card stays: the output was not submitted')
  assert.equal(notices.some(n => n.message === 'stale'), true)
})

// --- localShellSandboxPreferenceOf ---

test('localShellSandboxPreferenceOf defaults to bypass and honors only sandbox', () => {
  assert.equal(localShellSandboxPreferenceOf(undefined), 'bypass')
  assert.equal(localShellSandboxPreferenceOf({}), 'bypass')
  assert.equal(localShellSandboxPreferenceOf({ localShellSandbox: 'bypass' }), 'bypass')
  assert.equal(localShellSandboxPreferenceOf({ localShellSandbox: 'sandbox' }), 'sandbox')
  assert.equal(localShellSandboxPreferenceOf({ localShellSandbox: 'something-else' }), 'bypass')
})

// ── review round 4: the session-transition write fence ─────────────────────

test('the transition fence refuses the shell followup (output stays on the card)', async () => {
  const agent = fakeAgent()
  const { deps, notices, cleared } = makeDeps({ agent: () => agent })
  deps.fence = () => true
  deps.fenceNotice = () => 'a session transition is in progress — the output stays on the card; re-run ! after it settles'
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(agent.followed.length, 0, 'no followup may reach the old agent while a transition is in flight')
  assert.equal(cleared.count, 0, 'the card stays (the output is not lost)')
  assert.equal(notices.at(-1)?.kind, 'info')
  assert.ok(notices.at(-1)!.message.includes('transition is in progress'))
})

// ── convergence phase 3: the write itself runs inside the barrier ──────────

test('submitShellResult: TransitionInProgressError from the barrier refuses with the fence notice', async () => {
  const agent = fakeAgent()
  const { deps, notices, cleared } = makeDeps({ agent: () => agent })
  deps.barrier = {
    runWriter: async () => { throw new TransitionInProgressError() },
  } as unknown as SessionOperationBarrier
  deps.fenceNotice = () => 'a session transition is in progress — the output stays on the card; re-run ! after it settles'
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(agent.followed.length, 0, 'no followup during a transition')
  assert.equal(cleared.count, 0, 'the card stays (the output is not lost)')
  assert.equal(notices.at(-1)?.kind, 'info')
  assert.ok(notices.at(-1)!.message.includes('transition is in progress'))
})

test('submitShellResult delivers normally after the barrier drains', async () => {
  const agent = fakeAgent()
  const { deps, cleared } = makeDeps({ agent: () => agent })
  const { barrier, release } = stallingBarrier()
  deps.barrier = barrier
  const pending = submitShellResult(deps, '$ ls\n[exit 0]')
  release()
  const outcome = await pending
  assert.equal(outcome, 'ok')
  assert.equal(agent.followed.length, 1)
  assert.equal(cleared.count, 1)
})