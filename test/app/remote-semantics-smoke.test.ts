/**
 * M3-3A same-Host integration smoke: the closed semantic bundle over a REAL
 * Host Context → the M3-1 in-process carrier → a real official Client
 * Context → the M3-3A adapters (`createRemoteM3ASemantics`). No fake Remote
 * unit wiring and no production TUI Remote backend; Host-side abstract
 * capability seams (the llm adapter, the skills registry, the file-reference
 * provider) use the same fixture stand-ins as the M3-1 L5 suite.
 *
 * Covered probes (plan §16): P1 Session list/read · P2 contextPressure
 * projection · P3 modelCatalog grouped directory · P4 llm/discoverModels ·
 * P5 skills/list · P6 Session-scoped `@` discovery (the private
 * piTuiFileReferences augmentation, TS8-HF1) · P7
 * PresentationReader.loadThrough · P8 turnOutline projection · P9 retained
 * child Session projection read · P10 reconnect/generation replacement ·
 * P11 rc.2 Question wire surfaces (the live forwarded request, the
 * `attachWait` claim, the non-cancelling timeout, the late-answer mapping).
 *
 * @module @xmoon76/dsh-pi-tui/remote-semantics-smoke.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SESSION_LOG_FILENAME, sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { unzipEntries } from '../support/zip-entries.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { TuiApp, type OwnedRunner } from '../../src/tui-app.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import {
  createUserMessage,
  LlmAdapter,
  MessageId,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { loadExperimentalRemoteRuntime } from '../../src/runtime/backend-loader.ts'
import type { ExperimentalRemoteRuntime } from '../../src/app/remote/runtime.ts'
import { createRemoteM3ASemantics, type RemoteM3ASemantics } from '../../src/app/remote/m3a-semantics.ts'
import { createRemoteBackendRuntime } from '../../src/app/remote/runtime.ts'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import { acquireMainSurfaceReference, type MainSurfaceReference } from '../../src/runtime/remote/session-reference.ts'
import { contextPressureOccupancy } from '../../src/runtime/session-reader-port.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectTuiSettings, type SettingsFormsLike, type TuiConfigRefs } from '../../src/runtime/direct/tui-settings-direct.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const PRESET = 'm3a-smoke-preset'
const MAIN = 'm3a-main'
const CHILD = 'm3a-child'
const BARE = 'm3a-bare'
/**
 * The bound on a settlement wait.
 *
 * It is a DEADLINE, not the expected duration: the settlement is observed,
 * not waited for, so the bound only says how long a settlement that never
 * arrives is tolerated before the case fails with the word it observed. The
 * write chain (the app-owned write channel, the config port, the Host write,
 * the authoritative re-read and the classification) is a handful of awaited
 * steps; a loaded runner stretches it, it never stalls it.
 */
const SETTLEMENT_TIMEOUT_MS = 30_000

/** The L5 stub llm route shape (enough adapter for real composition). */
class StubLlmAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke-model', name: 'Smoke Model' }])
  }

  override async *stream(): AsyncGenerator<never> {}
}

/** The scripted model for the durable-continued probe: its FIRST step asks the
 *  real timed `ask_user_question` tool with a one-second foreground wait; every
 *  later step (the pending continuation and the late-answer turn) replies with
 *  ordinary text. */
class TimedQuestionLlmAdapter extends LlmAdapter {
  calls = 0

