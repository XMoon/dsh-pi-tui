/**
 * The PR3-B B2 **official Direct** application fixture.
 *
 * This is the Direct counterpart of `remote-application-fixture.ts`: the rc.2
 * Host services are mounted for real (`mountAgentLoopTestDependencies` +
 * `mountAgentLoopTestHarness` compose REAL live Agents), and the TUI runner boots
 * against them in the Direct branch. By default a scripted TSP pane owns the
 * tty; the `externalTern` mode leaves stdio with a real Tern client. Only the
 * MODEL is synthetic (a scripted streaming `LlmAdapter` registered on the Host
 * `llm` service). The default configuration boundary is described below;
 * `profileDefault` opts into the official isolated profile composition.
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
 * - `agentDefaultModel`: the fixed selection stand-in (`scripted` /
 *   `scripted-model`) so the live Agents resolve a model without a
 *   credentials-backed provider; `saveSelection` is a no-op. With
 *   `profileDefault`, this substitution is removed: the real default service,
 *   Loader profile row, ConfigEditor and SettingsForms are mounted instead
 * - the empty `fileReferences` stand-in (the workspace index)
 * - the scripted tty in the default mode; `externalTern` uses Tern-owned stdio
 *
 * DELIBERATELY ABSENT
 * - a user's profile and full shipped profile composition. The ordinary mode
 *   has no Loader profile entry/ConfigEditor-backed default persistence; its
 *   default save proves no configuration write. The optional isolated profile
 *   mode is manifested in `model-profile-fixture.ts` and qualified separately
 *   by `tern-tsp-model-profile.test.ts`.
 * - external provider endpoints and a physical Tern GUI/OS input path
 *
 * @module @xmoon76/dsh-pi-tui/test/support/direct-tsp-fixture
 */

