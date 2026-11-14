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
import { attachEntryControl, createEntryDiag, writeEntryRecord } from './entry-control.ts'
import { HostActivityObserver } from './host-activity.ts'
import { PI_TUI_WEB_ACCESS_ROWS } from '../host/features/web-roster.ts'
import {
  bindProcessSeat,
  installedPackageRootFromEntry,
  LocalScopeError,
  LOCAL_PROTOCOL,
  readInstalledDshVersion,
  readLinuxStarttime,
  removeOwnedScratch,
  scopeFromInstalledProfile,
  type LocalScope,
  type ProcessSeat,
} from './local-scope.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import {
  PI_TUI_WEB_ACCESS_NAMESPACE,
  type PiTuiWebAccessStatus,
} from '../../runtime/remote/pi-tui-web-access-contract.ts'
import { cleanupOwnedFiles, type LocalInstanceRecord } from './local-discovery.ts'
import {
  LocalAcpError,
  parseAcpMaxConnections,
  startLocalAcpListener,
  type LocalAcpListener,
} from './local-acp-listener.ts'
import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'

/** The official Web-only rows of the Host overlay, rendered from the ONE
 * production roster (`host/features/web-roster.ts`). Pure template data: no
 * parser, no discovery and no state — the same table the `piTuiWebAccess`
 * service verifies the live Loader against. `inject`/`config` come from that
 * same row record; `yaml` is the fixed official macro fragment for the ONE
 * `!!js`-configured row (office-kit's Host data output directory). */
const WEB_ONLY_ROWS_YAML = PI_TUI_WEB_ACCESS_ROWS.flatMap(row => [
  `    - id: ${row.id}`,
  `      name: '${row.name}'`,
  '      disabled: true',
  ...(row.inject === undefined ? [] : [`      inject: [${row.inject.join(', ')}]`]),
  ...(row.config === undefined
    ? []
    : ['      config:', ...Object.entries(row.config).map(([key, value]) => `        ${key}: ${String(value)}`)]),
  ...(row.yaml ?? []),
]).join('\n')

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

    # The package's ONE built-in Host Runtime row: the private contribution plus
    # the private business services. Business features are NOT separate Loader
    # rows or package subpaths. The sandbox policy/provider are resolved PER
    # CALL by the features that need them (M6-1 F8), so a Host without the
    # sandbox provider still becomes Ready and reports that side truthfully.
    - id: split-host-pi-tui-runtime
      name: '@xmoon76/dsh-pi-tui/host-runtime'
      inject: [typert, agents, fileReferences, workingDirectory, sessions, subprocess, workspaceRegistry, skills, agentPresets]
      config:
        sessionId: ''