  override resolveModel(_provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider: 'smoke', id: model, name: model })
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke-model', name: 'Smoke Model' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.calls += 1
    if (this.calls === 1) {
      const args = JSON.stringify({
        questions: [{
          id: 'q1',
          question: 'Continue?',
          options: [{ label: 'yes' }, { label: 'no' }],
        }],
        timeout: 1,
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0,
        id: ToolCallId('m3b-timed-question-call'), name: 'ask_user_question', argumentsDelta: args,
      }
      yield {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: ToolCallId('m3b-timed-question-call'),
          name: 'ask_user_question', arguments: args,
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'continuing independently' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'continuing independently' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface HostFixture {
  ctx: Context
  workRoot: string
  anchorDir: string
  /** The production AgentLoop test driver (composes real live Agents). */
  harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
  dispose(): Promise<void>
}

async function createHostFixture(
  life: TestLifecycle,
  options: {
    /** Mount the production config plane: a real profile directory plus the
     *  official `ConfigEditor` (service `configEditor`) and `SettingsForms`
     *  (service `settings`). OPT-IN so the fail-closed "no settings service"
     *  deployment contract stays testable. */
    readonly configPlane?: boolean
    /** Expose the mounted `tui-app` row plugin's RESOLVED Config (its live
     *  volatile references) on `globalThis.__m3aTuiRowConfig`, so a suite can build
     *  the REAL production `DirectTuiSettings` over the real Host settings plane. */
    readonly captureTuiRowConfig?: boolean
    /** Replace the inert stub model only for a suite that needs a real scripted
     *  turn (the durable timed-question probe). */
    readonly llmAdapter?: LlmAdapter
  } = {},
): Promise<HostFixture> {
  const workRoot = life.tempDir('dsh-m3a-')
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const ctx = new Context()
  let persistenceFiber: Fiber | undefined
  let harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>> | undefined
  try {
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx)
    // The REAL token-meter Host rows: the official contextPressure /
    // contextBreakdown / tokenUsage projection units the smoke proves on the
    // wire — plus the official todos projection unit.
    await ctx.plugin(TokenMeter)
    await ctx.plugin(toolTodo, { allowParallelInProgress: false })
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
    harness = await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['smoke'], options.llmAdapter ?? new StubLlmAdapter())
    // P4: the official discovery registered for the TUI wizard's family.
    ctx.llm.registerModelDiscovery('llm-pi-ai', async () => [{ id: 'discovered-a', name: 'Discovered A' }])
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'smoke', model: 'smoke-model' }),
      saveSelection: async () => {},
    })
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 100 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      admitPromptContent: async (content: unknown) => content,
    } as never)
    ctx.provide('webServer', { registerUpgrade: () => () => {} })
    // P5: the Host-side abstract skill registry seam (the L5 stand-in style).
    ctx.provide('skills', {
      list: async () => [{
        name: 'smoke-skill',
        description: 'a same-Host smoke skill',
        invocation: { userInvocable: true, modelInvocable: false },
      }],
    } as never)
    // P6: the Host-side abstract file-reference provider seam.
    ctx.provide('fileReferences', {
      list: async () => [{ path: 'anchor/notes.md', kind: 'file' as const }],
    } as never)
    // The rc.2 user-questions service is a HOST PREREQUISITE of the M3 Remote
    // composition (the production Host gets it from `@deepseek-ai/dsh-base`),
    // so the fixture mounts the official service itself — the composition must
    // REUSE it, never mount a second one.
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(Loader)
    // The production config plane the base bundle mounts while a
    // `profileContext` exists: `ConfigEditor` (service `configEditor`, injecting
    // loader + profileContext) and the official `SettingsForms` (service
    // `settings`, injecting configEditor + profileContext). The M3 Remote
    // composition must NOT mount these; they belong to the profile lifecycle.
    if (options.configPlane === true) {
      // A minimal but REAL dsh profile directory: the official settings service
      // reads the profile manifest + its patch file, so the plane needs both.
      // A real dsh layout: the PROFILE directory holds the manifest + patch,
      // while `home` is its parent (a home-layer patch file must not shadow the
      // profile one, or the official editor refuses the write as overridden).
      const profileDir = join(workRoot, 'profile')
      mkdirSync(profileDir, { recursive: true })
      const profilePatchPath = join(profileDir, 'cordis.patch.yml')
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-m3a-profile',
        private: true,
        dsh: { profile: { bundles: ['m3b-tui-bundle'], patch: 'cordis.patch.yml' } },
      }, null, 2))
      // The row's id IS the settings namespace the Remote config port writes:
      // `tui-app`. The row plugin is a stub — mounting the real TUI here would register
      // this repository's own commands and surface inside the fixture — but its
      // Config IS the product schema (`src/app/config/schema.ts`), so the section's
      // fields, defaults and volatile markers are the shipped ones and the
      // Remote config path is exercised against the real shape.
      const rowModulePath = join(workRoot, 'm3b-tui-settings-row.mjs')
      writeFileSync(rowModulePath, [
        `import { Config } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/app/config/schema.ts')).href)}`,
        "export const name = 'm3b-tui-settings-row'",
        'export { Config }',
        // The loader resolves `Config` and hands the RESOLVED object (with the live
        // volatile references) to `apply`; the Direct settings proof asks for it so it
        // can drive the production adapter against the real Host plane.
        options.captureTuiRowConfig === true
          ? 'export function apply(_ctx, config) { globalThis.__m3aTuiRowConfig = config }'
          : 'export function apply() {}',
        '',
      ].join('\n'))
      // The production LAYOUT: a bundle declares the row and its base config,
      // while the profile patch carries only the user's own change. Both halves
      // matter — the official editor compares the effective (layer + document)
      // configuration against the live entry, so a row that exists only in the
      // profile patch can never be written.
      const bundleDir = join(workRoot, 'bundle')
      mkdirSync(bundleDir, { recursive: true })
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
        name: 'm3b-tui-bundle',
        version: '0.0.0',
        private: true,
        dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
      }, null, 2))
      // Bundle patches use the include's `insert` dialect: only an insertion
      // patch can materialize a row, a flat row list is inert.
      writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: tui-app',
        `      name: ${JSON.stringify(rowModulePath)}`,
        '      config:',
        "        sessionId: ''",
        '',
      ].join('\n'))
      // A profile resolves its bundles from its OWN node_modules, exactly what
      // `dsh plugin --profile <p> install` creates.
      const linkedScope = join(profileDir, 'node_modules')
      mkdirSync(linkedScope, { recursive: true })
      symlinkSync(bundleDir, join(linkedScope, 'm3b-tui-bundle'), 'dir')
      writeFileSync(profilePatchPath, '[]\n')

      ctx.provide('profileContext', {
        // The COMPLETE production contract: the official write flow reads more
        // than `dir`/`patchPath` (it also resolves the home-layer patch file and
        // the launch overlays), so a partial context fails deep inside the write.
        name: 'm3a-smoke',
        dir: profileDir,
        patchPath: profilePatchPath,
        // The REPOSITORY root: the Loader resolves the row by package name from
        // its node_modules, exactly like a real profile install anchor.
        installAnchor: process.cwd(),
        cwd: workRoot,
        home: workRoot,
        startedBundles: [],
        overlays: [],
        telemetryDisabledEnv: undefined,
      } as never)
      await ctx.plugin(ConfigEditor)
      await ctx.plugin(SettingsForms)
      // SECTIONS come from Loader-managed profile rows whose plugin declares a
      // Config schema (a directly mounted plugin contributes nothing), and a
      // section's ns is the row id. App boot's own root `Include` entry plus its
      // apply path is exactly that shape, so the fixture uses them: the row id
      // is the namespace the Remote config port writes.
      const loadedProfile = loadProfileDirectory('dsh', profileDir, process.cwd(), { userLayer: false })
      // RAW patch options (each may be an `insert` group): the include's own
      // patch algorithm needs the insertion form to materialize a new row, so
      // the composed/flattened view is NOT what a tree is built from.
      const profilePatches = [
        ...loadedProfile.layers.flatMap(layer => layer.patches),
        ...loadedProfile.patches,
      ]
      await mountRootInclude(
        ctx,
        // App boot's root include reads the profile PATCH file and applies the
        // composed layer rows to it — `patches` is how a bundle row reaches the
        // tree, and only its `insert` dialect can materialize a new row.
        profilePatchPath,
        profilePatches,
        // The profile's install anchor as a URL: the include subtree resolves
        // row plugin names from here (a bare path does not resolve).
        pathToFileURL(join(process.cwd(), 'package.json')).href,
        'dsh',
      )
      // Wait for the root include's rows to settle before the settings service
      // reads their schemas.
      await (ctx.get('loader' as never) as unknown as { await: () => Promise<void> }).await()
    }
    await ctx.plugin(AgentPresetRegistry, { default: PRESET })
    await ctx.get('agentPresets')!.register({ id: PRESET, name: 'M3-3A smoke preset', plugins: [] })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    await ctx.plugin(LocalFileSystem)
    // 0.2.1-rc.2's SessionController nests the official skill catalog, whose
    // `SessionSkillCatalog.inject` requires the real `workingDirectory` owner;
    // without it the `skills/list` Remote never registers. The official base
    // layer mounts this same row once.
    await ctx.plugin(WorkingDirectory)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(pluginCtx => {
      Reflect.construct(CredentialProvider, [pluginCtx])
    })
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(toolJobs)
    await ctx.plugin(JobController, {})
    // 0.2.1-rc.2 requires the Gateway's access decider: `TypertGatewayService.inject`
    // is ['typert', 'remoteAccess'], so the official RemoteAccess owner mounts
    // first (the base layer's order) — never a fake `remoteAccess` provide.
    await ctx.plugin(RemoteAccessService)
    await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
      new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
    })
    // One real cold child Session (the main session is composed LIVE by the
    // test body through the AgentLoop harness — the file-reference Host face
    // resolves a live Agent from the session identity).
  } catch (error) {
    await persistenceFiber?.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
  const dispose = async (): Promise<void> => {
    await persistenceFiber?.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
  life.defer(dispose)
  return { ctx, workRoot, anchorDir, harness: harness!, dispose }
}

/** Seed one REAL completed turn with a provider usage sample; the official
 * projection units fold it exactly like a live model turn would. */
function seedTurn(
  host: HostFixture,
  sessionId: string,
  input: {
    turn: number
    prompt: string
    response: string
    usage: { inputTokens: number; outputTokens: number }
    /** Optional whole-list snapshot appended INSIDE the open turn (the
     * official invariant rejects a todo/write outside one). */
    todos?: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
  },
): void {
  const session = host.ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new Error(`seedTurn: no Host session ${sessionId}`)
  session.append('turn/start', { turn: input.turn })
  // The official step lifecycle: an `assistant/message` is only legal inside an
  // OPEN turn+step, and the durable reader enforces it (`SessionFormatError`
  // otherwise). Without these two events every seeded log was corrupt on the
  // persistence READ path — the path `/api/session.export` uses — so the archive
  // route could never serve a seeded Session.
  session.append('step/start', { turn: input.turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: input.prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: input.turn,
    step: 1,
    message: {
      id: MessageId(`${sessionId}-assistant-${input.turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: input.response }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke-model' },
    },
    stream: [],
    usage: { ...input.usage },
  }, { surfaceOp: 'append' })
  if (input.todos !== undefined) {
    session.append('todo/write', { todos: [...input.todos] })
  }
  session.append('step/end', { turn: input.turn, step: 1 })
  session.append('turn/end', { turn: input.turn, reason: { kind: 'completed' } })
}

function stubSerializer(): import('../../src/runtime/remote/session-writer-remote.ts').RemotePromptSerializer {
  return {
    preflight: () => ({ kind: 'unsupported', reason: 'smoke serializer never dispatches' }),
    serialize: async () => ({ kind: 'unsupported', reason: 'smoke serializer never dispatches' }),
  }
}

interface Composed {
  runtime: ExperimentalRemoteRuntime
  semantics: RemoteM3ASemantics
}

/** The real Host + generated Client runtime, with no M3 semantic bundle yet. */
/**
 * Mount the REAL `/settings` workspace whose settings port is the PRODUCTION
 * `ConfigPort` of the deployment under test — the assembled Remote adapter for
 * the wire case, the Direct port over the real Host settings plane for the local
 * case. Mirrors the L6 visual harness shape (a sessionless surface and a Proxy
 * runner for the capabilities this command factory never touches); the settings
 * port is never a hand-rolled document object.
 */
async function mountSettingsWorkspace(
  cwd: string,
  config: {
    readonly configReadiness: () => 'ready' | 'stale' | 'unavailable'
    readonly tuiSettings: unknown
    readonly footerCustomItems: unknown
    readonly permissions: unknown
    readonly subagentModelSelection: unknown
    /** S2/PR-B: the Web provider sub-domain (the Remote adapter's static
     *  unavailable/refuse implementation) and the credential surface the Web
     *  section reads. */
    readonly web: unknown
    readonly credentials: unknown
  },
  backendKind: 'direct' | 'remote',
): Promise<{
  open(): Promise<void>
  key(data: string): Promise<void>
  /**
   * Walk the category rail to one category. The workspace opens on its About
   * home (Phase 3C / C2-A), so a case that drives the legacy configuration
   * levels walks the rail first.
   */
  selectCategory(category: string): Promise<void>
  /**
   * Wait for the workspace's SETTLED status word.
   *
   * The write chain is asynchronous by nature (the app-owned write channel →
   * the config port → the Host write → the authoritative re-read → the
   * classification), so the settlement arrives on an unknown turn. A fixed
   * window would read the IN-FLIGHT frame (`Saving…`) whenever the machine
   * is loaded, and the assertion would then judge a frame the product never
   * promised. This waits for the REAL settlement and reports the word it
   * actually observed when the deadline passes.
   */
  settleUntil(pattern: RegExp, label: string): Promise<void>
  /** The mounted surface, for asserting the LIVE runtime fact a commit really changed. */
  app: TuiApp
  view(): string
  dispose(): void
}> {
  const vt = new VirtualTerminal(120, 40)
  const owned: OwnedRunner = (_label, task, options) => {
    void Promise.resolve()
      .then(() => task())
      .then(result => options.onResult?.(result), error => options.onError?.(error))
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, runOwned: owned }, {})
  app.start()
  const defs: { name: string; handler?: (invocation: { rawInput: string }) => unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: (invocation: { rawInput: string }) => unknown }) => {
      defs.push(definition)
      return () => {}
    },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd,
    sessionCwd: () => cwd,
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    // C3 About seams: this fixture composes no StatusRuntime, so the
    // sessionless capture is the only reachable state (no scoped read can
    // start). The subscription STILL must return a real disposer: opening
    // `/settings` builds the About controller, its close calls `dispose()`,
    // and a non-function return would abort the TuiApp teardown and leak the
    // process slot into every later test.
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => app.displayPreset() === 'focus',
    refreshStatus: () => {},
    // THE point of this fixture: the real Remote settings port.
    tuiSettings: config.tuiSettings,
    config: settingsDirectPageConfig({
      configReadiness: () => config.configReadiness(),
      footerCustomItems: config.footerCustomItems,
      permissions: config.permissions,
      subagentModelSelection: config.subagentModelSelection,
      web: config.web,
      credentials: config.credentials,
    }),
    extensions: undefined,
    createPluginManagerPage: () => undefined,
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  /**
   * Wait for the workspace's SETTLED status word.
   *
   * The write chain is asynchronous by nature (the app-owned write channel →
   * the config port → the Host write → the authoritative re-read → the
   * classification), so the settlement arrives on an unknown turn. A fixed
   * window would read the IN-FLIGHT frame (`Saving…`) whenever the machine
   * is loaded, and the assertion would then judge a frame the product never
   * promised. This waits for the REAL settlement and reports the word it
   * actually observed when the deadline passes.
   */
  const settleUntil = async (pattern: RegExp, label: string): Promise<void> => {
    const deadline = Date.now() + SETTLEMENT_TIMEOUT_MS
    for (;;) {
      // Drain the terminal's own write queue, then read the frame: a frame
      // that is still being painted must not be read as the settled one.
      await vt.flush()
      const frame = view()
      if (pattern.test(frame)) return
      if (Date.now() >= deadline) {
        // The OBSERVED word, not a guess: the reader must be able to tell
        // "the write never settled" from "the write settled as something
        // else".
        const observed = (frame.replace(/\s+/gu, ' ').match(/Status\s+([A-Za-z…]+)/) ?? [])[1] ?? 'no status word'
        assert.fail(`${label} never settled: the workspace still shows "${observed}"\n${frame}`)
      }
      // Yield the event loop so the write chain can make progress.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
  return {
    async open(): Promise<void> {
      const definition = defs.find(candidate => candidate.name === 'settings')
      assert.ok(definition?.handler !== undefined, '/settings must be registered')
      definition.handler({ rawInput: '' })
      await vt.waitForRender()
    },
    async key(data: string): Promise<void> {
      vt.sendInput(data)
      await vt.waitForRender()
    },
    async selectCategory(category: string): Promise<void> {
      await selectSettingsCategory(vt, category)
    },
    settleUntil,
    app,
    view,
    dispose: () => { if (!app.isDisposed()) app.dispose() },
  }
}

async function composeRuntime(host: HostFixture): Promise<Composed['runtime']> {
  return await (await loadExperimentalRemoteRuntime()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
}

async function compose(host: HostFixture): Promise<Composed> {
  const runtime = await composeRuntime(host)
  return { runtime, semantics: createRemoteM3ASemantics(runtime.client, { promptSerializer: stubSerializer() }) }
}

test('the M3-3A semantic bundle serves over one real Host wire', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  const { runtime, semantics } = await compose(host)
  try {
    // The main Session is a REAL live Agent (the file-reference Host face
    // resolves the live Agent from the exact session identity); the child is
    // its own live Agent with COMPETING projection facts; the bare session
    // keeps the absent-value cases honest.
    await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
    await host.harness.create(SessionId(CHILD), undefined, { cwd: join(host.anchorDir, 'child') })
    await host.harness.create(SessionId(BARE), undefined, { cwd: join(host.anchorDir, 'bare') })
    // Seed REAL Host-side projection facts BEFORE any retention, so the
    // Client's initial tail page carries them: distinct usage per session
    // (parent/child values must never mix) and one completed turn each.
    seedTurn(host, MAIN, { turn: 1, prompt: 'plan the launch', response: 'launch plan ready', usage: { inputTokens: 1000, outputTokens: 42 } })
    seedTurn(host, CHILD, {
      turn: 1,
      prompt: 'child task',
      response: 'child done',
      usage: { inputTokens: 200, outputTokens: 7 },
      todos: [{ content: 'child todo', status: 'in_progress' }],
    })

    // P1 — Session list/read through the official Client list face.
    const rows = await semantics.sessionReader.list(undefined)
    assert.ok(rows !== undefined, 'the list capability is available')
    const ids = rows!.map(row => row.id)
    assert.ok(ids.includes(MAIN), `the seeded main session is listed: ${JSON.stringify(ids)}`)
    assert.ok(rows!.find(row => row.id === MAIN)!.cwd === host.anchorDir,
      `the official cwd fact rides the row: ${JSON.stringify(rows!.find(row => row.id === MAIN))}`)

    // Retain the sessions the way the TUI's surfaces would, and let the
    // initial tail pages (with their projection blocks) settle.
    const mainRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(MAIN))
    const childRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(CHILD))
    const bareRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(BARE))
    await waitFor('the MAIN window to open', () =>
      runtime.client.sessions.binding(SessionId(MAIN))?.session.getSnapshot().openState === 'open')
    await waitFor('the CHILD window to open', () =>
      runtime.client.sessions.binding(SessionId(CHILD))?.session.getSnapshot().openState === 'open')

    // The HOST-side projection snapshot is the truth the wire must carry.
    const hostProjections = host.ctx.get('sessionProjections') as {
      snapshot(session: unknown, keys?: readonly string[]): { readonly values?: Record<string, unknown> } | undefined
    }
    const hostMainValues = hostProjections.snapshot(host.ctx.sessions.get(SessionId(MAIN)), [
      'contextPressure', 'turnOutline', 'tokenUsage',
    ])!.values!
    const hostChildValues = hostProjections.snapshot(host.ctx.sessions.get(SessionId(CHILD)), [
      'contextPressure', 'tokenUsage', 'todos',
    ])!.values!

    // P2 — the POPULATED contextPressure projection crosses the real wire:
    // the Remote occupancy equals the Host fold's own numerator, and it is a
    // measured number (the seeded 1000-prompt-token usage), never invented.
    const hostMainPressure = contextPressureOccupancy(hostMainValues.contextPressure)
    assert.ok(typeof hostMainPressure === 'number', 'the Host fold reports usage pressure')
    assert.equal(semantics.sessionReader.measureContext(MAIN), hostMainPressure,
      'the wire carries the exact official numerator the Host fold produced')
    // The BARE session (no usage) keeps the truthful unmeasured value.
    assert.equal(semantics.sessionReader.measureContext(BARE), undefined,
      'no provider usage — the official pressure projection reads unmeasured')

    // P3 — the modelCatalog grouped directory over the stub route.
    const directory = await semantics.catalog.models.loadDirectory()
    assert.ok(directory.groups.some(group => group.id === 'smoke' && group.models.some(model => model.id === 'smoke-model')),
      `the grouped selectable directory flows through: ${JSON.stringify(directory.groups.map(group => group.id))}`)

    // P4 — llm/discoverModels through the registered official discovery.
    const discovered = await semantics.catalog.models.discoverModels({ baseURL: 'https://example.test' })
    assert.deepEqual(discovered, [{ id: 'discovered-a', name: 'Discovered A' }])

    // P5 — skills/list for the retained session.
    const skills = await semantics.catalog.skills.listHumanSkills(MAIN)
    assert.deepEqual(skills?.skills.map(skill => skill.name), ['smoke-skill'],
      'the Session-addressed human catalog flows through the real wire')

    // P6 — Session-scoped `@` discovery through the private piTuiFileReferences
    // augmentation (TS8-HF1): the bare query delegates the official Host
    // provider, the exact session id drives the Host lookup, and the child
    // scope carries the CHILD identity.
    const files = await semantics.hostFile.listReferences({ kind: 'session', sessionId: MAIN }, 'notes')
    assert.deepEqual(files, { kind: 'ok', items: [{ path: 'anchor/notes.md', kind: 'file' }] })
    const childFiles = await semantics.hostFile.listReferences({ kind: 'session', sessionId: CHILD }, 'notes')
    assert.equal(childFiles.kind, 'ok')
    const unavailable = await semantics.hostFile.listReferences({ kind: 'workspace', cwd: host.anchorDir }, 'x')
    assert.equal(unavailable.kind, 'unavailable', 'the workspace scope stays fail-closed on the wire')

    // P7 — the official loadThrough jump on the retained open session.
    const jumped = await semantics.presentationReader.loadThrough(MAIN, 1)
    assert.ok(jumped !== undefined, 'the jump settles for the retained session')
    assert.equal(jumped!.coverage, 'bounded')

    // P8 — the POPULATED turnOutline projection crosses the real wire and
    // equals the Host fold's own outline (the seeded turn, its prompt
    // preview and its `turn/start` seq — the loadThrough target).
    const hostOutline = semantics.sessionReader.turnOutline(MAIN)
    assert.ok(hostOutline !== undefined && hostOutline.length === 1,
      'the seeded turn is outlined')
    if (hostOutline !== undefined && hostOutline.length === 1) {
      assert.equal(hostOutline[0]!.turn, 1)
      assert.ok(hostOutline[0]!.prompt.includes('plan the launch'),
        `the prompt preview flows through: ${JSON.stringify(hostOutline[0])}`)
    }
    assert.deepEqual(semantics.sessionReader.turnOutline(BARE), [],
      'the bare session keeps the official empty outline')

    // P9 — the retained CHILD Session reads its OWN populated projection
    // facts (its distinct usage and todos), never the parent's competing
    // values; the bare session stays fact-free beyond its cwd.
    const mainStatus = semantics.sessionReader.sessionStatus(MAIN)!
    const childStatus = semantics.sessionReader.sessionStatus(CHILD)!
    // EXACT Host/Remote parity: the child's wire facts equal the Host fold's
    // own values for the same session (usage + todos), never the parent's.
    assert.ok(childStatus.usage !== undefined, 'the child usage projection crossed the wire')
    assert.ok(mainStatus.usage !== undefined, 'the main usage projection crossed the wire')
    assert.deepEqual(childStatus.usage, hostChildValues.tokenUsage,
      'the child usage equals its own Host fold')
    assert.deepEqual(childStatus.todos, hostChildValues.todos,
      'the child todos equal their own Host fold')
    if (childStatus.usage !== undefined && mainStatus.usage !== undefined) {
      assert.ok(childStatus.usage.uncachedInputTokens !== mainStatus.usage.uncachedInputTokens
        || childStatus.usage.outputTokens !== mainStatus.usage.outputTokens,
        'the two sessions carry COMPETING usage values')
      assert.ok(childStatus.usage.uncachedInputTokens <= 200 + 42,
        `the child value is its own small sample, never the parent's 1000: ${JSON.stringify(childStatus.usage)}`)
    }
    assert.deepEqual(mainStatus.usage, hostMainValues.tokenUsage,
      'the main usage equals its own Host fold')
    assert.equal(childStatus.cwd, join(host.anchorDir, 'child'))
    // The bare session's official projection units are REGISTERED but empty:
    // their truthful zero-value wire views (usage totals, breakdown) cross —
    // they are the Host fold's real values, not inventions. The todos
    // projection's LEGAL null (present, no todo/write yet) stays null —
    // distinct from an absent (capability-unavailable) field.
    assert.deepEqual(semantics.sessionReader.sessionStatus(BARE), {
      sessionId: BARE,
      cwd: join(host.anchorDir, 'bare'),
      context: { breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
      todos: null,
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      // TPS plan PR-2: the bundle's own Host performance projection is one of
      // this Session's official facts; an empty log truthfully reads two zero
      // counters (the VIEW is always present; absence is the missing key).
      performance: {
        recent: { outputTokens: 0, modelMs: 0, samples: 0, firstTokenMs: 0, firstTokenSamples: 0 },
        all: { outputTokens: 0, modelMs: 0, samples: 0 },
      },
    }, 'the bare session reads its own cwd fact and its official zero-valued folds (todos legally null)')
    assert.equal(semantics.sessionReader.sessionStatus('never-created'), undefined,
      'an unretained session has no facts')

    // P10 — reconnect/generation replacement: the OFFICIAL reconnect replaces
    // the Connection generation; the retained binding stays identity-stable,
    // the list returns to ready, and the SAME adapters keep serving on the
    // new generation (the captured one is gone).
    const firstGeneration = runtime.client.connection.generation.getSnapshot()
    runtime.client.connection.reconnect()
    await waitFor('a different connection generation', () => {
      const generation = runtime.client.connection.generation.getSnapshot()
      return generation !== undefined && !Object.is(generation, firstGeneration)
    })
    await waitFor('the Session list to return to ready', () =>
      runtime.client.sessions.list.getSnapshot().phase === 'ready')
    const afterRows = await semantics.sessionReader.list(undefined)
    assert.ok(afterRows!.some(row => row.id === MAIN), 'the new generation serves the same Host sessions')
    const afterDirectory = await semantics.catalog.models.loadDirectory()
    assert.ok(afterDirectory.groups.some(group => group.id === 'smoke'))
    bareRef.release()
    childRef.release()
    mainRef.release()
    semantics.dispose()
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

/** Bounded test-local wait (the L5 suite's helper shape). */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('the rc.2 Question wire surfaces (live request → claim → timeout → late-answer mapping)', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  const { runtime, semantics } = await compose(host)
  try {
    const agent = await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
    acquireMainSurfaceReference(runtime.client.sessions, SessionId(MAIN))
    await waitFor('the MAIN window to open', () =>
      runtime.client.sessions.binding(SessionId(MAIN))?.session.getSnapshot().openState === 'open')

    const questions = [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }, { label: 'no' }] }]
    const captured: Array<{ sessionId: string; callId: string | undefined; timed: boolean }> = []
    const resolvers = new Map<string, (answer: AskUserQuestionAnswer) => void>()
    const registered = semantics.interaction.questions.onRequest((request) => {
      captured.push({ sessionId: request.sessionId, callId: request.callId, timed: request.timed })
      return new Promise((resolve, reject) => {
        if (request.callId !== undefined) resolvers.set(request.callId, resolve)
        // Mirror the real client: the delivery lifetime ends the attempt with
        // the wire-preserved abort code when the Host closes the wait.
        request.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('ask_user_question was aborted before the user answered'), {
            name: 'UserQuestionError', code: 'ASK_ABORTED',
          }))
        }, { once: true })
      })
    })
    assert.equal(registered, true, 'the forwarded user-questions waterfall is subscribed')

    const service = host.ctx.get('userQuestions') as unknown as {
      askTimed(
        request: { questions: readonly unknown[]; agent: unknown; signal?: AbortSignal },
        callId: unknown,
        timeoutMs: number,
      ): Promise<unknown>
      attachWait(agent: unknown, callId: unknown, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
    }

    // A — an UNCLAIMED timed request: the live request reaches the UI, and after
    // the Host's own deadline the FOREGROUND wait is gone. The call is NOT
    // durably "continued" here because the durable continued row comes from the
    // question's tool events inside a turn, and this fixture asks the service
    // directly; the wire therefore answers truthfully instead of inventing a
    // queue. (A real tool-turn deadline→continued case is recorded as a limit
    // in the PR evidence rather than faked here.)
    const callA = ToolCallId('m3b-call-a')
    const pendingA = await service.askTimed({ questions, agent }, callA, 40)
    assert.deepEqual(pendingA, { pending: true, callId: callA }, 'the Host returns the pending result, not an error')
    await waitFor('the captured live request', () => captured.length >= 1)
    assert.deepEqual(captured[0], { sessionId: MAIN, callId: 'm3b-call-a', timed: true },
      'the live request carries the derived Session identity, call identity and timed flag')

    // Wait for the REAL Host deadline to elapse before observing the late path.
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(await semantics.interaction.questions.claimTimedWait(MAIN, 'm3b-call-a'), undefined,
      'after its deadline the foreground wait can no longer be claimed')
    assert.equal(
      await semantics.interaction.questions.answerContinued(MAIN, 'm3b-call-a', { answers: [{ id: 'q1', selected: ['yes'] }] }),
      'not-continued',
      'the late-answer boolean maps truthfully when the call is not durably continued',
    )
    assert.equal(
      await semantics.interaction.questions.answerContinued(MAIN, 'm3b-call-a', { answers: [{ id: 'q1', selected: ['no'] }] }),
      'not-continued',
      'a repeated late answer is refused identically: no one-shot flag, no replayed Host settlement',
    )

    // B — a CLAIMED timed request: the first attachWait frame carries the
    // Host-computed remaining duration and the foreground answer settles it.
    const callB = ToolCallId('m3b-call-b')
    const askB = service.askTimed({ questions, agent }, callB, 5_000)
    await waitFor('the second captured request', () => captured.length >= 2)
    const claim = await semantics.interaction.questions.claimTimedWait(MAIN, 'm3b-call-b')
    assert.ok(claim !== undefined, 'a live timed wait yields a claim')
    assert.ok(claim.remainingMs > 0 && claim.remainingMs <= 5_000, `the first frame seeds the Host remaining duration: ${String(claim.remainingMs)}`)
    resolvers.get('m3b-call-b')?.({ answers: [{ id: 'q1', selected: ['no'] }] })
    const answered = await askB
    assert.deepEqual(answered, { answers: [{ id: 'q1', selected: ['no'] }] }, 'the foreground answer reaches the Host')
    claim.release()
    await claim.ended
    assert.equal(semantics.interaction.setApprovalPolicy(MAIN, 'ask'), false,
      'the Remote approval-policy write fails closed (no public rc.2 carrier)')
  } finally {
    semantics.dispose()
    await runtime.dispose()
  }
})

