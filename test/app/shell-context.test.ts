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
  type ShellSubmitDeps,
} from '../../src/app/submission/shell-context.ts'
import { TransitionInProgressError } from '../../src/app/session/operation-barrier.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../../src/app/session/scope.ts'

interface FakeAgent {
  readonly session: { readonly id: string }
  followup(message: unknown): void
  readonly followed: { id: string; text: string }[]
}

function fakeAgent(id = 'session-shell'): FakeAgent {
  const followed: { id: string; text: string }[] = []
  return {
    session: { id },
    followup: message => { followed.push(message as { id: string; text: string }) },
    followed,
  }
}

function scopeOf(sessionId: string): LiveSessionScope {
  return { sessionId, subject: {} } as LiveSessionScope
}

function makeDeps(options: {
  readonly agent?: () => FakeAgent | undefined
  readonly scope?: LiveSessionScope
  readonly isScopeCurrent?: () => boolean
  readonly writer?: ShellSubmitDeps['writer']
} = {}): {
  deps: ShellSubmitDeps
  notices: { message: string; kind: 'info' | 'error' }[]
  cleared: { count: number }
  writes: { sessionId: string; message: unknown }[]
} {
  const notices: { message: string; kind: 'info' | 'error' }[] = []
  const cleared = { count: 0 }
  const writes: { sessionId: string; message: unknown }[] = []
  const initialAgent = options.agent?.()
  const scope = options.scope ?? scopeOf(initialAgent?.session.id ?? 'session-shell')
  const deps: ShellSubmitDeps = {
    scope,
    isScopeCurrent: options.isScopeCurrent ?? (() => options.agent === undefined || options.agent() === initialAgent),
    notify: (message, kind) => { notices.push({ message, kind }) },
    staleNotice: () => 'stale',
    writer: options.writer ?? {
      prompt: async (sessionId, message) => {
        writes.push({ sessionId, message })
        initialAgent?.followup(message)
        return { kind: 'committed' as const, value: undefined }
      },
    },
    createMessage: text => ({ id: `msg-${text.length}`, text }),
    onSubmitted: () => { cleared.count += 1 },
  }
  return { deps, notices, cleared, writes }
}

function stallingWriterSection(): {
  writerSection: <T>(scope: LiveSessionScope, task: () => Promise<T>) => Promise<T>
  release: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return {
    writerSection: <T>(_scope: LiveSessionScope, task: () => Promise<T>) => promise.then(task),
    release: () => resolve(),
  }
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

test('submitShellResult writes once to the captured Session scope and clears the card', async () => {
  const { deps, cleared, writes } = makeDeps({ scope: scopeOf('session-captured') })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'ok')
  assert.deepEqual(writes.map(write => write.sessionId), ['session-captured'])
  assert.equal(writes.length, 1)
  assert.equal(cleared.count, 1, 'the settled card is cleared once the send is accepted')
})

test('submitShellResult writes to the captured Host Session without a Client Agent', async () => {
  const { deps, cleared, writes } = makeDeps({ scope: scopeOf('remote-session') })
  assert.equal(await submitShellResult(deps, '$ ls\n[exit 0]'), 'ok')
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.sessionId, 'remote-session')
  assert.equal(cleared.count, 1)
})

// --- submitShellResult: TOCTOU session switch ---

test('submitShellResult: a switched scope aborts before the semantic writer', async () => {
  const { deps, notices, cleared, writes } = makeDeps({
    scope: scopeOf('session-a'),
    isScopeCurrent: () => false,
  })
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(writes.length, 0, 'nothing is written after the captured Session scope goes stale')
  assert.equal(cleared.count, 0, 'the card stays: the output was not submitted')
  assert.equal(notices.some(n => n.message === 'stale'), true)
})

test('submitShellResult uses the transport message builder for the captured Remote Session', async () => {
  const scope = scopeOf('remote-session')
  const { deps, writes, cleared } = makeDeps({ scope })
  let directBuilds = 0
  deps.createMessage = () => { directBuilds += 1; throw new Error('Remote must not build a Direct UserMessage') }
  deps.prepareMessage = async (captured, text) => ({ sessionId: captured.sessionId, segments: [{ type: 'text', text }] })
  assert.equal(await submitShellResult(deps, '$ echo remote result'), 'ok')
  assert.equal(directBuilds, 0)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], {
    sessionId: 'remote-session',
    message: { sessionId: 'remote-session', segments: [{ type: 'text', text: '$ echo remote result' }] },
  })
  assert.equal(cleared.count, 1)
})