import { mkdirSync } from 'node:fs'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
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
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
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
import type { WriteOutcome } from '../../src/runtime/session-writer-port.ts'
import { DirectSessionWriter } from '../../src/runtime/direct/session-writer-direct.ts'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { apply as applyRunner, Config as TuiConfigSchema } from '../../src/index.ts'
import { apply as applyExtensionHost, PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { apply as applyBuiltins } from '../../src/builtins.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { installTspPane, type TspPane } from './tsp-terminal-fixture.ts'
import { mountModelProfile } from './model-profile-fixture.ts'

export const DIRECT_TSP_MODEL = 'scripted-model'
/** A SECOND advertised model: selecting it is a real change, not a re-selection
 *  of the model the live Session already uses. */
export const DIRECT_TSP_MODEL_TWO = 'scripted-model-two'
export const DIRECT_TSP_PROVIDER = 'scripted'

/**
 * A scripted STREAMING LLM adapter: it yields the given deltas as real
 * `text-delta` chunks, so the Host produces genuine assistant-stream events and
 * the canonical fold/SDK pane render them incrementally.
 */
export class ScriptedStreamingAdapter extends LlmAdapter {
  private readonly deltas: readonly string[]
  private readonly hold: (() => Promise<void>) | undefined
  /** Every model request that observed its caller's ABORT (the authoritative
   *  fact that an existing cancellation path reached the live request). */
  readonly aborts: string[] = []
  /** How many model requests were issued (the skill path issues one too). */
  calls = 0
  constructor(deltas: readonly string[], hold?: () => Promise<void>) {
    super()
    this.deltas = deltas
    this.hold = hold
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([
      { provider, id: DIRECT_TSP_MODEL, name: 'Scripted Model' },
      { provider, id: DIRECT_TSP_MODEL_TWO, name: 'Scripted Model Two' },
    ])
  }

  override async *stream(options: { readonly signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    this.calls += 1
    // A HELD stream keeps the turn RUNNING until the test releases it (the
    // busy/running-window cases need a live turn, not a finished one). It must
    // still OBEY the caller's abort signal: a cancelled turn has to end.
    if (this.hold !== undefined) {
      const signal = options.signal
      if (signal !== undefined) signal.addEventListener('abort', () => this.aborts.push('aborted'), { once: true })
      await Promise.race([
        this.hold(),
        new Promise<never>((_, reject) => {
          if (signal === undefined) return
          if (signal.aborted) { reject(new Error('cancelled')); return }
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
      ])
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const delta of this.deltas) yield { type: 'text-delta', index: 0, text: delta }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.deltas.join('') } }
  }
}

export interface DirectTspFixture {
  readonly pane: TspPane
  readonly ctx: Context
  /** Disposers of the pre-boot genuine Host commands (revocation witnesses). */
  readonly hostCommandDisposers: ReadonlyArray<() => void>
  readonly workRoot: string
  /** How many live model requests observed their caller's abort. */
  cancellations(): number
  /** How many model requests the scripted adapter served. */
  modelCalls(): number
  /**
   * Attach a ONE-TO-ONE recorder to the PRODUCTION-CREATED Direct session
   * writer's `prompt` (the review's exact-once qualification). The patch
   * follows the repo's producer-fact rules: the UNBOUND prototype original is
   * saved (never `.bind`), every call goes through `original.call(instance)`
   * and the recorder returns the ORIGINAL outcome unchanged. `record` sees the
   * input bytes (the prepared message), the resolved live Agent (session id +
   * status) and the settled outcome; the caller asserts `calls === 1` itself.
   */
  /**
   * Attach a SETTLED-RECORD recorder to the PRODUCTION-created Direct session
   * writer's `prompt` (the exact-once qualification). The patch follows the
   * repo's producer-fact rules: the UNBOUND prototype original is saved
   * (never `.bind`), every call goes through `original.call(instance)` and
   * the recorder returns the ORIGINAL outcome unchanged. A record — and the
   * `calls()` count — is emitted only AFTER the write settles (never at
   * entry, so `calls() === N` always implies `records.length === N`); each
   * record carries the prepared message, the resolved live Agent (session id
   * + status) and the settled outcome. The caller asserts on a SPECIFIC
   * settled record (by index/identity), never on a bare entry count.
   */
  recordPrompts(record: (call: {
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly message: unknown
    readonly agentStatus: string
    readonly outcome: WriteOutcome
  }) => void): { readonly calls: () => number; readonly detach: () => void }
  /**
   * FAULT-INJECTION override for the production writer's `cancel` (the
   * cancel-ERROR qualification): saves the unbound original (identity
   * restored on detach) but does NOT forward — every call returns the fixed
   * outcome. This is deliberately NOT a recorder; the injected outcome is
   * the subject under test.
   */
  recordCancels(outcome: () => WriteOutcome): { readonly detach: () => void }
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
 * Wait until the TTY input is DELIVERABLE.
 *
 * The scripted pane is an `EventEmitter`: a `data` event with no listener is
 * DROPPED. The shipped Tern SDK attaches its stdin listener only inside
 * `session.handshake()` — i.e. AFTER the hello reply — so a key typed before
 * that point is LOST, not merely unhandled.
 *
 * This is therefore the AUTHORITARY input-delivery boundary, and it is
 * observable without mutating anything: the SDK's own listener registration is
 * the fact.
 *
 * It is NOT a readiness proof for the whole application: the ONE input bind
 * (`surface.bindRendererInput()`) runs later, and the renderer HOLDS the keys
 * that arrive between the attach and the bind, replaying them in arrival
 * order at the bind. So a key delivered after this wait is safe even if the
 * bind has not committed yet.
 */
export async function waitForInputDelivery(pane: TspPane, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pane.input.listenerCount('data') > 0) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('timed out waiting for the tty input to become deliverable')
}

/**
 * Mount the official Direct Host composition and TUI runner. The default uses
 * a scripted TSP pane; `externalTern: true` keeps the real Tern-owned stdio.
 */
export interface DirectTspFixtureOptions {
  /** The assistant deltas the scripted model streams (default: one line). */
  readonly deltas?: readonly string[]
  /** Keep the model stream OPEN until this resolves (a running turn). */
  readonly streamHold?: () => Promise<void>
  /** Extra TUI plugin config (e.g. `{ busyEnter: 'steer' }`) — the SAME
   *  volatile authority `applyRunner` reads, so the busy preference under
   *  test is the real configured one. */
  readonly tuiConfig?: Record<string, unknown>
  /** SKILLS served by a fixture provider on the REAL `dsh-skill` registry
   *  (the `skill-invocation` family — agent-facing input). `unresolved` models
   *  the genuine advertised-miss shape: the provider still ADVERTISES the Skill
   *  to the composer (`list()`) while it can no longer RESOLVE it once the
   *  Session is created (`get()`), exactly as a provider that lost its
   *  availability between the submit-time claim and the execution. */
  readonly skills?: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly body: string
    readonly unresolved?: boolean
  }>
  /** CLIENT-EXTENSION command contributions registered through the REAL
   *  extension service (the `client-command`/`extension` family). */
  readonly extensionCommands?: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description: string
    readonly sessionless?: boolean
    readonly handler: () => unknown
  }>
  readonly startup?: { readonly sessionId?: string; readonly presetId?: string }
  readonly modelPicker?: boolean
  readonly presetPicker?: boolean
  readonly sessionBrowser?: boolean
  /**
   * Advertise the NATIVE IMAGE capability on the scripted pane (the `image`
   * kind + the `blobs` feature): a pane that does not advertise them can
   * never carry a tool-result image, so the qualification of that path needs
   * a pane that does.
   */
  readonly nativeImages?: boolean
  /** Advertise the NATIVE CHART kind on the scripted pane (PR-D). */
  readonly nativeChart?: boolean
  /** Reuse isolated persisted session files across a clean runner remount. */
  readonly workRoot?: string
  /** Replace the historical default stand-in with the official isolated
   * profile/configuration plane for Model persistence qualification. */
  readonly profileDefault?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /** Extra agent presets registered into the REAL registry beside the
   *  fixture's own (a second real switch target). */
  readonly presets?: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly description?: string }>
  /** Materialize a REAL persisted, released, turn-boundary-BLANK Session
   *  through the official persistence seam before the runner boots, then let
   *  the runner's ordinary startup resume it. */
  readonly persistedBlankSession?: {
    readonly id: string
    readonly parentSession?: string
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
  }
  /** Materialize additional blank Sessions, including child metadata, in the same official pre-boot list. */
  readonly persistedBlankSessions?: ReadonlyArray<{
    readonly id: string
    readonly parentSession?: string
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
  }>
  /** Mount the official preset-declaring profile plane: the listed presets are
   *  declared by REAL bundle rows (healthy, with a resolution base) and the
   *  default write goes through the real ConfigEditor/Loader. */
  readonly presetProfile?: { readonly presets?: readonly { readonly id: string; readonly name?: string }[] }
  readonly appExit?: () => void
  /**
   * GENUINE Host commands registered into the REAL command catalog before the
   * runner boots (the Host-same-name winner and command-failure cases). Each
   * handler records its invocation so a test can observe the Host SINK.
   */
  readonly hostCommands?: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly definitionId?: string
    readonly handler: (invocation: { readonly rawInput: string }) => unknown
  }>
  /**
   * PR4-B2-A: mount the OFFICIAL service plugins the B2-A command closure
   * needs, so `/title`, `/yolo` and `/logout <flow-route>` reach their REAL
   * authority instead of a stand-in. Each flag mounts the same plugin the
   * shipped bundle composes; nothing is re-implemented here.
   */
  readonly officialServices?: {
    /** `dsh-session-title` (the authoritative title write + refresh). */
    readonly sessionTitle?: boolean
    /** `dsh-permission-presets` + its approval/shell/turn-outline prerequisites. */
    readonly permissionPresets?: boolean
    /** `dsh-authorization` (the provider sign-in flow targets). */
    readonly authorization?: boolean
    /**
     * B3-A3: mount the official `@deepseek-ai/dsh-subagent` runtime (the SAME
     * plugin row the shipped base layer mounts). The Direct Task read composes
     * `subagents.listDescendants`, so without this runtime the Task Center has
     * NO descendant half at all — the production bundle always mounts it, and a
     * suite that proves the real `/tasks` roster must reproduce that row.
     */
    readonly subagentRuntime?: boolean
  }
  /**
   * Negative composition: mount no credentials provider at all, so the
   * credential port's `available()` is false (the composition that must refuse
   * `/logout` truthfully instead of reporting success).
   */
  readonly withoutCredentials?: boolean
  /**
   * Mount the official `@deepseek-ai/dsh-working-directory` Session directory
   * owner (the same row the shipped base layer provides) through the testkit's
   * own switch, so a Session's EFFECTIVE directory is a real Host fact.
   */
  readonly workingDirectory?: boolean
  /**
   * The renderer the runner boots under. The default `'tsp'` installs the
   * scripted Tern pane. `'pi-tui'` installs NO pane and leaves the process tty
   * to the test, which must install its `VirtualTerminal` through
   * `runner-harness.installVirtualProcessTerminal` BEFORE calling this factory
   * (the same physical-terminal stand-in every PiTui runner suite uses).
   */
  readonly renderer?: 'tsp' | 'pi-tui'
}

