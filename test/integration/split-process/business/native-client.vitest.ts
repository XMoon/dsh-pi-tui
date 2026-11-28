import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import sharp from 'sharp'
import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessHostHandle,
  type SplitProcessScene,
  type SessionEvent,
} from '../../../support/split-process-fixture.ts'
import type {
  NativeAttachOptions,
  NativeClient,
  NativeClientStatus,
  NativeHostIdentity,
  NativeImageAttachmentRef,
  NativeJob,
  NativePromptResult,
  NativeResult,
  NativeSession,
  NativeSessionEvent,
  NativeSessionView,
  NativeSubagentSnapshot,
} from '../../../../src/app/remote-process/native-client.ts'

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): Record<string, any>[]
  waitForC1WorkEvent(
    root: string,
    predicate: (event: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
}

const evidenceDir = process.env.NAF1_NATIVE_EVIDENCE_DIR === undefined
  ? join(process.cwd(), 'temp', 'paseo', 'evidence', 'naf1-native-qualification')
  : process.env.NAF1_NATIVE_EVIDENCE_DIR
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function countFiles(root: string): number {
  return existsSync(root)
    ? readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length
    : 0
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part === 'object' && part !== null && 'text' in part
    && typeof part.text === 'string' ? part.text : '').join('')
}

function eventText(event: SessionEvent | undefined): string {
  return textOf(event?.data?.message?.content) || textOf(event?.data?.content)
}

function isUser(event: SessionEvent | undefined, text: string): boolean {
  return event?.type === 'user/message' && eventText(event) === text
}

function resultSummary(result: { readonly kind: string; readonly code?: string; readonly message?: string }): string {
  return result.kind === 'ok' || result.kind === 'committed' || result.kind === 'accepted'
    ? result.kind
    : JSON.stringify({ kind: result.kind, code: result.code, message: result.message })
}

function ok<T>(result: NativeResult<T>, label: string): T {
  expect(result.kind, `${label}: ${resultSummary(result)}`).toBe('ok')
  assert(result.kind === 'ok')
  return result.value
}

function committed<T>(result: NativeResult<T>, label: string): T {
  expect(result.kind, `${label}: ${resultSummary(result)}`).toBe('committed')
  assert(result.kind === 'committed')
  return result.value
}

function accepted(result: NativePromptResult, label: string): { readonly requestId: string } {
  expect(result.kind, `${label}: ${resultSummary(result)}`).toBe('accepted')
  assert(result.kind === 'accepted')
  assert(typeof result.requestId === 'string' && result.requestId !== '')
  return { requestId: result.requestId }
}

function acceptedVoid(result: NativeResult<undefined>, label: string): void {
  expect(result.kind, `${label}: ${resultSummary(result)}`).toBe('accepted')
  assert(result.kind === 'accepted')
}

function defined<T>(value: T | undefined | null, label: string): T {
  expect(value, label).not.toBeUndefined()
  expect(value, label).not.toBeNull()
  assert(value !== undefined && value !== null)
  return value
}

function seqOf(event: SessionEvent | undefined): number {
  const seq = (event as { readonly seq?: unknown } | undefined)?.seq
  expect(seq, 'durable event sequence').toBeTypeOf('number')
  assert(typeof seq === 'number')
  return seq
}

async function withAbort<T>(decision: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await decision
  if (signal.aborted) throw signal.reason
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      decision,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${String(timeoutMs)}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    await sleep(25)
  }
}

function durableEvents(scene: SplitProcessScene, sessionId: string): SessionEvent[] {
  return scene.sessionEvents(sessionId) ?? []
}

function eventIndex(events: readonly SessionEvent[], event: SessionEvent | undefined): number {
  assert(event !== undefined, 'expected a durable event')
  const seq = seqOf(event)
  const index = events.findIndex(item => (item as { readonly seq?: unknown }).seq === seq)
  assert(index >= 0, 'durable event sequence was not present in the authoritative log')
  return index
}

function nearestTurnStart(events: readonly SessionEvent[], event: SessionEvent): SessionEvent {
  const index = eventIndex(events, event)
  const start = events.slice(0, index).findLast(item => item.type === 'turn/start')
  assert(start !== undefined, 'durable event has no enclosing turn/start')
  return start
}

async function waitForTurnEnd(
  scene: SplitProcessScene,
  sessionId: string,
  turn: number,
  label: string,
): Promise<SessionEvent> {
  return await scene.waitForSessionEvent(sessionId, 0,
    event => event.type === 'turn/end' && event.data?.turn === turn,
    label)
}

async function waitForPromptTerminal(
  scene: SplitProcessScene,
  sessionId: string,
  requestId: string,
  label: string,
): Promise<Record<string, unknown>> {
  const user = await scene.waitForSessionEvent(sessionId, 0,
    event => event.type === 'user/message' && event.data?.source?.rpcId === requestId,
    `${label}: requestId reached durable user/message`)
  const events = durableEvents(scene, sessionId)
  const start = nearestTurnStart(events, user)
  const turn = Number(start.data?.turn)
  const end = await waitForTurnEnd(scene, sessionId, turn, `${label}: turn/end`)
  const final = durableEvents(scene, sessionId)
  return {
    requestId,
    messageId: user.data?.id,
    userSeq: seqOf(user),
    turn,
    turnStartSeq: seqOf(start),
    turnEndSeq: seqOf(end),
    stepStarts: final.filter(event => event.type === 'step/start' && event.data?.turn === turn).map(seqOf),
    stepEnds: final.filter(event => event.type === 'step/end' && event.data?.turn === turn).map(seqOf),
  }
}

function watchSession(session: NativeSession): {
  readonly latest: () => NativeSessionView | undefined
  readonly events: () => readonly NativeSessionEvent[]
  readonly transientCount: () => number
  readonly failure: () => unknown
  readonly release: () => void
} {
  let latest: NativeSessionView | undefined
  let failure: unknown
  let transients = 0
  const bySeq = new Map<number, NativeSessionEvent>()
  const off = session.subscribe(result => {
    if (result.kind !== 'ok') {
      failure ??= result
      return
    }
    latest = result.value
    for (const entry of result.value.window.entries) {
      if (entry.type === 'transient') transients += 1
      else bySeq.set(entry.event.seq, entry.event)
    }
  })
  return {
    latest: () => latest,
    events: () => [...bySeq.values()],
    transientCount: () => transients,
    failure: () => failure,
    release: off,
  }
}

async function createSession(
  scene: SplitProcessScene,
  client: NativeClient,
  label: string,
): Promise<{ readonly sessionId: string; readonly session: NativeSession; readonly workspacePath: string }> {
  const workspacePath = join(scene.workDir, `native-workspace-${label}`)
  mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
  writeFileSync(join(workspacePath, 'host-marker.txt'), `native-host-${label}\n`, { mode: 0o600, flag: 'wx' })
  const workspace = committed(await client.createWorkspace(workspacePath), `${label}: createWorkspace`)
  expect(workspace.workspace.path).toBe(workspacePath)
  const created = committed(await client.createSession({ workspaceId: workspace.workspace.workspaceId, agentPreset: 'standard' }), `${label}: createSession`)
  const opened = ok(await client.openSession(created.sessionId), `${label}: openSession`)
  return { sessionId: created.sessionId, session: opened, workspacePath }
}