test('submitShellResult revalidates the captured scope after asynchronous transport preparation', async () => {
  const scope = scopeOf('remote-session')
  let current = true
  const { deps, writes, notices, cleared } = makeDeps({ scope, isScopeCurrent: () => current })
  deps.prepareMessage = async (captured, text) => {
    assert.strictEqual(captured, scope)
    current = false
    return { sessionId: captured.sessionId, text }
  }
  assert.equal(await submitShellResult(deps, '$ echo stale result'), 'stale')
  assert.equal(writes.length, 0)
  assert.equal(cleared.count, 0)
  assert.deepEqual(notices, [{ message: 'stale', kind: 'error' }])
})

test('submitShell: a stale run scope skips the result submit entirely', async () => {
  const { submitShell } = await import('../../src/app/submission/runtime.ts')
  const written: unknown[] = []
  const notices: { message: string; kind: string }[] = []
  const ackReasons: string[] = []
  submitShell({
    command: 'pwd',
    result: 'out\n[exit 0]',
    scope: scopeOf('session-a'),
    isDisposed: () => false,
    isScopeCurrent: () => false,
    terminalAck: reason => { ackReasons.push(reason) },
    clearSettledLocalMessages: () => { throw new Error('the card must not be dismissed') },
    notify: (message, kind) => notices.push({ message, kind }),
    markDispatch: () => {},
    writerSection: async (_scope, task) => task(),
    writer: { prompt: async () => { written.push(1); return { kind: 'committed' as const, value: undefined } } },
    createMessage: (text: string) => ({ text }),
    diag: { debug: () => {}, warn: () => {}, error: () => {}, info: () => {} } as never,
    onSettled: () => {},
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(written.length, 0, 'the result is never submitted to a replacement Session')
  assert.equal(ackReasons.length > 0, true, 'the gesture ack row terminates on the skip')
  assert.ok(notices.some(notice => notice.message.includes('not submitted')))
})

test('submitShellResult: cancelled semantic write is cancellation-shaped', async () => {
  const agent = fakeAgent()
  const { deps, cleared, notices } = makeDeps({
    agent: () => agent,
    writer: { prompt: async () => ({ kind: 'cancelled' as const }) },
  })
  await assert.rejects(
    () => submitShellResult(deps, '$ ls\n[exit 0]'),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(cleared.count, 0)
  assert.deepEqual(notices, [])
})

test('submitShellResult: indeterminate semantic write is not retried or treated as committed', async () => {
  const agent = fakeAgent()
  const { deps, cleared, notices } = makeDeps({
    agent: () => agent,
    writer: { prompt: async () => ({ kind: 'indeterminate' as const, error: { code: 'transport/unknown', message: 'unknown' } }) },
  })
  assert.equal(await submitShellResult(deps, '$ ls\\n[exit 0]'), 'indeterminate')
  assert.equal(cleared.count, 0)
  assert.deepEqual(notices, [{ message: 'shell session write result is indeterminate — do not retry automatically', kind: 'error' }])
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

test('submitShellResult: TransitionInProgressError from the writer section refuses with the fence notice', async () => {
  const agent = fakeAgent()
  const { deps, notices, cleared } = makeDeps({ agent: () => agent })
  deps.writerSection = async () => { throw new TransitionInProgressError() }
  deps.fenceNotice = () => 'a session transition is in progress — the output stays on the card; re-run ! after it settles'
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(agent.followed.length, 0, 'no followup during a transition')
  assert.equal(cleared.count, 0, 'the card stays (the output is not lost)')
  assert.equal(notices.at(-1)?.kind, 'info')
  assert.ok(notices.at(-1)!.message.includes('transition is in progress'))
})

test('submitShellResult: a stale capture refuses stale, never as a frozen transition', async () => {
  const agent = fakeAgent()
  const { deps, notices, cleared } = makeDeps({ agent: () => agent })
  deps.writerSection = async () => { throw new SessionScopeSupersededError() }
  // The PRODUCTION wiring configures a transition-specific fence notice: a stale
  // capture must still take the STALE notice, never the transition one.
  deps.fenceNotice = () => 'a session transition is in progress'
  const outcome = await submitShellResult(deps, '$ ls\n[exit 0]')
  assert.equal(outcome, 'stale')
  assert.equal(agent.followed.length, 0, 'no followup for a superseded capture')
  assert.equal(cleared.count, 0, 'the card stays (the output is not lost)')
  assert.deepEqual(notices, [{ message: 'stale', kind: 'info' }],
    'a stale capture takes the stale refusal — the output stays on the card')
})

test('submitShellResult delivers normally after the writer section drains', async () => {
  const agent = fakeAgent()
  const { deps, cleared } = makeDeps({ agent: () => agent })
  const { writerSection, release } = stallingWriterSection()
  deps.writerSection = writerSection
  const pending = submitShellResult(deps, '$ ls\n[exit 0]')
  release()
  const outcome = await pending
  assert.equal(outcome, 'ok')
  assert.equal(agent.followed.length, 1)
  assert.equal(cleared.count, 1)
})