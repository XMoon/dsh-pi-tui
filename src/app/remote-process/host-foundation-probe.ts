/**
 * M4-B2-HF real Host RPC qualification probe.
 *
 * Runs ONLY on the existing B1 Client Context after the authenticated
 * transport is live. It temporarily mounts the package's own private
 * contribution and the official Session controller `/remote` contribution —
 * plus the official Workspace controller `/remote` contribution when the caller
 * requests the Workspace proof — calls the official `session/list` RPC, the
 * private PiFile RPC, one private terminal-progress watch and (on request) the
 * official `workspace` namespace (`follow` baseline then `create` identity),
 * then unmounts them in reverse order. It creates no Context, no Connection and
 * no Gateway.
 *
 * The probe is an internal qualification control (not an npm export, CLI
 * command or user-facing API). The caller owns the control channel; this module
 * owns only the contribution/stream lifetime and the structured proof.
 *
 * @module app/remote-process/host-foundation-probe
 */

import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PI_TUI_CLIENT_CONTRIBUTION } from '../../runtime/remote/pi-tui-remote-contribution.ts'
import type { PiTuiTerminalProgressFrame } from '../../runtime/remote/pi-tui-terminal-progress-contract.ts'
import { mergeCause } from '../remote/dispose-cause.ts'
import { writeEntryRecord } from './entry-control.ts'
import type { VerifiedLocalHost } from './local-discovery.ts'

/** The no-live-Agent Session id every negative business probe names. */
const PROBE_SESSION_ID = 'm4-hf-no-live-agent'

/** Bounded wait for one Workspace stream frame; a timeout is a FAIL, never a PASS. */
const WORKSPACE_FRAME_TIMEOUT_MS = 20_000

/** Bound on frames skipped while looking for one Workspace `upsert`. */
const WORKSPACE_FRAME_LIMIT = 64

/** One Remote unary result, structurally (the Gateway Client face). */
interface RemoteResultLike<Value> {
  readonly ok: boolean
  readonly value?: Value
}

