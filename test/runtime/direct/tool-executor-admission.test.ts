/**
 * The official tool-executor admission contract (DSH 0.2.2): a composition
 * that mounts the tool registry WITHOUT an executor refuses every batch with
 * `TOOL_EXECUTOR_UNAVAILABLE`. There is no legacy single-call fallback — the
 * removed rc.5 `tools.execute({name, arguments, callId})` shape is gone — so a
 * test Host that forgets its executor fails loud instead of silently running
 * through a second dispatch path.
 *
 * DSH 0.2.2 moved that admission to the Base layer's `tool-executor-native`
 * row (enabled) and the `ptc` preset's `tool-executor-ptc` row (disabled by
 * default). The TUI's standalone test compositions therefore install the
 * official `NativeToolExecutor` themselves, exactly one per registry.
 * @module @xmoon76/dsh-pi-tui/tool-executor-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const TOOL = 'admission_probe'

/** One test-owned registry: the real ToolsService, plus the official executor
 *  only when the case asks for it. */
async function mountRegistry(withExecutor: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  if (withExecutor) ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.tools.register(defineContentToolFixture({
    name: TOOL,
    description: 'admission probe tool',
    parameters: {},
    execute: async () => [{ type: 'text', text: 'ADMITTED' }],
  }))
  return ctx
}

const call = (ctx: Context) => executeModelToolFixture(ctx, {
  callId: ToolCallId('admission-call'),
  name: TOOL,
  arguments: {},
  signal: new AbortController().signal,
})

test('a registry without an executor refuses the batch instead of falling back to a single-call path', async () => {
  const ctx = await mountRegistry(false)
  const failure = await call(ctx).then(
    () => { throw new Error('an executors-less registry must refuse the call') },
    (error: unknown) => error,
  )
  assert.equal((failure as { code?: unknown }).code, 'TOOL_EXECUTOR_UNAVAILABLE')
  assert.match((failure as Error).message, /tool executor is unavailable/u)
})

test('installing the official native executor in that same scope admits the identical batch', async () => {
  const ctx = await mountRegistry(true)
  const result = await call(ctx)
  assert.equal(result.isError, false)
  assert.deepEqual(
    result.content.map(block => block.type === 'text' ? block.text : ''),
    ['ADMITTED'],
    'the official NativeToolExecutor settled the batch through the shared pipeline',
  )
})
