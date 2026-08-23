/**
 * Headless tests for the `!` shell context submission (kimi parity): the
 * mode classification, the model-facing submit text, and the guard/TOCTOU
 * races — a blocked write keeps the card, a session switch during the
 * guard aborts `stale`, and only an accepted send clears the card.
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
  type ShellSubmitGuard,
} from '../src/shell-context.ts'

type GuardVerdict = { kind: 'ok' | 'forced' } | { kind: 'blocked'; reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed' }

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
  guard: Promise<GuardVerdict>
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
    guard: { run: () => options.guard },
    notify: (message, kind) => { notices.push({ message, kind }) },
    blockedNotice: (reason) => `blocked:${reason}`,
    forcedNotice: () => 'forced',
    staleNotice: () => 'stale',
    createMessage: (text) => ({ id: `msg-${text.length}`, text }),
    onSubmitted: () => { cleared.count += 1 },
  }
  return { deps, notices, cleared }
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

test('submitShellResult: ok guard follows up and clears the card', async () => {
  const agent = fakeAgent()
  const { deps, cleared } = makeDeps({ agent: () => agent, guard: Promise.resolve({ kind: 'ok' }) })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'ok')
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.followed[0]!.text, '$ ls\n[exit 0]')
  assert.equal(cleared.count, 1, 'the settled card is cleared once the send is accepted')
})

test('submitShellResult: forced guard still follows up and notifies', async () => {
  const agent = fakeAgent()
  const { deps, notices, cleared } = makeDeps({ agent: () => agent, guard: Promise.resolve({ kind: 'forced' }) })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'ok')
  assert.equal(agent.followed.length, 1)
  assert.equal(cleared.count, 1)
  assert.equal(notices.some(n => n.message === 'forced' && n.kind === 'error'), true)
})

test('submitShellResult: no agent is a no-op (no card to clear)', async () => {
  const { deps, cleared } = makeDeps({ agent: () => undefined, guard: Promise.resolve({ kind: 'ok' }) })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'ok')
  assert.equal(cleared.count, 0)
})

// --- submitShellResult: blocked keeps the card ---

for (const reason of ['diverged', 'tail-mismatch', 'unreadable', 'removed'] as const) {
  test(`submitShellResult: ${reason} block notifies, never follows up, keeps the card`, async () => {
    const agent = fakeAgent()
    const { deps, notices, cleared } = makeDeps({
      agent: () => agent,
      guard: Promise.resolve({ kind: 'blocked', reason }),
    })
    const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
    assert.equal(outcome, 'blocked')
    assert.equal(agent.followed.length, 0, 'a blocked send must not reach the agent')
    assert.equal(cleared.count, 0, 'the card stays visible for review')
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.message, `blocked:${reason}`)
    assert.equal(notices[0]!.kind, 'error')
  })
}

// --- submitShellResult: TOCTOU session switch ---

test('submitShellResult: a session switch during the guard aborts stale', async () => {
  const agentA = fakeAgent('session-a')
  const agentB = fakeAgent('session-b')
  let live: ShellSubmitAgentLike = agentA
  let generation = 1
  const { deps, notices, cleared } = makeDeps({
    agent: () => live,
    generation: () => generation,
    guard: Promise.resolve({ kind: 'ok' }),
  })
  const pending = submitShellResult(deps, '$ ls\n[exit 0]')
  // The guard read is in flight; the user switched sessions.
  live = agentB
  generation = 2
  const outcome = await pending
  assert.equal(outcome, 'stale')
  assert.equal(agentA.followed.length, 0, 'nothing is written to the session the guard checked')
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
  const { deps, notices, cleared } = makeDeps({ agent: () => agent, guard: Promise.resolve({ kind: 'ok' }) })
  deps.fence = () => true
  deps.fenceNotice = () => 'a session transition is in progress — the output stays on the card; re-run ! after it settles'
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(agent.followed.length, 0, 'no followup may reach the old agent while a transition is in flight')
  assert.equal(cleared.count, 0, 'the card stays (the output is not lost)')
  assert.equal(notices.at(-1)?.kind, 'info')
  assert.ok(notices.at(-1)!.message.includes('transition is in progress'))
})
