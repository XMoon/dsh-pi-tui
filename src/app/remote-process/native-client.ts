import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectInstalledProfileScope, readInstalledDshVersion } from './local-scope.ts'
import {
  assertClientHostCompatible,
  assertRecordedHostKernelIdentityCurrent,
  authenticateLocalHost,
  inspectHostProcess,
  readLocalRecord,
} from './local-discovery.ts'
import { awaitLocalTransportReady, installLocalTransport } from './local-transport.ts'
import { createDiag } from '../../runtime/process/diagnostics.ts'

export interface NativeAttachOptions {
  readonly dshAnchor: string
  readonly profile: string
  readonly packageRoot: string
  readonly expectedInstanceId?: string
  readonly signal?: AbortSignal
  readonly onQuestion?: (request: NativeQuestionRequest) => Promise<NativeQuestionAnswer>
  readonly onApproval?: (request: NativeApprovalRequest) => Promise<unknown>
}

export interface NativeHostIdentity {
  readonly scopeId: string
  readonly instanceId: string
  readonly hostPid: number
  readonly hostStarttime?: string
  readonly protocol: string
  readonly dshVersion: string
  readonly bundleVersion: string
  readonly buildId: string
}

export interface NativeQuestionRequest {
  readonly sessionId: string
  readonly callId?: string
  readonly timed?: boolean
  readonly questions: readonly {
    readonly id: string
    readonly prompt: string
    readonly options?: readonly { readonly label: string; readonly description?: string }[]
  }[]
  readonly signal?: AbortSignal
}

export interface NativeQuestionAnswer {
  readonly answers: readonly {
    readonly id: string
    readonly selected?: readonly string[]
    readonly text?: string
  }[]
}