export interface DirectTspExternalFixture extends Omit<DirectTspFixture, 'pane'> {}

type DirectTspPiTuiOptions = DirectTspFixtureOptions & { readonly renderer: 'pi-tui' }
type DirectTspExternalOptions = DirectTspFixtureOptions & { readonly externalTern: true }
type DirectTspScriptedOptions = DirectTspFixtureOptions & { readonly externalTern?: false; readonly renderer?: 'tsp' }

export function createDirectTspFixture(
  life: import('./temp-lifecycle.ts').TestLifecycle,
  options: DirectTspPiTuiOptions,
): Promise<DirectTspExternalFixture>
export function createDirectTspFixture(
  life: import('./temp-lifecycle.ts').TestLifecycle,
  options: DirectTspExternalOptions,
): Promise<DirectTspExternalFixture>
export function createDirectTspFixture(
  life: import('./temp-lifecycle.ts').TestLifecycle,
  options?: DirectTspScriptedOptions,
): Promise<DirectTspFixture>
export async function createDirectTspFixture(
  life: import('./temp-lifecycle.ts').TestLifecycle,
  options: (DirectTspFixtureOptions & { readonly externalTern?: boolean }) = {},
): Promise<DirectTspFixture | DirectTspExternalFixture> {
  const workRoot = options.workRoot ?? life.tempDir('dsh-b2-direct-')
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const pane = options.externalTern === true || options.renderer === 'pi-tui'
    ? undefined
    : installTspPane({
        modelPicker: options.modelPicker,
        presetPicker: options.presetPicker,
        sessionBrowser: options.sessionBrowser,
        nativeImages: options.nativeImages,
        nativeChart: options.nativeChart,
      })
  // OWNERSHIP, not success-contingency: scripted mode replaces the PROCESS tty
  // and clears five env vars; external-Tern and PiTui modes must leave the
  // tty (Tern-owned / test VirtualTerminal) and its injected environment
  // untouched. In every mode, setup failures must restore the resources this
  // fixture itself acquired.
  const cleanup: Array<() => Promise<void> | void> = []
  /** Ownership cleanups run LAST, LIFO, EXACTLY ONCE (success or reject). */
  const runSetupCleanup = async (): Promise<void> => {
    for (const step of cleanup.reverse()) await step()
    cleanup.length = 0
  }
  const ownCleanup = (step: () => Promise<void> | void): void => { cleanup.push(step) }
  if (pane !== undefined) ownCleanup(() => pane.restore())
  const previousTspRenderer = process.env.DSH_PI_TUI_RENDERER
  const previousTspLog = process.env.DSH_PI_TUI_LOG
  ownCleanup(() => {
    if (previousTspRenderer === undefined) delete process.env.DSH_PI_TUI_RENDERER
    else process.env.DSH_PI_TUI_RENDERER = previousTspRenderer
    if (previousTspLog === undefined) delete process.env.DSH_PI_TUI_LOG
    else process.env.DSH_PI_TUI_LOG = previousTspLog
  })
  let previousDshHome: string | undefined
  // Declared OUTSIDE the try so the success return below (and the recorder
  // closures) can read the mounted Context even on the last-statement path.
  let ctx!: Context
  let llmAdapter!: ScriptedStreamingAdapter
  const fibers: Fiber[] = []
  /** Disposers of the pre-boot genuine Host commands (see the interface). */
  const hostCommandDisposers: Array<() => void> = []
  let persistenceFiber: Fiber | undefined
  let settlement: Promise<void> | undefined
  const settle = (): Promise<void> => {
    settlement ??= (async () => {
      pane?.releaseHandshake()
      try {
        for (const fiber of fibers.reverse()) await Promise.resolve(fiber.dispose())
        await persistenceFiber?.dispose()
        await ctx.fiber.dispose()
      } finally {
        // The registered ownership cleanups run LAST and exactly once —
        // whether setup SUCCEEDED (this normal teardown) or REJECTED (the
        // catch below, which is the setup-ownership fix).
        await runSetupCleanup()
      }
    })()
    return settlement
  }
  try {
  ctx = new Context()
  ownCleanup(() => ctx.fiber.dispose())

  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, options.workingDirectory === true ? { workingDirectory: true } : {})
  persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
  await mountAgentLoopTestHarness(ctx)
  llmAdapter = new ScriptedStreamingAdapter(options.deltas ?? ['B2', '-DIRECT', '-OK'], options.streamHold)
  ctx.llm.registerAdapter([DIRECT_TSP_PROVIDER], llmAdapter)
  await ctx.plugin(CommandRuntime)
  for (const command of options.hostCommands ?? []) {
    hostCommandDisposers.push(ctx.commands.register({
      name: command.name,
      description: command.description,
      ...(command.definitionId === undefined ? {} : { definitionId: command.definitionId as never }),
      handler: (invocation) => command.handler({ rawInput: invocation.rawInput }) as never,
    }))
  }
  if (options.profileDefault === undefined) {
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: DIRECT_TSP_PROVIDER, model: DIRECT_TSP_MODEL }),
      saveSelection: async () => {},
    })
  }
  const LocalAttachmentStore = (await import('@deepseek-ai/dsh-attachment-local')).default
  await ctx.plugin(LocalAttachmentStore, { dshHome: workRoot })
  ctx.provide('fileReferences', { list: async () => [] })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Loader)
  if (options.profileDefault !== undefined) await mountModelProfile(ctx, workRoot, options.profileDefault)
  if (options.presetProfile !== undefined) {
    // The preset plane declares the registry AND its presets as REAL bundle rows,
    // so the settings namespace the default write mutates exists.
    const { mountPresetProfile } = await import('./preset-profile-fixture.ts')
    await mountPresetProfile(ctx, workRoot, options.presetProfile.presets ?? [])
  }
  if (options.presetProfile === undefined) {
    await ctx.plugin(AgentPresetRegistry, { default: options.startup?.presetId ?? 'b2-direct-preset' })
  }
  if (options.presetProfile === undefined) {
    await ctx.get('agentPresets')!.register({
      id: options.startup?.presetId ?? 'b2-direct-preset',
      name: 'B2 direct preset',
      plugins: [],
    })
    for (const preset of options.presets ?? []) {
      await ctx.get('agentPresets')!.register({
        id: preset.id,
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
        plugins: [],
      })
    }
  }
  await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  // The testkit's workingDirectory switch mounts FsLocal itself (when the
  // composition has no filesystem yet): never mount a second `fs` service.
  if (ctx.get('fs') === undefined) await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  if (options.withoutCredentials !== true) {
    await ctx.plugin(LocalCredentials, { path: join(workRoot, '.credentials.yaml'), watch: false })
  }
  await ctx.plugin(LocalJobRegistry, {})
  await ctx.plugin(toolJobs)
  await ctx.plugin(JobController, {})
  await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
    new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
  })

  process.env.DSH_PI_TUI_RENDERER = options.renderer === 'pi-tui' ? 'pi-tui' : 'tsp'
  process.env.DSH_PI_TUI_LOG = join(workRoot, 'diag.log')
  // Isolate the DSH home for this fixture: the input-history and session
  // stores must land under the work root, never in the developer's real
  // `~/.dsh` (and so a "no history row was written" assertion is meaningful).
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = workRoot
  ownCleanup(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })
  ctx.provide('appExit', options.appExit ?? (() => {}))
  ctx.provide(TUI_STARTUP_SERVICE, {
    ...(options.startup ?? {}),
    shippedPresetRoot: workRoot,
  } as never)
  // The Client-EXTENSION command family is REAL too: mount the TUI's own
  // extension host (and the first-party chrome row) before the runner, so a
  // registered contribution reaches the runner through the same service the
  // production bundle provides.
  if (options.skills !== undefined && options.skills.length > 0) {
    await ctx.plugin(SkillRegistry, {})
    const registry = ctx.get('skills') as unknown as {
      registerProvider(provider: unknown): unknown
    }
    const skills = options.skills
    // The registry takes a FACTORY `(control) => provider`.
    registry.registerProvider((_control: unknown) => ({
      name: 'b2-fixture-provider',
      list: async () => skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        rank: 10,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'b2-fixture-provider',
        locator: { name: skill.name },
      })),
      get: async (candidate: { locator: { name: string } }) => {
        const skill = skills.find(entry => entry.name === candidate.locator.name)
        return skill === undefined || skill.unresolved === true ? undefined : {
          name: skill.name,
          description: skill.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: 'b2-fixture-provider',
          locator: candidate.locator,
          content: skill.body,
        }
      },
    }))
  }
  const extensionFiber = await ctx.plugin(applyExtensionHost as never, {} as never)
  const builtinsFiber = await ctx.plugin(applyBuiltins as never, {} as never)
  const contributionFiber = await ctx.plugin(((pluginCtx: Context) => {
    const service = pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as
      { registerCommand(contribution: never): unknown } | undefined
    for (const command of options.extensionCommands ?? []) {
      service?.registerCommand({
        id: command.id,
        name: command.name,
        description: command.description,
        ...(command.sessionless === undefined ? {} : { sessionless: command.sessionless }),
        handler: () => command.handler(),
      } as never)
    }
  }) as never, {} as never)
  const persistedBlankSessions = [
    ...(options.persistedBlankSession === undefined ? [] : [options.persistedBlankSession]),
    ...(options.persistedBlankSessions ?? []),
  ]
  if (persistedBlankSessions.length > 0) {
    // The OFFICIAL persistence seam: `create` takes write ownership, `flush`
    // materializes each artifact, and `close` releases each handle WITHOUT
    // deleting the stored log — so the runner's ordinary startup/list paths
    // see real persisted Sessions that hold no user turn.
    const persistence = ctx.get('sessionPersistence') as unknown as {
      create(header: unknown, options?: unknown): Promise<{
        flush(options?: unknown): Promise<void>
        close(): Promise<void>
      }>
    }
    for (const session of persistedBlankSessions) {
      const handle = await persistence.create({
        id: session.id,
        cwd: workRoot,
        createdAt: Date.now(),
        version: SESSION_FORMAT_VERSION,
        isSeeded: false,
        ...(session.parentSession === undefined ? {} : { parentSession: session.parentSession }),
        ...(session.origin === undefined ? {} : { origin: session.origin }),
        ...(session.delegationDepth === undefined ? {} : { delegationDepth: session.delegationDepth }),
      })
      await handle.flush()
      await handle.close()
    }
  }
  const officialServices = options.officialServices ?? {}
  if (officialServices.sessionTitle === true) {
    // The authoritative session-title service the Direct SessionWriter's
    // rename/refresh paths require (absent = "renaming is unavailable"). The
    // config is the shipped bundle's own (bundle/base cordis.patch.yml).
    const { default: SessionTitleService } = await import('@deepseek-ai/dsh-session-title')
    await ctx.plugin(SessionTitleService as never, {
      fallbackMaxWords: 5,
      fallbackMaxBytes: 40,
      maxTitleBytes: 80,
    } as never)
  }
  if (officialServices.permissionPresets === true) {
    // The official preset table + the `/permission` command, over the same
    // approval/shell/turn-outline prerequisites `runner-remote-permission` uses.
    ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
    const approval = await import('@deepseek-ai/dsh-user-approval')
    await ctx.plugin((approval as unknown as { default: unknown }).default as never, undefined as never)
    const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
    await ctx.plugin(turnOutline as never, undefined as never)
    const { PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets')
    await ctx.plugin(PermissionPresetService as never, undefined as never)
  }
  if (officialServices.authorization === true) {
    // The provider sign-in flow targets `/logout <flow-route>` resolves
    // through (`flowForRoute`), and whose keyless login stores a RECORD.
    const { default: AuthorizationService } = await import('@deepseek-ai/dsh-authorization')
    await ctx.plugin(AuthorizationService as never, undefined as never)
  }
  if (officialServices.subagentRuntime === true) {
    // B3-A3: the official subagent runtime row the shipped base layer mounts. It
    // must precede the runner, because the composition root reads `ctx.get(
    // 'subagents')` when it builds the Direct Task source. Its `inject` names
    // `workingDirectory`, so a composition opting in must mount that row too.
    const { default: SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
    await ctx.plugin(SubagentRuntime as never, { maxDepth: 3 } as never)
  }
  const runnerFiber = await ctx.plugin(pluginCtx => applyRunner(
    pluginCtx,
    TuiConfigSchema({ fullscreen: 'off', ...options.tuiConfig } as never),
  ))
  fibers.push(runnerFiber, contributionFiber, builtinsFiber, extensionFiber)

  life.defer(() => settle())
  } catch (error) {
    // PARTIAL SETUP: the factory rejects, so the caller's `finally` can never
    // reach `settle()`. Run the registered ownership cleanups here — the pane
    // tty restoration, the env vars and the partially mounted Context — so a
    // rejecting setup leaves the process exactly as it found it.
    await runSetupCleanup()
    throw error
  }

  /**
   * The production-created writer observation. `createDirectRuntimeBackend`
   * constructs the writer INSIDE the mounted runner as a `DirectSessionWriter`
   * over this exact module class, so patching the PROTOTYPE observes every
   * production write with the true receiver identity (the same
   * `TuiApp.prototype.start` shape every Direct runner suite uses — never a
   * re-bound copy). The recorder is one-to-one: single call →
   * `original.call(this, ...)` → `record(v)` → return `v`; `detach()`
   * restores the SAME function identity.
   */
  const recordPrompts = (record: (call: {
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly message: unknown
    readonly agentStatus: string
    readonly outcome: WriteOutcome
  }) => void): { readonly calls: () => number; readonly detach: () => void } => {
    const prototype = DirectSessionWriter.prototype as unknown as {
      prompt(this: DirectSessionWriter, sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<WriteOutcome>
    }
    const originalPrompt = prototype.prompt
    const settled: unknown[] = []
    prototype.prompt = async function (this: DirectSessionWriter, sessionId, message, mode) {
      const outcome = await originalPrompt.call(this, sessionId, message, mode)
      // The record — and the count — exist only AFTER the write settles: a
      // caller waiting on `calls()` can never observe an entry whose settled
      // record is still missing (the round-4 fake-green: the busy guard once
      // matched the warm-up's committed record while the real second write
      // was still pending and later rejected).
      settled.push(undefined)
      const agent = (this as unknown as { agentFor(id: string): { session: { id: string }; status: string } | undefined }).agentFor(sessionId)
      record({ sessionId, mode, message, agentStatus: agent?.status ?? 'unresolved', outcome })
      return outcome
    }
    return {
      calls: () => settled.length,
      detach: () => { prototype.prompt = originalPrompt },
    }
  }

  /** The cancel-ERROR fault-injection seam: force the production outcome. */
  const recordCancels = (outcome: () => WriteOutcome): { readonly detach: () => void } => {
    const prototype = DirectSessionWriter.prototype as unknown as {
      cancel(this: DirectSessionWriter, sessionId: string): Promise<WriteOutcome>
    }
    const originalCancel = prototype.cancel
    prototype.cancel = async function (this: DirectSessionWriter) {
      return outcome()
    }
    return { detach: () => { prototype.cancel = originalCancel } }
  }

  const fixture = {
    ctx,
    workRoot,
    hostCommandDisposers,
    cancellations: () => llmAdapter.aborts.length,
    modelCalls: () => llmAdapter.calls,
    recordPrompts,
    recordCancels,
    settle,
  }
  return pane === undefined ? fixture : { ...fixture, pane }
}
