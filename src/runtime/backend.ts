/**
 * The backend vocabulary (M1.1) + assembly (M1.2): the TUI consumes Host
 * domains through semantic ports, and a backend is the assembly of the
 * ports serving one transport. `direct` is the current production backend
 * (in-process, full Host access); `remote` / `wire-local` adapters join in
 * later milestones (M2/M3) behind the SAME port interfaces — never a second
 * feature semantics.
 *
 * Full contract: docs/architecture/host-client.md + docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/backend
 */

import { DIRECT_IMPLEMENTED_CAPABILITIES, type CapabilitySet } from './capability.ts'
import type { SubagentPort } from './subagent-port.ts'
import type { SessionReader } from './session-reader-port.ts'
import type { PendingInputReader } from './pending-input-reader-port.ts'
import type { SessionWriter } from './session-writer-port.ts'
import type { SessionLifecycle } from './session-lifecycle-port.ts'
import type { InteractionPort } from './interaction-port.ts'
import type { Catalog } from './catalog-port.ts'
import type { ConfigPort } from './config-port.ts'
import type { HostFilePort } from './host-file-port.ts'
import type { SessionArchivePort } from './session-archive-port.ts'
import type { SessionMarkdownPort } from './session-markdown-port.ts'
import type { HostCommandPort } from './host-command-port.ts'
import type { PluginManagerPort } from './plugin-manager-port.ts'
import type { JobObservationPort } from './job-observation-port.ts'
import type { HostUserShellPort } from './host-user-shell-port.ts'
import type { HostShellCompletionPort } from './host-shell-completion-port.ts'
import type { DeliveredFileReadPort } from './deliverables-port.ts'
import type { WebAccessPort } from './web-access-port.ts'
import type { SessionWorkspaceFactsPort } from './session-workspace-facts-port.ts'
import type { SchedulePort } from './schedule-port.ts'
import type { HostDirectoryBrowsePort } from './host-directory-browse-port.ts'
import type { SessionPolicyPort } from './session-policy-port.ts'
import type { TeamModePort } from './team-mode-port.ts'

/** The transport backends the TUI can run on. `direct` remains the
 * production/default; `remote` is the experimental M3-3B assembly that can be
 * constructed and tested but is NOT selected by normal startup (M3-4 owns the
 * main-application cutover). */
export type BackendKind = 'direct' | 'remote'

