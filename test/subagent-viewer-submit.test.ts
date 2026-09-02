/**
 * Runner-level tests for the interactive subagent viewer's human prompt
 * delivery seam (subagent-viewer-submit.ts, plan §17; DSH 0.1.2-alpha.4):
 * validation, the official `ctx.subagents.prompt(...)` call, requestId
 * minting, and error classification — with pure dependency injection, no
 * TUI surface.
 * @module @xmoon76/dsh-pi-tui/subagent-viewer-submit.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifySubagentPromptError,
  resolveSubagentSettleTarget,
  submitSubagentPrompt,
  viewerCanonicalizeScope,
  type SubagentPromptContentPart,
  type SubagentPromptService,
  type SubagentSettleViewerState,
  type SubagentViewerSubmitDeps,
  type SubagentViewerSubmitRequest,
} from '../src/subagent-viewer-submit.ts'

const request: SubagentViewerSubmitRequest = {
  parentSessionId: 'session-parent',
  childSessionId: 'session-child',
  content: [{ type: 'text', text: 'focus on cancellation races' }],
}

function deps(overrides: Partial<SubagentViewerSubmitDeps> = {}): SubagentViewerSubmitDeps {
  return {
    subagents: () => undefined,
    makeSignal: () => new AbortController().signal,
    mintRequestId: () => `request-${Math.random()}`,
    ...overrides,
  }
}

interface RecordedCall {
  requestId: string
  parentSessionId: string
  childSessionId: string
  mode: string
  content: readonly SubagentPromptContentPart[]
  clientTimeZone: string | undefined
  signal: AbortSignal
}

function service(calls: RecordedCall[]): SubagentPromptService {
  return {
    prompt: async (payload, signal) => {
      calls.push({
        requestId: payload.requestId,
        parentSessionId: payload.parentSessionId,
        childSessionId: payload.childSessionId,
        mode: payload.mode,
        content: payload.content,
        clientTimeZone: payload.clientTimeZone,
        signal,
      })
      return { messageId: `inbox-${payload.childSessionId}-1` }
    },
  }
}

test('delivers through the official prompt call with the official request vocabulary', async () => {
  const calls: RecordedCall[] = []
  const signal = new AbortController().signal
  const outcome = await submitSubagentPrompt(request, deps({
    subagents: () => service(calls),
    makeSignal: () => signal,
    mintRequestId: () => 'minted-request-id',
  }))
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind === 'ok') assert.equal(outcome.messageId, 'inbox-session-child-1')
  assert.equal(calls.length, 1, 'prompt called exactly once')
  assert.equal(calls[0]!.requestId, 'minted-request-id', 'the caller-minted id is persisted on the call')
  assert.equal(calls[0]!.parentSessionId, 'session-parent')
  assert.equal(calls[0]!.childSessionId, 'session-child')
  assert.equal(calls[0]!.mode, 'continuable', 'the browser control address keeps the continuable discriminator')
  assert.deepEqual(calls[0]!.content, request.content)
  assert.equal(calls[0]!.signal, signal, 'the caller-owned signal is forwarded to the official call')
})

test('every submit mints a FRESH requestId (a retry is a new human prompt)', async () => {
  const calls: RecordedCall[] = []
  let minted = 0
  const depsBase = deps({
    subagents: () => service(calls),
    mintRequestId: () => `request-${minted += 1}`,
  })
  await submitSubagentPrompt(request, depsBase)
  await submitSubagentPrompt(request, depsBase)
  assert.notEqual(calls[0]!.requestId, calls[1]!.requestId, 'two submits never share one identity')
})

test('the prompt text runs through the SAME canonicalization as the main session (@-mention expansion)', async () => {
  // The viewer editor keeps the concise `@src/foo.ts` form; the child
  // model must receive the absolute path exactly like a main-session
  // submission (expandFileMentionsForSubmit is the runner's wiring).
  const calls: RecordedCall[] = []
  const outcome = await submitSubagentPrompt(
    {
      parentSessionId: request.parentSessionId,
      childSessionId: request.childSessionId,
      content: [{ type: 'text', text: 'review @src/foo.ts' }],
    },
    deps({
      subagents: () => service(calls),
      canonicalizeText: (text) => text.replace('@src/foo.ts', '@/home/xmoon/project/src/foo.ts'),
    }),
  )
  assert.equal(outcome.kind, 'ok')
  const first = calls[0]!.content[0]!
  assert.equal(first.type, 'text')
  if (first.type === 'text') {
    assert.equal(first.text, 'review @/home/xmoon/project/src/foo.ts',
      'the prompt content must carry the canonicalized absolute path')
  }
})

test('a signal aborted while canonicalizing rejects BEFORE the write path (never a stale accept)', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const outcome = await submitSubagentPrompt(request, deps({
    makeSignal: () => controller.signal,
    canonicalizeText: async (text) => text,
    subagents: () => ({
      prompt: async () => {
        calls += 1
        return { messageId: 'inbox-1' }
      },
    }),
  }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'cancelled' } })
  assert.equal(calls, 0, 'the write path must never be invoked with an already-aborted signal')
})

test('rejects when the continuation runtime is unavailable', async () => {
  const outcome = await submitSubagentPrompt(request, deps({ subagents: () => undefined }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'unavailable' } })
})

test('classifies the official RemoteError vocabulary into the stable reason set', () => {
  const cases: Array<[string, string]> = [
    ['subagent/parent-unavailable', 'parent-unavailable'],
    ['subagent/not-resumable', 'stale-child'],
    ['subagent/unauthorized', 'unauthorized'],
    ['subagent/delivery-unavailable', 'unavailable'],
    ['gateway/cancelled', 'cancelled'],
    ['subagent/invalid-time-zone', 'error'],
    ['subagent/attachment-invalid', 'error'],
    ['gateway/bad-request', 'error'],
    ['gateway/internal', 'error'],
  ]
  for (const [code, kind] of cases) {
    const reason = classifySubagentPromptError(makeError(code))
    assert.equal(reason.kind, kind, `code ${code}`)
  }
})

test('classifies cancellation before inbox acceptance as cancelled (message never owned by the child)', () => {
  const reason = classifySubagentPromptError(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  assert.deepEqual(reason, { kind: 'cancelled' })
})

test('the OLD SubagentError vocabulary is NOT interpreted anymore (superseded by alpha.4)', () => {
  // alpha.4 replaced the internal NOT_RESUMABLE/DRAINING/… codes with the
  // RemoteError vocabulary; reading the old codes again would silently
  // misclassify a future Host failure — they must fall through to `error`.
  for (const code of ['NOT_RESUMABLE', 'UNAUTHORIZED', 'PARENT_UNAVAILABLE', 'DRAINING', 'ACTIVATION_CLOSING']) {
    const reason = classifySubagentPromptError(makeError(code))
    assert.equal(reason.kind, 'error', `legacy code ${code} must not be classified`)
  }
})

test('a prompt that REJECTS surfaces the classified reason (never a throw)', async () => {
  const outcome = await submitSubagentPrompt(request, deps({
    subagents: () => ({
      prompt: async () => { throw Object.assign(new Error('subagent cannot be resumed'), { code: 'subagent/not-resumable' }) },
    }),
  }))
  assert.deepEqual(outcome, { kind: 'rejected', reason: { kind: 'stale-child' } })
})

test('an unexpected throw surfaces as a safe error reason with a message', async () => {
  const outcome = await submitSubagentPrompt(request, deps({
    subagents: () => ({
      prompt: async () => { throw new Error('boom') },
    }),
  }))
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') {
    assert.equal(outcome.reason.kind, 'error')
    if (outcome.reason.kind === 'error') assert.equal(outcome.reason.message, 'boom')
  }
})

function makeError(code: string): Error {
  return Object.assign(new Error(`remote error: ${code}`), { code })
}

// ── settle target resolution (plan §12: the current/stale split) ──────────

const settleView = (overrides: Partial<SubagentSettleViewerState> = {}): SubagentSettleViewerState => ({
  viewingChildId: 'session-child',
  viewingLabel: 'research',
  viewingParentSessionId: 'session-parent',
  viewerGenerationAtSend: 3,
  viewerGenerationNow: 3,
  liveParentSessionId: 'session-parent',
  ...overrides,
})

test('a settle is CURRENT only while the SAME viewer session is unchanged', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView()),
    { kind: 'current', label: 'research' })
})

test('a close → REOPEN of the SAME child is STALE (the generation moved)', () => {
  // The exact round-2 scenario: the viewer was closed and reopened for the
  // same child id while the send was in flight — the new viewer session
  // must not be touched by the old send's settle.
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewerGenerationNow: 5,
  })), { kind: 'stale' })
})

test('a child switch is STALE even when the new child is the same id via another parent', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewingChildId: 'session-other',
  })), { kind: 'stale' })
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewingParentSessionId: 'session-other-parent',
  })), { kind: 'stale' })
})

test('a parent session switch at settle time is STALE', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    liveParentSessionId: 'session-other',
  })), { kind: 'stale' })
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    liveParentSessionId: undefined,
  })), { kind: 'stale' })
})

test('a closed viewer (no viewing child) is STALE', () => {
  assert.deepEqual(resolveSubagentSettleTarget(request, settleView({
    viewingChildId: undefined,
    viewingLabel: undefined,
    viewingParentSessionId: undefined,
  })), { kind: 'stale' })
})

test('review: the canonicalize scope is the VIEWED CHILD workspace, never the parent cwd', () => {
  // The child may have been born in another directory: rewriting its
  // `@src/foo.ts` against the PARENT cwd would resolve to the wrong tree.
  // A known child cwd wins; an unknown cold-child cwd falls back to the
  // live parent session.
  assert.deepEqual(
    viewerCanonicalizeScope('/repo-b', 'session-parent'),
    { kind: 'workspace', cwd: '/repo-b' },
    'a known child cwd is the scope (parent cwd is irrelevant)',
  )
  assert.deepEqual(
    viewerCanonicalizeScope('', 'session-parent'),
    { kind: 'session', sessionId: 'session-parent' },
    'an unknown cold-child cwd falls back to the live parent',
  )
  assert.deepEqual(
    viewerCanonicalizeScope(undefined, undefined),
    { kind: 'session', sessionId: '' },
    'a sessionless fallback stays fail-closed',
  )
})

test('image parts are forwarded VERBATIM (the Host admits them; the TUI never rewrites them)', async () => {
  // The DTO mirrors the official PromptContentPart vocabulary: an image
  // part rides through untouched — no canonicalization, no rewriting —
  // while a text part in the same prompt still canonicalizes.
  const calls: RecordedCall[] = []
  const outcome = await submitSubagentPrompt(
    {
      parentSessionId: request.parentSessionId,
      childSessionId: request.childSessionId,
      content: [
        { type: 'text', text: 'review @src/foo.ts' },
        { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
      ],
    },
    deps({
      subagents: () => service(calls),
      canonicalizeText: (text) => text.replace('@src/foo.ts', '@/home/xmoon/project/src/foo.ts'),
    }),
  )
  assert.equal(outcome.kind, 'ok')
  assert.deepEqual(calls[0]!.content, [
    { type: 'text', text: 'review @/home/xmoon/project/src/foo.ts' },
    { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' },
  ], 'text canonicalizes, the image part is forwarded verbatim')
})
