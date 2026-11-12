/**
 * The Direct backend assembly (Pre-M3 PR1): the ONE place that constructs the
 * in-process `ctx.*` adapters for a `Backend`. The runner supplies the
 * Direct-only dependency resolvers (live-Agent lookup, preset composition,
 * Session accessors) and receives the semantic `Backend`; it no longer
 * constructs the Direct semantic adapters one by one, so a port can never be
 * served by a runner-local side channel that bypasses the backend vocabulary.
 *
 * This module owns assembly ONLY: no UI, transition, draft, panel or command
 * routing lives here; every `ctx.*` Host service the adapters need is
 * resolved lazily INSIDE the assembled adapters themselves (e.g. the Direct
 * Host user-shell adapter resolves the `shell` capability per call).
 *
 * Full contract: docs/architecture/host-client.md + docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/backend-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Diag } from '../process/diagnostics.ts'
import type { Backend } from '../backend.ts'
import { createDirectBackend } from '../backend.ts'
import type { TuiSettingsConfig } from '../config-port.ts'
import type { CompositionLike, DirectOwnerPoolLike } from './session-lifecycle-direct.ts'
import type { DirectSessionLiveResolvers } from './session-direct.ts'
import type { LiveAgentLike } from './session-writer-direct.ts'
import type { DirectPendingAgentLike } from './pending-input-reader-direct.ts'
import type { DurableModelSelectionReader, SessionModelSelectionOwnerLike } from './model-selection-direct.ts'
import { DirectSubagentPort } from './subagent-direct.ts'
import { DirectSessionReader } from './session-direct.ts'
import { DirectPendingInputReader } from './pending-input-reader-direct.ts'
import { DirectSessionWriter } from './session-writer-direct.ts'
import { DirectSessionLifecycle } from './session-lifecycle-direct.ts'
import { DirectInteractionPort } from './interaction-direct.ts'
import { DirectCatalogPort } from './catalog-direct.ts'
import { DirectConfigPort } from './config-direct.ts'
import { DirectHostFilePort } from './host-file-direct.ts'
import { DirectSessionArchive } from './session-archive-direct.ts'
import { DirectSessionMarkdown } from './session-markdown-direct.ts'
import { DirectHostCommandPort } from './host-command-direct.ts'
import { DirectPluginManagerPort } from './plugin-manager-direct.ts'
import { DirectJobObservationPort } from './job-observation-direct.ts'
import { DirectHostUserShellPort } from './host-user-shell-direct.ts'
import { DirectHostShellCompletionPort, type DirectShellCandidateReader } from './host-shell-completion-direct.ts'
import type { WorkingDirectoryServiceLike } from './working-directory-direct.ts'
import { DirectDeliveredFileReadPort } from './deliverables-direct.ts'
import { DirectSessionWorkspaceFacts } from './session-workspace-facts-direct.ts'
import { DirectSchedulePort } from './schedule-direct.ts'
import { DirectHostDirectoryBrowsePort } from './host-directory-browse-direct.ts'
import { DirectSessionPolicyPort } from './session-policy-direct.ts'
import type { WebAccessPort, WebAccessStatus, WebAccessUrl } from '../web-access-port.ts'

/** The minimal Host context surface the Direct adapters need (structural;
 * the services resolve from the running dsh installation). */
export interface DirectBackendContextLike {
  get(name: string): unknown
  /** The framework's typed `on` (cordis 4.1 restricts names to `keyof Events`);
   *  the Direct adapters only subscribe to official DSH events. */
  on: Context['on']
}

/** The live-Agent surface the Direct assembly hands to its adapters: the
 * runner's resolver satisfies every adapter's narrower structural need. */
export type DirectLiveAgentLike = LiveAgentLike & DirectPendingAgentLike

/** The Direct-only dependency resolvers the runner supplies to the assembly. */
export interface DirectBackendDeps {
  readonly ctx: DirectBackendContextLike
  readonly diag: Diag
  /** The persisted TUI-settings facade (absent without the Settings service). */
  readonly tuiSettings: TuiSettingsConfig | undefined
  /**
   * The ONE per-Agent model-selection owner (shared with the runner's picker):
   * it serves the catalog WRITE seam AND the session reader's Direct-only
   * durable read. The two capabilities are intersected here on purpose — the
   * reader must never be handed a second owner, and a composition that supplies
   * only the write half must fail to compile.
   */
  readonly modelSelections: SessionModelSelectionOwnerLike & DurableModelSelectionReader
  /** The Direct Session ownership pool (lifecycle retirement/claim). */
  readonly ownerPool: DirectOwnerPoolLike
  /** The current Direct Host Session working directory supplied by the status owner. */
  readonly sessionCwd: () => string
  /** Resolve one preset composition (the runner's compose). */
  readonly compose: (presetId?: string) => Promise<CompositionLike>
  /** The exact live Agent of one Session, or undefined when not mounted. */
  readonly agentFor: (sessionId: string) => DirectLiveAgentLike | undefined
  /** The live Agent plus the interactive continuable child currently viewed. */
  readonly queueAgentFor: (sessionId: string) => DirectLiveAgentLike | undefined
  /** The existing Direct compgen implementation, injected across the composition boundary. */
  readonly shellCandidates: DirectShellCandidateReader
  /** The Host Session/Agent accessors the Direct session reader projects. */
  readonly liveResolvers: DirectSessionLiveResolvers
}

