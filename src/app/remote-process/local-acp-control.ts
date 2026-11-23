/**
 * The headless ACP CLI runner (PR-C ACP headless CLI).
 *
 * One short-lived management process reads the installed Profile through the
 * existing read-only scope inspection, authenticates the ONE live Host with the
 * official `/connect` Cookie + identity + fresh kernel check, then performs
 * exactly ONE Host request:
 *
 * ```text
 * acp status          -> existing GET  /api/pi-tui.acp-status  (pure read)
 * acp enable/disable  -> Owner-only POST /api/pi-tui.acp-control (ONE write)
 * ```
 *
 * It never starts a Host, never opens a TUI/Client, never creates a
 * Session/Agent/Writer, never spawns the ACP stdio adapter and never caches an
 * ACP state. The ONE Host-entry ACP runtime controller remains the only socket
 * owner; this module only drives it through the authenticated management route.
 *
 * Every failure is mapped to the fixed code/exit taxonomy; no raw Error
 * message, Host response body, Cookie, socket path or private path reaches
 * stdout/stderr.
 *
 * @module app/remote-process/local-acp-control
 */

import type { AcpAccessStatus } from '../../runtime/acp-access-port.ts'
import type { AcpControlIntent } from '../../startup.ts'
import { observeAuthenticatedLocalAcpStatus } from './local-acp-status.ts'
import {
  LOCAL_ACP_CONTROL_MAX_RESPONSE_BYTES,
  LOCAL_ACP_CONTROL_ROUTE,
  LOCAL_ACP_CONTROL_TIMEOUT_MS,
  parseLocalAcpControlReply,
  type LocalAcpControlOp,
  type LocalAcpControlReply,
  type LocalAcpControlState,
} from './local-acp-control-route.ts'
import type { DaemonControlProfile, DaemonControlResult } from './local-daemon-control.ts'
import {
  assertClientHostCompatible,
  assertRecordedHostKernelIdentityCurrent,
  authenticateLocalHost,
  inspectHostProcess,
  readLocalRecord,
  sameLocalInstanceRecord,
  type LocalInstanceRecord,
  type VerifiedLocalHost,
} from './local-discovery.ts'
import { inspectInstalledProfileScope, type LocalScope } from './local-scope.ts'

/** The fixed failure vocabulary of the headless ACP CLI. */
export type AcpControlErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'HOST_NOT_RUNNING'
  | 'HOST_IDENTITY_REFUSED'
  | 'HOST_AUTH_FAILED'
  | 'ACP_CLI_UNAVAILABLE'
  | 'ACP_UNAVAILABLE'
  | 'ACP_OUTCOME_UNCONFIRMED'

const EXIT_CODE: Readonly<Record<AcpControlErrorCode, number>> = {
  UNSUPPORTED_PLATFORM: 3,
  HOST_NOT_RUNNING: 3,
  HOST_IDENTITY_REFUSED: 3,
  HOST_AUTH_FAILED: 3,
  ACP_CLI_UNAVAILABLE: 4,
  ACP_UNAVAILABLE: 4,
  ACP_OUTCOME_UNCONFIRMED: 5,
}

/** One stable failure with its fixed exit class and a local-only reason. */
class AcpControlError extends Error {
  readonly code: AcpControlErrorCode
  readonly exitCode: number
  readonly reason: string
  constructor(code: AcpControlErrorCode, reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause })
    this.name = 'AcpControlError'
    this.code = code
    this.exitCode = EXIT_CODE[code]
    this.reason = reason
  }
}

/** Injectable OS/discovery seams; production omits every one of them. */
export interface LocalAcpControlDeps {
  readonly platform?: NodeJS.Platform
  readonly readRecord?: (scope: LocalScope) => LocalInstanceRecord | undefined
  readonly inspectProcess?: (record: LocalInstanceRecord) => 'alive' | 'dead'
  readonly authenticate?: (record: LocalInstanceRecord, scope: LocalScope, signal?: AbortSignal) => Promise<VerifiedLocalHost>
  /** Fresh kernel-identity recheck seam; production reads the platform kernel. */
  readonly assertKernelIdentity?: (record: LocalInstanceRecord) => void
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
}

/** One bounded HTTP write result; `status: 0` means no response. */
interface AcpControlHttpResult {
  readonly status: number
  readonly reply?: LocalAcpControlReply
}