/** One Workspace projection as the Host Controller returns it. */
interface WorkspaceFacts {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** The Schedule subset this probe reads back out of the official namespace. */
interface ScheduleEntryFacts {
  readonly id: string
  readonly title: string
}

/** The official `schedule/create` request shape this probe sends. */
interface ScheduleCreateRequestLike {
  readonly title: string
  readonly prompt: string
  readonly timing: { readonly kind: 'after'; readonly after_seconds: number }
}

/** The official `schedule/edit` request shapes this probe sends: one CAS update,
 *  then the cleanup delete that leaves the durable catalog as it found it. */
type ScheduleEditRequestLike =
  | { readonly id: string; readonly action: 'update'; readonly patch: { readonly title: string } }
  | { readonly id: string; readonly action: 'delete' }

/** One `workspace/follow` frame, structurally (only the fields this probe reads). */
interface WorkspaceFollowFrameLike {
  readonly type: string
  readonly value?: { readonly items?: readonly unknown[] }
  readonly workspace?: unknown
}

/** The `workspace/create` value, structurally. */
interface WorkspaceCreateValueLike {
  readonly workspace?: unknown
  readonly created?: unknown
}

/** The exact Remote faces this probe calls. */
interface HostFoundationRemote {
  readonly session: {
    list(request: Record<string, never>): Promise<RemoteResultLike<{ readonly items?: unknown }>>
  }
  readonly piTuiFileReferences: {
    list(sessionId: string, query: string): Promise<RemoteResultLike<{ readonly kind?: unknown }>>
  }
  readonly piTuiTerminalProgress: {
    watch(sessionId: string, signal?: AbortSignal): RemoteStreamHandle<PiTuiTerminalProgressFrame, never>
  }
  readonly workspace: {
    create(request: { readonly path: string }): Promise<RemoteResultLike<WorkspaceCreateValueLike>>
    follow(signal?: AbortSignal): RemoteStreamHandle<WorkspaceFollowFrameLike, never>
  }
  readonly schedule: {
    catalog(): Promise<RemoteResultLike<readonly ScheduleEntryFacts[]>>
    create(request: ScheduleCreateRequestLike): Promise<RemoteResultLike<ScheduleEntryFacts>>
    edit(request: ScheduleEditRequestLike): Promise<RemoteResultLike<unknown>>
  }
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
}

/** Inputs supplied by the Client entry (already-authenticated facts only). */
export interface HostFoundationProbeOptions {
  /** Installed `@deepseek-ai/dsh/package.json` anchor (installed-DSH resolution). */
  readonly dshAnchor: string
  /** The authenticated Host candidate the Client transport already verified. */
  readonly host: VerifiedLocalHost
  /** Qualification correlation id used by the split-process harness. */
  readonly requestId?: string
  /**
   * Qualification-only: an EXISTING absolute directory the harness created in
   * its isolated work directory. The Host, not this Client, canonicalizes and
   * records it; this field never reaches the surface runtime or a package API.
   *
   * Absent = the caller does not request the official `workspace` proof. The M4
   * cross-build lane runs a NEW Client against a Host that predates the
   * `workspace` namespace, so it must be able to ask for the Session/private
   * RPC proof alone. A REQUESTED Workspace proof is all-or-nothing: it either
   * produces every field below or fails the whole probe, never a degraded
   * subset.
   */
  readonly workspacePath?: string
  /**
   * Qualification-only: drop the Client's physical carrier right after the
   * Workspace stream reaches its hold point, so the SAME live iterator must
   * resume on a NEW Connection generation. Supplied by the Client entry, which
   * owns the transport; the probe never creates or disposes a transport.
   */
  readonly dropCarrier?: () => void
  /**
   * Qualification-only: read the Client transport's current Connection
   * generation id (the entry's own status projection). Supplied together with
   * `dropCarrier`; the probe never reaches into the Client Context for it.
   */
  readonly readGeneration?: () => number | undefined
  /**
   * Qualification-only: request the official `schedule` Remote namespace proof.
   * Absent = the caller does not request it (an older Host, or the cross-build
   * lane, may expose no `schedule` namespace). A requested Schedule proof is
   * all-or-nothing: it produces every field below or fails the whole probe.
   */
  readonly schedule?: boolean
}

/** The structured proof written as one `m4b2hf: 'host-rpc-proof'` record. */
export interface HostFoundationProof {
  readonly m4b2hf: 'host-rpc-proof'
  readonly hostPid: number
  readonly hostInstanceId: string
  readonly clientPid: number
  readonly officialSessionList: true
  readonly privateFileRpc: true
  readonly terminalSnapshot: true
  /** The official generated `workspace` namespace answered through the Host.
   *  Present only when the caller passed `workspacePath`. */
  readonly workspaceRemote?: true
  /** `workspace/follow` opened with an authoritative baseline. */
  readonly workspaceBaseline?: true
  /** Whether the baseline already carried the Workspace this probe resolved. */
  readonly workspaceInBaseline?: boolean
  /** `workspace/create` reported `created` for THIS call. */
  readonly workspaceCreated?: boolean
  /** A second identical `create` reported `created=false` and the same id. */
  readonly workspaceIdempotent?: true
  /** The matching `upsert` frame (never a local echo) named this Workspace. */
  readonly workspaceUpsert?: boolean
  /** The Host-assigned Workspace identity. */
  readonly workspaceId?: string
  /** The Host canonical directory path of that Workspace. */
  readonly workspacePath?: string
  /** The held stream observed a NEW Connection generation. */
  readonly workspaceGenerationAdvanced?: boolean
  /** The held stream ended/failed instead of writing into the new generation. */
  readonly workspaceHeldStreamClosed?: boolean
  /** A NEW stream on the same Client recovered the Host's complete baseline. */
  readonly workspaceRestoredBaseline?: boolean
  /** The official generated `schedule` namespace answered through the Host.
   *  Present only when the caller passed `schedule: true`. */
  readonly scheduleRemote?: true
  /** `schedule/catalog` answered with a real Host task list. */
  readonly scheduleCatalog?: true
  /** `schedule/create` returned the Host-assigned task identity. */
  readonly scheduleCreate?: true
  /** `schedule/edit` applied the CAS update to the created task. */
  readonly scheduleEdit?: true
  /** After a physical carrier replacement, a NEW `catalog` still listed the
   *  created task (present only when the generation-resume control was used). */
  readonly scheduleReconnectCatalog?: boolean
  /** The probe deleted the task it created and re-read the catalog without it.
   *  A qualification Host profile is durable and shared by later scenarios, so a
   *  leftover ACTIVE task would corrupt their liveness observation. */
  readonly scheduleDeleted?: true
  readonly cleaned: true
}

/**
 * Load one official generated `/remote` contribution from the installed DSH
 * anchor. This is the same installed-package resolution strategy the B1
 * transport already uses; a source-tree module must never participate.
 */
async function loadInstalledRemote(dshAnchor: string, specifier: string): Promise<TypertRemoteContribution> {
  const requireFromDsh = createRequire(realpathSync(dshAnchor))
  const resolved = requireFromDsh.resolve(specifier)
  const module = await import(pathToFileURL(resolved).href) as { readonly default?: unknown }
  const contribution = module.default
  if (
    typeof contribution !== 'object'
    || contribution === null
    || !Array.isArray((contribution as { readonly descriptors?: unknown }).descriptors)
  ) {
    throw new Error(`host foundation probe: the installed ${specifier} export is not a Remote contribution`)
  }
  return contribution as TypertRemoteContribution
}

function remoteOf(context: Context): HostFoundationRemote {
  const remote = (context as unknown as { readonly remote?: HostFoundationRemote }).remote
  if (remote === undefined) {
    throw new Error('host foundation probe: the Client Context has no official Remote service')
  }
  return remote
}

/**
 * Wait at the qualification hold point so the split-process harness can read
 * the live Host subscriber count while the watch is still open. Production
 * never sets this environment variable.
 */
async function waitForQualificationBarrier(path: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`host foundation probe: the qualification barrier was not released: ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Validate the opening terminal-progress snapshot required by T24. */
function assertOpeningSnapshot(frame: PiTuiTerminalProgressFrame | undefined): void {
  if (frame === undefined || frame.kind !== 'snapshot') {
    throw new Error('host foundation probe: the terminal-progress watch did not open with a snapshot')
  }
  if (frame.sessionId !== PROBE_SESSION_ID) {
    throw new Error('host foundation probe: the terminal-progress snapshot names another Session')
  }
  if (frame.running !== false || frame.outcome !== 'idle') {
    throw new Error('host foundation probe: the terminal-progress baseline is not idle')
  }
  if (typeof frame.hostEpoch !== 'string' || frame.hostEpoch === '') {
    throw new Error('host foundation probe: the terminal-progress snapshot has no Host epoch')
  }
  if (!Number.isSafeInteger(frame.agentEpoch) || !Number.isSafeInteger(frame.revision)) {
    throw new Error('host foundation probe: the terminal-progress snapshot has invalid epoch/revision')
  }
}

/**
 * Await the next frame of one Workspace stream under the qualification bound.
 * A stream that ends or stalls is a FAIL, never an empty success.
 */
async function nextWorkspaceFrame(
  iterator: AsyncIterator<WorkspaceFollowFrameLike>,
  label: string,
): Promise<WorkspaceFollowFrameLike> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`host foundation probe: timed out waiting for ${label}`))
    }, WORKSPACE_FRAME_TIMEOUT_MS)
  })
  try {
    const next = await Promise.race([iterator.next(), timeout])
    if (next.done === true) {
      throw new Error(`host foundation probe: the Workspace stream ended before ${label}`)
    }
    return next.value
  } finally {
    clearTimeout(timer)
  }
}

/** Bounded wait for one pull of a HELD stream, so a hang is classified separately. */
class HeldStreamWaitTimeout extends Error {}

/** What one pull of the held stream produced after the generation replacement. */
type HeldStreamOutcome =
  | { readonly kind: 'frame'; readonly frame: WorkspaceFollowFrameLike }
  | { readonly kind: 'ended' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Pull one HELD Workspace iterator once and classify the outcome. A frame means
 * the obsolete generation still wrote into the Client (stale delivery); an ended
 * iterator or a carrier failure means the generation is gone and wrote nothing.
 */
async function pullHeldStream(iterator: AsyncIterator<WorkspaceFollowFrameLike>): Promise<HeldStreamOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new HeldStreamWaitTimeout('held-stream-wait-timeout')) }, WORKSPACE_FRAME_TIMEOUT_MS)
  })
  try {
    const next = await Promise.race([iterator.next(), timeout])
    return next.done === true ? { kind: 'ended' } : { kind: 'frame', frame: next.value }
  } catch (error) {
    if (error instanceof HeldStreamWaitTimeout) {
      throw new Error('host foundation probe: the held Workspace stream neither ended nor reported a carrier failure within its bound')
    }
    return { kind: 'failed', error }
  } finally {
    clearTimeout(timer)
  }
}

/** Read one Workspace projection out of an unknown Remote value, or fail loudly. */
function readWorkspaceFacts(value: unknown, label: string): WorkspaceFacts {
  const candidate = value as
    | { readonly workspaceId?: unknown; readonly path?: unknown; readonly sessionIds?: unknown }
    | undefined
  if (
    candidate === undefined
    || typeof candidate.workspaceId !== 'string'
    || candidate.workspaceId === ''
    || typeof candidate.path !== 'string'
    || !isAbsolute(candidate.path)
    || !Array.isArray(candidate.sessionIds)
    || !candidate.sessionIds.every(sessionId => typeof sessionId === 'string')
  ) {
    throw new Error(`host foundation probe: ${label} did not return a Workspace projection: ${JSON.stringify(value)}`)
  }
  return {
    workspaceId: candidate.workspaceId,
    path: candidate.path,
    sessionIds: candidate.sessionIds as readonly string[],
  }
}

/**
 * Prove the official `workspace` namespace over the authenticated link: a real
 * baseline, a Host-created Workspace, the matching authoritative `upsert`, one
 * idempotent repeat and a stream that really ends on dispose.
 *
 * The frames are correlated by Workspace identity rather than by position: a
 * create may emit `upsert` and `order`, and the baseline may arrive with other
 * Workspaces already registered.
 */
/**
 * Qualification-only generation-currentness control for the held stream. The
 * probe owns the timing: it drops the carrier itself and waits for the Client's
 * own Connection to publish a replacement generation. It deliberately issues no
 * control request while the stream is held — the entry's control channel is
 * serialized, so a status round trip would deadlock behind this handler.
 */
interface WorkspaceResumeControl {
  /** Read the live Client Connection generation id, or undefined. */
  readGeneration(): number | undefined
  /** The generation the stream was opened on. */
  readonly generationBefore: number | undefined
  /** Drop the Client's physical carrier, forcing a replacement generation. */
  dropCarrier(): void
  readonly requestId?: string
}

async function proveWorkspace(
  remote: HostFoundationRemote,
  workspacePath: string,
  resume?: WorkspaceResumeControl,
): Promise<{
  readonly baseline: true
  readonly inBaseline: boolean
  readonly created: boolean
  readonly idempotent: true
  readonly upsert: boolean
  readonly workspaceId: string
  readonly path: string
  readonly generationAdvanced: boolean
  readonly heldStreamClosed: boolean
  readonly restoredBaseline: boolean
}> {
  const expectedPath = realpathSync(workspacePath)
  const stream = remote.workspace.follow()
  const iterator = stream[Symbol.asyncIterator]()
  let streamClosed = false
  try {
    const opening = await nextWorkspaceFrame(iterator, 'the Workspace baseline')
    if (opening.type !== 'baseline' || !Array.isArray(opening.value?.items)) {
      throw new Error(`host foundation probe: workspace/follow did not open with a baseline: ${JSON.stringify(opening)}`)
    }
    const baselineIds = new Set<string>()
    for (const item of opening.value.items) {
      baselineIds.add(readWorkspaceFacts(item, 'the Workspace baseline').workspaceId)
    }

    const first = await remote.workspace.create({ path: workspacePath })
    if (first.ok !== true || first.value === undefined) {
      throw new Error(`host foundation probe: workspace/create did not return ok: ${JSON.stringify(first)}`)
    }
    if (typeof first.value.created !== 'boolean') {
      throw new Error(`host foundation probe: workspace/create did not report "created": ${JSON.stringify(first.value)}`)
    }
    const createdWorkspace = readWorkspaceFacts(first.value.workspace, 'workspace/create')
    if (createdWorkspace.path !== expectedPath) {
      throw new Error(
        `host foundation probe: workspace/create returned "${createdWorkspace.path}" instead of the Host canonical "${expectedPath}"`,
      )
    }

    // The Host feed, not a local echo: a create that CREATES must arrive as a
    // matching `upsert` on the stream opened before it. A create that merely
    // resolves an existing Workspace changes nothing, so it emits no frame and
    // is instead proven by the baseline that already carried the identity.
    const inBaseline = baselineIds.has(createdWorkspace.workspaceId)
    let upserted: WorkspaceFacts | undefined
    if (first.value.created) {
      if (inBaseline) {
        throw new Error(
          `host foundation probe: workspace/create reported a new Workspace while the baseline already carried "${createdWorkspace.workspaceId}"`,
        )
      }
      for (let frames = 0; frames < WORKSPACE_FRAME_LIMIT; frames += 1) {
        const frame = await nextWorkspaceFrame(iterator, `the "${createdWorkspace.workspaceId}" Workspace upsert`)
        if (frame.type !== 'upsert') continue
        const candidate = readWorkspaceFacts(frame.workspace, 'a Workspace upsert frame')
        if (candidate.workspaceId === createdWorkspace.workspaceId) {
          upserted = candidate
          break
        }
      }
      if (upserted === undefined) {
        throw new Error(
          `host foundation probe: workspace/follow never reported an upsert for "${createdWorkspace.workspaceId}"`,
        )
      }
      if (upserted.path !== createdWorkspace.path
        || JSON.stringify(upserted.sessionIds) !== JSON.stringify(createdWorkspace.sessionIds)) {
        throw new Error(
          `host foundation probe: the Workspace upsert disagrees with workspace/create: ${JSON.stringify(upserted)} vs ${JSON.stringify(createdWorkspace)}`,
        )
      }
    } else if (!inBaseline) {
      throw new Error(
        `host foundation probe: workspace/create resolved "${createdWorkspace.workspaceId}" but the baseline did not carry it`,
      )
    }

    const second = await remote.workspace.create({ path: workspacePath })
    if (second.ok !== true || second.value === undefined || second.value.created !== false) {
      throw new Error(`host foundation probe: a repeated workspace/create was not an idempotent resolve: ${JSON.stringify(second)}`)
    }
    const resolvedWorkspace = readWorkspaceFacts(second.value.workspace, 'the repeated workspace/create')
    if (resolvedWorkspace.workspaceId !== createdWorkspace.workspaceId) {
      throw new Error(
        `host foundation probe: a repeated workspace/create returned "${resolvedWorkspace.workspaceId}" instead of "${createdWorkspace.workspaceId}"`,
      )
    }

    let generationAdvanced = false
    let heldStreamClosed = false
    let restoredBaseline = false
    if (resume !== undefined) {
      // Qualification-only: hold this SAME iterator open across a physical
      // carrier replacement. The held stream may only continue by re-reading
      // the Host's complete baseline on the NEW generation: a state increment
      // (`upsert`) arriving first would be stale/partial delivery.
      if (resume.requestId !== undefined) {
        writeEntryRecord({
          m4b2hf: 'workspace-hold-open',
          processRole: 'client',
          pid: process.pid,
          requestId: resume.requestId,
        })
      }
      resume.dropCarrier()
      const deadline = Date.now() + WORKSPACE_FRAME_TIMEOUT_MS
      let generationAfter = resume.readGeneration()
      while (
        generationAfter === undefined
        || resume.generationBefore === undefined
        || generationAfter <= resume.generationBefore
      ) {
        if (Date.now() > deadline) {
          throw new Error(
            `host foundation probe: the held Workspace stream did not observe a replacement Connection generation (${String(resume.generationBefore)} -> ${String(generationAfter)})`,
          )
        }
        await new Promise(resolve => setTimeout(resolve, 25))
        generationAfter = resume.readGeneration()
      }
      generationAdvanced = true
      // The held iterator's generation is gone: it may END or fail as a carrier
      // stream, but it may never deliver a frame into the replacement
      // generation. A frame here is stale delivery.
      const held = await pullHeldStream(iterator)
      if (held.kind === 'frame') {
        throw new Error(
          `host foundation probe: the held Workspace stream delivered a "${held.frame.type}" frame after its Connection generation was replaced`,
        )
      }
      heldStreamClosed = true
      // A NEW stream on the SAME Client must recover from the authoritative Host
      // baseline (not a Client cache) and carry the Workspace the Host already
      // published on the previous generation.
      const restarted = remote.workspace.follow()
      const restartedIterator = restarted[Symbol.asyncIterator]()
      try {
        const baseline = await nextWorkspaceFrame(restartedIterator, 'the post-replacement Workspace baseline')
        if (baseline.type !== 'baseline' || !Array.isArray(baseline.value?.items)) {
          throw new Error(
            `host foundation probe: the post-replacement stream did not open with a Host baseline: ${JSON.stringify(baseline)}`,
          )
        }
        const restoredIds = baseline.value.items.map(item =>
          readWorkspaceFacts(item, 'the post-replacement Workspace baseline').workspaceId)
        if (!restoredIds.includes(createdWorkspace.workspaceId)) {
          throw new Error(
            `host foundation probe: the post-replacement baseline dropped the Workspace the Host had already published (${JSON.stringify(restoredIds)})`,
          )
        }
        restoredBaseline = true
      } finally {
        restarted.dispose()
      }
    }

    stream.dispose()
    streamClosed = true
    const ended = await iterator.next()
    if (ended.done !== true) {
      throw new Error('host foundation probe: the Workspace stream did not end after dispose')
    }
    return {
      baseline: true,
      inBaseline,
      created: first.value.created,
      idempotent: true,
      upsert: upserted !== undefined,
      workspaceId: createdWorkspace.workspaceId,
      path: createdWorkspace.path,
      generationAdvanced,
      heldStreamClosed,
      restoredBaseline,
    }
  } finally {
    if (!streamClosed) {
      try {
        stream.dispose()
      } catch {
        // The caller's cleanup collector reports the contribution teardown; a
        // dispose failure here must not mask the Workspace proof failure.
      }
    }
  }
}

/**
 * Qualification-only generation-currentness control for the Schedule catalog:
 * drop the physical carrier the Client transport owns, then wait until the
 * Client publishes a replacement Connection generation. The probe never issues
 * a control request while the transport is mid-replacement.
 */
interface ScheduleResumeControl {
  readGeneration(): number | undefined
  dropCarrier(): void
}

/** Wait until the Client's own Connection generation advances past `before`. */
async function waitForCarrierReplacement(
  readGeneration: () => number | undefined,
  before: number | undefined,
): Promise<void> {
  const deadline = Date.now() + WORKSPACE_FRAME_TIMEOUT_MS
  let after = readGeneration()
  while (after === undefined || before === undefined || after <= before) {
    if (Date.now() > deadline) {
      throw new Error(
        `host foundation probe: the Schedule catalog did not observe a replacement Connection generation (${String(before)} -> ${String(after)})`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 25))
    after = readGeneration()
  }
}

/**
 * Prove the official `schedule` namespace over the authenticated link on the
 * SAME live Client Context: a real `catalog`, a Host-created task returned with
 * its identity, one CAS `edit`, and — when the resume control is supplied — a
 * fresh `catalog` on a replacement Connection generation that STILL lists the
 * created task. A failure in any stage throws; the probe never swallows a
 * business/transport error into a false PASS.
 */
async function proveSchedule(
  remote: HostFoundationRemote,
  resume?: ScheduleResumeControl,
): Promise<{
  readonly catalog: true
  readonly create: true
  readonly edit: true
  readonly deleted: true
  readonly reconnectCatalog?: boolean
}> {
  const opening = await remote.schedule.catalog()
  if (opening.ok !== true || !Array.isArray(opening.value)) {
    throw new Error(`host foundation probe: schedule/catalog did not return ok with an entry array: ${JSON.stringify(opening)}`)
  }
  const baselineIds = new Set(opening.value.map(entry => entry.id))

  const title = `probe-schedule-${Date.now()}-${process.pid}`
  const created = await remote.schedule.create({
    title,
    prompt: 'host foundation probe schedule task',
    // A far-future one-shot occurrence: the Host never delivers it during the
    // probe, so the proof observes only creation/edit/catalog state.
    timing: { kind: 'after', after_seconds: 3600 },
  })
  if (created.ok !== true || created.value === undefined) {
    throw new Error(`host foundation probe: schedule/create did not return ok: ${JSON.stringify(created)}`)
  }
  const entry = created.value
  if (typeof entry.id !== 'string' || entry.id === '' || entry.title !== title) {
    throw new Error(`host foundation probe: schedule/create did not return the created task identity: ${JSON.stringify(entry)}`)
  }
  if (baselineIds.has(entry.id)) {
    throw new Error(`host foundation probe: schedule/create returned an identity the opening catalog already held: ${entry.id}`)
  }

  const editedTitle = `${title}-edited`
  const edited = await remote.schedule.edit({ id: entry.id, action: 'update', patch: { title: editedTitle } })
  if (edited.ok !== true || edited.value === undefined) {
    throw new Error(`host foundation probe: schedule/edit did not return ok: ${JSON.stringify(edited)}`)
  }
  const editedEntry = edited.value as Partial<ScheduleEntryFacts>
  if (editedEntry.id !== entry.id || editedEntry.title !== editedTitle) {
    throw new Error(`host foundation probe: schedule/edit did not return the updated task: ${JSON.stringify(editedEntry)}`)
  }

  let reconnectCatalog: boolean | undefined
  if (resume !== undefined) {
    const generationBefore = resume.readGeneration()
    resume.dropCarrier()
    await waitForCarrierReplacement(resume.readGeneration, generationBefore)
    // A NEW unary call on the replacement generation must reach the SAME Host
    // authority and still list the task the previous generation created.
    const after = await remote.schedule.catalog()
    if (after.ok !== true || !Array.isArray(after.value)) {
      throw new Error(`host foundation probe: the post-replacement schedule/catalog did not return ok: ${JSON.stringify(after)}`)
    }
    reconnectCatalog = after.value.some(candidate => candidate.id === entry.id)
    if (!reconnectCatalog) {
      throw new Error(
        `host foundation probe: the post-replacement schedule/catalog dropped the task the Host had already created (${entry.id})`,
      )
    }
  }

  // The probe runs inside a durable Host profile that later qualification
  // scenarios share: an ACTIVE task left behind would make their Host-liveness
  // observation legitimately BLOCKED (`schedule-active`). Delete the task the
  // probe created and prove the catalog no longer lists it.
  const deleted = await remote.schedule.edit({ id: entry.id, action: 'delete' })
  if (deleted.ok !== true) {
    throw new Error(`host foundation probe: schedule/edit(delete) did not return ok: ${JSON.stringify(deleted)}`)
  }
  const afterDelete = await remote.schedule.catalog()
  if (afterDelete.ok !== true || !Array.isArray(afterDelete.value)) {
    throw new Error(`host foundation probe: the post-delete schedule/catalog did not return ok: ${JSON.stringify(afterDelete)}`)
  }
  if (afterDelete.value.some(candidate => candidate.id === entry.id)) {
    throw new Error(`host foundation probe: the deleted schedule task is still listed: ${entry.id}`)
  }

  return { catalog: true, create: true, edit: true, deleted: true, ...resume === undefined ? {} : { reconnectCatalog } }
}

/**
 * Execute the real Host RPC proof on the caller's live Client Context.
 *
 * Contribution mounts are recorded immediately after each `$mount` resolves;
 * cleanup runs in reverse order in `finally`, so a failed second mount still
 * unmounts the first. Cleanup failures attach to the original RPC error as its
 * cause chain instead of masking it. The result is returned only after the
 * contribution unmounts and the stream cancellations both succeeded.
 */
export async function runHostFoundationProbe(
  context: Context,
  options: HostFoundationProbeOptions,
): Promise<HostFoundationProof> {
  if ((options.dropCarrier === undefined) !== (options.readGeneration === undefined)) {
    throw new Error(
      'host foundation probe: the generation-resume control requires BOTH dropCarrier and readGeneration',
    )
  }
  if (options.dropCarrier !== undefined && options.workspacePath === undefined) {
    throw new Error('host foundation probe: the generation-resume control requires the Workspace proof')
  }
  const remote = remoteOf(context)
  const sessionRemote = await loadInstalledRemote(options.dshAnchor, '@deepseek-ai/dsh-api-session-controller/remote')
  const workspaceRequest = options.workspacePath
  const workspaceRemote = workspaceRequest === undefined
    ? undefined
    : await loadInstalledRemote(options.dshAnchor, '@deepseek-ai/dsh-api-workspace-controller/remote')
  const scheduleRemote = options.schedule === true
    ? await loadInstalledRemote(options.dshAnchor, '@deepseek-ai/dsh-schedule/remote')
    : undefined
  const disposers: Array<() => Promise<void>> = []
  const cleanupErrors: unknown[] = []
  let watch: RemoteStreamHandle<PiTuiTerminalProgressFrame, never> | undefined
  let watchIterator: AsyncIterator<PiTuiTerminalProgressFrame> | undefined
  let result: Omit<HostFoundationProof, 'm4b2hf' | 'hostPid' | 'hostInstanceId' | 'clientPid' | 'cleaned'> | undefined
  let primaryError: unknown

  try {
    // The package's ONE private contribution first, then the official
    // controller contributions; each disposer is owned the instant `$mount`
    // resolves.
    disposers.push(await remote.$mount(PI_TUI_CLIENT_CONTRIBUTION))
    disposers.push(await remote.$mount(sessionRemote))
    if (workspaceRemote !== undefined) disposers.push(await remote.$mount(workspaceRemote))
    if (scheduleRemote !== undefined) disposers.push(await remote.$mount(scheduleRemote))

    const list = await remote.session.list({})
    if (list.ok !== true || !Array.isArray(list.value?.items)) {
      throw new Error(`host foundation probe: official session/list did not return ok with an items array: ${JSON.stringify(list)}`)
    }

    const fileResult = await remote.piTuiFileReferences.list(PROBE_SESSION_ID, 'notes')
    if (fileResult.ok !== true || fileResult.value?.kind !== 'unavailable') {
      throw new Error(`host foundation probe: private PiFile RPC did not return ok/unavailable: ${JSON.stringify(fileResult)}`)
    }

    watch = remote.piTuiTerminalProgress.watch(PROBE_SESSION_ID)
    watchIterator = watch[Symbol.asyncIterator]()
    const opening = await watchIterator.next()
    if (opening.done) {
      throw new Error('host foundation probe: the terminal-progress watch ended before its snapshot')
    }
    assertOpeningSnapshot(opening.value)
    if (options.requestId !== undefined) {
      writeEntryRecord({
        m4b2hf: 'host-rpc-watch-open',
        processRole: 'client',
        pid: process.pid,
        requestId: options.requestId,
      })
    }
    const barrier = process.env.SPLIT_PROCESS_HOST_FOUNDATION_BARRIER
    if (barrier !== undefined && barrier !== '') await waitForQualificationBarrier(barrier)
    watch.dispose()
    const ended = await watchIterator.next()
    if (ended.done !== true) {
      throw new Error('host foundation probe: the terminal-progress watch did not end after dispose')
    }
    watch = undefined
    watchIterator = undefined

    // The official `workspace` namespace over the SAME authenticated link and
    // the same live Host registry, when the caller requested that proof. It
    // runs after the terminal-progress proof so its live Host watch count is
    // still observed first.
    const dropCarrier = options.dropCarrier
    const readGeneration = options.readGeneration
    if ((dropCarrier === undefined) !== (readGeneration === undefined)) {
      throw new Error(
        'host foundation probe: the generation-resume control requires BOTH dropCarrier and readGeneration',
      )
    }
    const workspace = workspaceRequest === undefined
      ? undefined
      : await proveWorkspace(
          remote,
          workspaceRequest,
          dropCarrier === undefined || readGeneration === undefined
            ? undefined
            : {
                readGeneration,
                generationBefore: readGeneration(),
                dropCarrier,
                ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
              },
        )

    // The official `schedule` namespace on the SAME authenticated link. When
    // the generation-resume control is live it drops the carrier a second time
    // and reads the catalog on the replacement generation; otherwise it proves
    // catalog/create/edit only.
    const schedule = options.schedule === true
      ? await proveSchedule(
          remote,
          dropCarrier === undefined || readGeneration === undefined
            ? undefined
            : { readGeneration, dropCarrier },
        )
      : undefined

    result = {
      officialSessionList: true,
      privateFileRpc: true,
      terminalSnapshot: true,
      ...schedule === undefined
        ? {}
        : {
            scheduleRemote: true as const,
            scheduleCatalog: schedule.catalog,
            scheduleCreate: schedule.create,
            scheduleEdit: schedule.edit,
            scheduleDeleted: schedule.deleted,
            ...schedule.reconnectCatalog === undefined
              ? {}
              : { scheduleReconnectCatalog: schedule.reconnectCatalog },
          },
      ...workspace === undefined
        ? {}
        : {
            workspaceRemote: true as const,
            workspaceBaseline: workspace.baseline,
            workspaceInBaseline: workspace.inBaseline,
            workspaceCreated: workspace.created,
            workspaceIdempotent: workspace.idempotent,
            workspaceUpsert: workspace.upsert,
            workspaceId: workspace.workspaceId,
            workspacePath: workspace.path,
            ...options.dropCarrier === undefined
              ? {}
              : {
                  workspaceGenerationAdvanced: workspace.generationAdvanced,
                  workspaceHeldStreamClosed: workspace.heldStreamClosed,
                  workspaceRestoredBaseline: workspace.restoredBaseline,
                },
          },
    }
  } catch (error) {
    primaryError = error
  } finally {
    if (watch !== undefined) {
      try {
        watch.dispose()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        await disposers[index]()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }

  if (primaryError !== undefined) {
    const primary = primaryError instanceof Error ? primaryError : new Error(String(primaryError))
    if (cleanupErrors.length > 0) {
      const secondary = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'host foundation probe: contribution cleanup failures')
      throw mergeCause(primary, secondary)
    }
    throw primary
  }
  if (result === undefined) {
    throw new Error('host foundation probe: no proof was produced')
  }
  if (cleanupErrors.length > 0) {
    const failure = new Error('host foundation probe: contribution cleanup failed')
    throw mergeCause(failure, cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'host foundation probe: contribution cleanup failures'))
  }
  return {
    m4b2hf: 'host-rpc-proof',
    hostPid: options.host.identity.hostPid,
    hostInstanceId: options.host.identity.instanceId,
    clientPid: process.pid,
    ...result,
    cleaned: true,
  }
}
