/**
 * M6 PR-C C3 (RFL-012): the presence revision scope SURVIVES the
 * qualification-only Surface replacement.
 *
 * The Host stores ONE strictly increasing revision per authenticated Peer and
 * retires the record only when the Peer disconnects. The runner derives its
 * revision counter from the Client CONNECTION root through the mount seam
 * (`presencePeerScope`) — never from its own plugin fiber: a fresh Cordis
 * fiber per Surface revision is a fresh scope key and would reset the counter
 * into a `stale-revision` refusal, blocking every later prompt.
 *
 * The regression drives the PRODUCTION wiring twice (two plugin fibers over
 * one Client Context, each mount passing `presencePeerScope`) against a
 * STRICT Host stand-in that refuses non-increasing revisions, and proves the
 * replacement Surface's first prompt reaches the submission sink (a refused
 * presence gate would RESTORE the draft instead of consuming it).
 *
 * @module @xmoon76/dsh-pi-tui/app/presence-surface-replacement.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../../src/index.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import type { RemoteApplicationOverride, RemotePromptPresenceCapability } from '../../src/app/application-runtime.ts'
import { createRemoteApplicationRuntime } from '../support/m3-inprocess/application-runtime.ts'
import { createRemoteApplicationHostFixture, waitFor } from '../support/remote-application-fixture.ts'
import { ownTransportTeardown } from '../support/transport-teardown-ownership.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

class SmokeLlmAdapter extends (await import('@deepseek-ai/dsh-llm')).LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'remote reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'remote reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('the presence revision scope survives a Surface replacement through the production wiring (RFL-012)', async (t) => {
  const life = testLifecycle(t)
  const vt = new VirtualTerminal(110, 32)
  life.defer(installVirtualProcessTerminal(vt))
  // The STRICT Host stand-in: one strictly increasing revision per Peer,
  // exactly the real service's `stale-revision` refusal.
  const seen: Array<{ revision: number; applied: boolean }> = []
  let record: number | undefined
  const promptPresence: RemotePromptPresenceCapability = {
    syncView: (_viewedSessionId, _displayPreset, revision) => {
      const applied = record === undefined || revision > record
      if (applied) record = revision
      seen.push({ revision, applied })
      return Promise.resolve(applied
        ? { ok: true as const, value: { kind: 'applied' as const, revision } }
        : { ok: true as const, value: { kind: 'refused' as const, reason: 'stale-revision' as const } })
    },
  }
  const presetId = 'm6-pr-c-presence-replacement-preset'
  const host = await createRemoteApplicationHostFixture(life, presetId, { llmAdapter: new SmokeLlmAdapter() })
  host.ctx.provide('appExit', (): void => {})
  const { TUI_STARTUP_SERVICE } = await import('../../src/startup.ts')
  host.ctx.provide(TUI_STARTUP_SERVICE, {
    sessionId: 'm6-pr-c-presence-replacement',
    shippedPresetRoot: host.workRoot,
  })
  const sessionId = 'm6-pr-c-presence-replacement'
  await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const mountRevision = async () => {
    const aggregate = await createRemoteApplicationRuntime({
      hostContext: host.ctx,
      waitForHostPrerequisites: async () => {},
      clientUiStartup: { sessionId },
    })
    const ownership = ownTransportTeardown(aggregate.selected)
    life.defer(ownership.runFallback)
    const override: RemoteApplicationOverride = {
      selected: aggregate.selected,
      presentation: aggregate.presentation,
      extensionService: aggregate.clientUi.extensionService,
      promptPresence,
    }
    const fiber = host.ctx.plugin(pluginCtx => {
      applyRunnerWithRuntime(
        pluginCtx,
        TuiConfigSchema({ fullscreen: 'off', sessionId } as never),
        override,
        {
          surfaceReady: () => {},
          surfaceFailed: () => {},
          // PRODUCTION wiring: the Client CONNECTION root, never the plugin fiber.
          presencePeerScope: host.ctx,
        },
      )
    })
    life.defer(async () => { await fiber.dispose() })
    await fiber
    return { fiber, aggregate }
  }
  // Revision 1: the first Surface projects its presence on the shared scope.
  const revision1 = await mountRevision()
  await waitFor('the first Surface projects its presence', () => seen.some(call => call.applied))
  const first = seen.find(call => call.applied)
  assert.ok(first !== undefined)
  // The qualification-only Surface replacement: retire the old revision
  // (runner fiber -> application/Domain release) and remount over the SAME
  // Client Context (a fresh plugin fiber and a fresh application).
  await revision1.fiber.dispose()
  await revision1.aggregate.selected.disposeTransport()
  await mountRevision()
  await waitFor('the replacement projects its presence', () => seen.some(call => call.applied && call.revision > first.revision))
  assert.ok(seen.every(call => call.applied),
    'the strict Host accepted every same-Peer revision (no stale-revision refusal)')
  // The sink proof: the replacement Surface's first prompt reaches the writer.
  // A refused presence gate would RESTORE the draft instead of consuming it.
  await waitFor('the replacement Surface mounts its TUI app', () => apps.length > 0)
  const app = apps.at(-1) as { setDraft(text: string): void; submitDraft(): void; getDraft(): string }
  app.setDraft('replacement first prompt')
  app.submitDraft()
  await waitFor('the replacement prompt reaches the writer', () => app.getDraft() === '')
  assert.equal(app.getDraft(), '', 'the replacement Surface dispatched its first prompt')
})
