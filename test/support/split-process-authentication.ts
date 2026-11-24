/**
 * Pure authenticated-identity and raw HTTP/WebSocket observation shared by the
 * split-process bootstrap, seat and transport qualification files.
 *
 * This module observes the real installed Host/Client files and the real
 * official HTTP/WebSocket surface. It creates no process, owns no Scene
 * resource and never prints a token, Cookie or private path: callers compare
 * booleans or redacted projections only.
 *
 * @module split-process-authentication
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

import {
  readKernelProcess,
  readProcessStarttime,
  sameKernelProcess,
  type KernelObservation,
  type KernelProcessIdentity,
} from '../../src/runtime/native-process/identity.ts'
// @ts-expect-error -- the repository's plain-JavaScript upgrade contract has no declaration file
import { classifyKernelLiveness, serializeKernelIdentity } from './split-upgrade-native-contract.mjs'
// @ts-expect-error -- the repository's plain-JavaScript smoke helper has no declaration file
import { connectCookie as exchangeLaunchCookie, fetchStatus as fetchRawStatus } from '../../scripts/lib/split-smoke-processes.mjs'

export interface PublishedHostRecord {
  schema: 1 | 2
  scopeId: string
  profileRealpath: string
  instanceId: string
  hostPid: number
  origin: string
  protocol: string
  bundleVersion: string
  dshVersion: string
  buildId: string
  hostStarttime?: string
  hostKernelIdentity?: Record<string, any>
}

export interface ClientHostFacts {
  schema?: 1 | 2
  scopeId: string
  instanceId: string
  hostPid: number
  origin: string
  protocol: string
  bundleVersion: string
  dshVersion: string
  buildId: string
  hostStarttime?: string
  hostKernelIdentity?: Record<string, any>
}

export interface RawHttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface MuxAttempt {
  opened: boolean
  status?: number
  socket?: MuxSocket
}

export interface MuxSocket {
  readyState: number
  on(event: string, listener: (...args: any[]) => void): MuxSocket
  once(event: string, listener: (...args: any[]) => void): MuxSocket
  close(): void
  terminate(): void
}

export interface MuxWebSocketConstructor {
  new (url: string, options?: Record<string, any>): MuxSocket
  readonly OPEN: number
  readonly CLOSED: number
}

export interface ScopeFiles {
  scopeDir: string
  registryPath: string
  launchPath: string
  registry: Record<string, any>
  launch: Record<string, any>
  registryMode: number
  launchMode: number
}

export function readJsonFile(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

export function readScopeFiles(dshHome: string, scopeId: string): ScopeFiles {
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const registryPath = join(scopeDir, 'instance.json')
  const launchPath = join(scopeDir, 'launch.json')
  return {
    scopeDir,
    registryPath,
    launchPath,
    registry: readJsonFile(registryPath),
    launch: readJsonFile(launchPath),
    registryMode: statSync(registryPath).mode & 0o777,
    launchMode: statSync(launchPath).mode & 0o777,
  }
}

/** The schema-aware exact kernel proof of one published Host record. */
export function assertPublishedHostMatchesKernel(record: PublishedHostRecord, label: string): void {
  if (!Number.isInteger(record.hostPid) || record.hostPid <= 0) {
    throw new Error(`${label}: the published Host record carries no real PID`)
  }
  const observation = readKernelProcess(record.hostPid)
  if (record.schema === 1) {
    const starttime = readProcessStarttime(record.hostPid)
    if (starttime === undefined) throw new Error(`${label}: the published Host has no readable kernel start time`)
    if (record.hostStarttime !== starttime) {
      throw new Error(`${label}: the published Host starttime is not the live kernel start time`)
    }
    return
  }
  if (record.schema === 2) {
    if (sameKernelProcess(record.hostKernelIdentity as never, observation as KernelObservation) !== 'same') {
      throw new Error(`${label}: the published Darwin kernel identity is not the live kernel process`)
    }
    return
  }
  throw new Error(`${label}: unsupported published Host identity schema`)
}