test('a REAL timed tool call produces a durable continued question, accepts the late answer once, and never duplicates it', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life, { llmAdapter: new TimedQuestionLlmAdapter() })
  // The REAL model-facing tool, registered on the Host tool runtime exactly as
  // the shipped `standard`/`ptc`/`cordis` presets do. The scripted model calls
  // it with `timeout: 1` so the Host's own foreground wait expires instead of
  // the test asking the service directly.
  const ToolAskUser = await import('@deepseek-ai/dsh-tool-ask-user')
  await host.ctx.plugin(ToolAskUser as never, { mode: 'timed', timeout: 1 } as never)
  const agent = await host.harness.create(
    SessionId(MAIN),
    { provider: 'smoke', model: 'smoke-model' } as never,
    { cwd: host.anchorDir },
  )
  const hostSession = agent.session as unknown as {
    snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  }
  const { runtime, semantics } = await compose(host)
  const reference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(MAIN))
  await waitFor('the MAIN window to open', () =>
    runtime.client.sessions.binding(SessionId(MAIN))?.session.getSnapshot().openState === 'open')

  const liveRequests: Array<{ readonly callId?: string; readonly timed?: boolean }> = []
  const registered = semantics.interaction.questions.onRequest((request) => {
    liveRequests.push({ callId: request.callId, timed: request.timed })
    // A live UI that never answers: the Host's own deadline must produce the
    // pending result. Reject on the request's abort so no provider promise is
    // left dangling after the timeout.
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('ask_user_question was aborted before the user answered'), {
          name: 'UserQuestionError',
          code: 'ASK_ABORTED',
        }))
      }, { once: true })
    })
  })
  assert.equal(registered, true, 'the forwarded user-questions waterfall is subscribed')
  try {
    const binding = runtime.client.sessions.binding(SessionId(MAIN)) as unknown as {
      session: {
        prompt(
          content: readonly { type: 'text'; text: string }[],
          mode: 'queue' | 'steer',
        ): Promise<{ ok: boolean; error?: unknown }>
      }
    }
    const accepted = await binding.session.prompt([{ type: 'text', text: 'start the timed question' }], 'queue')
    assert.equal(accepted.ok, true, `the official prompt must be accepted: ${JSON.stringify(accepted.error)}`)

    await waitFor('the live timed request reaches the UI', () => liveRequests.length === 1, 20_000)
    assert.deepEqual(liveRequests[0], { callId: 'm3b-timed-question-call', timed: true },
      'the live request carries the real Host call identity and timed flag')

    // The REAL tool call/result rows are on the Host log; the official
    // projection folds the pending result into `continued` (not an answer and
    // not a skipped question).
    await waitFor('the durable question is continued after the real timeout', () =>
      semantics.interaction.questions.snapshot(MAIN)?.active.some(question =>
        question.callId === 'm3b-timed-question-call' && question.state === 'continued') === true, 20_000)
    const toolEvents = hostSession.snapshotEvents()
    assert.equal(toolEvents.some(event => event.type === 'tool/call'
      && (event.data as { readonly name?: unknown }).name === 'ask_user_question'), true,
      'the real ask_user_question tool ran in the turn')
    assert.equal(toolEvents.some(event => event.type === 'tool/result'
      && (event.data as { readonly message?: { readonly toolCallId?: unknown } }).message?.toolCallId === 'm3b-timed-question-call'), true,
      'the Host recorded the pending tool result that makes the question answerable')

    const answer = { answers: [{ id: 'q1', selected: ['yes'] }] }
    assert.equal(
      await semantics.interaction.questions.answerContinued(MAIN, 'm3b-timed-question-call', answer),
      'queued',
      'the late answer is accepted into the Host inbox',
    )
    await waitFor('the late answer is admitted as a durable user message', () =>
      hostSession.snapshotEvents().some(event => event.type === 'user/message'
        && (event.data as { readonly source?: { readonly kind?: unknown } }).source?.kind === 'user-question-reply'), 20_000)
    const replies = hostSession.snapshotEvents().filter(event => event.type === 'user/message'
      && (event.data as { readonly source?: { readonly kind?: unknown } }).source?.kind === 'user-question-reply')
    assert.equal(replies.length, 1, 'the answer is persisted exactly once')
    assert.deepEqual((replies[0]!.data as {
      readonly source?: { readonly callId?: unknown }
      readonly content?: readonly { readonly type?: string; readonly text?: string }[]
    }).source?.callId, 'm3b-timed-question-call')
    assert.match((replies[0]!.data as { readonly content?: readonly { readonly text?: string }[] }).content
      ?.map(part => part.text ?? '').join('') ?? '', /"selected":\["yes"\]/u,
      'the durable reply carries the user\'s answer batch')

    await waitFor('the projection settles the continued question', () =>
      semantics.interaction.questions.snapshot(MAIN)?.settled.some(question =>
        question.callId === 'm3b-timed-question-call') === true, 20_000)
    const settled = semantics.interaction.questions.snapshot(MAIN)!
    assert.equal(settled.active.some(question => question.callId === 'm3b-timed-question-call'), false,
      'a settled question is no longer answerable')
    assert.deepEqual(settled.settled.find(question => question.callId === 'm3b-timed-question-call')?.answers,
      [{ id: 'q1', selected: ['yes'] }],
      'the settled batch is the answer the user actually submitted')

    assert.equal(
      await semantics.interaction.questions.answerContinued(MAIN, 'm3b-timed-question-call', answer),
      'not-continued',
      'a repeated late answer is refused after settlement',
    )
    assert.equal(hostSession.snapshotEvents().filter(event => event.type === 'user/message'
      && (event.data as { readonly source?: { readonly kind?: unknown } }).source?.kind === 'user-question-reply').length,
    1, 'the repeated answer never reaches the Host log')
  } finally {
    reference.release()
    semantics.dispose()
    await runtime.dispose()
  }
})

