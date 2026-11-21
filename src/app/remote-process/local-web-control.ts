/**
 * The headless Web CLI runner (M6 Web CLI).
 *
 * One short-lived management process reads the installed Profile through the
 * existing read-only scope inspection, authenticates the ONE live Host with the
 * official `/connect` Cookie + identity + fresh kernel check, performs exactly
 * ONE request against the Owner-only `/api/pi-tui.web-control` adapter, and
 * maps the reply to the fixed stdout/stderr/exit contract. It never starts a
 * Host, never opens a TUI/Client, never creates a Session/Agent/Writer and never
 * caches a Web state.
 *
 * ```text
 * runLocalWebControl -> inspectInstalledProfileScope -> authenticateLocalHost
 *   -> ONE GET/POST /api/pi-tui.web-control -> typed result
 * ```
 *
 * The URL produced by `web url` is the official Host-built authenticated URL;
 * this module never synthesizes a token, never logs the URL, and passes it
 * unchanged to stdout (or to the local OS opener, which runs on the CLI machine).
 *
 * @module app/remote-process/local-web-control
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { openerFor } from '../../client/url/open.ts'
import type { WebControlIntent } from '../../startup.ts'
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
import {
  LOCAL_WEB_CONTROL_MAX_RESPONSE_BYTES,
  LOCAL_WEB_CONTROL_ROUTE,
  LOCAL_WEB_CONTROL_TIMEOUT_MS,
  parseLocalWebControlReply,
  type LocalWebControlOp,
  type LocalWebControlReply,
  type LocalWebControlState,
} from './local-web-control-route.ts'

/** The fixed failure vocabulary of the headless Web CLI. */
export type WebControlErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'HOST_NOT_RUNNING'
  | 'HOST_IDENTITY_REFUSED'
  | 'HOST_AUTH_FAILED'
  | 'WEB_DISABLED'
  | 'WEB_CHANGING'
  | 'WEB_CLI_UNAVAILABLE'
  | 'WEB_UNAVAILABLE'
  | 'WEB_OUTCOME_UNCONFIRMED'
  | 'BROWSER_LAUNCH_UNAVAILABLE'

const EXIT_CODE: Readonly<Record<WebControlErrorCode, number>> = {
  UNSUPPORTED_PLATFORM: 3,
  HOST_NOT_RUNNING: 3,
  HOST_IDENTITY_REFUSED: 3,
  HOST_AUTH_FAILED: 3,
  WEB_DISABLED: 4,
  WEB_CHANGING: 5,
  WEB_CLI_UNAVAILABLE: 4,
  WEB_UNAVAILABLE: 4,
  WEB_OUTCOME_UNCONFIRMED: 5,
  BROWSER_LAUNCH_UNAVAILABLE: 4,
}

/** One stable failure with its fixed exit class and a local-only reason. */
class WebControlError extends Error {
  readonly code: WebControlErrorCode
  readonly exitCode: number
  readonly reason: string
  constructor(code: WebControlErrorCode, reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause })
    this.name = 'WebControlError'
    this.code = code
    this.exitCode = EXIT_CODE[code]
    this.reason = reason
  }
}

/** Injectable OS/discovery seams; production omits every one of them. */
export interface LocalWebControlDeps {
  readonly platform?: NodeJS.Platform
  readonly readRecord?: (scope: LocalScope) => LocalInstanceRecord | undefined
  readonly inspectProcess?: (record: LocalInstanceRecord) => 'alive' | 'dead'
  readonly authenticate?: (record: LocalInstanceRecord, scope: LocalScope, signal?: AbortSignal) => Promise<VerifiedLocalHost>
  /** Fresh kernel-identity recheck seam; production reads the platform kernel. */
  readonly assertKernelIdentity?: (record: LocalInstanceRecord) => void
  readonly fetch?: typeof fetch
  readonly spawn?: typeof spawn
  /** How long an accepted opener may run before `browser=requested` is reported. */
  readonly openerWaitMs?: number
  readonly signal?: AbortSignal
}