/** The exact kernel identity a published Host record owns, schema-aware. */
export function publishedKernelIdentity(record: PublishedHostRecord): KernelProcessIdentity {
  if (record.schema === 2) {
    if (record.hostKernelIdentity === undefined) throw new Error('the published Darwin identity has no kernel identity')
    return record.hostKernelIdentity as KernelProcessIdentity
  }
  if (record.schema === 1) {
    if (typeof record.hostStarttime !== 'string' || record.hostStarttime === '') {
      throw new Error('the published Linux identity has no kernel start time')
    }
    return {
      platform: 'linux',
      pid: record.hostPid,
      startTicks: record.hostStarttime,
      ppid: 0,
      pgid: 0,
      sid: 0,
      state: '',
    }
  }
  throw new Error('unsupported published Host identity schema')
}

/** The published process is still the SAME live kernel process (never a PID). */
export function assertPublishedHostIdentityLive(record: PublishedHostRecord, label: string): void {
  const expected = publishedKernelIdentity(record)
  const observation = readKernelProcess(record.hostPid)
  if (observation.kind !== 'alive'
    || classifyKernelLiveness(observation).state !== 'alive'
    || sameKernelProcess(expected, observation) !== 'same') {
    throw new Error(`${label}: the published Host is not the same live kernel process`)
  }
}

/** The published process identity is terminal (gone or a provably different PID). */
export function assertPublishedHostIdentityTerminal(record: PublishedHostRecord, label: string): void {
  const expected = publishedKernelIdentity(record)
  const observation = readKernelProcess(record.hostPid)
  if (observation.kind === 'unknown') {
    throw new Error(`${label}: the published Host kernel identity is unverifiable`)
  }
  if (observation.kind === 'alive'
    && sameKernelProcess(expected, observation) === 'same'
    && classifyKernelLiveness(observation).state === 'alive') {
    throw new Error(`${label}: the published Host identity is still live`)
  }
}

/** The real identity witness is still the same live, non-terminated process. */
export function assertWitnessIdentityLive(
  witness: { pid: number; kernelIdentity: Record<string, any> },
  label: string,
): void {
  const observation = readKernelProcess(witness.pid)
  if (observation.kind !== 'alive'
    || classifyKernelLiveness(observation).state !== 'alive'
    || sameKernelProcess(witness.kernelIdentity as KernelProcessIdentity, observation) !== 'same') {
    throw new Error(`${label}: the identity witness is not the same live kernel process`)
  }
}

/** A captured kernel birth is gone or provably another process (never live). */
export function assertKernelBirthTerminal(pid: number, birth: string | undefined, label: string): void {
  assert(typeof pid === 'number' && Number.isInteger(pid) && pid > 0, `${label}: no real PID`)
  assert(typeof birth === 'string' && birth !== '', `${label}: no recorded kernel birth`)
  const observation = readKernelProcess(pid)
  if (observation.kind === 'unknown') throw new Error(`${label}: the kernel identity is unverifiable`)
  if (observation.kind === 'alive'
    && serializeKernelIdentity(observation.identity) === birth
    && classifyKernelLiveness(observation).state === 'alive') {
    throw new Error(`${label}: the captured kernel birth is still live`)
  }
}

/** The authenticated Client echo must name the SAME Host record, schema-aware. */
export function assertClientHostMatchesPublished(
  clientHost: ClientHostFacts,
  published: PublishedHostRecord,
  label: string,
): void {
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'origin', 'protocol', 'bundleVersion', 'dshVersion', 'buildId'] as const) {
    if (clientHost[key] !== published[key]) throw new Error(`${label}: ${key} differs from the published Host`)
  }
  if (published.schema === 1) {
    if (clientHost.hostStarttime !== published.hostStarttime) {
      throw new Error(`${label}: the Linux Host starttime echo differs from the published identity`)
    }
    return
  }
  if (published.schema === 2) {
    const expected = published.hostKernelIdentity
    const actual = clientHost.hostKernelIdentity
    if (expected === undefined || actual === undefined) {
      throw new Error(`${label}: the Darwin Host kernel identity echo is missing`)
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
    for (const key of keys) {
      if (expected[key] !== actual[key]) {
        throw new Error(`${label}: the Darwin Host kernel identity echo differs at ${key}`)
      }
    }
    return
  }
  throw new Error(`${label}: unsupported published Host identity schema`)
}

