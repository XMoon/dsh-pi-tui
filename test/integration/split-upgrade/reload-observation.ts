/**
 * Read-only observations shared by the two U1 `/reload-client` business files.
 *
 * This module owns no Host, Client, profile or Scene. It reads the official
 * Client JSONL sink, the durable Host Session log and the Host-owned C1 proof
 * file; the Supervisor remains the sole lifecycle owner.
 *
 * @module test/integration/split-upgrade/reload-observation
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { OpaqueHostHandle, UpgradeClientHandle, UpgradeScene } from '../../support/split-upgrade-fixture.ts'

const OBSERVATION_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(OBSERVATION_DIR, '..', '..', '..'))

interface SessionEvent {
  type?: string
  data?: Record<string, any>
}

interface SplitSmokeSessionsModule {
  hostSessionEvents(dshHome: string, sessionId: string): SessionEvent[] | undefined
  waitForHostSessionEventAfter(
    dshHome: string,
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
}

interface SplitUpgradeSupportModule {
  sessionLogFiles(dshHome: string): string[]
  scopeDirOf(dshHome: string, scopeId: string): string
  c1WorkHadRelease(workRoot: string): boolean
  waitForUpgradeC1WorkEvent(
    workRoot: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
}

interface SplitSmokeDiagnosticsModule {
  classifyReloadNotices(viewportLines: string[]): string[]
  classifyHandoffRejection(error: unknown): string
  reloadNoticeTypeForText(text: string): string
}

async function loadModule<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(join(REPO_ROOT, relativePath)).href)) as T
}

const sessions = await loadModule<SplitSmokeSessionsModule>('scripts/lib/split-smoke-sessions.mjs')
const support = await loadModule<SplitUpgradeSupportModule>('scripts/lib/split-upgrade-support.mjs')
const diagnostics = await loadModule<SplitSmokeDiagnosticsModule>('scripts/lib/split-smoke-diagnostics.mjs')

export const RELOAD_NOTICE = Object.freeze({
  alreadyCurrent: 'Client reload skipped: this Client already runs the installed build.',
  attachments: 'Client reload blocked: remove or submit the staged attachments first.',
  targetInvalid: 'Client reload failed: the installed replacement Client is unavailable or incompatible.',
})

export interface HostArtifacts {
  identity: Record<string, any>
  scopeDir: string
  instanceBytes: Buffer
  launchBytes: Buffer
}

export interface SurfaceStatus {
  pid: number
  rootFiberUid: unknown
  generationId: unknown
  surfaceRevision: unknown
  sessionOpen: boolean
  openSessionId: string
  transport: string
  surfaceMounted: boolean
  host: Record<string, any>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

function assertHostIdentityKept(actual: Record<string, any>, expected: Record<string, any>, label: string): void {
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'protocol', 'bundleVersion', 'dshVersion', 'buildId']) {
    assert(actual?.[key] === expected?.[key], `${label}: identity ${key} changed`)
  }
  if (expected?.schema === 2 || actual?.schema === 2) {
    assert(JSON.stringify(actual?.hostKernelIdentity) === JSON.stringify(expected?.hostKernelIdentity),
      `${label}: Darwin kernel identity changed`)
  } else {
    assert(actual?.hostStarttime === expected?.hostStarttime, `${label}: Host starttime changed`)
  }
}

export function recordIndex(client: UpgradeClientHandle): number {
  return client.readRecords().length
}

export function latestSurfaceStatus(client: UpgradeClientHandle): SurfaceStatus | undefined {
  return client.readRecords()
    .filter(record => record.m4b2s === 'surface-status')
    .at(-1) as SurfaceStatus | undefined
}

export function assertNoHandoffRequested(client: UpgradeClientHandle, fromIndex: number, label: string): void {
  assert(!client.readRecords().slice(fromIndex).some(record => record.m4r === 'handoff-requested'),
    `${label}: a reload request reached the process sink`)
}

export function assertNoHandoffRecord(client: UpgradeClientHandle, label: string): void {
  assert(!client.readRecords().some(record => record.m4r === 'handoff-requested'),
    `${label}: the official record file already carries a handoff-requested event`)
}

export async function waitForPaintedText(
  client: UpgradeClientHandle,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = await client.text(true).catch(() => '')
    if (frame.includes(text)) return
    await sleep(50)
  }
  throw new Error(`${label}: the terminal never showed ${JSON.stringify(text)} within ${String(timeoutMs)}ms`)
}

export async function waitForVisibleTextGone(
  client: UpgradeClientHandle,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const frame = await client.text().catch(() => '')
    if (!frame.includes(text)) return
    await sleep(50)
  }
  throw new Error(`${label}: text ${JSON.stringify(text)} stayed visible for ${String(timeoutMs)}ms`)
}

export async function waitForReloadNotice(
  client: UpgradeClientHandle,
  expectedText: string,
  label: string,
  fromRecordIndex: number,
  timeoutMs = 120_000,
): Promise<void> {
  const expected = diagnostics.reloadNoticeTypeForText(expectedText)
  const started = Date.now()
  let lastFrame = ''
  for (;;) {
    lastFrame = await client.text().catch(() => '')
    const notices = diagnostics.classifyReloadNotices(lastFrame.split('\n'))
    if (notices.includes(expected)) return
    const unexpected = notices.find(type => type !== expected)
    if (unexpected !== undefined) {
      throw new Error(`${label}: painted reload notice ${unexpected}, expected ${expected}; frame=${JSON.stringify(lastFrame.slice(-2000))}`)
    }
    for (const record of client.readRecords().slice(fromRecordIndex)) {
      if (record?.m4r !== 'handoff-request-rejected') continue
      const observed = diagnostics.classifyHandoffRejection(record.error)
      if (rejectionMatchesNotice(expected, observed)) continue
      throw new Error(`${label}: process refused the reload as ${observed}, expected ${expected}`)
    }
    if (Date.now() - started >= timeoutMs) {
      const tail = client.readRecords().slice(fromRecordIndex).slice(-12)
      throw new Error(`${label}: no ${expected} reload notice within ${String(timeoutMs)}ms; last frame=${JSON.stringify(lastFrame.slice(-2000))}; records=${JSON.stringify(tail)}`)
    }
    await sleep(50)
  }
}

function rejectionMatchesNotice(expected: string, observed: string): boolean {
  if (expected === 'ALREADY_CURRENT') return observed === 'ALREADY_CURRENT'
  if (expected === 'TARGET_INVALID') return observed.startsWith('TARGET_INVALID')
  return false
}

export async function waitForAcceptedHandoff(
  client: UpgradeClientHandle,
  pid: number,
  label: string,
  fromRecordIndex: number,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  const started = Date.now()
  for (;;) {
    const records = client.readRecords().slice(fromRecordIndex)
    const accepted = records.find(record => record?.m4r === 'handoff-requested' && record.pid === pid)
    if (accepted !== undefined) return accepted
    for (const record of records) {
      if (record?.m4r === 'handoff-request-rejected') {
        throw new Error(`${label}: process refused the reload as ${diagnostics.classifyHandoffRejection(record.error)}`)
      }
      if (record?.m4r === 'handoff-request-ignored') {
        throw new Error(`${label}: process ignored the reload: ${String(record.reason)}`)
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: no accepted handoff-requested event within ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

export async function waitForSurfaceSession(client: UpgradeClientHandle, label: string): Promise<SurfaceStatus> {
  const record = await client.waitForRecord(
    value => value.m4b2s === 'surface-status'
      && value.sessionOpen === true
      && typeof value.openSessionId === 'string',
    label,
    120_000,
  )
  return record as SurfaceStatus
}

export async function waitForSurfaceConnected(client: UpgradeClientHandle, label: string): Promise<SurfaceStatus> {
  const record = await client.waitForRecord(
    value => value.m4b2s === 'surface-status'
      && value.sessionOpen === true
      && typeof value.openSessionId === 'string'
      && value.transport === 'connected'
      && value.surfaceMounted === true,
    label,
    120_000,
  )
  return record as SurfaceStatus
}

export async function waitForClientClosed(
  client: UpgradeClientHandle,
  pid: number,
  label: string,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  return await client.waitForRecord(
    record => record.m4b2s === 'client-closed' && record.pid === pid,
    label,
    timeoutMs,
  )
}

export async function waitForReplacement(
  client: UpgradeClientHandle,
  oldPid: number,
  label: string,
): Promise<{ pid: number; hostAuthenticated: Record<string, any>; restored: Record<string, any>; ready: Record<string, any> }> {
  const started = await client.waitForRecord(
    record => record.m4a0 === 'client-started' && record.pid !== oldPid,
    `${label}: replacement client-started`,
    180_000,
  )
  const pid = started.pid
  assert(Number.isInteger(pid) && pid > 0 && pid !== oldPid, `${label}: replacement carries no new business PID`)
  const hostAuthenticated = await client.waitForRecord(
    record => record.m4a0 === 'host-authenticated' && record.pid === pid,
    `${label}: replacement host-authenticated`,
    180_000,
  )
  const restored = await client.waitForRecord(
    record => record.m4r === 'handoff-restored' && record.pid === pid,
    `${label}: replacement handoff-restored`,
    180_000,
  )
  const ready = await client.waitForRecord(
    record => record.m4a0 === 'ready' && record.pid === pid,
    `${label}: replacement ready`,
    120_000,
  )
  return { pid, hostAuthenticated, restored, ready }
}

export function assertPeerSurfaceKept(
  client: UpgradeClientHandle,
  fromIndex: number,
  boundary: SurfaceStatus,
  identity: Record<string, any>,
  label: string,
): void {
  const records = client.readRecords().slice(fromIndex)
  const statuses = records.filter(record => record.m4b2s === 'surface-status') as SurfaceStatus[]
  for (const status of statuses) {
    assert(status.pid === boundary.pid, `${label}: peer Client PID changed`)
    assert(status.rootFiberUid === boundary.rootFiberUid, `${label}: peer root fiber changed`)
    assert(status.generationId === boundary.generationId, `${label}: peer transport generation changed`)
    assert(status.surfaceRevision === boundary.surfaceRevision, `${label}: peer surface revision changed`)
    assert(status.sessionOpen === true, `${label}: peer lost its open Session`)
    assert(status.openSessionId === boundary.openSessionId, `${label}: peer Session changed`)
    assert(status.transport === 'connected', `${label}: peer transport disconnected`)
    assert(status.surfaceMounted === true, `${label}: peer surface unmounted`)
    assertHostIdentityKept(status.host, identity, `${label}: peer Host identity`)
  }
  assert(!records.some(record => record.m4b2s === 'client-closed'), `${label}: peer Client closed its resources`)
}

export async function hostArtifacts(scene: UpgradeScene, host: OpaqueHostHandle): Promise<HostArtifacts> {
  const status = await scene.hostStatus(host)
  const identity = status.localHost as Record<string, any>
  const scopeDir = support.scopeDirOf(scene.installation.dshHome, String(identity.scopeId))
  return {
    identity,
    scopeDir,
    instanceBytes: readFileSync(join(scopeDir, 'instance.json')),
    launchBytes: readFileSync(join(scopeDir, 'launch.json')),
  }
}

export async function assertHostArtifactsKept(
  scene: UpgradeScene,
  host: OpaqueHostHandle,
  before: HostArtifacts,
  label: string,
): Promise<void> {
  const after = await hostArtifacts(scene, host)
  assertHostIdentityKept(after.identity, before.identity, label)
  assert(after.instanceBytes.equals(before.instanceBytes), `${label}: the Host registry bytes changed`)
  assert(after.launchBytes.equals(before.launchBytes), `${label}: the Host launch bytes changed`)
}

export async function waitForC1Event(
  workRoot: string,
  predicate: (event: Record<string, any>) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  return await support.waitForUpgradeC1WorkEvent(workRoot, predicate, label, timeoutMs)
}

export function hostSessionEvents(scene: UpgradeScene, sessionId: string): SessionEvent[] | undefined {
  return sessions.hostSessionEvents(scene.installation.dshHome, sessionId)
}

export async function waitForHostSessionEventAfter(
  scene: UpgradeScene,
  sessionId: string,
  afterIndex: number,
  predicate: (event: SessionEvent) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<SessionEvent> {
  return await sessions.waitForHostSessionEventAfter(
    scene.installation.dshHome,
    sessionId,
    afterIndex,
    predicate,
    label,
    timeoutMs,
  )
}

export function sessionLogFiles(scene: UpgradeScene): string[] {
  return support.sessionLogFiles(scene.installation.dshHome)
}

export function c1WorkHadRelease(workRoot: string): boolean {
  return support.c1WorkHadRelease(workRoot)
}

export async function waitForPidGone(pid: number, label: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return
    await sleep(50)
  }
  throw new Error(`${label}: PID ${String(pid)} is still alive after ${String(timeoutMs)}ms`)
}

export function userPromptCount(scene: UpgradeScene, sessionId: string, prompt: string): number {
  return (hostSessionEvents(scene, sessionId) ?? []).filter(event => event.type === 'user/message'
    && event.data?.source?.kind === 'user'
    && JSON.stringify(event.data?.content ?? []).includes(prompt)).length
}

export function turnEndCount(scene: UpgradeScene, sessionId: string): number {
  return (hostSessionEvents(scene, sessionId) ?? []).filter(event => event.type === 'turn/end').length
}

export function writeMinimalPng(path: string): void {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(800, 16)
  bytes.writeUInt32BE(100, 20)
  writeFileSync(path, bytes, { mode: 0o600 })
}

export async function waitForClearedComposer(
  client: UpgradeClientHandle,
  needle: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const viewport = (await client.text()).split('\n')
    const separators = []
    for (let index = 0; index < viewport.length; index += 1) {
      if (/^─+$/u.test(viewport[index].trim())) separators.push(index)
    }
    if (separators.length > 0) {
      const top = separators.length >= 2 ? separators[separators.length - 2] : separators[separators.length - 1]
      const bottom = separators.length >= 2 ? separators[separators.length - 1] : viewport.length
      const composer = viewport.slice(top + 1, bottom).join('\n')
      if (composer.includes('❯') && !composer.includes(needle)) return
    }
    await sleep(50)
  }
  throw new Error(`${label}: the painted composer still contains ${JSON.stringify(needle)} after ${String(timeoutMs)}ms`)
}

export interface ParallelAudit {
  readonly markerPath: string
  complete(): void
}

/**
 * Optional qualification-only rendezvous. It never drives product behavior and
 * only activates when the dedicated parallel-audit environment is present.
 */
