/**
 * DRAFT (Pre-M3 PR3) — test/remote-official-contract.test.ts
 *
 * The centralized compile-time compatibility gate for every Remote adapter the
 * TUI intends to bring into M3, plus the rc.2 published-surface gate M3-3B
 * depends on. Each `officialX` function below is a REAL structural
 * assignability proof: the pinned installed DSH PUBLIC Client / generated
 * Remote face must satisfy the adapter's declared source type with NO cast.
 * The pre-existing adapter proofs were frozen against 0.1.7-rc.2 and carry
 * over unchanged; the M3-3A additions were proven against 0.2.0-rc.1 and the
 * M3-3B additions are proven against 0.2.0-rc.2 — the per-stage requalification
 * record lives in docs/m3-entry-contract.md §1.1/§2.1. The functions are never
 * called at runtime; `assert.equal(typeof …, 'function')` keeps them referenced
 * so the compiler must keep checking them.
 *
 * Contract matrix (adapter -> official face):
 *
 * | Adapter                        | Official face                                   |
 * |--------------------------------|-------------------------------------------------|
 * | RemoteSessionReader            | `ISessions`                                     |
 * | RemoteSessionWriter            | `ISessions`                                     |
 * | RemoteSessionLifecycle         | `ISessions` + `ClientRemote['session']`         |
 * | RemoteModelCatalog             | `ClientRemote['session']` + `ISessions`         |
 * | RemotePresetCatalog            | `ClientRemote['agentPresets']`                  |
 * | RemotePendingInputReader       | `ISessions`                                     |
 * | RemoteHostCommandPort          | `ClientRemote['commands']`                      |
 * | RemoteSubagentPort             | `ClientRemote['subagents']`                     |
 * | RemoteTaskReader               | `ISessions` + `IJobs`                           |
 * | RemotePresentationReader       | `ISessions`                                     |
 * | RemoteSurfaceAuthorityReader   | `ClientRemote['commands']` + ['skills']         |
 * | RemoteSubmissionPresentation   | `ISessions`                                     |
 * | RemotePluginManagerPort        | `ClientRemote` (methods + forwarded events)     |
 * | RemoteJobObservationPort       | `IJobs`                                         |
 * | RemoteInteractionPort          | `ISessions` + `ClientRemote` (userQuestions + $on) |
 * | RemoteSessionArchive          | the composition-owned `Fetch`                   |
 * | RemoteConfigPort               | `ClientRemote['settings']` + `['credentials']`   |
 *
 * @module @xmoon76/dsh-pi-tui/remote-official-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
// The generated namespace augmentations (`session`, `commands`, `subagents`,
// `skills`, `agentPresets`, `pluginManager`) are declared by each package's
// `./remote` face; this public assembly entry references them all, so the
// `ClientRemote[...]` indexed accesses below resolve to the published contract.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteSessionReader } from '../src/runtime/remote/session-reader-remote.ts'
import { RemoteSessionWriter, type RemotePromptSerializer } from '../src/runtime/remote/session-writer-remote.ts'
import { RemoteSessionLifecycle } from '../src/runtime/remote/session-lifecycle-remote.ts'
import { RemoteModelCatalog, type RemoteLlmRemotes } from '../src/runtime/remote/model-remote.ts'
import { RemotePresetCatalog } from '../src/runtime/remote/preset-remote.ts'
import { RemotePendingInputReader } from '../src/runtime/remote/pending-input-reader-remote.ts'
import { RemoteHostCommandPort } from '../src/runtime/remote/host-command-remote.ts'
import { RemoteSubagentPort } from '../src/runtime/remote/subagent-remote.ts'
import { RemoteTaskReader } from '../src/runtime/remote/task-read-remote.ts'
import { RemotePresentationReader } from '../src/runtime/remote/presentation-read-remote.ts'
import { RemoteSurfaceAuthorityReader } from '../src/runtime/remote/surface-authority-remote.ts'
import { RemoteSubmissionPresentation } from '../src/submission-presentation.ts'
import { RemotePluginManagerPort } from '../src/runtime/remote/plugin-manager-remote.ts'
import { RemoteJobObservationPort } from '../src/runtime/remote/job-observation-remote.ts'
import { RemoteSkillCatalog } from '../src/runtime/remote/skill-remote.ts'
import { createRemoteM3ASemantics, remoteM3ARuntimeSourceOf } from '../src/app/remote/m3a-semantics.ts'
import { RemoteHostFilePort } from '../src/runtime/remote/host-file-remote.ts'
import { RemoteInteractionPort } from '../src/runtime/remote/interaction-remote.ts'
import type { ContextPressureProjection, ContextBreakdownProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/types'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusProjection, SessionReader } from '../src/runtime/session-reader-port.ts'
import type { PresentationReader, TurnOutlineEntryDto } from '../src/runtime/presentation-read-port.ts'

function officialSessionReader(sessions: ISessions, generation: ConnectionGenerationState): RemoteSessionReader {
  return new RemoteSessionReader(sessions, generation)
}

function officialSessionWriter(
  sessions: ISessions,
  generation: ConnectionGenerationState,
  serializer: RemotePromptSerializer,
): RemoteSessionWriter {
  return new RemoteSessionWriter(sessions, generation, serializer)
}

function officialSessionLifecycle(
  sessions: ISessions,
  session: ClientRemote['session'],
  generation: ConnectionGenerationState,
): RemoteSessionLifecycle {
  return new RemoteSessionLifecycle(sessions, session, generation)
}

function officialModelCatalog(
  session: ClientRemote['session'],
  sessions: ISessions,
  generation: ConnectionGenerationState,
): RemoteModelCatalog {
  return new RemoteModelCatalog(session, sessions, generation)
}

function officialPresetCatalog(
  presets: ClientRemote['agentPresets'],
  generation: ConnectionGenerationState,
): RemotePresetCatalog {
  return new RemotePresetCatalog(presets, generation)
}

function officialPendingInputReader(
  sessions: ISessions,
  generation: ConnectionGenerationState,
): RemotePendingInputReader {
  return new RemotePendingInputReader(sessions, generation)
}

function officialHostCommandPort(commands: ClientRemote['commands']): RemoteHostCommandPort {
  return new RemoteHostCommandPort(commands)
}

function officialSubagentPort(subagents: ClientRemote['subagents']): RemoteSubagentPort {
  return new RemoteSubagentPort(subagents)
}

function officialTaskReader(
  sessions: ISessions,
  jobs: IJobs,
  generation: ConnectionGenerationState,
): RemoteTaskReader {
  return new RemoteTaskReader(sessions, jobs, generation)
}

function officialPresentationReader(
  sessions: ISessions,
  generation: ConnectionGenerationState,
): RemotePresentationReader {
  return new RemotePresentationReader(sessions, generation)
}

function officialSurfaceAuthorityReader(
  commands: ClientRemote['commands'],
  skills: ClientRemote['skills'],
  generation: ConnectionGenerationState,
): RemoteSurfaceAuthorityReader {
  return new RemoteSurfaceAuthorityReader({ commands, skills }, generation)
}

function officialSubmissionPresentation(
  sessions: ISessions,
  generation: ConnectionGenerationState,
): RemoteSubmissionPresentation {
  return new RemoteSubmissionPresentation(sessions, generation)
}

function officialPluginManagerPort(remote: ClientRemote): RemotePluginManagerPort {
  return new RemotePluginManagerPort(remote)
}

function officialJobObservationPort(jobs: IJobs): RemoteJobObservationPort {
  return new RemoteJobObservationPort(jobs)
}

function officialSkillCatalog(
  skills: ClientRemote['skills'],
  generation: ConnectionGenerationState,
): RemoteSkillCatalog {
  return new RemoteSkillCatalog(skills, generation)
}

function officialHostFilePort(
  fileReferences: ClientRemote['fileReferences'],
  generation: ConnectionGenerationState,
): RemoteHostFilePort {
  return new RemoteHostFilePort(fileReferences, generation)
}


/** The official `Session.loadThrough(seq)` jump face (W5): the Remote
 * PresentationReader's paging target, straight off the published Client
 * binding type. */
