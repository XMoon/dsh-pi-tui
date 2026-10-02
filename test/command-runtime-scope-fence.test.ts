/**
 * PR5 (plan §3.7) unit coverage: the async scope-bound command reads
 * (`currentSessionStats`, `lastAssistantText`) re-validate the ORIGINAL
 * session scope after the await — a read that began on session A must
 * settle as `SupersededReadError` when the visible owner became B, never
 * deliver A's figures/text to the command UI. Mirrors the pattern
 * `refreshSessionCatalog` already implements.
 * @module @xmoon76/dsh-pi-tui/command-runtime-scope-fence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { bindCommandRuntime } from '../src/app/command/runtime.ts'
import { SupersededReadError } from '../src/runtime/read-error.ts'
import type { LiveSessionScope, SessionScopeAuthority } from '../src/app/session/scope.ts'

const SCOPE = { sessionId: 'session-a' } as unknown as LiveSessionScope

function harness(options: {
  /** Flip the scope currency DURING the read await (the stale window). */
  readonly staleDuringRead?: boolean
  readonly statsResult?: unknown
  readonly textResult?: unknown
}) {
  let scopeCurrent = true
  const calls: string[] = []
  const authority = {
    capture: () => ({ sessionId: 'session-a' }) as never,
    captureLive: () => SCOPE,
    isCurrent: () => scopeCurrent,
  } as unknown as SessionScopeAuthority
  const runtime = bindCommandRuntime({
    scope: authority,
    session: {
      ensureSession: async () => SCOPE,
      withWriter: async <T>(_scope: unknown, task: () => T) => task(),
    } as never,
    skills: {} as never,
    surface: {
      listScopedCommands: () => [],
      sessionRunning: () => false,
      sessionRouting: () => ({ provider: undefined, model: undefined, cwd: '/ws' }),
      approvalOverride: () => undefined,
      sessionStats: async (sessionId: string) => {
        calls.push(`stats:${sessionId}`)
        if (options.staleDuringRead === true) scopeCurrent = false
        await Promise.resolve()
        return options.statsResult
      },
      lastAssistantText: async (sessionId: string) => {
        calls.push(`text:${sessionId}`)
        if (options.staleDuringRead === true) scopeCurrent = false
        await Promise.resolve()
        return options.textResult
      },
      refreshLiveCatalog: async () => ({ kind: 'failed' as const, error: 'unused' }),
      refreshStandingCatalog: async () => ({ kind: 'failed' as const, error: 'unused' }),
      promptAdmission: async <T>(_id: string, _line: string, task: () => T) => task(),
    } as never,
  })
  return { runtime, calls, setScopeCurrent: (value: boolean) => { scopeCurrent = value } }
}

test('PR5 §3.7: currentSessionStats re-checks the ORIGINAL scope after the await', async () => {
  const stale = harness({ staleDuringRead: true, statsResult: { turns: 99 } })
  await assert.rejects(
    stale.runtime.currentSessionStats(SCOPE),
    (error: unknown) => error instanceof SupersededReadError,
    'a stats read whose subject was replaced mid-flight settles as SupersededReadError')
  assert.deepEqual(stale.calls, ['stats:session-a'], 'the read was admitted once against the captured session')

  const live = harness({ statsResult: { turns: 3 } })
  const stats = await live.runtime.currentSessionStats(SCOPE)
  assert.deepEqual(stats, { turns: 3 }, 'a current-scope read returns the figures unchanged')
})

test('PR5 §3.7: lastAssistantText re-checks the ORIGINAL scope after the await', async () => {
  const stale = harness({ staleDuringRead: true, textResult: 'old-session text' })
  await assert.rejects(
    stale.runtime.lastAssistantText(SCOPE),
    (error: unknown) => error instanceof SupersededReadError,
    'a /copy text read whose subject was replaced mid-flight never returns the old text')
  assert.deepEqual(stale.calls, ['text:session-a'])

  const live = harness({ textResult: 'current text' })
  assert.equal(await live.runtime.lastAssistantText(SCOPE), 'current text')
})

test('PR5 §3.7: a scope that goes stale BEFORE dispatch never starts the read', async () => {
  const h = harness({ textResult: 'never' })
  h.setScopeCurrent(false)
  await assert.rejects(
    h.runtime.lastAssistantText(SCOPE),
    (error: unknown) => error instanceof SupersededReadError,
    'the pre-dispatch fence still applies')
  assert.deepEqual(h.calls, [], 'no read was dispatched')
})
