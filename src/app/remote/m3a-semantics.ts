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
import type { RemoteConnectionGenerationSource, RemoteSessionsReadSource } from '../../runtime/remote/session-reader-remote.ts'
import type { PiTuiSkillsRemotes } from '../../runtime/remote/skill-remote.ts'
import type { RemoteLlmRemotes, RemoteModelRemotes, RemoteModelSessionsSource } from '../../runtime/remote/model-remote.ts'
import type { RemotePendingSessionsSource } from '../../runtime/remote/pending-input-reader-remote.ts'
import type { RemoteWriteSessionsSource } from '../../runtime/remote/session-writer-remote.ts'
import type { RemoteSerializerSessionsSource } from '../../runtime/remote/prompt-serializer-remote.ts'
import type { RemoteLifecycleSessions, RemoteWorkspaceNamespaceLike } from '../../runtime/remote/session-lifecycle-remote.ts'
import type { RemoteSubagentSource } from '../../runtime/remote/subagent-remote.ts'
import type { RemotePresetRemotes } from '../../runtime/remote/preset-remote.ts'
import type { RemoteSkillRemotes } from '../../runtime/remote/skill-remote.ts'
import type { RemotePiTuiFileReferenceRemotes } from '../../runtime/remote/host-file-remote.ts'
import type { RemoteCommandsSource } from '../../runtime/remote/host-command-remote.ts'
import type { RemoteFileReceiptUploader } from '../../runtime/remote/file-upload-remote.ts'
import type { RemoteConfigRuntimeSource } from '../../runtime/remote/config-remote.ts'
import type { RemotePresentationSessionsSource } from '../../runtime/remote/presentation-read-remote.ts'
import type {
  RemoteInteractionRuntimeSource,
  SplitClientInteractionDelivery,
} from '../../runtime/remote/interaction-remote.ts'
import { RemoteInteractionPort } from '../../runtime/remote/interaction-remote.ts'
import type { RemotePluginManagerSource } from '../../runtime/remote/plugin-manager-remote.ts'
import { RemotePluginManagerPort } from '../../runtime/remote/plugin-manager-remote.ts'
import { RemoteDeliveredFileReadPort } from '../../runtime/remote/deliverables-remote.ts'
import type { RemoteWorkspaceFilesNamespace } from '../../runtime/remote/deliverables-remote.ts'
import type { SessionWorkspaceFactsPort } from '../../runtime/session-workspace-facts-port.ts'
import { RemoteSessionWorkspaceFacts, type RemoteSessionFactsRemotes } from '../../runtime/remote/session-workspace-facts-remote.ts'
import type { RemoteWebAccessNamespace } from '../../runtime/remote/web-access-remote.ts'
import type { PiTuiHostUserShellNamespace } from '../../runtime/remote/pi-tui-host-user-shell-contract.ts'
import type { PiTuiAuthorizationNamespace } from '../../runtime/remote/pi-tui-authorization-contract.ts'
import type { PiTuiCredentialRecordsNamespace } from '../../runtime/remote/pi-tui-credential-records-contract.ts'
import type { PiTuiSessionPolicyNamespace } from '../../runtime/remote/pi-tui-session-policy-contract.ts'
import type { PiTuiDefaultModelNamespace } from '../../runtime/remote/pi-tui-default-model-contract.ts'
import {
  RemoteSchedulePort,
  type RemoteScheduleEvents,
  type RemoteScheduleNamespace,
} from '../../runtime/remote/schedule-remote.ts'
import type { RemoteJobObservationSource } from '../../runtime/remote/job-observation-remote.ts'
import { RemoteJobObservationPort } from '../../runtime/remote/job-observation-remote.ts'
import type { PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import type { JobObservationPort } from '../../runtime/job-observation-port.ts'
import type { DeliveredFileReadPort } from '../../runtime/deliverables-port.ts'
import type { SchedulePort } from '../../runtime/schedule-port.ts'
import type { HostDirectoryBrowsePort } from '../../runtime/host-directory-browse-port.ts'
import { RemoteHostDirectoryBrowsePort } from '../../runtime/remote/host-directory-browse-remote.ts'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
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
  /** The delivered-file READ port (Delivered files PR2): the generated
   *  `workspaceFiles` namespace, generation-fenced. */
  readonly deliveredFileRead: DeliveredFileReadPort
  /** The UI-neutral read-authority port (M5-U-A): passive Session activity
   *  facts and the official Workspace follow stream. Read-only. */
  readonly sessionWorkspaceFacts: SessionWorkspaceFactsPort
  /** The Host Schedule management port (S5-PR4): the official generated
   *  `schedule` namespace over the SAME authenticated Connection. */
  readonly schedule: SchedulePort
  /** The Host directory-browse read port (Session Workspace PR1): the SAME
   *  generated `directoryPicker` namespace, generation-fenced. Read-only. */
  readonly hostDirectoryBrowse: HostDirectoryBrowsePort
  /** Drop adapter-owned caches/subscriptions. Runs BEFORE the Client
   *  Context disposal (`RemoteClientRuntime.dispose()`). */
  dispose(): void
}