test('the M3 composition REUSES the existing userQuestions service (never a second mount)', async (t) => {
  // `@deepseek-ai/dsh-base` already mounts `id: user-questions ->
  // @deepseek-ai/dsh-user-questions`, and this bundle layers on top of that
  // base without disabling it. The M3 additive closure therefore must not
  // mount a second service: the Host's stable Typert binding has to be the
  // very same one after the composition (the additive closure mounts no
  // second service).
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  const before = (host.ctx.get('userQuestions') as { typertRemote?: unknown } | undefined)?.typertRemote
  assert.ok(before !== undefined, 'the fixture Host already provides the rc.2 userQuestions service')

  const { runtime, semantics } = await compose(host)
  try {
    const after = (host.ctx.get('userQuestions') as { typertRemote?: unknown } | undefined)?.typertRemote
    assert.equal(after, before, 'the composition reuses the existing service binding')
    // The Remote Client still reaches the namespace that binding publishes.
    assert.equal(typeof semantics.interaction.questions.onRequest, 'function')
  } finally {
    semantics.dispose()
    await runtime.dispose()
  }
  const afterDispose = (host.ctx.get('userQuestions') as { typertRemote?: unknown } | undefined)?.typertRemote
  assert.equal(afterDispose, before, 'disposal leaves the Host service untouched')
})

