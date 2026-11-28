import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { JobListFrame } from '@deepseek-ai/dsh-api-job-controller/types'
import type {
  ISessions,
  SessionBinding,
  SessionEventChange,
  SessionEventLikeEntry,
  SessionEventWindow,
  SessionReference,
  SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SessionEventsPage,
  SessionEventEntry,
  SessionPageRequest,
  SessionProjectionsValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MountedRemoteClientDomains, MountedRemoteClientDomainPrerequisites } from '../remote/client-runtime.ts'
import type { InstalledLocalClientTransport, LocalClientTransport, LocalTransportStatus } from './local-transport.ts'
import type { LocalInstanceRecord } from './local-discovery.ts'
import type { PiTuiSessionPolicyNamespace } from '../../runtime/remote/pi-tui-session-policy-contract.ts'
import type { RemoteConnectionGenerationSource } from '../../runtime/remote/session-reader-remote.ts'
import type { RemoteFileReceiptUploader } from '../../runtime/remote/file-upload-remote.ts'
import type { RemoteWriteFailure } from '../../runtime/remote/write-failure.ts'
import { createRemoteFileReceiptUploader } from '../../runtime/remote/file-upload-remote.ts'
import {
  classifyRemoteModelFailure,
} from '../../runtime/remote/model-remote.ts'
import {
  classifyRemotePresetFailure,
} from '../../runtime/remote/preset-remote.ts'
import {
  classifyRemoteWriteFailure,
  remoteFailureCode,
  remoteFailureMessage,
} from '../../runtime/remote/write-failure.ts'
import { RemoteTaskReader } from '../../runtime/remote/task-read-remote.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { observeSettled, runDetached, runOwned } from '../../runtime/process/tasks.ts'
import { isRemoteBusinessRefusalCode } from '../../runtime/write-outcome.ts'
import { mergeCause } from '../remote/dispose-cause.ts'
import { createDiag, type Diag } from '../../runtime/process/diagnostics.ts'
import {
  assertClientHostCompatible,
  assertRecordedHostKernelIdentityCurrent,
  authenticateLocalHost,
  inspectHostProcess,
  readLocalRecord,
} from './local-discovery.ts'
import {
  installedPackageRootFromEntry,
  inspectInstalledProfileScope,
  readInstalledDshVersion,
} from './local-scope.ts'
import {
  createNativeContinuedQuestionReceiver,
  type NativeContinuedDeliveryReservation,
  type NativeContinuedQuestionReceiver,
} from './native-client-continued.ts'
import { abortable } from './native-client-operations.ts'
import { completeNativeClientRealm, reserveNativeClientRealm } from './native-client-realm.ts'
import { nativePromptWriteFailure, nativeWriteFailure } from './native-client-write-result.ts'

type SessionId = SessionReference['sessionId']
type WorkspaceId = NonNullable<NonNullable<Parameters<ISessions['create']>[0]>['workspaceId']>

export const NATIVE_CLIENT_API_VERSION = 1 as const

const NATIVE_DSH_VERSION = '0.2.2-rc.5'
const NATIVE_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'

export type NativeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NativeJsonValue[]
  | { readonly [key: string]: NativeJsonValue }

export interface NativeFailure {
  readonly code: string
  readonly message: string
}

export type NativeResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'accepted'; readonly requestId?: string; readonly value?: T }
  | { readonly kind: 'committed'; readonly value: T }
  | ({ readonly kind: 'not-dispatched' } & NativeFailure)
  | ({ readonly kind: 'rejected' } & NativeFailure)
  | ({
    readonly kind: 'unknown'
    readonly requestId?: string
    readonly requestedSessionId?: string
    readonly committedSessionId?: string
  } & NativeFailure)
  | ({ readonly kind: 'unsupported' } & NativeFailure)
  | ({ readonly kind: 'unavailable' } & NativeFailure)
  | ({ readonly kind: 'stale' } & NativeFailure)
  | ({ readonly kind: 'closed' } & NativeFailure)

type NativeFailureResult = Extract<NativeResult<never>, {
  readonly kind: 'not-dispatched' | 'rejected' | 'unknown' | 'unsupported' | 'unavailable' | 'stale' | 'closed'
}>
type NativeReadResult<T> = { readonly kind: 'ok'; readonly value: T } | NativeFailureResult
type NativePromptFailure =
  | ({ readonly kind: 'not-dispatched' } & NativeFailure)
  | ({ readonly kind: 'rejected' } & NativeFailure)
  | ({ readonly kind: 'unsupported' } & NativeFailure)
  | ({ readonly kind: 'unavailable' } & NativeFailure)
  | ({ readonly kind: 'stale' } & NativeFailure)
  | ({ readonly kind: 'closed' } & NativeFailure)
export type NativePromptResult =
  | { readonly kind: 'accepted'; readonly requestId: string }
  | ({ readonly kind: 'unknown'; readonly requestId: string } & NativeFailure)
  | NativePromptFailure

export interface NativeDarwinKernelIdentity {
  readonly platform: 'darwin'
  readonly pid: number
  readonly bootUUID: string
  readonly uniqueId: string
  readonly parentUniqueId: string
  readonly processUUID: string
  readonly startSec: string
  readonly startUsec: string
  readonly ppid: number
  readonly pgid: number
  readonly sid: number
  readonly uid: number
  readonly state: number
}

export type NativeHostKernelIdentity =
  | { readonly platform: 'linux'; readonly hostStarttime: string }
  | NativeDarwinKernelIdentity

export interface NativeHostIdentity {
  readonly scopeId: string
  readonly instanceId: string
  readonly hostPid: number
  readonly kernel: NativeHostKernelIdentity
  readonly protocol: string
  readonly dshVersion: string
  readonly bundleVersion: string
  readonly buildId: string
}

export type NativeLocalizedText = string | { readonly en: string; readonly [locale: string]: string }

export interface NativeQuestionOption {
  readonly label: string
  readonly description?: string
}

export type NativeQuestionIntent =
  | {
    readonly kind: 'plan-review'
    readonly approve: string
    readonly callId?: string
  }
  | {
    readonly kind: 'approval'
    readonly approve: string
    readonly reject: string
    readonly always?: string
    readonly subject?: { readonly name: string; readonly icon?: string }
    readonly display?: {
      readonly question: { readonly en: string; readonly [locale: string]: string }
      readonly detail?: { readonly en: string; readonly [locale: string]: string }
      readonly approve?: { readonly en: string; readonly [locale: string]: string }
    }
  }

export interface NativeQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly NativeQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: NativeQuestionIntent
}

export interface NativeQuestionRequest {
  readonly sessionId: string
  readonly callId?: string
  readonly timed?: boolean
  readonly questions: readonly NativeQuestionItem[]
  readonly signal?: AbortSignal
}

export interface NativeQuestionAnswer {
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[]
}

export interface NativeApprovalRequest {
  readonly sessionId: string
  readonly callId?: string
  readonly toolName: string
  readonly reason?: string
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  readonly signal?: AbortSignal
}

export type NativeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface NativeAttachOptions {
  readonly dshAnchor: string
  readonly profile: string
  readonly expectedScopeId?: string
  readonly expectedInstanceId?: string
  readonly signal?: AbortSignal
  readonly onQuestion?: (request: NativeQuestionRequest) => Promise<NativeQuestionAnswer>
  readonly onApproval?: (request: NativeApprovalRequest) => Promise<NativeApprovalOutcome>
}

export interface NativeClientStatus {
  readonly transport: 'connecting' | 'connected' | 'disconnected' | 'closed'
  readonly generationId?: number
  readonly activeWrappers: number
  readonly liveSockets: number
  readonly pendingInteractions: number
  readonly interactionIdentityGaps: number
  readonly identity: NativeHostIdentity
}

export interface NativeSessionSummary {
  readonly sessionId: string
  readonly title?: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly formatStatus?: 'current' | 'migration-required'
}

export interface NativeHistoryOptions {
  readonly beforeSeq?: number
  readonly throughSeq?: number
  readonly maxMessages?: number
  readonly turnWindow?: {
    readonly minMessages: number
    readonly minTurns: number
  }
}

export interface NativeSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: NativeJsonValue
  readonly ignorable?: true
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }
  readonly sourceEventSeqs?: readonly number[]
}

export interface NativeLiveChunkEvent {
  readonly type: 'assistant/live-chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly attemptId: string
    readonly turn: number
    readonly step: number
    readonly chunk: NativeJsonValue
  }
}

export type NativeSessionEventEntry =
  | { readonly type: 'event'; readonly event: NativeSessionEvent }
  | { readonly type: 'transient'; readonly event: NativeLiveChunkEvent }

export type NativeSessionChange =
  | { readonly kind: 'replace'; readonly entries: readonly NativeSessionEventEntry[] }
  | { readonly kind: 'prepend'; readonly entries: readonly NativeSessionEventEntry[] }
  | { readonly kind: 'append'; readonly entries: readonly NativeSessionEventEntry[] }
  | {
    readonly kind: 'settle-assistant'
    readonly attemptId: string
    readonly entry?: NativeSessionEventEntry
  }

export interface NativeHistoryPage {
  readonly cursor: number
  readonly records: readonly NativeSessionEventEntry[]
  readonly hasMore: boolean
}

export interface NativeSessionHistoryWindow {
  readonly entries: readonly NativeSessionEventEntry[]
  readonly hasMore: boolean
  readonly revision: number
  readonly change: NativeSessionChange
}

export interface NativeFileAttachmentRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

export interface NativeImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

export interface NativePendingSubmission {
  readonly requestId: string
  readonly placement: 'transcript' | 'queued' | 'steering'
  readonly time: number
  readonly text: string
  readonly attachments: readonly (
    | { readonly type: 'image'; readonly value: {
      readonly previewUrl?: string
      readonly name?: string
      readonly width?: number
      readonly height?: number
    } }
    | { readonly type: 'file'; readonly value: NativeFileAttachmentRef }
  )[]
}

export interface NativePlanProjection {
  readonly active: boolean
  readonly pending: boolean
}

export interface NativeTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export interface NativeContextPressure {
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

export interface NativeUserQuestionProjection {
  readonly active: readonly {
    readonly callId: string
    readonly questions: readonly NativeQuestionItem[]
    readonly state: 'open' | 'continued'
  }[]
  readonly settled: readonly {
    readonly callId: string
    readonly answers: readonly {
      readonly id: string
      readonly selected: readonly string[]
      readonly custom?: string
    }[]
  }[]
}

export interface NativeSessionSnapshot {
  readonly sessionId: string
  readonly pendingSubmissions: readonly NativePendingSubmission[]
  readonly running: boolean
  readonly subagent: {
    readonly parentSessionId: string
    readonly childSessionId: string
    readonly mode: 'one-shot' | 'continuable' | 'unknown'
  } | null
  readonly removed: boolean
  readonly openState: 'cold' | 'loading' | 'open' | 'error'
  readonly openError: NativeFailure | null
  readonly hasMore: boolean
  readonly historyWasPartial: boolean
  readonly loadingOlder: boolean
  readonly historyLoadStatus: 'idle' | 'loading' | 'pendingConsumption' | 'error'
  readonly promptError: {
    readonly op: 'send' | 'stop'
    readonly error: NativeFailure
  } | null
  readonly blank: boolean
  readonly lastAgentError: string | null
  readonly promptAttempted: boolean
  readonly awaitingFirstTurn: boolean
  readonly projections: {
    readonly state: 'idle' | 'loading' | 'ready' | 'error' | 'migration-required'
    readonly title?: string | null
    readonly plan?: NativePlanProjection
    readonly tokenUsage?: NativeTokenUsage
    readonly contextPressure?: NativeContextPressure
    readonly userQuestions?: NativeUserQuestionProjection
    readonly inbox?: {
      readonly 'next-turn': readonly NativeJsonValue[]
      readonly 'next-step': readonly NativeJsonValue[]
    }
  }
}

export interface NativeSessionView {
  readonly sessionId: string
  readonly snapshot: NativeSessionSnapshot
  readonly window: NativeSessionHistoryWindow
  readonly reconcileRequired: boolean
}

export type NativePromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: NativeImageAttachmentRef['mediaType']
    readonly bytes: Uint8Array
    readonly name?: string
  }
  | { readonly type: 'file'; readonly name: string; readonly bytes: Uint8Array }

export interface NativePromptInput {
  readonly content: readonly NativePromptPart[]
  readonly mode?: 'queue' | 'steer'
  readonly signal?: AbortSignal
}

export type NativeQueueAction =
  | { readonly kind: 'edit'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

export interface NativeModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface NativeModelSelectionProjection {
  readonly lastUsed: NativeModelSelection | null
  readonly next: NativeModelSelection | null
}

export interface NativeModelCatalog {
  readonly default: NativeModelSelection
  readonly routableProviders: readonly string[]
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly reasoning?: {
        readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
        readonly defaultEffort?: string
      }
      readonly badge?: { readonly text: NativeLocalizedText; readonly tone: 'neutral' | 'info' | 'success' | 'warning' }
    }[]
  }[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export interface NativePresetRoster {
  readonly presets: readonly {
    readonly id: string
    readonly isDefault?: boolean
    readonly name?: string
    readonly description?: string
    readonly broken?: string
  }[]
}

export interface NativePermissionCatalog {
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly defaultOptions: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly defaultPreset: string
}

export interface NativePermissionSelection {
  readonly currentValue: string
}

export type NativePolicySide<T extends string> =
  | { readonly state: 'ready'; readonly effective: T; readonly override?: T }
  | { readonly state: 'unavailable'; readonly reason: 'service-not-installed' }

export type NativeSessionPolicyRead =
  | {
    readonly kind: 'ready'
    readonly sessionId: string
    readonly approval: NativePolicySide<'ask' | 'never'>
    readonly sandbox: NativePolicySide<'read-only' | 'workspace-write' | 'danger-full-access'>
  }
  | { readonly kind: 'unavailable'; readonly sessionId: string; readonly reason: 'session-not-live' }

export interface NativeSessionConfiguration {
  readonly modelSelection?: NativeModelSelectionProjection
  readonly currentModel?: NativeModelSelection
  readonly agentPreset?: string | null
  readonly title?: string | null
  readonly permissions?: NativePermissionSelection
  readonly plan?: NativePlanProjection
  readonly policy?: NativeSessionPolicyRead
}

export interface NativeCatalog {
  readonly models: NativeModelCatalog
  readonly presets: NativePresetRoster
  readonly permissions: NativePermissionCatalog
}

export interface NativeCommandDescriptor {
  readonly definitionId?: string
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
}

export type NativeCommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

export interface NativeCommandExecution {
  readonly commandId: string
  readonly result: NativeCommandResult
}

export interface NativeWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
}