export async function beginParallelAudit(
  scene: UpgradeScene,
  host: OpaqueHostHandle,
  client: UpgradeClientHandle,
  sessionId: string,
  label: 'client-reload' | 'reload-target-source',
): Promise<ParallelAudit | undefined> {
  const runId = process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID
  if (runId === undefined || runId === '') return undefined
  assert(/^[A-Za-z0-9._-]+$/u.test(runId), 'SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID must be a short path-safe id')
  const tmpBase = process.env.SPLIT_VITEST_TMP_BASE
  assert(typeof tmpBase === 'string' && tmpBase !== '' && isAbsolute(tmpBase),
    'SPLIT_VITEST_TMP_BASE must be set for the parallel audit')
  const auditDir = join(tmpBase, `upgrade-overlap-${runId}`)
  mkdirSync(auditDir, { recursive: true, mode: 0o700 })
  chmodSync(auditDir, 0o700)
  const status = await scene.hostStatus(host)
  const identity = status.localHost as Record<string, any>
  const businessPids = client.businessPids()
  assert(businessPids.length === 1, `parallel audit: ${label} must start one live business Client`)
  const marker = {
    schemaVersion: 1,
    runId,
    label,
    workerPid: process.pid,
    workerPpid: process.ppid,
    sceneId: scene.sceneId,
    sceneRoot: scene.workRoot,
    profileDir: scene.installation.profileDir,
    dshHome: scene.installation.dshHome,
    oldSha256: scene.pair.old.sha256,
    newSha256: scene.pair.new.sha256,
    hostPid: identity.hostPid,
    hostPgid: host.pgid ?? null,
    hostStarttime: identity.hostStarttime
      ?? (identity.hostKernelIdentity
        ? `${String(identity.hostKernelIdentity.startSec)}.${String(identity.hostKernelIdentity.startUsec)}`
        : null),
    hostKernelIdentity: identity.hostKernelIdentity ?? null,
    clientPid: businessPids[0],
    sessionId,
    activeStartedAt: new Date().toISOString(),
    activeEndedAt: null,
  }
  const markerPath = join(auditDir, `${label}.json`)
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  const otherLabel = label === 'client-reload' ? 'reload-target-source' : 'client-reload'
  const otherPath = join(auditDir, `${otherLabel}.json`)
  const started = Date.now()
  let other
  while (Date.now() - started < 360_000) {
    if (existsSync(otherPath)) {
      try {
        other = JSON.parse(readFileSync(otherPath, 'utf8')) as Record<string, any>
        break
      } catch {
        // The other worker is mid-write; retry without inventing a fact.
      }
    }
    await sleep(100)
  }
  assert(other !== undefined, `parallel audit: ${label} did not find ${otherLabel} within 360000ms`)
  assert(other.runId === runId, 'parallel audit: the two markers carry different run ids')
  assert(other.oldSha256 === marker.oldSha256 && other.newSha256 === marker.newSha256,
    'parallel audit: the two markers carry different artifact pairs')
  assert(other.workerPid !== marker.workerPid, 'parallel audit: both files ran in the same worker PID')
  assert(other.sceneId !== marker.sceneId && other.sceneRoot !== marker.sceneRoot,
    'parallel audit: both files share one Scene root')
  assert(other.profileDir !== marker.profileDir && other.dshHome !== marker.dshHome,
    'parallel audit: both files share a profile or DSH_HOME')
  assert(other.hostPid !== marker.hostPid && other.clientPid !== marker.clientPid,
    'parallel audit: both files share a Host or Client PID')
  assert(pidAlive(Number(other.hostPid)) && pidAlive(Number(other.clientPid)),
    'parallel audit: the other Scene is not live at the rendezvous')
  return {
    markerPath,
    complete: () => {
      const completed = { ...marker, activeEndedAt: new Date().toISOString() }
      writeFileSync(markerPath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 })
    },
  }
}