test('the Remote question subscription follows a REAL reconnect', async (t) => {
  // The contract the adapter claims must hold against the real Client, not only
  // a fake: a generation change notifies the consumer (which re-reads the
  // fenced snapshot), and authority is restored on the new generation.
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
  const { runtime, semantics } = await compose(host)
  const reference = runtime.client.sessions.retain(SessionId(MAIN), { source: 'controllerOperation' })
  await reference.ready

  const first = runtime.client.connection.generation.getSnapshot()
  assert.notEqual(first, undefined)
  assert.notEqual(semantics.interaction.questions.snapshot(MAIN), undefined,
    'authority to present while connected')

  let notifications = 0
  const off = semantics.interaction.questions.subscribe(MAIN, () => { notifications += 1 })
  try {
    assert.ok(off !== undefined, 'the real Client provides the observation seam')
    runtime.client.connection.reconnect()
    await waitFor('a different connection generation', () =>
      runtime.client.connection.generation.getSnapshot()?.id !== first?.id)
    await waitFor('the generation change to notify the question surface', () => notifications >= 1)
    // Authority comes back on the new generation (the fenced read answers
    // again), so the consumer's reconcile can re-derive reachability.
    await waitFor('authority on the new generation', () =>
      semantics.interaction.questions.snapshot(MAIN) !== undefined)
  } finally {
    off?.()
    reference.release()
    await runtime.dispose()
  }
})