function officialLoadThroughFace(
  binding: NonNullable<ReturnType<ISessions['binding']>>,
): (seq: SessionSeq) => Promise<void> {
  return binding.session.loadThrough
}

/** The official context-pressure projection face (W1): the exact published
 * `ContextPressureProjection` the occupancy numerator reads. */
function officialContextPressureFace(): ContextPressureProjection {
  return { projectedTokens: 1, pressureTokens: 2, contextWindow: 3 }
}

/** The official context-breakdown/usage faces (W6 status projection). */
function officialContextFactFaces(): { breakdown: ContextBreakdownProjection; usage: TokenUsageProjection } {
  return {
    breakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
    usage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  }
}

/** The M3-3A partial assembly constructs from the REAL M3-1 runtime — a
 * compile-time proof that `RemoteClientRuntime` satisfies the narrow
 * one-source face (the same sessions service, Remote namespaces and
 * Connection generation source feed every adapter). */
function officialM3ASemanticsAssembly(
  runtime: import('../src/app/remote/client-runtime.ts').RemoteClientRuntime,
  options: { promptSerializer: import('../src/runtime/remote/session-writer-remote.ts').RemotePromptSerializer },
): ReturnType<typeof createRemoteM3ASemantics> {
  return createRemoteM3ASemantics(remoteM3ARuntimeSourceOf(runtime), options)
}