/** POSIX-safe single-argument quoting for the copy-paste hint. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Replace private paths/URLs and control characters in a human reason. */
function sanitizeReason(text: string): string {
  const line = text.split(/\r?\n/u).map(part => part.trim()).find(part => part !== '') ?? ''
  return line
    .replace(/\/[^\s"']+/gu, '<path>')
    .replace(/https?:\/\/[^\s"']+/giu, '<url>')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .slice(0, 200)
}

function formatAcpControlError(error: AcpControlError): string {
  return `dsh-pi-tui acp: ${error.code}: ${sanitizeReason(error.reason)}\n`
}

function platformOf(deps: LocalAcpControlDeps): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function notRunningReason(profile: DaemonControlProfile): string {
  return `the Host for this Profile is not running; start it with: dsh --profile ${shellQuote(profile.name)} daemon start`
}

/** Map a lower-level failure to the fixed ACP CLI taxonomy. */
function toAcpControlError(error: unknown): AcpControlError {
  if (error instanceof AcpControlError) return error
  const code = (error as { readonly code?: unknown } | undefined)?.code
  switch (code) {
    case 'B1_PLATFORM_UNSUPPORTED':
      return new AcpControlError('UNSUPPORTED_PLATFORM', 'the acp CLI is only supported on Linux and macOS')
    case 'SCOPE_DIRECTORY_UNSAFE':
    case 'LOCAL_FILE_UNSAFE':
    case 'HOST_PROTOCOL_INCOMPATIBLE':
    case 'HOST_BUILD_INCOMPATIBLE':
    case 'HOST_IDENTITY_MISMATCH':
    case 'PROCESS_STARTTIME_UNAVAILABLE':
      return new AcpControlError('HOST_IDENTITY_REFUSED', 'the local Host identity could not be verified for this Profile', error)
    case 'HOST_HANDOFF_UNAVAILABLE':
      return new AcpControlError('HOST_NOT_RUNNING', 'the Host for this Profile is not running', error)
    case 'HOST_AUTH_FAILED':
    case 'HOST_UNRESPONSIVE':
      return new AcpControlError('HOST_AUTH_FAILED', 'the local Host did not accept the authenticated handshake', error)
    default:
      return new AcpControlError('ACP_CLI_UNAVAILABLE', 'an unexpected local ACP CLI failure occurred', error)
  }
}

/** Read at most `maxBytes` of a response body; an oversize/unreadable body is `undefined`. */
async function readBoundedResponse(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

/** Node's `RequestInit` omits the cache mode; the authenticated request is no-store. */
type LocalRequestInit = RequestInit & { readonly cache?: 'no-store' }

/** One bounded POST against the ONE Owner-only management route. */
async function callAcpControl(
  verified: VerifiedLocalHost,
  op: LocalAcpControlOp,
  deps: LocalAcpControlDeps,
): Promise<AcpControlHttpResult> {
  const timeout = AbortSignal.timeout(LOCAL_ACP_CONTROL_TIMEOUT_MS)
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout])
  const init: LocalRequestInit = {
    method: 'POST',
    headers: { cookie: verified.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ schema: 1, instanceId: verified.identity.instanceId, op }),
    redirect: 'manual',
    cache: 'no-store',
    signal,
  }
  const fetchImpl = deps.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${verified.record.origin}${LOCAL_ACP_CONTROL_ROUTE}`, init)
  } catch {
    return { status: 0 }
  }
  let text: string | undefined
  try {
    text = await readBoundedResponse(response, LOCAL_ACP_CONTROL_MAX_RESPONSE_BYTES)
  } catch {
    text = undefined
  }
  const contentType = response.headers.get('content-type') ?? ''
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (text === undefined || !/^application\/json\b/iu.test(contentType) || !/\bno-store\b/iu.test(cacheControl)) {
    return { status: response.status }
  }
  try {
    return { status: response.status, reply: parseLocalAcpControlReply(text) }
  } catch {
    return { status: response.status }
  }
}

/**
 * Prove the reply still belongs to the authenticated Host: the reply must echo
 * THIS instance, the same-scope registry must still name the SAME instance and
 * the fresh kernel identity must still be that process. A host replaced during
 * the write cannot lend its answer to this CLI.
 */
function assertReplyBelongsToAuthenticatedHost(
  verified: VerifiedLocalHost,
  reply: { readonly instanceId: string },
  scope: LocalScope,
  deps: LocalAcpControlDeps,
): void {
  if (reply.instanceId !== verified.identity.instanceId) {
    throw new AcpControlError('HOST_IDENTITY_REFUSED', 'the Host reply names a different instance')
  }
  assertHostStillAuthenticated(verified, scope, deps)
}

/**
 * Re-prove the SAME authenticated Host after ONE request: the same-scope
 * registry still names this instance and the fresh kernel identity is still
 * that process. The read-only observation already checked the reply instance
 * id; a Host that disappeared/replaced mid-read must still be refused.
 */
function assertHostStillAuthenticated(
  verified: VerifiedLocalHost,
  scope: LocalScope,
  deps: LocalAcpControlDeps,
): void {
  const readRecord = deps.readRecord ?? readLocalRecord
  const current = readRecord(scope)
  if (current === undefined || !sameLocalInstanceRecord(current, verified.record)) {
    throw new AcpControlError('HOST_IDENTITY_REFUSED', 'the Host identity changed while the request was in flight')
  }
  const assertKernel = deps.assertKernelIdentity ?? assertRecordedHostKernelIdentityCurrent
  assertKernel(verified.record)
}

/** Map one write result to the fixed settle/unknown contract. */
function writeResult(verb: LocalAcpControlOp, state: LocalAcpControlState, profile: DaemonControlProfile): DaemonControlResult {
  const target = verb === 'enable' ? 'enabled' : 'disabled'
  if (state === target) return { code: 0, stdout: `acp=${state}\n`, stderr: '' }
  if (state === 'unavailable') {
    return {
      code: 4,
      stdout: 'acp=unavailable\n',
      stderr: 'dsh-pi-tui acp: ACP_UNAVAILABLE: the Host could not reach a settled ACP listener state\n',
    }
  }
  // `changing` or a state that does not match the requested target: never
  // retried, and the observed state is the only truthful output.
  return {
    code: 5,
    stdout: `acp=${state}\n`,
    stderr: `dsh-pi-tui acp: ACP_OUTCOME_UNCONFIRMED: the Host did not confirm the requested ACP listener state; run: dsh --profile ${shellQuote(profile.name)} acp status\n`,
  }
}

/** The unreached-write outcome: the request may have been committed. */
function unknownWriteOutcome(profile: DaemonControlProfile): AcpControlError {
  return new AcpControlError(
    'ACP_OUTCOME_UNCONFIRMED',
    `the ACP write result is unknown; run: dsh --profile ${shellQuote(profile.name)} acp status before retrying`,
  )
}

/**
 * Run ONE headless ACP command for ONE official Profile. `status` is a pure
 * read; `enable`/`disable` send exactly ONE authenticated write and never
 * replay it.
 */
export async function runLocalAcpControl(
  intent: AcpControlIntent,
  profile: DaemonControlProfile,
  deps: LocalAcpControlDeps = {},
): Promise<DaemonControlResult> {
  try {
    const platform = platformOf(deps)
    if (platform !== 'linux' && platform !== 'darwin') {
      throw new AcpControlError('UNSUPPORTED_PLATFORM', 'the acp CLI is only supported on Linux and macOS')
    }
    const scope = inspectInstalledProfileScope({
      dshHome: profile.home,
      profileDir: profile.dir,
      packageRoot: profile.packageRoot,
      dshVersion: profile.dshVersion,
    })
    const readRecord = deps.readRecord ?? readLocalRecord
    const record = readRecord(scope)
    if (record === undefined) throw new AcpControlError('HOST_NOT_RUNNING', notRunningReason(profile))
    const inspect = deps.inspectProcess ?? inspectHostProcess
    if (inspect(record) === 'dead') throw new AcpControlError('HOST_NOT_RUNNING', notRunningReason(profile))
    assertClientHostCompatible(record, scope)
    const authenticate = deps.authenticate ?? authenticateLocalHost
    const verified = await authenticate(record, scope, deps.signal)
    deps.signal?.throwIfAborted()

    if (intent.verb === 'status') {
      // The existing strict observer is the ONLY status read: it validates the
      // media/cache headers, the bounded body, the exact DTO and the reply
      // instance id. Everything unprovable is ACP_CLI_UNAVAILABLE, never a
      // guessed `disabled`.
      const status: AcpAccessStatus | undefined = await observeAuthenticatedLocalAcpStatus(verified, deps.signal)
      if (status === undefined) {
        throw new AcpControlError('ACP_CLI_UNAVAILABLE', 'the authenticated Host did not return a readable ACP listener state')
      }
      // The observer already matched the reply instance id; the fresh registry
      // and kernel identity still have to prove the SAME process answered.
      assertHostStillAuthenticated(verified, scope, deps)
      return { code: 0, stdout: `acp=${status.state}\n`, stderr: '' }
    }

    const result = await callAcpControl(verified, intent.verb, deps)
    // No response / timeout / an abort after dispatch: the write may have
    // committed. The CLI never replays it and never claims it did not happen.
    if (result.status === 0) throw unknownWriteOutcome(profile)
    if (result.status === 401 || result.status === 403) {
      // The official Connection admission refuses BEFORE the handler, so the
      // Controller provably received no write.
      throw new AcpControlError('HOST_AUTH_FAILED', 'the Host rejected the authenticated ACP CLI request')
    }
    if (result.status === 404) {
      throw new AcpControlError('ACP_CLI_UNAVAILABLE', 'this Host build does not support the acp CLI; restart the Host from the current install')
    }
    if (result.status === 409) {
      throw new AcpControlError('HOST_IDENTITY_REFUSED', 'the Host reply names a different instance')
    }
    if (result.status === 400 || result.status === 405 || result.status === 415) {
      // Strict schema/media/method refusals run BEFORE the instance check and
      // the Controller call: this is a provable zero-write answer.
      throw new AcpControlError('ACP_CLI_UNAVAILABLE', 'the Host rejected the ACP control request before any write')
    }
    // A Host 503 means the controller threw: the mutation may have partially
    // committed, so it is the same unknown outcome, never "no write".
    if (result.status === 503 || result.status !== 200 || result.reply?.kind !== 'state') {
      throw unknownWriteOutcome(profile)
    }
    try {
      assertReplyBelongsToAuthenticatedHost(verified, result.reply, scope, deps)
    } catch {
      // A host replaced during the write leaves the same unknown outcome; the
      // write is never replayed against the new host.
      throw unknownWriteOutcome(profile)
    }
    return writeResult(intent.verb, result.reply.state, profile)
  } catch (error) {
    const failure = toAcpControlError(error)
    return { code: failure.exitCode, stdout: '', stderr: formatAcpControlError(failure) }
  }
}