export interface NativeApprovalRequest {
  readonly sessionId: string
  readonly callId?: string
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export interface NativeResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

export interface NativeSessionSummary {
  readonly sessionId: string
  readonly title?: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
}

export interface NativeSessionView {
  readonly sessionId: string
  readonly snapshot: unknown
  readonly events: readonly unknown[]
}

export interface NativeUploadedFile {
  readonly receiptId: string
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

export interface NativePromptAttachment {
  readonly receiptId: string
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

export interface NativeClient {
  status(): NativeResult<{
    readonly transport: 'connecting' | 'connected' | 'disconnected'
    readonly generationId?: number
    readonly activeWrappers: number
    readonly liveSockets: number
    readonly pendingInteractions: number
    readonly interactionIdentityGaps: number
    readonly identity: NativeHostIdentity
  }>
  listSessions(): Promise<readonly NativeSessionSummary[]>
  createWorkspace(path: string): Promise<NativeResult<{
    readonly workspace: { readonly workspaceId: string; readonly path: string; readonly title: string }
    readonly created: boolean
  }>>
  createSession(input?: {
    readonly workspaceId?: string
    readonly sessionId?: string
    readonly agentPreset?: string
  }): Promise<string>
  openSession(sessionId: string): Promise<NativeSessionView>
  subscribeSession(sessionId: string, listener: (snapshot: unknown) => void): () => void
  prompt(input: {
    readonly sessionId: string
    readonly text: string
    readonly mode?: 'queue' | 'steer'
    readonly attachments?: readonly NativePromptAttachment[]
  }): Promise<NativeResult<{ readonly accepted: true; readonly requestId: string }>>
  cancel(sessionId: string): Promise<NativeResult<{ readonly accepted: true }>>
  command(sessionId: string, line: string): Promise<NativeResult<{ readonly matched: boolean }>>
  commands(sessionId: string): Promise<NativeResult<unknown>>
  renameSession(sessionId: string, title: string): Promise<NativeResult<unknown>>
  catalog(): Promise<NativeResult<{ readonly models: unknown; readonly presets: unknown; readonly permissions: unknown }>>
  selectModel(input: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<NativeResult<unknown>>
  selectPreset(sessionId: string, presetId: string): Promise<NativeResult<unknown>>
  uploadFile(sessionId: string, input: { readonly name: string; readonly bytes: Uint8Array }): Promise<NativeResult<NativeUploadedFile>>
  readFile(sessionId: string, path: string): Promise<NativeResult<unknown>>
  watchJobs(sessionId: string): () => void
  observeJob(sessionId: string, jobId: string): () => void
  jobsSnapshot(): unknown
  closeSession(sessionId: string): void
  close(): Promise<void>
}

interface OfficialClientHostModules {
  readonly Context: new () => any
  readonly PluginPackages: abstract new (...args: never[]) => unknown
  readonly Loader: new (ctx: any) => any
  readonly loadProfile: (binName: string, name: string, installAnchor: string) => unknown
  readonly createRuntimeResolution: (options: { installAnchor: string; profile: unknown }) => Promise<unknown>
  readonly resolveDshHome: () => string
  readonly resolveProfileDir: (name: string, home?: string) => string
}

async function loadOfficialClientHost(anchor: string): Promise<OfficialClientHostModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  const cordis = await importResolved('@deepseek-ai/cordis')
  const loaderModule = await importResolved('@deepseek-ai/cordis-plugin-loader')
  const homePaths = await importResolved('@deepseek-ai/dsh-home-paths')
  return {
    Context: cordis.Context as OfficialClientHostModules['Context'],
    PluginPackages: appBoot.PluginPackages as OfficialClientHostModules['PluginPackages'],
    Loader: loaderModule.default as OfficialClientHostModules['Loader'],
    loadProfile: appBoot.loadProfile as OfficialClientHostModules['loadProfile'],
    createRuntimeResolution: appBoot.createRuntimeResolution as OfficialClientHostModules['createRuntimeResolution'],
    resolveDshHome: homePaths.resolveDshHome as OfficialClientHostModules['resolveDshHome'],
    resolveProfileDir: appBoot.resolveProfileDir as OfficialClientHostModules['resolveProfileDir'],
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`native-client: ${label} is required`)
  return value
}

function projectIdentity(identity: any): NativeHostIdentity {
  return {
    scopeId: identity.scopeId,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
    ...(identity.schema === 1 ? { hostStarttime: identity.hostStarttime } : {}),
    protocol: identity.protocol,
    dshVersion: identity.dshVersion,
    bundleVersion: identity.bundleVersion,
    buildId: identity.buildId,
  }
}

function createStartupGate(): { plugin: () => Promise<void>; release: () => void; cancel: (reason: unknown) => void; pending: boolean } {
  let resolveBarrier: (() => void) | undefined
  let rejectBarrier: ((reason: unknown) => void) | undefined
  let state: 'pending' | 'released' | 'cancelled' = 'pending'
  const barrier = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve
    rejectBarrier = reject
  })
  barrier.catch(() => {})
  return {
    plugin: async () => { await barrier },
    get pending(): boolean { return state === 'pending' },
    release(): void {
      if (state !== 'pending') return
      state = 'released'
      resolveBarrier?.()
    },
    cancel(reason: unknown): void {
      if (state !== 'pending') return
      state = 'cancelled'
      rejectBarrier?.(reason)
    },
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  if (signal === undefined) return new Promise<never>(() => {})
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

interface NativeInteractionReceivers {
  readonly pendingCount: number
  readonly identityGaps: number
  dispose(): void
}

/**
 * Consume the two official forwarded interaction events directly. The public
 * headless entry has no TUI Surface: the official Agent scope and native
 * callId are the only identity, and local disposal never answers the Host
 * request.
 */
function createNativeInteractionReceivers(input: {
  readonly remote: any
  readonly sessions: { scopeOf(owner: unknown): string | undefined }
  readonly onQuestion: NativeAttachOptions['onQuestion']
  readonly onApproval: NativeAttachOptions['onApproval']
}): NativeInteractionReceivers {
  let disposed = false
  let pending = 0
  let identityGaps = 0
  const owned: Array<() => void> = []

  const answerQuestion = async (request: any, sessionId: string, callId: string): Promise<NativeQuestionAnswer> => {
    pending += 1
    try {
      const answer = input.onQuestion === undefined
        ? await waitForAbort(request.signal)
        : await Promise.race([
            Promise.resolve().then(() => input.onQuestion!({
              sessionId,
              callId,
              timed: request.wait?.timed === true,
              questions: request.questions,
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            })),
            waitForAbort(request.signal),
          ])
      if (disposed) return await waitForAbort(request.signal)
      request.signal?.throwIfAborted()
      return answer
    } finally {
      pending -= 1
    }
  }

  const answerApproval = async (request: any, sessionId: string, callId: string): Promise<unknown> => {
    pending += 1
    try {
      const answer = input.onApproval === undefined
        ? await waitForAbort(request.signal)
        : await Promise.race([
            Promise.resolve().then(() => input.onApproval!({
              sessionId,
              callId,
              toolName: request.toolName,
              ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            })),
            waitForAbort(request.signal),
          ])
      if (disposed) return await waitForAbort(request.signal)
      request.signal?.throwIfAborted()
      return answer
    } finally {
      pending -= 1
    }
  }

  owned.push(input.remote.$on('user-questions/request', async function (this: unknown, request: any, next: () => unknown) {
    const sessionId = input.sessions.scopeOf(this)
    const callId = request.wait?.callId
    if (sessionId === undefined) return next()
    if (typeof callId !== 'string') {
      identityGaps += 1
      return next()
    }
    return await answerQuestion(request, sessionId, callId)
  }))
  owned.push(input.remote.$on('approval/request', async function (this: unknown, request: any, next: () => unknown) {
    const sessionId = input.sessions.scopeOf(this)
    const callId = request.callId
    if (sessionId === undefined) return next()
    if (typeof callId !== 'string') {
      identityGaps += 1
      return next()
    }
    return await answerApproval(request, sessionId, callId)
  }))

  return {
    get pendingCount(): number { return pending },
    get identityGaps(): number { return identityGaps },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const off of owned.splice(0)) off()
    },
  }
}

function normalizeResult<T>(result: any): NativeResult<T> {
  if (result?.ok === true) return { ok: true, value: result.value as T }
  return {
    ok: false,
    error: {
      ...(typeof result?.error?.code === 'string' ? { code: result.error.code } : {}),
      ...(typeof result?.error?.message === 'string' ? { message: result.error.message } : {}),
    },
  }
}

export async function attachNativeClient(options: NativeAttachOptions): Promise<NativeClient> {
  options.signal?.throwIfAborted()
  const dshAnchor = realpathSync(requireNonEmpty(options.dshAnchor, 'dshAnchor'))
  const packageRoot = realpathSync(requireNonEmpty(options.packageRoot, 'packageRoot'))
  const profile = requireNonEmpty(options.profile, 'profile')
  const hostModules = await loadOfficialClientHost(dshAnchor)
  options.signal?.throwIfAborted()
  const dshHome = hostModules.resolveDshHome()
  const profileDir = hostModules.resolveProfileDir(profile, dshHome)
  const scope = inspectInstalledProfileScope({
    dshHome,
    profileDir,
    packageRoot,
    dshVersion: readInstalledDshVersion(dshAnchor),
  })
  const record = readLocalRecord(scope)
  if (record === undefined) throw new Error('native-client: target Host is not running')
  if (inspectHostProcess(record) !== 'alive') throw new Error('native-client: target Host process is not alive')
  if (options.expectedInstanceId !== undefined && record.instanceId !== options.expectedInstanceId) {
    throw new Error('native-client: target Host instance does not match the expected identity')
  }
  assertClientHostCompatible(record, scope)
  const host = await authenticateLocalHost(record, scope, options.signal)
  assertRecordedHostKernelIdentityCurrent(host.identity)
  options.signal?.throwIfAborted()

  const loadedProfile = hostModules.loadProfile('native-client', profile, dshAnchor)
  options.signal?.throwIfAborted()
  const resolution = await hostModules.createRuntimeResolution({ installAnchor: dshAnchor, profile: loadedProfile })
  options.signal?.throwIfAborted()
  const context = new hostModules.Context()
  const diag = createDiag({ stderrLevel: 'off' })
  let loaderFiber: any
  let installedTransport: any
  let prerequisites: any
  let mountedDomains: any
  let interactions: NativeInteractionReceivers | undefined
  let gate: ReturnType<typeof createStartupGate> | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  const references = new Map<string, { release: () => void; binding: any }>()
  const jobWatchers = new Set<() => void>()
  let fatalError: unknown

  const cleanup = async (reason: Error): Promise<void> => {
    const cleanupErrors: unknown[] = []
    for (const reference of references.values()) reference.release()
    references.clear()
    for (const release of jobWatchers) release()
    jobWatchers.clear()
    try { interactions?.dispose() } catch (error) { cleanupErrors.push(error) }
    try { await installedTransport?.dispose() } catch (error) { cleanupErrors.push(error) }
    try { await prerequisites?.dispose() } catch (error) { cleanupErrors.push(error) }
    try { await mountedDomains?.dispose() } catch (error) { cleanupErrors.push(error) }
    gate?.cancel(reason)
    try { await loaderFiber?.dispose() } catch (error) { cleanupErrors.push(error) }
    try { await context.fiber.dispose() } catch (error) { cleanupErrors.push(error) }
    diag.dispose()
    if (cleanupErrors.length > 0) {
      for (const error of cleanupErrors) (reason as Error & { cause?: unknown }).cause ??= error
      throw reason
    }
  }

  try {
    const packageFiber = context.plugin(hostModules.PluginPackages as never, { resolution } as never)
    await packageFiber
    options.signal?.throwIfAborted()
    const { mountRemoteClientDomainPrerequisites } = await import('./native-client-domains.ts')
    options.signal?.throwIfAborted()
    loaderFiber = context.plugin(hostModules.Loader as never, {
      baseUrl: pathToFileURL(join(profileDir, 'package.json')).href,
    } as never)
    await loaderFiber
    options.signal?.throwIfAborted()
    const loader = context.get('loader')
    if (loader === undefined) throw new Error('native-client: official Loader did not install')
    gate = createStartupGate()
    loader.builtins['pi-tui-interaction-startup-gate'] = gate.plugin as never
    await loader.create({ name: 'cordis:pi-tui-interaction-startup-gate' })
    options.signal?.throwIfAborted()
    if (!gate.pending) throw new Error('native-client: interaction startup gate failed before transport install')
    installedTransport = await installLocalTransport(context, {
      dshAnchor,
      host,
      scope,
      diag,
      signal: options.signal,
      onFatal: error => { fatalError = error },
    })
    options.signal?.throwIfAborted()
    prerequisites = await mountRemoteClientDomainPrerequisites({ context, dshAnchor })
    options.signal?.throwIfAborted()
    const remote = context.get('remote')
    if (remote === undefined) throw new Error('native-client: official Remote service did not install')
    interactions = createNativeInteractionReceivers({
      remote,
      sessions: prerequisites.sessions,
      onQuestion: options.onQuestion,
      onApproval: options.onApproval,
    })
    const typert = context.get('typert') as any
    const agentResolver = typert?.contexts?.getClient('agent')
    if (!gate.pending || agentResolver === undefined) {
      throw new Error('native-client: Session Agent resolver was not ready before interaction gate release')
    }
    gate.release()
    const transport = await awaitLocalTransportReady(installedTransport, { signal: options.signal })
    mountedDomains = await prerequisites.complete({ signal: options.signal })
    prerequisites = undefined
    options.signal?.throwIfAborted()

    const sessions = mountedDomains.sessions
    const identity = projectIdentity(host.identity)
    const client: NativeClient = {
      status: () => fatalError === undefined
        ? { ok: true, value: {
            ...transport.status(),
            pendingInteractions: interactions?.pendingCount ?? 0,
            interactionIdentityGaps: interactions?.identityGaps ?? 0,
            identity,
          } }
        : { ok: false, error: { message: fatalError instanceof Error ? fatalError.message : String(fatalError) } },
      listSessions: async () => {
        await sessions.refresh()
        const state = sessions.list.getSnapshot()
        return state.ids.map((id: string) => {
          const row = state.byId[id]
          return {
            sessionId: id,
            ...(typeof row.title === 'string' ? { title: row.title } : {}),
            ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
            running: row.running === true,
            blank: row.blank === true,
          }
        })
      },
      createWorkspace: async path => {
        const workspace = context.get('remote')?.workspace
        if (workspace === undefined) throw new Error('native-client: official Workspace Remote is unavailable')
        return normalizeResult(await workspace.create({ path }))
      },
      createSession: async input => {
        const id = await sessions.create(input)
        return id
      },
      openSession: async sessionId => {
        const existing = references.get(sessionId)
        if (existing !== undefined) {
          const binding = sessions.binding(sessionId)
          if (binding === undefined) throw new Error('native-client: retained Session binding disappeared')
          return {
            sessionId,
            snapshot: binding.session.getSnapshot(),
            events: binding.eventSource.getSnapshot().entries,
          }
        }
        const reference = sessions.retain(sessionId, { source: 'controllerOperation' })
        references.set(sessionId, reference)
        try {
          await reference.ready
        } catch (error) {
          reference.release()
          references.delete(sessionId)
          throw error
        }
        const binding = reference.binding
        const state = binding.session.getSnapshot()
        if (state.openState !== 'open') throw new Error(`native-client: Session open did not complete: ${String(state.openState)}`)
        return {
          sessionId,
          snapshot: state,
          events: binding.eventSource.getSnapshot().entries,
        }
      },
      subscribeSession: (sessionId, listener) => {
        const reference = references.get(sessionId)
        if (reference === undefined) throw new Error('native-client: subscribeSession requires an opened Session')
        const source = reference.binding.eventSource
        const notify = (): void => { listener(source.getSnapshot()) }
        const off = source.subscribe(notify)
        notify()
        return off
      },
      prompt: async input => {
        const reference = references.get(input.sessionId)
        if (reference === undefined) throw new Error('native-client: prompt requires an opened Session')
        const binding = reference.binding
        const mode = input.mode ?? 'queue'
        const attachments = input.attachments ?? []
        const submission = binding.session.beginSubmission({
          mode,
          text: input.text,
          attachments: attachments.map(attachment => ({
            type: 'file',
            value: { attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes },
          })),
        })
        try {
          const result = normalizeResult<{ readonly accepted: true }>(await binding.session.prompt([
            { type: 'text', text: input.text },
            ...attachments.map(attachment => ({ type: 'file' as const, receiptId: attachment.receiptId })),
          ], mode, undefined, submission.requestId))
          if (result.ok) return { ok: true, value: { accepted: true as const, requestId: submission.requestId } }
          return { ok: false, error: result.error }
        } catch (error) {
          submission.abandon()
          throw error
        }
      },
      cancel: async sessionId => {
        const reference = references.get(sessionId)
        if (reference === undefined) throw new Error('native-client: cancel requires an opened Session')
        return normalizeResult(await reference.binding.session.cancel())
      },
      command: async (sessionId, line) => {
        const reference = references.get(sessionId)
        if (reference === undefined) throw new Error('native-client: command requires an opened Session')
        return normalizeResult(await reference.binding.session.command(line))
      },
      commands: async sessionId => {
        const reference = references.get(sessionId)
        if (reference === undefined) throw new Error('native-client: commands requires an opened Session')
        return normalizeResult(await remote.commands.list(sessionId))
      },
      renameSession: async (sessionId, title) => {
        const reference = references.get(sessionId)
        if (reference === undefined) throw new Error('native-client: renameSession requires an opened Session')
        return normalizeResult(await reference.binding.session.rename(title))
      },
      catalog: async () => {
        const models = normalizeResult(await remote.session.modelCatalog())
        if (!models.ok) return models as NativeResult<any>
        const presets = normalizeResult(await remote.agentPresets.list())
        if (!presets.ok) return presets as NativeResult<any>
        const permissions = normalizeResult(await remote.permissionPresets.catalog())
        if (!permissions.ok) return permissions as NativeResult<any>
        return { ok: true, value: { models: models.value, presets: presets.value, permissions: permissions.value } }
      },
      selectModel: async input => normalizeResult(await remote.session.selectModel(input)),
      selectPreset: async (sessionId, presetId) => normalizeResult(await remote.agentPresets.select(sessionId, presetId)),
      uploadFile: async (sessionId, input) => {
        const query = new URLSearchParams({ sessionId, name: input.name })
        const response = await installedTransport.authenticatedFetch(`/api/session/uploadFileBinary?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from(input.bytes),
        })
        const payload: any = await response.json()
        if (response.ok === false || payload?.ok !== true) return normalizeResult(payload)
        const value = payload.value
        if (typeof value?.receiptId !== 'string' || typeof value?.file?.attachmentId !== 'string'
          || typeof value?.file?.name !== 'string' || typeof value?.file?.bytes !== 'number') {
          throw new Error('native-client: official file upload returned invalid receipt metadata')
        }
        return {
          ok: true,
          value: {
            receiptId: value.receiptId,
            attachmentId: value.file.attachmentId,
            name: value.file.name,
            bytes: value.file.bytes,
          },
        }
      },
      readFile: async (sessionId, path) => normalizeResult(await remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: 200 })),
      watchJobs: sessionId => {
        const release = mountedDomains.jobs.watchRows(sessionId)
        jobWatchers.add(release)
        return () => {
          release()
          jobWatchers.delete(release)
        }
      },
      observeJob: (sessionId, jobId) => {
        const release = mountedDomains.jobs.observe(sessionId, jobId)
        jobWatchers.add(release)
        return () => {
          release()
          jobWatchers.delete(release)
        }
      },
      jobsSnapshot: () => mountedDomains.jobs.state.getSnapshot(),
      closeSession: sessionId => {
        const reference = references.get(sessionId)
        if (reference === undefined) return
        reference.release()
        references.delete(sessionId)
      },
      close: () => {
        closePromise ??= (async () => {
          if (closed) return
          closed = true
          await cleanup(new Error('native-client: closed'))
        })()
        return closePromise
      },
    }
    return client
  } catch (error) {
    await cleanup(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}