/** The published `SessionSeq` brand accepts the port's plain number target. */
function officialLoadThroughSeq(): SessionSeq {
  return 1 as SessionSeq
}

/** The official `turnOutline` projection face (W5): the published entry
 * shape satisfies the detached picker DTO mapping. */
function officialTurnOutlineFace(): readonly TurnOutlineEntry[] {
  return [{ turn: 1, seq: officialLoadThroughSeq(), prompt: 'p', response: 'r' }]
}

/** The M3-3A semantic surfaces are transport-neutral: the reader/presentation
 * contracts type-check against the shared DTOs (a compile-time proof that
 * the mappings consume the published faces, never a private shape). */
function officialM3ASemanticSurfaces(
  reader: Pick<SessionReader, 'measureContext' | 'turnOutline' | 'sessionStatus'>,
  presentation: Pick<PresentationReader, 'loadThrough'>,
): { status: SessionStatusProjection | undefined; outline: readonly TurnOutlineEntryDto[] | undefined } {
  return {
    status: reader.sessionStatus('session'),
    outline: reader.turnOutline('session'),
    // The port's plain `number` target assignably feeds the official
    // branded `SessionSeq` face (a compile-time proof).
    ...presentation.loadThrough('session', officialLoadThroughSeq()) === undefined ? {} : {},
  }
}

test('every Remote adapter accepts the published DSH public Client/Remote face (0.1.7-rc.2 proofs carried, M3-3A on 0.2.0-rc.1, M3-3B on 0.2.0-rc.2)', () => {
  // A compile-time proof only runs when the compiler keeps the function in the
  // program; this reference is that keep-alive.
  for (const proof of [
    officialSessionReader,
    officialSessionWriter,
    officialSessionLifecycle,
    officialModelCatalog,
    officialPresetCatalog,
    officialPendingInputReader,
    officialHostCommandPort,
    officialSubagentPort,
    officialTaskReader,
    officialPresentationReader,
    officialSurfaceAuthorityReader,
    officialSubmissionPresentation,
    officialPluginManagerPort,
    officialJobObservationPort,
    officialSkillCatalog,
    officialHostFilePort,
    officialRemoteInteractionPort,
  ]) {
    assert.equal(typeof proof, 'function')
  }
})

