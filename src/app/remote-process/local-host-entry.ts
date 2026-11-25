#!/usr/bin/env node
/**
 * M4-B1 Host-only process entry.
 *
 * Boots the ordinary DSH profile through the real launcher
 * (`@deepseek-ai/dsh/profile-boot` → `@deepseek-ai/dsh-app-boot` → Loader /
 * Include) rather than a hand-built Context. The launcher-owned Host-only
 * overlay disables exactly the TUI runner and the Client extension host /
 * builtins and adds exactly one official Connection row and one API-remotes
 * event source. Every other Host-plane row keeps its production source.
 *
 * Before the profile Context exists this process claims one Linux abstract
 * socket for the canonical DSH profile; losing that kernel claim is a clean
 * non-fault exit. After boot it registers one authenticated identity Fetch
 * route, publishes the private launch material, and commits `instance.json`
 * as its last Ready step. Process-lifetime SIGTERM/SIGINT admission is
 * installed before the registry becomes discoverable: a signal observed while
 * publication is still in flight is kept as one pending stop intent and runs
 * the ordinary owner-governed shutdown once the published identity and the
 * official shutdown owner are both available, never emitting Ready for a
 * stop-requested Host.
 *
 * The entry is an internal qualification artifact, not a package export or a
 * CLI command: the launcher supplies the DSH installation anchor, profile name
 * and scratch directory through `SPLIT_PROCESS_DSH_ANCHOR` /
 * `SPLIT_PROCESS_PROFILE` / `SPLIT_PROCESS_SCRATCH`.
 *
 * @module app/remote-process/local-host-entry
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachEntryControl, createEntryDiag, writeEntryRecord, type EntryControlChannel } from './entry-control.ts'
import { initializeHostEnvironment } from './host-environment.ts'
import { HostActivityObserver } from './host-activity.ts'
import { PI_TUI_WEB_ACCESS_ROWS } from '../host/features/web-roster.ts'
import {
  bindProfileKernelSeat,
  installedPackageRootFromEntry,
  LocalScopeError,
  LOCAL_PROTOCOL,
  readInstalledDshVersion,
  removeOwnedScratch,
  scopeFromInstalledProfile,
  type LocalScope,
  type ProcessSeat,
} from './local-scope.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { ProfileConfigEditorLike } from '../config/profile-preferences-migration.ts'
import type { SettingsFormsLike } from '../../runtime/config-port.ts'
import {
  PI_TUI_WEB_ACCESS_NAMESPACE,
  type PiTuiWebAccessStatus,
} from '../../runtime/remote/pi-tui-web-access-contract.ts'
import {
  LOCAL_WORKSPACE_OBJECT_ROUTE,
  createWorkspaceObjectHandler,
} from './local-workspace-object.ts'
import {
  LOCAL_ACP_STATUS_ROUTE,
  createLocalAcpStatusHandler,
} from './local-acp-status.ts'
import {
  LOCAL_ACP_CONTROL_ROUTE,
  createLocalAcpControlHandler,
} from './local-acp-control-route.ts'
import {
  LOCAL_WEB_CONTROL_ROUTE,
  createLocalWebControlHandler,
} from './local-web-control-route.ts'
import {
  assertRecordedHostKernelIdentityCurrent,
  buildHostInstanceRecord,
  cleanupOwnedFiles,
  readHostProcessIdentity,
  type HostProcessIdentity,
  type LocalInstanceRecord,
} from './local-discovery.ts'
import {
  LocalAcpError,
  parseAcpMaxConnections,
  startLocalAcpListener,
  type LocalAcpListener,
} from './local-acp-listener.ts'
import type { AcpQuestionSpec } from './local-acp-question-form.ts'
import {
  AcpHostCommandError,
  EMPTY_COMMAND_CATALOG,
  type AcpCommandCatalogRead,
  type AcpCommandCatalogRow,
  type AcpNativeSkillCatalog,
} from './local-acp-commands.ts'
import {
  AcpSessionViewRegistry,
  ACP_IMAGE_MEDIA_TYPES,
  type AcpImageLimits,
  type AcpContinuedAnswerOutcome,
  type AcpCreateSessionOutcome,
  type AcpCreateWorkspaceOutcome,
  type AcpPromptFactListener,
  type AcpQuestionAnswer,
  type AcpQuestionSnapshot,
  type AcpSessionPromptRequest,
  type HostAcpSessionAccess,
  type LiveAgentViewIdentity,
} from './local-acp-session-view.ts'
import type {
  AcpHistoryHeader,
  AcpSessionHistory,
  AcpSessionReadRow,
} from './local-acp-projections.ts'
import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'
import {
  AcpSessionModelService,
  type AcpModelAgent,
  type AcpModelCatalog,
  type AcpModelSelection,
} from './local-acp-model-selection.ts'
import {
  AcpSessionPolicyService,
  stalePolicy,
  type AcpAgentTeamService,
  type AcpPlanModeService,
  type AcpSessionPolicyAgent,
  type AcpSessionPolicyRequest,
  type AcpSessionPolicyState,
} from './local-acp-session-policy.ts'
import {
  AcpScopedMcpError,
  mountAcpScopedMcp,
  retireAcpScopedMcp,
  type AcpScopedMcpAgent,
  type AcpScopedMcpToolAuthority,
} from './local-acp-scoped-mcp.ts'

/** The three Web roster rows whose official non-desktop values must stay fixed
 * at the Host-only layer, read from the ONE production roster
 * (`host/features/web-roster.ts`). These rows carry NO volatile Settings form
 * (pinned rc.5), so an in-place command-line override cannot block a user
 * save; the generated bundle patch declares the complete roster. A writable UI
 * row (`ui-settings-general`, `ui-theme`, …) must NEVER appear here: a
 * command-line config override would make the official ConfigEditor refuse
 * every user write. */
const WEB_FIXED_OVERRIDE_IDS = ['web-runtime', 'office-kit', 'skill-office'] as const

/** The Host-only in-place fixes for the three non-user Web values. `config`
 * comes from the SAME roster record that generates the bundle declaration;
 * `yaml` is the fixed official macro fragment for the ONE `!!js`-configured
 * row (office-kit's Host data output directory). No `name`, no `insert`, no
 * `inject` and no `disabled`: those belong to the bundle declaration. */
const WEB_FIXED_OVERRIDES_YAML = WEB_FIXED_OVERRIDE_IDS.map(id => {
  const row = PI_TUI_WEB_ACCESS_ROWS.find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`local host entry: the Web roster lost its "${id}" row`)
  return [
    `- id: ${row.id}`,
    ...(row.config === undefined
      ? []
      : ['  config:', ...Object.entries(row.config).map(([key, value]) => `    ${key}: ${String(value)}`)]),
    // The roster `yaml` fragment is indented for the bundle's `- insert:`
    // block; an in-place top-level override is four columns shallower.
    ...(row.yaml ?? []).map(line => line.replace(/^ {4}/u, '')),
  ].join('\n')
}).join('\n')

/**
 * The Host-only overlay applied over the profile's own patch stack. It keeps
 * `tui-startup` mounted for the consumers that genuinely need its parsed
 * startup facts, but the Host execution rows never use that mutable provider
 * as their Dispose gate: reloading `tui-startup` must not dispose
 * already-accepted Host Session/Agent/Connection ownership. It disables only
 * the three surface rows that must not exist in a Host-only PID, then adds the
 * two B1 rows plus the official Session-serving and Account Controller rows and the ONE built-in
 * PiTui Host Runtime row. The base Gateway, webserver, workspace-files,
 * workspace-controller, credentials, agents, sessions and jobs are reused,
 * never mounted twice.
 */
export const HOST_ONLY_PATCH = `# M4-B1 Host-only profile overlay: production Host rows only.
- id: tui-app
  disabled: true
- id: pi-tui-extension-host
  disabled: true
- id: pi-tui-builtins
  disabled: true

# The Split Host's ONE Host Runtime row. The bundle DECLARES it (disabled by
# default); this overlay only ENABLES it. Keeping the declaration — and its
# config — out of this command-line overlay is required: the official
# ConfigEditor refuses to persist an entry whose config a home patch or
# command-line overlay overrides. The row owns the Split Host's private
# business services; the profile-owned TUI preferences it reads live in the
# canonical 'pi-tui-preferences' row.
- id: split-host-pi-tui-runtime
  disabled: false

# Infrastructure lifetime is independent of the mutable tuiStartup provider.
- id: webserver
  inject: []
- id: workspace-files
  inject: []
# The bundle's ONE official Workspace Controller row, retuned IN PLACE: the
# Host is a long-lived Workspace Remote owner, not a CLI startup side effect,
# yet the row (its ID, package, config and the class's own
# remoteAccess/typert/workspaceRegistry injects) stays the bundle's. A second
# row here would register the \`workspace\` namespace twice.
- id: workspace-controller
  inject: []
# The bundle's ONE official Host directory-browse backend stays the bundle's
# row too: the overlay only drops its Direct tuiStartup admission gate so the
# Workspace Controller's DirectoryPickerController keeps serving
# 'directoryPicker/list' after the TUI Client is gone. A second picker row
# here would register the directory-picker seam twice.
- id: directory-picker
  inject: []

# Host Schedule management (S5-PR4): the bundle's ONE official Schedule row
# stays this bundle's row; the overlay only drops its Direct tuiStartup
# admission gate so the Host timer keeps running after the Client and the Web
# UI are gone. sessionController remains the readiness barrier and resolves to
# the existing split-host-session-controller below. Never insert a second
# Schedule row here.
- id: pi-tui-schedule
  inject: [sessionController]
# The three Direct-only activation prerequisites are DISABLED here: the
# overlay already mounts the split-host-connection / split-host-file-upload /
# split-host-session-controller rows exactly once, and a second Connection,
# FileUploads or Session controller would give one Host PID two owners.
- id: pi-tui-direct-connection
  disabled: true
- id: pi-tui-direct-file-upload
  disabled: true
- id: pi-tui-direct-session-controller
  disabled: true

- insert:
    # One official Connection owner (loopback /connect + /api) behind the
    # profile's existing webserver (whose Host-only lifetime is independent of
    # tuiStartup). trustedHosts stays empty: loopback and the listener's own
    # bind IP are the only accepted authorities.
    - id: split-host-connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [credentials, webServer]
      config:
        trustedHosts: []

    # One forwarded-event source on the base typert-gateway row. It registers
    # host.home and the private $events stream; the gateway is not remounted.
    - id: split-host-api-remotes
      name: '@deepseek-ai/dsh-api-remotes'
      inject: [typertGateway, connection]

    # Official Session-serving Host rows (rc.4): each is mounted ONCE here and
    # never re-mounted by the built-in PiTui Host Runtime or the Client.
    - id: split-host-file-upload
      name: '@deepseek-ai/dsh-client-file-upload'
      inject: [agents, attachments, commands, connection]

    - id: split-host-session-stats
      name: '@deepseek-ai/dsh-session-stats'
      inject: [sessionProjections]

    - id: split-host-turn-outline
      name: '@deepseek-ai/dsh-session-turn-outline'
      inject: [sessionProjections]

    - id: split-host-session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
      inject: [agentDefaultModel, agents, attachments, fileUploads, fs, llm, remoteAccess, sessions, sessionProjections, sessionQuery, typert, workspaceRegistry]
      config:
        nativeOpen: false

    - id: split-host-settings-controller
      name: '@deepseek-ai/dsh-api-settings-controller'
      inject: [typert]

    - id: split-host-session-log-download
      name: '@deepseek-ai/dsh-session-log-export'
      inject: [commands, connection]

    # One process-global provider registration for the existing Cordis inspect
    # registry. Never put this row in the Web toggle roster or mount a second
    # runner: the registry rejects a duplicate provider id.
    - id: split-host-cordis-inspect-providers
      name: '@deepseek-ai/dsh-tool-cordis/host'
      inject: [cordisInspect, tools]

    # The package's ONE built-in Host Runtime row: the private contribution plus
    # the private business services. Business features are NOT separate Loader
    # rows or package subpaths. The sandbox policy/provider are resolved PER
    # CALL by the features that need them (M6-1 F8), so a Host without the
    # sandbox provider still becomes Ready and reports that side truthfully.
    #
    # The row itself is DECLARED by the bundle patch (disabled by default), so
    # its config stays USER-profile owned. This overlay only ENABLES it: the
    # official ConfigEditor refuses to persist an entry whose config a home
    # patch or command-line overlay overrides. Its legacy TUI preference fields
    # are a migration source only; runtime behavior reads the canonical
    # 'piTuiPreferences' service.

# ── Official Web composition (M5-W PR-A/PR-B/PR-C, PR-A profile-writable) ──
# The complete Browser Web roster is declared in the BUNDLE
# (generated/web-access/cordis.patch.yml, generated from the ONE production
# table). It is NOT inserted here: a command-line overlay config override makes
# the official ConfigEditor refuse that entry's user writes, which is exactly
# why the official Web pages could not persist their volatile settings.
# Every roster row arrives DISABLED from the bundle. The private
# 'piTuiWebAccess' Host service flips exactly those rows through
# 'Entry.update'; a cold boot starts from the default-off bundle state UNLESS
# the profile's own 'pi-tui-web-preferences.autoStart' is on, in which case the
# boot sequence below enables the same roster before Ready ('/web' remains the
# immediate control of a running Host). Only the isolated qualification runs
# additionally override rows through SPLIT_PROCESS_EXTRA_PATCH; that internal
# test channel is not a user API.
#
# The three rows below keep their official non-desktop safety values at this
# layer so a profile patch cannot relax them. They carry NO volatile Settings
# form in the pinned DSH family, so the in-place override cannot block a user
# save, and no writable UI row is overridden here.
${WEB_FIXED_OVERRIDES_YAML}
`

