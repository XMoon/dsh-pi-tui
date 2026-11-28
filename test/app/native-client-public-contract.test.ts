/**
 * Public headless entry contract for NAF-1.
 *
 * The package subpath is the compatibility surface: a consumer must be able to
 * import the typed factory from `@xmoon76/dsh-pi-tui/native-client` without
 * reaching the TUI, a second Store closure or a Host-owned service object.
 * Runtime business evidence belongs to the installed integration candidate.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import type {
  NativeAttachOptions,
  NativeApprovalOutcome,
  NativeClient,
  NativeClientStatus,
  NativeHostIdentity,
  NativeJsonValue,
  NativePromptInput,
  NativePromptResult,
  NativePendingSubmission,
  NativeQuestionAnswer,
  NativeQuestionItem,
  NativeQuestionRequest,
  NativeResult,
  NativeSession,
  NativeSessionConfiguration,
  NativeSessionEvent,
  NativeSessionSummary,
} from '../../src/app/remote-process/native-client.ts'
import { attachNativeClient, NATIVE_CLIENT_API_VERSION } from '../../src/app/remote-process/native-client.ts'
import { createNativeContinuedQuestionReceiver } from '../../src/app/remote-process/native-client-continued.ts'
import { nativeJobFrameIsDeliverable } from '../../src/app/remote-process/native-client-job-observation.ts'
import { completeNativeClientRealm, reserveNativeClientRealm } from '../../src/app/remote-process/native-client-realm.ts'
import { nativePromptWriteFailure, nativeWriteFailure } from '../../src/app/remote-process/native-client-write-result.ts'
import { classifyRemoteWriteFailure } from '../../src/runtime/remote/write-failure.ts'

const packageRoot = join(import.meta.dirname, '..', '..')

type AssertAssignable<A, B> = A extends B ? true : never
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const _attachOptionsShape: AssertAssignable<NativeAttachOptions, {
  readonly dshAnchor: string
  readonly profile: string
  readonly expectedScopeId?: string
  readonly expectedInstanceId?: string
  readonly signal?: AbortSignal
}> = true
const _packageRootRemoved: AssertEqual<'packageRoot' extends keyof NativeAttachOptions ? true : false, false> = true
const _clientShape: AssertAssignable<NativeClient, {
  status(): NativeResult<NativeClientStatus>
  subscribeStatus(listener: (result: NativeResult<NativeClientStatus>) => void): () => void
  listSessions(): Promise<NativeResult<readonly NativeSessionSummary[]>>
  readSession(sessionId: string): Promise<NativeResult<unknown>>
  createWorkspace(path: string): Promise<NativeResult<unknown>>
  createSession(input?: { readonly workspaceId?: string; readonly sessionId?: string; readonly agentPreset?: string }): Promise<NativeResult<{ readonly sessionId: string }>>
  openSession(sessionId: string): Promise<NativeResult<NativeSession>>
  catalog(): Promise<NativeResult<unknown>>
  close(): Promise<void>
}> = true
const _sessionShape: AssertAssignable<NativeSession, {
  snapshot(): NativeResult<unknown>
  history(): Promise<NativeResult<unknown>>
  subscribe(listener: (result: NativeResult<unknown>) => void): () => void
  prompt(input: NativePromptInput): Promise<NativePromptResult>
  cancel(): Promise<NativeResult<undefined>>
  updateQueue(itemId: string, action: { readonly kind: 'remove' }): Promise<NativeResult<undefined>>
  rename(title: string): Promise<NativeResult<{ readonly title: string; readonly seq: number }>>
  configuration(): Promise<NativeResult<NativeSessionConfiguration>>
  selectModel(input: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<NativeResult<unknown>>
  selectPreset(presetId: string): Promise<NativeResult<string>>
  selectPermissionPreset(presetId: string): Promise<NativeResult<unknown>>
  selectPlanMode(active: boolean): Promise<NativeResult<unknown>>
  commands(): Promise<NativeResult<unknown>>
  command(line: string): Promise<NativeResult<unknown>>
  readFile(input: { readonly path: string }): Promise<NativeResult<unknown>>
  readAttachment(attachment: unknown): Promise<NativeResult<unknown>>
  observeJobs(listener: (result: NativeResult<unknown>) => void): () => void
  observeSubagents(listener: (result: NativeResult<unknown>) => void): () => void
  close(): Promise<void>
}> = true
const _resultKinds: AssertEqual<NativeResult<string>['kind'],
  'ok' | 'accepted' | 'committed' | 'not-dispatched' | 'rejected' | 'unknown' | 'unsupported' | 'unavailable' | 'stale' | 'closed'> = true
const _questionShape: AssertAssignable<NativeQuestionItem, {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}> = true
const _questionHasNoPrompt: AssertEqual<'prompt' extends keyof NativeQuestionItem ? true : false, false> = true
const _questionAnswerShape: AssertAssignable<NativeQuestionAnswer, {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}> = true
const _questionAnswerHasNoText: AssertEqual<'text' extends keyof NativeQuestionAnswer['answers'][number] ? true : false, false> = true
const _questionRequestShape: AssertAssignable<NativeQuestionRequest, {
  readonly sessionId: string
  readonly callId?: string
  readonly timed?: boolean
  readonly questions: readonly NativeQuestionItem[]
  readonly signal?: AbortSignal
}> = true
const _approvalOutcomes: AssertEqual<NativeApprovalOutcome, 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> = true
const _promptBytes: AssertAssignable<NativePromptInput['content'][number], {
  readonly type: 'text'; readonly text: string
} | {
  readonly type: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly bytes: Uint8Array; readonly name?: string
} | {
  readonly type: 'file'; readonly name: string; readonly bytes: Uint8Array
}> = true
const _pendingImagePreviewOptional: AssertEqual<{} extends Pick<Extract<NativePendingSubmission['attachments'][number], { readonly type: 'image' }>['value'], 'previewUrl'> ? true : false, true> = true
const _eventDataTyped: AssertAssignable<NativeSessionEvent['data'], NativeJsonValue> = true
const _identityKernel: AssertAssignable<NativeHostIdentity['kernel'], {
  readonly platform: 'linux'; readonly hostStarttime: string
} | {
  readonly platform: 'darwin'; readonly pid: number; readonly bootUUID: string; readonly uniqueId: string
}> = true

test('package.json publishes one typed native-client subpath', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string } | string>
  }
  const entry = manifest.exports?.['./native-client']
  assert.ok(entry !== undefined && typeof entry !== 'string', 'the public subpath must exist')
  assert.equal(entry.types, './dist/native-client.d.mts')
  assert.equal(entry.default, './dist/native-client.mjs')
})

test('the Native Client guide Session example typechecks against the public contract', () => {
  const guide = readFileSync(join(packageRoot, 'docs', 'guides', 'native-client.md'), 'utf8')
  const section = guide.slice(guide.indexOf('## Owned Session handles'))
  const example = /```ts\n([\s\S]*?)\n```/u.exec(section)?.[1]
  assert.ok(example !== undefined, 'the Native Client guide must contain a Session example')
  const virtualPath = join(packageRoot, 'test', 'app', 'native-client-guide-example.ts')
  const source = [
    "import type { NativeClient } from '../../src/app/remote-process/native-client.ts'",
    'declare const client: NativeClient',
    'declare const sessionId: string',
    'declare const pngBytes: Uint8Array',
    'declare const signal: AbortSignal',
    example,
  ].join('\n')
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: ['node'],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === virtualPath
    ? ts.createSourceFile(fileName, source, languageVersion, true)
    : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  host.fileExists = fileName => fileName === virtualPath || fileExists(fileName)
  host.readFile = fileName => fileName === virtualPath ? source : readFile(fileName)
  const program = ts.createProgram([virtualPath], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file?.fileName === virtualPath)
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), [])
})

test('the headless entry exports the frozen API version and attach factory', () => {
  assert.equal(NATIVE_CLIENT_API_VERSION, 1)
  assert.equal(typeof attachNativeClient, 'function')
  assert.ok(_attachOptionsShape)
  assert.ok(_packageRootRemoved)
  assert.ok(_clientShape)
  assert.ok(_sessionShape)
  assert.ok(_resultKinds)
  assert.ok(_questionShape)
  assert.ok(_questionHasNoPrompt)
  assert.ok(_questionAnswerShape)
  assert.ok(_questionAnswerHasNoText)
  assert.ok(_questionRequestShape)
  assert.ok(_approvalOutcomes)
  assert.ok(_promptBytes)
  assert.ok(_eventDataTyped)
  assert.ok(_identityKernel)
  assert.ok(_pendingImagePreviewOptional)
})

test('one Node realm rejects a concurrent composition and releases only its own reservation', () => {
  const release = reserveNativeClientRealm()
  assert.throws(() => reserveNativeClientRealm(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'NATIVE_CLIENT_REALM_BUSY')
    return true
  })
  release()
  const releaseAfterFailure = reserveNativeClientRealm()
  releaseAfterFailure()
  const releaseAfterClose = reserveNativeClientRealm()
  releaseAfterClose()
})

test('failed Client-owned cleanup retains the realm until a successful settlement', async () => {
  const release = reserveNativeClientRealm()
  await assert.rejects(completeNativeClientRealm(release, async () => { throw new Error('cleanup failed') }), /cleanup failed/u)
  assert.throws(() => reserveNativeClientRealm(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'NATIVE_CLIENT_REALM_BUSY')
    return true
  })
  await completeNativeClientRealm(release, async () => {})
  const releaseAfterSuccessfulSettlement = reserveNativeClientRealm()
  releaseAfterSuccessfulSettlement()
})

test('service-reported cancellation after dispatch stays unknown with the prompt request id', () => {
  const classified = classifyRemoteWriteFailure({ code: 'gateway/cancelled', message: 'cancelled after invocation' })
  assert.equal(classified.kind, 'cancelled')
  assert.deepEqual(nativeWriteFailure(classified), {
    kind: 'unknown',
    code: 'NATIVE_OPERATION_CANCELLED_AFTER_DISPATCH',
    message: 'The official call was cancelled after it entered the dispatch path.',
  })
  assert.deepEqual(nativePromptWriteFailure(classified, 'request-1'), {
    kind: 'unknown',
    code: 'NATIVE_OPERATION_CANCELLED_AFTER_DISPATCH',
    message: 'The official prompt call was cancelled after it entered the dispatch path.',
    requestId: 'request-1',
  })
})

test('production continued receiver follows both official fact faces', () => {
  const generation = { id: 1 }
  const generationListeners = new Set<() => void>()
  const factListeners = new Set<() => void>()
  const facts = {
    active: [{ callId: 'call-1', questions: [{ id: 'q1', question: 'continue?' }], state: 'continued' as const }],
    settled: [] as string[],
    queued: false,
  }
  const source = {
    getSnapshot: () => generation as object | undefined,
    subscribe(listener: () => void): () => void {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  const binding = {}
  const handle = {
    sessionId: 'session-1',
    isClosed: false,
    bindingIdentity: () => binding,
    isCurrentBinding: () => true,
    continuedCalls: () => facts.active,
    continuedEligible: (callId: string) => facts.active.some(call => call.callId === callId && call.state === 'continued')
      && !facts.settled.includes(callId) && !facts.queued,
    observeOfficialQuestionFacts(listener: () => void): () => void {
      factListeners.add(listener)
      listener()
      return () => { factListeners.delete(listener) }
    },
  }
  const notifyFacts = (): void => { for (const listener of [...factListeners]) listener() }
  const handles = new Set([handle])
  const offers: AbortController[] = []
  const receiver = createNativeContinuedQuestionReceiver({
    generation: source,
    handles,
    handlesBySession: new Map([['session-1', handles]]),
    handleListeners: new Set(),
    isClosed: () => false,
    onInvalidProjection: error => { throw error },
    onOffer: reservation => { offers.push(reservation.controller); return true },
  })
  assert.equal(offers.length, 1)
  facts.queued = true
  notifyFacts()
  assert.equal(offers[0]?.signal.aborted, true)
  assert.equal(offers.length, 1)
  facts.queued = false
  notifyFacts()
  assert.equal(offers.length, 2)
  assert.equal(offers[1]?.signal.aborted, false)
  facts.settled.push('call-1')
  notifyFacts()
  assert.equal(offers[1]?.signal.aborted, true)
  notifyFacts()
  assert.equal(offers.length, 2)
  receiver.dispose()
  assert.equal(generationListeners.size, 0)
  assert.equal(factListeners.size, 0)
})

test('continued receiver reserves delivery before a reentrant close', () => {
  const generation = { id: 1 }
  let receiver: ReturnType<typeof createNativeContinuedQuestionReceiver> | undefined
  let offeredController: AbortController | undefined
  let notifyFacts: (() => void) | undefined
  let continued = false
  const source = {
    getSnapshot: () => generation as object | undefined,
    subscribe: () => () => {},
  }
  const binding = {}
  const handle = {
    sessionId: 'session-1',
    isClosed: false,
    bindingIdentity: () => binding,
    isCurrentBinding: () => true,
    continuedCalls: () => continued ? [{ callId: 'call-1', questions: [], state: 'continued' as const }] : [],
    continuedEligible: () => true,
    observeOfficialQuestionFacts(listener: () => void): () => void {
      notifyFacts = listener
      return () => {}
    },
  }
  const handles = new Set([handle])
  receiver = createNativeContinuedQuestionReceiver({
    generation: source,
    handles,
    handlesBySession: new Map([['session-1', handles]]),
    handleListeners: new Set(),
    isClosed: () => false,
    onInvalidProjection: error => { throw error },
    onOffer: reservation => {
      offeredController = reservation.controller
      receiver?.dispose()
      return true
    },
  })
  continued = true
  notifyFacts?.()
  assert.equal(offeredController?.signal.aborted, true)
})

test('Job frames require their physical opener generation', () => {
  const opener = { id: 1 }
  const successor = { id: 2 }
  assert.equal(nativeJobFrameIsDeliverable({
    openerGeneration: opener,
    currentGeneration: opener,
    openerSignalAborted: false,
    bindingCurrent: true,
  }), true)
  assert.equal(nativeJobFrameIsDeliverable({
    openerGeneration: opener,
    currentGeneration: successor,
    openerSignalAborted: false,
    bindingCurrent: true,
  }), false)
  assert.equal(nativeJobFrameIsDeliverable({
    openerGeneration: opener,
    currentGeneration: opener,
    openerSignalAborted: true,
    bindingCurrent: true,
  }), false)
  assert.equal(nativeJobFrameIsDeliverable({
    openerGeneration: opener,
    currentGeneration: opener,
    openerSignalAborted: false,
    bindingCurrent: false,
  }), false)
})

test('separate module instances share the same Node-realm reservation', async () => {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', '..', 'src', 'app', 'remote-process', 'native-client-realm.ts')).href
  const first = await import(`${moduleUrl}?review-copy=a`) as typeof import('../../src/app/remote-process/native-client-realm.ts')
  const second = await import(`${moduleUrl}?review-copy=b`) as typeof import('../../src/app/remote-process/native-client-realm.ts')
  const release = first.reserveNativeClientRealm()
  assert.throws(() => second.reserveNativeClientRealm(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'NATIVE_CLIENT_REALM_BUSY')
    return true
  })
  release()
  const releaseSecond = second.reserveNativeClientRealm()
  releaseSecond()
})
