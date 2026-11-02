/**
 * M4 PR4 external-review P2 (second round) — a SESSIONLESS local command is
 * accepted at the gesture, but its persistent configuration write only starts
 * after an asynchronous preparation (the real `/preset default <id>` first
 * awaits the official agent-preset roster, then writes the default). The
 * config port only registers the write when it is dispatched, so a manual
 * `/reload-client` during that preparation window could retire the old Client
 * and cut the accepted command off.
 *
 * This test drives the REAL command chain:
 * - the REAL `/preset` command handler (`createModelCommands().registerPreset`)
 *   with a HELD `catalog.presets.resolve()` — the production pre-write await;
 * - the REAL registered `/reload-client` handler and ClientCommandRegistry;
 * - the REAL SubmissionController's sessionless `runLocalCommand` dispatch and
 *   the REAL `createClientReloadCommandRequest` owner.
 *
 * Fix under test: the accepted local command that may write holds the
 * controller's accepted-command lifetime for its WHOLE handler (preparation
 * included); read-only commands and `/reload-client` itself stay uncounted.
 *
 * @module @xmoon76/dsh-pi-tui/client-reload-local-command.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createClientReloadCommandRequest } from '../../src/app/command/client-reload.ts'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime, type SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createModelCommands } from '../../src/tui/commands/models.ts'
import { CLIENT_RELOAD_REFUSAL_NOTICES, registerReloadClientCommand } from '../../src/tui/commands/utility.ts'
import {
  localCommandMayWrite,
  READ_ONLY_LOCAL_COMMANDS,
} from '../../src/domain/command/policy.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import type { WriteOutcome } from '../../src/runtime/session-writer-port.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  cancel(): void
}

interface Harness {
  readonly controller: ReturnType<typeof createSubmissionController<AgentLike>>
  readonly requests: number
  readonly configWrites: readonly string[]
  readonly notices: readonly string[]
  resolveEntered: Promise<void>
  releaseResolve(): void
  drain(): Promise<void>
}

function startHarness(): Harness {
  let draft = ''
  const notices: string[] = []
  const configWrites: string[] = []
  let requests = 0
  let enterResolve!: () => void
  const resolveEntered = new Promise<void>((resolve) => { enterResolve = resolve })
  let releaseResolve!: () => void
  const resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve })

  const agent: AgentLike = { status: 'idle', session: { id: 'session-a' }, options: {}, cancel: () => {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-a')
  const scopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = core.subject()
      if (subject === undefined) throw new Error('fixture: the owner is not published')
      return { sessionId: 'session-a', generation: core.generation(), subject }
    },
    isSubjectCurrent: (subject) => core.isSubjectCurrent(subject),
  })
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text
    },
    restoreStaleDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message) => { notices.push(message) },
    refuseByTransitionFence: (text) => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt('session-a', text, { images, files }, requestId),
    prompt: async (_sessionId, _message): Promise<WriteOutcome> => ({ kind: 'committed', value: undefined }),
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })

  // ── The REAL command registry: the real /preset handler and /reload-client.
  const registry = createClientCommandRegistry(parseCommand)
  const presetRunner = {
    signal: new AbortController().signal,
    effectivePresetId: undefined,
    pendingPreset: undefined as string | undefined,
    currentPreset: () => undefined,
    catalog: {
      presets: {
        available: () => true,
        // The production PRE-WRITE await: the roster read the reviewer asked
        // us to hold instead of the config write.
        resolve: async (_id: string) => {
          enterResolve()
          await resolveGate
          return { id: 'code' }
        },
        defaultId: () => undefined,
      },
    },
    config: {
      presetDefault: {
        available: () => true,
        get: () => undefined,
        set: async (id: string) => { configWrites.push(id) },
      },
    },
    refreshStandingCatalog: async () => ({ kind: 'applied' as const }),
  }
  const modelCommands = createModelCommands({
    runner: presetRunner as never,
    app: {} as never,
    presetPresentation: {
      notify: () => {},
      open: async () => ({ kind: 'success' as const }),
    } as never,
    registerOne: (definition) => { registry.register(definition) },
    recordCommandDraftDisposition: () => {},
    notifyOutcome: () => {},
  })
  modelCommands.registerPreset()

  let controller: ReturnType<typeof createSubmissionController<AgentLike>> | undefined
  const request = createClientReloadCommandRequest({
    facts: {
      capable: () => true,
      ready: () => true,
      draftText: () => '',
      stagedImageCount: () => images.values().length,
      stagedFileCount: () => files.values().length,
      // The SAME composition the bootstrap uses: the accepted-command lifetime
      // is this controller's unsettled-write read (the config port read is
      // covered by its own suite).
      hasUnsettledUserWrite: () => controller!.hasUnsettledClientWrite(),
      hasUnsettledInteraction: () => false,
      hasUnsettledTransition: () => false,
    },
    request: () => {
      requests += 1
      return { kind: 'accepted' }
    },
  })
  registerReloadClientCommand({
    runner: { requestClientReload: request },
    registerTuiCommand: (spec) => {
      registry.register({ name: spec.name, description: spec.description, handler: spec.handler })
    },
    recordCommandDraftDisposition: () => {},
  })

  const composer = {
    getDraft: () => draft,
    setDraft: (text: string) => { draft = text },
    setEditorText: (text: string) => { draft = text },
    insertIntoEditor: (text: string) => { draft += text },
    notify: (message: string) => { notices.push(message) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
  }
  const command = {
    wasAdvertisedClaim: () => false,
    hostClaimOf: () => undefined,
    hostOriginClaimOf: () => undefined,
    hostCatalogResolves: () => false,
    clientClaimsLine: (parsed: { name: string; rawInput?: string } | undefined) => registry.claimsLine(parsed),
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands: registry,
  }
  const deps: SubmissionControllerDeps<AgentLike> = {
    app: () => composer,
    diag: DIAG,
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    // A SESSIONLESS Client: this is the runLocalCommand path.
    liveAgent: () => undefined,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => scopeAuthority.captureLive(),
      isCurrent: (scope) => scopeAuthority.isCurrent(scope),
      requireLive: () => {
        const live = scopeAuthority.captureLive()
        if (live === undefined) throw new Error('fixture: the owner is not live')
        return live
      },
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: command as unknown as SubmissionControllerDeps<AgentLike>['command'],
    commandPlane: { available: () => false, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'remote',
    backend: {
      hostFile: { canonicalizeMentions: async (_scope: unknown, text: string) => text } as never,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed', value: undefined }) } as never,
      hostCommand: { execute: async () => ({ kind: 'committed', matched: false }) } as never,
    },
    drafts: { images, files },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: () => {},
      persistAfterSession: async (resolveSession, persist) => { persist(await resolveSession()) },
    },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { run: () => {}, interrupt: () => {} },
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: (subject) => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: (subject) => core.subjectAuthority.ownerReplaced(subject as never),
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text, requestId) => preparePrompt('session-a', text, { images, files }, requestId),
  }
  controller = createSubmissionController<AgentLike>(deps)
  const drain = async (): Promise<void> => {
    for (let index = 0; index < 200; index += 1) await Promise.resolve()
  }
  return {
    controller,
    get requests() { return requests },
    get configWrites() { return configWrites },
    get notices() { return notices },
    resolveEntered,
    releaseResolve: () => { releaseResolve() },
    drain,
  }
}

test('an accepted /preset default command holds the reload gate through its pre-write roster await', async () => {
  const harness = startHarness()
  harness.controller.submit('/preset default code')
  await harness.resolveEntered
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'the accepted local command is unsettled BEFORE the config write is dispatched')
  assert.equal(harness.configWrites.length, 0, 'the roster await runs before the config write')

  harness.controller.submit('/reload-client')
  await harness.drain()
  assert.equal(harness.requests, 0, 'the process request must not be reached during the preparation window')
  assert.equal(harness.notices.includes(CLIENT_RELOAD_REFUSAL_NOTICES.submission), true,
    'the user sees the fixed submission refusal')

  harness.releaseResolve()
  for (let attempt = 0; attempt < 200 && harness.controller.hasUnsettledClientWrite(); attempt += 1) {
    await harness.drain()
  }
  assert.equal(harness.configWrites.length, 1, 'the preset default write ran after the roster resolved')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false, 'the command terminal settlement releases the lifetime')

  harness.controller.submit('/reload-client')
  await harness.drain()
  assert.equal(harness.requests, 1, 'the settled command allows the manual reload')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    'the /reload-client command itself never holds a business-write lifetime')
})

test('the read-only local command set stays explicit and never includes a writer', () => {
  for (const name of ['reload-client', 'reload', 'help', 'copy', 'sessions', 'attach']) {
    assert.equal(READ_ONLY_LOCAL_COMMANDS.has(name), true, `/${name} must be a declared read-only local command`)
    assert.equal(localCommandMayWrite(name), false)
  }
  for (const name of ['preset', 'settings', 'footer', 'display', 'focus', 'login', 'logout', 'yolo', 'status']) {
    assert.equal(localCommandMayWrite(name), true,
      `/${name} may perform a persisted write and must keep the reload gate closed`)
  }
  assert.equal(localCommandMayWrite('a-future-local-writer'), true,
    'an undeclared local command is treated as a potential writer (fail-safe)')
})