test('the assembled M3-3B Remote backend serves config + archive over the real Host/Client graph', async (t) => {
  // The M3-3B integrated same-Host qualification: ONE real rc.2 Host Context ->
  // the real experimental Client runtime -> `createRemoteBackendRuntime(...)`
  // with the composition-owned carrier fetch. The earlier suites prove the
  // adapters against structural fakes; this proves the ASSEMBLY over the real
  // wire.
  const life = testLifecycle(t)
  const host = await createHostFixture(life, { configPlane: true })
  await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
  seedTurn(host, MAIN, {
    turn: 1,
    prompt: 'archive me',
    response: 'archived answer',
    usage: { inputTokens: 7, outputTokens: 3 },
  })
  // Deliberately NOT `compose(...)`: that would also build an M3A semantic
  // bundle over this same Client graph, and the closure evidence must carry
  // exactly ONE M3 wiring — the one `createRemoteBackendRuntime` assembles.
  const runtime = await composeRuntime(host)
  const assembled = await createRemoteBackendRuntime({
    runtime: runtime.client,
    promptSerializer: stubSerializer(),
    fetch: runtime.host.carrier.fetch,
  })
  const reference = runtime.client.sessions.retain(SessionId(MAIN), { source: 'controllerOperation' })
  await reference.ready
  try {
    // 1. This assembly is the Remote backend. The exact advertised set (and its
    // equality with the whole port vocabulary) is locked in
    // `test/app/remote-backend.test.ts`; repeating it here against the same
    // constant the backend is built from would assert nothing.
    assert.equal(assembled.backend.kind, 'remote')

    // 2. Config over the REAL generated settings Remote with the
    // production-equivalent config plane mounted: the mirror reached the
    // official settings namespace (the namespace-loss P1 fixed in the port),
    // committed its first describe, and a REAL write is followed by the
    // authoritative Host read.
    assert.equal(assembled.backend.config.configReadiness(), 'ready', 'the first real describe committed')
    const tuiSettings = assembled.backend.config.tuiSettings
    assert.ok(tuiSettings !== undefined, 'the settings section is served over the wire')
    const before = tuiSettings.get()
    const nextTheme = before.theme === 'dark' ? 'light' : 'dark'
    await tuiSettings.replace({ ...before, theme: nextTheme })
    assert.equal(tuiSettings.get().theme, nextTheme, 'the authoritative re-read sees the Host mutation')
    assert.equal(assembled.backend.config.configReadiness(), 'ready', 'and the mirror stays current')
    await tuiSettings.replace(before)
    assert.equal(tuiSettings.get().theme, before.theme, 'and the revert is authoritative too')

    // 2b. The official revision fence itself — the property the whole-document
    // writer relies on when it passes the revision its ops were RECONCILED
    // against. A mutate carrying a revision the live document already moved past
    // is REFUSED and the concurrent value is preserved, over the REAL settings
    // plane; the adapter-level stale-diff equivalence is locked in
    // `test/domain/remote-config-port.test.ts`.
    const hostSettings = (host.ctx as unknown as {
      settings: {
        describe(): readonly { ns: string; value?: { theme?: string }; revision?: number }[]
        mutate(ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[], revision?: number): Promise<unknown>
      }
    }).settings
    const anchored = hostSettings.describe().find(entry => entry.ns === 'tui-app')
    assert.ok(anchored !== undefined, 'the tui-app namespace is served by the real settings plane')
    assert.notEqual(anchored.revision, undefined, 'and the real descriptor carries a revision')
    const staleRevision = anchored.revision
    const externalTheme = anchored.value?.theme === 'dark' ? 'light' : 'dark'
    await hostSettings.mutate('tui-app', [{ op: 'set', path: ['theme'], value: externalTheme }], undefined)
    await assert.rejects(
      async () => {
        await hostSettings.mutate('tui-app', [{ op: 'set', path: ['theme'], value: 'stale-write' }], staleRevision)
      },
      (error: unknown) => {
        assert.match(
          String((error as { message?: unknown })?.message ?? error),
          /revision|conflict|changed/u,
          'the refusal names the moved revision',
        )
        return true
      },
    )
    const settled = hostSettings.describe().find(entry => entry.ns === 'tui-app')
    assert.equal(settled?.value?.theme, externalTheme, 'the stale write never reached the document')

    // 3. Archive over the REAL Host route: the composition carrier fetch reaches
    // `/api/session.export` for real (never a fake fetch), and the returned ZIP
    // is unpacked here to prove the whole chain carried the ACTUAL durable log
    // of this AgentLoop-backed Session: seeded prompt and answer, in the root
    // entry the upstream exporter names. The fail-closed classification (absent
    // Session → `none`, missing services → `unavailable`, any other failure →
    // thrown) is locked separately in `test/runtime/remote/remote-session-archive.test.ts`.
    const opened = await assembled.backend.sessionArchive.open(MAIN)
    assert.ok(opened.kind === 'ready', `the Host serves a real archive (got ${opened.kind})`)
    assert.equal(opened.artifact.filename, sessionLogZipFilename(MAIN), 'the upstream archive filename')
    const chunks: Uint8Array[] = []
    const reader = opened.artifact.stream.getReader()
    for (;;) {
      const next = await reader.read()
      if (next.done === true) break
      chunks.push(next.value)
    }
    const archiveBytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let archiveOffset = 0
    for (const chunk of chunks) {
      archiveBytes.set(chunk, archiveOffset)
      archiveOffset += chunk.byteLength
    }
    const archiveEntries = unzipEntries(archiveBytes)
    const rootLog = archiveEntries.get(SESSION_LOG_FILENAME)
    assert.ok(rootLog !== undefined,
      `the archive carries the root session log (entries: ${[...archiveEntries.keys()].join(', ') || 'none'})`)
    const logText = new TextDecoder().decode(rootLog)
    assert.match(logText, /archive me/u, 'the ZIP carries the seeded prompt')
    assert.match(logText, /archived answer/u, 'the ZIP carries the seeded answer')

    // 4. The ONE M3 wiring here is the assembly's own: it serves the adapter
    // INSTANCE it built, never a second one constructed inside
    // `createRemoteBackend` (the pass-through could be replaced by a rebuilt
    // adapter).
    assert.equal(
      assembled.backend.interaction,
      assembled.semantics.interaction,
      'the backend serves the assembly\'s own interaction adapter',
    )

    // 5. Reverse disposal: the adapters go first, then the Client/Context, and
    // the borrowed Client stays usable in between — the adapters own only their
    // own state.
    assembled.dispose()
    assembled.dispose()
    const survivor = runtime.client.sessions.retain(SessionId(MAIN), { source: 'controllerOperation' })
    await survivor.ready
    survivor.release()
  } finally {
    reference.release()
    assembled.dispose()
    await runtime.dispose()
  }
})