interface OfficialDshModules {
  /** The official strict leading-slash parser used by ACP command routing. */
  readonly parseCommand: (line: string) => { readonly name: string; readonly rawInput: string } | undefined
  readonly runProfile: (options: {
    environment: unknown
    profile: string
    patchFiles: readonly string[]
    args: readonly string[]
  }) => Promise<{
    ctx: import('@deepseek-ai/cordis').Context
    shutdown: { shutdown(code: number): Promise<void> }
  }>
  readonly loadLayeredEnv: (binName: string, cwd?: string) => unknown
  readonly resolveDshHome: () => string
  readonly resolveProfileDir: (name: string, home?: string) => string
  /**
   * The official basic compaction implementation class, resolved from the
   * SAME installation anchor as the retained Host. Optional: without it the
   * ACP compact capability is unavailable, never replaced by a root engine.
   */
  readonly compactionEngineClass?: Function
  /**
   * The official PlanModeController class, resolved from the SAME installation
   * anchor. Optional: without it the ACP collaboration mode is unavailable,
   * never replaced by a differently-shaped service.
   */
  readonly planModeClass?: Function
}

/** Resolve one published DSH subpath from the installation anchor supplied by the launcher. */
async function loadOfficialDsh(anchor: string): Promise<OfficialDshModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const profileBoot = await importResolved('@deepseek-ai/dsh/profile-boot')
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  const homePaths = await importResolved('@deepseek-ai/dsh-home-paths')
  const commands = await importResolved('@deepseek-ai/dsh-commands')
  let compactionEngineClass: Function | undefined
  try {
    const compaction = await importResolved('@deepseek-ai/dsh-compaction-basic')
    const candidate = compaction.BasicCompactionEngine
    if (typeof candidate === 'function') compactionEngineClass = candidate
  } catch {
    // The optional compact capability is absent when its public official
    // implementation cannot be resolved from this anchor.
  }
  let planModeClass: Function | undefined
  try {
    const planMode = await importResolved('@deepseek-ai/dsh-plan-mode')
    const candidate = planMode.PlanModeController ?? planMode.default
    if (typeof candidate === 'function') planModeClass = candidate
  } catch {
    // The optional collaboration-mode capability is absent when its public
    // official implementation cannot be resolved from this anchor.
  }
  return {
    parseCommand: commands.parseCommand as OfficialDshModules['parseCommand'],
    ...(compactionEngineClass === undefined ? {} : { compactionEngineClass }),
    ...(planModeClass === undefined ? {} : { planModeClass }),
    runProfile: profileBoot.runProfile as OfficialDshModules['runProfile'],
    loadLayeredEnv: appBoot.loadLayeredEnv as OfficialDshModules['loadLayeredEnv'],
    resolveDshHome: homePaths.resolveDshHome as OfficialDshModules['resolveDshHome'],
    resolveProfileDir: appBoot.resolveProfileDir as OfficialDshModules['resolveProfileDir'],
  }
}

/** The launcher-supplied facts one Host-only process needs. */
export interface LocalHostEntryOptions {
  /** Absolute path of the installed `@deepseek-ai/dsh/package.json`. */
  readonly dshAnchor: string
  /** Profile to boot; defaults to `pi-tui`. */
  readonly profile: string
  /** Extra overlay applied after the Host-only overlay (negative controls). */
  readonly extraPatchFiles?: readonly string[]
}

/** The exact scratch this Host process created under its real scope. */
interface HostScratchOwner {
  scopeDir?: string
  scratchDir?: string
  /** The one Host-entry-owned ACP runtime controller; its synchronous exit mirror retires the socket inode. */
  acpController?: AcpControlController
}

/** Node's `RequestInit` omits the cache mode; B1 requires `no-store` explicitly. */
type LocalRequestInit = RequestInit & { readonly cache?: 'no-store' }

/** Wait for one unauthenticated route to answer with the expected refusal. */
async function waitForRefusal(
  url: string,
  timeoutMs = 10_000,
  init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const request: LocalRequestInit = {
        method: init.method ?? 'GET',
        redirect: 'manual',
        cache: 'no-store',
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
      }
      const response = await fetch(url, request)
      await response.body?.cancel()
      // The official admission must refuse a request that carries no Cookie.
      // Any other status (especially 200) is not proof and keeps the wait.
      if (response.status === 401 || response.status === 403) return
    } catch {
      // The listener or route may still be settling; retry inside the bound.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`local host entry: the official route did not become ready: ${url}`)
}

