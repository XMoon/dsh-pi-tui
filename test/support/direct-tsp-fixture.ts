/**
 * The PR3-B B2 **official Direct** application fixture.
 *
 * This is the Direct counterpart of `remote-application-fixture.ts`: the rc.2
 * Host services are mounted for real (`mountAgentLoopTestDependencies` +
 * `mountAgentLoopTestHarness` compose REAL live Agents), the TUI runner boots
 * against them in the Direct branch, and the TSP pane owns the tty. Only the
 * MODEL is synthetic (a scripted streaming `LlmAdapter` registered on the Host
 * `llm` service), exactly the boundary the plan's §6.2 manifesto allows.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - real Host service composition (agent loop + harness, persistence, storage,
 *   credentials, presets, attachments, jobs, gateway, loader, userQuestions,
 *   workspace, filesystem) and REAL live Agents
 * - the REAL TUI runner (`applyRunner`) in its Direct branch, the REAL
 *   `SubmissionController`, the REAL Direct `SessionWriter`, the REAL TSP
 *   renderer over the shipped SDK `connect`
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the scripted streaming LLM adapter (the model endpoint only)
 * - the empty `fileReferences` stand-in and the `loader` readiness stub
 * - the scripted tty (the pane)
 *
 * @module @xmoon76/dsh-pi-tui/test/support/direct-tsp-fixture
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply as applyRunner, Config as TuiConfigSchema } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { installTspPane, type TspPane } from './tsp-terminal-fixture.ts'

export const DIRECT_TSP_MODEL = 'scripted-model'
export const DIRECT_TSP_PROVIDER = 'scripted'

/**
 * A scripted STREAMING LLM adapter: it yields the given deltas as real
 * `text-delta` chunks, so the Host produces genuine assistant-stream events and
 * the canonical fold/SDK pane render them incrementally.
 */
export class ScriptedStreamingAdapter extends LlmAdapter {
  private readonly deltas: readonly string[]
  constructor(deltas: readonly string[]) {
    super()
    this.deltas = deltas
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: DIRECT_TSP_MODEL, name: 'Scripted Model' }])
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const delta of this.deltas) yield { type: 'text-delta', index: 0, text: delta }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.deltas.join('') } }
  }
}

export interface DirectTspFixture {
  readonly pane: TspPane
  readonly ctx: Context
  readonly workRoot: string
  settle(): Promise<void>
}

/** Wait a fixed slice so the renderer/application frames can settle. */
export async function directSettle(millis = 800): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, millis))
}

export async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Mount the official Direct Host composition, boot the TUI runner against it
 * with the TSP renderer, and hand back the pane.
 */
export async function createDirectTspFixture(
  life: import('./temp-lifecycle.ts').TestLifecycle,
  options: {
    /** The assistant deltas the scripted model streams (default: one line). */
    readonly deltas?: readonly string[]
    readonly startup?: { readonly sessionId?: string; readonly presetId?: string }
    readonly appExit?: () => void
  } = {},
): Promise<DirectTspFixture> {
  const workRoot = life.tempDir('dsh-b2-direct-')
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const pane = installTspPane()
  const ctx = new Context()
  const fibers: Fiber[] = []
  let persistenceFiber: Fiber | undefined

  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter([DIRECT_TSP_PROVIDER], new ScriptedStreamingAdapter(options.deltas ?? ['B2', '-DIRECT', '-OK']))
  await ctx.plugin(CommandRuntime)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: DIRECT_TSP_PROVIDER, model: DIRECT_TSP_MODEL }),
    saveSelection: async () => {},
  })
  const LocalAttachmentStore = (await import('@deepseek-ai/dsh-attachment-local')).default
  await ctx.plugin(LocalAttachmentStore, { dshHome: workRoot })
  ctx.provide('fileReferences', { list: async () => [] })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Loader)
  await ctx.plugin(AgentPresetRegistry, { default: options.startup?.presetId ?? 'b2-direct-preset' })
  await ctx.get('agentPresets')!.register({
    id: options.startup?.presetId ?? 'b2-direct-preset',
    name: 'B2 direct preset',
    plugins: [],
  })
  await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalCredentials, { path: join(workRoot, '.credentials.yaml'), watch: false })
  await ctx.plugin(LocalJobRegistry, {})
  await ctx.plugin(toolJobs)
  await ctx.plugin(JobController, {})
  await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
    new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
  })

  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = join(workRoot, 'diag.log')
  ctx.provide('appExit', options.appExit ?? (() => {}))
  ctx.provide(TUI_STARTUP_SERVICE, {
    ...(options.startup ?? {}),
    shippedPresetRoot: workRoot,
  } as never)
  const runnerFiber = await ctx.plugin(pluginCtx => applyRunner(pluginCtx, TuiConfigSchema({ fullscreen: 'off' } as never)))
  fibers.push(runnerFiber)

  let settlement: Promise<void> | undefined
  const settle = (): Promise<void> => {
    settlement ??= (async () => {
      pane.releaseHandshake()
      try {
        for (const fiber of fibers.reverse()) await Promise.resolve(fiber.dispose())
        await persistenceFiber?.dispose()
        await ctx.fiber.dispose()
      } finally {
        pane.restore()
      }
    })()
    return settlement
  }
  life.defer(() => settle())

  return {
    pane,
    ctx,
    workRoot,
    settle,
  }
}