/** Assembly inputs beyond the shared runtime: the application-owned prompt
 * serializer (the D2.2 submission-path dependency the writer consumes) and the
 * optional composition-owned pre-dispatch dispatch admission (closed
 * synchronously at the surface-stop boundary). */
export interface RemoteM3ASemanticsOptions {
  readonly promptSerializer: RemotePromptSerializer
  /** The ONE composition-owned receipt uploader the Host command port reuses
   *  for its official staged file receipts (never a second transport). */
  readonly fileReceiptUploader: RemoteFileReceiptUploader
  readonly isDispatchAllowed?: () => boolean
  readonly signal?: AbortSignal
  /** Split-Client only: borrow the root delivery instead of per-revision `$on`. */
  readonly delivery?: SplitClientInteractionDelivery
  /** Split-Client only: the surface revision token attached to `delivery`. */
  readonly surfaceRevision?: number
  /** Qualification-only telemetry forwarded to the Remote interaction port. */
  readonly onQualification?: (record: Record<string, unknown>) => void
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
  // The production prompt serializer reads recalled attachment bytes through
  // the exact retained binding on this SAME sessions service.
  & RemoteSerializerSessionsSource

/** The NARROW one-source runtime face the assembly consumes — exactly what
 * the official Client runtime provides (the official-contract gate proves
 * that assignability; tests construct small structural stand-ins). */
export interface RemoteM3ARuntimeSource {
  /** The ONE shared Client sessions service. */
  readonly sessions: RemoteM3ASessionsSource
  /** The ONE shared generated Remote namespaces the M3-3A adapters map. */
  readonly remote: {
    readonly session: RemoteModelRemotes & RemoteSessionFactsRemotes['session']
    /** The official generated `llm` namespaces (discovery + the configurable-provider directory the ConfigPort reads from this SAME service). */
    readonly llm: RemoteLlmRemotes & RemoteConfigRuntimeSource['remote']['llm']
    readonly agentPresets: RemotePresetRemotes
    readonly skills: RemoteSkillRemotes
    /** The private Host Workspace standing catalog and invalidation stream. */
    readonly piTuiSkills: PiTuiSkillsRemotes
    /** The PRIVATE pi-tui Host augmentation namespace (TS8-HF1): the Session
     *  `@` source. The official `fileReferences` namespace stays mounted but is
     *  consumed only by the Host-side bare-query delegation. */
    readonly piTuiFileReferences: RemotePiTuiFileReferenceRemotes
    readonly piTuiHostUserShell: PiTuiHostUserShellNamespace
    /** The PRIVATE `piTuiAuthorization` namespace (M6-1 F7A): provider-native
     *  sign-in attempts and the official roster. The SAME mounted contribution
     *  publishes it; the Remote ConfigPort is its only consumer. */
    readonly piTuiAuthorization: PiTuiAuthorizationNamespace
    /** The PRIVATE `piTuiCredentialRecords` namespace (M6-1 F7B): metadata-only
     *  enumeration and exact-key deletion of the official stored credential
     *  records. The SAME mounted contribution publishes it; the Remote
     *  ConfigPort's credential adapter is its only consumer. */
    readonly piTuiCredentialRecords?: PiTuiCredentialRecordsNamespace
    /** The PRIVATE `piTuiSessionPolicy` namespace (M6-1 F8): the exact-Session
     *  approval/sandbox policy facts and the single approval write. The SAME
     *  mounted contribution publishes it; the Remote session-policy port is
     *  its only consumer. */
    readonly piTuiSessionPolicy: PiTuiSessionPolicyNamespace
    /** The PRIVATE `piTuiDefaultModel` namespace (M6): the sessionless default
     *  model write delegated to the official `agentDefaultModel.saveSelection`.
     *  The SAME mounted contribution publishes it; the Remote model catalog is
     *  its only consumer. */
    readonly piTuiDefaultModel: PiTuiDefaultModelNamespace
    /** The PRIVATE `piTuiWebAccess` namespace (M5-W PR-C): the Split-Client
     *  Web frontend control (`/web`). The SAME mounted contribution publishes
     *  it; `/web` is its only consumer. */
    readonly piTuiWebAccess: RemoteWebAccessNamespace
    readonly commands: RemoteCommandsSource
    readonly subagents: RemoteSubagentSource
    /** The rc.2 generated `userQuestions` namespace + the forwarded
     *  interaction-event source (M3-3B). */
    readonly userQuestions: RemoteInteractionRuntimeSource['remote']['userQuestions']
    /** The Plugin Manager namespace + its forwarded install events. */
    readonly pluginManager: RemotePluginManagerSource['pluginManager']
    /** The official generated `workspaceFiles` namespace (Delivered files
     *  PR2): bounded Host file reads for the preview. */
    readonly workspaceFiles: RemoteWorkspaceFilesNamespace | undefined
    /** The official generated `workspace` namespace (WS-1): the Host Workspace
     *  Controller's Remote face. The SAME Client Domain mounts it and the
     *  lifecycle adopts it as the one pre-selection authority — never a second
     *  Client, store or cached Workspace list. */
    readonly workspace: RemoteWorkspaceNamespaceLike
    /** The official generated `directoryPicker` namespace (Session Workspace
     *  PR1): the SAME Workspace Controller's child Host handler. Host home,
     *  paths, hidden flags and truncation stay Host facts. */
    readonly directoryPicker: ClientRemote['directoryPicker']
    /** The official generated `schedule` namespace (S5-PR4): the Host Schedule
     *  domain's management face. Absent until the installed contribution is
     *  mounted, so the port answers the ONE truthful unavailable error. */
    readonly schedule: RemoteScheduleNamespace | undefined
    /** The official generated config-plane namespaces (the SAME Client
     *  Remote service): settings, credentials and permission presets. The
     *  M3-3A adapters ignore them; the Remote Backend's ConfigPort reads them
     *  from this SAME source (no second Client Remote object). */
    readonly settings: RemoteConfigRuntimeSource['remote']['settings']
    readonly credentials: RemoteConfigRuntimeSource['remote']['credentials']
    readonly account?: RemoteConfigRuntimeSource['remote']['account']
    readonly permissionPresets: RemoteConfigRuntimeSource['remote']['permissionPresets']
    /** The forwarded-event seat shared by every adapter: the intersection of
     *  the event declarations each one subscribes to (the real generated
     *  `$on` is one generic method and satisfies the whole intersection). */
    readonly $on: RemoteInteractionRuntimeSource['remote']['$on']
      & RemotePluginManagerSource['$on']
      & RemoteConfigRuntimeSource['remote']['$on']
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
export function remoteM3ARuntimeSourceOf(runtime: RemoteM3ARuntimeSource): RemoteM3ARuntimeSource {
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
    RemoteInteractionRuntimeSource['remote']['$on']
      & RemotePluginManagerSource['$on']
  const modelCatalog = new RemoteModelCatalog(remote.session, sessions, generation, remote.llm, remote.piTuiDefaultModel)
  const interaction = new RemoteInteractionPort({
    sessions,
    remote: { userQuestions: remote.userQuestions, $on: forwardedEvents },
    connection: { generation },
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    ...(options.surfaceRevision === undefined ? {} : { surfaceRevision: options.surfaceRevision }),
    ...(options.onQualification === undefined ? {} : { onQualification: options.onQualification }),
  })
  const presetCatalog = new RemotePresetCatalog(remote.agentPresets, generation)
  let disposed = false
  return {
    sessionReader: new RemoteSessionReader(sessions, generation),
    pendingInputReader: new RemotePendingInputReader(sessions, generation),
    sessionWriter: new RemoteSessionWriter(
      sessions,
      generation,
      options.promptSerializer,
      options.isDispatchAllowed === undefined ? undefined : { isDispatchAllowed: options.isDispatchAllowed },
      options.signal,
    ),
    // The ONE Client Remote's official `session` namespace also carries the
    // fail-closed Session-list read the historical header fallback needs.
    sessionLifecycle: new RemoteSessionLifecycle(sessions, generation, remote.workspace, remote.session),
    subagent: new RemoteSubagentPort(remote.subagents),
    catalog: {
      models: modelCatalog,
      presets: presetCatalog,
      skills: new RemoteSkillCatalog(remote.skills, remote.piTuiSkills, generation),
    },
    hostFile: new RemoteHostFilePort(remote.piTuiFileReferences, generation),
    hostCommand: new RemoteHostCommandPort(remote.commands, options.fileReceiptUploader),
    presentationReader: new RemotePresentationReader(sessions, generation),
    interaction,
    pluginManager: new RemotePluginManagerPort(
      { pluginManager: remote.pluginManager, $on: forwardedEvents },
      generation,
    ),
    jobObservation: new RemoteJobObservationPort(runtime.jobs),
    deliveredFileRead: new RemoteDeliveredFileReadPort(remote.workspaceFiles, generation),
    // M5-U-A: passive `session.state`/`session.projections` reads over the SAME
    // generated namespace and the official `workspace.follow` stream. No second
    // Client/Remote, no retain, no writer.
    sessionWorkspaceFacts: new RemoteSessionWorkspaceFacts({
      sessions,
      remote: { session: remote.session, workspace: remote.workspace },
      connection: { generation },
    }),
    // S5-PR4: the official generated `schedule` namespace over the SAME
    // Client Remote and the SAME Connection generation; a missing namespace is
    // a truthful unavailable, never a Direct fallback.
    // The forwarded-event seat is the SAME method-bound `$on`; `schedule/changed`
    // is part of the installed rc.1 forwarded-event allowlist (the
    // schedule-remote contract test proves that from the installed package), so
    // the narrow schedule face is a typed view of THIS one method.
    schedule: new RemoteSchedulePort(
      remote.schedule,
      forwardedEvents as unknown as RemoteScheduleEvents,
      generation,
    ),
    // Session Workspace PR1: the SAME generated namespace the official Web
    // Workspace UI reads (`UiWorkspace.listDirectory`), over the SAME
    // Connection generation. No second Remote, no private RPC.
    hostDirectoryBrowse: new RemoteHostDirectoryBrowsePort(remote.directoryPicker, generation),
    dispose(): void {
      if (disposed) return
      disposed = true
      // Adapter-owned caches and subscriptions ahead of the Client Context
      // disposal (the frozen adapter-disposal order).
      modelCatalog.disposeCache()
      presetCatalog.disposeCache()
      interaction.dispose()
    },
  }
}