export interface NativeWorkspaceCreateResult {
  readonly workspace: NativeWorkspace
  readonly created: boolean
}

export interface NativeFileReadInput {
  readonly path: string
  readonly baseFile?: string
  readonly range?: { readonly offset?: number; readonly length?: number }
}

export interface NativeFileBytes {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
  readonly offset: number
  readonly data: Uint8Array
  readonly eof: boolean
}

export interface NativeStoredImage {
  readonly attachment: NativeImageAttachmentRef
  readonly data: Uint8Array
}

export interface NativeJob {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly progress?: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

export type NativeSubagentEntry =
  | {
    readonly kind: 'child'
    readonly id: string
    readonly label?: string
    readonly mode: 'one-shot' | 'continuable' | 'external'
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
    readonly parentId: string
    readonly depth: number
    readonly path?: string
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: string
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly parentId: string
    readonly depth: number
  }

export interface NativeSubagentSnapshot {
  readonly parentSessionId: string
  readonly parentAvailable: boolean
  readonly descendants: readonly NativeSubagentEntry[]
}

export interface NativeSession {
  snapshot(): NativeResult<NativeSessionSnapshot>
  history(options?: NativeHistoryOptions): Promise<NativeResult<NativeHistoryPage>>
  subscribe(listener: (result: NativeResult<NativeSessionView>) => void): () => void
  prompt(input: NativePromptInput): Promise<NativePromptResult>
  cancel(): Promise<NativeResult<undefined>>
  updateQueue(itemId: string, action: NativeQueueAction): Promise<NativeResult<undefined>>
  rename(title: string): Promise<NativeResult<{ readonly title: string; readonly seq: number }>>
  configuration(): Promise<NativeResult<NativeSessionConfiguration>>
  selectModel(input: Omit<NativeModelSelection, 'reasoningEffort'> & { readonly reasoningEffort?: string }): Promise<NativeResult<NativeModelSelection>>
  selectPreset(presetId: string): Promise<NativeResult<string>>
  selectPermissionPreset(presetId: string): Promise<NativeResult<NativePermissionSelection>>
  selectPlanMode(active: boolean): Promise<NativeResult<NativePlanProjection>>
  commands(): Promise<NativeResult<readonly NativeCommandDescriptor[]>>
  command(line: string): Promise<NativeResult<NativeCommandExecution | { readonly matched: false }>>
  readFile(input: NativeFileReadInput): Promise<NativeResult<NativeFileBytes>>
  readAttachment(attachment: NativeImageAttachmentRef): Promise<NativeResult<NativeStoredImage>>
  observeJobs(listener: (result: NativeResult<readonly NativeJob[]>) => void): () => void
  observeSubagents(listener: (result: NativeResult<NativeSubagentSnapshot>) => void): () => void
  close(): Promise<void>
}

export interface NativeClient {
  status(): NativeResult<NativeClientStatus>
  subscribeStatus(listener: (result: NativeResult<NativeClientStatus>) => void): () => void
  listSessions(): Promise<NativeResult<readonly NativeSessionSummary[]>>
  readSession(sessionId: string, options?: NativeHistoryOptions): Promise<NativeResult<NativeHistoryPage>>
  createWorkspace(path: string): Promise<NativeResult<NativeWorkspaceCreateResult>>
  createSession(input?: {
    readonly workspaceId?: string
    readonly sessionId?: string
    readonly agentPreset?: string
  }): Promise<NativeResult<{ readonly sessionId: string }>>
  openSession(sessionId: string): Promise<NativeResult<NativeSession>>
  catalog(): Promise<NativeResult<NativeCatalog>>
  close(): Promise<void>
}

type NativeRemote = MountedRemoteClientDomains['remote']
type Generation = object | undefined

interface OfficialLoader {
  readonly builtins: Record<string, () => Promise<void>>
  create(options: { readonly name: string }): Promise<unknown>
}

interface OfficialClientHostModules {
  readonly Context: typeof Context
  readonly PluginPackages: abstract new (...args: never[]) => unknown
  readonly Loader: new (ctx: Context) => OfficialLoader
  readonly loadProfileDirectory: (binName: string, profileDir: string, installAnchor: string) => unknown
  readonly readProfileManifest: (binName: string, profileDir: string) => unknown
  readonly createRuntimeResolution: (options: { readonly installAnchor: string; readonly profile: unknown }) => Promise<unknown>
  readonly resolveDshHome: () => string
  readonly resolveProfileDir: (name: string, home?: string) => string
}

interface StartupGate {
  readonly plugin: () => Promise<void>
  readonly pending: boolean
  release(): void
  cancel(reason: unknown): void
}

interface NativeInteractionReceivers {
  readonly pendingCount: number
  readonly identityGaps: number
  dispose(): void
}

interface NativeClientState {
  readonly sessions: ISessions
  readonly remote: NativeRemote
  jobs: IJobs | undefined
  readonly transport: LocalClientTransport
  readonly uploader: RemoteFileReceiptUploader
  readonly generation: RemoteConnectionGenerationSource
  carrierError?: new (message: string, options?: ErrorOptions) => Error
  readonly identity: NativeHostIdentity
  readonly diag: Diag
  readonly handles: Set<OwnedNativeSession>
  readonly handlesBySession: Map<string, Set<OwnedNativeSession>>
  readonly handleListeners: Set<() => void>
  readonly statusListeners: Set<(result: NativeResult<NativeClientStatus>) => void>
  readonly statusSubscriptions: Array<() => void>
  readonly lifetime: AbortController
  readonly operations: Set<Promise<unknown>>
  closed: boolean
  closePromise?: Promise<void>
  closeFailed: boolean
  terminalStatus?: LocalTransportStatus
  fatalError: unknown
  notifyStatus(): void
  notifyHandles(): void
}

function nativeError(code: string, message: string): Error {
  return Object.assign(new Error(`native-client: ${message}`), { code })
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw nativeError('NATIVE_CLIENT_INVALID_INPUT', `${label} is required`)
  return value
}

function validateProfileName(profile: string): void {
  if (profile === '' || profile.includes('/') || profile.includes('\\') || profile === '.'
    || profile === '..' || profile === 'node_modules') {
    throw nativeError('NATIVE_CLIENT_INVALID_PROFILE', 'profile is not a valid official profile name')
  }
}

function validateNodeAndPlatform(): void {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw nativeError('NATIVE_CLIENT_UNSUPPORTED_PLATFORM', 'Native Client supports Linux and macOS only')
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(process.versions.node)
  if (match === null || Number(match[1]) !== 24 || Number(match[2]) < 9) {
    throw nativeError('NATIVE_CLIENT_UNSUPPORTED_NODE', 'Native Client requires Node 24.9 or later within Node 24')
  }
}

function validateDshAnchor(value: string): string {
  requireNonEmpty(value, 'dshAnchor')
  if (!isAbsolute(value)) throw nativeError('NATIVE_CLIENT_INVALID_DSH_ANCHOR', 'dshAnchor must be an absolute package.json path')
  const anchor = realpathSync(value)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(anchor, 'utf8'))
  } catch (error) {
    throw nativeError('NATIVE_CLIENT_INVALID_DSH_ANCHOR', 'dshAnchor is not a readable DSH package manifest')
  }
  const record = recordOf(manifest, 'dshAnchor manifest')
  if (record.name !== '@deepseek-ai/dsh' || record.version !== NATIVE_DSH_VERSION) {
    throw nativeError('NATIVE_CLIENT_UNSUPPORTED_DSH', `Native Client requires @deepseek-ai/dsh ${NATIVE_DSH_VERSION}`)
  }
  return anchor
}

async function loadOfficialClientHost(anchor: string): Promise<OfficialClientHostModules> {
  const requireFromDsh = createRequire(anchor)
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
    loadProfileDirectory: appBoot.loadProfileDirectory as OfficialClientHostModules['loadProfileDirectory'],
    readProfileManifest: appBoot.readProfileManifest as OfficialClientHostModules['readProfileManifest'],
    createRuntimeResolution: appBoot.createRuntimeResolution as OfficialClientHostModules['createRuntimeResolution'],
    resolveDshHome: homePaths.resolveDshHome as OfficialClientHostModules['resolveDshHome'],
    resolveProfileDir: appBoot.resolveProfileDir as OfficialClientHostModules['resolveProfileDir'],
  }
}

