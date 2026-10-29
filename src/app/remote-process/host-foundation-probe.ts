/**
 * M4-B2-HF real Host RPC qualification probe.
 *
 * Runs ONLY on the existing B1 Client Context after the authenticated
 * transport is live. It temporarily mounts two Remote contributions — the
 * package's own private contribution and the official Session controller
 * `/remote` contribution — calls the official `session/list` RPC, the private
 * PiFile RPC and one private terminal-progress watch, then unmounts both in
 * reverse order. It creates no Context, no Connection and no Gateway.
 *
 * The probe is an internal qualification control (not an npm export, CLI
 * command or user-facing API). The caller owns the control channel; this module
 * owns only the contribution/watch lifetime and the structured proof.
 *
 * @module app/remote-process/host-foundation-probe
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamHandle, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PI_TUI_CLIENT_CONTRIBUTION } from '../../runtime/remote/pi-tui-remote-contribution.ts'
import type { PiTuiTerminalProgressFrame } from '../../runtime/remote/pi-tui-terminal-progress-contract.ts'
import { mergeCause } from '../remote/dispose-cause.ts'
import type { VerifiedLocalHost } from './local-discovery.ts'

/** The no-live-Agent Session id every negative business probe names. */
const PROBE_SESSION_ID = 'm4-hf-no-live-agent'

/** One Remote unary result, structurally (the Gateway Client face). */
interface RemoteResultLike<Value> {
  readonly ok: boolean
  readonly value?: Value
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
  $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
}

/** Inputs supplied by the Client entry (already-authenticated facts only). */
export interface HostFoundationProbeOptions {
  /** Installed `@deepseek-ai/dsh/package.json` anchor (installed-DSH resolution). */
  readonly dshAnchor: string
  /** The authenticated Host candidate the Client transport already verified. */
  readonly host: VerifiedLocalHost
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
  readonly cleaned: true
}

/**
 * Load the official Session controller Client contribution from the installed
 * DSH anchor. This is the same installed-package resolution strategy the B1
 * transport already uses; a source-tree module must never participate.
 */
async function loadOfficialSessionRemote(dshAnchor: string): Promise<TypertRemoteContribution> {
  const requireFromDsh = createRequire(realpathSync(dshAnchor))
  const resolved = requireFromDsh.resolve('@deepseek-ai/dsh-api-session-controller/remote')
  const module = await import(pathToFileURL(resolved).href) as { readonly default?: unknown }
  const contribution = module.default
  if (
    typeof contribution !== 'object'
    || contribution === null
    || !Array.isArray((contribution as { readonly descriptors?: unknown }).descriptors)
  ) {
    throw new Error('host foundation probe: the installed Session controller /remote export is not a Remote contribution')
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
 * Execute the real Host RPC proof on the caller's live Client Context.
 *
 * Contribution mounts are recorded immediately after each `$mount` resolves;
 * cleanup runs in reverse order in `finally`, so a failed second mount still
 * unmounts the first. Cleanup failures attach to the original RPC error as its
 * cause chain instead of masking it. The result is returned only after the
 * contribution unmounts and the watch cancellation both succeeded.
 */
export async function runHostFoundationProbe(
  context: Context,
  options: HostFoundationProbeOptions,
): Promise<HostFoundationProof> {
  const remote = remoteOf(context)
  const sessionRemote = await loadOfficialSessionRemote(options.dshAnchor)
  const disposers: Array<() => Promise<void>> = []
  const cleanupErrors: unknown[] = []
  let watch: RemoteStreamHandle<PiTuiTerminalProgressFrame, never> | undefined
  let watchIterator: AsyncIterator<PiTuiTerminalProgressFrame> | undefined
  let result: Omit<HostFoundationProof, 'm4b2hf' | 'hostPid' | 'hostInstanceId' | 'clientPid' | 'cleaned'> | undefined
  let primaryError: unknown

  try {
    // The package's ONE private contribution first, then the official Session
    // controller contribution; each disposer is owned the instant `$mount`
    // resolves.
    disposers.push(await remote.$mount(PI_TUI_CLIENT_CONTRIBUTION))
    disposers.push(await remote.$mount(sessionRemote))

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
    watch.dispose()
    const ended = await watchIterator.next()
    if (ended.done !== true) {
      throw new Error('host foundation probe: the terminal-progress watch did not end after dispose')
    }
    watch = undefined
    watchIterator = undefined

    result = {
      officialSessionList: true,
      privateFileRpc: true,
      terminalSnapshot: true,
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