/** Qualification-only publication/stop barrier; production never sets either path. */
async function waitForQualificationBarrier(path: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`local host entry: the qualification barrier was not released: ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The Host's own settings-form projection (the official SettingsForms read). */
interface HostSettingsServiceLike {
  describe(options?: { readonly redactSecrets?: boolean }): readonly {
    readonly ns?: unknown
    readonly value?: unknown
  }[] | undefined
}

/** The profile entry that owns the Web startup preference. */
const WEB_STARTUP_PREFERENCE_NAMESPACE = 'pi-tui-web-preferences'

/** The fixed failure categories the pre-Ready Web autostart may report. */
export type WebAutostartFailure = 'service-missing' | 'mutation-failed' | 'not-enabled'

/**
 * Apply the profile-owned Web startup preference BEFORE the Host becomes Ready.
 *
 * `autoStart` is read from the SAME `ctx` that already settled the profile: a
 * missing settings service or a missing `pi-tui-web-preferences` section is a
 * corrupted composition and fails the Host startup loudly (never "treated as
 * Off"), while a failing Web enable is a bounded diagnostic: the Host keeps its
 * Session/Agent/Gateway graph and publishes Ready with the Web frontend in
 * whatever state the private service truthfully reports.
 *
 * The diagnostic is a FIXED record: a failure category and (when the service
 * answered at all) the Host's own small state vocabulary. It never carries an
 * exception message — a Host, Connection, Loader or plugin error text could
 * contain a URL, launch token, cookie or profile path, which this pre-Ready path
 * must never publish.
 *
 * @param context - the Host context that already settled the profile.
 * @param emit - the structured record sink (the entry emits on its control channel).
 */
export async function applyWebStartupPreference(
  context: import('@deepseek-ai/cordis').Context,
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
): Promise<void> {
  const settings = context.get('settings') as HostSettingsServiceLike | undefined
  if (settings === undefined || typeof settings.describe !== 'function') {
    throw new Error('local host entry: the Host has no settings service, so the Web startup preference cannot be read')
  }
  const descriptor = (settings.describe() ?? []).find(entry => entry.ns === WEB_STARTUP_PREFERENCE_NAMESPACE)
  if (descriptor === undefined) {
    throw new Error('local host entry: the profile projects no "pi-tui-web-preferences" settings section')
  }
  const value = descriptor.value
  const autoStart = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { readonly autoStart?: unknown }).autoStart
    : undefined
  // The schema owns the boolean strictly; anything else means the section was
  // projected by a different composition, not a missing user choice.
  if (typeof autoStart !== 'boolean') {
    throw new Error('local host entry: "pi-tui-web-preferences.autoStart" is not a boolean')
  }
  if (!autoStart) return
  const unavailable = (failure: WebAutostartFailure, state?: string): void => {
    emit({
      m4a0: 'diagnostic',
      processRole: 'host',
      pid: process.pid,
      code: 'web-autostart-unavailable',
      failure,
      ...(state === undefined ? {} : { state }),
    })
  }
  const service = context.get(PI_TUI_WEB_ACCESS_NAMESPACE) as {
    setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus>
  } | undefined
  if (service === undefined) {
    unavailable('service-missing')
    return
  }
  let status: PiTuiWebAccessStatus
  try {
    status = await service.setEnabled(true)
  } catch {
    // The exception text is deliberately dropped: it can name a URL, a token,
    // a cookie or a profile path. The Host's own status is the visible truth.
    unavailable('mutation-failed')
    return
  }
  if (status.state !== 'enabled') {
    unavailable('not-enabled', status.state)
    return
  }
  emit({
    m4a0: 'web-autostart',
    processRole: 'host',
    pid: process.pid,
    phase: 'pre-ready',
    status: 'enabled',
  })
}

/** The profile entry that owns the ACP startup preference. */
const ACP_STARTUP_PREFERENCE_NAMESPACE = 'pi-tui-acp-preferences'

/** The fixed failure categories the pre-Ready ACP autostart may report. */
export type AcpAutostartFailure = 'controller-missing' | 'mutation-failed' | 'not-enabled'

/**
 * The single Host-entry-owned ACP runtime controller interface. ONE socket owner
 * per Host profile: `getStatus` reads the LIVE listener fact; `setEnabled`
 * serializes bind/close through one promise chain; `quiesce` is a SYNCHRONOUS
 * latch set before the official shutdown begins so no new enable is admitted;
 * `close` retires the listener inside the same serialized chain; `cleanupSync`
 * is the synchronous process-exit mirror for the exact owned socket inode.
 */
export interface AcpControlController {
  getStatus(): Promise<AcpAccessStatus>
  setEnabled(enabled: boolean): Promise<AcpAccessStatus>
  /** Mark the controller quiescing synchronously (no async work). */
  quiesce(): void
  /** Serialize a final close of the current listener (idempotent). */
  close(): Promise<void>
  /** Synchronously retire only this controller's current owned socket inode. */
  cleanupSync(): void
}

/** Options for {@link createAcpController}; no Context, Agent or Session enters here. */
export interface AcpControlControllerOptions {
  readonly scope: LocalScope
  readonly maxConnections: number
  readonly diag: import('../../runtime/process/diagnostics.ts').Diag
  /**
   * The narrow, already-bound Host Session access the listener forwards to the
   * connection-scoped Session View (PO-2). Absent keeps the PO-1 fail-closed
   * Session behaviour. Never a Context, Agent or Session object.
   */
  readonly sessionAccess?: HostAcpSessionAccess
}

interface AttachmentServiceLike {
  readonly imageLimits: AcpImageLimits & { readonly maxImagePixels?: number; readonly maxImageDimension?: number }
  /** Read one committed image back with the Store's OWN integrity verification. */
  readImage(
    ref: {
      readonly attachmentId: string
      readonly mediaType: string
      readonly bytes: number
      readonly width: number
      readonly height: number
    },
    signal?: AbortSignal,
  ): Promise<{ readonly ref: { readonly mediaType: string }; readonly data: Uint8Array }>
}

interface LlmServiceLike {
  resolveModelInfo(provider: string, model: string): Promise<{ readonly inputModalities?: readonly string[] }>
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(providerId: string): Promise<readonly { readonly id: string; readonly name: string }[]>
  resolveCallConfig(selection: AcpModelSelection, signal?: AbortSignal): Promise<AcpModelSelection>
}

interface DefaultModelServiceLike {
  currentSelection(): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
}

interface AgentModelLike {
  current(): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
}

function imageRouteError(reason: string, message: string): Error & {
  readonly isDSHRemoteError: true
  readonly code: 'session/attachment-invalid'
  readonly details: { readonly reason: string }
} {
  return Object.assign(new Error(message), {
    isDSHRemoteError: true as const,
    code: 'session/attachment-invalid' as const,
    details: { reason },
  })
}

interface ImageRouteAgentLike extends LiveAgentViewIdentity {
  readonly model?: AgentModelLike
}

/** The structural views of the official Host services the ACP access borrows. */
interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: { workspaceId: string; path: string }; created: boolean }>
}
interface SessionControllerLike {
  create(request: { workspaceId: string }): Promise<{ sessionId: string }>
  /**
   * The official authorized Session roster: the Controller already filters it
   * through `remoteAccess.allows({kind:'session'})` and never resumes an Agent.
   */
  list(request: { readonly cursor?: string }, signal: AbortSignal): Promise<{
    readonly items: readonly {
      readonly sessionId: string
      readonly updatedAt: number
      readonly cwd?: string
      readonly origin?: 'subagent'
    }[]
  }>
  resolveAgent(sessionId: string): Promise<
    { agent: LiveAgentViewIdentity } | { error: { code: string; message: string } }
  >
  /** The official Remote prompt surface; `signal` gates admission only. */
  prompt(request: AcpSessionPromptRequest, signal: AbortSignal): Promise<{ readonly accepted: true }>
  /** The official Host provider-grouped model catalog (with reasoning metadata). */
  modelCatalog(): Promise<AcpModelCatalog>
}
interface AgentRegistryLike {
  get(id: string): LiveAgentViewIdentity | undefined
  /** The official current turn/step boundary projection of one Session. */
  turnBoundaryOf(session: object): {
    readonly openTurnStartSeq: number | null
    readonly lastTurn: number
  }
}
interface SessionRegistryLike {
  get(id: string): object | undefined
}
interface ToolsServiceLike {
  definitions(scope?: object): readonly { readonly name: string }[]
}

/** The official one-item answer shape (`AskUserQuestionAnswerItem`). */
interface UserQuestionAnswerItemLike {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The structural seam of the official `userQuestions` service. */
interface UserQuestionServiceLike {
  /**
   * Commit ONE late answer for a continued timed call. `true` means the reply
   * was accepted into the Agent inbox; `false` that the call is no longer
   * answerable. A rejection keeps its official code (`REPLY_QUEUED`,
   * `BAD_ANSWER`, `CALLER_NOT_LIVE`, …).
   */
  answer(
    agent: LiveAgentViewIdentity,
    callId: string,
    answer: { readonly answers: readonly UserQuestionAnswerItemLike[] },
  ): boolean
}

/** One official continued timed question (`PendingUserQuestion`). */
interface PendingUserQuestionLike {
  readonly callId: string
  readonly questions: readonly AcpQuestionSpec[]
  readonly state: 'open' | 'continued'
}

/** The official `userQuestions` projection state as this seam reads it. */
interface UserQuestionProjectionStateLike {
  readonly questions: {
    readonly active: readonly PendingUserQuestionLike[]
    readonly settled: readonly { readonly callId: string }[]
  }
}

/** The structural seam of the official `sessionProjections` registry. */
interface SessionProjectionServiceLike {
  stateOf(session: object, key: string): unknown
  snapshot(session: object, keys?: readonly string[]): {
    readonly asOfSeq: number
    readonly values: Readonly<Record<string, unknown>>
  }
  onChanged(listener: (session: object, key: string) => void): () => void
}

/** The official header facts a Session List/History read needs (structural). */
export interface SessionHeaderFactsLike {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

/**
 * One title/header observation result of the official Session Query
 * (structural). The official `SessionTitleObservation` carries the folded
 * header as `value.session` (a `structuredClone` of the durable header) plus an
 * optional `value.title`; the seam is asserted against that official result in
 * `test/app/local-acp-host-cold-header.test.ts` so a renamed field cannot fall
 * through to `undefined` at runtime.
 */
export type SessionTitleObservationLike =
  | {
    readonly sessionId: string
    readonly status: 'fulfilled'
    readonly value: {
      readonly session: SessionHeaderFactsLike
      readonly title?: { readonly title: string }
    }
  }
  | { readonly sessionId: string; readonly status: 'rejected' }

/**
 * The structural seam of the official `sessionQuery` read surface. It is
 * declared structurally (never imported) so this Host composition root does
 * not pull a second physical copy of `dsh-session` into the program.
 */
interface SessionQueryReadLike {
  readSession(sessionId: string): Promise<{
    readonly session: SessionHeaderFactsLike
    readonly events: readonly { readonly seq: number; readonly type: string; readonly data: unknown; readonly time?: number }[]
  }>
  readTitleSnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<readonly SessionTitleObservationLike[]>
}

/**
 * The synchronous cancel seam of one live Agent. PO-3B calls these two official
 * methods only, always on the EXACT attached object and in the same Host
 * callback stack that read the current-turn fence.
 */
interface AgentCancelSeamLike {
  readonly inbox: {
    remove(messageId: string): boolean
    readonly nextTurn: readonly { readonly id: string }[]
    readonly nextStep: readonly { readonly id: string }[]
  }
  cancel(cause: { readonly kind: 'user' }, options?: { readonly keepInbox?: boolean }): void
}

/** The official running/idle phase the turn fence cross-checks. */
interface AgentStatusSeamLike {
  readonly status: 'idle' | 'running'
}

/** The exact official command descriptor/definition facts this adapter uses. */
interface CommandDescriptorLike {
  readonly name: string
  readonly description: string
  readonly definitionId?: unknown
  readonly input?: { readonly hint?: string }
}

interface CommandExecutionLike {
  readonly result?: { readonly kind?: unknown; readonly text?: unknown }
}

interface CommandRuntimeLike {
  list(agent: object): readonly CommandDescriptorLike[]
  find(agent: object, name: string): CommandDescriptorLike | undefined
  execute(
    agent: object,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<CommandExecutionLike | undefined>
}

interface AgentPresetInspectionLike {
  readonly id: string
  readonly modules: readonly { readonly moduleName: string }[]
  readonly leakedServices?: readonly string[]
}

interface AgentPresetRegistryLike {
  inspectCompositions(ctx?: object): readonly AgentPresetInspectionLike[]
  serviceFor(agent: { readonly ctx: object }, name: 'compaction' | 'skills' | 'planMode'): unknown
}

/** The official root-only Agent Team write seam (structural). */
interface AgentTeamServiceLike extends AcpAgentTeamService {}

/** The official subagent registry root resolver (structural). */
interface SubagentRegistryLike {
  rootOf(agent: object): object
}

interface WorkingDirectoryLike {
  get(session: object): string
}

interface SkillSummaryLike {
  readonly name?: unknown
  readonly description?: unknown
  readonly invocation?: { readonly userInvocable?: unknown }
}

interface SkillRegistryLike {
  snapshot(options: {
    readonly cwd: string
    readonly scope: object
    readonly signal?: AbortSignal
  }): Promise<{ readonly skills: readonly SkillSummaryLike[]; readonly complete: boolean }>
}

interface CompactionEngineLike {
  compactNow(agent: object, signal: AbortSignal): Promise<unknown>
}

/** The official command definition identities this Host may advertise. */
const FEEDBACK_DEFINITION_ID = '@deepseek-ai/dsh-command-feedback'
const COMPACT_DEFINITION_ID = '@deepseek-ai/dsh-command-compact'

/** Official generated preset identities whose compaction composition is audited. */
const AUDITED_COMPACTION_PRESETS: ReadonlySet<string> = new Set(['standard', 'ptc', 'minimal', 'cordis'])

/** The audited official compaction modules of one isolated preset group. */
const AUDITED_COMPACTION_MODULES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
])

/** One live Agent exposes its exact Cordis context to the preset registry. */
interface HostAgentLike extends LiveAgentViewIdentity {
  readonly ctx: object
}

/** Fail closed unless the exact Agent/Session objects are still the live pair. */
function assertExactHostIdentity(
  agents: AgentRegistryLike,
  sessions: SessionRegistryLike,
  agent: LiveAgentViewIdentity,
  session: object,
): void {
  if (agents.get(agent.id) !== agent || sessions.get(agent.id) !== session || agent.session !== session) {
    throw new AcpHostCommandError('stale', 'the exact Host Agent/Session identity is no longer current')
  }
}

/** Whether this Agent exposes the exact Cordis context required for preset reads. */
function hasContext(agent: LiveAgentViewIdentity): agent is HostAgentLike {
  return typeof (agent as { readonly ctx?: unknown }).ctx === 'object' && (agent as { readonly ctx?: unknown }).ctx !== null
}

/** The active modules of the exact retained preset revision. */
function retainedInspection(
  agent: LiveAgentViewIdentity,
  presets: AgentPresetRegistryLike,
): AgentPresetInspectionLike | undefined {
  if (!hasContext(agent)) return undefined
  let inspections: readonly AgentPresetInspectionLike[]
  try {
    inspections = presets.inspectCompositions(agent.ctx)
  } catch {
    throw new AcpHostCommandError('unavailable', 'the retained preset composition could not be inspected')
  }
  if (inspections.length !== 1) return undefined
  return inspections[0]
}

function retainedModules(agent: LiveAgentViewIdentity, presets: AgentPresetRegistryLike): readonly string[] | undefined {
  return retainedInspection(agent, presets)?.modules.map(module => module.moduleName)
}

/** Whether the exact retained revision mounts the native human Skill loader. */
function hasNativeSkillLoader(agent: LiveAgentViewIdentity, presets: AgentPresetRegistryLike): boolean {
  return retainedModules(agent, presets)?.includes('@deepseek-ai/dsh-tool-skill') === true
}

/**
 * Resolve the registry the exact retained loader actually consumes. The
 * standard composition mounts `tool-skill` against the global `skills`
 * service (there is no scoped isolate), while a custom composition may
 * publish an Agent-scoped registry. Prefer the scoped registry when it
 * exists; otherwise the official global service is the effective registry.
 * A missing/unusable registry is absent, never a third authority.
 */
function readSkillRegistry(
  agent: LiveAgentViewIdentity,
  presets: AgentPresetRegistryLike,
  global: SkillRegistryLike | undefined,
): SkillRegistryLike | undefined {
  if (!hasContext(agent)) return undefined
  let scoped: unknown
  try {
    scoped = presets.serviceFor(agent, 'skills')
  } catch {
    // A failed authoritative read is not absence; never switch to the global
    // registry because the scoped read could not answer.
    throw new AcpHostCommandError('unavailable', 'the retained Skill service could not be resolved')
  }
  const registry = (scoped as SkillRegistryLike | undefined) ?? global
  return registry !== undefined && typeof registry.snapshot === 'function' ? registry : undefined
}

/**
 * The ONE audited compaction composition gate: exactly one retained revision,
 * the official basic engine + command definition modules, no other compaction
 * engine module, and the exact scoped service object.
 */
function auditedCompactionEngine(
  agent: LiveAgentViewIdentity,
  presets: AgentPresetRegistryLike | undefined,
  expectedEngineClass: Function | undefined,
): CompactionEngineLike | undefined {
  if (presets === undefined || !hasContext(agent)) return undefined
  const inspection = retainedInspection(agent, presets)
  if (inspection === undefined || !AUDITED_COMPACTION_PRESETS.has(inspection.id)) return undefined
  const modules = inspection.modules.map(module => module.moduleName)
  if (!modules.includes('@deepseek-ai/dsh-compaction-basic')
    || !modules.includes('@deepseek-ai/dsh-command-compact')
    || !modules.filter(name => name.includes('compaction')).every(name => AUDITED_COMPACTION_MODULES.has(name))) {
    return undefined
  }
  let service: unknown
  try {
    service = presets.serviceFor(agent, 'compaction')
  } catch {
    throw new AcpHostCommandError('unavailable', 'the retained compaction service could not be resolved')
  }
  const engine = service as CompactionEngineLike | undefined
  if (engine === undefined || typeof engine.compactNow !== 'function') return undefined
  if (expectedEngineClass === undefined) return undefined
  try {
    if (!(engine instanceof expectedEngineClass)) return undefined
  } catch {
    return undefined
  }
  return engine
}

/** Project one official command definition onto the detached wire row. */
function commandRow(definition: CommandDescriptorLike): AcpCommandCatalogRow {
  return {
    kind: 'command',
    name: definition.name,
    description: definition.description,
    ...definition.input?.hint === undefined ? {} : { inputHint: definition.input.hint },
  }
}

/**
 * Bind the narrow {@link HostAcpSessionAccess} from the ONE already-settled Host
 * Context. The official Workspace/Session/Agent/Session services stay the sole
 * authority: this only forwards their callable methods, never their objects,
 * Context or lifecycle. A missing service is a Host composition failure (the
 * readiness audit already requires all four), never a silent fallback.
 *
 * `reflect.get` is used (not `ctx.<service>`) so this Host composition root does
 * not add client-boundary coupling debt; the service identities remain the
 * official ones the readiness audit asserts.
 *
 * @param context - the settled Host context.
 * @returns the narrow Session access the listener borrows from.
 */
export function createHostAcpSessionAccess(
  context: import('@deepseek-ai/cordis').Context,
  parseCommand?: (line: string) => { readonly name: string; readonly rawInput: string } | undefined,
  compactionEngineClass?: Function,
  planModeClass?: Function,
): HostAcpSessionAccess {
  const workspaceController = context.reflect.get('workspaceController') as WorkspaceControllerLike | undefined
  const sessionController = context.reflect.get('sessionController') as SessionControllerLike | undefined
  const agents = context.reflect.get('agents') as AgentRegistryLike | undefined
  const sessions = context.reflect.get('sessions') as SessionRegistryLike | undefined
  const attachments = context.reflect.get('attachments') as AttachmentServiceLike | undefined
  const llm = context.reflect.get('llm') as LlmServiceLike | undefined
  const agentDefaultModel = context.reflect.get('agentDefaultModel') as DefaultModelServiceLike | undefined
  const tools = context.reflect.get('tools') as ToolsServiceLike | undefined
  // Question capability is OPTIONAL: an environment without the official
  // `userQuestions`/`sessionProjections` services never pretends to answer an
  // ACP-owned question (the View fails it closed instead).
  const userQuestions = context.reflect.get('userQuestions') as UserQuestionServiceLike | undefined
  const sessionProjections = context.reflect.get('sessionProjections') as SessionProjectionServiceLike | undefined
  // Command/Skill/compaction capabilities are optional at the Host access
  // boundary: an absent service is a truthful capability absence, never a
  // fabricated empty catalog or a root-engine fallback.
  const commands = context.reflect.get('commands') as CommandRuntimeLike | undefined
  const agentPresets = context.reflect.get('agentPresets') as AgentPresetRegistryLike | undefined
  const workingDirectory = context.reflect.get('workingDirectory') as WorkingDirectoryLike | undefined
  const skills = context.reflect.get('skills') as SkillRegistryLike | undefined
  // The official canonical-history/title read plane is REQUIRED for a truthful
  // load/list advertisement: without it the listener advertises neither.
  const sessionQuery = context.reflect.get('sessionQuery') as SessionQueryReadLike | undefined
  if (
    workspaceController === undefined
    || sessionController === undefined
    || agents === undefined
    || sessions === undefined
    || llm === undefined
    || tools === undefined
  ) {
    throw new Error(
      'local host entry: the Host ACP Session View requires the live workspaceController, sessionController, agents, sessions, llm and tools services',
    )
  }
  const modelCatalog = (sessionController as { readonly modelCatalog?: unknown }).modelCatalog
  if (typeof modelCatalog !== 'function') {
    throw new Error('local host entry: the Host ACP Session View requires the official sessionController.modelCatalog service')
  }
  const modelService = new AcpSessionModelService({
    modelCatalog: async () => await sessionController.modelCatalog(),
    listProviders: () => llm.listProviders(),
    listModels: async providerId => await llm.listModels(providerId),
    resolveCallConfig: async (selection, signal) => {
      const resolved = await llm.resolveCallConfig(selection, signal)
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
    },
    currentAgent: sessionId => agents.get(sessionId) as unknown as AcpModelAgent | undefined,
    currentSession: sessionId => sessions.get(sessionId),
  })
  // The exact official policy authorities are resolved PER CALL: a retained
  // PlanModeController by instance identity and the root Team service by the
  // real subagent registry. Neither is cached as a second authority.
  // Re-read each official service at the operation boundary; an access-time
  // capture is not proof that the current root authority still exists.
  const currentAgentTeams = (): AgentTeamServiceLike | undefined =>
    context.reflect.get('agentTeams') as AgentTeamServiceLike | undefined
  const currentSubagents = (): SubagentRegistryLike | undefined =>
    context.reflect.get('subagents') as SubagentRegistryLike | undefined
  const currentProjections = (): SessionProjectionServiceLike | undefined =>
    context.reflect.get('sessionProjections') as SessionProjectionServiceLike | undefined
  const policyService = new AcpSessionPolicyService({
    currentAgent: sessionId => agents.get(sessionId),
    currentSession: sessionId => sessions.get(sessionId),
    planMode: agent => {
      if (planModeClass === undefined || agentPresets === undefined || !hasContext(agent as LiveAgentViewIdentity)) {
        return undefined
      }
      let service: unknown
      try {
        service = agentPresets.serviceFor(agent as { readonly ctx: object }, 'planMode')
      } catch {
        throw new Error('local host entry: the retained plan-mode service could not be resolved')
      }
      if (service === undefined) return undefined
      try {
        if (!(service instanceof planModeClass)) return undefined
      } catch {
        return undefined
      }
      const candidate = service as { get?: unknown; set?: unknown }
      if (typeof candidate.get !== 'function' || typeof candidate.set !== 'function') return undefined
      return service as AcpPlanModeService
    },
    team: agent => {
      const agentTeams = currentAgentTeams()
      const subagents = currentSubagents()
      const projections = currentProjections()
      if (agentTeams === undefined || subagents === undefined || projections === undefined) return undefined
      let root: object
      try {
        root = subagents.rootOf(agent)
      } catch {
        throw new Error('local host entry: the Agent Team root could not be resolved')
      }
      if (root !== agent) return undefined
      return agentTeams
    },
    teamEnabled: session => {
      const projections = currentProjections()
      if (projections === undefined) return undefined
      const value = projectionValueOf(projections, session, 'agentTeam')
      if (value === undefined) return undefined
      if (value === null || typeof value !== 'object') {
        throw new Error('local host entry: the official Agent Team projection is malformed')
      }
      const enabled = (value as { readonly enabled?: unknown }).enabled
      if (typeof enabled !== 'boolean') {
        throw new Error('local host entry: the official Agent Team projection carries no boolean')
      }
      return enabled
    },
    noOpenTurn: session => agents.turnBoundaryOf(session).openTurnStartSeq === null,
  })
  return {
    async createWorkspace(path: string): Promise<AcpCreateWorkspaceOutcome> {
      try {
        const result = await workspaceController.create({ path })
        return { kind: 'created', workspaceId: result.workspace.workspaceId, path: result.workspace.path }
      } catch (error) {
        // The official Workspace Controller wraps EVERY non-RemoteError failure
        // (including registry/persistence failures) as `workspace/invalid-path`,
        // and even a path rejection can occur after a partial registry change.
        // No official fact here can prove "no Workspace was created", so the
        // outcome is unconfirmed, never a definite client directory rejection.
        return { kind: 'indeterminate', code: remoteErrorCode(error) ?? 'workspace/internal' }
      }
    },
    async createSession(workspaceId: string): Promise<AcpCreateSessionOutcome> {
      try {
        return { kind: 'created', sessionId: (await sessionController.create({ workspaceId })).sessionId }
      } catch (error) {
        const code = remoteErrorCode(error) ?? 'session/internal'
        // These codes are thrown BEFORE the official Session is minted: the
        // request shape and the pre-create Workspace lookup both run first, so
        // "no Session was created" is proven.
        // `agent-preset/not-found|invalid` are NOT in this set: rc.3 can also
        // raise them from `composition.setup()` AFTER the Session handle was
        // persisted, so they cannot prove "not created" and stay unconfirmed.
        if (code === 'gateway/bad-request' || code === 'workspace/not-found') {
          return { kind: 'rejected', code }
        }
        // Official `SessionController.create` can publish a Session then fail a
        // later step (e.g. `workspace.attachSession`). Its details carry the real
        // created Session id, which the caller must preserve rather than treating
        // the whole create as unconfirmed.
        const sessionId = remoteErrorSessionId(error)
        if (code === 'session/workspace-attach-failed' && sessionId !== undefined) {
          return { kind: 'published-with-error', sessionId, code }
        }
        return { kind: 'indeterminate', code }
      }
    },
    resolveAgent: sessionId => sessionController.resolveAgent(sessionId),
    currentAgent: sessionId => agents.get(sessionId),
    currentSession: sessionId => sessions.get(sessionId),
    supportsSessionRead: () => sessionQuery !== undefined,
    readSessionList: async signal => await readAuthorizedSessionRows(sessionController, sessionQuery, signal),
    readSessionHistory: async (sessionId, signal) => {
      if (sessionQuery === undefined) {
        throw new Error('local host entry: no official sessionQuery service can read canonical Session history')
      }
      signal?.throwIfAborted()
      const snapshot = await sessionQuery.readSession(sessionId)
      signal?.throwIfAborted()
      return {
        header: headerFactsOf(snapshot.session),
        events: snapshot.events.map(event => ({ seq: event.seq, type: event.type, data: event.data, time: event.time })),
      } satisfies AcpSessionHistory
    },
    sessionHeaderFacts: async (sessionId, signal) => {
      // LIVE-FIRST: a currently attached child Session exposes the official
      // header directly, which is the exact identity the subagent edge names.
      // Only a child this Host cannot see live falls back to the query fold.
      const live = sessions.get(sessionId)
      if (live !== undefined) return headerFactsOf((live as { readonly header: SessionHeaderFactsLike }).header)
      if (sessionQuery === undefined) return undefined
      const [result] = await sessionQuery.readTitleSnapshots([sessionId], signal)
      if (result === undefined || result.status !== 'fulfilled') return undefined
      // The official observation carries the folded header as `value.session`;
      // its id must still be the exact Session this View asked about.
      const facts = headerFactsOf(result.value.session)
      return facts.sessionId === sessionId ? facts : undefined
    },
    contextPressure: session => projectionValueOf(sessionProjections, session, 'contextPressure'),
    sessionTodos: session => projectionValueOf(sessionProjections, session, 'todos'),
    mountScopedMcp: async (agent, session, servers, stillCurrent, signal) => {
      // The exact Host identities are re-verified synchronously before the
      // Agent-scoped maintenance window can mount any child process.
      const liveAgent = agents.get(agent.id)
      const liveSession = sessions.get(agent.id)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) {
        throw new AcpScopedMcpError('STALE', 'the exact Host Agent/Session is no longer current')
      }
      const authority: AcpScopedMcpToolAuthority = {
        definitions: (scope?: object) => scope === undefined ? tools.definitions() : tools.definitions(scope),
      }
      return await mountAcpScopedMcp({
        agent: agent as unknown as AcpScopedMcpAgent,
        session,
        servers,
        tools: authority,
        stillCurrent,
        signal,
      })
    },
    requestRetireScopedMcp: async lease => await retireAcpScopedMcp(lease),
    // Session-only model capability: this narrow pair is the ONLY model write
    // surface the ACP View can reach. It never exposes the profile default.
    modelOptions: async (agent, session) => await modelService.readOptions(agent as unknown as AcpModelAgent, session),
    selectModelOnly: async (agent, session, request, signal, stillCurrent) =>
      await modelService.selectSessionOnly(agent as unknown as AcpModelAgent, session, request, signal, stillCurrent),
    // Session policy capability: the ONLY mode/Team surface the ACP View can
    // reach. The retained official service identity and the exact Agent/Session
    // are re-resolved per call; a missing service is absence, a failed read is
    // unavailable.
    readSessionPolicy: (agent, session): AcpSessionPolicyState => {
      if (agents.get(agent.id) !== agent || sessions.get(agent.id) !== session || agent.session !== session) {
        throw stalePolicy()
      }
      return policyService.read(agent as unknown as AcpSessionPolicyAgent)
    },
    selectSessionPolicy: async (agent, session, request: AcpSessionPolicyRequest, signal, stillCurrent) => {
      if (agents.get(agent.id) !== agent || sessions.get(agent.id) !== session || agent.session !== session) {
        throw stalePolicy()
      }
      await policyService.select(agent as unknown as AcpSessionPolicyAgent, request, signal, stillCurrent)
    },
    imageLimits: () => attachments?.imageLimits,
    // The ONE official Host Attachment Store reads and verifies the committed
    // image; the View never sees a Host path, a second store or an unverified
    // `ref.bytes`. A missing Store rejects this read instead of fabricating an
    // empty image or an `end_turn`.
    readOutputImage: async (ref, signal) => {
      if (attachments === undefined) {
        throw new Error('local host entry: no official attachment store can read a committed output image')
      }
      const stored = await attachments.readImage(ref, signal)
      return { data: stored.data, mediaType: stored.ref.mediaType }
    },
    supportsImagePrompts: async () => {
      if (attachments === undefined || llm === undefined || agentDefaultModel === undefined) return false
      try {
        const route = agentDefaultModel.currentSelection()
        if (route === undefined
          || !attachments.imageLimits.mediaTypes.some(mediaType => (ACP_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType))) {
          return false
        }
        const model = await llm.resolveModelInfo(route.provider, route.model)
        return model.inputModalities?.includes('image') === true
      } catch {
        return false
      }
    },
    prompt: async (request, signal) => {
      if (!request.content.some(part => part.type === 'image')) {
        return await sessionController.prompt(request, signal)
      }
      signal.throwIfAborted()
      const agent = agents.get(request.sessionId) as ImageRouteAgentLike | undefined
      const session = sessions.get(request.sessionId)
      if (agent === undefined || session === undefined || agent.session !== session || agent.model === undefined) {
        throw imageRouteError('IMAGE_ROUTE_UNKNOWN', 'the attached Agent route is unavailable for image input')
      }
      const route = agent.model.current()
      if (route === undefined || route.provider.length === 0 || route.model.length === 0 || llm === undefined) {
        throw imageRouteError('IMAGE_ROUTE_UNKNOWN', 'the attached Agent route is unavailable for image input')
      }
      let model: Awaited<ReturnType<LlmServiceLike['resolveModelInfo']>>
      try {
        model = await llm.resolveModelInfo(route.provider, route.model)
      } catch {
        throw imageRouteError('IMAGE_ROUTE_UNKNOWN', 'the attached Agent route could not be verified for image input')
      }
      if (model.inputModalities?.includes('image') !== true) {
        throw imageRouteError('MODEL_DOES_NOT_SUPPORT_IMAGES', 'the attached Agent route does not declare image input')
      }
      // DSH rc.3 session-controller/src/commands.ts:349-386 checks the route
      // inside its image-admission chain but permits unknown modalities. A
      // concurrent selectModel can follow this preflight; the PO-4A PR records
      // the Owner-accepted upstream limitation and its barrier evidence.
      signal.throwIfAborted()
      const currentAgent = agents.get(request.sessionId)
      const currentSession = sessions.get(request.sessionId)
      const currentRoute = (currentAgent as ImageRouteAgentLike | undefined)?.model?.current()
      if (currentAgent !== agent || currentSession !== session || agent.session !== session
        || currentRoute?.provider !== route.provider || currentRoute.model !== route.model) {
        throw imageRouteError('IMAGE_ROUTE_CHANGED', 'the attached Agent route changed during image capability verification')
      }
      return await sessionController.prompt(request, signal)
    },
    cancelPending: (sessionId, agent, session, messageId) => {
      // The EXACT live identity is re-verified synchronously: only the very
      // Agent/Session objects this View attached may be touched.
      const liveAgent = agents.get(sessionId)
      const liveSession = sessions.get(sessionId)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) return 'stale'
      return (agent as unknown as AgentCancelSeamLike).inbox.remove(messageId) === true ? 'removed' : 'not-pending'
    },
    pendingMessage: (sessionId, agent, session, messageId) => {
      const liveAgent = agents.get(sessionId)
      const liveSession = sessions.get(sessionId)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) return 'stale'
      const inbox = (agent as unknown as AgentCancelSeamLike).inbox
      return inbox.nextTurn.some(message => message.id === messageId)
        || inbox.nextStep.some(message => message.id === messageId) ? 'pending' : 'absent'
    },
    cancelCurrentTurn: (sessionId, agent, session, turn) => {
      const liveAgent = agents.get(sessionId)
      const liveSession = sessions.get(sessionId)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) return 'stale'
      // The official current-turn fence must STILL point at this exact turn.
      const boundary = agents.turnBoundaryOf(session)
      if (boundary.openTurnStartSeq === null || boundary.lastTurn !== turn) return 'not-current'
      if ((agent as unknown as AgentStatusSeamLike).status !== 'running') return 'not-current'
      ;(agent as unknown as AgentCancelSeamLike).cancel({ kind: 'user' }, { keepInbox: true })
      return 'addressed'
    },
    currentTurn: (sessionId, agent, session) => {
      const liveAgent = agents.get(sessionId)
      const liveSession = sessions.get(sessionId)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) return { kind: 'stale' }
      const boundary = agents.turnBoundaryOf(session)
      return { kind: 'current', openTurn: boundary.openTurnStartSeq === null ? null : boundary.lastTurn }
    },
    hasQuestionService: () => userQuestions !== undefined && sessionProjections !== undefined,
    questionSnapshot: (sessionId, agent, session): AcpQuestionSnapshot => {
      // The EXACT live identity is re-verified: a projection read for a
      // replaced Agent or a different Session object is never a question fact.
      const liveAgent = agents.get(sessionId)
      const liveSession = sessions.get(sessionId)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) return { kind: 'stale' }
      if (sessionProjections === undefined) return { kind: 'unavailable' }
      const state = sessionProjections.stateOf(session, 'userQuestions') as UserQuestionProjectionStateLike | undefined
      // The unit is registered by the official question service; an absent key
      // is capability absence, never an authoritative empty projection.
      if (state === undefined) return { kind: 'unavailable' }
      return {
        kind: 'current',
        continued: state.questions.active
          .filter(question => question.state === 'continued')
          .map(question => ({ callId: question.callId, questions: question.questions })),
        settled: new Set(state.questions.settled.map(question => question.callId)),
      }
    },
    answerContinued: (sessionId, agent, session, callId, answer, stillCurrent): AcpContinuedAnswerOutcome => {
      // The VIEW ownership fence comes first and is read synchronously: a late
      // answer of a closed/detached/re-bound View must never reach the shared
      // Session even when the Agent/Session objects are still live.
      if (!stillCurrent()) return { kind: 'stale' }
      const liveAgent = agents.get(sessionId)
      const liveSession = sessions.get(sessionId)
      if (liveAgent !== agent || liveSession !== session || agent.session !== session) return { kind: 'stale' }
      if (userQuestions === undefined) return { kind: 'unavailable' }
      try {
        // The official service owns the whole taxonomy: `true` is a queued
        // reply, `false` is "no longer continued", and its rejections keep
        // their exact code (REPLY_QUEUED / BAD_ANSWER / CALLER_NOT_LIVE).
        return userQuestions.answer(agent, callId, {
          answers: answer.answers.map(item => ({
            id: item.id,
            selected: [...item.selected],
            ...item.custom === undefined ? {} : { custom: item.custom },
          })),
        })
          ? { kind: 'queued' }
          : { kind: 'not-continued' }
      } catch (error) {
        return { kind: 'rejected', code: remoteErrorCode(error) ?? 'question/answer-failed' }
      }
    },
    /**
     * Read the effective official command registry. Only the audited
     * `feedback` identity and the audited retained compact composition are
     * advertised; other effective Host names remain visible for precedence and
     * explicit unsupported routing.
     */
    readCommandCatalog(agent, session): AcpCommandCatalogRead {
      assertExactHostIdentity(agents, sessions, agent, session)
      if (commands === undefined) return EMPTY_COMMAND_CATALOG
      let effective: readonly CommandDescriptorLike[]
      let feedback: CommandDescriptorLike | undefined
      let compact: CommandDescriptorLike | undefined
      try {
        effective = commands.list(agent as never)
        feedback = commands.find(agent as never, 'feedback')
        compact = commands.find(agent as never, 'compact')
      } catch {
        throw new AcpHostCommandError('unavailable', 'the official command registry could not be read')
      }
      const feedbackState = feedback === undefined
        ? 'missing' as const
        : String(feedback.definitionId) === FEEDBACK_DEFINITION_ID
          ? 'available' as const
          : 'shadowed' as const
      let compactState: AcpCommandCatalogRead['compact']
      if (compact === undefined) compactState = 'missing'
      else if (String(compact.definitionId) !== COMPACT_DEFINITION_ID) compactState = 'shadowed'
      else compactState = auditedCompactionEngine(agent, agentPresets, compactionEngineClass) === undefined ? 'unavailable' : 'available'
      const rows: AcpCommandCatalogRow[] = []
      if (feedbackState === 'available' && feedback !== undefined) rows.push(commandRow(feedback))
      if (compactState === 'available' && compact !== undefined) rows.push(commandRow(compact))
      return {
        effectiveNames: effective.map(descriptor => descriptor.name),
        feedback: feedbackState,
        compact: compactState,
        rows,
      }
    },

    /**
     * Read the native Skill catalog from the exact retained loader composition
     * and the official committed working directory. No list() fallback, no
     * header cwd and no same-name tool heuristic is accepted.
     */
    async readNativeSkills(agent, session, signal): Promise<AcpNativeSkillCatalog> {
      assertExactHostIdentity(agents, sessions, agent, session)
      signal.throwIfAborted()
      if (agentPresets === undefined || !hasContext(agent) || !hasNativeSkillLoader(agent, agentPresets)) {
        return { kind: 'absent' }
      }
      if (workingDirectory === undefined) return { kind: 'absent' }
      const registry = readSkillRegistry(agent, agentPresets, skills)
      if (registry === undefined) return { kind: 'absent' }
      const cwd = workingDirectory.get(session)
      if (typeof cwd !== 'string' || cwd.length === 0 || !cwd.startsWith('/')) {
        throw new AcpHostCommandError('unavailable', 'the exact Session has no effective working directory')
      }
      let observed: Awaited<ReturnType<SkillRegistryLike['snapshot']>>
      try {
        observed = await registry.snapshot({ cwd, scope: agent as never, signal })
      } catch (error) {
        if (signal.aborted) throw error
        throw new AcpHostCommandError('unavailable', 'the native Skill catalog could not be read')
      }
      signal.throwIfAborted()
      assertExactHostIdentity(agents, sessions, agent, session)
      if (workingDirectory.get(session) !== cwd || !hasNativeSkillLoader(agent, agentPresets)) {
        throw new AcpHostCommandError('stale', 'the native Skill scope changed during the catalog read')
      }
      // The snapshot is accepted only while the exact retained service still
      // resolves to the same registry authority. A replacement that happens
      // across the await cannot be smuggled in behind a stale snapshot.
      const currentRegistry = readSkillRegistry(agent, agentPresets, skills)
      if (currentRegistry !== registry) {
        throw new AcpHostCommandError('stale', 'the native Skill registry changed during the catalog read')
      }
      if (observed.complete !== true) {
        throw new AcpHostCommandError('unavailable', 'the native Skill catalog is incomplete')
      }
      const rows = observed.skills
        .filter(skill => skill.invocation?.userInvocable === true)
        .map(skill => {
          if (typeof skill.name !== 'string' || skill.name.length === 0 || typeof skill.description !== 'string') return undefined
          return { kind: 'skill' as const, name: skill.name, description: skill.description }
        })
        .filter((row): row is { readonly kind: 'skill'; readonly name: string; readonly description: string } => row !== undefined)
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      return { kind: 'available', cwd, skills: rows }
    },

    /** Execute the ONE approved standalone command through the official runtime. */
    executeStandaloneCommand(agent, session, line, signal): Promise<unknown> {
      assertExactHostIdentity(agents, sessions, agent, session)
      if (commands === undefined) throw new AcpHostCommandError('unavailable', 'the official command runtime is unavailable')
      let definition: CommandDescriptorLike | undefined
      try {
        definition = commands.find(agent as never, 'feedback')
      } catch {
        throw new AcpHostCommandError('unavailable', 'the official command registry could not be read')
      }
      if (definition === undefined) throw new AcpHostCommandError('unavailable', 'the approved command is no longer registered')
      if (String(definition.definitionId) !== FEEDBACK_DEFINITION_ID) {
        throw new AcpHostCommandError('unsupported', 'the effective command is not the approved definition')
      }
      return commands.execute(agent as never, line, [], signal)
    },

    /** Enter the exact retained official manual-compaction engine. */
    parseCommand: line => parseCommand?.(line),
    executeManualCompact(agent, session, signal): Promise<unknown> {
      assertExactHostIdentity(agents, sessions, agent, session)
      if (commands === undefined) throw new AcpHostCommandError('unavailable', 'the official command runtime is unavailable')
      let definition: CommandDescriptorLike | undefined
      let engine: CompactionEngineLike | undefined
      try {
        definition = commands.find(agent as never, 'compact')
        engine = auditedCompactionEngine(agent, agentPresets, compactionEngineClass)
      } catch {
        throw new AcpHostCommandError('unavailable', 'the official compaction composition could not be read')
      }
      if (definition === undefined) throw new AcpHostCommandError('unavailable', 'the approved compact command is no longer registered')
      if (String(definition.definitionId) !== COMPACT_DEFINITION_ID) {
        throw new AcpHostCommandError('unsupported', 'the effective compact command is not the approved definition')
      }
      if (engine === undefined) throw new AcpHostCommandError('unavailable', 'the exact retained compaction engine is unavailable')
      try {
        return engine.compactNow(agent as never, signal)
      } catch (error) {
        // `compactNow` performs its official synchronous admission (busy,
        // disposed signal) before returning its Promise. Preserve that real
        // rejection as the operation settlement instead of turning it into an
        // unrelated dispatch failure.
        return Promise.reject(error)
      }
    },

    /**
     * Subscribe the View owner to the exact Host facts a prompt flight is
     * correlated against. The Host Context, registries and Agent/Session objects
     * stay on this side: only the observed identity payloads are forwarded, and
     * the returned disposer removes exactly these listeners. The ONE approval
     * classification seat is registered with `prepend: true` so it runs AHEAD
     * of the TUI forwarding listener: a proven ACP-owned approval is answered
     * (or fail-closed) without ever reaching `next()`.
     */
    observePromptFacts(listener: AcpPromptFactListener): () => void {
      const disposers = [
        context.on('agent/inbox/inserted', payload => {
          listener.onInboxInserted(payload.agent, payload.message)
        }),
        context.on('agent/inbox/claimed', payload => {
          listener.onInboxClaimed(payload.agent, payload.message, payload.turn)
        }),
        // The official discard notice is the documented way to learn which
        // message an ordinary inbox removal dropped (v1.1 §4 terminal proof).
        context.on('agent/inbox/discarded', payload => {
          listener.onInboxDiscarded(payload.agent, payload.message)
        }),
        context.on('session/event', (session, event) => {
          listener.onSessionEvent(session, event)
        }),
        // Effective command/Skill registry invalidations are unfiltered by
        // contract: each attached claim re-reads its own exact scope.
        context.on('commands/change', () => {
          listener.onCommandCatalogInvalidated()
        }),
        context.on('skills/change', () => {
          listener.onSkillCatalogInvalidated()
        }),
        // A preset tool/loader recomposition can change the retained Skill
        // registry without a `skills/change`; it is an invalidation only, never
        // a tool-list authority.
        context.on('tools/change', () => {
          listener.onSkillCatalogInvalidated()
          // A recomposition can add/remove the retained PlanMode/Team
          // authority: re-read it instead of trusting the projected rows.
          listener.onPolicyAvailabilityInvalidated()
        }),
        // The transient provisional output of one emitting Agent. It is the
        // SAME official frame the Direct TUI consumes; here it is correlated to
        // an owned prompt flight and never persisted.
        context.on('agent/assistant-stream', payload => {
          listener.onAssistantStream(payload.agent, payload.frame)
        }),
        // The OFFICIAL question projection change feed. It is the only
        // continued-answerability source; the View re-reads the exact Session.
        ...sessionProjections === undefined
          ? []
          : [sessionProjections.onChanged((session, key) => {
            listener.onQuestionProjection(session, key)
          })],
        context.on('agent/error', payload => {
          listener.onAgentError(payload.agent, payload.turn)
        }),
        context.on('agent/disposed', payload => {
          listener.onAgentDisposed(payload.agent)
        }),
        // The official subagent lifecycle edges. The View cross-checks the
        // child Session header (origin + durable creator) before announcing an
        // association; nothing here invents a parent/child relationship.
        context.on('subagent/start', info => {
          listener.onSubagentStart({
            runId: String(info.runId),
            id: String(info.id),
            parentSessionId: String(info.parentSessionId),
            local: info.local,
          })
        }),
        context.on('subagent/end', info => {
          listener.onSubagentEnd({
            runId: String(info.runId),
            id: String(info.id),
            parentSessionId: String(info.parentSessionId),
            local: info.local,
            stopReason: String(info.stopReason),
          })
        }),
        // The ONE question classification seat of the shared waterfall. It is
        // prepended for the same reason as the approval seat: a proven
        // ACP-owned question is answered (or fails closed) here and never
        // delegated to the TUI, while a foreign question calls `next()` once.
        context.on('user-questions/request', async (request, next) => {
          const answer = await listener.onQuestionRequest(
            {
              ...request.agent === undefined ? {} : { agent: request.agent },
              questions: request.questions,
              ...request.signal === undefined ? {} : { signal: request.signal },
              ...request.wait === undefined ? {} : { wait: request.wait },
            },
            // A foreign (TUI/autonomous) question keeps its existing seat: the
            // downstream answerer runs exactly once, and the View never rewrites
            // the batch it returns.
            async () => await next(),
          )
          return detachAnswerBatch(answer)
        }, { prepend: true }),
        context.on('approval/request', (request, next) => {
          return listener.onApprovalRequest(
            {
              agent: request.agent,
              toolName: request.toolName,
              ...(request.callId === undefined ? {} : { callId: request.callId }),
              ...(request.reason === undefined ? {} : { reason: request.reason }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            },
            async () => await next(),
          )
        }, { prepend: true }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  }
}

/**
 * Read the official authorized Session roster plus the durable title fold of
 * EXACTLY those ids. Titles are read only for ids the Session Controller
 * already admitted, so an ACP client can never receive an unauthorized title.
 * A per-session title failure leaves that row without a title instead of
 * failing the whole roster.
 */
async function readAuthorizedSessionRows(
  sessionController: SessionControllerLike,
  sessionQuery: SessionQueryReadLike | undefined,
  signal: AbortSignal | undefined,
): Promise<readonly AcpSessionReadRow[]> {
  const page = await sessionController.list({}, signal ?? new AbortController().signal)
  const rows: AcpSessionReadRow[] = page.items.map(item => ({
    sessionId: item.sessionId,
    updatedAt: item.updatedAt,
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(item.origin === undefined ? {} : { origin: item.origin }),
  }))
  if (sessionQuery === undefined || rows.length === 0) return rows
  const titles = new Map<string, string>()
  for (const result of await sessionQuery.readTitleSnapshots(rows.map(row => row.sessionId), signal)) {
    if (result.status !== 'fulfilled') continue
    const title = result.value.title?.title
    if (title !== undefined && title.length > 0) titles.set(result.sessionId, title)
  }
  return rows.map(row => {
    const title = titles.get(row.sessionId)
    return title === undefined ? row : { ...row, title }
  })
}

/** Project one official Session header onto the neutral history facts. */
function headerFactsOf(header: SessionHeaderFactsLike): AcpHistoryHeader {
  return {
    sessionId: header.id,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
  }
}

/** Read ONE detached official projection value of the exact Session, or `undefined`. */
function projectionValueOf(
  projections: SessionProjectionServiceLike | undefined,
  session: object,
  key: string,
): unknown {
  if (projections === undefined) return undefined
  return projections.snapshot(session, [key]).values[key]
}

/** Detach one official answer batch into the mutable wire shape consumers expect. */
function detachAnswerBatch(answer: AcpQuestionAnswer): { answers: Array<{ id: string; selected: string[]; custom?: string }> } {
  return {
    answers: answer.answers.map(item => ({
      id: item.id,
      selected: [...item.selected],
      ...item.custom === undefined ? {} : { custom: item.custom },
    })),
  }
}

/** A stable code from an official RemoteError without importing its class. */
function remoteErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/** The authoritative created Session id an official `published-with-error` carries. */
function remoteErrorSessionId(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'details' in error) {
    const details = (error as { readonly details?: { readonly sessionId?: unknown } }).details
    const sessionId = details?.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  }
  return undefined
}

/**
 * Create the ONE Host-entry-owned ACP runtime controller.
 *
 * The controller owns no durable "enabled" flag: the ONLY authority is the live
 * `LocalAcpListener` handle plus its own `isListening()` (a real `net.Server`
 * listening with the exact saved socket inode). `getStatus` therefore reports
 * `enabled` only when the socket really is serving and `disabled` only when no
 * listener handle exists; a bind/close in flight is `changing`; a handle that is
 * no longer listening is a truthful `unavailable`. Every bind/close joins ONE
 * serialized promise chain so at most one transition runs at a time.
 */
export function createAcpController(options: AcpControlControllerOptions): AcpControlController {
  const { scope, maxConnections, diag, sessionAccess } = options
  // ONE View/claim registry for this controller's whole lifetime: an Off ->
  // On rebind must not lose a retired-turn approval fence (or any claim), or
  // the fresh registry would let a new connection bypass one-View-per-Session
  // and delegate the old turn's approval to the TUI.
  const views = sessionAccess === undefined ? undefined : new AcpSessionViewRegistry(diag)
  let listener: LocalAcpListener | undefined
  let tail: Promise<unknown> = Promise.resolve()
  let inFlight = 0
  let quiescing = false

  const describe = (): AcpAccessStatus => {
    if (inFlight > 0) return { state: 'changing' }
    if (listener === undefined) return { state: 'disabled' }
    return listener.isListening()
      ? { state: 'enabled' }
      : { state: 'unavailable', reason: 'the local ACP listener is not accepting connections' }
  }

  const apply = async (enabled: boolean): Promise<AcpAccessStatus> => {
    // A quiescing controller refuses every new transition; the caller sees the
    // truthful shut-down state instead of a fabricated outcome.
    if (quiescing) return { state: 'unavailable', reason: 'the Host is shutting down' }
    inFlight += 1
    try {
      // Qualification-only barrier: hold the controller INSIDE an accepted
      // mutation so a launcher can prove SIGTERM is admitted while a transition
      // is genuinely in flight (never inferred from send-time proximity).
      const mutationBarrier = process.env.SPLIT_PROCESS_HOST_ACP_MUTATION_BARRIER
      if (mutationBarrier !== undefined && mutationBarrier !== '') {
        writeEntryRecord({ m4a0: 'qualification', processRole: 'host', op: 'acp-mutation-start', pid: process.pid })
        await waitForQualificationBarrier(mutationBarrier)
      }
      if (enabled) {
        // Idempotent enable: an already-listening listener touches nothing.
        if (listener !== undefined && listener.isListening()) return { state: 'enabled' }
        // A handle that is no longer listening is retired before a fresh bind;
        // the original safety checks in `startLocalAcpListener` still gate it.
        if (listener !== undefined) {
          const stale = listener
          listener = undefined
          try {
            await stale.close()
          } catch (error) {
            diag.warn('local-acp.error', { code: 'LOCAL_ACP_CLOSE_FAILED', cause: String(error) })
          }
        }
        listener = await startLocalAcpListener({
          scope,
          maxConnections,
          diag,
          ...(sessionAccess === undefined ? {} : { sessionAccess, views }),
        })
        return listener.isListening()
          ? { state: 'enabled' }
          : { state: 'unavailable', reason: 'the local ACP listener failed to bind' }
      }
      // Disable: drop the reference BEFORE the async close so a status read
      // during the close cannot claim `enabled` for a listener being retired.
      if (listener === undefined) return { state: 'disabled' }
      const current = listener
      listener = undefined
      try {
        await current.close()
      } catch (error) {
        diag.warn('local-acp.error', { code: 'LOCAL_ACP_CLOSE_FAILED', cause: String(error) })
        return { state: 'unavailable', reason: 'the local ACP listener could not be closed' }
      }
      return { state: 'disabled' }
    } finally {
      inFlight -= 1
    }
  }

  // ONE serialized chain: a failed transition never poisons the following entry.
  const serialize = (operation: () => Promise<AcpAccessStatus>): Promise<AcpAccessStatus> => {
    const run = tail.then(operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    getStatus: async () => describe(),
    setEnabled: (enabled: boolean) => serialize(() => apply(enabled)),
    quiesce: () => {
      quiescing = true
    },
    close: () =>
      serialize(async () => {
        quiescing = true
        if (listener !== undefined) {
          const current = listener
          listener = undefined
          try {
            await current.close()
          } catch (error) {
            diag.warn('local-acp.error', { code: 'LOCAL_ACP_CLOSE_FAILED', cause: String(error) })
          }
        }
        // The CONTROLLER owns the shared registry's ONE Host fact/approval
        // subscription across rebinds (R701-03), so it releases it here — and
        // only after every accepted piece of work settled on real Host facts,
        // detached so the Host shutdown itself is never blocked by a shared
        // turn it may not cancel (D23).
        const viewsToRetire = views
        if (viewsToRetire !== undefined && viewsToRetire.hasFactsObserver()) {
          runDetached('local acp: shared fact subscription retirement', async () => {
            await viewsToRetire.whenHostWorkSettled()
            viewsToRetire.disposeFacts()
          }, { diag })
        }
        return { state: 'disabled' }
      }).then(() => undefined),
    cleanupSync: () => {
      listener?.cleanupSync()
    },
  }
}

/**
 * Apply the profile-owned ACP startup preference BEFORE the Host becomes Ready.
 *
 * `autoStart` is read from the SAME `ctx` that already settled the profile: a
 * missing settings service, a missing `pi-tui-acp-preferences` section or a
 * non-boolean value is a corrupted composition and fails Host startup loudly
 * (never "treated as Off"). A failing ACP enable is a bounded diagnostic: the
 * ACP listener is an optional add-on, so the Host keeps its Session/Agent/
 * Gateway graph and publishes Ready with the listener in whatever state the
 * controller truthfully reports. The diagnostic is a FIXED record (a failure
 * category plus the small state vocabulary), never an exception message or a
 * socket path.
 *
 * @param context - the Host context that already settled the profile.
 * @param controller - the entry-owned ACP runtime controller.
 * @param emit - the structured record sink (the entry emits on its control channel).
 */
export async function applyAcpStartupPreference(
  context: import('@deepseek-ai/cordis').Context,
  controller: AcpControlController | undefined,
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
): Promise<void> {
  const settings = context.get('settings') as HostSettingsServiceLike | undefined
  if (settings === undefined || typeof settings.describe !== 'function') {
    throw new Error('local host entry: the Host has no settings service, so the ACP startup preference cannot be read')
  }
  const descriptor = (settings.describe() ?? []).find(entry => entry.ns === ACP_STARTUP_PREFERENCE_NAMESPACE)
  if (descriptor === undefined) {
    throw new Error('local host entry: the profile projects no "pi-tui-acp-preferences" settings section')
  }
  const value = descriptor.value
  const autoStart = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { readonly autoStart?: unknown }).autoStart
    : undefined
  // The schema owns the boolean strictly; anything else means the section was
  // projected by a different composition, not a missing user choice.
  if (typeof autoStart !== 'boolean') {
    throw new Error('local host entry: "pi-tui-acp-preferences.autoStart" is not a boolean')
  }
  if (!autoStart) return
  const unavailable = (failure: AcpAutostartFailure, state?: string): void => {
    emit({
      m4a0: 'diagnostic',
      processRole: 'host',
      pid: process.pid,
      code: 'acp-autostart-unavailable',
      failure,
      ...(state === undefined ? {} : { state }),
    })
  }
  if (controller === undefined) {
    unavailable('controller-missing')
    return
  }
  let status: AcpAccessStatus
  try {
    status = await controller.setEnabled(true)
  } catch {
    // The exception text is deliberately dropped: it can carry a socket path or
    // a system error string. The controller's own state is the visible truth.
    unavailable('mutation-failed')
    return
  }
  if (status.state !== 'enabled') {
    unavailable('not-enabled', status.state)
    return
  }
  emit({
    m4a0: 'acp-autostart',
    processRole: 'host',
    pid: process.pid,
    phase: 'pre-ready',
    status: 'enabled',
  })
}

interface HostConnectionService {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly string[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
  authenticatedUrl(baseUrl: string): string
}

interface HostWebServerService {
  readonly host: string
  readonly port: number
  getOrigin(): string
}

/** The narrow existing Web authority the CLI adapter borrows (never re-owned). */
interface HostWebAccessService {
  getStatus(): Promise<PiTuiWebAccessStatus>
  setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus>
  getAuthenticatedUrl(): Promise<{ readonly url: string }>
}

interface PublishedLocalHost {
  readonly identity: LocalInstanceRecord
  /** Release ALL entry-owned exact routes (identity echo, the read-only
   *  workspace-object observation, the read-only ACP status observation, the
   *  headless ACP CLI adapter and the headless Web CLI adapter) before the
   *  official shutdown runs. */
  unregisterRoutes(): Promise<void>
}

/**
 * Publish the authenticated identity and private launch material, then commit
 * the registry as the Ready step. The route is registered before the registry
 * so no Client can observe a registry whose identity route is missing.
 */
async function publishLocalHost(
  context: import('@deepseek-ai/cordis').Context,
  scope: LocalScope,
  hostIdentity: HostProcessIdentity,
  seat: ProcessSeat,
  acpController: AcpControlController,
): Promise<PublishedLocalHost> {
  const connection = context.get('connection') as unknown as HostConnectionService | undefined
  if (connection === undefined || typeof connection.authenticatedUrl !== 'function' || typeof connection.fetch?.register !== 'function') {
    throw new Error('local host entry: the official Connection service is not live')
  }
  const webServer = context.get('webServer') as unknown as HostWebServerService | undefined
  if (webServer === undefined || webServer.host !== '127.0.0.1' || webServer.port < 1) {
    throw new Error('local host entry: the official webserver is not a bound loopback listener')
  }
  // The SAME Host Web authority the TUI `/web` control uses. A missing service
  // is a real composition error before Ready; the CLI adapter never creates a
  // second Web service or falls back to a Direct path.
  const webAccess = context.get(PI_TUI_WEB_ACCESS_NAMESPACE) as unknown as HostWebAccessService | undefined
  if (webAccess === undefined) {
    throw new Error('local host entry: the private piTuiWebAccess Host service is not live')
  }
  const origin = webServer.getOrigin()
  const loopbackPrefix = 'http://127.0.0.1:'
  if (!origin.startsWith(loopbackPrefix) || !/^\d+$/u.test(origin.slice(loopbackPrefix.length))) {
    throw new Error('local host entry: B1 requires one canonical loopback HTTP origin')
  }
  // The /connect route is owned by the Connection plugin; prove it is live
  // before exposing any token material.
  await waitForRefusal(`${origin}/connect`)

  const instanceId = randomUUID()
  const shared = {
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId,
    hostPid: process.pid,
    origin,
    protocol: LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
  } as const
  // The authenticated echo and the registry share ONE canonical builder so
  // Linux schema 1 keeps its frozen key order.
  const identity: LocalInstanceRecord = buildHostInstanceRecord(shared, hostIdentity)
  const connectUrl = connection.authenticatedUrl(`${origin}/connect`)
  const connectProbe = new URL(connectUrl)
  if (
    connectProbe.origin !== origin
    || connectProbe.pathname !== '/connect'
    || connectProbe.searchParams.getAll('token').length !== 1
    || [...connectProbe.searchParams.keys()].length !== 1
  ) {
    throw new Error('local host entry: the Connection owner returned an unexpected launch URL')
  }

  const { writeLaunchMaterial, writeLocalRecord } = await import('./local-discovery.ts')
  writeLaunchMaterial(scope, identity, { schema: 1, instanceId, connectUrl })
  let unregisterIdentity: (() => Promise<void>) | undefined
  let unregisterWorkspaceObject: (() => Promise<void>) | undefined
  let unregisterAcpStatus: (() => Promise<void>) | undefined
  let unregisterAcpControl: (() => Promise<void>) | undefined
  let unregisterWebControl: (() => Promise<void>) | undefined
  try {
    unregisterIdentity = connection.fetch.register({
      path: '/api/pi-tui.local-host',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => Response.json(identity, {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      }),
    })
    // The read-only directory-object observation joins the SAME official
    // Owner-only admission and the SAME publication lifetime. It never
    // registers a Workspace or returns file content.
    unregisterWorkspaceObject = connection.fetch.register({
      path: LOCAL_WORKSPACE_OBJECT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createWorkspaceObjectHandler(instanceId),
    })
    // PO-5D: the read-only ACP status observation joins the SAME official
    // Owner-only admission and publication lifetime. It answers the ONE live
    // controller read and never mutates, caches or reflects a path.
    unregisterAcpStatus = connection.fetch.register({
      path: LOCAL_ACP_STATUS_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: createLocalAcpStatusHandler(instanceId, acpController),
    })
    // The headless ACP CLI adapter joins the SAME official Owner-only admission
    // and the SAME publication lifetime. It borrows the ONE Host-entry ACP
    // runtime controller and never holds ACP state of its own.
    unregisterAcpControl = connection.fetch.register({
      path: LOCAL_ACP_CONTROL_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createLocalAcpControlHandler(instanceId, acpController),
    })
    // The headless Web CLI adapter joins the SAME official Owner-only admission
    // and the SAME publication lifetime. It borrows the existing Web service
    // and never holds status, tokens or a mutation queue of its own.
    unregisterWebControl = connection.fetch.register({
      path: LOCAL_WEB_CONTROL_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: createLocalWebControlHandler(instanceId, webAccess),
    })
    // Admission runs before the exact routes; this proves every route sits
    // behind the official Connection owner rather than a bare webserver
    // handler. The POST probe uses the read-only `url` operation so a broken
    // fence cannot toggle Web during publication.
    await waitForRefusal(`${origin}/api/pi-tui.local-host`)
    await waitForRefusal(`${origin}${LOCAL_WORKSPACE_OBJECT_ROUTE}`, 10_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId, path: scope.profileRealpath }),
    })
    await waitForRefusal(`${origin}${LOCAL_ACP_STATUS_ROUTE}`)
    // The write probe carries a legal `enable` body under THIS instance so a
    // broken Owner fence would actually toggle the listener: the following
    // status/daemon verdicts are real business negatives, never a shape check.
    await waitForRefusal(`${origin}${LOCAL_ACP_CONTROL_ROUTE}`, 10_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 1, instanceId, op: 'enable' }),
    })
    await waitForRefusal(`${origin}${LOCAL_WEB_CONTROL_ROUTE}`)
    await waitForRefusal(`${origin}${LOCAL_WEB_CONTROL_ROUTE}`, 10_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 1, instanceId, op: 'url' }),
    })
    // The READY commit re-proves BOTH authorities immediately before the
    // registry becomes discoverable: the kernel process identity is still the
    // one this Host captured, and the singleton seat is still held. A replaced
    // seat/inode or a changed kernel identity must stop instead of publishing.
    seat.assertCurrent()
    assertRecordedHostKernelIdentityCurrent(identity)
    writeLocalRecord(scope, identity)
    // Qualification barrier: hold the process after the registry commit and
    // before the caller can report Ready, so a launcher can deliver a signal in
    // the exact publication gap. Production never sets this variable.
    const barrier = process.env.SPLIT_PROCESS_HOST_PUBLISH_BARRIER
    if (barrier !== undefined && barrier !== '') {
      await waitForQualificationBarrier(barrier)
    }
  } catch (error) {
    try {
      await unregisterWebControl?.()
    } catch {
      // The registry was never committed; cleanup continues below.
    }
    try {
      await unregisterAcpControl?.()
    } catch {
      // The registry was never committed; cleanup continues below.
    }
    try {
      await unregisterAcpStatus?.()
    } catch {
      // The registry was never committed; cleanup continues below.
    }
    try {
      await unregisterWorkspaceObject?.()
    } catch {
      // The registry was never committed; cleanup continues below.
    }
    try {
      await unregisterIdentity?.()
    } catch {
      // The registry was never committed; cleanup continues below.
    }
    cleanupOwnedFiles(scope, instanceId)
    throw error
  }
  return {
    identity,
    async unregisterRoutes(): Promise<void> {
      await unregisterWebControl?.()
      await unregisterAcpControl?.()
      await unregisterAcpStatus?.()
      await unregisterWorkspaceObject?.()
      await unregisterIdentity?.()
    },
  }
}

/**
 * Run one Host-only process and remove only the scratch this process created
 * under its independently derived real scope. A failure anywhere before the
 * post-boot controller (official-module load, scope construction, kernel seat,
 * overlay write, starttime read or profile boot) still passes through this
 * owner-safe finally; the launcher-supplied path and another live Host's
 * scratch are never deletion authority. A forced `process.exit()` from the
 * launcher's native signal handler during `runProfile` bypasses the async
 * finally, so a synchronous exit mirror below removes the same owned scratch.
 */
export async function runLocalHostEntry(options: LocalHostEntryOptions): Promise<void> {
  const owned: HostScratchOwner = {}
  process.once('exit', () => {
    // A forced `process.exit()` from the launcher's native signal handler
    // bypasses the async finally; this synchronous mirror retires the exact
    // socket inode this process bound (a SIGKILL has no JS callback and is left
    // to the next seat winner's safe reclaim).
    owned.acpController?.cleanupSync()
    if (owned.scopeDir !== undefined && owned.scratchDir !== undefined) {
      removeOwnedScratch(owned.scopeDir, owned.scratchDir)
    }
  })
  try {
    await runLocalHostEntryOwned(options, owned)
  } finally {
    if (owned.scopeDir !== undefined && owned.scratchDir !== undefined) {
      removeOwnedScratch(owned.scopeDir, owned.scratchDir)
    }
  }
}

/**
 * Run one Host-only process until its launcher requests shutdown. Exported so
 * the process-level qualification harness can document its exact contract; the
 * module's `import.meta.main` block is the only caller in production.
 */
async function runLocalHostEntryOwned(options: LocalHostEntryOptions, scratchOwner: HostScratchOwner): Promise<void> {
  const dsh = await loadOfficialDsh(options.dshAnchor)
  const dshHome = dsh.resolveDshHome()
  const scope = scopeFromInstalledProfile({
    dshHome,
    profileDir: dsh.resolveProfileDir(options.profile, dshHome),
    packageRoot: installedPackageRootFromEntry(process.argv[1] === undefined ? import.meta.url : pathToFileURL(process.argv[1]).href),
    dshVersion: readInstalledDshVersion(options.dshAnchor),
  })
  scratchOwner.scopeDir = scope.dir

  let seat: ProcessSeat
  try {
    seat = await bindProfileKernelSeat(scope, 'host', 'HOST_ALREADY_OWNED')
  } catch (error) {
    if (error instanceof LocalScopeError && error.code === 'HOST_ALREADY_OWNED') {
      // A live Host already owns this profile scope. This candidate never
      // creates a Context, webserver, Agent or Session.
      writeEntryRecord({
        m4a0: 'host-seat-conflict',
        processRole: 'host',
        pid: process.pid,
        scopeId: scope.scopeId,
        error: error.code,
      })
      return
    }
    throw error
  }

  let handle: Awaited<ReturnType<OfficialDshModules['runProfile']>> | undefined
  let registration: PublishedLocalHost | undefined
  let liveness: HostActivityObserver | undefined
  let acpController: AcpControlController | undefined
  try {
    const scratchDir = mkdtempSync(join(scope.dir, 'host-scratch-'))
    scratchOwner.scratchDir = scratchDir
    if (process.env.SPLIT_PROCESS_HOST_FORCE_EARLY_EXIT === '1') {
      // Qualification-only: a forced exit after this process owns its scratch
      // and before runProfile installs the launcher signal handlers. The
      // wrapper's synchronous exit mirror must remove the scratch even though
      // the async finally never runs.
      process.exit(1)
    }
    const overlayPath = join(scratchDir, 'host-only.patch.yml')
    writeFileSync(overlayPath, HOST_ONLY_PATCH, { mode: 0o600 })
    const hostProcessIdentity = readHostProcessIdentity()
    const processStartIdentity = hostProcessIdentity.schema === 1 ? hostProcessIdentity.hostStarttime : undefined
    if (process.env.SPLIT_PROCESS_HOST_FORCE_BOOT_FAILURE === 'before-profile') {
      throw new Error('local host entry: qualification forced pre-profile failure')
    }
    // The profile's startup row reads these launcher facts. The identity
    // marker binds the role to THIS executable, so a regular CLI that inherits
    // the role string cannot suppress the TUI-surface verdict (see startup.ts).
    process.env.DSH_PI_TUI_ROLE = 'host'
    if (process.argv[1] !== undefined) {
      process.env.DSH_PI_TUI_HOST_ENTRY = realpathSync(process.argv[1])
    }
    // Snapshot the process signal listeners so the entry can identify the
    // launcher-installed CLI shortcut after the official handle exists.
    const priorSigterm = process.listeners('SIGTERM')
    const priorSigint = process.listeners('SIGINT')
    handle = await dsh.runProfile({
      environment: dsh.loadLayeredEnv('dsh', process.cwd()),
      profile: options.profile,
      patchFiles: [overlayPath, ...options.extraPatchFiles ?? []],
      args: [],
    })
    const shutdownOwner = handle.shutdown
    // From here on the Host root exists. EVERY step — first record, the lazy
    // audit import, the audit itself, ready publication and control
    // installation — is owned by the launcher shutdown controller on failure.
    try {
      writeEntryRecord({
        m4a0: 'profile-booted', processRole: 'host', pid: process.pid, phase: 'profile-booted',
      })
      const { settleHostEntries, collectHostEntryStatus } = await import('./host-bootstrap.ts')
      await settleHostEntries(handle.ctx)
      // M6 PR-A: the HOST-OWNED canonical TUI preference migration. It runs
      // after the profile settled (the canonical row and ConfigEditor exist)
      // and BEFORE the Web/ACP startup preferences or Ready publication, so no
      // Host business can read an unmigrated preference and a failed migration
      // never publishes Ready. A Split Client never runs this barrier.
      const settled = handle
      if (settled === undefined) throw new Error('local host entry: the profile handle disappeared before migration')
      const profileContext = settled.ctx.get('profileContext') as {
        readonly home: string
        readonly patchPath: string
      } | undefined
      if (profileContext === undefined) {
        throw new Error('local host entry: the Host profile context is missing')
      }
      // Loaded LAZILY: this entry is a standalone Node program whose static
      // graph must not import the Schemastery-backed preference schema before
      // the launcher installed the official package resolution. The same
      // reason `host-bootstrap.ts` is a dynamic import above.
      const { migrateProfileTuiPreferences } = await import('../config/profile-preferences-migration.ts')
      await migrateProfileTuiPreferences({
        patchPath: profileContext.patchPath,
        configEditor: settled.ctx.get('configEditor') as ProfileConfigEditorLike | undefined,
        forms: settled.ctx.get('settings') as SettingsFormsLike | undefined,
        home: profileContext.home,
        resolvePreset: async (id) => {
          const presets = settled.ctx.get('agentPresets') as {
            resolve(id?: string): Promise<{ broken?: string }>
          } | undefined
          if (presets === undefined) throw new Error('agent presets unavailable in this deployment')
          const resolved = await presets.resolve(id)
          if (resolved.broken !== undefined) {
            throw Object.assign(new Error(resolved.broken), { code: 'agent-preset/invalid' })
          }
        },
        diag: createEntryDiag('host'),
      })
      // M5-W PR-C: the profile-owned Web startup preference is consumed HERE —
      // after the profile settled, before the readiness audit and Ready.
      await applyWebStartupPreference(handle.ctx)
      const status = collectHostEntryStatus(handle.ctx, { profile: options.profile, processStartIdentity })
      // Installed after the Host readiness audit and before Ready. The
      // observer is Host-process-local: it subscribes to the official live
      // signals and never owns or stops any DSH business work.
      liveness = new HostActivityObserver(handle.ctx)
      // R1: signal admission is process-lifetime and precedes the discoverable
      // registry. A signal inside the publication gap becomes ONE pending stop
      // intent; it cannot default-terminate the process and cannot create a
      // second Host shutdown owner.
      let published: PublishedLocalHost | undefined
      let stopping: Promise<void> | undefined
      let shuttingDown = false
      let controlChannel: EntryControlChannel | undefined
      let resolveStopped: (() => void) | undefined
      const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
      const stop = (code: number, owner: PublishedLocalHost | undefined): Promise<void> => {
        if (stopping !== undefined) return stopping
        shuttingDown = true
        // Synchronously latch the ACP controller quiescing BEFORE any await, so
        // a concurrent `setEnabled(true)` can no longer be admitted once the one
        // official Host shutdown has begun. The actual close runs in the chain.
        acpController?.quiesce()
        stopping = (async () => {
          const errors: Array<{ step: string; error: unknown }> = []
          // PO-1B: stop accepting and retire the local ACP socket before the
          // official shutdown runs. One collected step; a close failure never
          // skips the official `shutdownOwner`.
          try {
            await acpController?.close()
          } catch (error) {
            errors.push({ step: 'local-acp-close', error })
          }
          try {
            liveness?.close()
          } catch (error) {
            errors.push({ step: 'liveness-close', error })
          }
          // runProfile already consumed the Host-only overlay. Remove only this
          // process's own scratch under the real scope; a removal failure is one
          // collected cleanup step and must never truncate the official shutdown.
          try {
            if (process.env.SPLIT_PROCESS_HOST_FORCE_SCRATCH_REMOVE_FAILURE === '1') {
              throw new Error('local host entry: qualification forced scratch removal failure')
            }
            removeOwnedScratch(scope.dir, scratchDir)
          } catch (error) {
            errors.push({ step: 'scratch-remove', error })
          }
          // With no published owner there is no identity route or registry yet
          // (a stop admitted while the listener was binding, before Ready), so
          // there is nothing to unregister and no owned registry file to delete.
          if (owner !== undefined) {
            try {
              await owner.unregisterRoutes()
            } catch (error) {
              errors.push({ step: 'identity-unregister', error })
            }
          }
          try {
            await shutdownOwner.shutdown(code)
          } catch (error) {
            errors.push({ step: 'shutdown', error })
          }
          if (owner !== undefined) cleanupOwnedFiles(scope, owner.identity.instanceId)
          if (errors.length > 0) {
            const first = errors[0]
            const primary = first.error instanceof Error ? first.error : new Error(String(first.error))
            writeEntryRecord({
              m4a0: 'cleanup-failure',
              processRole: 'host',
              phase: 'shutdown',
              pid: process.pid,
              error: primary.message,
              step: first.step,
            })
            process.exitCode = 1
          } else {
            writeEntryRecord({
              m4a0: 'cleanup',
              processRole: 'host',
              phase: 'shutdown',
              pid: process.pid,
              status: 'completed',
            })
            process.exitCode = code
          }
          // Qualification barrier: hold the completed shutdown before the
          // signal admission is released, so a launcher can prove that a
          // repeated signal during shutdown is admitted and ignored instead of
          // default-terminating the process. Production never sets this.
          const stopBarrier = process.env.SPLIT_PROCESS_HOST_STOP_BARRIER
          if (stopBarrier !== undefined && stopBarrier !== '') {
            await waitForQualificationBarrier(stopBarrier)
          }
          // The shutdown is complete: no further control request can be
          // admitted. Release the stdin channel this entry resumed, because the
          // launcher holds the other end of that pipe — a resumed stdin keeps
          // the event loop alive, and the process would stay resident after its
          // own shutdown (a signal-driven stop never runs the control `shutdown`
          // op that releases it). Idempotent with that path.
          controlChannel?.release()
          resolveStopped?.()
        })()
        return stopping
      }
      let pendingStop: number | undefined
      const requestStop = (code: number, signal: 'SIGTERM' | 'SIGINT'): void => {
        const owner = published
        if (pendingStop !== undefined) {
          // The admission listeners stay installed for the whole process
          // lifetime; a repeated signal (supervisor escalation or a second
          // Ctrl-C) is observed and ignored by the single stop intent instead
          // of falling through to Node's default termination.
          writeEntryRecord({
            m4a0: 'stop-repeat-ignored',
            processRole: 'host',
            pid: process.pid,
            signal,
            phase: shuttingDown ? 'shutdown' : owner === undefined ? 'publication' : 'running',
          })
          return
        }
        pendingStop = code
        writeEntryRecord({
          m4a0: 'stop-requested',
          processRole: 'host',
          pid: process.pid,
          signal,
          phase: shuttingDown ? 'shutdown' : owner === undefined ? 'publication' : 'running',
        })
        if (owner !== undefined) {
          runDetached(`local host: ${signal} shutdown`, () => stop(code, owner), { diag: createEntryDiag('host') })
        }
      }
      // runProfile installs one CLI signal shortcut per signal (interrupt →
      // disposal + forced process exit) before the profile tree mounts. This
      // long-lived entry owns process lifetime and must finish its published
      // identity and scratch cleanup through the SAME official shutdown
      // controller, so the launcher shortcut is removed here; the entry's own
      // handlers become the single process-lifetime admission. The launcher
      // registers before mounting the tree, so each shortcut is the first
      // listener added since the pre-boot snapshot; listeners added by mounted
      // rows later are untouched.
      const launcherSigterm = process.listeners('SIGTERM').find(listener => !priorSigterm.includes(listener))
      if (launcherSigterm !== undefined) process.removeListener('SIGTERM', launcherSigterm)
      const launcherSigint = process.listeners('SIGINT').find(listener => !priorSigint.includes(listener))
      if (launcherSigint !== undefined) process.removeListener('SIGINT', launcherSigint)
      const onSigterm = (): void => { requestStop(0, 'SIGTERM') }
      const onSigint = (): void => { requestStop(130, 'SIGINT') }
      process.on('SIGTERM', onSigterm)
      process.on('SIGINT', onSigint)
      // Released only once the owner-governed shutdown has completed, so every
      // signal during startup, publication and shutdown is admitted by the
      // persistent listener above rather than Node's default action.
      const releaseSignalAdmission = (): void => {
        process.removeListener('SIGTERM', onSigterm)
        process.removeListener('SIGINT', onSigint)
      }

      // PO-1B: the ONE Host-entry-owned ACP runtime controller. The socket is
      // OFF by default and is bound ONLY when the profile's independent
      // `pi-tui-acp-preferences.autoStart` preference is on (consumed below,
      // before Ready). When enabled, the bind still happens BEFORE the Ready
      // commit so a published registry never points at a not-yet-listening
      // socket. The controller lives on the entry's existing scratch owner, so
      // the ONE official shutdown and the synchronous process-exit mirror
      // release it; there is no second Host owner, Context, Agent or Session.
      const maxConnections = parseAcpMaxConnections(process.env.DSH_PI_TUI_ACP_MAX_CONNECTIONS)
      // Bind the narrow shared-Session View access from THIS settled Context.
      // The official Workspace/Session/Agent registries stay the sole authority;
      // only their callable methods are forwarded. A failure to read them is a
      // Host composition failure (the readiness audit already required them).
      const sessionAccess = createHostAcpSessionAccess(
        handle.ctx,
        dsh.parseCommand,
        dsh.compactionEngineClass,
        dsh.planModeClass,
      )
      acpController = createAcpController({ scope, maxConnections, diag: createEntryDiag('host'), sessionAccess })
      scratchOwner.acpController = acpController
      // Register the entry-owned controller as the root Host `piTuiAcpOwner`
      // service the private `piTuiAcpAccess` facade forwards to. It is a plain
      // root-Context value (not a Typert endpoint, not a business Fiber), so a
      // profile settings recomposition cannot dispose a live socket.
      handle.ctx.provide('piTuiAcpOwner', acpController)
      // Consume the persisted next-launch preference from the SAME settled ctx.
      // A failing enable keeps the Host Ready with a bounded diagnostic; a
      // corrupted composition fails startup. autoStart=false binds nothing.
      await applyAcpStartupPreference(handle.ctx, acpController)
      // Qualification-only barrier: hold the process after the socket is bound
      // and serving but BEFORE the registry is committed, so a launcher can
      // prove listen-before-Ready and deliver a signal in that exact window.
      // (Reached only when autoStart bound the socket.)
      const acpBoundBarrier = process.env.SPLIT_PROCESS_HOST_ACP_BOUND_BARRIER
      if (acpBoundBarrier !== undefined && acpBoundBarrier !== '') {
        writeEntryRecord({ m4a0: 'qualification', processRole: 'host', op: 'acp-bound-barrier', pid: process.pid })
        await waitForQualificationBarrier(acpBoundBarrier)
      }
      if (pendingStop !== undefined) {
        // A signal was admitted while the listener was binding but before the
        // registry committed. Never publish Ready for a stop-requested Host; the
        // listener is already on the scratch owner, so the ordinary shutdown
        // closes it and retires the socket inode.
        await stop(pendingStop, undefined)
        releaseSignalAdmission()
        return
      }

      const publishedHost = await publishLocalHost(handle.ctx, scope, hostProcessIdentity, seat, acpController)
      published = publishedHost
      registration = publishedHost
      // The exit backstop removes only this instance's files; SIGKILL leaves
      // them for the stale-candidate path to classify.
      process.once('exit', () => { cleanupOwnedFiles(scope, publishedHost.identity.instanceId) })
      if (pendingStop !== undefined) {
        // A signal was admitted while the registry was becoming discoverable.
        // The published identity and the official shutdown owner are now both
        // available, so run the ordinary owner-governed shutdown WITHOUT ever
        // advertising Ready.
        await stop(pendingStop, publishedHost)
        releaseSignalAdmission()
        return
      }
      // The first observation is asynchronous (a mounted Schedule catalog can
      // take up to its bound). A stop admitted during that window owns the
      // process: wait for it, and never publish Ready after a stop request.
      const initialLivenessPromise = liveness.snapshot()
      const livenessBarrier = process.env.SPLIT_PROCESS_HOST_LIVENESS_BARRIER
      if (livenessBarrier !== undefined && livenessBarrier !== '') {
        writeEntryRecord({ m4a0: 'qualification', processRole: 'host', op: 'liveness-barrier', pid: process.pid })
        await waitForQualificationBarrier(livenessBarrier)
      }
      const initialLiveness = await initialLivenessPromise
      if (stopping !== undefined || pendingStop !== undefined) {
        await stopped
        releaseSignalAdmission()
        return
      }
      writeEntryRecord({ m4a0: 'ready', ...status, liveness: initialLiveness, localHost: publishedHost.identity })
      controlChannel = attachEntryControl(async request => {
        if (request.op === 'status') {
          const snapshot = await liveness!.snapshot()
          writeEntryRecord({
            m4a0: 'status',
            ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            ...collectHostEntryStatus(handle!.ctx, { profile: options.profile, processStartIdentity }),
            liveness: snapshot,
            localHost: publishedHost.identity,
          })
          return false
        }
        if (request.op === 'shutdown') {
          await stop(0, publishedHost)
          return true
        }
        writeEntryRecord({ m4a0: 'control-error', error: `local host entry: unknown op ${JSON.stringify(request.op)}` })
        return false
      })
      await stopped
      releaseSignalAdmission()
    } catch (error) {
      writeEntryRecord({
        m4a0: 'failure',
        processRole: 'host',
        phase: 'after-boot',
        pid: process.pid,
        ...(error instanceof LocalScopeError || error instanceof LocalAcpError ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      })
      // A post-boot failure may still be mid-settle (the Host-only Connection /
      // API-remotes rows inject the webserver/gateway). Let the Loader settle
      // before the official shutdown owner runs so the A0 failure cleanup stays
      // classifiable instead of hitting the official force-exit grace path.
      let priorCleanupFailure: string | undefined
      try {
        const loader = (handle.ctx as unknown as { readonly loader?: { await(): Promise<unknown> } }).loader
        if (loader !== undefined) {
          await Promise.race([
            loader.await(),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('local host entry: profile entries did not settle before failure cleanup')), 5_000)
            }),
          ])
        }
      } catch (settleError) {
        priorCleanupFailure = settleError instanceof Error ? settleError.message : String(settleError)
        writeEntryRecord({
          m4a0: 'cleanup-failure',
          processRole: 'host',
          phase: 'after-boot',
          pid: process.pid,
          step: 'settle-before-shutdown',
          error: priorCleanupFailure,
        })
      }
      try {
        await acpController?.close()
      } catch (cleanupError) {
        priorCleanupFailure ??= cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        writeEntryRecord({
          m4a0: 'cleanup-failure',
          processRole: 'host',
          phase: 'after-boot',
          pid: process.pid,
          step: 'local-acp-close',
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      }
      try {
        liveness?.close()
      } catch (cleanupError) {
        priorCleanupFailure ??= cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        writeEntryRecord({
          m4a0: 'cleanup-failure',
          processRole: 'host',
          phase: 'after-boot',
          pid: process.pid,
          step: 'liveness-close',
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      }
      try {
        await registration?.unregisterRoutes()
      } catch (cleanupError) {
        priorCleanupFailure ??= cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        writeEntryRecord({
          m4a0: 'cleanup-failure',
          processRole: 'host',
          phase: 'after-boot',
          pid: process.pid,
          step: 'identity-unregister',
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      }
      // rc1 teardown compatibility: Cordis 4.1 unloads a provider fiber only
      // after its dependent fibers finish, and the built-in HMR service's own
      // unload drains its serialized reload queue. A post-boot failure can
      // happen while the initial configuration refresh is still queued;
      // disposing the tree then waits on that refresh while the refresh waits
      // on the Loader being disposed, so the launcher's 5s shutdown grace
      // force-exits before the cleanup classification can be recorded. Drain
      // the PUBLIC HMR transaction queue first (bounded) so the official
      // shutdown can settle; a drain that does not complete stays a truthful
      // prior cleanup failure instead of a fabricated completed record.
      try {
        await drainHmrTransactions(handle?.ctx as unknown as HostHmrTransactionsContext)
      } catch (drainError) {
        const message = drainError instanceof Error ? drainError.message : String(drainError)
        // The FIRST cleanup failure stays the final failure reason; this record
        // names the step's OWN error so a diagnosis does not get the earlier
        // Loader error attributed to the HMR drain.
        priorCleanupFailure ??= message
        writeEntryRecord({
          m4a0: 'cleanup-failure',
          processRole: 'host',
          phase: 'after-boot',
          pid: process.pid,
          step: 'hmr-drain',
          error: message,
        })
      }
      await finishHostFailureCleanup(
        shutdownOwner,
        writeEntryRecord,
        priorCleanupFailure === undefined ? undefined : { priorCleanupFailure },
      )
      if (registration !== undefined) cleanupOwnedFiles(scope, registration.identity.instanceId)
      process.exitCode = 1
    }
  } finally {
    await seat.close()
  }
}

/** The public HMR transaction queue seam the post-boot failure cleanup drains. */
export interface HostHmrTransactionsContext {
  get?(name: string): { runExclusive?(operation: () => Promise<unknown>): Promise<unknown> } | undefined
}

/**
 * Drain the HMR service's serialized reload transactions before the failed
 * Host disposes its application tree.
 *
 * Cordis 4.1 unloads a provider fiber only after its dependent fibers finish,
 * and the built-in HMR service's own unload drains the reload queue that is
 * still holding the boot-time configuration refresh. Disposing the tree while
 * that refresh is queued therefore deadlocks: the HMR fiber waits for the
 * refresh, and the refresh waits for the Loader that is being disposed. The
 * launcher's shutdown then force-exits after its 5s grace before the cleanup
 * classification can be recorded. `runExclusive` is the public serialization
 * seam, so an empty operation joins the queue and resolves after the in-flight
 * transaction settled. A missing HMR service is a no-op; a queue that cannot
 * drain within the bound rejects so the caller reports a truthful cleanup
 * failure instead of claiming completion.
 *
 * @param context - the Host context whose HMR service (if any) is drained.
 * @param timeoutMs - the bound on the drain, so a stuck queue cannot hang exit.
 */
export async function drainHmrTransactions(
  context: HostHmrTransactionsContext,
  timeoutMs = 3_000,
): Promise<void> {
  const hmr = context.get?.('hmr')
  if (typeof hmr?.runExclusive !== 'function') return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      hmr.runExclusive(async () => undefined),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('local host entry: HMR transactions did not drain before failure cleanup')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Finish one failed Host startup with the launcher's official shutdown owner.
 * A successful disposal emits exactly one `cleanup: completed`; a rejecting
 * disposal emits one `cleanup-failure` and NEVER a completed record. Exported
 * for the review-fix negative control.
 */
export interface FinishHostFailureCleanupOptions {
  /** One already-reported cleanup step failure that must prevent a completed claim. */
  readonly priorCleanupFailure?: string
}

export async function finishHostFailureCleanup(
  shutdownOwner: { shutdown(code: number): Promise<void> },
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
  options: FinishHostFailureCleanupOptions = {},
): Promise<boolean> {
  try {
    await shutdownOwner.shutdown(1)
    if (options.priorCleanupFailure !== undefined) {
      emit({
        m4a0: 'cleanup-failure',
        processRole: 'host',
        phase: 'after-boot',
        pid: process.pid,
        step: 'prior-cleanup',
        error: options.priorCleanupFailure,
      })
      return false
    }
    emit({ m4a0: 'cleanup', processRole: 'host', phase: 'after-boot', pid: process.pid, status: 'completed' })
    return true
  } catch (cleanupError) {
    emit({
      m4a0: 'cleanup-failure',
      processRole: 'host',
      phase: 'after-boot',
      pid: process.pid,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    })
    return false
  }
}

/** Read the launcher environment; a missing anchor is a hard startup failure. */
function optionsFromEnvironment(): LocalHostEntryOptions {
  const dshAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local host entry: SPLIT_PROCESS_DSH_ANCHOR must name the installed @deepseek-ai/dsh/package.json')
  }
  return {
    dshAnchor,
    profile: process.env.SPLIT_PROCESS_PROFILE ?? 'pi-tui',
    ...(process.env.SPLIT_PROCESS_EXTRA_PATCH === undefined || process.env.SPLIT_PROCESS_EXTRA_PATCH === ''
      ? {}
      : { extraPatchFiles: [process.env.SPLIT_PROCESS_EXTRA_PATCH] }),
  }
}

if (import.meta.main) {
  try {
    const options = optionsFromEnvironment()
    // The Host inherits the OS manager's environment, not an interactive
    // shell's. Append the common tool directories that already exist before
    // the official profile boot snapshots this process environment; the mode
    // value and the inherited PATH are the only inputs. A non-Linux/macOS
    // process keeps its existing unsupported-platform path untouched.
    const platform = process.platform
    if (platform === 'linux' || platform === 'darwin') {
      const environment = initializeHostEnvironment(platform)
      writeEntryRecord({
        m4a0: 'host-environment',
        processRole: 'host',
        pid: process.pid,
        mode: environment.mode,
        addedPathCount: environment.addedPathCount,
        skippedInvalidCount: environment.skippedInvalidCount,
        skippedInaccessibleCount: environment.skippedInaccessibleCount,
      })
      if (environment.skippedInvalidCount > 0 || environment.skippedInaccessibleCount > 0) {
        createEntryDiag('host').warn(
          `host environment: skipped PATH candidates (invalid=${String(environment.skippedInvalidCount)}, inaccessible=${String(environment.skippedInaccessibleCount)})`,
          {
            skippedInvalidCount: environment.skippedInvalidCount,
            skippedInaccessibleCount: environment.skippedInaccessibleCount,
          },
        )
      }
      if (environment.homeAvailable === false) {
        createEntryDiag('host').warn('host environment: no usable home directory; only absolute path candidates were considered')
      }
    }
    await runLocalHostEntry(options)
  } catch (error) {
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'host',
      phase: 'startup',
      pid: process.pid,
      ...(error instanceof LocalScopeError || error instanceof LocalAcpError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    process.exit(1)
  }
}