test('the REAL /settings workspace commits through the Remote adapter over the wire and verifies by the authoritative re-read', async (t) => {
  // The Remote ASSEMBLED UI path the acceptance requires: the command's
  // `ConfigPort.tuiSettings` IS the Remote adapter over the real generated
  // transport, the UI is the real `TuiApp` on a virtual terminal, and the
  // authoritative sink is the real Host settings plane. Nothing here is a
  // hand-rolled settings object.
  const life = testLifecycle(t)
  const host = await createHostFixture(life, { configPlane: true, captureTuiRowConfig: true })
  await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
  const runtime = await composeRuntime(host)
  // Register every resource for teardown the moment it EXISTS: an exception
  // after the Client runtime came up must still release the reference,
  // dispose the adapters and stop the Client BEFORE the Host fixture goes
  // away. A skipped cleanup leaves the Connection reconnecting against a
  // dead Host and the test process never settles.
  let disposeAssembled: (() => void) | undefined
  let releaseReference: (() => void) | undefined
  let disposeFixture: (() => void) | undefined
  try {
    const assembled = await createRemoteBackendRuntime({
      runtime: runtime.client,
      promptSerializer: stubSerializer(),
      fetch: runtime.host.carrier.fetch,
    })
    disposeAssembled = () => { assembled.dispose() }
    const reference = runtime.client.sessions.retain(SessionId(MAIN), { source: 'controllerOperation' })
    releaseReference = () => { reference.release() }
    await reference.ready
    const config = assembled.backend.config
    const fixture = await mountSettingsWorkspace(host.anchorDir, config, 'remote')
    disposeFixture = () => { fixture.dispose() }
    assert.equal(config.configReadiness(), 'ready', 'the Remote mirror reached the Host settings plane')
    const tuiSettings = config.tuiSettings
    assert.ok(tuiSettings !== undefined, 'the settings section is served over the wire')

    await fixture.open()
    await fixture.selectCategory('Conversation')
    await fixture.key('\r') // L0 -> L1
    await fixture.key('\r') // writable L1 -> L2 inline choice
    const initialChoice = fixture.view().replace(/\s+/gu, ' ')
    assert.match(initialChoice, /Transcript display/)
    assert.match(initialChoice, /Choose value/)
    assert.match(initialChoice, /Value full/)
    assert.match(initialChoice, /Persisted full/)
    assert.match(initialChoice, /Client runtime · optional TUI preference/)
    assert.match(initialChoice, /> full/)
    await fixture.key('\x1b[6~') // PgDn scrolls facts only
    const scrolledChoice = fixture.view().replace(/\s+/gu, ' ')
    assert.match(scrolledChoice, /persistence/, 'the wrapped Scope continuation is readable')
    assert.match(scrolledChoice, /> full/, 'scrolling facts leaves the candidate unchanged')
    await fixture.key('\x1b[B') // full -> compact, still only a preview
    assert.match(fixture.view(), /> compact/)
    await fixture.key('\r') // explicit confirm
    await fixture.settleUntil(/Status\s+Verified/, 'the display-preset write')

    assert.match(fixture.view(), /Status\s+Verified/, `the UI verified the commit:\n${fixture.view()}`)
    // The REAL Host document changed — the mirror's re-read is not the only witness.
    const hostDescriptor = (): { readonly ns: string; readonly value?: Record<string, unknown>; readonly user?: unknown } | undefined =>
      (host.ctx as unknown as {
        settings: { describe(): readonly { ns: string; value?: Record<string, unknown>; user?: unknown }[] }
      }).settings.describe().find(entry => entry.ns === 'tui-app')
    /** The same read through the SAVED UNBOUND original, for a case that has an
     *  injected read failure armed on the live service. */
    const hostDescriptorUnpatched = (): Record<string, unknown> | undefined => {
      const descriptor = (originalDescribe.call(forms) as readonly {
        readonly ns: string
        readonly value?: Record<string, unknown>
      }[]).find(entry => entry.ns === 'tui-app')
      return descriptor?.value
    }
    const descriptor = hostDescriptor()
    assert.equal(descriptor?.value?.displayPreset, 'compact', 'the Host authority carries the new preset')
    // The USER layer owns exactly the written field — the whole document was not
    // pinned by the merge (W-11 through the real Host).
    const user = descriptor?.user as Record<string, unknown> | undefined
    assert.equal(user?.displayPreset, 'compact', 'and only that field reached the USER layer')
    assert.equal(user?.theme, undefined, 'no other field was pinned')
    assert.equal(tuiSettings.get().displayPreset, 'compact', 'and the authoritative Remote re-read agrees')
    assert.equal(config.configReadiness(), 'ready', 'the mirror stayed current through the write')

    // ── the SAME chain must also REFUSE over the real wire, and must never attribute a
    // rejection it cannot prove. The Host service is patched in place (the unbound
    // originals are restored in the finally), so the failure really happens on the
    // production read/write path.
    const forms = (host.ctx as unknown as {
      settings: {
        describe(...args: never[]): unknown
        mutate(...args: never[]): Promise<unknown>
      }
    }).settings
    const originalDescribe = forms.describe
    const originalMutate = forms.mutate
    let failMutate = false
    let failRefresh = false
    forms.mutate = function (this: unknown, ...args: never[]): Promise<unknown> {
      if (failMutate) {
        failMutate = false
        throw Object.assign(new Error('settings write refused (injected)'), { code: 'settings/rejected' })
      }
      const accepted = originalMutate.apply(this, args)
      // Arm the authoritative refresh from the moment THIS write is ACCEPTED (the
      // service's own pre-write reads are already done) and keep failing until the
      // assertion has run: the post-settlement read — the adapter's own or the
      // invalidation-triggered one — then really cannot complete.
      void Promise.resolve(accepted).then(() => { failRefresh = true })
      return accepted
    }
    forms.describe = function (this: unknown, ...args: never[]): unknown {
      if (failRefresh) throw new Error('settings read unavailable (injected)')
      return originalDescribe.apply(this, args)
    }
    /** Reopen the choice and step ONE candidate down (the display candidates are the
     *  fixed `full, compact, focus` vocabulary and the choice starts on the persisted
     *  one), then confirm and wait for the settlement the write must reach. */
    const chooseNextPreset = async (expected: RegExp, label: string): Promise<void> => {
      await fixture.key('\r')
      assert.match(fixture.view().replace(/\s+/gu, ' '), /Choose value/)
      await fixture.key('\x1b[B')
      assert.match(fixture.view(), /> focus/, `the highlighted candidate is the next preset:\n${fixture.view()}`)
      await fixture.key('\r')
      await fixture.settleUntil(expected, label)
    }
    try {
      // A refused official mutate is a REFUSAL: the UI says so and the Host is intact.
      failMutate = true
      await chooseNextPreset(/Status\s+Not saved/, 'the refused display-preset write')
      const refusedFrame = fixture.view().replace(/\s+/gu, ' ')
      assert.match(
        refusedFrame,
        /Not saved · the display preset is.*?applied locally, but storing it failed:.*?settings\.mutate\(tui-app\) failed:.*?settings write refused \(injected\)/,
        `a refused write is reported:\n${fixture.view()}`,
      )
      assert.equal(hostDescriptor()?.value?.displayPreset, 'compact', 'the refused write never reached the Host')

      // A rejected write whose authoritative readback cannot complete must never be
      // called `Not saved`, and must never be called `Verified`: the official service
      // applies the edit and then performs its OWN post-write describe, so a failure of
      // that read reaches the client as a failed `settings.mutate` even though the write
      // may have committed. The adapter re-reads the authority on that failure and the
      // workspace attributes the outcome from it — here the authority already carries the
      // requested value, which proves the value is in place but never that THIS request
      // was accepted, so the outcome is `Outcome unknown`. The Host state and that
      // classification are asserted TOGETHER.
      await chooseNextPreset(/Status\s+Outcome unknown/, 'the write whose readback could not complete')
      const hostAfter = hostDescriptorUnpatched()
      const unverifiedFrame = fixture.view().replace(/\s+/gu, ' ')
      assert.equal(hostAfter?.displayPreset, 'focus', 'the Host authority really committed the write')
      // The CLIENT cannot attribute the rejection (the failure may precede or follow
      // the commit), so the outcome is stated as unknown — never an acceptance it
      // cannot prove (the "Commit accepted" wording is reserved for a write that
      // RETURNED SUCCESS with an unavailable readback) and never a refusal.
      assert.match(
        unverifiedFrame,
        /Outcome unknown ·/,
        `a rejected write whose readback could not complete is neither accepted nor refused:\n${fixture.view()}`,
      )
      assert.doesNotMatch(unverifiedFrame, /Not saved · the display preset/,
        `and it is not misreported as a refusal:\n${fixture.view()}`)
    } finally {
      failRefresh = false
      failMutate = false
      forms.describe = originalDescribe
      forms.mutate = originalMutate
    }

    // L4 parity witness: use the SAME real Host, namespace and field in both
    // directions. The production Direct adapter observes the Remote UI commit,
    // writes that field back through SettingsForms, and the production Remote
    // adapter refreshes the authoritative result over the generated Client.
    const rowConfig = (globalThis as { __m3aTuiRowConfig?: unknown }).__m3aTuiRowConfig
    assert.ok(rowConfig !== undefined, 'the mounted tui-app row exposed its resolved Config references')
    const directForms = host.ctx.get('settings') as SettingsFormsLike | undefined
    assert.ok(directForms !== undefined, 'the official Host settings service is mounted')
    const directSettings = new DirectTuiSettings(rowConfig as TuiConfigRefs, directForms)
    assert.ok(config instanceof RemoteConfigPort, 'the assembled Remote backend uses the production config adapter')
    assert.equal(directSettings.get().displayPreset, 'focus', 'Direct observes the Remote-committed value from the same Host')
    await directSettings.replace({ ...directSettings.get(), displayPreset: 'full' })
    const pairedDescriptor = hostDescriptor()
    assert.equal(pairedDescriptor?.value?.displayPreset, 'full', 'Direct writes the same Host field')
    const pairedUser = pairedDescriptor?.user as Record<string, unknown> | undefined
    assert.equal(pairedUser?.displayPreset, 'full', 'the same USER-owned field is updated')
    assert.equal(pairedUser?.theme, undefined, 'the Direct write does not pin an unrelated field')
    assert.equal(directSettings.get().displayPreset, 'full', 'the Direct volatile reference follows its commit')
    await config.describe()
    assert.equal(tuiSettings.get().displayPreset, 'full', 'Remote refresh reads the Direct-committed value from the same Host')
    assert.equal(config.configReadiness(), 'ready', 'both adapters remain current after the paired writes')
  } finally {
    // Each cleanup runs even when an earlier one throws: a broken UI teardown
    // must never leave the Client adapters or the Client runtime alive.
    try {
      disposeFixture?.()
    } finally {
      try {
        releaseReference?.()
      } finally {
        try {
          disposeAssembled?.()
        } finally {
          await runtime.dispose()
        }
      }
    }
  }
})