/**
 * The Direct backend's Web frontend control: a truthful UNAVAILABLE capability.
 *
 * The official Web frontend toggle is a Split-Client capability (it belongs to
 * the Split Host's private `piTuiWebAccess` service). The Direct process owns no
 * such toggle, and this adapter touches no Host row, starts no Host and opens no
 * browser — it answers the real missing capability so `/web` can say exactly
 * that.
 */
class DirectUnavailableWebAccess implements WebAccessPort {
  async getStatus(): Promise<WebAccessStatus> {
    return { state: 'unavailable', reason: DIRECT_WEB_ACCESS_REASON }
  }

  async setEnabled(): Promise<WebAccessStatus> {
    return { state: 'unavailable', reason: DIRECT_WEB_ACCESS_REASON }
  }

  async getAuthenticatedUrl(): Promise<WebAccessUrl> {
    throw new Error(DIRECT_WEB_ACCESS_REASON)
  }
}

/** The ONE statement of the Direct capability gap (presentation reads it). */
export const DIRECT_WEB_ACCESS_REASON = 'Web frontend controls are available only in a Split Client.'

/** Assemble the complete Direct `Backend` from the runner's resolvers. */
export function createDirectRuntimeBackend(deps: DirectBackendDeps): Backend {
  return createDirectBackend(
    new DirectSubagentPort(deps.ctx),
    new DirectSessionReader(deps.ctx, deps.liveResolvers, deps.modelSelections),
    new DirectPendingInputReader(deps.queueAgentFor),
    new DirectSessionWriter(deps.ctx, deps.agentFor, deps.queueAgentFor),
    new DirectSessionLifecycle(deps.ctx, deps.compose, deps.ownerPool),
    new DirectInteractionPort(deps.ctx, deps.agentFor),
    new DirectCatalogPort(deps.ctx, deps.agentFor, deps.modelSelections, deps.diag),
    new DirectConfigPort(deps.ctx, deps.tuiSettings, deps.agentFor),
    new DirectHostFilePort(deps.agentFor, deps.ctx),
    new DirectSessionArchive(deps.ctx),
    // S5-PR3: the official Markdown read is a separate semantic capability
    // from the ZIP archive; the Host Session Query snapshot and the official
    // formatter are resolved/consumed in-process, never in the Client.
    new DirectSessionMarkdown(deps.ctx),
    new DirectHostCommandPort(deps.ctx, deps.agentFor),
    new DirectPluginManagerPort(deps.ctx),
    new DirectJobObservationPort(deps.ctx, deps.diag),
    // The Direct Host user-shell adapter (M3-4 PR3): both policies run the
    // official one-shot subprocess core; sandbox additionally needs the
    // official sandbox policy/provider. The resolvers stay here as the one
    // Direct-only assembly seam (resolved lazily per run inside the adapter).
    new DirectHostUserShellPort({
      subprocess: () => deps.ctx.get('subprocess') as never,
      sandbox: () => deps.ctx.get('sandbox') as never,
      sandboxPolicy: () => deps.ctx.get('sandboxPolicy') as never,
      sessionFor: sessionId => deps.agentFor(sessionId)?.session,
      // The request's cwd/policy are EXPECTED values. Both readers answer from
      // the LIVE authorities on every call — the official Session directory
      // owner and the persisted TUI preference the submission owner read —
      // never from a cached snapshot; missing authorities fail closed.
      effectiveCwdFor: (session) => {
        const workingDirectory = deps.ctx.get('workingDirectory') as WorkingDirectoryServiceLike | undefined
        if (workingDirectory === undefined) return undefined
        const cwd = workingDirectory.get(session)
        return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
      },
      shellPolicy: () => deps.tuiSettings?.get().localShellSandbox === 'sandbox' ? 'sandbox' : 'bypass',
    }),
    new DirectHostShellCompletionPort(deps.sessionCwd, deps.agentFor, deps.shellCandidates),
    // Delivered files PR2: the official Host file service read in-process,
    // under the same Session-derived scope the official Remote lookup uses.
    new DirectDeliveredFileReadPort(deps.ctx),
    // M5-W PR-C: the Direct process owns no official Web frontend toggle; the
    // adapter reports that missing capability instead of faking a control.
    new DirectUnavailableWebAccess(),
    // M5-U-A: the ONE read-authority port. Direct reads the live Agent status
    // and the official Workspace registry it already owns; it never fabricates
    // a cross-Session pending fact.
    new DirectSessionWorkspaceFacts(deps.ctx, deps.agentFor),
    // S5-PR4: the official Host Schedule domain, resolved per operation from
    // the SAME Host Context. Never a Client task store and never a
    // `runner.ctx.schedule` shortcut around this port.
    new DirectSchedulePort(deps.ctx),
    // Session Workspace PR1: the official Host directory-picker controller's
    // own `list` handler, resolved per read from the SAME Host Context. This
    // adapter owns no filesystem scan and no Workspace write.
    new DirectHostDirectoryBrowsePort(deps.ctx),
    // M6-1 F8: the exact-Session policy facts + the official approval write,
    // resolved per call from the SAME Host Context (the exact live
    // Session/Agent identity is resolved inside the adapter).
    new DirectSessionPolicyPort(deps.ctx, sessionId => deps.agentFor(sessionId)),
  )
}