async function attach(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  options: Pick<NativeAttachOptions, 'onQuestion' | 'onApproval'> = {},
): Promise<NativeClient> {
  return await attachNativeClient({
    dshAnchor: scene.installation.anchor,
    profile: 'pi-tui',
    expectedScopeId: scene.scope.scopeId,
    expectedInstanceId: host.ready.localHost.instanceId,
    ...options,
  })
}

function statusIdentity(status: NativeClientStatus): NativeHostIdentity {
  expect(status.transport).toBe('connected')
  expect(status.liveSockets).toBeGreaterThan(0)
  expect(status.interactionIdentityGaps).toBe(0)
  const serialized = JSON.stringify(status)
  for (const forbidden of ['hostHome', 'profileDir', 'dshHome', 'origin', 'cookie', 'launch.json']) {
    expect(serialized).not.toContain(forbidden)
  }
  return status.identity
}

let attachNativeClient: (options: NativeAttachOptions) => Promise<NativeClient>

test('qualifies the installed Native Client business and interaction paths', { timeout: 900_000 }, async () => {
  const scene = await createSplitProcessScene()
  const previousEnv = {
    HOME: process.env.HOME,
    DSH_HOME: process.env.DSH_HOME,
    SPLIT_PROCESS_DSH_ANCHOR: process.env.SPLIT_PROCESS_DSH_ANCHOR,
    SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: process.env.SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK,
  }
  const evidence: Record<string, any> = {
    startedAt: new Date().toISOString(),
    candidate: scene.candidate,
    scope: scene.scope,
    installation: {
      anchor: scene.installation.anchor,
      dshHome: scene.installation.dshHome,
      profileDir: scene.installation.profileDir,
    },
    results: {} as Record<string, string>,
  }
  const save = (): void => {
    writeFileSync(join(evidenceDir, 'native-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  }
  const pass = (name: string, detail: unknown): void => {
    evidence.results[name] = 'PASS'
    evidence[name] = detail
    save()
  }
  let primary: unknown
  try {
    process.env.HOME = scene.installation.base.env.HOME
    process.env.DSH_HOME = scene.installation.dshHome
    process.env.SPLIT_PROCESS_DSH_ANCHOR = scene.installation.anchor
    const nativeEntry = join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui', 'dist', 'native-client.mjs')
    expect(existsSync(nativeEntry), `installed Native entry is absent: ${nativeEntry}`).toBe(true)
    ;({ attachNativeClient } = await import(pathToFileURL(nativeEntry).href) as {
      attachNativeClient: (options: NativeAttachOptions) => Promise<NativeClient>
    })
    evidence.nativeEntry = nativeEntry
    save()

    // Pre-auth negatives run before any Host exists or authentication is attempted.
    {
      const base = { dshAnchor: scene.installation.anchor, profile: 'pi-tui', expectedScopeId: scene.scope.scopeId }
      await expect(attachNativeClient(base)).rejects.toMatchObject({ code: 'NATIVE_CLIENT_HOST_UNAVAILABLE' })
      await expect(attachNativeClient({ ...base, expectedScopeId: 'foreign-scope' })).rejects.toMatchObject({ code: 'NATIVE_CLIENT_SCOPE_MISMATCH' })
      const preCancelled = new AbortController()
      preCancelled.abort(new Error('pre-cancel'))
      await expect(attachNativeClient({ ...base, signal: preCancelled.signal })).rejects.toThrow('pre-cancel')
      const fakeAnchorDir = join(scene.workDir, 'foreign-dsh-anchor')
      mkdirSync(fakeAnchorDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(fakeAnchorDir, 'package.json'), JSON.stringify({ name: 'not-dsh', version: '0.2.2-rc.5' }), { mode: 0o600 })
      await expect(attachNativeClient({ ...base, dshAnchor: join(fakeAnchorDir, 'package.json') }))
        .rejects.toMatchObject({ code: 'NATIVE_CLIENT_UNSUPPORTED_DSH' })
      pass('pre-auth-negatives', { missingHost: true, foreignScope: true, preCancelled: true, foreignPackage: true })
    }

    // 1. Attach/status/realm/close/reattach plus exact Host identity.
    {
      const host = await scene.startHost({ scenario: 'foreground-tool', holdTool: true })
      let first: NativeClient | undefined
      let second: NativeClient | undefined
      try {
        const recordPath = join(scene.scopeDir, 'instance.json')
        const originalRecord = readFileSync(recordPath, 'utf8')
        try {
          const stale = JSON.parse(originalRecord)
          stale.hostPid = process.pid
          if (stale.hostKernelIdentity !== undefined) stale.hostKernelIdentity.pid = process.pid
          writeFileSync(recordPath, JSON.stringify(stale), { mode: 0o600 })
          await expect(attachNativeClient({
            dshAnchor: scene.installation.anchor,
            profile: 'pi-tui',
            expectedScopeId: scene.scope.scopeId,
          })).rejects.toMatchObject({ code: 'NATIVE_CLIENT_HOST_STALE' })
        } finally {
          writeFileSync(recordPath, originalRecord, { mode: 0o600 })
        }
        const launchPath = join(scene.scopeDir, 'launch.json')
        const originalLaunch = readFileSync(launchPath, 'utf8')
        try {
          const invalidAuth = JSON.parse(originalLaunch)
          invalidAuth.connectUrl = 'http://127.0.0.1:1/connect'
          writeFileSync(launchPath, JSON.stringify(invalidAuth), { mode: 0o600 })
          await expect(attachNativeClient({
            dshAnchor: scene.installation.anchor,
            profile: 'pi-tui',
            expectedScopeId: scene.scope.scopeId,
          })).rejects.toThrow()
        } finally {
          writeFileSync(launchPath, originalLaunch, { mode: 0o600 })
        }
        pass('pre-auth-host-negatives', { staleRegistry: true, invalidAuth: true })
        first = await attach(scene, host)
        const initial = ok(first.status(), 'initial status')
        const identity = statusIdentity(initial)
        expect(identity.scopeId).toBe(scene.scope.scopeId)
        expect(identity.instanceId).toBe(host.ready.localHost.instanceId)
        expect(identity.hostPid).toBe(host.ready.localHost.hostPid)
        expect(identity.buildId).toBe(host.ready.localHost.buildId)
        expect(identity.dshVersion).toBe('0.2.2-rc.5')
        expect(identity.protocol).toBe('dsh-pi-tui/local/2')
        if (process.platform === 'darwin') {
          expect(identity.kernel).toEqual({ ...host.ready.localHost.hostKernelIdentity, platform: 'darwin' })
        } else {
          expect(identity.kernel).toEqual({ platform: 'linux', hostStarttime: host.ready.localHost.hostStarttime })
        }
        const statuses: NativeResult<NativeClientStatus>[] = []
        const offStatus = first.subscribeStatus(result => { statuses.push(result) })
        expect(statuses.length).toBeGreaterThan(0)
        offStatus()
        await expect(attach(scene, host)).rejects.toMatchObject({ code: 'NATIVE_CLIENT_REALM_BUSY' })
        const duplicateEntry = await import(`${pathToFileURL(nativeEntry).href}?native-realm-copy`) as {
          attachNativeClient: (options: NativeAttachOptions) => Promise<NativeClient>
        }
        await expect(duplicateEntry.attachNativeClient({
          dshAnchor: scene.installation.anchor,
          profile: 'pi-tui',
          expectedScopeId: scene.scope.scopeId,
          expectedInstanceId: host.ready.localHost.instanceId,
        })).rejects.toMatchObject({ code: 'NATIVE_CLIENT_REALM_BUSY' })
        const hostStatus = await scene.hostStatus(host)
        expect(hostStatus.localHost.instanceId).toBe(identity.instanceId)
        expect(hostStatus.localHost.hostPid).toBe(identity.hostPid)

        // 2. Workspace/Session/two handles/cold history/typed text+tool stream/config/commands.
        const created = await createSession(scene, first, 'basic')
        const sibling = ok(await first.openSession(created.sessionId), 'second same-id handle')
        expect(sibling).not.toBe(created.session)
        await created.session.close()
        expect(created.session.snapshot().kind).toBe('closed')
        expect(sibling.snapshot().kind).toBe('ok')
        const cold = ok(await first.readSession(created.sessionId, { maxMessages: 20 }), 'cold readSession')
        expect(cold.records.length).toBeGreaterThan(0)
        const history = ok(await sibling.history({ maxMessages: 20 }), 'cold history')
        expect(history.records.length).toBeGreaterThan(0)

        const watched = watchSession(sibling)
        const beforeInvalidPrompt = durableEvents(scene, created.sessionId).length
        const invalidPrompt = await sibling.prompt({ content: [{ type: 'bogus', name: 'x.txt', bytes: new Uint8Array([1]) } as never] })
        expect(invalidPrompt.kind, `unknown prompt discriminator must fail before Host effects: ${resultSummary(invalidPrompt)}`).toBe('not-dispatched')
        expect(durableEvents(scene, created.sessionId).length).toBe(beforeInvalidPrompt)
        const attachmentsRoot = join(scene.installation.dshHome, 'attachments', 'v1', 'files')
        const beforeMixedInvalid = countFiles(attachmentsRoot)
        const mixedInvalid = await sibling.prompt({ content: [
          { type: 'file', name: 'must-not-upload.txt', bytes: new Uint8Array([1]) },
          { type: 'bogus', name: 'x.txt', bytes: new Uint8Array([1]) },
        ] as never })
        expect(mixedInvalid.kind, `mixed invalid prompt must fail before upload: ${resultSummary(mixedInvalid)}`).toBe('not-dispatched')
        expect(countFiles(attachmentsRoot)).toBe(beforeMixedInvalid)
        expect(durableEvents(scene, created.sessionId).length).toBe(beforeInvalidPrompt)
        const prompt = accepted(await sibling.prompt({ content: [{ type: 'text', text: 'native foreground tool' }] }), 'foreground prompt')
        const toolCall = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool',
          'foreground tool/call')
        expect(host.toolReleasePath).toBeTypeOf('string')
        writeFileSync(host.toolReleasePath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const terminal = await waitForPromptTerminal(scene, created.sessionId, prompt.requestId, 'foreground prompt')
        const toolResult = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'tool/result' && event.data?.message?.toolCallId === toolCall.data?.callId,
          'foreground tool/result')
        expect(toolResult.data?.message?.isError, JSON.stringify(toolResult.data?.message)).not.toBe(true)
        await waitFor('Native durable foreground stream', () => watched.events(),
          events => events.some(event => event.type === 'assistant/message' && eventText(event as unknown as SessionEvent).includes('foreground answer')))
        expect(watched.transientCount(), 'the real model stream reached the Native observer').toBeGreaterThan(0)
        expect(watched.failure()).toBeUndefined()

        const configured = await createSession(scene, first, 'config')
        const catalog = ok(await first.catalog(), 'catalog')
        expect(catalog.models.groups.some(group => group.id === 'c1-qualification')).toBe(true)
        expect(catalog.presets.presets.some(preset => preset.id === 'standard')).toBe(true)
        expect(catalog.permissions.options.some(option => option.value === 'read-only')).toBe(true)
        const commands = ok(await configured.session.commands(), 'commands')
        expect(commands.some(command => command.name === 'plan')).toBe(true)
        expect(commands.some(command => command.name === 'footer')).toBe(false)
        const unknownCommand = committed(await configured.session.command('/native-unknown-command'), 'unknown command')
        expect(unknownCommand).toEqual({ matched: false })
        const tuiOnlyCommand = committed(await configured.session.command('/footer'), 'TUI-only command')
        expect(tuiOnlyCommand).toEqual({ matched: false })
        const command = committed(await configured.session.command('/plan'), 'command /plan')
        expect('matched' in command ? command.matched : command.result.kind).toBe('success')
        await waitFor('plan active after /plan', async () => ok(await configured.session.configuration(), 'configuration').plan,
          plan => plan?.active === true)
        committed(await configured.session.selectModel({ provider: 'c1-qualification', model: 'c1' }), 'selectModel')
        committed(await configured.session.selectPreset('standard'), 'selectPreset')
        const readOnly = committed(await configured.session.selectPermissionPreset('read-only'), 'selectPermissionPreset')
        expect(readOnly.currentValue).toBe('read-only')
        const workspaceWrite = committed(await configured.session.selectPermissionPreset('workspace-write'), 'restore permission')
        expect(workspaceWrite.currentValue).toBe('workspace-write')
        const planOn = committed(await configured.session.selectPlanMode(true), 'selectPlanMode true')
        expect(planOn.active).toBe(true)
        const planOff = committed(await configured.session.selectPlanMode(false), 'selectPlanMode false')
        expect(planOff.active).toBe(false)
        await configured.session.close()
        const file = ok(await sibling.readFile({ path: 'host-marker.txt' }), 'readFile')
        expect(Buffer.from(file.data).toString('utf8')).toBe('native-host-basic\n')

        const beforeClose = ok(first.status(), 'status before close')
        expect(beforeClose.activeWrappers).toBeGreaterThan(0)
        expect(beforeClose.liveSockets).toBeGreaterThan(0)
        const firstClose = first.close()
        expect(first.close()).toBe(firstClose)
        await firstClose
        const terminalStatus = ok(first.status(), 'terminal status after close')
        expect(terminalStatus.transport).toBe('closed')
        expect(terminalStatus.activeWrappers).toBe(0)
        expect(terminalStatus.liveSockets).toBe(0)
        expect(terminalStatus.pendingInteractions).toBe(0)
        const startupAbort = new AbortController()
        const cancelledAttach = attachNativeClient({
          dshAnchor: scene.installation.anchor,
          profile: 'pi-tui',
          expectedScopeId: scene.scope.scopeId,
          expectedInstanceId: host.ready.localHost.instanceId,
          signal: startupAbort.signal,
        })
        queueMicrotask(() => startupAbort.abort(new Error('startup-cancel')))
        let startupCancel: { code?: string; message: string } | undefined
        try {
          await cancelledAttach
        } catch (error) {
          startupCancel = { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) }
        }
        expect(startupCancel?.code).not.toBe('NATIVE_CLIENT_REALM_BUSY')
        expect(startupCancel?.message).toContain('startup-cancel')
        const hostAfterClose = await scene.hostStatus(host)
        expect(hostAfterClose.localHost.instanceId).toBe(identity.instanceId)
        expect(hostAfterClose.localHost.hostPid).toBe(identity.hostPid)
        await expect(attachNativeClient({
          dshAnchor: scene.installation.anchor,
          profile: 'pi-tui',
          expectedScopeId: scene.scope.scopeId,
          expectedInstanceId: 'foreign-instance',
        })).rejects.toMatchObject({ code: 'NATIVE_CLIENT_INSTANCE_MISMATCH' })
        second = await attach(scene, host)
        const reattached = ok(second.status(), 'reattach status')
        expect(reattached.identity.instanceId).toBe(identity.instanceId)
        const reread = ok(await second.readSession(created.sessionId, { maxMessages: 20 }), 'reattach cold read')
        expect(reread.records.some(entry => entry.type === 'event' && entry.event.type === 'user/message')).toBe(true)
        watched.release()
        await sibling.close()
        pass('attach-status-realm-close-reattach', {
          identity,
          generationId: reattached.generationId,
          beforeClose: { activeWrappers: beforeClose.activeWrappers, liveSockets: beforeClose.liveSockets },
          terminalStatus,
          startupCancel,
          hostAfterClose: { instanceId: hostAfterClose.localHost.instanceId, hostPid: hostAfterClose.localHost.hostPid },
          duplicateEntryRejected: true,
        })
        pass('session-handles-history-config-commands-file', {
          sessionId: created.sessionId,
          workspacePath: created.workspacePath,
          terminal,
          toolCallId: toolCall.data?.callId,
          toolResultSeq: seqOf(toolResult),
          catalog: { models: catalog.models.routableProviders, presets: catalog.presets.presets.map(preset => preset.id) },
        })
      } finally {
        await first?.close()
        await second?.close()
        await scene.stopHost(host)
      }
    }

    // Typed file bytes use official staging and reach durable/model consumers.
    {
      const host = await scene.startHost({ scenario: 'foreground-tool', holdTool: true })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'file-input')
        const bytes = Buffer.from('native typed file payload\n', 'utf8')
        const prompt = accepted(await session.prompt({ content: [
          { type: 'text', text: 'native typed file input' },
          { type: 'file', name: 'native-input.txt', bytes },
        ] }), 'typed file prompt')
        const user = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'user/message' && event.data?.source?.rpcId === prompt.requestId,
          'typed file durable user/message')
        const file = (user.data?.content ?? []).find((part: Record<string, any>) => part.type === 'file')?.attachment
        expect(file).toBeDefined()
        expect(file.name).toBe('native-input.txt')
        expect(file.bytes).toBe(bytes.byteLength)
        const promptEvidencePath = scene.installation.base.env.SPLIT_PROCESS_PROMPT_EVIDENCE
        const modelRow = await waitFor('model request userFiles', () => {
          if (!existsSync(promptEvidencePath)) return undefined
          const text = readFileSync(promptEvidencePath, 'utf8')
          if (!text.endsWith('\n')) return undefined
          return text.slice(0, -1).split('\n').filter(Boolean).map(line => JSON.parse(line))
            .find(row => row.userFileHandles?.some((text: string) => text.includes(file.name)
              && text.includes(`${bytes.byteLength} bytes`)))
        }, value => value !== undefined)
        expect(modelRow.userFileHandles.some((text: string) => text.includes(file.attachmentId.slice(0, 15))
          && text.includes(file.name) && text.includes(`${bytes.byteLength} bytes`))).toBe(true)
        const toolCall = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool',
          'typed file tool/call')
        writeFileSync(host.toolReleasePath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const terminal = await waitForPromptTerminal(scene, sessionId, prompt.requestId, 'typed file prompt')
        const toolResult = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/result' && event.data?.message?.toolCallId === toolCall.data?.callId,
          'typed file tool/result')
        expect(toolResult.data?.message?.isError).not.toBe(true)
        pass('typed-file-input', { sessionId, attachment: file, modelRow, terminal, toolCallId: toolCall.data?.callId })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // A real user skill is resolved by the Host tool and replayed durably.
    {
      const skillDir = join(scene.installation.dshHome, 'skills', 'native-skill')
      mkdirSync(skillDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(skillDir, 'SKILL.md'), [
        '---',
        'name: native-skill',
        'description: Native candidate skill',
        '---',
        '',
        'NATIVE_SKILL_INSTRUCTIONS_MARKER',
        '',
      ].join('\n'), { mode: 0o600 })
      const host = await scene.startHost({ scenario: 'native-skill' })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'skill')
        const prompt = accepted(await session.prompt({ content: [{ type: 'text', text: 'native user skill' }] }), 'skill prompt')
        const call = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'skill',
          'user skill tool/call')
        expect(call.data?.arguments).toContain('native-skill')
        const result = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/result' && event.data?.message?.toolCallId === call.data?.callId,
          'user skill tool/result')
        expect(result.data?.message?.isError).not.toBe(true)
        expect(eventText(result)).toContain('NATIVE_SKILL_INSTRUCTIONS_MARKER')
        const terminal = await waitForPromptTerminal(scene, sessionId, prompt.requestId, 'skill prompt')
        pass('user-skill', { sessionId, toolCallId: call.data?.callId, terminal })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // 3. Held queue/steer and exact cancellation, each on its own real Host generation.
    {
      const host = await scene.startHost({ scenario: 'long-turn' })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'queue')
        const first = accepted(await session.prompt({ content: [{ type: 'text', text: 'native held turn' }] }), 'held prompt')
        await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'held Native turn')
        const queued = accepted(await session.prompt({ content: [{ type: 'text', text: 'native queued then steered' }] }), 'queued prompt')
        const queuedEvent = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn'
            && (event.data?.inserted ?? []).some((item: Record<string, any>) => item?.source?.rpcId === queued.requestId),
          'queued occurrence')
        const item = (queuedEvent.data?.inserted ?? []).find((entry: Record<string, any>) => entry?.source?.rpcId === queued.requestId) as Record<string, any>
        expect(item.id).toBeTypeOf('string')
        acceptedVoid(await session.updateQueue(String(item.id), { kind: 'steer' }), 'updateQueue steer')
        await scene.waitForSessionEvent(sessionId, eventIndex(durableEvents(scene, sessionId), queuedEvent) + 1,
          event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-step'
            && (event.data?.inserted ?? []).some((entry: Record<string, any>) => entry?.id === item.id),
          'steered occurrence')
        writeFileSync(host.holdReleasePath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const firstTerminal = await waitForPromptTerminal(scene, sessionId, first.requestId, 'held prompt')
        const queuedTerminal = await waitForPromptTerminal(scene, sessionId, queued.requestId, 'steered prompt')
        pass('queue-steer', { sessionId, itemId: item.id, firstTerminal, queuedTerminal })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }
    {
      const host = await scene.startHost({ scenario: 'long-turn' })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'cancel')
        const held = accepted(await session.prompt({ content: [{ type: 'text', text: 'native cancel held' }] }), 'cancel held prompt')
        await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'cancel held turn')
        acceptedVoid(await session.cancel(), 'cancel')
        const user = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'user/message' && event.data?.source?.rpcId === held.requestId,
          'cancel durable user')
        const turn = Number(nearestTurnStart(durableEvents(scene, sessionId), user).data?.turn)
        const end = await waitForTurnEnd(scene, sessionId, turn, 'cancelled turn/end')
        expect(end.data?.reason?.kind, 'the official Session cancel route terminates the held Turn as aborted').toBe('aborted')
        writeFileSync(host.holdReleasePath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const next = accepted(await session.prompt({ content: [{ type: 'text', text: 'native after cancel' }] }), 'post-cancel prompt')
        const nextTerminal = await waitForPromptTerminal(scene, sessionId, next.requestId, 'post-cancel prompt')
        pass('cancel', { sessionId, heldRequestId: held.requestId, cancelledTurn: turn, turnEndSeq: seqOf(end), nextTerminal })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // 4. Real ACK loss in a fresh Node realm: official acceptance evidence reconciles the lost reply.
    {
      const host = await scene.startHost({ scenario: 'long-turn' })
      try {
        const workspacePath = join(scene.workDir, 'native-workspace-ack-loss')
        mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
        const marker = `native-ack-loss-${Date.now()}`
        const script = `
          const originalFetch = globalThis.fetch
          let promptResponseSeen = false
          let ackBodyCancelled = false
          globalThis.fetch = async (input, init) => {
            const response = await originalFetch(input, init)
            if (!promptResponseSeen && typeof init?.body === 'string') {
              let method
              try { method = JSON.parse(init.body)?.method } catch {}
              if (method === 'session/prompt') {
                promptResponseSeen = true
                const body = response.body
                if (body !== null) {
                  const cancel = body.cancel.bind(body)
                  body.cancel = async reason => {
                    ackBodyCancelled = true
                    return await cancel(reason)
                  }
                }
              }
            }
            return response
          }
          try {
            const { attachNativeClient } = await import(process.env.NAF_ACK_NATIVE_ENTRY)
            const client = await attachNativeClient({
              dshAnchor: process.env.NAF_ACK_ANCHOR,
              profile: 'pi-tui',
              expectedScopeId: process.env.NAF_ACK_SCOPE,
              expectedInstanceId: process.env.NAF_ACK_INSTANCE,
            })
            const workspace = await client.createWorkspace(process.env.NAF_ACK_WORKSPACE)
            if (workspace.kind !== 'committed') throw new Error('ACK child workspace: ' + workspace.kind)
            const created = await client.createSession({ workspaceId: workspace.value.workspace.workspaceId, agentPreset: 'standard' })
            if (created.kind !== 'committed') throw new Error('ACK child create: ' + created.kind)
            const session = await client.openSession(created.value.sessionId)
            if (session.kind !== 'ok') throw new Error('ACK child open: ' + session.kind)
            const result = await session.value.prompt({ content: [{ type: 'text', text: process.env.NAF_ACK_MARKER }] })
            process.send?.({ type: 'result', sessionId: created.value.sessionId, result, injectionProof: { promptResponseSeen, ackBodyCancelled } })
            await client.close()
            process.disconnect?.()
          } catch (error) {
            process.send?.({ type: 'error', message: error instanceof Error ? error.message : String(error) })
            process.exitCode = 1
            process.disconnect?.()
          }
        `
        const messages: Array<Record<string, any>> = []
        let stderr = ''
        const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
          env: {
            ...process.env,
            HOME: scene.installation.base.env.HOME,
            DSH_HOME: scene.installation.dshHome,
            SPLIT_PROCESS_DSH_ANCHOR: scene.installation.anchor,
            SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1',
            NAF_ACK_NATIVE_ENTRY: pathToFileURL(evidence.nativeEntry).href,
            NAF_ACK_ANCHOR: scene.installation.anchor,
            NAF_ACK_SCOPE: scene.scope.scopeId,
            NAF_ACK_INSTANCE: host.ready.localHost.instanceId,
            NAF_ACK_WORKSPACE: workspacePath,
            NAF_ACK_MARKER: marker,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
        assert(child.stderr !== null)
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        child.on('message', message => { messages.push(message as Record<string, any>) })
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
          const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
          child.on('exit', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal })
          })
        })
        expect(exit, `ACK child exited abnormally: ${stderr}`).toEqual({ code: 0, signal: null })
        expect(messages.find(message => message.type === 'error'), stderr).toBeUndefined()
        const message = defined(messages.find(message => message.type === 'result'), 'ACK child result')
        const sessionId = String(message.sessionId)
        const result = message.result as NativePromptResult
        expect(message.injectionProof, 'the qualification transport must observe the real prompt response body cancellation').toEqual({
          promptResponseSeen: true,
          ackBodyCancelled: true,
        })
        const requestId = accepted(result, 'ACK-loss prompt reconciled by official acceptance evidence').requestId
        await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
          event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
          'ACK-loss held Turn')
        writeFileSync(host.holdReleasePath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const terminal = await waitForPromptTerminal(scene, sessionId, requestId, 'ACK-loss prompt')
        const matching = durableEvents(scene, sessionId).filter(event =>
          event.type === 'user/message' && event.data?.source?.rpcId === requestId)
        expect(matching).toHaveLength(1)
        expect(durableEvents(scene, sessionId).filter(event => event.type === 'turn/end')).toHaveLength(1)
        pass('ack-loss-accepted-reconciliation', { sessionId, marker, result, terminal, userMessageCount: matching.length, exit, injectionProof: message.injectionProof })
      } finally {
        await scene.stopHost(host)
      }
    }

    // 5. Real owned Job observation and terminal output.
    {
      const host = await scene.startHost({ scenario: 'job' })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'jobs')
        const rows: Array<NativeResult<readonly NativeJob[]>> = []
        const offFirst = session.observeJobs(result => { rows.push(result) })
        const offSecond = session.observeJobs(result => { rows.push(result) })
        const prompt = accepted(await session.prompt({ content: [{ type: 'text', text: 'c1-job-start' }] }), 'job prompt')
        const running = defined(await waitFor('Native running Job row', () => rows.at(-1),
          result => result?.kind === 'ok' && result.value.some(job => job.status === 'running')), 'Native running Job row')
        assert(running.kind === 'ok')
        const job = running.value.find(item => item.status === 'running')!
        offFirst()
        const toolCall = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'bash',
          'job bash tool/call')
        const registered = await fixtureHelpers.waitForC1WorkEvent(host.jobWorkRoot!,
          event => event.kind === 'job-event' && event.event === 'registered' && event.jobId === job.id,
          'Job registered')
        expect(registered.owner).toBe(sessionId)
        expect(registered.status).toBe('running')
        writeFileSync(join(host.jobWorkRoot!, 'job.release'), 'release\n', { mode: 0o600, flag: 'wx' })
        const completed = await waitFor('Native completed Job row', () => rows.at(-1),
          result => result?.kind === 'ok' && result.value.some(item => item.id === job.id && item.status === 'completed'))
        const settled = await fixtureHelpers.waitForC1WorkEvent(host.jobWorkRoot!,
          event => event.kind === 'job-event' && event.event === 'settled' && event.jobId === job.id,
          'Job settled')
        expect(settled.status).toBe('completed')
        expect(settled.output).toContain('c1-job-done')
        const durableSettled = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'job/settled' && event.data?.jobId === job.id,
          'durable job/settled')
        const durableRegistered = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'job/registered' && event.data?.jobId === job.id,
          'durable job/registered')
        expect(durableRegistered.data?.toolCall?.callId).toBe(toolCall.data?.callId)
        expect(durableSettled.data?.jobId).toBe(job.id)
        await waitForPromptTerminal(scene, sessionId, prompt.requestId, 'job prompt')
        offSecond()
        pass('jobs', { sessionId, toolCallId: toolCall.data?.callId, job, registered, settled, durableRegistered, durableSettled })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // 6. Approval allow positive control.
    {
      const host = await scene.startHost({ scenario: 'approval-allow' })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host, { onApproval: async () => 'allowed-once' })
        const { sessionId, session } = await createSession(scene, client, 'approval-allow')
        accepted(await session.prompt({ content: [{ type: 'text', text: 'native approval allow' }] }), 'approval allow prompt')
        const asked = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'approval/asked',
          'approval allow asked')
        const decided = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'approval/decided' && event.data?.id === asked.data?.id,
          'approval allow decided')
        expect(decided.data?.outcome).toBe('allowed-once')
        const result = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/result' && event.data?.message?.toolCallId === asked.data?.callId,
          'approval allow tool/result')
        expect(result.data?.message?.isError).not.toBe(true)
        const marker = join(host.workloadRoot!, 'approval-allow.marker')
        expect(existsSync(marker)).toBe(true)
        expect(readFileSync(marker, 'utf8')).toBe('c1-approval-allow')
        await waitForTurnEnd(scene, sessionId, Number(nearestTurnStart(durableEvents(scene, sessionId), asked).data?.turn), 'approval allow turn/end')
        pass('approval-allow', { sessionId, asked, decided, result, marker })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // 7. Approval deny with old-Client late allow fenced and same Host request recovered.
    {
      const host = await scene.startHost({ scenario: 'approval-reject' })
      let first: NativeClient | undefined
      let second: NativeClient | undefined
      try {
        let oldRequest: Parameters<NonNullable<NativeAttachOptions['onApproval']>>[0] | undefined
        const oldDecision = Promise.withResolvers<Awaited<ReturnType<NonNullable<NativeAttachOptions['onApproval']>>>>()
        first = await attach(scene, host, { onApproval: async request => {
          oldRequest = request
          return await withAbort(oldDecision.promise, request.signal)
        } })
        const created = await createSession(scene, first, 'approval')
        accepted(await created.session.prompt({ content: [{ type: 'text', text: 'native approval reject' }] }), 'approval prompt')
        const request = defined(await waitFor('first Approval request', () => oldRequest, value => value !== undefined), 'first Approval request')
        expect(request.toolName).toBe('bash')
        const asked = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'approval/asked' && event.data?.callId === request.callId,
          'approval/asked')
        await first.close()
        first = undefined
        expect(request.signal?.aborted).toBe(true)
        oldDecision.resolve('allowed-once')

        let recoveredRequest: typeof request | undefined
        second = await attach(scene, host, { onApproval: async incoming => {
          recoveredRequest = incoming
          return 'rejected'
        } })
        const reopened = ok(await second.openSession(created.sessionId), 'reopen approval Session')
        const recovered = defined(await waitFor('recovered Approval request', () => recoveredRequest, value => value !== undefined), 'recovered Approval request')
        expect(recovered.callId).toBe(request.callId)
        const decided = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'approval/decided' && event.data?.id === asked.data?.id,
          'approval/decided')
        expect(decided.data?.outcome).toBe('rejected')
        const result = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'tool/result' && event.data?.message?.toolCallId === request.callId,
          'rejected tool/result')
        expect(result.data?.message?.isError).toBe(true)
        expect(existsSync(join(host.workloadRoot!, 'approval-reject.marker'))).toBe(false)
        await waitForTurnEnd(scene, created.sessionId, Number(nearestTurnStart(durableEvents(scene, created.sessionId), asked).data?.turn), 'approval turn/end')
        const decisions = durableEvents(scene, created.sessionId).filter(event => event.type === 'approval/decided' && event.data?.id === asked.data?.id)
        expect(decisions).toHaveLength(1)
        expect(decisions[0]?.data?.outcome).toBe('rejected')
        await reopened.close()
        pass('approval-deny', { sessionId: created.sessionId, callId: request.callId, asked, decided, result, lateOldOutcome: 'allowed-once' })
      } finally {
        await first?.close()
        await second?.close()
        await scene.stopHost(host)
      }
    }

    // 6. Official timed Question -> continued projection -> one native reply.
    {
      const host = await scene.startHost({ scenario: 'question', timedQuestion: true })
      let first: NativeClient | undefined
      let second: NativeClient | undefined
      try {
        let firstRequest: Parameters<NonNullable<NativeAttachOptions['onQuestion']>>[0] | undefined
        first = await attach(scene, host, { onQuestion: async request => {
          firstRequest ??= request
          if (request !== firstRequest) {
            return await withAbort(new Promise<never>(() => {}), request.signal)
          }
          return await new Promise(resolve => {
            const answer = (): void => resolve({ answers: [{ id: 'c1-question', selected: ['Proceed'] }] })
            if (request.signal?.aborted === true) answer()
            else request.signal?.addEventListener('abort', answer, { once: true })
          })
        } })
        const created = await createSession(scene, first, 'continued')
        accepted(await created.session.prompt({ content: [{ type: 'text', text: 'native timed question' }] }), 'timed Question prompt')
        const call = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'ask_user_question',
          'timed Question tool/call')
        const callId = String(call.data?.callId)
        const request = defined(await waitFor('timed Question request', () => firstRequest, value => value !== undefined), 'timed Question request')
        expect(request.timed).toBe(true)
        expect(request.callId).toBe(callId)
        await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
          event => event.kind === 'question-failed' && event.sessionId === created.sessionId,
          'official timed foreground end')
        await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
          event => event.kind === 'question-projection' && event.callId === callId
            && event.active?.some((item: Record<string, any>) => item.callId === callId && item.state === 'continued'),
          'continued projection')
        await first.close()
        first = undefined

        let continuedRequest: typeof request | undefined
        second = await attach(scene, host, { onQuestion: async incoming => {
          continuedRequest = incoming
          return { answers: [{ id: 'c1-question', selected: ['Proceed'] }] }
        } })
        const reopened = ok(await second.openSession(created.sessionId), 'reopen continued Session')
        const recovered = defined(await waitFor('continued Native reoffer', () => continuedRequest, value => value !== undefined), 'continued Native reoffer')
        expect(recovered.callId).toBe(callId)
        await waitFor('continued answer RPC settlement', () => ok(defined(second, 'continued Client').status(), 'continued status').pendingInteractions,
          pending => pending === 0)
        writeFileSync(host.timedDuplicateBarrierPath!, 'duplicate\n', { mode: 0o600, flag: 'wx' })
        const duplicate = await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
          event => event.kind === 'answer-probe' && event.phase === 'duplicate',
          'duplicate continued answer')
        expect(duplicate.code).toBe('REPLY_QUEUED')
        writeFileSync(host.timedAfterBarrierPath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const reply = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply'
            && event.data?.source?.callId === callId,
          'durable continued reply')
        await waitForTurnEnd(scene, created.sessionId, Number(nearestTurnStart(durableEvents(scene, created.sessionId), call).data?.turn), 'continued turn/end')
        writeFileSync(host.timedExpiredBarrierPath!, 'expired\n', { mode: 0o600, flag: 'wx' })
        const expired = await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!,
          event => event.kind === 'answer-probe' && event.phase === 'expired',
          'expired continued answer')
        expect(expired.value).toBe(false)
        expect(durableEvents(scene, created.sessionId).filter(event =>
          event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply'
          && event.data?.source?.callId === callId)).toHaveLength(1)
        await reopened.close()
        pass('question-pending-continued', { sessionId: created.sessionId, callId, request, recovered, reply, duplicate, expired })
      } finally {
        await first?.close()
        await second?.close()
        await scene.stopHost(host)
      }
    }

    // A caller callback that ignores its signal must not hold Client close forever.
    {
      const host = await scene.startHost({ scenario: 'question', timedQuestion: true })
      let client: NativeClient | undefined
      try {
        let request: Parameters<NonNullable<NativeAttachOptions['onQuestion']>>[0] | undefined
        client = await attach(scene, host, { onQuestion: async incoming => {
          request = incoming
          return await new Promise<never>(() => {})
        } })
        const created = await createSession(scene, client, 'noncooperative-question')
        accepted(await created.session.prompt({ content: [{ type: 'text', text: 'native noncooperative question acp-question-blocking' }] }), 'noncooperative question prompt')
        const received = defined(await waitFor('noncooperative Question request', () => request, value => value !== undefined), 'noncooperative Question request')
        await settleWithin(client.close(), 'close with noncooperative Question callback')
        client = undefined
        expect(received.signal?.aborted).toBe(true)
        expect(durableEvents(scene, created.sessionId).some(event =>
          event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply')).toBe(false)
        pass('noncooperative-callback-close', { sessionId: created.sessionId, callId: received.callId, closed: true })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // 7. Official Plan command/readback and exit_plan_mode approval.
    {
      const host = await scene.startHost({ scenario: 'plan-review' })
      let first: NativeClient | undefined
      let second: NativeClient | undefined
      try {
        let planRequest: Parameters<NonNullable<NativeAttachOptions['onQuestion']>>[0] | undefined
        const planDecision = Promise.withResolvers<Awaited<ReturnType<NonNullable<NativeAttachOptions['onQuestion']>>>>()
        first = await attach(scene, host, { onQuestion: async request => {
          planRequest = request
          return await withAbort(planDecision.promise, request.signal)
        } })
        const created = await createSession(scene, first, 'plan')
        const entered = committed(await created.session.command('/plan'), 'Plan /plan')
        expect('matched' in entered ? entered.matched : entered.result.kind).toBe('success')
        await waitFor('Plan active readback', async () => ok(await created.session.configuration(), 'Plan configuration').plan,
          plan => plan?.active === true)
        const off = committed(await created.session.selectPlanMode(false), 'Plan off readback')
        expect(off.active).toBe(false)
        const on = committed(await created.session.selectPlanMode(true), 'Plan on readback')
        expect(on.active).toBe(true)
        const planPrompt = accepted(await created.session.prompt({ content: [{ type: 'text', text: 'Present the plan FR8_PLAN_APPROVE' }] }), 'Plan prompt')
        const call = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'exit_plan_mode',
          'exit_plan_mode tool/call', 30_000)
        const request = defined(await waitFor('Plan review request', () => planRequest, value => value !== undefined, 30_000), 'Plan review request')
        expect(request.questions[0]?.intent?.kind).toBe('plan-review')
        expect(request.questions[0]?.detail).toContain('FR8_PLAN_TAIL_END')
        expect(call.data?.callId).toBe(request.callId)
        await first.close()
        first = undefined
        expect(request.signal?.aborted).toBe(true)

        let recoveredRequest: typeof request | undefined
        second = await attach(scene, host, { onQuestion: async incoming => {
          recoveredRequest = incoming
          return { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
        } })
        const reopened = ok(await second.openSession(created.sessionId), 'reopen Plan Session')
        const recovered = defined(await waitFor('recovered Plan request', () => recoveredRequest, value => value !== undefined), 'recovered Plan request')
        expect(recovered.callId).toBe(request.callId)
        planDecision.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
        const result = await scene.waitForSessionEvent(created.sessionId, 0,
          event => event.type === 'tool/result' && event.data?.message?.toolCallId === request.callId,
          'Plan approved tool/result')
        expect(result.data?.message?.isError).not.toBe(true)
        expect(eventText(result)).toContain('Plan approved')
        const resultIndex = eventIndex(durableEvents(scene, created.sessionId), result)
        const modeOff = await scene.waitForSessionEvent(created.sessionId, resultIndex + 1,
          event => event.type === 'plan/mode' && event.data?.active === false,
          'Plan mode off after approval')
        expect(seqOf(modeOff)).toBeGreaterThan(seqOf(result))
        await waitFor('Plan inactive projection', async () => ok(await reopened.configuration(), 'Plan final configuration').plan,
          plan => plan?.active === false)
        await reopened.close()
        pass('plan', { sessionId: created.sessionId, prompt: planPrompt, callId: request.callId, request, recovered, result, modeOff })
      } finally {
        await first?.close()
        await second?.close()
        await scene.stopHost(host)
      }
    }

    // 8. Real image bytes -> durable ref -> model request -> verified readback.
    {
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#20a040' } }).png().toBuffer()
      const host = await scene.startHost({ scenario: 'acp-po4a', imageProbe: true, imageSha256: digest(png) })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'image')
        const imageCatalog = ok(await client.catalog(), 'image model catalog')
        expect(imageCatalog.models.groups.find(group => group.id === 'c1-qualification')?.models.some(model => model.id === 'c1-text-only')).toBe(true)
        committed(await session.selectModel({ provider: 'c1-qualification', model: 'c1-text-only' }), 'select text-only model')
        const beforeNegative = durableEvents(scene, sessionId).length
        const negative = await session.prompt({ content: [
          { type: 'text', text: 'native unsupported image' },
          { type: 'image', mediaType: 'image/png', bytes: png, name: 'unsupported.png' },
        ] })
        expect(negative.kind, `text-only image prompt must be rejected: ${resultSummary(negative)}`).toBe('rejected')
        const negativeEvents = durableEvents(scene, sessionId)
        expect(negativeEvents.length).toBe(beforeNegative)
        expect(negativeEvents.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
        committed(await session.selectModel({ provider: 'c1-qualification', model: 'c1' }), 'restore image-capable model')
        const prompt = accepted(await session.prompt({ content: [
          { type: 'text', text: 'native image input' },
          { type: 'image', mediaType: 'image/png', bytes: png, name: 'native.png' },
        ] }), 'image prompt')
        const user = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'user/message' && event.data?.source?.rpcId === prompt.requestId,
          'image durable user/message')
        const image = (user.data?.content ?? []).find((part: Record<string, any>) => part.type === 'image')?.attachment as NativeImageAttachmentRef
        expect(image).toBeDefined()
        expect(image.mediaType).toBe('image/png')
        expect(image.bytes).toBe(png.byteLength)
        const promptEvidencePath = scene.installation.base.env.SPLIT_PROCESS_PROMPT_EVIDENCE
        const modelRow = await waitFor('model request userImages', () => {
          if (!existsSync(promptEvidencePath)) return undefined
          const text = readFileSync(promptEvidencePath, 'utf8')
          if (!text.endsWith('\n')) return undefined
          return text.slice(0, -1).split('\n').filter(Boolean).map(line => JSON.parse(line))
            .find(row => row.userImages?.some((entry: Record<string, any>) => entry.attachmentId === image.attachmentId))
        }, value => value !== undefined)
        expect(modelRow.userImages).toContainEqual(expect.objectContaining({
          attachmentId: image.attachmentId,
          mediaType: 'image/png',
          bytes: png.byteLength,
        }))
        const stored = ok(await session.readAttachment(image), 'readAttachment')
        expect(stored.attachment.attachmentId).toBe(image.attachmentId)
        expect(stored.data.byteLength).toBe(png.byteLength)
        expect(digest(stored.data)).toBe(digest(png))
        const terminal = await waitForPromptTerminal(scene, sessionId, prompt.requestId, 'image prompt')
        const imageProbePath = defined(host.imageProbePath, 'Host image probe path')
        const hostImageProbe = await waitFor<Record<string, any>[]>('Host image probe digest', () => {
          if (!existsSync(imageProbePath)) return []
          const text = readFileSync(imageProbePath, 'utf8')
          if (!text.endsWith('\n')) return []
          return text.slice(0, -1).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
        }, rows => rows.some(row => row.attachmentId === image.attachmentId))
        const probe = defined(hostImageProbe.find(row => row.attachmentId === image.attachmentId), 'Host image probe row')
        expect(probe.success, JSON.stringify(probe)).toBe(true)
        expect(probe.sha256).toBe(digest(png))
        expect(probe.bytes).toBe(png.byteLength)
        pass('image', {
          sessionId,
          inputBytes: png.byteLength,
          inputSha256: digest(png),
          attachment: image,
          modelRow,
          readBackBytes: stored.data.byteLength,
          readBackSha256: digest(stored.data),
          hostImageProbePath: host.imageProbePath,
          hostImageProbe,
          textOnlyNegative: negative,
          terminal,
        })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    // 9. Real child observation, continuity and terminal history.
    {
      const host = await scene.startHost({ scenario: 'child', holdChild: true })
      let client: NativeClient | undefined
      try {
        client = await attach(scene, host)
        const { sessionId, session } = await createSession(scene, client, 'child')
        const snapshots: Array<NativeResult<NativeSubagentSnapshot>> = []
        const offFirst = session.observeSubagents(result => { snapshots.push(result) })
        const offSecond = session.observeSubagents(result => { snapshots.push(result) })
        const parentPrompt = accepted(await session.prompt({ content: [{ type: 'text', text: 'native child parent' }] }), 'child parent prompt')
        const running = defined(await waitFor('Native running child', () => snapshots.at(-1),
          result => result?.kind === 'ok' && result.value.descendants.some(entry => entry.kind === 'child' && entry.activity === 'running')), 'Native running child')
        assert(running.kind === 'ok')
        const child = running.value.descendants.find(entry => entry.kind === 'child' && entry.activity === 'running')!
        assert(child.kind === 'child')
        expect(child.id).not.toBe(sessionId)
        expect(child.parentId).toBe(sessionId)
        const call = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'tool/call' && event.data?.name === 'subagent',
          'subagent tool/call')
        const catalog = await scene.waitForSessionEvent(sessionId, 0,
          event => event.type === 'subagent/catalog' && event.data?.childId === child.id,
          'subagent/catalog child identity')
        expect(seqOf(catalog)).toBeGreaterThan(seqOf(call))
        offFirst()
        writeFileSync(host.childReleasePath!, 'release\n', { mode: 0o600, flag: 'wx' })
        const inactive = await waitFor('Native inactive child', () => snapshots.at(-1),
          result => result?.kind === 'ok' && result.value.descendants.some(entry => entry.kind === 'child' && entry.id === child.id && entry.activity === 'inactive'))
        const childEnd = await scene.waitForSessionEvent(child.id, 0,
          event => event.type === 'turn/end',
          'child turn/end')
        const childMessage = await scene.waitForSessionEvent(child.id, 0,
          event => event.type === 'assistant/message' && eventText(event).includes('child answer'),
          'child final assistant/message')
        const childHistory = durableEvents(scene, child.id)
        expect(childHistory.some(event => event.type === 'assistant/message'
          && textOf(event.data?.message?.content).includes('child answer'))).toBe(true)
        await waitForPromptTerminal(scene, sessionId, parentPrompt.requestId, 'child parent prompt')
        offSecond()
        pass('subagent', { sessionId, toolCallId: call.data?.callId, child, catalog, childEnd, childMessage, inactive })
      } finally {
        await client?.close()
        await scene.stopHost(host)
      }
    }

    evidence.completedAt = new Date().toISOString()
    evidence.status = 'PASS'
    save()
  } catch (error) {
    primary = error
    evidence.status = 'FAIL'
    evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    save()
    throw error
  } finally {
    if (previousEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previousEnv.HOME
    if (previousEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousEnv.DSH_HOME
    if (previousEnv.SPLIT_PROCESS_DSH_ANCHOR === undefined) delete process.env.SPLIT_PROCESS_DSH_ANCHOR
    else process.env.SPLIT_PROCESS_DSH_ANCHOR = previousEnv.SPLIT_PROCESS_DSH_ANCHOR
    if (previousEnv.SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK === undefined) delete process.env.SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK
    else process.env.SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK = previousEnv.SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) throw new AggregateError([primary, cleanupError], 'Native qualification and Scene cleanup both failed')
      throw cleanupError
    }
  }
})