/** The semantic surface a backend serves: one narrow port per domain. */
export interface Backend {
  readonly kind: BackendKind
  /** The capabilities this backend serves (direct = everything). */
  readonly capabilities: CapabilitySet
  /** The subagent domain port (M1.2; more ports join in later cuts). */
  readonly subagent: SubagentPort
  /** The session READ domain port (M1.3). */
  readonly sessionReader: SessionReader
  /** The semantic pending-input projection (D2.1). */
  readonly pendingInputReader: PendingInputReader
  /** The session WRITE domain port (D2.1 contract convergence). */
  readonly sessionWriter: SessionWriter
  /** The session LIFECYCLE domain port (D2.1 semantic open). */
  readonly sessionLifecycle: SessionLifecycle
  /** The interaction domain port (M1.6). */
  readonly interaction: InteractionPort
  /** The catalog domain port (M1.8): models/providers, presets, skills. */
  readonly catalog: Catalog
  /** The config domain port (M1.9): settings, provider profiles,
   * credentials, authorization, permissions, preset default. */
  readonly config: ConfigPort
  /** The Host-file domain port (M1.10): `@`-reference discovery and
   * canonicalization against the Host filesystem. */
  readonly hostFile: HostFilePort
  /** The session ARCHIVE domain port (Pre-Stage-D): one complete
   * Session-tree archive stream per root Session. */
  readonly sessionArchive: SessionArchivePort
  /** The Session MARKDOWN domain port (S5-PR3): the official complete
   * committed Session transcript read by id, never the Client transcript
   * projection. */
  readonly sessionMarkdown: SessionMarkdownPort
  /** The Host command execution domain port (D2.1). */
  readonly hostCommand: HostCommandPort
  /** The Plugin Manager domain port (P1-A): bundles, plugins, installs. */
  readonly pluginManager: PluginManagerPort
  /** The selected-Job observation domain port (P1-B): one non-consuming
   * observation stream for the Job the user opened. */
  readonly jobObservation: JobObservationPort
  /** The shared Host user-shell execution authority: Direct runs in-process;
   * Remote uses the authenticated one-shot Host stream. */
  readonly hostUserShell: HostUserShellPort
  /** Read-only command/variable/git/path completion facts from the selected Host. */
  readonly hostShellCompletion: HostShellCompletionPort
  /** The delivered-file READ port (Delivered files PR2): bounded Host
   * `stat`/`read` for one declared file, under the Session-derived workspace
   * scope. Direct reads the official Host service in-process; Remote calls the
   * official generated `workspaceFiles` namespace. */
  readonly deliveredFileRead: DeliveredFileReadPort
  /** The Split-Client Web frontend control port (M5-W PR-C): the explicit
   *  `/web` surface over the Host's private `piTuiWebAccess` service. Direct
   *  serves the truthful-unavailable adapter. */
  readonly webAccess: WebAccessPort
  /** The UI-neutral read-authority port (M5-U-A): Session activity facts over
   *  the caller's authorized roster plus the ONE official Workspace stream.
   *  Read-only; it owns no writer, store or cross-session cache. */
  readonly sessionWorkspaceFacts: SessionWorkspaceFactsPort
  /** The Host Schedule management port (S5-PR4): the official Host task
   *  domain with its CAS writes and delivery receipts. Direct forwards to the
   *  in-process service, Remote to the authenticated generated namespace; the
   *  Host stays the only task store and the only timer. */
  readonly schedule: SchedulePort
  /** The Host directory-browse READ port (Session Workspace PR1): one official
   *  `directoryPicker/list` level over the SAME Host the other ports reach.
   *  Read-only; it never registers a Workspace or creates a Session. */
  readonly hostDirectoryBrowse: HostDirectoryBrowsePort
  /** The exact-Session policy port (M6-1 F8): the independent
   *  approval/sandbox facts of one live Session and the single official
   *  approval-policy write. Both backends serve the SAME contract. */
  readonly sessionPolicy: SessionPolicyPort
  /** The exact-Root Agent Team mode port (FR1): the official saved selection,
   *  its model-request history and the single official Team mode write. Both
   *  backends serve the SAME contract; no client-side Team truth exists. */
  readonly teamMode: TeamModePort
}

/** Assemble the Direct backend: in-process adapters over `ctx.*` services.
 * The runner depends on the returned `Backend`, never on `ctx.*` directly
 * for the ported domains. */
export function createDirectBackend(
  subagent: SubagentPort,
  sessionReader: SessionReader,
  pendingInputReader: PendingInputReader,
  sessionWriter: SessionWriter,
  sessionLifecycle: SessionLifecycle,
  interaction: InteractionPort,
  catalog: Catalog,
  config: ConfigPort,
  hostFile: HostFilePort,
  sessionArchive: SessionArchivePort,
  sessionMarkdown: SessionMarkdownPort,
  hostCommand: HostCommandPort,
  pluginManager: PluginManagerPort,
  jobObservation: JobObservationPort,
  hostUserShell: HostUserShellPort,
  hostShellCompletion: HostShellCompletionPort,
  deliveredFileRead: DeliveredFileReadPort,
  webAccess: WebAccessPort,
  sessionWorkspaceFacts: SessionWorkspaceFactsPort,
  schedule: SchedulePort,
  hostDirectoryBrowse: HostDirectoryBrowsePort,
  sessionPolicy: SessionPolicyPort,
  teamMode: TeamModePort,
): Backend {
  return {
    kind: 'direct',
    capabilities: new Set(DIRECT_IMPLEMENTED_CAPABILITIES),
    subagent,
    sessionReader,
    pendingInputReader,
    sessionWriter,
    sessionLifecycle,
    interaction,
    catalog,
    config,
    hostFile,
    sessionArchive,
    sessionMarkdown,
    hostCommand,
    pluginManager,
    jobObservation,
    hostUserShell,
    hostShellCompletion,
    deliveredFileRead,
    webAccess,
    sessionWorkspaceFacts,
    schedule,
    hostDirectoryBrowse,
    sessionPolicy,
    teamMode,
  }
}