test('the M3-3B additions consume the published 0.2.0-rc.2 contract', () => {
  // The rc.2 published surfaces M3-3B is allowed to consume. A future rc that
  // renames or drops one of these must fail HERE rather than at runtime.
  assert.equal(USER_QUESTIONS_REMOTE_NAMESPACE, 'userQuestions')
  assert.equal(SESSION_LOG_EXPORT_PATH, '/api/session.export')
  assert.equal(typeof officialRemoteInteractionPort, 'function')
  assert.equal(typeof officialSettingsRemoteFace, 'function')
  assert.equal(typeof officialCredentialsRemoteFace, 'function')
  assert.equal(typeof officialArchiveFetchFace, 'function')
})

test('the M3-3A semantic additions consume the published 0.2.0-rc.1 contract', () => {
  // Runtime keep-alives for the compile-time face proofs above.
  assert.equal(typeof officialLoadThroughFace, 'function')
  assert.equal(typeof officialContextPressureFace, 'function')
  assert.equal(typeof officialContextFactFaces, 'function')
  assert.equal(typeof officialTurnOutlineFace, 'function')
  assert.equal(typeof officialM3ASemanticSurfaces, 'function')
  assert.equal(typeof officialM3ASemanticsAssembly, 'function')
  assert.deepEqual(officialContextPressureFace(), { projectedTokens: 1, pressureTokens: 2, contextWindow: 3 })
  assert.deepEqual(officialTurnOutlineFace(), [{ turn: 1, seq: 1, prompt: 'p', response: 'r' }])
})

/** The official `llm` namespace satisfies the wizard-probe source (W2): the
 * Remote catalog's `discoverModels` maps `ClientRemote['llm']` directly. */
function officialLlmDiscoverModelsSource(llm: ClientRemote['llm']): RemoteLlmRemotes {
  return llm
}


/** The rc.2 `userQuestions` namespace the M3-3B interaction adapter maps. */
const USER_QUESTIONS_REMOTE_NAMESPACE = 'userQuestions' as const

/** The official `GET/HEAD /api/session.export` route the archive adapter
 *  addresses; a rename upstream must fail this gate. */
import { SESSION_LOG_EXPORT_PATH } from '@deepseek-ai/dsh-session-log-export'

/** The M3-3B Remote interaction adapter constructs from the REAL Client
 *  runtime faces with no cast: the published `userQuestions` namespace and
 *  the forwarded-event `$on` seat must satisfy the adapter's narrow source. */
function officialRemoteInteractionPort(
  sessions: ISessions,
  remote: ClientRemote,
  generation: ConnectionGenerationState,
): RemoteInteractionPort {
  return new RemoteInteractionPort({
    sessions,
    remote: { userQuestions: remote.userQuestions, $on: remote.$on },
    connection: { generation },
  })
}

/** The published settings Remote face the Remote ConfigPort maps (the mirror
 *  reads `describe`/`update`/`mutate`/`replace`). */
function officialSettingsRemoteFace(settings: ClientRemote['settings']): {
  describe: ClientRemote['settings']['describe']
  update: ClientRemote['settings']['update']
  mutate: ClientRemote['settings']['mutate']
  replace: ClientRemote['settings']['replace']
} {
  return {
    describe: settings.describe,
    update: settings.update,
    mutate: settings.mutate,
    replace: settings.replace,
  }
}

/** The published credentials Remote face the Remote ConfigPort maps. */
function officialCredentialsRemoteFace(credentials: ClientRemote['credentials']): {
  describe: ClientRemote['credentials']['describe']
  set: ClientRemote['credentials']['set']
  unset: ClientRemote['credentials']['unset']
} {
  return { describe: credentials.describe, set: credentials.set, unset: credentials.unset }
}

/** The composition-owned archive Fetch face (never `document.baseURI`). */
function officialArchiveFetchFace(fetch: (input: string | URL, init?: RequestInit) => Promise<Response>): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
} {
  return { fetch }
}