/** One authenticated identity read; never carries the Cookie into a failure. */
export async function readAuthenticatedIdentity(
  origin: string,
  cookie: string,
  label: string,
): Promise<{ status: number; identity: Record<string, any>; noStore: boolean; json: boolean }> {
  const response = await fetchRawStatus(`${origin}/api/pi-tui.local-host`, {
    headers: { cookie },
    signal: AbortSignal.timeout(15_000),
  }) as { status: number; headers: { get(name: string): string | null }; body: string }
  const contentType = String(response.headers.get('content-type') ?? '')
  const cacheControl = String(response.headers.get('cache-control') ?? '')
  let identity: Record<string, any> = {}
  let json = false
  if (/application\/json\b/iu.test(contentType)) {
    identity = JSON.parse(response.body) as Record<string, any>
    json = true
  }
  if (response.status !== 200) throw new Error(`${label}: authenticated identity returned HTTP ${String(response.status)}`)
  if (!json) throw new Error(`${label}: authenticated identity is not JSON`)
  if (!/\bno-store\b/iu.test(cacheControl)) throw new Error(`${label}: authenticated identity is not no-store`)
  return { status: response.status, identity, noStore: true, json }
}

/** The real launch exchange; the returned Cookie stays in Worker memory only. */
export async function exchangeCookie(origin: string, launch: Record<string, any>): Promise<string> {
  return await exchangeLaunchCookie(origin, launch) as string
}

/** One raw loopback HTTP request with explicit authority/Origin mutation. */
export async function rawHttpRequest(
  origin: string,
  options: {
    path: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  },
): Promise<RawHttpResponse> {
  const url = new URL(options.path, origin)
  const timeoutMs = options.timeoutMs ?? 15_000
  return await new Promise<RawHttpResponse>((resolve, reject) => {
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
      timeout: timeoutMs,
      // No pooled client socket survives the observation.
      agent: false,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.once('error', reject)
    })
    request.once('timeout', () => request.destroy(new Error('the raw HTTP request timed out')))
    request.once('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

function resolveWebSocket(profilePackage: string): MuxWebSocketConstructor {
  const profileRequire = createRequire(join(profilePackage, 'package.json'))
  return profileRequire('ws') as MuxWebSocketConstructor
}

/** One real raw mux upgrade attempt with the exact Cookie header. */
export function muxAttempt(
  profilePackage: string,
  origin: string,
  cookie: string,
  timeoutMs = 15_000,
): Promise<MuxAttempt> {
  const WebSocket = resolveWebSocket(profilePackage)
  return new Promise<MuxAttempt>((resolve, reject) => {
    const socket = new WebSocket(`${origin}/api/remote.mux`, { headers: { Cookie: cookie } })
    let settled = false
    const finish = (value: MuxAttempt): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.terminate() } catch { /* already closed */ }
      reject(new Error('the raw mux attempt timed out'))
    }, timeoutMs)
    socket.once('open', () => finish({ opened: true, socket }))
    socket.once('unexpected-response', (request: { destroy(): void }, response: { statusCode?: number }) => {
      request.destroy()
      try { socket.terminate() } catch { /* already closed */ }
      finish({ opened: false, ...(response.statusCode === undefined ? {} : { status: response.statusCode }) })
    })
    socket.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

export function closeMuxSocket(profilePackage: string, socket: MuxSocket): void {
  const WebSocket = resolveWebSocket(profilePackage)
  if (socket.readyState === WebSocket.CLOSED) return
  socket.close()
}

export function openMuxSocket(profilePackage: string, origin: string, cookie: string): Promise<MuxSocket> {
  const WebSocket = resolveWebSocket(profilePackage)
  return new Promise<MuxSocket>((resolve, reject) => {
    const socket = new WebSocket(`${origin}/api/remote.mux`, { headers: { Cookie: cookie } })
    const timer = setTimeout(() => {
      try { socket.terminate() } catch { /* already closed */ }
      reject(new Error('the raw mux socket did not open in time'))
    }, 15_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

export function muxSocketOpen(profilePackage: string, socket: MuxSocket): boolean {
  const WebSocket = resolveWebSocket(profilePackage)
  return socket.readyState === WebSocket.OPEN
}

export function muxSocketClosed(profilePackage: string, socket: MuxSocket): boolean {
  const WebSocket = resolveWebSocket(profilePackage)
  return socket.readyState === WebSocket.CLOSED
}

/** Boolean-only secret detection: a failure never repeats the secret value. */
export function assertNoSecret(text: string, secrets: readonly string[], label: string): void {
  for (const [index, secret] of secrets.entries()) {
    if (secret === '') continue
    if (text.includes(secret)) throw new Error(`${label}: secret #${String(index + 1)} appeared in an observable projection`)
  }
}