test('the REAL Host-owned Direct settings authority drives the /settings workspace (Theme → Host commit → authoritative re-read → Verified)', async (t) => {
  // The Direct counterpart of P16, over the SAME real Host config plane: the settings
  // port is the production `DirectConfigPort` whose `tuiSettings` is the production
  // `DirectTuiSettings` — built EXACTLY as `src/app/bootstrap.ts` builds it, from the
  // mounted `tui-app` plugin's own resolved volatile Config references and the official
  // Host `SettingsForms` service. The Host commit therefore lands in the real
  // profile-backed document, and the UI verifies against that authority.
  const life = testLifecycle(t)
  const host = await createHostFixture(life, { configPlane: true, captureTuiRowConfig: true })
  const rowConfig = (globalThis as { __m3aTuiRowConfig?: unknown }).__m3aTuiRowConfig
  assert.ok(rowConfig !== undefined, 'the mounted tui-app row exposed its resolved Config references')
  const forms = host.ctx.get('settings') as SettingsFormsLike | undefined
  assert.ok(forms !== undefined, 'the official Host settings service is mounted')
  const settings = new DirectTuiSettings(rowConfig as TuiConfigRefs, forms)
  const port = new DirectConfigPort(host.ctx as never, settings, () => undefined)
  const fixture = await mountSettingsWorkspace(host.anchorDir, port, 'direct')
  const hostDescriptor = (): { readonly ns: string; readonly value?: Record<string, unknown>; readonly user?: unknown } | undefined =>
    (host.ctx as unknown as {
      settings: { describe(): readonly { ns: string; value?: Record<string, unknown>; user?: unknown }[] }
    }).settings.describe().find(entry => entry.ns === 'tui-app')
  try {
    assert.equal(port.configReadiness(), 'ready', 'Direct reads hit the in-process Host authority')
    assert.equal(settings.get().theme, 'auto', 'the profile schema default is the live reference value')

    await fixture.open()
    await fixture.selectCategory('Appearance')
    await fixture.key('\r') // L0 -> L1
    await fixture.key('\r') // writable L1 -> L2 inline choice
    assert.match(fixture.view(), /Configured theme/)
    const choiceFrame = fixture.view().replace(/\s+/gu, ' ')
    assert.match(choiceFrame, /Choose value/)
    assert.match(choiceFrame, /> auto/)
    assert.equal(settings.get().theme, 'auto', 'entering the choice is preview-only')
    // Pick a value that really CHANGES the runtime: the fresh TuiApp is painted dark,
    // so `light` proves the apply reached the live surface (and `auto` would leave the
    // terminal detection to decide).
    await fixture.key('\x1b[B') // auto -> dark
    await fixture.key('\x1b[B') // dark -> light
    assert.match(fixture.view(), /> light/)
    await fixture.key('\r') // confirm
    await fixture.settleUntil(/Status\s+Verified/, 'the theme write')
    assert.match(
      fixture.view().replace(/\s+/gu, ' '),
      /Status Verified · the authoritative read agrees/,
      `the UI verified the commit:\n${fixture.view()}`,
    )
    assert.match(fixture.view(), /Runtime\s+light/, 'the Detail names the runtime fact it applied')
    assert.equal(fixture.app.currentTheme(), 'light', 'and the live surface really changed')

    // The REAL Host authority: the effective value, the USER layer that owns exactly
    // the written field, the live volatile references and the profile document.
    const descriptor = hostDescriptor()
    assert.equal(descriptor?.value?.theme, 'light', 'the Host effective value carries the change')
    const user = descriptor?.user as Record<string, unknown> | undefined
    assert.equal(user?.theme, 'light', 'and the USER layer owns exactly that field')
    assert.equal(user?.displayPreset, undefined, 'no other field was pinned by the write')
    assert.equal(settings.get().theme, 'light', 'the live Config references followed the Host commit')
    const patch = readFileSync(join(host.workRoot, 'profile', 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /theme: light/, `the profile document really carries it:\n${patch}`)
  } finally {
    fixture.dispose()
  }
})

test('without a settings service the Remote config fails closed', async (t) => {
  // The complementary contract, deliberately kept testable now that the config
  // plane is opt-in: on a deployment whose profile composition carries no
  // settings service the Remote configuration must never fabricate values and
  // must never report a local success.
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
  const runtime = await composeRuntime(host)
  const assembled = await createRemoteBackendRuntime({
    runtime: runtime.client,
    promptSerializer: stubSerializer(),
    fetch: runtime.host.carrier.fetch,
  })
  try {
    const config = assembled.backend.config
    assert.equal(config.configReadiness(), 'unavailable')
    const failure = (config as unknown as { lastRefreshFailure?: () => Error }).lastRefreshFailure?.()
    assert.match(
      String(failure?.message),
      /settings service is absent/u,
      'the Host diagnostic reaches the consumer instead of a fabricated value',
    )
    assert.equal(config.tuiSettings, undefined, 'no settings view is fabricated')
    await assert.rejects(
      () => config.permissions.setDefaultPreset('any-preset'),
      /settings\.describe failed|has not been read yet|not current/u,
      'a write against an unreadable Remote configuration is refused, never a local success',
    )
  } finally {
    assembled.dispose()
    await runtime.dispose()
  }
})