# ── Official Web composition (M5-W PR-A/PR-B/PR-C) ──────────────────────────
# The official Browser Web rows, declared here ONCE and DISABLED BY DEFAULT.
# This declaration is the ONE roster the private 'piTuiWebAccess' Host service
# toggles at runtime: it flips 'disabled' on exactly these rows through
# 'Entry.update', never a second declaration, never a profile patch write, and
# never a separate Web process. The toggle is per Host lifetime; a cold boot
# starts from this default-off state UNLESS the profile's own
# 'pi-tui-web-preferences.autoStart' preference is on, in which case the boot
# sequence below enables the same roster before Ready ('/web' remains the
# immediate control of a running Host).
# Only the isolated qualification runs additionally override rows through
# SPLIT_PROCESS_EXTRA_PATCH; that internal test channel is not a user API.
#
# The roster is the official browser graph of the installed DSH family minus
# every row whose authority ALREADY exists in this Host: the second
# 'connection', 'api-remotes', 'file-upload', 'workspace'/'workspace-controller',
# 'session-controller', 'settings-controller', 'webserver', 'frontend-static'
# fallback and 'web-startup' parser are NOT declared here. The mandatory
# client-dependency closure of the official UIs ('ui-context-menu',
# 'ui-file-drag'), the official Client file-actions / message-quotes features
# and the 'workspace-changes' Host recorder that 'ui-deliverables' injects are
# part of it. 'workspace-changes' is declared BEFORE its consumer because the
# toggle activates one row at a time and awaits each fiber.
# 'terminal-controller' is the ONE official Host row added on top of the
# browser roster (the real Browser x TUI composition needs it).
#
# 'web-runtime' owns the single 'frontend-static' fallback over the official
# dist and is explicitly told to stay silent: no browser launch, no printed
# token URL and no DSH_WEB_URL shell variable.
- insert:
${WEB_ONLY_ROWS_YAML}
`

interface OfficialDshModules {
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
}

/** Resolve one published DSH subpath from the installation anchor supplied by the launcher. */
async function loadOfficialDsh(anchor: string): Promise<OfficialDshModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const profileBoot = await importResolved('@deepseek-ai/dsh/profile-boot')
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  const homePaths = await importResolved('@deepseek-ai/dsh-home-paths')
  return {
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
async function waitForRefusal(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const request: LocalRequestInit = { method: 'GET', redirect: 'manual', cache: 'no-store' }
      const response = await fetch(url, request)
      await response.body?.cancel()
      if (response.status === 401) return
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
  const { scope, maxConnections, diag } = options
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
        listener = await startLocalAcpListener({ scope, maxConnections, diag })
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
        if (listener === undefined) return { state: 'disabled' }
        const current = listener
        listener = undefined
        try {
          await current.close()
        } catch (error) {
          diag.warn('local-acp.error', { code: 'LOCAL_ACP_CLOSE_FAILED', cause: String(error) })
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

interface PublishedLocalHost {
  readonly identity: LocalInstanceRecord
  unregisterIdentity(): Promise<void>
}

/**
 * Publish the authenticated identity and private launch material, then commit
 * the registry as the Ready step. The route is registered before the registry
 * so no Client can observe a registry whose identity route is missing.
 */
async function publishLocalHost(
  context: import('@deepseek-ai/cordis').Context,
  scope: LocalScope,
  processStarttime: string,
): Promise<PublishedLocalHost> {
  const connection = context.get('connection') as unknown as HostConnectionService | undefined
  if (connection === undefined || typeof connection.authenticatedUrl !== 'function' || typeof connection.fetch?.register !== 'function') {
    throw new Error('local host entry: the official Connection service is not live')
  }
  const webServer = context.get('webServer') as unknown as HostWebServerService | undefined
  if (webServer === undefined || webServer.host !== '127.0.0.1' || webServer.port < 1) {
    throw new Error('local host entry: the official webserver is not a bound loopback listener')
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
  const identity: LocalInstanceRecord = {
    schema: 1,
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId,
    hostPid: process.pid,
    hostStarttime: processStarttime,
    origin,
    protocol: LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
  }
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
  let unregister: (() => Promise<void>) | undefined
  try {
    unregister = connection.fetch.register({
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
    // Admission runs before the exact route; this proves the route sits behind
    // the official Connection owner rather than a bare webserver handler.
    await waitForRefusal(`${origin}/api/pi-tui.local-host`)
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
      await unregister?.()
    } catch {
      // The registry was never committed; cleanup continues below.
    }
    cleanupOwnedFiles(scope, instanceId)
    throw error
  }
  return {
    identity,
    async unregisterIdentity(): Promise<void> {
      await unregister?.()
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
    packageRoot: installedPackageRootFromEntry(import.meta.url),
    dshVersion: readInstalledDshVersion(options.dshAnchor),
  })
  scratchOwner.scopeDir = scope.dir

  let seat: ProcessSeat
  try {
    seat = await bindProcessSeat(scope.hostSocketName, 'HOST_ALREADY_OWNED')
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
    const processStartIdentity = readLinuxStarttime()
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
              await owner.unregisterIdentity()
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
      acpController = createAcpController({ scope, maxConnections, diag: createEntryDiag('host') })
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

      const publishedHost = await publishLocalHost(handle.ctx, scope, processStartIdentity)
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
      attachEntryControl(async request => {
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
        await registration?.unregisterIdentity()
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
    await runLocalHostEntry(optionsFromEnvironment())
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