/** One bounded HTTP observation result; `status: 0` means no response. */
interface WebControlHttpResult {
  readonly status: number
  readonly reply?: LocalWebControlReply
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

function formatWebControlError(error: WebControlError): string {
  return `dsh-pi-tui web: ${error.code}: ${sanitizeReason(error.reason)}\n`
}

function platformOf(deps: LocalWebControlDeps): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function notRunningReason(profile: DaemonControlProfile): string {
  return `the Host for this Profile is not running; start it with: dsh --profile ${shellQuote(profile.name)} daemon start`
}

function disabledReason(profile: DaemonControlProfile): string {
  return `Web access is disabled for this Profile; run: dsh --profile ${shellQuote(profile.name)} web enable`
}

/** Map a lower-level failure to the fixed Web CLI taxonomy. */
function toWebControlError(error: unknown): WebControlError {
  if (error instanceof WebControlError) return error
  const code = (error as { readonly code?: unknown } | undefined)?.code
  switch (code) {
    case 'B1_PLATFORM_UNSUPPORTED':
      return new WebControlError('UNSUPPORTED_PLATFORM', 'the web CLI is only supported on Linux and macOS')
    case 'SCOPE_DIRECTORY_UNSAFE':
    case 'LOCAL_FILE_UNSAFE':
    case 'HOST_PROTOCOL_INCOMPATIBLE':
    case 'HOST_BUILD_INCOMPATIBLE':
    case 'HOST_IDENTITY_MISMATCH':
    case 'PROCESS_STARTTIME_UNAVAILABLE':
      return new WebControlError('HOST_IDENTITY_REFUSED', 'the local Host identity could not be verified for this Profile', error)
    case 'HOST_HANDOFF_UNAVAILABLE':
      return new WebControlError('HOST_NOT_RUNNING', 'the Host for this Profile is not running', error)
    case 'HOST_AUTH_FAILED':
    case 'HOST_UNRESPONSIVE':
      return new WebControlError('HOST_AUTH_FAILED', 'the local Host did not accept the authenticated handshake', error)
    default:
      return new WebControlError('WEB_CLI_UNAVAILABLE', 'an unexpected local Web CLI failure occurred', error)
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

/** One bounded request against the ONE Owner-only route. */
async function callWebControl(
  verified: VerifiedLocalHost,
  op: LocalWebControlOp | 'status',
  deps: LocalWebControlDeps,
): Promise<WebControlHttpResult> {
  const signal = deps.signal === undefined
    ? AbortSignal.timeout(LOCAL_WEB_CONTROL_TIMEOUT_MS)
    : AbortSignal.any([deps.signal, AbortSignal.timeout(LOCAL_WEB_CONTROL_TIMEOUT_MS)])
  const init: LocalRequestInit = op === 'status'
    ? {
        method: 'GET',
        headers: { cookie: verified.cookie },
        redirect: 'manual',
        cache: 'no-store',
        signal,
      }
    : {
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
    response = await fetchImpl(`${verified.record.origin}${LOCAL_WEB_CONTROL_ROUTE}`, init)
  } catch {
    return { status: 0 }
  }
  let text: string | undefined
  try {
    text = await readBoundedResponse(response, LOCAL_WEB_CONTROL_MAX_RESPONSE_BYTES)
  } catch {
    text = undefined
  }
  const contentType = response.headers.get('content-type') ?? ''
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (text === undefined || !/^application\/json\b/iu.test(contentType) || !/\bno-store\b/iu.test(cacheControl)) {
    return { status: response.status }
  }
  try {
    return { status: response.status, reply: parseLocalWebControlReply(text) }
  } catch {
    return { status: response.status }
  }
}

/**
 * Prove the reply still belongs to the authenticated Host: the reply must echo
 * THIS instance, the same-scope registry must still name the SAME instance and
 * the fresh kernel identity must still be that process. A host replaced during
 * the request cannot lend its answer to this CLI.
 */
function assertReplyBelongsToAuthenticatedHost(
  verified: VerifiedLocalHost,
  reply: { readonly instanceId: string },
  scope: LocalScope,
  deps: LocalWebControlDeps,
): void {
  if (reply.instanceId !== verified.identity.instanceId) {
    throw new WebControlError('HOST_IDENTITY_REFUSED', 'the Host reply names a different instance')
  }
  const readRecord = deps.readRecord ?? readLocalRecord
  const current = readRecord(scope)
  if (current === undefined || !sameLocalInstanceRecord(current, verified.record)) {
    throw new WebControlError('HOST_IDENTITY_REFUSED', 'the Host identity changed while the request was in flight')
  }
  const assertKernel = deps.assertKernelIdentity ?? assertRecordedHostKernelIdentityCurrent
  assertKernel(verified.record)
}

/** Validate the official authenticated URL before printing/opening it. */
function assertAuthenticatedWebUrl(raw: string, origin: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebControlError('WEB_CLI_UNAVAILABLE', 'the Host returned an unparsable Web URL')
  }
  const tokens = url.searchParams.getAll('token')
  const keys = [...url.searchParams.keys()]
  if (
    url.protocol !== 'http:'
    || url.origin !== origin
    || url.pathname !== '/'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || tokens.length !== 1
    || tokens[0] === ''
    || keys.length !== 1
  ) {
    throw new WebControlError('WEB_CLI_UNAVAILABLE', 'the Host returned an unexpected Web URL')
  }
  return raw
}

/**
 * Ask the local OS opener to open one URL. Success means the OS accepted the
 * launch request, never that a Browser page loaded. A synchronously observable
 * spawn error or immediate non-zero exit is a real failure.
 */
async function launchBrowser(url: string, deps: LocalWebControlDeps): Promise<void> {
  const { command, args } = openerFor(url, platformOf(deps))
  const spawnImpl = deps.spawn ?? spawn
  let child: ChildProcess
  try {
    child = spawnImpl(command, args, { shell: false, stdio: 'ignore', detached: true })
  } catch (error) {
    throw new WebControlError('BROWSER_LAUNCH_UNAVAILABLE', 'the local browser opener could not be started', error)
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let spawnTimer: ReturnType<typeof setTimeout> | undefined
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (failure?: string): void => {
      if (settled) return
      settled = true
      if (spawnTimer !== undefined) clearTimeout(spawnTimer)
      if (exitTimer !== undefined) clearTimeout(exitTimer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      if (failure === undefined) resolve()
      else reject(new WebControlError('BROWSER_LAUNCH_UNAVAILABLE', failure))
    }
    const onError = (): void => { finish('the local browser opener could not be started') }
    const onExit = (code: number | null, _signal: NodeJS.Signals | null): void => {
      // An opener that exits zero has done its job. A signal or non-zero exit
      // that is already observable is a real launch failure.
      if (code === 0) finish()
      else finish('the local browser opener exited with an error')
    }
    child.once('error', onError)
    child.once('exit', onExit)
    // The timer is only the abnormal "no spawn/error reported" fallback; a real
    // spawn event cancels it and starts the short immediate-exit observation.
    spawnTimer = setTimeout(() => { finish('the local browser opener did not accept the request') }, 2_000)
    child.once('spawn', () => {
      if (spawnTimer !== undefined) clearTimeout(spawnTimer)
      try { child.unref() } catch { /* already released */ }
      exitTimer = setTimeout(() => { finish() }, deps.openerWaitMs ?? 250)
    })
  })
}

/** Map one write result to the fixed settle/unknown contract. */
function writeResult(verb: 'enable' | 'disable', state: LocalWebControlState, profile: DaemonControlProfile): DaemonControlResult {
  const target = verb === 'enable' ? 'enabled' : 'disabled'
  if (state === target) return { code: 0, stdout: `web=${state}\n`, stderr: '' }
  if (state === 'unavailable') {
    return { code: 4, stdout: 'web=unavailable\n', stderr: 'dsh-pi-tui web: WEB_UNAVAILABLE: the Host could not reach a settled Web state\n' }
  }
  // `changing` or a state that does not match the requested target: never
  // retried, and the observed state is the only truthful output.
  return {
    code: 5,
    stdout: `web=${state}\n`,
    stderr: `dsh-pi-tui web: WEB_OUTCOME_UNCONFIRMED: the Host did not confirm the requested Web state; run: dsh --profile ${shellQuote(profile.name)} web status\n`,
  }
}

/** The unreached-write outcome: the request may have been committed. */
function unknownWriteOutcome(profile: DaemonControlProfile): WebControlError {
  return new WebControlError(
    'WEB_OUTCOME_UNCONFIRMED',
    `the Web write result is unknown; run: dsh --profile ${shellQuote(profile.name)} web status before retrying`,
  )
}

/**
 * Run ONE headless Web command for ONE official Profile. Every failure is
 * mapped to a fixed code/exit; no raw Error message, Host response body,
 * Cookie, authenticated URL or private path reaches stdout/stderr.
 */
export async function runLocalWebControl(
  intent: WebControlIntent,
  profile: DaemonControlProfile,
  deps: LocalWebControlDeps = {},
): Promise<DaemonControlResult> {
  try {
    const platform = platformOf(deps)
    if (platform !== 'linux' && platform !== 'darwin') {
      throw new WebControlError('UNSUPPORTED_PLATFORM', 'the web CLI is only supported on Linux and macOS')
    }
    const scope = inspectInstalledProfileScope({
      dshHome: profile.home,
      profileDir: profile.dir,
      packageRoot: profile.packageRoot,
      dshVersion: profile.dshVersion,
    })
    const readRecord = deps.readRecord ?? readLocalRecord
    const record = readRecord(scope)
    if (record === undefined) throw new WebControlError('HOST_NOT_RUNNING', notRunningReason(profile))
    const inspect = deps.inspectProcess ?? inspectHostProcess
    if (inspect(record) === 'dead') throw new WebControlError('HOST_NOT_RUNNING', notRunningReason(profile))
    assertClientHostCompatible(record, scope)
    const authenticate = deps.authenticate ?? authenticateLocalHost
    const verified = await authenticate(record, scope, deps.signal)
    deps.signal?.throwIfAborted()

    switch (intent.verb) {
      case 'status': {
        const result = await callWebControl(verified, 'status', deps)
        if (result.status === 0) throw new WebControlError('HOST_NOT_RUNNING', 'the authenticated Host stopped answering')
        if (result.status === 401 || result.status === 403) {
          throw new WebControlError('HOST_AUTH_FAILED', 'the Host rejected the authenticated Web CLI request')
        }
        if (result.status === 404) {
          throw new WebControlError('WEB_CLI_UNAVAILABLE', 'this Host build does not support the web CLI; restart the Host from the current install')
        }
        if (result.status === 409) {
          throw new WebControlError('HOST_IDENTITY_REFUSED', 'the Host reply names a different instance')
        }
        if (result.status !== 200 || result.reply?.kind !== 'state') {
          throw new WebControlError('WEB_CLI_UNAVAILABLE', 'the Host returned no readable Web status')
        }
        assertReplyBelongsToAuthenticatedHost(verified, result.reply, scope, deps)
        return { code: 0, stdout: `web=${result.reply.state}\n`, stderr: '' }
      }
      case 'enable':
      case 'disable': {
        const result = await callWebControl(verified, intent.verb, deps)
        if (result.status === 401 || result.status === 403) {
          throw new WebControlError('HOST_AUTH_FAILED', 'the Host rejected the authenticated Web CLI request')
        }
        if (result.status === 404) {
          throw new WebControlError('WEB_CLI_UNAVAILABLE', 'this Host build does not support the web CLI; restart the Host from the current install')
        }
        if (result.status !== 200 || result.reply?.kind !== 'state') throw unknownWriteOutcome(profile)
        try {
          assertReplyBelongsToAuthenticatedHost(verified, result.reply, scope, deps)
        } catch {
          // A host replaced during the write leaves the same unknown outcome;
          // the write is never replayed against the new host.
          throw unknownWriteOutcome(profile)
        }
        return writeResult(intent.verb, result.reply.state, profile)
      }
      case 'url':
      case 'open': {
        const result = await callWebControl(verified, 'url', deps)
        if (result.status === 0) throw new WebControlError('HOST_NOT_RUNNING', 'the authenticated Host stopped answering')
        if (result.status === 401 || result.status === 403) {
          throw new WebControlError('HOST_AUTH_FAILED', 'the Host rejected the authenticated Web CLI request')
        }
        if (result.status === 404) {
          throw new WebControlError('WEB_CLI_UNAVAILABLE', 'this Host build does not support the web CLI; restart the Host from the current install')
        }
        if (result.reply?.kind === 'error') {
          if (result.reply.error === 'WEB_DISABLED') throw new WebControlError('WEB_DISABLED', disabledReason(profile))
          if (result.reply.error === 'WEB_CHANGING') {
            throw new WebControlError('WEB_CHANGING', 'the Host is still changing its Web state; retry: dsh-pi-tui web status')
          }
          if (result.reply.error === 'WEB_INSTANCE_MISMATCH') {
            throw new WebControlError('HOST_IDENTITY_REFUSED', 'the Host instance changed before the Web URL was read')
          }
          throw new WebControlError('WEB_CLI_UNAVAILABLE', 'the Host could not produce the authenticated Web URL')
        }
        if (result.status === 409) {
          throw new WebControlError('HOST_IDENTITY_REFUSED', 'the Host reply names a different instance')
        }
        if (result.status !== 200 || result.reply?.kind !== 'url') {
          throw new WebControlError('WEB_CLI_UNAVAILABLE', 'the Host returned no readable authenticated Web URL')
        }
        assertReplyBelongsToAuthenticatedHost(verified, result.reply, scope, deps)
        const url = assertAuthenticatedWebUrl(result.reply.url, verified.record.origin)
        if (intent.verb === 'url') return { code: 0, stdout: `${url}\n`, stderr: '' }
        await launchBrowser(url, deps)
        return { code: 0, stdout: 'browser=requested\n', stderr: '' }
      }
    }
  } catch (error) {
    const failure = toWebControlError(error)
    return { code: failure.exitCode, stdout: '', stderr: formatWebControlError(failure) }
  }
}
