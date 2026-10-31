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
import { HostActivityObserver } from './host-liveness.ts'
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
import { cleanupOwnedFiles, type LocalInstanceRecord } from './local-discovery.ts'

/**
 * The Host-only overlay applied over the profile's own patch stack. It keeps
 * `tui-startup` mounted (the Host rows gated on `tuiStartup` need its parsed
 * facts) and disables only the three surface rows that must not exist in a
 * Host-only PID, then adds the two B1 rows plus the official Session-serving
 * rows and the ONE built-in PiTui Host Runtime row. The base Gateway,
 * webserver, credentials, agents, sessions and jobs are reused, never mounted
 * twice.
 */
export const HOST_ONLY_PATCH = `# M4-B1 Host-only profile overlay: production Host rows only.
- id: tui-app
  disabled: true
- id: pi-tui-extension-host
  disabled: true
- id: pi-tui-builtins
  disabled: true

- insert:
    # One official Connection owner (loopback /connect + /api) behind the
    # profile's existing tuiStartup-gated webserver. trustedHosts stays empty:
    # loopback and the listener's own bind IP are the only accepted authorities.
    - id: split-host-connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [tuiStartup, credentials, webServer]
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
      inject: [tuiStartup, agents, attachments, commands, connection]

    - id: split-host-session-stats
      name: '@deepseek-ai/dsh-session-stats'
      inject: [tuiStartup, sessionProjections]

    - id: split-host-turn-outline
      name: '@deepseek-ai/dsh-session-turn-outline'
      inject: [tuiStartup, sessionProjections]

    - id: split-host-session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
      inject: [tuiStartup, agentDefaultModel, agents, attachments, fileUploads, fs, llm, remoteAccess, sessions, sessionProjections, sessionQuery, typert, workspaceRegistry]
      config:
        nativeOpen: false

    - id: split-host-settings-controller
      name: '@deepseek-ai/dsh-api-settings-controller'
      inject: [tuiStartup, typert]

    - id: split-host-session-log-download
      name: '@deepseek-ai/dsh-session-log-export'
      inject: [tuiStartup, commands, connection]

    # The package's ONE built-in Host Runtime row: the private contribution plus
    # the two private business services. Business features are NOT separate
    # Loader rows or package subpaths.
    - id: split-host-pi-tui-runtime
      name: '@xmoon76/dsh-pi-tui/host-runtime'
      inject: [tuiStartup, typert, agents, fileReferences, workingDirectory]
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
      const stop = (code: number, owner: PublishedLocalHost): Promise<void> => {
        if (stopping !== undefined) return stopping
        shuttingDown = true
        stopping = (async () => {
          const errors: Array<{ step: string; error: unknown }> = []
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
          try {
            await owner.unregisterIdentity()
          } catch (error) {
            errors.push({ step: 'identity-unregister', error })
          }
          try {
            await shutdownOwner.shutdown(code)
          } catch (error) {
            errors.push({ step: 'shutdown', error })
          }
          cleanupOwnedFiles(scope, owner.identity.instanceId)
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
        ...(error instanceof LocalScopeError ? { code: error.code } : {}),
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
      ...(error instanceof LocalScopeError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    process.exit(1)
  }
}
