/**
 * M3-3A partial Remote semantic assembly: every M3-3A-closed adapter
 * constructed from ONE M3-1 `RemoteClientRuntime`.
 *
 * This is deliberately NOT a `Backend`: interaction/config/sessionArchive
 * still belong to M3-3B, so the bundle exposes only the closed semantic
 * surfaces and no backend selector, no `BackendKind` change, and no
 * production wiring consumes it yet. The M3-2 owner services
 * (`createRemoteSessionOwnerServices`) stay their own owner — never
 * duplicated here.
 *
 * One-source wiring (plan §14): all adapters share the SAME
 * `RemoteClientRuntime.sessions`, `remote`, Connection generation source and
 * Client `Context`. No feature-owned Context, no second Connection, no new
 * Gateway, no second sessions service. Disposal order is adapter
 * subscriptions/caches → Client Context (`runtime.dispose()`), so
 * `dispose()` here must run BEFORE the runtime's own disposal.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/m3a-semantics
 */

import type { Catalog } from '../../runtime/catalog-port.ts'
import type { HostCommandPort } from '../../runtime/host-command-port.ts'
import type { HostFilePort } from '../../runtime/host-file-port.ts'
import type { PendingInputReader } from '../../runtime/pending-input-reader-port.ts'
import type { PresentationReader } from '../../runtime/presentation-read-port.ts'
import type { SessionLifecycle } from '../../runtime/session-lifecycle-port.ts'
import type { SessionReader } from '../../runtime/session-reader-port.ts'
import type { SessionWriter } from '../../runtime/session-writer-port.ts'
import type { SubagentPort } from '../../runtime/subagent-port.ts'
import type { RemoteClientRuntime } from './client-runtime.ts'
import type { RemoteConnectionGenerationSource, RemoteSessionsReadSource } from '../../runtime/remote/session-reader-remote.ts'
import type { RemoteLlmRemotes, RemoteModelRemotes, RemoteModelSessionsSource } from '../../runtime/remote/model-remote.ts'
import type { RemotePendingSessionsSource } from '../../runtime/remote/pending-input-reader-remote.ts'
import type { RemoteWriteSessionsSource } from '../../runtime/remote/session-writer-remote.ts'
import type { RemoteLifecycleSessions, RemoteLifecycleSessionRemotes } from '../../runtime/remote/session-lifecycle-remote.ts'
import type { RemoteSubagentSource } from '../../runtime/remote/subagent-remote.ts'
import type { RemotePresetRemotes } from '../../runtime/remote/preset-remote.ts'
import type { RemoteSkillRemotes } from '../../runtime/remote/skill-remote.ts'
import type { RemoteHostFileRemotes } from '../../runtime/remote/host-file-remote.ts'
import type { RemoteCommandsSource } from '../../runtime/remote/host-command-remote.ts'
import type { RemotePresentationSessionsSource } from '../../runtime/remote/presentation-read-remote.ts'
import type { RemoteInteractionRuntimeSource } from '../../runtime/remote/interaction-remote.ts'
import { RemoteInteractionPort } from '../../runtime/remote/interaction-remote.ts'
import type { RemotePluginManagerSource } from '../../runtime/remote/plugin-manager-remote.ts'
import { RemotePluginManagerPort } from '../../runtime/remote/plugin-manager-remote.ts'
import type { RemoteJobObservationSource } from '../../runtime/remote/job-observation-remote.ts'
import { RemoteJobObservationPort } from '../../runtime/remote/job-observation-remote.ts'
import type { PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import type { JobObservationPort } from '../../runtime/job-observation-port.ts'
import type { InteractionPort } from '../../runtime/interaction-port.ts'
import { RemoteSessionReader } from '../../runtime/remote/session-reader-remote.ts'
import { RemotePendingInputReader } from '../../runtime/remote/pending-input-reader-remote.ts'
import { RemoteSessionWriter, type RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { RemoteSessionLifecycle } from '../../runtime/remote/session-lifecycle-remote.ts'
import { RemoteSubagentPort } from '../../runtime/remote/subagent-remote.ts'
import { RemoteModelCatalog } from '../../runtime/remote/model-remote.ts'
import { RemotePresetCatalog } from '../../runtime/remote/preset-remote.ts'
import { RemoteSkillCatalog } from '../../runtime/remote/skill-remote.ts'
import { RemoteHostFilePort } from '../../runtime/remote/host-file-remote.ts'
import { RemoteHostCommandPort } from '../../runtime/remote/host-command-remote.ts'
import { RemotePresentationReader } from '../../runtime/remote/presentation-read-remote.ts'

/** The M3-3A-closed semantic bundle (NOT a complete `Backend`). */
export interface RemoteM3ASemantics {
  readonly sessionReader: SessionReader
  readonly pendingInputReader: PendingInputReader
  readonly sessionWriter: SessionWriter
  readonly sessionLifecycle: SessionLifecycle
  readonly subagent: SubagentPort
  readonly catalog: Catalog
  readonly hostFile: HostFilePort
  readonly hostCommand: HostCommandPort
  readonly presentationReader: PresentationReader
  /** The interaction domain port (M3-3B): the forwarded approval waterfall,
   *  the rc.2 Question contract (timed claim, late answer, durable surface,
   *  queued-reply fact) and the explicitly unsupported approval-policy write. */
  readonly interaction: InteractionPort
  /** The Plugin Manager port (P1-A): the already-proven Remote adapter. */
  readonly pluginManager: PluginManagerPort
  /** The selected-Job observation port (P1-B): the already-proven Remote
   *  adapter over the shared `IJobs` service. */
  readonly jobObservation: JobObservationPort
  /** Drop adapter-owned caches/subscriptions. Runs BEFORE the Client
   *  Context disposal (`RemoteClientRuntime.dispose()`). */
  dispose(): void
}

/** Assembly inputs beyond the shared runtime: the application-owned prompt
 * serializer (the D2.2 submission-path dependency the writer consumes). */
export interface RemoteM3ASemanticsOptions {
  readonly promptSerializer: RemotePromptSerializer
}

/** The ONE shared Client sessions service: the intersection of every
 * adapter's structural sessions face (each is a subset of the official
 * `ISessions`, so the real runtime satisfies the whole intersection). */
export type RemoteM3ASessionsSource = RemoteSessionsReadSource
  & RemotePendingSessionsSource
  & RemoteWriteSessionsSource
  & RemoteLifecycleSessions
  & RemoteModelSessionsSource
  & RemotePresentationSessionsSource
  & RemoteInteractionRuntimeSource['sessions']

/** The NARROW one-source runtime face the assembly consumes — exactly what
 * `RemoteClientRuntime` provides (the official-contract gate proves that
 * assignability; tests construct small structural stand-ins). */
export interface RemoteM3ARuntimeSource {
  /** The ONE shared Client sessions service. */
  readonly sessions: RemoteM3ASessionsSource
  /** The ONE shared generated Remote namespaces the M3-3A adapters map. */
  readonly remote: {
    readonly session: RemoteModelRemotes & RemoteLifecycleSessionRemotes
    readonly llm: RemoteLlmRemotes
    readonly agentPresets: RemotePresetRemotes
    readonly skills: RemoteSkillRemotes
    readonly fileReferences: RemoteHostFileRemotes
    readonly commands: RemoteCommandsSource
    readonly subagents: RemoteSubagentSource
    /** The rc.2 generated `userQuestions` namespace + the forwarded
     *  interaction-event source (M3-3B). */
    readonly userQuestions: RemoteInteractionRuntimeSource['remote']['userQuestions']
    /** The Plugin Manager namespace + its forwarded install events. */
    readonly pluginManager: RemotePluginManagerSource['pluginManager']
    /** The forwarded-event seat shared by every adapter: the intersection of
     *  the event declarations each one subscribes to (the real generated
     *  `$on` is one generic method and satisfies the whole intersection). */
    readonly $on: RemoteInteractionRuntimeSource['remote']['$on'] & RemotePluginManagerSource['$on']
  }
  /** The ONE shared Client jobs service (the Job observation adapter). */
  readonly jobs: RemoteJobObservationSource
  /** The ONE shared Connection generation source. */
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
}

/**
 * Assemble every M3-3A adapter over ONE M3-1 Client runtime. The runtime's
 * `sessions`, `remote` namespaces and Connection generation source are the
 * single sources every adapter shares; constructing a second runtime for
 * another adapter is the wiring error this owner exists to prevent.
 */
/** Compile-time proof that the real M3-1 runtime satisfies the narrow
 *  one-source face (never called; referenced by the official-contract gate). */
export function remoteM3ARuntimeSourceOf(runtime: RemoteClientRuntime): RemoteM3ARuntimeSource {
  return runtime
}

export function createRemoteM3ASemantics(
  runtime: RemoteM3ARuntimeSource,
  options: RemoteM3ASemanticsOptions,
): RemoteM3ASemantics {
  const sessions = runtime.sessions
  const remote = runtime.remote
  const generation = runtime.connection.generation
  // The forwarded-event seat is kept METHOD-BOUND: the Client `$on` reads its
  // own service state, so passing the bare reference would lose `this` (the
  // P11 same-Host wire smoke caught exactly that). The cast only restores the
  // overload set of the two per-adapter event declarations.
  const forwardedEvents = remote.$on.bind(remote) as unknown as
    RemoteInteractionRuntimeSource['remote']['$on'] & RemotePluginManagerSource['$on']
  const modelCatalog = new RemoteModelCatalog(remote.session, sessions, generation, remote.llm)
  const presetCatalog = new RemotePresetCatalog(remote.agentPresets, generation)
  let disposed = false
  return {
    sessionReader: new RemoteSessionReader(sessions, generation),
    pendingInputReader: new RemotePendingInputReader(sessions, generation),
    sessionWriter: new RemoteSessionWriter(sessions, generation, options.promptSerializer),
    sessionLifecycle: new RemoteSessionLifecycle(sessions, remote.session, generation),
    subagent: new RemoteSubagentPort(remote.subagents),
    catalog: {
      models: modelCatalog,
      presets: presetCatalog,
      skills: new RemoteSkillCatalog(remote.skills, generation),
    },
    hostFile: new RemoteHostFilePort(remote.fileReferences, generation),
    hostCommand: new RemoteHostCommandPort(remote.commands),
    presentationReader: new RemotePresentationReader(sessions, generation),
    interaction: new RemoteInteractionPort({
      sessions,
      remote: { userQuestions: remote.userQuestions, $on: forwardedEvents },
      connection: { generation },
    }),
    pluginManager: new RemotePluginManagerPort({ pluginManager: remote.pluginManager, $on: forwardedEvents }),
    jobObservation: new RemoteJobObservationPort(runtime.jobs),
    dispose(): void {
      if (disposed) return
      disposed = true
      // Adapter-owned caches ahead of the Client Context disposal. Neither
      // catalog adapter holds a subscription today; keeping the seam exact
      // documents the frozen ordering for the adapters that will.
      modelCatalog.disposeCache()
      presetCatalog.disposeCache()
    },
  }
}