function createStartupGate(): StartupGate {
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

function projectIdentity(identity: LocalInstanceRecord): NativeHostIdentity {
  const shared = {
    scopeId: identity.scopeId,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
    protocol: identity.protocol,
    dshVersion: identity.dshVersion,
    bundleVersion: identity.bundleVersion,
    buildId: identity.buildId,
  }
  if (identity.schema === 1) {
    return Object.freeze({ ...shared, kernel: Object.freeze({ platform: 'linux' as const, hostStarttime: identity.hostStarttime }) })
  }
  if (identity.schema === 2) {
    return Object.freeze({ ...shared, kernel: Object.freeze({ ...identity.hostKernelIdentity, platform: 'darwin' as const }) })
  }
  throw nativeError('NATIVE_CLIENT_UNSUPPORTED_PLATFORM', 'the authenticated Host uses an unsupported kernel identity schema')
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}: expected an object`)
  }
  return value as Record<string, unknown>
}

function jsonValueOf(value: unknown, label = 'value'): NativeJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => jsonValueOf(item, label))
  if (typeof value === 'object') {
    const output: Record<string, NativeJsonValue> = {}
    for (const [key, item] of Object.entries(value)) output[key] = jsonValueOf(item, `${label}.${key}`)
    return output
  }
  throw new TypeError(`${label}: expected JSON data`)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function failureOf(error: unknown, fallbackCode: string, fallbackMessage: string, officialMessage: boolean): NativeFailure {
  const code = remoteFailureCode(error)
  return {
    code: code !== undefined && (isRemoteBusinessRefusalCode(code) || code.startsWith('gateway/')) ? code : fallbackCode,
    message: officialMessage ? remoteFailureMessage(error) : fallbackMessage,
  }
}

function closedResult(): NativeFailureResult {
  return { kind: 'closed', code: 'NATIVE_CLIENT_CLOSED', message: 'The Native Client is closed.' }
}

function closedSessionResult(): NativeFailureResult {
  return { kind: 'closed', code: 'NATIVE_SESSION_CLOSED', message: 'The Native Session handle is closed.' }
}

function staleResult(): NativeFailureResult {
  return { kind: 'stale', code: 'NATIVE_GENERATION_STALE', message: 'The result belongs to a replaced Connection generation.' }
}

function unavailableResult(code: string, message: string): NativeFailureResult {
  return { kind: 'unavailable', code, message }
}

function notDispatchedResult(code = 'NATIVE_OPERATION_NOT_DISPATCHED', message = 'The operation was not dispatched.'): NativeFailureResult {
  return { kind: 'not-dispatched', code, message }
}

function unsupportedResult(code: string, message: string): NativeFailureResult {
  return { kind: 'unsupported', code, message }
}

function rejectedResult(failure: NativeFailure): NativeFailureResult {
  return { kind: 'rejected', ...failure }
}

function unknownResult(failure: NativeFailure, extra?: {
  readonly requestId?: string
  readonly requestedSessionId?: string
  readonly committedSessionId?: string
}): NativeFailureResult {
  return { kind: 'unknown', ...failure, ...extra }
}

function asPromptFailure(result: NativeFailureResult): NativePromptResult {
  if (result.kind === 'unknown') throw new Error('native-client: a prompt failure after request creation must carry requestId')
  return result
}

function readFailure(error: unknown, officialMessage: boolean): NativeFailureResult {
  const failure = failureOf(error, 'NATIVE_READ_UNAVAILABLE', 'The authoritative read is unavailable.', officialMessage)
  return isRemoteBusinessRefusalCode(remoteFailureCode(error))
    ? rejectedResult(failure)
    : unavailableResult(failure.code, failure.message)
}

function currentGeneration(state: NativeClientState): Generation {
  return state.transport.connection.generation.getSnapshot()
}

function trackClientOperation<T>(state: NativeClientState, operation: Promise<T>): Promise<T> {
  state.operations.add(operation)
  observeSettled(operation, () => { state.operations.delete(operation) })
  return operation
}

async function settleRead<T, U>(
  call: () => Promise<RemoteResult<T>>,
  captured: Generation,
  generation: RemoteConnectionGenerationSource,
  map: (value: T) => U,
): Promise<NativeReadResult<U>> {
  let result: RemoteResult<T>
  try {
    result = await call()
  } catch (error) {
    if (!Object.is(captured, generation.getSnapshot())) return staleResult()
    return readFailure(error, false)
  }
  if (!Object.is(captured, generation.getSnapshot())) return staleResult()
  if (!result.ok) return readFailure(result.error, true)
  try {
    return { kind: 'ok', value: map(result.value) }
  } catch {
    return unavailableResult('NATIVE_INVALID_RESPONSE', 'The official service returned an unusable response.')
  }
}

async function settleWrite<T, U>(
  call: () => Promise<RemoteResult<T>>,
  success: 'accepted' | 'committed',
  map: (value: T) => U,
  classify: (error: unknown) => RemoteWriteFailure = classifyRemoteWriteFailure,
): Promise<NativeResult<U>> {
  let result: RemoteResult<T>
  try {
    result = await call()
  } catch (error) {
    return unknownResult(failureOf(error, 'NATIVE_OPERATION_OUTCOME_UNKNOWN', 'The operation outcome could not be determined.', false))
  }
  if (!result.ok) return nativeWriteFailure(classify(result.error))
  try {
    const value = map(result.value)
    return success === 'accepted'
      ? { kind: 'accepted', value }
      : { kind: 'committed', value }
  } catch {
    return unknownResult({ code: 'NATIVE_INVALID_RESPONSE', message: 'The official service returned an unusable response.' })
  }
}

function modelSelectionOf(value: unknown): NativeModelSelection {
  const record = recordOf(value, 'model selection')
  const provider = optionalString(record, 'provider')
  const model = optionalString(record, 'model')
  if (provider === undefined || provider === '' || model === undefined || model === '') {
    throw new TypeError('model selection: provider and model are required')
  }
  const reasoningEffort = optionalString(record, 'reasoningEffort')
  if (record.reasoningEffort !== undefined && (reasoningEffort === undefined || reasoningEffort === '')) {
    throw new TypeError('model selection: invalid reasoning effort')
  }
  return { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
}

function nullableModelSelectionOf(value: unknown): NativeModelSelection | null {
  return value === null ? null : modelSelectionOf(value)
}

function nullableStringOf(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value === '') throw new TypeError(`${label}: invalid value`)
  return value
}

function localizedTextOf(value: unknown): NativeLocalizedText {
  if (typeof value === 'string') return value
  const record = recordOf(value, 'localized text')
  if (typeof record.en !== 'string') throw new TypeError('localized text: English entry is required')
  const output: { en: string; [locale: string]: string } = { en: record.en }
  for (const [locale, text] of Object.entries(record)) {
    if (typeof text !== 'string') throw new TypeError('localized text: every entry must be a string')
    if (locale !== 'en') output[locale] = text
  }
  return output
}

function modelCatalogOf(value: unknown): NativeModelCatalog {
  const record = recordOf(value, 'model catalog')
  if (!Array.isArray(record.routableProviders) || !Array.isArray(record.groups) || !Array.isArray(record.failures)) {
    throw new TypeError('model catalog: invalid arrays')
  }
  return {
    default: modelSelectionOf(record.default),
    routableProviders: record.routableProviders.map(provider => {
      if (typeof provider !== 'string') throw new TypeError('model catalog: invalid provider')
      return provider
    }),
    groups: record.groups.map(groupValue => {
      const group = recordOf(groupValue, 'model group')
      if (typeof group.id !== 'string' || typeof group.name !== 'string' || !Array.isArray(group.models)) {
        throw new TypeError('model group: invalid fields')
      }
      return {
        id: group.id,
        name: group.name,
        models: group.models.map(modelValue => {
          const model = recordOf(modelValue, 'catalog model')
          if (typeof model.id !== 'string' || typeof model.name !== 'string') throw new TypeError('catalog model: invalid identity')
          const description = optionalString(model, 'description')
          const reasoning = model.reasoning === undefined ? undefined : (() => {
            const value = recordOf(model.reasoning, 'model reasoning')
            if (!Array.isArray(value.efforts)) throw new TypeError('model reasoning: invalid efforts')
            const defaultEffort = optionalString(value, 'defaultEffort')
            return {
              efforts: value.efforts.map(effortValue => {
                const effort = recordOf(effortValue, 'reasoning effort')
                if (typeof effort.id !== 'string' || typeof effort.name !== 'string') throw new TypeError('reasoning effort: invalid identity')
                const effortDescription = optionalString(effort, 'description')
                return { id: effort.id, name: effort.name, ...effortDescription === undefined ? {} : { description: effortDescription } }
              }),
              ...defaultEffort === undefined ? {} : { defaultEffort },
            }
          })()
          const badge: { readonly text: NativeLocalizedText; readonly tone: 'neutral' | 'info' | 'success' | 'warning' } | undefined = model.badge === undefined ? undefined : (() => {
            const value = recordOf(model.badge, 'model badge')
            const tone = value.tone
            if (tone !== 'neutral' && tone !== 'info' && tone !== 'success' && tone !== 'warning') {
              throw new TypeError('model badge: invalid tone')
            }
            return { text: localizedTextOf(value.text), tone }
          })()
          return {
            id: model.id,
            name: model.name,
            ...description === undefined ? {} : { description },
            ...reasoning === undefined ? {} : { reasoning },
            ...badge === undefined ? {} : { badge },
          }
        }),
      }
    }),
    failures: record.failures.map(failureValue => {
      const failure = recordOf(failureValue, 'model catalog failure')
      if (typeof failure.id !== 'string' || typeof failure.name !== 'string' || typeof failure.message !== 'string') {
        throw new TypeError('model catalog failure: invalid fields')
      }
      return { id: failure.id, name: failure.name, message: failure.message }
    }),
  }
}

function presetRosterOf(value: unknown): NativePresetRoster {
  const record = recordOf(value, 'preset roster')
  if (!Array.isArray(record.presets)) throw new TypeError('preset roster: invalid presets')
  return {
    presets: record.presets.map(value => {
      const preset = recordOf(value, 'preset row')
      if (typeof preset.id !== 'string') throw new TypeError('preset row: invalid id')
      const name = optionalString(preset, 'name')
      const description = optionalString(preset, 'description')
      const broken = optionalString(preset, 'broken')
      return {
        id: preset.id,
        ...typeof preset.isDefault === 'boolean' ? { isDefault: preset.isDefault } : {},
        ...name === undefined ? {} : { name },
        ...description === undefined ? {} : { description },
        ...broken === undefined ? {} : { broken },
      }
    }),
  }
}

function permissionOptionOf(value: unknown): { readonly value: string; readonly name: string; readonly description?: string } {
  const option = recordOf(value, 'permission option')
  if (typeof option.value !== 'string' || typeof option.name !== 'string') throw new TypeError('permission option: invalid identity')
  const description = optionalString(option, 'description')
  return { value: option.value, name: option.name, ...description === undefined ? {} : { description } }
}

function permissionCatalogOf(value: unknown): NativePermissionCatalog {
  const record = recordOf(value, 'permission catalog')
  if (!Array.isArray(record.options) || !Array.isArray(record.defaultOptions) || typeof record.defaultPreset !== 'string') {
    throw new TypeError('permission catalog: invalid fields')
  }
  return {
    options: record.options.map(permissionOptionOf),
    defaultOptions: record.defaultOptions.map(permissionOptionOf),
    defaultPreset: record.defaultPreset,
  }
}

function questionIntentOf(value: unknown): NativeQuestionIntent {
  const intent = recordOf(value, 'question intent')
  if (intent.kind === 'plan-review') {
    if (typeof intent.approve !== 'string') throw new TypeError('plan-review intent: approve is required')
    const callId = optionalString(intent, 'callId')
    return { kind: 'plan-review', approve: intent.approve, ...callId === undefined ? {} : { callId } }
  }
  if (intent.kind === 'approval') {
    if (typeof intent.approve !== 'string' || typeof intent.reject !== 'string') {
      throw new TypeError('approval intent: approve and reject are required')
    }
    const always = optionalString(intent, 'always')
    const subject = intent.subject === undefined ? undefined : (() => {
      const value = recordOf(intent.subject, 'approval subject')
      if (typeof value.name !== 'string') throw new TypeError('approval subject: name is required')
      const icon = optionalString(value, 'icon')
      return { name: value.name, ...icon === undefined ? {} : { icon } }
    })()
    const display = intent.display === undefined ? undefined : (() => {
      const value = recordOf(intent.display, 'approval display')
      const question = localizedTextOf(value.question)
      if (typeof question === 'string') throw new TypeError('approval display: question must be localized')
      const detail = value.detail === undefined ? undefined : localizedTextOf(value.detail)
      const approve = value.approve === undefined ? undefined : localizedTextOf(value.approve)
      if ((detail !== undefined && typeof detail === 'string') || (approve !== undefined && typeof approve === 'string')) {
        throw new TypeError('approval display: detail and approve must be localized')
      }
      return {
        question,
        ...detail === undefined ? {} : { detail },
        ...approve === undefined ? {} : { approve },
      }
    })()
    return {
      kind: 'approval',
      approve: intent.approve,
      reject: intent.reject,
      ...always === undefined ? {} : { always },
      ...subject === undefined ? {} : { subject },
      ...display === undefined ? {} : { display },
    }
  }
  throw new TypeError('question intent: unknown kind')
}

function questionItemOf(value: unknown): NativeQuestionItem {
  const item = recordOf(value, 'question item')
  if (typeof item.id !== 'string' || typeof item.question !== 'string') throw new TypeError('question item: invalid identity')
  const detail = optionalString(item, 'detail')
  const header = optionalString(item, 'header')
  const options = item.options === undefined ? undefined : (() => {
    if (!Array.isArray(item.options)) throw new TypeError('question item: invalid options')
    return item.options.map(optionValue => {
      const option = recordOf(optionValue, 'question option')
      if (typeof option.label !== 'string') throw new TypeError('question option: label is required')
      const description = optionalString(option, 'description')
      return { label: option.label, ...description === undefined ? {} : { description } }
    })
  })()
  if (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean') throw new TypeError('question item: invalid multiSelect')
  return {
    id: item.id,
    question: item.question,
    ...detail === undefined ? {} : { detail },
    ...header === undefined ? {} : { header },
    ...options === undefined ? {} : { options },
    ...item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect },
    ...item.intent === undefined ? {} : { intent: questionIntentOf(item.intent) },
  }
}

function questionItemsOf(value: readonly AskUserQuestionItem[]): readonly NativeQuestionItem[] {
  return value.map(questionItemOf)
}

function sessionEventOf(entry: SessionEventEntry | SessionEventLikeEntry): NativeSessionEventEntry {
  if (entry.type === 'transient') {
    return {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: entry.event.seq,
        time: entry.event.time,
        data: {
          attemptId: entry.event.data.attemptId,
          turn: entry.event.data.turn,
          step: entry.event.data.step,
          chunk: jsonValueOf(entry.event.data.chunk, 'assistant chunk'),
        },
      },
    }
  }
  const event = entry.event
  const type = event.type
  const seq = event.seq
  const time = event.time
  if (typeof type !== 'string' || typeof seq !== 'number' || typeof time !== 'number') {
    throw new TypeError('session event: invalid envelope')
  }
  const rawSurfaceOp = 'surfaceOp' in event ? event.surfaceOp : undefined
  const rawSourceEventSeqs = 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined
  const surfaceOp: NativeSessionEvent['surfaceOp'] = rawSurfaceOp === undefined || rawSurfaceOp === 'append'
    ? rawSurfaceOp
    : typeof rawSurfaceOp === 'object' && rawSurfaceOp !== null && !Array.isArray(rawSurfaceOp)
      && (rawSurfaceOp as Record<string, unknown>).op === 'replace'
      && typeof (rawSurfaceOp as Record<string, unknown>).startSeq === 'number'
      && typeof (rawSurfaceOp as Record<string, unknown>).endSeq === 'number'
      ? {
        op: 'replace',
        startSeq: (rawSurfaceOp as Record<string, unknown>).startSeq as number,
        endSeq: (rawSurfaceOp as Record<string, unknown>).endSeq as number,
      }
      : undefined
  if (rawSurfaceOp !== undefined && surfaceOp === undefined) throw new TypeError('session event: invalid surfaceOp')
  if (rawSourceEventSeqs !== undefined && (!Array.isArray(rawSourceEventSeqs)
    || !rawSourceEventSeqs.every((value: unknown) => typeof value === 'number'))) {
    throw new TypeError('session event: invalid sourceEventSeqs')
  }
  const sourceEventSeqs = rawSourceEventSeqs as readonly number[] | undefined
  return {
    type: 'event',
    event: {
      type,
      seq,
      time,
      data: jsonValueOf(event.data, `session event ${type}`),
      ...event.ignorable === true ? { ignorable: true as const } : {},
      ...surfaceOp === undefined ? {} : { surfaceOp },
      ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
    },
  }
}

function sessionChangeOf(change: SessionEventChange, entries: readonly SessionEventLikeEntry[]): NativeSessionChange {
  if (change.kind === 'settle-assistant') {
    return {
      kind: 'settle-assistant',
      attemptId: change.attemptId,
      ...change.entry === undefined ? {} : { entry: sessionEventOf(change.entry) },
    }
  }
  return { kind: change.kind, entries: change.entries.map(sessionEventOf) }
}

function historyPageOf(page: SessionEventsPage): NativeHistoryPage {
  return {
    cursor: page.cursor,
    records: page.records.map(sessionEventOf),
    hasMore: page.hasMore,
  }
}

function historyWindowOf(window: SessionEventWindow): NativeSessionHistoryWindow {
  const entries = window.entries.map(sessionEventOf)
  return {
    entries,
    hasMore: window.hasMore,
    revision: window.revision,
    change: sessionChangeOf(window.change, window.entries),
  }
}

function failureDtoOf(value: unknown): NativeFailure {
  const failure = recordOf(value, 'remote failure')
  if (typeof failure.code !== 'string' || typeof failure.message !== 'string') throw new TypeError('remote failure: invalid fields')
  return { code: failure.code, message: failure.message }
}

function planOf(value: unknown): NativePlanProjection {
  const plan = recordOf(value, 'plan projection')
  if (typeof plan.active !== 'boolean' || typeof plan.pending !== 'boolean') throw new TypeError('plan projection: invalid fields')
  return { active: plan.active, pending: plan.pending }
}

function tokenUsageOf(value: unknown): NativeTokenUsage {
  const usage = recordOf(value, 'token usage')
  const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  for (const key of keys) {
    if (typeof usage[key] !== 'number' || !Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) {
      throw new TypeError('token usage: invalid counters')
    }
  }
  return {
    uncachedInputTokens: usage.uncachedInputTokens as number,
    outputTokens: usage.outputTokens as number,
    cacheReadTokens: usage.cacheReadTokens as number,
    cacheWriteTokens: usage.cacheWriteTokens as number,
  }
}

function contextPressureOf(value: unknown): NativeContextPressure {
  const pressure = recordOf(value, 'context pressure')
  const output: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } = {}
  for (const key of ['pressureTokens', 'projectedTokens', 'contextWindow'] as const) {
    const value = pressure[key]
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('context pressure: invalid value')
      output[key] = value
    }
  }
  return output
}

function questionAnswerOf(value: unknown): NativeUserQuestionProjection['settled'][number]['answers'][number] {
  const answer = recordOf(value, 'question answer')
  if (typeof answer.id !== 'string' || !Array.isArray(answer.selected) || !answer.selected.every(item => typeof item === 'string')) {
    throw new TypeError('question answer: invalid fields')
  }
  const custom = optionalString(answer, 'custom')
  return { id: answer.id, selected: answer.selected as string[], ...custom === undefined ? {} : { custom } }
}

function officialQuestionAnswers(answer: NativeQuestionAnswer): { id: string; selected: string[]; custom?: string }[] {
  if (!Array.isArray(answer.answers)) throw new TypeError('question answer: answers must be an array')
  return answer.answers.map(item => {
    if (typeof item.id !== 'string' || !Array.isArray(item.selected)
      || !item.selected.every((selected: unknown) => typeof selected === 'string')
      || (item.custom !== undefined && typeof item.custom !== 'string')) {
      throw new TypeError('question answer: invalid answer item')
    }
    return { id: item.id, selected: [...item.selected], ...item.custom === undefined ? {} : { custom: item.custom } }
  })
}

function userQuestionsOf(value: unknown): NativeUserQuestionProjection {
  const projection = recordOf(value, 'user questions projection')
  if (!Array.isArray(projection.active) || !Array.isArray(projection.settled)) throw new TypeError('user questions projection: invalid arrays')
  return {
    active: projection.active.map(value => {
      const active = recordOf(value, 'pending question')
      if (typeof active.callId !== 'string' || !Array.isArray(active.questions)
        || (active.state !== 'open' && active.state !== 'continued')) {
        throw new TypeError('pending question: invalid fields')
      }
      return { callId: active.callId, questions: active.questions.map(questionItemOf), state: active.state }
    }),
    settled: projection.settled.map(value => {
      const settled = recordOf(value, 'settled question')
      if (typeof settled.callId !== 'string' || !Array.isArray(settled.answers)) throw new TypeError('settled question: invalid fields')
      return { callId: settled.callId, answers: settled.answers.map(questionAnswerOf) }
    }),
  }
}

function queuedQuestionReply(value: unknown, callId: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const source = (value as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return false
  const record = source as { readonly kind?: unknown; readonly callId?: unknown }
  return record.kind === 'user-question-reply' && record.callId === callId
}

function inboxOf(value: unknown): NativeSessionSnapshot['projections']['inbox'] {
  const inbox = recordOf(value, 'inbox projection')
  if (!Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw new TypeError('inbox projection: invalid arrays')
  return {
    'next-turn': inbox['next-turn'].map(value => jsonValueOf(value, 'inbox message')),
    'next-step': inbox['next-step'].map(value => jsonValueOf(value, 'inbox message')),
  }
}

function permissionSelectionOf(value: unknown): NativePermissionSelection {
  const selection = recordOf(value, 'permission selection')
  if (typeof selection.currentValue !== 'string') throw new TypeError('permission selection: invalid value')
  return { currentValue: selection.currentValue }
}

function policyReadOf(value: unknown): NativeSessionPolicyRead {
  const policy = recordOf(value, 'session policy')
  if (policy.kind === 'unavailable') {
    if (typeof policy.sessionId !== 'string' || policy.reason !== 'session-not-live') throw new TypeError('session policy: invalid unavailable result')
    return { kind: 'unavailable', sessionId: policy.sessionId, reason: 'session-not-live' }
  }
  if (policy.kind !== 'ready' || typeof policy.sessionId !== 'string') throw new TypeError('session policy: invalid result')
  const side = <T extends string>(value: unknown, allowed: readonly T[]): NativePolicySide<T> => {
    const record = recordOf(value, 'policy side')
    if (record.state === 'unavailable') {
      if (record.reason !== 'service-not-installed') throw new TypeError('policy side: invalid reason')
      return { state: 'unavailable', reason: 'service-not-installed' }
    }
    if (record.state !== 'ready' || !allowed.includes(record.effective as T)) throw new TypeError('policy side: invalid value')
    const override = record.override
    if (override !== undefined && !allowed.includes(override as T)) throw new TypeError('policy side: invalid override')
    return {
      state: 'ready',
      effective: record.effective as T,
      ...override === undefined ? {} : { override: override as T },
    }
  }
  return {
    kind: 'ready',
    sessionId: policy.sessionId,
    approval: side(policy.approval, ['ask', 'never'] as const),
    sandbox: side(policy.sandbox, ['read-only', 'workspace-write', 'danger-full-access'] as const),
  }
}

function configurationOf(values: Readonly<Record<string, unknown>>, policy?: NativeSessionPolicyRead): NativeSessionConfiguration {
  const modelSelection = values.modelSelection === undefined ? undefined : (() => {
    const value = recordOf(values.modelSelection, 'model selection projection')
    return { lastUsed: nullableModelSelectionOf(value.lastUsed), next: nullableModelSelectionOf(value.next) }
  })()
  const currentModel = modelSelection === undefined ? undefined : modelSelection.next ?? modelSelection.lastUsed
  return {
    ...modelSelection === undefined ? {} : { modelSelection },
    ...currentModel === undefined || currentModel === null ? {} : { currentModel },
    ...values.agentPreset === undefined ? {} : { agentPreset: nullableStringOf(values.agentPreset, 'agentPreset projection') },
    ...values.title === undefined ? {} : { title: nullableStringOf(values.title, 'title projection') },
    ...values.permissions === undefined ? {} : { permissions: permissionSelectionOf(values.permissions) },
    ...values.plan === undefined ? {} : { plan: planOf(values.plan) },
    ...policy === undefined ? {} : { policy },
  }
}

function commandDescriptorOf(value: CommandDescriptor): NativeCommandDescriptor {
  return {
    ...value.definitionId === undefined ? {} : { definitionId: value.definitionId },
    name: value.name,
    description: value.description,
    ...value.input === undefined ? {} : { input: {
      hint: value.input.hint,
      ...value.input.attachments === undefined ? {} : { attachments: value.input.attachments },
    } },
  }
}

function commandExecutionOf(value: CommandExecution): NativeCommandExecution {
  return {
    commandId: value.commandId,
    result: value.result.kind === 'success'
      ? {
        kind: 'success',
        ...value.result.text === undefined ? {} : { text: value.result.text },
        ...value.result.sourceEventSeq === undefined ? {} : { sourceEventSeq: value.result.sourceEventSeq },
      }
      : { kind: 'error', text: value.result.text },
  }
}

function jobOf(value: unknown): NativeJob {
  const job = recordOf(value, 'job row')
  if (typeof job.id !== 'string' || typeof job.kind !== 'string' || typeof job.label !== 'string'
    || typeof job.startedAt !== 'number'
    || (job.status !== 'running' && job.status !== 'stopping' && job.status !== 'completed'
      && job.status !== 'killed' && job.status !== 'failed')) {
    throw new TypeError('job row: invalid fields')
  }
  const progress = optionalString(job, 'progress')
  const detail = optionalString(job, 'detail')
  const finishedAt = job.finishedAt
  if (finishedAt !== undefined && typeof finishedAt !== 'number') throw new TypeError('job row: invalid finishedAt')
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...progress === undefined ? {} : { progress },
    ...detail === undefined ? {} : { detail },
    startedAt: job.startedAt,
    ...finishedAt === undefined ? {} : { finishedAt },
  }
}

function subagentSnapshotOf(value: unknown): NativeSubagentSnapshot {
  const snapshot = recordOf(value, 'subagent snapshot')
  if (typeof snapshot.parentSessionId !== 'string' || typeof snapshot.parentAvailable !== 'boolean'
    || !Array.isArray(snapshot.descendants)) {
    throw new TypeError('subagent snapshot: invalid fields')
  }
  return {
    parentSessionId: snapshot.parentSessionId,
    parentAvailable: snapshot.parentAvailable,
    descendants: snapshot.descendants.map(value => {
      const entry = recordOf(value, 'subagent entry')
      if (typeof entry.id !== 'string' || typeof entry.parentId !== 'string' || typeof entry.depth !== 'number') {
        throw new TypeError('subagent entry: invalid identity')
      }
      if (entry.kind === 'diagnostic') {
        if (entry.reason !== 'corrupt' && entry.reason !== 'unsupported' && entry.reason !== 'unavailable') {
          throw new TypeError('subagent diagnostic: invalid reason')
        }
        return { kind: 'diagnostic', id: entry.id, reason: entry.reason, parentId: entry.parentId, depth: entry.depth }
      }
      if (entry.kind !== 'child' || (entry.mode !== 'one-shot' && entry.mode !== 'continuable' && entry.mode !== 'external')
        || (entry.activity !== 'running' && entry.activity !== 'inactive') || typeof entry.hasChildren !== 'boolean') {
        throw new TypeError('subagent child: invalid fields')
      }
      const label = optionalString(entry, 'label')
      const path = optionalString(entry, 'path')
      return {
        kind: 'child',
        id: entry.id,
        ...label === undefined ? {} : { label },
        mode: entry.mode,
        activity: entry.activity,
        hasChildren: entry.hasChildren,
        parentId: entry.parentId,
        depth: entry.depth,
        ...path === undefined ? {} : { path },
      }
    }),
  }
}

function validateHistoryOptions(options: NativeHistoryOptions | undefined): void {
  if (options === undefined) return
  for (const key of ['beforeSeq', 'throughSeq', 'maxMessages'] as const) {
    const value = options[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'throughSeq' ? -1 : key === 'maxMessages' ? 1 : 0))) {
      throw nativeError('NATIVE_CLIENT_INVALID_INPUT', `${key} is invalid`)
    }
  }
  if (options.turnWindow !== undefined) {
    if (!Number.isSafeInteger(options.turnWindow.minMessages) || options.turnWindow.minMessages <= 0
      || !Number.isSafeInteger(options.turnWindow.minTurns) || options.turnWindow.minTurns <= 0
      || options.turnWindow.minMessages > (options.maxMessages ?? 50)) {
      throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'turnWindow is invalid')
    }
  }
}

function historyRequest(sessionId: string, options?: NativeHistoryOptions): SessionPageRequest {
  validateHistoryOptions(options)
  return {
    address: { kind: 'session', sessionId: sessionId as SessionId },
    ...options?.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq },
    ...options?.throughSeq === undefined ? {} : { throughSeq: options.throughSeq },
    ...options?.maxMessages === undefined ? {} : { maxMessages: options.maxMessages },
    ...options?.turnWindow === undefined ? {} : { turnWindow: options.turnWindow },
  }
}

async function readHistory(
  state: NativeClientState,
  sessionId: string,
  options: NativeHistoryOptions | undefined,
  signal?: AbortSignal,
): Promise<NativeReadResult<NativeHistoryPage>> {
  requireNonEmpty(sessionId, 'sessionId')
  const request = historyRequest(sessionId, options)
  if (state.closed) return closedResult()
  if (signal?.aborted) return notDispatchedResult('NATIVE_OPERATION_CANCELLED', 'The read was cancelled before dispatch.')
  const captured = currentGeneration(state)
  if (captured === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
  return await settleRead(
    () => state.remote.session.page(request, signal),
    captured,
    state.generation,
    historyPageOf,
  )
}

function sameImage(left: NativeImageAttachmentRef, right: NativeImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
}

function imageRefOf(value: unknown): NativeImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const ref = value as Record<string, unknown>
  if (typeof ref.attachmentId !== 'string' || typeof ref.bytes !== 'number'
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || typeof ref.width !== 'number' || !Number.isSafeInteger(ref.width) || ref.width < 0
    || typeof ref.height !== 'number' || !Number.isSafeInteger(ref.height) || ref.height < 0
    || (ref.mediaType !== 'image/png' && ref.mediaType !== 'image/jpeg'
      && ref.mediaType !== 'image/webp' && ref.mediaType !== 'image/gif')) {
    return undefined
  }
  const name = optionalString(ref, 'name')
  const original = ref.originalDimensions
  if (original !== undefined) {
    const dimensions = recordOf(original, 'original dimensions')
    if (typeof dimensions.width !== 'number' || typeof dimensions.height !== 'number') return undefined
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...name === undefined ? {} : { name },
      originalDimensions: { width: dimensions.width, height: dimensions.height },
    }
  }
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...name === undefined ? {} : { name },
  }
}

function contentHasImage(content: unknown, expected: NativeImageAttachmentRef): boolean {
  if (!Array.isArray(content)) return false
  return content.some(part => {
    if (typeof part !== 'object' || part === null) return false
    const record = part as Record<string, unknown>
    if (record.type !== 'image') return false
    const ref = imageRefOf(record.attachment)
    return ref !== undefined && sameImage(ref, expected)
  })
}

function eventHasImage(entry: NativeSessionEventEntry, expected: NativeImageAttachmentRef): boolean {
  if (entry.type !== 'event') return false
  const data = entry.event.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const record = data as Record<string, NativeJsonValue>
  if (contentHasImage(record.content, expected)) return true
  if (entry.event.type === 'agent/inbox/spliced' && Array.isArray(record.inserted)) {
    return record.inserted.some(message => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
      return contentHasImage((message as Record<string, NativeJsonValue>).content, expected)
    })
  }
  return false
}

class OwnedNativeSession implements NativeSession {
  private readonly lifetime = new AbortController()
  private readonly subscriptions = new Set<() => void>()
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false
  private closePromise: Promise<void> | undefined

  private readonly state: NativeClientState
  private readonly reference: SessionReference
  private readonly binding: SessionBinding

  constructor(
    state: NativeClientState,
    reference: SessionReference,
    binding: SessionBinding,
  ) {
    this.state = state
    this.reference = reference
    this.binding = binding
  }

  get sessionId(): string { return this.reference.sessionId }
  get isClosed(): boolean { return this.closed }
  matchesSession(session: unknown): boolean { return this.binding.session === session }
  bindingIdentity(): object { return this.binding }
  isCurrentBinding(): boolean { return this.state.sessions.binding(this.sessionId as SessionId) === this.binding }
  lifetimeSignal(): AbortSignal { return this.lifetime.signal }
  continuedCalls(): readonly { readonly callId: string; readonly questions: unknown; readonly state: 'open' | 'continued' }[] {
    return userQuestionsOf(this.projection('userQuestions')).active
  }

  observeOfficialQuestionFacts(listener: () => void): () => void {
    const questions = this.binding.session.projections.faceOf('userQuestions')
    const inbox = this.binding.session.projections.faceOf('inbox')
    const offQuestions = questions.subscribe(listener)
    const offInbox = inbox.subscribe(listener)
    return () => { offQuestions(); offInbox() }
  }

  continuedEligible(callId: string): boolean {
    if (this.closed || this.state.closed || currentGeneration(this.state) === undefined
      || !this.isCurrentBinding()) return false
    try {
      const questions = userQuestionsOf(this.projection('userQuestions'))
      if (questions.settled.some(entry => entry.callId === callId)
        || !questions.active.some(entry => entry.callId === callId && entry.state === 'continued')) return false
      const inbox = inboxOf(this.projection('inbox'))
      if (inbox === undefined) return false
      return ![...inbox['next-turn'], ...inbox['next-step']]
        .some(message => queuedQuestionReply(message, callId))
    } catch {
      return false
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    observeSettled(operation, () => { this.operations.delete(operation) })
    return operation
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
  }

  private admission(signal?: AbortSignal): { readonly signal: AbortSignal; readonly generation: Generation } | NativeFailureResult {
    if (this.closed || this.state.closed) return this.closed ? closedSessionResult() : closedResult()
    if (signal?.aborted) return notDispatchedResult('NATIVE_OPERATION_CANCELLED', 'The operation was cancelled before dispatch.')
    if (this.state.sessions.binding(this.sessionId as SessionId) !== this.binding) {
      return { kind: 'stale', code: 'NATIVE_BINDING_STALE', message: 'The owned Session binding is no longer current.' }
    }
    const generation = currentGeneration(this.state)
    if (generation === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
    return { signal: this.signal(signal), generation }
  }

  private projection(key: string): unknown {
    return this.binding.session.projections.faceOf(key).getSnapshot()
  }

  snapshot(): NativeReadResult<NativeSessionSnapshot> {
    const admission = this.admission()
    if ('kind' in admission) return admission
    try {
      const snapshot: SessionSnapshot = this.binding.session.getSnapshot()
      const projectionState = this.state.sessions.list.getSnapshot().projectionsBySession[this.sessionId as SessionId]?.state ?? 'idle'
      const values = projectionState === 'ready' ? {
        ...this.projection('title') === undefined ? {} : { title: nullableStringOf(this.projection('title'), 'title projection') },
        ...this.projection('plan') === undefined ? {} : { plan: planOf(this.projection('plan')) },
        ...this.projection('tokenUsage') === undefined ? {} : { tokenUsage: tokenUsageOf(this.projection('tokenUsage')) },
        ...this.projection('contextPressure') === undefined ? {} : { contextPressure: contextPressureOf(this.projection('contextPressure')) },
        ...this.projection('userQuestions') === undefined ? {} : { userQuestions: userQuestionsOf(this.projection('userQuestions')) },
        ...this.projection('inbox') === undefined ? {} : { inbox: inboxOf(this.projection('inbox')) },
      } : {}
      return {
        kind: 'ok',
        value: {
          sessionId: snapshot.sessionId,
          pendingSubmissions: snapshot.pendingSubmissions.map(submission => ({
            requestId: submission.requestId,
            placement: submission.placement,
            time: submission.time,
            text: submission.text,
            attachments: submission.attachments.map(attachment => attachment.type === 'file'
              ? { type: 'file', value: {
                attachmentId: attachment.value.attachmentId,
                name: attachment.value.name,
                bytes: attachment.value.bytes,
              } }
              : { type: 'image', value: {
                ...typeof attachment.value.previewUrl === 'string' && attachment.value.previewUrl !== ''
                  ? { previewUrl: attachment.value.previewUrl }
                  : {},
                ...attachment.value.name === undefined ? {} : { name: attachment.value.name },
                ...attachment.value.width === undefined ? {} : { width: attachment.value.width },
                ...attachment.value.height === undefined ? {} : { height: attachment.value.height },
              } }),
          })),
          running: snapshot.running,
          subagent: snapshot.subagent === null ? null : {
            parentSessionId: snapshot.subagent.address.parentSessionId,
            childSessionId: snapshot.subagent.address.childSessionId,
            mode: snapshot.subagent.address.mode,
          },
          removed: snapshot.removed,
          openState: snapshot.openState,
          openError: snapshot.openError === null ? null : failureDtoOf(snapshot.openError),
          hasMore: snapshot.hasMore,
          historyWasPartial: snapshot.historyWasPartial,
          loadingOlder: snapshot.loadingOlder,
          historyLoadStatus: snapshot.historyLoadStatus,
          promptError: snapshot.promptError === null ? null : {
            op: snapshot.promptError.op,
            error: failureDtoOf(snapshot.promptError.error),
          },
          blank: snapshot.blank,
          lastAgentError: snapshot.lastAgentError,
          promptAttempted: snapshot.promptAttempted,
          awaitingFirstTurn: snapshot.awaitingFirstTurn,
          projections: { state: projectionState, ...values },
        },
      }
    } catch {
      return unavailableResult('NATIVE_INVALID_RESPONSE', 'The official Session snapshot is unusable.')
    }
  }

  async history(options?: NativeHistoryOptions): Promise<NativeResult<NativeHistoryPage>> {
    const admission = this.admission()
    if ('kind' in admission) return admission
    return await this.track(readHistory(this.state, this.sessionId, options, admission.signal))
  }

  subscribe(listener: (result: NativeResult<NativeSessionView>) => void): () => void {
    if (this.closed || this.state.closed) {
      listener(this.closed ? closedSessionResult() : closedResult())
      return () => {}
    }
    let released = false
    let lastGeneration: Generation = currentGeneration(this.state)
    let lastRevision = -1
    const notify = (): void => {
      if (released || this.closed || this.state.closed) return
      if (this.state.sessions.binding(this.sessionId as SessionId) !== this.binding) {
        try { listener({ kind: 'stale', code: 'NATIVE_BINDING_STALE', message: 'The owned Session binding is no longer current.' }) }
        catch (error) { this.state.diag.error('native-client: Session listener failed', { error: safeErrorMessage(error) }) }
        release()
        return
      }
      const generation = currentGeneration(this.state)
      if (generation === undefined) {
        try { listener(staleResult()) } catch (error) { this.state.diag.error('native-client: Session listener failed', { error: safeErrorMessage(error) }) }
        return
      }
      let result: NativeResult<NativeSessionView>
      try {
        const window = this.binding.eventSource.getSnapshot()
        const entries = window.entries.map(sessionEventOf)
        const continuous = Object.is(generation, lastGeneration) && window.revision === lastRevision + 1
          && (window.change.kind === 'append' || window.change.kind === 'settle-assistant')
        const snapshot = this.snapshot()
        if (snapshot.kind !== 'ok') throw nativeError(snapshot.code, snapshot.message)
        result = {
          kind: 'ok',
          value: {
            sessionId: this.sessionId,
            snapshot: snapshot.value,
            window: {
              entries,
              hasMore: window.hasMore,
              revision: window.revision,
              change: continuous ? sessionChangeOf(window.change, window.entries) : { kind: 'replace', entries },
            },
            reconcileRequired: !continuous,
          },
        }
        lastGeneration = generation
        lastRevision = window.revision
      } catch {
        result = unavailableResult('NATIVE_INVALID_RESPONSE', 'The official Session window is unusable.')
      }
      try { listener(result) } catch (error) {
        this.state.diag.error('native-client: Session listener failed', { error: safeErrorMessage(error) })
        release()
        return
      }
      if (result.kind !== 'ok') release()
    }
    const release = (): void => {
      if (released) return
      released = true
      for (const off of this.subscriptions) {
        if (off === eventOff || off === generationOff) off()
      }
      this.subscriptions.delete(eventOff)
      this.subscriptions.delete(generationOff)
    }
    const eventOff = this.binding.eventSource.subscribe(notify)
    const generationOff = this.state.generation.subscribe(notify)
    this.subscriptions.add(eventOff)
    this.subscriptions.add(generationOff)
    notify()
    return release
  }

  async prompt(input: NativePromptInput): Promise<NativePromptResult> {
    if (!Array.isArray(input.content) || input.content.length === 0) {
      throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'prompt content must contain at least one part')
    }
    const mode = input.mode ?? 'queue'
    if (mode !== 'queue' && mode !== 'steer') throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'prompt mode is invalid')
    const admission = this.admission(input.signal)
    if ('kind' in admission) return asPromptFailure(admission)
    const signal = admission.signal
    return await this.track((async (): Promise<NativePromptResult> => {
      const content: Array<
        | { readonly type: 'text'; readonly text: string }
        | { readonly type: 'image'; readonly mediaType: NativeImageAttachmentRef['mediaType']; readonly data: string; readonly name?: string }
        | { readonly type: 'file'; readonly receiptId: FileUploadReceiptId }
      > = []
      const echoAttachments: Array<
        | {
          readonly type: 'image'
          readonly value: { readonly previewUrl: string; readonly name?: string }
        }
        | {
          readonly type: 'file'
          readonly value: {
            readonly attachmentId: ImageAttachmentRef['attachmentId']
            readonly name: string
            readonly bytes: number
          }
        }
      > = []
      let text = ''
      try {
        for (const part of input.content) {
          if (typeof part !== 'object' || part === null) {
            throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'prompt parts must be objects')
          }
          switch (part.type) {
            case 'text':
              if (typeof part.text !== 'string') throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'text prompt part must contain text')
              break
            case 'image':
              if (!(part.bytes instanceof Uint8Array)) throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'attachment bytes must be Uint8Array')
              if (part.mediaType !== 'image/png' && part.mediaType !== 'image/jpeg'
                && part.mediaType !== 'image/webp' && part.mediaType !== 'image/gif') {
                throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'image media type is invalid')
              }
              if (part.name !== undefined && typeof part.name !== 'string') {
                throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'image name must be a string')
              }
              break
            case 'file':
              if (!(part.bytes instanceof Uint8Array)) throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'attachment bytes must be Uint8Array')
              requireNonEmpty(part.name, 'file name')
              break
            default:
              throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'prompt part type is invalid')
          }
        }
        for (const part of input.content) {
          switch (part.type) {
            case 'text':
              text += part.text
              content.push({ type: 'text', text: part.text })
              break
            case 'image':
              content.push({
                type: 'image',
                mediaType: part.mediaType,
                data: Buffer.from(part.bytes.buffer, part.bytes.byteOffset, part.bytes.byteLength).toString('base64'),
                ...part.name === undefined ? {} : { name: part.name },
              })
              echoAttachments.push({ type: 'image', value: { previewUrl: '', ...part.name === undefined ? {} : { name: part.name } } })
              break
            case 'file': {
              const uploaded = await this.state.uploader.upload(this.sessionId, {
                name: part.name,
                byteLength: part.bytes.byteLength,
                source: {
                  kind: 'client-stream',
                  open: () => (async function* (): AsyncIterable<Uint8Array> { yield part.bytes })(),
                },
              }, signal)
              content.push({ type: 'file', receiptId: uploaded.receiptId as FileUploadReceiptId })
              echoAttachments.push({ type: 'file', value: {
                ...uploaded.file,
                attachmentId: uploaded.file.attachmentId as ImageAttachmentRef['attachmentId'],
              } })
              break
            }
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return asPromptFailure(unavailableResult(
            'NATIVE_PROMPT_STAGING_INTERRUPTED',
            'The prompt was not dispatched; attachment staging was interrupted after it began.',
          ))
        }
        return asPromptFailure(notDispatchedResult(
          remoteFailureCode(error) ?? 'NATIVE_PROMPT_STAGING_FAILED',
          'The prompt was not dispatched; attachment staging did not return a usable receipt.',
        ))
      }
      if (this.closed || this.state.closed) return asPromptFailure(this.closed ? closedSessionResult() : closedResult())
      if (!Object.is(admission.generation, currentGeneration(this.state))
        || this.state.sessions.binding(this.sessionId as SessionId) !== this.binding) {
        return asPromptFailure(staleResult())
      }
      let accepted = false
      const submission = this.binding.session.beginSubmission({
        mode,
        text,
        attachments: echoAttachments,
        onAccept: () => { accepted = true },
      })
      let dispatched = false
      try {
        dispatched = true
        const result = await this.binding.session.prompt(content, mode, signal, submission.requestId)
        if (accepted) return { kind: 'accepted', requestId: submission.requestId }
        if (!result.ok) return nativePromptWriteFailure(classifyRemoteWriteFailure(result.error), submission.requestId)
        return {
          kind: 'unknown',
          code: 'NATIVE_ACCEPTANCE_UNCONFIRMED',
          message: 'The prompt reply arrived without official acceptance evidence.',
          requestId: submission.requestId,
        }
      } catch (error) {
        if (accepted) return { kind: 'accepted', requestId: submission.requestId }
        if (!dispatched) return asPromptFailure(notDispatchedResult('NATIVE_PROMPT_NOT_DISPATCHED', 'The prompt was not dispatched.'))
        return {
          kind: 'unknown',
          ...failureOf(error, 'NATIVE_PROMPT_OUTCOME_UNKNOWN', 'The prompt outcome could not be determined.', false),
          requestId: submission.requestId,
        }
      } finally {
        if (!dispatched) submission.abandon()
      }
    })())
  }

  async cancel(): Promise<NativeResult<undefined>> {
    const admission = this.admission()
    if ('kind' in admission) return admission
    return await this.track(settleWrite(
      () => abortable(this.binding.session.cancel(), admission.signal),
      'accepted',
      () => undefined,
    ))
  }

  async updateQueue(itemId: string, action: NativeQueueAction): Promise<NativeResult<undefined>> {
    requireNonEmpty(itemId, 'itemId')
    if (action.kind === 'edit' && (action.content.length === 0
      || action.content.some(block => block.type !== 'text' || block.text.trim() === ''))) {
      throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'queue edits require non-empty text content')
    }
    const admission = this.admission()
    if ('kind' in admission) return admission
    return await this.track(settleWrite(
      () => abortable(this.binding.session.updateQueue(itemId as MessageId, action), admission.signal),
      'accepted',
      () => undefined,
    ))
  }

  async rename(title: string): Promise<NativeResult<{ readonly title: string; readonly seq: number }>> {
    requireNonEmpty(title, 'title')
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<{ readonly title: string; readonly seq: number }>> => {
      const result = await settleWrite(
        () => abortable(this.binding.session.rename(title), admission.signal),
        'committed',
        value => ({ title: value.title, seq: value.seq }),
      )
      if (result.kind !== 'committed') return result
      const current = this.projection('title')
      if (current !== result.value.title) {
        return unknownResult({ code: 'NATIVE_CONFIG_READBACK_MISMATCH', message: 'The official title readback did not match the accepted rename.' })
      }
      return result
    })()
    return await this.track(operation)
  }

  async configuration(): Promise<NativeResult<NativeSessionConfiguration>> {
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<NativeSessionConfiguration>> => {
      const projections = await settleRead(
        () => this.state.remote.session.projections({ sessionId: this.sessionId as SessionId }, admission.signal),
        admission.generation,
        this.state.generation,
        (value: SessionProjectionsValue) => {
          if (value === null) throw new Error('projections unavailable')
          if (value.kind === 'migration-required') throw new Error('projections migration required')
          return value.values
        },
      )
      if (projections.kind !== 'ok') return projections
      const namespace = (this.state.remote as unknown as { readonly piTuiSessionPolicy?: PiTuiSessionPolicyNamespace }).piTuiSessionPolicy
      try {
        if (namespace === undefined) return { kind: 'ok', value: configurationOf(projections.value) }
        const policy = await settleRead(
          () => namespace.read(this.sessionId, admission.signal),
          admission.generation,
          this.state.generation,
          policyReadOf,
        )
        if (policy.kind !== 'ok') return policy
        return { kind: 'ok', value: configurationOf(projections.value, policy.value) }
      } catch {
        return unavailableResult('NATIVE_INVALID_RESPONSE', 'The official Session configuration is unusable.')
      }
    })()
    return await this.track(operation)
  }

  async selectModel(input: NativeModelSelection): Promise<NativeResult<NativeModelSelection>> {
    requireNonEmpty(input.provider, 'provider')
    requireNonEmpty(input.model, 'model')
    if (input.reasoningEffort !== undefined) requireNonEmpty(input.reasoningEffort, 'reasoningEffort')
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<NativeModelSelection>> => {
      const selected = await settleWrite(
        () => abortable(this.state.remote.session.selectModel({
          sessionId: this.sessionId as SessionId,
          provider: input.provider,
          model: input.model,
          ...input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort },
        }), admission.signal),
        'committed',
        value => modelSelectionOf(value.selected),
        classifyRemoteModelFailure,
      )
      if (selected.kind !== 'committed') return selected
      const configuration = await this.configuration()
      if (configuration.kind !== 'ok') return unknownResult(
        { code: 'NATIVE_CONFIG_READBACK_FAILED', message: 'The official model selection committed but its Session readback is unavailable.' },
      )
      if (configuration.value.currentModel === undefined
        || configuration.value.currentModel.provider !== selected.value.provider
        || configuration.value.currentModel.model !== selected.value.model
        || configuration.value.currentModel.reasoningEffort !== selected.value.reasoningEffort) {
        return unknownResult({ code: 'NATIVE_CONFIG_READBACK_MISMATCH', message: 'The official model readback did not match the accepted selection.' })
      }
      return selected
    })()
    return await this.track(operation)
  }

  async selectPreset(presetId: string): Promise<NativeResult<string>> {
    requireNonEmpty(presetId, 'presetId')
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<string>> => {
      const selected = await settleWrite(
        () => abortable(this.state.remote.agentPresets.select(this.sessionId as SessionId, presetId), admission.signal),
        'committed',
        value => {
          if (typeof value !== 'string' || value === '') throw new TypeError('invalid preset result')
          return value
        },
        classifyRemotePresetFailure,
      )
      if (selected.kind !== 'committed') return selected
      const configuration = await this.configuration()
      if (configuration.kind !== 'ok') return unknownResult(
        { code: 'NATIVE_CONFIG_READBACK_FAILED', message: 'The official preset selection committed but its Session readback is unavailable.' },
      )
      if (configuration.value.agentPreset !== selected.value) {
        return unknownResult({ code: 'NATIVE_CONFIG_READBACK_MISMATCH', message: 'The official preset readback did not match the accepted selection.' })
      }
      return selected
    })()
    return await this.track(operation)
  }

  private async execute(line: string, signal: AbortSignal): Promise<NativeResult<NativeCommandExecution | { readonly matched: false }>> {
    let result: RemoteResult<CommandExecution | undefined>
    try {
      result = await this.state.remote.commands.execute(this.sessionId as SessionId, line, [], signal)
    } catch (error) {
      return unknownResult(failureOf(error, 'NATIVE_COMMAND_OUTCOME_UNKNOWN', 'The command outcome could not be determined.', false))
    }
    if (!result.ok) return nativeWriteFailure(classifyRemoteWriteFailure(result.error))
    if (result.value === undefined) return { kind: 'committed', value: { matched: false } }
    try {
      return { kind: 'committed', value: commandExecutionOf(result.value) }
    } catch {
      return unknownResult({ code: 'NATIVE_INVALID_RESPONSE', message: 'The official command returned an unusable execution.' })
    }
  }

  async command(line: string): Promise<NativeResult<NativeCommandExecution | { readonly matched: false }>> {
    requireNonEmpty(line, 'line')
    if (!line.startsWith('/')) throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'command line must start with a slash')
    const admission = this.admission()
    if ('kind' in admission) return admission
    return await this.track(this.execute(line, admission.signal))
  }

  async commands(): Promise<NativeResult<readonly NativeCommandDescriptor[]>> {
    const admission = this.admission()
    if ('kind' in admission) return admission
    return await this.track(settleRead(
      () => abortable(this.state.remote.commands.list(this.sessionId as SessionId), admission.signal),
      admission.generation,
      this.state.generation,
      value => value.map(commandDescriptorOf),
    ))
  }

  async selectPermissionPreset(presetId: string): Promise<NativeResult<NativePermissionSelection>> {
    requireNonEmpty(presetId, 'presetId')
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<NativePermissionSelection>> => {
      const catalog = await settleRead(
        () => abortable(this.state.remote.permissionPresets.catalog(), admission.signal),
        admission.generation,
        this.state.generation,
        permissionCatalogOf,
      )
      if (catalog.kind !== 'ok') return catalog
      if (!catalog.value.options.some(option => option.value === presetId)) {
        return rejectedResult({ code: 'NATIVE_PERMISSION_PRESET_UNKNOWN', message: 'The permission preset is not in the official catalog.' })
      }
      if (!Object.is(admission.generation, currentGeneration(this.state))) return notDispatchedResult('NATIVE_GENERATION_CHANGED', 'The Connection generation changed before command dispatch.')
      const execution = await this.execute(`/permission ${presetId}`, admission.signal)
      if (execution.kind !== 'committed') return execution as NativeResult<NativePermissionSelection>
      if ('matched' in execution.value) {
        return unsupportedResult('NATIVE_PERMISSION_COMMAND_UNAVAILABLE', 'The official permission command is not registered.')
      }
      if (execution.value.result.kind === 'error') {
        return rejectedResult({ code: 'NATIVE_PERMISSION_COMMAND_REJECTED', message: execution.value.result.text })
      }
      const configuration = await this.configuration()
      if (configuration.kind !== 'ok') return unknownResult(
        { code: 'NATIVE_CONFIG_READBACK_FAILED', message: 'The permission command settled but its Session readback is unavailable.' },
      )
      if (configuration.value.permissions === undefined) {
        return unknownResult({ code: 'NATIVE_CONFIG_READBACK_MISSING', message: 'The official permission projection is absent after the command.' })
      }
      return { kind: 'committed', value: configuration.value.permissions }
    })()
    return await this.track(operation)
  }

  async selectPlanMode(active: boolean): Promise<NativeResult<NativePlanProjection>> {
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<NativePlanProjection>> => {
      const execution = await this.execute(active ? '/plan' : '/plan off', admission.signal)
      if (execution.kind !== 'committed') return execution as NativeResult<NativePlanProjection>
      if ('matched' in execution.value) {
        return unsupportedResult('NATIVE_PLAN_COMMAND_UNAVAILABLE', 'The official plan command is not registered.')
      }
      if (execution.value.result.kind === 'error') {
        return rejectedResult({ code: 'NATIVE_PLAN_COMMAND_REJECTED', message: execution.value.result.text })
      }
      const configuration = await this.configuration()
      if (configuration.kind !== 'ok') return unknownResult(
        { code: 'NATIVE_CONFIG_READBACK_FAILED', message: 'The plan command settled but its Session readback is unavailable.' },
      )
      if (configuration.value.plan === undefined) {
        return unknownResult({ code: 'NATIVE_CONFIG_READBACK_MISSING', message: 'The official plan projection is absent after the command.' })
      }
      return { kind: 'committed', value: configuration.value.plan }
    })()
    return await this.track(operation)
  }

  async readFile(input: NativeFileReadInput): Promise<NativeResult<NativeFileBytes>> {
    requireNonEmpty(input.path, 'path')
    if (input.range !== undefined) {
      for (const value of [input.range.offset, input.range.length]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'file range is invalid')
        }
      }
    }
    const admission = this.admission()
    if ('kind' in admission) return admission
    const range = input.range === undefined ? undefined : {
      ...input.range.offset === undefined ? {} : { offset: input.range.offset },
      ...input.range.length === undefined ? {} : { length: input.range.length },
    }
    return await this.track(settleRead(
      () => this.state.remote.workspaceFiles.readBytes(this.sessionId as SessionId, input.path, {
        ...input.baseFile === undefined ? {} : { baseFile: input.baseFile },
        ...range === undefined ? {} : { range },
      }, admission.signal),
      admission.generation,
      this.state.generation,
      value => ({
        absolutePath: value.absolutePath,
        version: value.version,
        ...value.bytes === undefined ? {} : { bytes: value.bytes },
        offset: value.offset,
        data: value.data,
        eof: value.eof,
      }),
    ))
  }

  async readAttachment(attachment: NativeImageAttachmentRef): Promise<NativeResult<NativeStoredImage>> {
    if (attachment.attachmentId === '' || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0
      || !Number.isSafeInteger(attachment.width) || attachment.width < 0
      || !Number.isSafeInteger(attachment.height) || attachment.height < 0
      || (attachment.mediaType !== 'image/png' && attachment.mediaType !== 'image/jpeg'
        && attachment.mediaType !== 'image/webp' && attachment.mediaType !== 'image/gif')) {
      throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'attachment reference is invalid')
    }
    const officialAttachment: ImageAttachmentRef = {
      ...attachment,
      attachmentId: attachment.attachmentId as ImageAttachmentRef['attachmentId'],
    }
    const admission = this.admission()
    if ('kind' in admission) return admission
    const operation = (async (): Promise<NativeResult<NativeStoredImage>> => {
      let beforeSeq: number | undefined
      while (true) {
        const page = await readHistory(this.state, this.sessionId, { maxMessages: 50, ...beforeSeq === undefined ? {} : { beforeSeq } }, admission.signal)
        if (page.kind !== 'ok') return page
        if (page.value.records.some(entry => eventHasImage(entry, attachment))) break
        const first = page.value.records[0]
        if (!page.value.hasMore || first === undefined || first.type !== 'event' || first.event.seq === 0) {
          return rejectedResult({ code: 'NATIVE_ATTACHMENT_NOT_IN_SESSION', message: 'The image reference is not present in this Session canonical history.' })
        }
        const next = first.event.seq
        if (next === beforeSeq) return rejectedResult({ code: 'NATIVE_ATTACHMENT_HISTORY_STALLED', message: 'The canonical history did not advance.' })
        beforeSeq = next
      }
      const result = await settleRead(
        () => abortable(this.binding.session.readAttachment(officialAttachment), admission.signal),
        admission.generation,
        this.state.generation,
        value => {
          const ref = imageRefOf(value.attachment)
          if (ref === undefined || !sameImage(ref, attachment)) throw new TypeError('attachment readback mismatch')
          return { attachment: ref, data: value.data }
        },
      )
      return result
    })()
    return await this.track(operation)
  }

  observeJobs(listener: (result: NativeResult<readonly NativeJob[]>) => void): () => void {
    if (this.closed || this.state.closed) {
      listener(this.closed ? closedSessionResult() : closedResult())
      return () => {}
    }
    const carrierError = this.state.carrierError
    if (carrierError === undefined) {
      listener(unavailableResult('NATIVE_JOBS_UNAVAILABLE', 'The official Job stream authority is unavailable.'))
      return () => {}
    }
    let released = false
    let openedGeneration: Generation
    let release: () => void
    const publish = (result: NativeResult<readonly NativeJob[]>): void => {
      if (released || this.closed || this.state.closed) return
      try {
        listener(result)
      } catch (error) {
        this.state.diag.error('native-client: Job listener failed', { error: safeErrorMessage(error) })
        release()
      }
    }
    const stream = this.state.remote.$stream<JobListFrame>({
      name: 'native-client: Job roster observation',
      open: signal => {
        openedGeneration = currentGeneration(this.state)
        if (openedGeneration === undefined) {
          throw new carrierError('native-client: the Job roster open is waiting for an authenticated generation')
        }
        if (this.state.sessions.binding(this.sessionId as SessionId) !== this.binding) {
          throw nativeError('NATIVE_BINDING_STALE', 'The owned Session binding is not current for a Job roster open.')
        }
        return this.state.remote.job.list({ sessionId: this.sessionId as SessionId }, signal)
      },
      ended: accepted => accepted
        ? new carrierError('native-client: the Job roster stream ended after an accepted frame')
        : new Error('native-client: the Job roster stream ended before its opening frame'),
      carrierFailed: () => { publish(staleResult()) },
    })
    const offGeneration = this.state.generation.subscribe(() => {
      publish(staleResult())
    })
    release = (): void => {
      if (released) return
      released = true
      offGeneration()
      this.subscriptions.delete(release)
      const disposal = stream.dispose()
      this.operations.add(disposal)
      observeSettled(disposal, () => { this.operations.delete(disposal) })
      runDetached('native-client: Job roster dispose', () => disposal, {
        diag: this.state.diag,
        sessionId: () => this.sessionId,
      })
    }
    this.subscriptions.add(release)
    runDetached('native-client: Job roster observation', async () => {
      try {
        for await (const item of stream) {
          if (released || this.closed || this.state.closed) return
          const current = currentGeneration(this.state)
          if (this.state.sessions.binding(this.sessionId as SessionId) !== this.binding) {
            publish(staleResult())
            release()
            return
          }
          if (current === undefined || item.signal.aborted) {
            publish(staleResult())
            continue
          }
          if (!Object.is(openedGeneration, current)) {
            publish(staleResult())
            stream.restart()
            continue
          }
          if (item.value.type !== 'rows') continue
          let value: readonly NativeJob[]
          try {
            value = item.value.jobs.map(jobOf)
          } catch {
            publish(unavailableResult('NATIVE_INVALID_RESPONSE', 'The official Job roster row is unusable.'))
            release()
            return
          }
          item.accept()
          publish({ kind: 'ok', value })
        }
      } catch (error) {
        publish(unavailableResult(remoteFailureCode(error) ?? 'NATIVE_JOBS_UNAVAILABLE', 'The official Job roster stream is unavailable.'))
      } finally {
        release()
      }
    }, {
      diag: this.state.diag,
      sessionId: () => this.sessionId,
    })
    return release
  }

  observeSubagents(listener: (result: NativeResult<NativeSubagentSnapshot>) => void): () => void {
    if (this.closed || this.state.closed) {
      listener(this.closed ? closedSessionResult() : closedResult())
      return () => {}
    }
    const jobs = this.state.jobs
    if (jobs === undefined) {
      listener(unsupportedResult('NATIVE_SUBAGENTS_UNAVAILABLE', 'The official Jobs service required by subagent observation is unavailable.'))
      return () => {}
    }
    const reader = new RemoteTaskReader(this.state.sessions, jobs, this.state.generation)
    let released = false
    let reading = false
    let again = false
    const release = (): void => {
      if (released) return
      released = true
      offList()
      offJobs()
      offGeneration()
      reader.dispose()
      this.subscriptions.delete(offList)
      this.subscriptions.delete(offJobs)
      this.subscriptions.delete(offGeneration)
      this.subscriptions.delete(release)
    }
    const read = (): void => {
      if (released || this.closed || this.state.closed) return
      if (reading) {
        again = true
        return
      }
      reading = true
      const operation = reader.readDescendants(this.sessionId, this.lifetime.signal).then(
        value => {
          reading = false
          if (released || this.closed || this.state.closed) return
          let result: NativeResult<NativeSubagentSnapshot>
          if (value === undefined) {
            result = staleResult()
          } else {
            try {
              result = { kind: 'ok', value: subagentSnapshotOf(value) }
            } catch {
              result = unavailableResult('NATIVE_INVALID_RESPONSE', 'The official subagent snapshot is unusable.')
            }
          }
          try { listener(result) } catch (error) {
            this.state.diag.error('native-client: Subagent listener failed', { error: safeErrorMessage(error) })
            release()
            return
          }
          if (again && !released) {
            again = false
            read()
          }
        },
        error => {
          reading = false
          if (!released && !this.closed && !this.state.closed) {
            try {
              listener(unavailableResult(remoteFailureCode(error) ?? 'NATIVE_SUBAGENTS_UNAVAILABLE', 'The official subagent catalog is unavailable.'))
            } catch (listenerError) {
              this.state.diag.error('native-client: Subagent listener failed', { error: safeErrorMessage(listenerError) })
              release()
              return
            }
          }
          if (again && !released) {
            again = false
            read()
          }
        },
      )
      this.operations.add(operation)
      observeSettled(operation, () => { this.operations.delete(operation) })
    }
    const offList = this.state.sessions.list.subscribe(read)
    const offJobs = jobs.state.subscribe(read)
    const offGeneration = this.state.generation.subscribe(read)
    this.subscriptions.add(release)
    read()
    return release
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    let settle!: () => void
    let fail!: (error: unknown) => void
    this.closePromise = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    runOwned('native-client: Session close', async () => {
      this.closed = true
      this.lifetime.abort(new Error('native-client: Session closed'))
      const errors: unknown[] = []
      for (const release of [...this.subscriptions]) {
        try { release() } catch (error) { errors.push(error) }
      }
      this.subscriptions.clear()
      await Promise.allSettled([...this.operations])
      try { this.reference.release() } catch (error) { errors.push(error) }
      this.state.handles.delete(this)
      const siblings = this.state.handlesBySession.get(this.sessionId)
      siblings?.delete(this)
      if (siblings?.size === 0) this.state.handlesBySession.delete(this.sessionId)
      this.state.notifyHandles()
      if (errors.length > 0) {
        const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
        for (const error of errors.slice(1)) mergeCause(primary, error)
        throw primary
      }
    }, {
      diag: this.state.diag,
      sessionId: () => this.sessionId,
      onResult: () => settle(),
      onError: error => fail(error),
    })
    return this.closePromise
  }
}

function createNativeInteractionReceivers(
  state: NativeClientState,
  options: NativeAttachOptions,
): NativeInteractionReceivers {
  let disposed = false
  let pending = 0
  let identityGaps = 0
  const owned: Array<() => void> = []
  const changed = (): void => { if (!disposed) state.notifyStatus() }
  const liveQuestionCalls = new Set<string>()
  const currentBindingHandle = (sessionId: string, binding: object): OwnedNativeSession | undefined =>
    [...(state.handlesBySession.get(sessionId) ?? [])]
      .find(handle => !handle.isClosed && handle.bindingIdentity() === binding && handle.isCurrentBinding())

  const continuedFencesValid = (reservation: NativeContinuedDeliveryReservation): boolean => {
    if (disposed || state.closed || reservation.controller.signal.aborted
      || !Object.is(reservation.generation, currentGeneration(state))) return false
    const handle = currentBindingHandle(reservation.sessionId, reservation.binding)
    return handle !== undefined && handle.continuedEligible(reservation.callId)
  }

  const deliverContinued = async (
    reservation: NativeContinuedDeliveryReservation,
    callId: string,
    questions: unknown,
    onQuestion: NonNullable<NativeAttachOptions['onQuestion']>,
  ): Promise<void> => {
    if (!continuedFencesValid(reservation)) {
      throw nativeError('NATIVE_INTERACTION_STALE', 'the continued Question answer is no longer current')
    }
    const lifetime = AbortSignal.any([reservation.controller.signal, state.lifetime.signal])
    const answer = await abortable(onQuestion({
      sessionId: reservation.sessionId,
      callId,
      timed: true,
      questions: questions as readonly NativeQuestionItem[],
      signal: lifetime,
    }), lifetime)
    if (!continuedFencesValid(reservation) || lifetime.aborted) {
      throw nativeError('NATIVE_INTERACTION_STALE', 'the continued Question answer is no longer current')
    }
    const result = await state.remote.userQuestions.answer(reservation.sessionId as SessionId, callId as ToolCallId, {
      answers: officialQuestionAnswers(answer),
    })
    if (!result.ok) {
      throw nativeError(remoteFailureCode(result.error) ?? 'NATIVE_QUESTION_ANSWER_FAILED', 'The continued Question answer was not accepted.')
    }
    if (result.value !== true) {
      throw nativeError('NATIVE_QUESTION_NOT_CONTINUED', 'The continued Question was no longer answerable.')
    }
  }

  let continued: NativeContinuedQuestionReceiver | undefined
  if (options.onQuestion !== undefined) {
    const onQuestion = options.onQuestion
    continued = createNativeContinuedQuestionReceiver({
      generation: state.generation,
      handles: state.handles,
      handlesBySession: state.handlesBySession,
      handleListeners: state.handleListeners,
      isClosed: () => state.closed,
      onInvalidProjection: error => {
        state.diag.error('native-client: continued Question projection was unusable', { error: safeErrorMessage(error) })
      },
      onOffer: (reservation, callId, questions) => {
        if (liveQuestionCalls.has(callId) || !continuedFencesValid(reservation)) return false
        // Own the one operation before notify. deliverContinued re-proves the
        // fences before the external callback, so reentrant close cannot start it.
        const operation = Promise.resolve()
          .then(() => deliverContinued(reservation, callId, questions, onQuestion))
          .finally(() => {
            pending -= 1
            changed()
          })
        trackClientOperation(state, operation)
        pending += 1
        changed()
        runDetached('native-client: continued Question delivery', () => operation, {
          diag: state.diag,
          sessionId: () => reservation.sessionId,
        })
        return true
      },
    })
    owned.push(() => continued?.dispose())
  }

  const waitForHandle = async (
    sessionId: string,
    session: unknown,
    signal: AbortSignal | undefined,
    captured: Generation,
  ): Promise<OwnedNativeSession> => {
    const find = (): OwnedNativeSession | undefined => [...(state.handlesBySession.get(sessionId) ?? [])]
      .find(handle => !handle.isClosed && handle.matchesSession(session))
    const current = find()
    if (current !== undefined && Object.is(captured, currentGeneration(state))) return current
    return await new Promise<OwnedNativeSession>((resolve, reject) => {
      let settled = false
      let offGeneration: (() => void) | undefined
      const cleanup = (): void => {
        state.handleListeners.delete(check)
        offGeneration?.()
        signal?.removeEventListener('abort', abort)
      }
      const settle = (handle: OwnedNativeSession | undefined): void => {
        if (settled) return
        if (state.closed || disposed) {
          settled = true
          cleanup()
          reject(nativeError('NATIVE_INTERACTION_CLOSED', 'the Native Client closed before the interaction could be attributed'))
        } else if (handle !== undefined && Object.is(captured, currentGeneration(state))) {
          settled = true
          cleanup()
          resolve(handle)
        } else if (!Object.is(captured, currentGeneration(state))) {
          settled = true
          cleanup()
          reject(nativeError('NATIVE_INTERACTION_GENERATION_STALE', 'the interaction generation was replaced'))
        }
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(signal?.reason ?? new Error('native-client: interaction aborted'))
      }
      const check = (): void => settle(find())
      state.handleListeners.add(check)
      offGeneration = state.generation.subscribe(check)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      check()
    })
  }

  owned.push(state.remote.$on('user-questions/request', async function (this: Context, request, next) {
    const sessionId = state.sessions.scopeOf(this)
    const planIntent = Array.isArray(request.questions)
      ? request.questions.find(question => question.intent?.kind === 'plan-review')?.intent
      : undefined
    const planCallId = planIntent?.kind === 'plan-review' ? planIntent.callId : undefined
    const callId = request.wait?.callId ?? planCallId
    if (sessionId === undefined || typeof callId !== 'string' || options.onQuestion === undefined) {
      if (sessionId === undefined || typeof callId !== 'string') identityGaps += 1
      changed()
      return await next()
    }
    const captured = currentGeneration(state)
    const session = state.sessions.sessionOf(this)
    if (session === undefined) {
      identityGaps += 1
      changed()
      return await next()
    }
    liveQuestionCalls.add(callId)
    pending += 1
    changed()
    try {
      const handle = await waitForHandle(sessionId, session, request.signal, captured)
      const lifetime = request.signal === undefined ? handle.lifetimeSignal() : AbortSignal.any([request.signal, handle.lifetimeSignal()])
      if (disposed || state.closed || handle.isClosed || lifetime.aborted
        || !Object.is(captured, currentGeneration(state))
        || !handle.matchesSession(state.sessions.sessionOf(this))) {
        throw nativeError('NATIVE_INTERACTION_STALE', 'the interaction answer is no longer current')
      }
      const answer = await abortable(options.onQuestion({
        sessionId,
        callId,
        timed: request.wait?.timed === true,
        questions: questionItemsOf(request.questions),
        signal: lifetime,
      }), lifetime)
      if (disposed || state.closed || handle.isClosed || lifetime.aborted
        || !Object.is(captured, currentGeneration(state))
        || !handle.matchesSession(state.sessions.sessionOf(this))) {
        throw nativeError('NATIVE_INTERACTION_STALE', 'the interaction answer is no longer current')
      }
      return { answers: officialQuestionAnswers(answer) }
    } finally {
      liveQuestionCalls.delete(callId)
      pending -= 1
      changed()
      continued?.reconcile()
    }
  }))

  owned.push(state.remote.$on('approval/request', async function (this: Context, request, next) {
    const sessionId = state.sessions.scopeOf(this)
    const callId = request.callId
    if (sessionId === undefined || typeof callId !== 'string' || options.onApproval === undefined) {
      if (sessionId === undefined || typeof callId !== 'string') identityGaps += 1
      changed()
      return await next()
    }
    const captured = currentGeneration(state)
    const session = state.sessions.sessionOf(this)
    if (session === undefined) {
      identityGaps += 1
      changed()
      return await next()
    }
    pending += 1
    changed()
    try {
      const handle = await waitForHandle(sessionId, session, request.signal, captured)
      const lifetime = request.signal === undefined ? handle.lifetimeSignal() : AbortSignal.any([request.signal, handle.lifetimeSignal()])
      if (disposed || state.closed || handle.isClosed || lifetime.aborted
        || !Object.is(captured, currentGeneration(state))
        || !handle.matchesSession(state.sessions.sessionOf(this))) {
        throw nativeError('NATIVE_INTERACTION_STALE', 'the approval answer is no longer current')
      }
      const outcome = await abortable(options.onApproval({
        sessionId,
        callId,
        toolName: request.toolName,
        ...request.reason === undefined ? {} : { reason: request.reason },
        ...request.displayReason === undefined ? {} : { displayReason: request.displayReason },
        signal: lifetime,
      }), lifetime)
      if (disposed || state.closed || handle.isClosed || lifetime.aborted
        || !Object.is(captured, currentGeneration(state))
        || !handle.matchesSession(state.sessions.sessionOf(this))) {
        throw nativeError('NATIVE_INTERACTION_STALE', 'the approval answer is no longer current')
      }
      if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled' && outcome !== 'unavailable') {
        throw new TypeError('approval answer: invalid outcome')
      }
      return outcome
    } finally {
      pending -= 1
      changed()
    }
  }))

  return {
    get pendingCount(): number { return pending },
    get identityGaps(): number { return identityGaps },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const off of owned.splice(0)) off()
      changed()
    },
  }
}

export async function attachNativeClient(options: NativeAttachOptions): Promise<NativeClient> {
  options.signal?.throwIfAborted()
  validateNodeAndPlatform()
  const dshAnchor = validateDshAnchor(options.dshAnchor)
  const packageRoot = realpathSync(installedPackageRootFromEntry(import.meta.url))
  const profile = requireNonEmpty(options.profile, 'profile')
  validateProfileName(profile)
  if (options.expectedScopeId !== undefined) requireNonEmpty(options.expectedScopeId, 'expectedScopeId')
  if (options.expectedInstanceId !== undefined) requireNonEmpty(options.expectedInstanceId, 'expectedInstanceId')
  options.signal?.throwIfAborted()

  const releaseRealm = reserveNativeClientRealm()
  let cleanupStarted = false
  let cleanupPromise: Promise<void> | undefined
  let context: Context | undefined
  let diag: Diag | undefined
  let loaderFiber: Fiber | undefined
  let installedTransport: InstalledLocalClientTransport | undefined
  let prerequisites: MountedRemoteClientDomainPrerequisites | undefined
  let mountedDomains: MountedRemoteClientDomains | undefined
  let interactions: NativeInteractionReceivers | undefined
  let gate: StartupGate | undefined
  let state: NativeClientState | undefined

  const cleanup = (reason: Error): Promise<void> => {
    if (cleanupStarted) return cleanupPromise ?? Promise.resolve()
    cleanupStarted = true
    cleanupPromise = completeNativeClientRealm(releaseRealm, async () => {
      const errors: unknown[] = []
      if (state !== undefined) {
        state.closed = true
        state.lifetime.abort(new Error('native-client: closed'))
        state.notifyStatus()
        state.notifyHandles()
        await Promise.allSettled([...state.operations])
        for (const handle of [...state.handles]) {
          try { await handle.close() } catch (error) { errors.push(error) }
        }
      }
      for (const release of state?.statusSubscriptions ?? []) {
        try { release() } catch (error) { errors.push(error) }
      }
      try { interactions?.dispose() } catch (error) { errors.push(error) }
      try { await installedTransport?.dispose() } catch (error) { errors.push(error) }
      if (installedTransport !== undefined && state !== undefined) {
        try { state.terminalStatus = installedTransport.status() } catch (error) { errors.push(error) }
      }
      try { await prerequisites?.dispose() } catch (error) { errors.push(error) }
      try { await mountedDomains?.dispose() } catch (error) { errors.push(error) }
      gate?.cancel(reason)
      try { await loaderFiber?.dispose() } catch (error) { errors.push(error) }
      try { await context?.fiber.dispose() } catch (error) { errors.push(error) }
      diag?.dispose()
      if (errors.length > 0) {
        if (state !== undefined) state.closeFailed = true
        for (const error of errors) mergeCause(reason, error)
        ;(reason as Error & { cleanupFailed?: boolean }).cleanupFailed = true
        throw reason
      }
    })
    return cleanupPromise
  }

  try {
    const hostModules = await loadOfficialClientHost(dshAnchor)
    options.signal?.throwIfAborted()
    const dshHome = hostModules.resolveDshHome()
    const profileDir = hostModules.resolveProfileDir(profile, dshHome)
    try {
      hostModules.readProfileManifest('native-client', profileDir)
    } catch {
      throw nativeError('NATIVE_CLIENT_PROFILE_NOT_INITIALIZED', 'the official profile is not initialized')
    }
    const scope = inspectInstalledProfileScope({
      dshHome,
      profileDir,
      packageRoot,
      dshVersion: readInstalledDshVersion(dshAnchor),
    })
    if (options.expectedScopeId !== undefined && scope.scopeId !== options.expectedScopeId) {
      throw nativeError('NATIVE_CLIENT_SCOPE_MISMATCH', 'the resolved profile scope does not match expectedScopeId')
    }
    const record = readLocalRecord(scope)
    if (record === undefined) throw nativeError('NATIVE_CLIENT_HOST_UNAVAILABLE', 'the target Host is not running')
    if (inspectHostProcess(record) !== 'alive') throw nativeError('NATIVE_CLIENT_HOST_STALE', 'the target Host process is not alive')
    if (options.expectedInstanceId !== undefined && record.instanceId !== options.expectedInstanceId) {
      throw nativeError('NATIVE_CLIENT_INSTANCE_MISMATCH', 'the target Host instance does not match expectedInstanceId')
    }
    assertClientHostCompatible(record, scope)
    const host = await authenticateLocalHost(record, scope, options.signal)
    assertRecordedHostKernelIdentityCurrent(host.identity)
    options.signal?.throwIfAborted()

    const loadedProfile = hostModules.loadProfileDirectory('native-client', profileDir, dshAnchor)
    options.signal?.throwIfAborted()
    const resolution = await hostModules.createRuntimeResolution({ installAnchor: dshAnchor, profile: loadedProfile })
    options.signal?.throwIfAborted()
    context = new hostModules.Context()
    diag = createDiag({ stderrLevel: 'off' })
    const nativeDiag = diag
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
    const loader = context.get('loader') as OfficialLoader | undefined
    if (loader === undefined) throw new Error('native-client: official Loader did not install')
    gate = createStartupGate()
    loader.builtins['pi-tui-interaction-startup-gate'] = gate.plugin
    await loader.create({ name: 'cordis:pi-tui-interaction-startup-gate' })
    options.signal?.throwIfAborted()
    if (!gate.pending) throw new Error('native-client: interaction startup gate failed before transport install')
    const localTransport = await import('./local-transport.ts')
    options.signal?.throwIfAborted()
    installedTransport = await localTransport.installLocalTransport(context, {
      dshAnchor,
      host,
      scope,
      diag,
      signal: options.signal,
      onFatal: error => {
        if (state !== undefined) {
          state.fatalError = error
          state.notifyStatus()
        }
      },
    })
    options.signal?.throwIfAborted()
    prerequisites = await mountRemoteClientDomainPrerequisites({ context, dshAnchor })
    options.signal?.throwIfAborted()
    const nativeTransport = installedTransport
    const generationSource: RemoteConnectionGenerationSource = {
      getSnapshot: () => nativeTransport.connection.generation.getSnapshot(),
      subscribe: listener => nativeTransport.connection.generation.subscribe(listener),
    }
    const identity = projectIdentity(host.identity)
    const handles = new Set<OwnedNativeSession>()
    const handlesBySession = new Map<string, Set<OwnedNativeSession>>()
    const handleListeners = new Set<() => void>()
    const statusListeners = new Set<(result: NativeResult<NativeClientStatus>) => void>()
    const statusSubscriptions: Array<() => void> = []
    const notifyHandles = (): void => { for (const listener of [...handleListeners]) listener() }
    const status = (): NativeResult<NativeClientStatus> => {
      if (state?.closed === true) {
        if (state.closeFailed || state.terminalStatus === undefined) return closedResult()
        const current = state.terminalStatus
        return {
          kind: 'ok',
          value: {
            transport: 'closed',
            activeWrappers: current.activeWrappers,
            liveSockets: current.liveSockets,
            pendingInteractions: 0,
            interactionIdentityGaps: interactions?.identityGaps ?? 0,
            identity,
          },
        }
      }
      if (state?.fatalError !== undefined) {
        return unavailableResult('NATIVE_CLIENT_FATAL', 'The authenticated Native Client transport failed.')
      }
      const current = nativeTransport.status()
      return {
        kind: 'ok',
        value: {
          transport: current.transport,
          ...current.generationId === undefined ? {} : { generationId: current.generationId },
          activeWrappers: current.activeWrappers,
          liveSockets: current.liveSockets,
          pendingInteractions: interactions?.pendingCount ?? 0,
          interactionIdentityGaps: interactions?.identityGaps ?? 0,
          identity,
        },
      }
    }
    const notifyStatus = (): void => {
      const result = status()
      for (const listener of [...statusListeners]) {
        try { listener(result) } catch (error) { nativeDiag.error('native-client: status listener failed', { error: safeErrorMessage(error) }) }
      }
    }
    const activeState: NativeClientState = {
      sessions: prerequisites.sessions,
      remote: prerequisites.remote,
      jobs: undefined,
      transport: nativeTransport,
      uploader: createRemoteFileReceiptUploader(nativeTransport.authenticatedFetch),
      generation: generationSource,
      identity,
      diag: nativeDiag,
      handles,
      handlesBySession,
      handleListeners,
      statusListeners,
      statusSubscriptions,
      lifetime: new AbortController(),
      operations: new Set(),
      closed: false,
      closeFailed: false,
      fatalError: undefined,
      notifyStatus,
      notifyHandles,
    }
    state = activeState
    interactions = createNativeInteractionReceivers(activeState, options)
    const typert = context.get('typert') as unknown as { readonly contexts?: { getClient(id: string): unknown } } | undefined
    const agentResolver = typert?.contexts?.getClient('agent')
    if (!gate.pending || agentResolver === undefined) {
      throw new Error('native-client: Session Agent resolver was not ready before interaction gate release')
    }
    statusSubscriptions.push((nativeTransport.connection.state as unknown as { subscribe(listener: () => void): () => void }).subscribe(notifyStatus))
    statusSubscriptions.push(nativeTransport.connection.generation.subscribe(notifyStatus))
    gate.release()
    await localTransport.awaitLocalTransportReady(nativeTransport, { signal: options.signal })
    mountedDomains = await prerequisites.complete({ signal: options.signal })
    prerequisites = undefined
    activeState.jobs = mountedDomains.jobs
    activeState.carrierError = mountedDomains.workspaceStream.carrierError
    options.signal?.throwIfAborted()
    const client: NativeClient = {
      status,
      subscribeStatus: listener => {
        if (activeState.closed) {
          try { listener(status()) } catch (error) { nativeDiag.error('native-client: status listener failed', { error: safeErrorMessage(error) }) }
          return () => {}
        }
        statusListeners.add(listener)
        try { listener(status()) } catch (error) { nativeDiag.error('native-client: status listener failed', { error: safeErrorMessage(error) }) }
        let active = true
        return () => {
          if (!active) return
          active = false
          statusListeners.delete(listener)
        }
      },
      listSessions: () => trackClientOperation(activeState, (async () => {
        if (activeState.closed) return closedResult()
        const captured = currentGeneration(activeState)
        if (captured === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
        try {
          await abortable(activeState.sessions.refresh(), activeState.lifetime.signal)
          if (!Object.is(captured, currentGeneration(activeState))) return staleResult()
          const list = activeState.sessions.list.getSnapshot()
          if (list.phase !== 'ready') return unavailableResult('NATIVE_SESSION_LIST_UNAVAILABLE', 'The official Session list is not ready.')
          return {
            kind: 'ok',
            value: list.ids.map(id => {
              const row = list.byId[id]
              if (row === undefined) throw new TypeError('Session list row is missing')
              return {
                sessionId: row.id,
                ...row.title === undefined ? {} : { title: row.title },
                ...row.cwd === undefined ? {} : { cwd: row.cwd },
                running: row.running,
                blank: row.blank,
                updatedAt: row.updatedAt,
                ...row.parentId === undefined ? {} : { parentSessionId: row.parentId },
                ...row.origin === undefined ? {} : { origin: row.origin },
                ...row.formatStatus === undefined ? {} : { formatStatus: row.formatStatus },
              }
            }),
          }
        } catch (error) {
          if (!Object.is(captured, currentGeneration(activeState))) return staleResult()
          return readFailure(error, false)
        }
      })()),
      readSession: (sessionId, options) => trackClientOperation(activeState, activeState.closed
        ? Promise.resolve(closedResult())
        : readHistory(activeState, sessionId, options, activeState.lifetime.signal)),
      createWorkspace: path => trackClientOperation(activeState, (async () => {
        requireNonEmpty(path, 'path')
        if (!isAbsolute(path)) throw nativeError('NATIVE_CLIENT_INVALID_INPUT', 'workspace path must be absolute')
        if (activeState.closed) return closedResult()
        const captured = currentGeneration(activeState)
        if (captured === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
        return await settleWrite(
          () => abortable(activeState.remote.workspace.create({ path }), activeState.lifetime.signal),
          'committed',
          value => ({
            workspace: {
              workspaceId: value.workspace.workspaceId,
              path: value.workspace.path,
              title: value.workspace.title,
            },
            created: value.created,
          }),
        )
      })()),
      createSession: input => trackClientOperation(activeState, (async () => {
        if (activeState.closed) return closedResult()
        if (input?.workspaceId !== undefined) requireNonEmpty(input.workspaceId, 'workspaceId')
        if (input?.agentPreset !== undefined) requireNonEmpty(input.agentPreset, 'agentPreset')
        const requestedSessionId = input?.sessionId === undefined ? `session-${randomUUID()}` : requireNonEmpty(input.sessionId, 'sessionId')
        const captured = currentGeneration(activeState)
        if (captured === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
        try {
          const sessionId = await abortable(activeState.sessions.create({
            ...input?.workspaceId === undefined ? {} : { workspaceId: input.workspaceId as WorkspaceId },
            sessionId: requestedSessionId as SessionId,
            ...input?.agentPreset === undefined ? {} : { agentPreset: input.agentPreset },
          }), activeState.lifetime.signal)
          if (sessionId === '') return unknownResult({ code: 'NATIVE_INVALID_RESPONSE', message: 'The official Session create returned an empty identity.' }, { requestedSessionId })
          return { kind: 'committed', value: { sessionId } }
        } catch (error) {
          const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
          const rpcError = record.rpcError
          const code = remoteFailureCode(error) ?? remoteFailureCode(rpcError)
          const details = typeof rpcError === 'object' && rpcError !== null
            ? (rpcError as Record<string, unknown>).details
            : typeof error === 'object' && error !== null
              ? (error as Record<string, unknown>).details
              : undefined
          const published = code === 'session/workspace-attach-failed' && typeof details === 'object' && details !== null
            && typeof (details as Record<string, unknown>).sessionId === 'string'
            ? (details as Record<string, unknown>).sessionId as string
            : typeof record.publishedSessionId === 'string' ? record.publishedSessionId : undefined
          if (published !== undefined) {
            return unknownResult(
              { code: code ?? 'session/workspace-attach-failed', message: 'The Session was published but its workspace attachment failed.' },
              { requestedSessionId, committedSessionId: published },
            )
          }
          const proven = code !== undefined && (
            code === 'gateway/bad-request'
            || code === 'workspace/not-found'
            || code === 'agent-preset/not-found'
            || code === 'agent-preset/invalid'
            || code === 'agent-preset/conflict'
            || code === 'session/conflict'
            || code === 'session/agent-busy'
            || ['gateway/ambiguous-endpoint', 'gateway/arguments-invalid', 'gateway/binding-invalid',
              'gateway/context-failed', 'gateway/context-not-found', 'gateway/context-unavailable',
              'gateway/definition-unavailable', 'gateway/input-invalid', 'gateway/invocation-unavailable',
              'gateway/lookup-failed', 'gateway/lookup-not-found', 'gateway/lookup-unavailable',
              'gateway/method-unavailable', 'gateway/provider-mismatch', 'gateway/service-unavailable',
              'gateway/signature-invalid', 'gateway/interactions-forbidden'].includes(code)
          )
          if (proven) return rejectedResult({ code, message: 'The official Session create refused the request.' })
          return unknownResult(
            { code: code ?? 'NATIVE_SESSION_CREATE_UNKNOWN', message: 'The Session create outcome could not be determined.' },
            { requestedSessionId },
          )
        }
      })()),
      openSession: sessionId => trackClientOperation(activeState, (async () => {
        requireNonEmpty(sessionId, 'sessionId')
        if (activeState.closed) return closedResult()
        const captured = currentGeneration(activeState)
        if (captured === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
        const reference = activeState.sessions.retain(sessionId as SessionId, {
          source: 'controllerOperation',
          signal: activeState.lifetime.signal,
        })
        try {
          await abortable(reference.ready, activeState.lifetime.signal)
          const binding = reference.binding
          const snapshot = binding.session.getSnapshot()
          if (!Object.is(captured, currentGeneration(activeState))) {
            reference.release()
            return currentGeneration(activeState) === undefined
              ? unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current after Session open.')
              : staleResult()
          }
          if (snapshot.openState !== 'open') {
            reference.release()
            return unavailableResult('NATIVE_SESSION_OPEN_FAILED', 'The official Session history open did not complete.')
          }
          const handle = new OwnedNativeSession(activeState, reference, binding)
          activeState.handles.add(handle)
          const siblings = activeState.handlesBySession.get(sessionId) ?? new Set<OwnedNativeSession>()
          siblings.add(handle)
          activeState.handlesBySession.set(sessionId, siblings)
          activeState.notifyHandles()
          return { kind: 'ok', value: handle }
        } catch (error) {
          reference.release()
          return unknownResult(
            failureOf(error, 'NATIVE_SESSION_OPEN_UNKNOWN', 'The Session open outcome could not be determined.', false),
            { requestedSessionId: sessionId },
          )
        }
      })()),
      catalog: () => trackClientOperation(activeState, (async () => {
        if (activeState.closed) return closedResult()
        const captured = currentGeneration(activeState)
        if (captured === undefined) return unavailableResult('NATIVE_DISCONNECTED', 'No authenticated Host generation is current.')
        const models = await settleRead(() => abortable(activeState.remote.session.modelCatalog(), activeState.lifetime.signal), captured, activeState.generation, modelCatalogOf)
        if (models.kind !== 'ok') return models
        const presets = await settleRead(() => abortable(activeState.remote.agentPresets.list(), activeState.lifetime.signal), captured, activeState.generation, presetRosterOf)
        if (presets.kind !== 'ok') return presets
        const permissions = await settleRead(() => abortable(activeState.remote.permissionPresets.catalog(), activeState.lifetime.signal), captured, activeState.generation, permissionCatalogOf)
        if (permissions.kind !== 'ok') return permissions
        return { kind: 'ok', value: { models: models.value, presets: presets.value, permissions: permissions.value } }
      })()),
      close: () => {
        if (activeState.closePromise !== undefined) return activeState.closePromise
        let settle!: () => void
        let fail!: (error: unknown) => void
        activeState.closePromise = new Promise<void>((resolve, reject) => {
          settle = resolve
          fail = reject
        })
        activeState.closed = true
        runOwned('native-client: Client close', async () => {
          await cleanup(new Error('native-client: closed'))
        }, {
          diag: activeState.diag,
          onResult: () => settle(),
          onError: error => fail(error),
        })
        activeState.notifyStatus()
        return activeState.closePromise
      },
    }
    return client
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    try {
      await cleanup(failure)
    } catch (cleanupError) {
      if (!cleanupStarted) releaseRealm()
      throw cleanupError
    }
    throw error
  }
}
