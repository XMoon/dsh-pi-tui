/**
 * The experimental Remote `Backend` assembly (M3-3B): ONE `Backend` whose
 * every capability is served by an already-proven official Remote/Client
 * adapter. It has no Direct fallback, no second Connection, no second
 * semantics — it is the same `Backend` contract the Direct backend serves.
 *
 * `kind: 'remote'` exists so composition/tests can distinguish the transport.
 * It is NOT a production cutover: normal startup still selects Direct
 * (`runtime/backend-loader.ts` dynamically imports the Remote graph only on
 * the explicit experimental path), and M3-4 owns the main-application
 * selection.
 *
 * Capability advertisement is EXACT (the current Remote composition's
 * unsupported set + docs/architecture/host-client.md): the set is declared in
 * `REMOTE_IMPLEMENTED_CAPABILITIES`, and a capability is advertised only when
 * its port genuinely serves the semantic contract — never to mask a
 * misleading empty/default value.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/backend-remote
 */

import type { Backend } from '../backend.ts'
import { REMOTE_IMPLEMENTED_CAPABILITIES } from '../capability.ts'
import type { SubagentPort } from '../subagent-port.ts'
import type { SessionReader } from '../session-reader-port.ts'
import type { PendingInputReader } from '../pending-input-reader-port.ts'
import type { SessionWriter } from '../session-writer-port.ts'
import type { SessionLifecycle } from '../session-lifecycle-port.ts'
import type { InteractionPort } from '../interaction-port.ts'
import type { Catalog } from '../catalog-port.ts'
import type { ConfigPort } from '../config-port.ts'
import type { HostFilePort } from '../host-file-port.ts'
import type { SessionArchivePort } from '../session-archive-port.ts'
import type { SessionMarkdownPort } from '../session-markdown-port.ts'
import type { HostCommandPort } from '../host-command-port.ts'
import type { PluginManagerPort } from '../plugin-manager-port.ts'
import type { JobObservationPort } from '../job-observation-port.ts'
import type { HostUserShellPort } from '../host-user-shell-port.ts'
import type { HostShellCompletionPort } from '../host-shell-completion-port.ts'
import type { DeliveredFileReadPort } from '../deliverables-port.ts'
import type { WebAccessPort } from '../web-access-port.ts'
import type { SessionWorkspaceFactsPort } from '../session-workspace-facts-port.ts'
import type { SchedulePort } from '../schedule-port.ts'
import type { HostDirectoryBrowsePort } from '../host-directory-browse-port.ts'
import type { SessionPolicyPort } from '../session-policy-port.ts'

/** Every semantic port the Remote backend serves (one adapter each). */
export interface RemoteBackendParts {
  /** The Host-owned one-shot shell adapter over the authenticated private stream. */
  readonly hostUserShell: HostUserShellPort
  readonly hostShellCompletion: HostShellCompletionPort
  readonly subagent: SubagentPort
  readonly sessionReader: SessionReader
  readonly pendingInputReader: PendingInputReader
  readonly sessionWriter: SessionWriter
  readonly sessionLifecycle: SessionLifecycle
  readonly interaction: InteractionPort
  readonly catalog: Catalog
  readonly config: ConfigPort
  readonly hostFile: HostFilePort
  readonly sessionArchive: SessionArchivePort
  /** The official authenticated Session Markdown read adapter (S5-PR3). */
  readonly sessionMarkdown: SessionMarkdownPort
  readonly hostCommand: HostCommandPort
  readonly pluginManager: PluginManagerPort
  readonly jobObservation: JobObservationPort
  /** The official generated `workspaceFiles` read adapter (Delivered files PR2). */
  readonly deliveredFileRead: DeliveredFileReadPort
  /** The private `piTuiWebAccess` control adapter (M5-W PR-C). */
  readonly webAccess: WebAccessPort
  /** The Remote read-authority adapter (M5-U-A). */
  readonly sessionWorkspaceFacts: SessionWorkspaceFactsPort
  /** The official generated `schedule` namespace adapter (S5-PR4). */
  readonly schedule: SchedulePort
  /** The official generated `directoryPicker` read adapter (Session Workspace PR1). */
  readonly hostDirectoryBrowse: HostDirectoryBrowsePort
  /** The private `piTuiSessionPolicy` adapter (M6-1 F8): the exact-Session
   *  approval/sandbox facts and the single approval write, generation-fenced
   *  and bracketed by the SHARED accepted-write lifetime. */
  readonly sessionPolicy: SessionPolicyPort
}

/** Assemble the experimental Remote `Backend` from its proven adapters. */
export function createRemoteBackend(parts: RemoteBackendParts): Backend {
  return {
    kind: 'remote',
    capabilities: new Set(REMOTE_IMPLEMENTED_CAPABILITIES),
    ...parts,
  }
}
