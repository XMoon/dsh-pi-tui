/**
 * The typed Worker-side Scene facade for the Split-process business Project.
 *
 * The Supervisor process owns the Scene root, the immutable single-package
 * install and every real Host and tui-test Client. This module only speaks the
 * existing Supervisor IPC protocol and exposes bounded operations; it never
 * runs a native terminal call, starts a Host itself or decides that a resource
 * is clean.
 *
 * It is plain TypeScript with erasable syntax only (no Vitest import), so the
 * same module stays loadable through the pinned Node type-stripping loader.
 *
 * @module split-process-fixture
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readKernelProcess, type KernelProcessIdentity } from '../../src/runtime/native-process/identity.ts'
import { readOfficialClientRecords } from './split-process-client.ts'
import { SupervisorClient } from './split-supervisor-client.ts'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))

export const PARALLEL_AUDIT_ENV = 'SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID'
export const PARALLEL_AUDIT_PAIR_ENV = 'SPLIT_VITEST_PARALLEL_AUDIT_PAIR'

interface CandidateFacts {
  tarball: string
  candidateSha256: string
  version: string
  manifestPin: string
  targetDshVersion: string
}

interface SplitProcessProfileModule {
  inspectImmutableSplitCandidate(path: string): CandidateFacts
}

interface SessionEvent {
  type?: string
  data?: Record<string, any>
}

interface SplitUpgradeNativeContractModule {
  serializeKernelIdentity(identity: unknown): string
  classifyKernelLiveness(kernel: unknown): { state: 'alive' | 'gone' | 'unknown' }
}

interface SplitSmokeSessionsModule {
  hostSessionEvents(dshHome: string, sessionId: string): SessionEvent[] | undefined
  hostSessionHeader(dshHome: string, sessionId: string): SessionEvent | undefined
  hostSessionLogCount(dshHome: string): number
  waitForHostSessionHeader(dshHome: string, sessionId: string, label: string, timeoutMs?: number): Promise<SessionEvent>
  waitForHostSessionEventAfter(
    dshHome: string,
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
}

const profileModule = await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-smoke-profile.mjs')).href
) as SplitProcessProfileModule
const sessionsModule = await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-smoke-sessions.mjs')).href
) as SplitSmokeSessionsModule
const nativeContract = await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-native-contract.mjs')).href
) as SplitUpgradeNativeContractModule

export interface SplitProcessInstallation {
  workDir: string
  dshHome: string
  profileDir: string
  entries: { host: string; client: string }
  anchor: string
  base: { cwd: string; env: Record<string, string> }
  scratch: string
}

export interface SplitProcessScopeFacts {
  scopeId: string
  buildId: string
  bundleVersion: string
  dshVersion: string
  hostSeat: { kind: string; name?: string; path?: string }
}

export type ProcessHostScenario =
  | 'long-turn' | 'job' | 'question' | 'approval-allow' | 'approval-reject'
  | 'foreground-tool' | 'child' | 'unowned-job' | 'goal-armed' | 'goal-round'
  | 'maintenance' | 'schedule' | 'plan-review' | 'team-board'

/** A bounded read-authority operation: the Supervisor owns the concrete wire values. */
export type ProcessReadAuthorityRequest =
  | { readonly op: 'read' }
  | { readonly op: 'activity'; readonly window: 'warm' | 'cold' }
  | { readonly op: 'workspaces'; readonly window: 'peer-baseline' | 'stream' | 'recovering' }
  | {
      readonly op: 'directory-browse'
      readonly target: 'home' | 'fixture' | 'missing' | 'relative'
      readonly interruption?: 'caller' | 'carrier'
    }
  | { readonly op: 'answer-continued'; readonly sessionId: string; readonly callId: string }

export interface StartProcessHostOptions {
  scenario?: ProcessHostScenario
  crashSignal?: 'SIGHUP' | 'SIGKILL'
  shellCompletionLocality?: true
  holdTool?: true
  holdChild?: true
  questionEligibility?: true
  timedQuestion?: true
  cancelAgent?: true
  goalArmed?: true
  unownedJob?: true
  maintenance?: true
}

export interface SplitProcessHostHandle {
  readonly hostId: string
  readonly entryId: string
  readonly generation: number
  readonly ready: Record<string, any>
  readonly workRoot: string
  readonly scopeId: string
  readonly pgid: number | null
  readonly entryRealpath: string
  readonly scenario?: string | null
  readonly crashSignal?: 'SIGHUP' | 'SIGKILL' | null
  readonly workloadRoot?: string | null
  readonly holdReleasePath?: string | null
  readonly jobWorkRoot?: string | null
  readonly toolReleasePath?: string | null
  readonly childReleasePath?: string | null
  readonly eligibilityBarrierPath?: string | null
  readonly timedAfterBarrierPath?: string | null
  readonly timedDuplicateBarrierPath?: string | null
  readonly timedExpiredBarrierPath?: string | null
  readonly cancelAgentBarrierPath?: string | null
  readonly goalPatchPath?: string | null
  readonly unownedJobArmPath?: string | null
  readonly unownedJobReleasePath?: string | null
  readonly maintenanceReleasePath?: string | null
  readonly scheduleDeletePath?: string | null
  exited: boolean
  exitResult?: { code: number | null; signal: NodeJS.Signals | null }
}

export interface SplitProcessClientReady {
  hostPid: number
  instanceId: string
  scopeId: string
  buildId: string
  transport: string
  surfaceMounted: boolean
  sessionOpen: boolean
  openSessionId?: string
  generationId?: number
  shellPid: number
  businessPid: number
}

export interface SplitProcessClientState {
  clientId: string
  label: string
  sessionId: string
  shellPid: number | null
  businessPids: number[]
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  sessionListed: boolean
  shellState: string
  businessStates: Array<{ pid: number; state: string }>
  /** Present only while the native terminal handle still exists. */
  cols?: number
  rows?: number
}

export interface SplitProcessClientTerminal {
  kind: 'native' | 'owner-loss'
  code?: number | null
  signal?: string | null
  ownerPid?: number
  ownerBirth?: string
  ownerExit?: { code: number | null; signal: string | null }
  hostPid?: number
  hostInstanceId?: string
  [key: string]: unknown
}

export interface SplitProcessClientExitFacts {
  code: number | null
  signal: string | null
  kind?: 'native' | 'owner-loss'
  terminal?: SplitProcessClientTerminal | null
  ownerPid?: number | null
  ownerExit?: { code: number | null; signal: string | null } | null
}

export type ProcessClientTerminalMode =
  | 'normal' | 'sigint' | 'hmr-failure' | 'terminal-owner-loss' | 'business-kill'
  | 'business-hangup' | 'host-replacement-refusal'
export type ProcessStartupStopStage = 'domain' | 'surface' | 'loader-gate' | 'before-start'
export type ProcessClientExpectedFailure = 'client-domain-module-absent'

export interface SplitProcessClientStopFacts {
  clientId: string
  label: string
  sessionId: string | null
  stage: ProcessStartupStopStage
  pid: number
  birth: string
  hostPid: number
  hostInstanceId: string
  exit: { code: number | null; signal: string | null }
  terminal: SplitProcessClientTerminal
}

export interface SplitProcessClientFailureFacts {
  clientId: string
  label: string
  sessionId: string | null
  pid: number
  birth: string
  hostPid: number
  hostInstanceId: string
  exit: { code: number | null; signal: string | null }
  failure: { code: string | null; phase: string | null; moduleAbsent: true }
  terminal: SplitProcessClientTerminal
}

export interface SplitProcessClient {
  readonly clientId: string
  readonly label: string
  readonly sessionId: string
  readonly recordFile: string
  readonly ready: SplitProcessClientReady
  /** Whether this Worker already observed the normal terminal close. */
  readonly closed: boolean
  readonly exit: { code: number | null; signal: string | null } | null
  type(text: string): Promise<void>
  press(...keys: string[]): Promise<void>
  submit(text?: string): Promise<void>
  text(): Promise<string>
  state(): Promise<SplitProcessClientState>
  readRecords(): Record<string, any>[]
  waitForRecord(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
  waitForSurfaceStatus(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<Record<string, any>>
  waitForExit(timeoutMs?: number): Promise<SplitProcessClientExitFacts>
  close(): Promise<SplitProcessClientExitFacts>
  /** Use the existing current-frame safe /exit path, then close. */
  exitGracefully(): Promise<void>
  /** Send one declared product signal to the real business Client PID. */
  signal(signal: 'SIGUSR1' | 'SIGUSR2' | 'SIGINT' | 'SIGTERM'): Promise<void>
  /** The ONE declared terminal-owner loss; returns the tagged verified fact. */
  loseTerminalOwner(): Promise<SplitProcessClientTerminal>
  /** Release the Supervisor-allocated HMR hold barrier exactly once. */
  releaseHmrHold(): void
  readonly holdBarrierPath: string | null
  readonly serializeBarrierPath: string | null
  readonly terminalKind: ProcessClientTerminalMode
  /** Send SIGKILL only to the exact live business PID of a business-kill Client. */
  killBusiness(): Promise<{ pid: number; birth: string; signal: 'SIGKILL' }>
  /** Send SIGHUP only to the exact live business PID of a business-hangup Client. */
  hangupBusiness(): Promise<{ pid: number; birth: string; signal: 'SIGHUP' }>
  /** Dispatch one bounded, typed read-authority operation; returns its correlation nonce. */
  readAuthority(request: ProcessReadAuthorityRequest): Promise<{ nonce: string; op: string }>
  /** Release the Supervisor-allocated serializer hold exactly once. */
  releaseSerializeHold(): void
}

export type PublicDaemonBackend = 'daemon' | 'direct' | '' | 'wire-local'

export interface PublicDaemonArgs {
  session?: string
  continue?: true
  preset?: string
}

export interface PublicProcessIdentity {
  pid: number
  birth: string
  entry: string
}

export interface PublicDaemonHostFacts {
  pid: number
  birth: string
  instanceId?: string
  scopeId: string
  buildId: string
  origin?: string
  protocol?: string
  bundleVersion?: string
  dshVersion?: string
  schema?: number
  pgid: number
  sid: number
  ppidAtCapture: number
  registeredAt: string
  attemptByLaunchId?: string | null
  published?: boolean
  winner?: boolean
  settled?: boolean
  terminalOutcome?: string | null
  reclaimed: boolean
  normalStop: boolean
  stoppedAt?: string
}

export interface PublicDaemonSurfaceFacts {
  marker: 'composer' | 'workspace'
  typed: boolean
  cleared: boolean
}

export interface PublicDaemonHerdrFacts {
  paneId: string
  binPath: string
  socketPath: string
  logPath: string
}

export interface PublicDaemonLaunchFacts {
  launchId: string
  label: string
  profile: string
  alias: string | null
  sessionId: string
  launchCwd: string
  backend: PublicDaemonBackend | null
  shellPid: number | null
  shellBirth: string | null
  shellTty: { platform: string; eTdev?: number; ttyNr?: number } | null
  cli: PublicProcessIdentity | null
  client: PublicProcessIdentity | null
  host: PublicDaemonHostFacts | null
  hostAttempt: PublicDaemonHostFacts | null
  registryAbsentBefore: boolean
  registryAbsentAfter: boolean
  ready: boolean
  refused: boolean
  exit: { code: number | null; signal: string | null } | null
  surface: PublicDaemonSurfaceFacts | null
  loaderRows: Array<{ id: string; disabled: boolean; state: unknown }> | null
  herdr: PublicDaemonHerdrFacts | null
}

export interface StartPublicDaemonOptions {
  label: string
  profile?: string
  alias?: string
  args?: PublicDaemonArgs
  backend?: PublicDaemonBackend
  cols?: number
  rows?: number
  /** The initial product surface the launch actually paints. */
  surface?: 'chat' | 'workspace'
  loaderDump?: true
  herdr?: true
  /** Replay one captured Herdr resume argv through the installed bin PATH. */
  replayCommand?: string[]
  /** Use one Supervisor-allocated private directory as the native launch cwd. */
  ownWorkspace?: true
}

export interface PublicDaemonState {
  launchId: string
  label: string
  sessionId: string
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  closed: boolean
  cliState: string
  clientState: string
  hostState: string
  cols?: number
  rows?: number
}

export interface PublicDaemonKernelState {
  launchId: string
  label: string
  exited: boolean
  closed: boolean
  exitCode: number | null
  exitSignal: string | null
  cliState: string
  clientState: string
  hostState: string
  cliPid: number | null
  clientPid: number | null
  hostPid: number | null
  hostInstanceId: string | null
  hostBirth: string | null
}

export interface PublicDaemonStatusFacts {
  exit: { code: number | null; signal: string | null }
  fields: Record<string, string>
  stdoutBytes: number
}

export interface PublicDaemonLaunch {
  readonly launchId: string
  readonly label: string
  readonly profile: string
  readonly alias: string | null
  readonly sessionId: string
  readonly launchCwd: string
  readonly backend: PublicDaemonBackend | null
  readonly shellPid: number | null
  readonly shellBirth: string | null
  readonly shellTty: { platform: string; eTdev?: number; ttyNr?: number } | null
  readonly cli: PublicProcessIdentity | null
  readonly client: PublicProcessIdentity | null
  readonly host: PublicDaemonHostFacts | null
  readonly hostAttempt: PublicDaemonHostFacts | null
  readonly registryAbsentBefore: boolean
  readonly registryAbsentAfter: boolean
  readonly ready: boolean
  readonly refused: boolean
  readonly surface: PublicDaemonSurfaceFacts | null
  readonly loaderRows: Array<{ id: string; disabled: boolean; state: unknown }> | null
  readonly herdr: PublicDaemonHerdrFacts | null
  readonly closed: boolean
  readonly exit: { code: number | null; signal: string | null } | null
  type(text: string): Promise<void>
  press(...keys: string[]): Promise<void>
  submit(text?: string): Promise<void>
  text(options?: { full?: boolean }): Promise<string>
  state(): Promise<PublicDaemonState>
  /** Kernel-only identity states, readable after the native terminal died. */
  kernelState(): Promise<PublicDaemonKernelState>
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: string | null; text: string }>
  close(): Promise<PublicDaemonLaunchFacts>
  /** Failure teardown: close the native PTY and prove the kernel terminal. */
  reclaim(): Promise<PublicDaemonLaunchFacts>
  daemonStatus(): Promise<PublicDaemonStatusFacts>
  stopHost(): Promise<PublicDaemonHostFacts>
  /** Send SIGTERM to the captured public CLI PID only (freshly re-proved). */
  signalCli(): Promise<{
    launchId: string
    pid: number
    birth: string
    signal: 'SIGTERM'
    outcome: PublicDaemonTermOrder
  }>
  /** Read the controlled Herdr fake's complete invocation lines. */
  readHerdrInvocations(): Array<{ ppid: number; argv: string[] }>
}

export interface PublicScopeStateFacts {
  registry: 'present' | 'absent'
  launch: 'present' | 'absent'
  hosts: Array<{ pid: number; birth: string }>
}

export interface PublicDaemonTermOrder {
  sentAt: string
  observedAt: string
  samples: number
  clientGoneAt: string | null
  cliGoneAt: string | null
  clientTerminalWhileCliLive: boolean
  cliLiveBirthAtClientTerminal: string | null
  sameSampleGone: boolean
  firstSampleBothGone: boolean
  order: string
}

export interface PublicDaemonColdPairLaunchOptions {
  label: string
  backend: 'daemon'
  cols?: number
  rows?: number
}

export interface PublicDaemonColdPair {
  pairId: string
  winner: PublicDaemonHostFacts
  launches: [PublicDaemonLaunch, PublicDaemonLaunch]
}

export interface StartProcessClientOptions {
  label: string
  cwd: string
  home: string
  sessionId?: string
  cols?: number
  rows?: number
  hmr?: 'replace' | 'mount-failure' | 'hold'
  dropPromptAck?: true
  terminal?: ProcessClientTerminalMode
  startupStop?: ProcessStartupStopStage
  expectedFailure?: ProcessClientExpectedFailure
  privateRpcProof?: true
  readAuthorityProof?: true
  holdSerialize?: true
  invalidWorkspacePath?: true
  recoverFromHostId?: string
  attachRecoveredHostId?: string
}

/** A bounded official record match; never a Worker-supplied predicate. */
export interface EntryRecordMatch {
  m4a0?: string
  m4b2hf?: string
  requestId?: string
  phase?: string
  signal?: string
  op?: string
}

export type EntryRecord = Record<string, any>

export type HostAttemptMode =
  | 'seat-race'
  | 'seat-conflict'
  | 'host-runtime-disabled'
  | 'tui-row-enabled'
  | 'connection-disabled'
  | 'session-controller-disabled'
  | 'workspace-controller-disabled'
  | 'host-runtime-absent'
  | 'host-bootstrap-absent'
  | 'scratch-removal-failure'
  | 'early-exit'
  | 'stop-during-publication'
  | 'stop-during-initial-liveness'

export type QualificationClientMode =
  | 'attach'
  | 'seat-race'
  | 'omit-cookie'
  | 'startup-fatal'
  | 'refresh-unresponsive-once'
  | 'bootstrap-failure'
  | 'client-bootstrap-drift'
  | 'discover-after-host-death'
  | 'discover-with-pre-profile-failure'
  | 'discovery-refusal'
  | 'identity-changed'
  | 'cross-home-seat-refusal'
  | 'peer-stale-question'
  | 'peer-stale-approval'

export type DiscoveryRefusal =
  | 'registry-symlink'
  | 'launch-symlink'
  | 'forged-instance'
  | 'forged-pid'
  | 'forged-build'
  | 'forged-origin'
  | 'unresponsive-dummy-origin'
  | 'protocol'
  | 'wrong-token'
  | 'scope-directory'

export type EntrySignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL'

export interface EntryQualificationHandle {
  readonly entryId: string
  readonly kind: 'host-attempt' | 'qualification-client'
  readonly label: string
  readonly mode: HostAttemptMode | QualificationClientMode
  readonly pid: number
  readonly birth: string | null
  readonly pgid: number | null
  readonly scratch: string | null
  readonly barriers: Record<string, string>
  readonly coStarted?: number
}

export interface HostAttemptHandle extends EntryQualificationHandle {
  readonly kind: 'host-attempt'
  readonly mode: HostAttemptMode
}

export interface QualificationClientHandle extends EntryQualificationHandle {
  readonly kind: 'qualification-client'
  readonly mode: QualificationClientMode
  readonly refusal?: DiscoveryRefusal
}

export interface EntryStderrMarkers {
  loaderImportFailed: boolean
  moduleNotFound: boolean
  requiredTuiSurfaceMissing: boolean
}

export interface EntryRecordFacts {
  entryId: string
  kind: string
  mode: string | null
  pid: number | null
  birth: string | null
  exited: boolean
  exitCode: number | null
  exitSignal: string | null
  stderrMarkers: EntryStderrMarkers
  stderrBytes: number
  records: EntryRecord[]
  /** Present only for the fixed cross-home seat-refusal reservation. */
  crossHome?: Record<string, any>
}

export interface EntryTerminalFacts {
  entryId: string
  kind: string
  mode: string | null
  outcome: string
  exit: { code: number | null; signal: string | null }
  records: EntryRecord[]
  stderrMarkers: EntryStderrMarkers
  [key: string]: unknown
}

export interface BootstrapCliFacts {
  mode: 'inherited-host-role' | 'direct-help'
  entryId: string
  exit: { code: number | null; signal: string | null }
  markers: EntryStderrMarkers
  profilePatchRestored: boolean
}

export interface InstallFaultFacts {
  fault: 'host-runtime-absent' | 'host-bootstrap-absent' | 'client-bootstrap-drift' | 'client-domain-module-absent'
  target: string
  payloadHashBefore: string
  buildIdBefore: string
  candidateSha256: string
  barrierPath?: string
  payloadHashAfter?: string
  buildIdAfter?: string
  [key: string]: unknown
}

export interface IdentityWitnessHandle {
  entryId: string
  kind: 'live-non-host' | 'linux-zombie'
  pid: number
  holderPid: number | null
  birth: string
  starttime: string | null
  kernelIdentity: Record<string, any>
}

export interface DiscoveredHostTerminalFacts {
  pid: number
  birth: string | null
  reclaimed: boolean
  registryRemoved: boolean
  normalStop?: boolean
  scratchEntries: string[]
}

export interface SplitProcessScene {
  /** The Scenario's unique Supervisor receipt/run identity. */
  readonly runId: string
  readonly workDir: string
  readonly candidate: CandidateFacts
  readonly installation: SplitProcessInstallation
  readonly scope: SplitProcessScopeFacts
  /** The exact installed product scope directory (`run/dsh-pi-tui/<scopeId>`). */
  readonly scopeDir: string
  /** The private external run base this Scene was created under. */
  readonly tmpBase: string
  /** Await the ONE Supervisor process exit (for an intentional failed FINALIZE). */
  waitSupervisorExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** The durable receipt, readable after the Supervisor exits (including failure). */
  readSupervisorReceipt(): Promise<SupervisorReceipt>
  /** Bounded typed Supervisor IPC, for boundary negatives on a real Scene. */
  request(type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>>
  startHost(options?: StartProcessHostOptions): Promise<SplitProcessHostHandle>
  hostStatus(host: SplitProcessHostHandle): Promise<Record<string, any>>
  stopHost(host: SplitProcessHostHandle): Promise<SplitProcessClientExitFacts>
  startClient(options: StartProcessClientOptions): Promise<SplitProcessClient>
  /** Stop one real Client inside the same pre-ready start transaction. */
  startClientStop(options: StartProcessClientOptions & { startupStop: ProcessStartupStopStage }): Promise<SplitProcessClientStopFacts>
  /** Observe the exact installed Client Domain module-absence failure. */
  startClientFailure(options: StartProcessClientOptions & { expectedFailure: ProcessClientExpectedFailure }): Promise<SplitProcessClientFailureFacts>
  /** Send the fixed opposite stale result through one real authenticated Peer. */
  sendStalePeerResult(handle: QualificationClientHandle, kind: 'question' | 'approval'): Promise<Record<string, any>>
  /** Start the REAL installed public CLI under a native PTY (Linux qualification). */
  startPublicDaemon(options: StartPublicDaemonOptions): Promise<PublicDaemonLaunch>
  /** Two real cold producers in one request; only daemon/chat/defaults. */
  startPublicDaemonColdPair(options: {
    launches: [PublicDaemonColdPairLaunchOptions, PublicDaemonColdPairLaunchOptions]
  }): Promise<PublicDaemonColdPair>
  /** Run the public CLI without a TTY to prove the daemon TTY refusal. */
  runPublicDaemonHeadless(options: {
    label: string
    backend: 'daemon'
    args?: PublicDaemonArgs
  }): Promise<{ exit: { code: number | null; signal: string | null }; text: string }>
  /** Report the public side of the explicit host-file-completion audit pair. */
  /** The fixed opt-in authority control (no caller-controlled command/PID/env). */
  runPublicAuthorityControl(): Promise<Record<string, any>>
  publicDaemonParallelReady(launch: PublicDaemonLaunch): Promise<void>
  publicDaemonParallelRelease(): Promise<void>
  startHostAttempts(options: {
    mode: HostAttemptMode
    scratchTarget?: string
    signal?: 'SIGTERM' | 'SIGINT'
  }): Promise<HostAttemptHandle[]>
  startQualificationClients(options: {
    mode: QualificationClientMode
    count?: number
    refusal?: DiscoveryRefusal
    foundationBarrier?: boolean
  }): Promise<QualificationClientHandle[]>
  entryRecordFacts(handle: EntryQualificationHandle): Promise<EntryRecordFacts>
  entryRecords(handle: EntryQualificationHandle): Promise<EntryRecord[]>
  waitEntryRecord(handle: EntryQualificationHandle, match: EntryRecordMatch, timeoutMs?: number): Promise<EntryRecord>
  entryStatus(handle: QualificationClientHandle): Promise<EntryRecord>
  qualificationControl(
    handle: QualificationClientHandle,
    control: {
      op: 'qualification-host-foundation' | 'qualification-drop-websocket'
      requestId: string
      workspacePath?: string
      workspaceResume?: true
      schedule?: true
    },
  ): Promise<void>
  signalEntry(handle: EntryQualificationHandle | SplitProcessHostHandle, signal: EntrySignal | 'SIGHUP'): Promise<void>
  finishEntry(handle: EntryQualificationHandle | SplitProcessHostHandle): Promise<EntryTerminalFacts>
  acceptHostWinner(handle: HostAttemptHandle): Promise<SplitProcessHostHandle>
  runBootstrapCli(mode: 'inherited-host-role' | 'direct-help'): Promise<BootstrapCliFacts>
  setInstallationFault(fault: 'host-runtime-absent' | 'host-bootstrap-absent' | 'client-bootstrap-drift' | 'client-domain-module-absent'): Promise<InstallFaultFacts>
  restoreInstallation(): Promise<void>
  startIdentityWitness(kind: 'live-non-host' | 'linux-zombie'): Promise<IdentityWitnessHandle>
  finishIdentityWitness(handle: IdentityWitnessHandle): Promise<void>
  reclaimDiscoveredHost(client: QualificationClientHandle | SplitProcessClient): Promise<DiscoveredHostTerminalFacts>
  assertEntrySeatsFree(): Promise<void>
  /** Release one Supervisor-preallocated qualification barrier (file existence). */
  releaseBarrier(handle: EntryQualificationHandle, name: string): void
  sessionIds(): Promise<string[]>
  publicScopeState(): Promise<PublicScopeStateFacts>
  sessionEvents(sessionId: string): SessionEvent[] | undefined
  hostSessionLogCount(): number
  waitForNewSessionId(before: ReadonlySet<string>, label: string, timeoutMs?: number): Promise<string>
  waitForHostSessionHeader(sessionId: string, label: string, timeoutMs?: number): Promise<SessionEvent>
  waitForSessionEvent(
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<SessionEvent>
  report(event: string, detail?: Record<string, unknown>): Promise<void>
  /** Report one real parallel-ready checkpoint and prove the other Scene is live. */
  parallelReady(
    label: 'host-file-completion' | 'preset-defaults',
    host: SplitProcessHostHandle,
    client: SplitProcessClient,
  ): Promise<void>
  /** Close this Scene's parallel-audit active interval. */
  parallelRelease(label: 'host-file-completion' | 'preset-defaults'): Promise<void>
  dispose(): Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function requireAbsoluteDirectory(name: string): string {
  const raw = process.env[name]
  assert(typeof raw === 'string' && raw !== '' && isAbsolute(raw),
    `INPUT_UNQUALIFIED: ${name} must be an absolute path`)
  let real: string
  let stats
  try {
    real = realpathSync(raw)
    stats = statSync(real)
  } catch (error) {
    throw new Error(`INPUT_UNQUALIFIED: ${name} is not a readable existing directory: ${asError(error).message}`)
  }
  assert(real === raw,
    `INPUT_UNQUALIFIED: ${name} must be a canonical path, not a symlink alias: ${raw} -> ${real}`)
  assert(stats.isDirectory(), `INPUT_UNQUALIFIED: ${name} is not a directory: ${real}`)
  if (typeof process.getuid === 'function') {
    assert(stats.uid === process.getuid(), `INPUT_UNQUALIFIED: ${name} is not owned by this user: ${real}`)
  }
  assert((stats.mode & 0o777) === 0o700, `INPUT_UNQUALIFIED: ${name} must have mode 0700: ${real}`)
  const rel = relative(REPO_ROOT, real)
  assert(rel === '..' || rel.startsWith(`..${sep}`),
    `INPUT_UNQUALIFIED: ${name} must be outside the checkout: ${real}`)
  return real
}

function requireCandidateTarball(): string {
  const raw = process.env.SPLIT_VITEST_CANDIDATE_TGZ
  assert(typeof raw === 'string' && raw !== '' && isAbsolute(raw),
    'INPUT_UNQUALIFIED: SPLIT_VITEST_CANDIDATE_TGZ must be an absolute path to the built candidate .tgz')
  return raw
}

/** Poll the real Host Session store for its Session directory identities. */
function listSessionIds(dshHome: string): string[] {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const ids: string[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (session.isDirectory()) ids.push(session.name)
    }
  }
  return ids
}

interface SupervisorReceipt {
  runId?: string
  parentRunId?: string
  kind?: string
  phase?: string
  sceneRoot?: string
  candidate?: { sha256?: string }
  installation?: { dshHome?: string; profileDir?: string; workDir?: string }
  scope?: { scopeId?: string; hostSeat?: { path?: string; name?: string } }
  worker?: { pid?: number; ppid?: number; birth?: string }
  host?: { pid?: number; birth?: string; pgid?: number }
  hosts?: Array<Record<string, any>>
  qualificationClients?: Array<Record<string, any>>
  qualificationHelpers?: Array<Record<string, any>>
  installationMutation?: Record<string, any>
  compensation?: { attempted?: boolean; completed?: boolean; failure?: string }
  cleanup?: { sceneRootRemoved?: boolean; hostsExited?: boolean; hostSeatFree?: boolean; qualificationSeatFree?: boolean }
  processClients?: Array<{
    clientId?: string
    label?: string
    sessionId?: string
    scratch?: string
    terminal?: string
    startupStop?: string | null
    expectedFailure?: string | null
    privateRpcProof?: boolean
    holdSerialize?: boolean
    serializeBarrierPath?: string | null
    invalidWorkspacePath?: boolean
    workspaceIntentPath?: string | null
    businessKillSent?: boolean
    ownerPid?: number | null
    ownerBirth?: string | null
    ownerExit?: { code?: number | null; signal?: string | null } | null
    shellPid?: number
    shellBirth?: string
    businessIdentities?: Array<{ pid?: number; birth?: string }>
    exited?: boolean
    exitCode?: number | null
    exitSignal?: string | null
    verifiedTerminal?: Record<string, any> | null
  }>
  publicLaunches?: Array<{
    launchId?: string
    label?: string
    profile?: string
    alias?: string | null
    sessionId?: string
    launchCwd?: string
    shellPid?: number | null
    shellBirth?: string | null
    cli?: PublicProcessIdentity | null
    client?: PublicProcessIdentity | null
    host?: PublicDaemonHostFacts | null
    readyAt?: string
    exited?: boolean
    exitCode?: number | null
    exitSignal?: string | null
    closed?: boolean
    verifiedTerminal?: Record<string, any> | null
  }>
  publicHosts?: PublicDaemonHostFacts[]
  notes?: Array<{ event?: string; detail?: Record<string, any>; at?: string }>
}

class ProcessClient implements SplitProcessClient {
  readonly clientId: string
  readonly label: string
  readonly sessionId: string
  readonly recordFile: string
  readonly ready: SplitProcessClientReady
  readonly holdBarrierPath: string | null
  readonly serializeBarrierPath: string | null
  readonly terminalKind: ProcessClientTerminalMode
  readonly #scene: ProcessScene
  #closed = false
  #exitFacts: SplitProcessClientExitFacts | undefined

  constructor(scene: ProcessScene, payload: Record<string, any>) {
    this.#scene = scene
    this.clientId = String(payload.clientId)
    this.label = String(payload.label)
    this.sessionId = String(payload.sessionId)
    this.recordFile = String(payload.recordFile)
    this.ready = payload.ready as SplitProcessClientReady
    this.holdBarrierPath = payload.holdBarrier === null || payload.holdBarrier === undefined
      ? null
      : String(payload.holdBarrier)
    this.serializeBarrierPath = payload.serializeBarrierPath === null || payload.serializeBarrierPath === undefined
      ? null
      : String(payload.serializeBarrierPath)
    this.terminalKind = (payload.terminal ?? 'normal') as ProcessClient['terminalKind']
  }

  async signal(signal: 'SIGUSR1' | 'SIGUSR2' | 'SIGINT' | 'SIGTERM'): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'SIGNAL_PROCESS_CLIENT', { signal })
  }

  async killBusiness(): Promise<{ pid: number; birth: string; signal: 'SIGKILL' }> {
    return await this.#scene.clientRequest(this.clientId, 'SIGNAL_PROCESS_CLIENT', { signal: 'SIGKILL' }) as {
      pid: number; birth: string; signal: 'SIGKILL'
    }
  }

  async hangupBusiness(): Promise<{ pid: number; birth: string; signal: 'SIGHUP' }> {
    return await this.#scene.clientRequest(this.clientId, 'SIGNAL_PROCESS_CLIENT', { signal: 'SIGHUP' }) as {
      pid: number; birth: string; signal: 'SIGHUP'
    }
  }

  async loseTerminalOwner(): Promise<SplitProcessClientTerminal> {
    const payload = await this.#scene.request('PROCESS_CLIENT_TERMINAL_LOSS', { clientId: this.clientId }, 120_000)
    this.#closed = true
    this.#exitFacts = {
      code: null,
      signal: null,
      kind: 'owner-loss',
      terminal: payload.terminal as SplitProcessClientTerminal,
      ownerPid: payload.ownerPid ?? null,
      ownerExit: payload.ownerExit ?? null,
    }
    return payload.terminal as SplitProcessClientTerminal
  }

  async readAuthority(request: ProcessReadAuthorityRequest): Promise<{ nonce: string; op: string }> {
    return await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_READ_AUTHORITY', { request }) as {
      nonce: string; op: string
    }
  }

  releaseHmrHold(): void {
    const path = this.holdBarrierPath
    if (path === null) throw new Error(`${this.label}: no Supervisor-allocated HMR hold barrier`)
    const parent = realpathSync(dirname(path))
    const rel = relative(this.#scene.workDir, parent)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`${this.label}: the HMR hold barrier parent escapes the Scene root`)
    }
    writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
  }

  releaseSerializeHold(): void {
    const path = this.serializeBarrierPath
    if (path === null) throw new Error(`${this.label}: no Supervisor-allocated serializer hold barrier`)
    const parent = realpathSync(dirname(path))
    const rel = relative(this.#scene.workDir, parent)
    assert(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`),
      `${this.label}: the serializer hold barrier parent escapes the Scene root`)
    writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
  }

  async type(text: string): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_INPUT', { input: { type: 'type', text } })
  }

  async press(...keys: string[]): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_INPUT', { input: { type: 'press', keys } })
  }

  async submit(text?: string): Promise<void> {
    await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_INPUT', {
      input: text === undefined ? { type: 'submit' } : { type: 'submit', text },
    })
  }

  async text(): Promise<string> {
    const payload = await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_TEXT', {})
    return String(payload.text)
  }

  async state(): Promise<SplitProcessClientState> {
    return await this.#scene.clientRequest(this.clientId, 'PROCESS_CLIENT_STATE', {}) as SplitProcessClientState
  }

  readRecords(): Record<string, any>[] {
    return readOfficialClientRecords(this.recordFile, this.label)
  }

  async waitForRecord(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<Record<string, any>> {
    const started = Date.now()
    // Streaming poll: a live JSONL append may end in a partial record, which is
    // not a malformed line. The final strict read below still rejects it.
    const find = (allowIncompleteTail: boolean): Record<string, any> | undefined =>
      readOfficialClientRecords(this.recordFile, this.label, { allowIncompleteTail }).find(predicate)
    let stateCheckedAt = 0
    for (;;) {
      const record = find(true)
      if (record !== undefined) return record
      if (Date.now() - stateCheckedAt >= 500) {
        stateCheckedAt = Date.now()
        const state = await this.state()
        if (state.exited) {
          throw new Error(`${label}: the Client exited before a matching official record`)
        }
      }
      if (Date.now() - started >= timeoutMs) {
        const late = find(false)
        if (late !== undefined) return late
        throw new Error(`${label}: no matching official record within ${String(timeoutMs)}ms`)
      }
      await sleep(25)
    }
  }

  async waitForSurfaceStatus(
    predicate: (record: Record<string, any>) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<Record<string, any>> {
    const started = Date.now()
    for (;;) {
      const records = readOfficialClientRecords(this.recordFile, this.label, { allowIncompleteTail: true })
        .filter(record => record?.m4b2s === 'surface-status')
      const status = records.at(-1)
      if (status !== undefined && predicate(status)) return status
      if (Date.now() - started >= timeoutMs) {
        const late = readOfficialClientRecords(this.recordFile, this.label)
          .filter(record => record?.m4b2s === 'surface-status').at(-1)
        if (late !== undefined && predicate(late)) return late
        throw new Error(`${label}: no matching official surface status within ${String(timeoutMs)}ms`)
      }
      await sleep(25)
    }
  }

  async waitForExit(timeoutMs = 120_000): Promise<SplitProcessClientExitFacts> {
    if (this.terminalKind === 'terminal-owner-loss') {
      throw new Error(`${this.label}: a terminal-owner-loss Client has no native exit fact; use loseTerminalOwner()`)
    }
    const started = Date.now()
    for (;;) {
      const state = await this.state()
      if (state.exited) {
        // Observation only: the Supervisor-owned CLOSE settlement is still
        // required before this Client can be called closed.
        this.#exitFacts = { code: state.exitCode, signal: state.exitSignal }
        return this.#exitFacts
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`${this.label}: the real tui-test shell did not exit within ${String(timeoutMs)}ms`)
      }
      await sleep(50)
    }
  }

  async close(): Promise<SplitProcessClientExitFacts> {
    if (this.#closed) return this.#exitFacts ?? { code: null, signal: null }
    if (this.terminalKind === 'terminal-owner-loss') {
      throw new Error(`${this.label}: the terminal-owner-loss Client must be closed by loseTerminalOwner()`)
    }
    const payload = await this.#scene.clientRequest(this.clientId, 'CLOSE_PROCESS_CLIENT', {})
    this.#closed = true
    this.#exitFacts = {
      code: payload.exitCode ?? null,
      signal: payload.exitSignal ?? null,
    }
    return this.#exitFacts
  }

  /** Whether this Client reached its normal native close in this Scene. */
  get closed(): boolean {
    return this.#closed
  }

  get exit(): { code: number | null; signal: string | null } | null {
    return this.#exitFacts ?? null
  }


  /**
   * Test teardown only: ask the real surface to leave, take the busy Exit Choice
   * ONLY when the CURRENT painted frame proves the default non-destructive row
   * is selected, then close. It never guesses a hidden modal state.
   */
  async exitGracefully(): Promise<void> {
    if (this.#closed) return
    const current = await this.state().catch(() => undefined)
    if (current !== undefined && current.exited) {
      await this.close()
      return
    }
    await this.submit('/exit')
    const deadline = Date.now() + 60_000
    let choiceTaken = false
    for (;;) {
      const state = await this.state().catch(() => undefined)
      if (state !== undefined && state.exited) {
        await this.close()
        return
      }
      if (!choiceTaken) {
        const frame = await this.text().catch(() => '')
        if (frame.includes('Disconnect from dsh-pi-tui') && frame.includes('> Keep working and disconnect')) {
          await this.press('Enter')
          choiceTaken = true
        }
      }
      if (Date.now() >= deadline) {
        const frame = await this.text().catch(() => '')
        throw new Error(`${this.label} did not exit after /exit; last frame: ${JSON.stringify(frame.slice(-2000))}`)
      }
      await sleep(100)
    }
  }
}

class PublicDaemon implements PublicDaemonLaunch {
  readonly launchId: string
  readonly label: string
  readonly profile: string
  readonly alias: string | null
  readonly sessionId: string
  readonly launchCwd: string
  readonly backend: PublicDaemonBackend | null
  readonly shellPid: number | null
  readonly shellBirth: string | null
  readonly shellTty: { platform: string; eTdev?: number; ttyNr?: number } | null
  readonly cli: PublicProcessIdentity | null
  readonly client: PublicProcessIdentity | null
  readonly host: PublicDaemonHostFacts | null
  readonly hostAttempt: PublicDaemonHostFacts | null
  readonly registryAbsentBefore: boolean
  readonly registryAbsentAfter: boolean
  readonly ready: boolean
  readonly refused: boolean
  readonly surface: PublicDaemonSurfaceFacts | null
  readonly loaderRows: Array<{ id: string; disabled: boolean; state: unknown }> | null
  readonly herdr: PublicDaemonHerdrFacts | null
  readonly #scene: ProcessScene
  #closed = false
  #exitFacts: { code: number | null; signal: string | null } | undefined

  constructor(scene: ProcessScene, payload: Record<string, any>) {
    this.#scene = scene
    this.launchId = String(payload.launchId)
    this.label = String(payload.label)
    this.profile = String(payload.profile)
    this.alias = payload.alias === null || payload.alias === undefined ? null : String(payload.alias)
    this.sessionId = String(payload.sessionId)
    this.launchCwd = String(payload.launchCwd)
    this.backend = (payload.backend ?? null) as PublicDaemonBackend | null
    this.shellPid = payload.shellPid === null || payload.shellPid === undefined ? null : Number(payload.shellPid)
    this.shellBirth = payload.shellBirth === null || payload.shellBirth === undefined ? null : String(payload.shellBirth)
    this.shellTty = payload.shellTty ?? null
    this.cli = payload.cli ?? null
    this.client = payload.client ?? null
    this.host = payload.host ?? null
    this.hostAttempt = payload.hostAttempt ?? null
    this.registryAbsentBefore = payload.registryAbsentBefore === true
    this.registryAbsentAfter = payload.registryAbsentAfter === true
    this.ready = payload.ready === true
    this.refused = payload.refused === true
    this.surface = payload.surface ?? null
    this.loaderRows = payload.loaderRows ?? null
    this.herdr = payload.herdr ?? null
    if (payload.exit !== null && payload.exit !== undefined) {
      this.#exitFacts = { code: payload.exit.code ?? null, signal: payload.exit.signal ?? null }
    }
  }

  get closed(): boolean {
    return this.#closed
  }

  get exit(): { code: number | null; signal: string | null } | null {
    return this.#exitFacts ?? null
  }

  async type(text: string): Promise<void> {
    await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_INPUT', { input: { type: 'type', text } })
  }

  async press(...keys: string[]): Promise<void> {
    await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_INPUT', { input: { type: 'press', keys } })
  }

  async submit(text?: string): Promise<void> {
    await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_INPUT', {
      input: text === undefined ? { type: 'submit' } : { type: 'submit', text },
    })
  }

  async text(options: { full?: boolean } = {}): Promise<string> {
    const payload = await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_TEXT', {
      ...(options.full === true ? { full: true } : {}),
    })
    return String(payload.text)
  }

  async state(): Promise<PublicDaemonState> {
    return await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_STATE', {}) as PublicDaemonState
  }

  async kernelState(): Promise<PublicDaemonKernelState> {
    return await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_KERNEL_STATE', {}) as PublicDaemonKernelState
  }

  async waitForExit(timeoutMs = 120_000): Promise<{ code: number | null; signal: string | null; text: string }> {
    const started = Date.now()
    for (;;) {
      const state = await this.state()
      if (state.exited) {
        this.#exitFacts = { code: state.exitCode, signal: state.exitSignal }
        const text = await this.text({ full: true }).catch(() => '')
        return { ...this.#exitFacts, text }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`${this.label}: the public daemon launch did not exit within ${String(timeoutMs)}ms`)
      }
      await sleep(50)
    }
  }

  async close(): Promise<PublicDaemonLaunchFacts> {
    if (this.#closed) {
      return {
        launchId: this.launchId,
        label: this.label,
        profile: this.profile,
        alias: this.alias,
        sessionId: this.sessionId,
        launchCwd: this.launchCwd,
        backend: this.backend,
        shellPid: this.shellPid,
        shellBirth: this.shellBirth,
        shellTty: this.shellTty,
        cli: this.cli,
        client: this.client,
        host: this.host,
        hostAttempt: this.hostAttempt,
        registryAbsentBefore: this.registryAbsentBefore,
        registryAbsentAfter: this.registryAbsentAfter,
        ready: this.ready,
        refused: this.refused,
        exit: this.#exitFacts ?? null,
        surface: this.surface,
        loaderRows: this.loaderRows,
        herdr: this.herdr,
      }
    }
    const payload = await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_CLOSE', {})
    this.#closed = true
    this.#exitFacts = payload.exitCode === null || payload.exitCode === undefined
      ? this.#exitFacts
      : { code: Number(payload.exitCode), signal: payload.exitSignal ?? null }
    return {
      launchId: this.launchId,
      label: this.label,
      profile: this.profile,
      alias: this.alias,
      sessionId: this.sessionId,
      launchCwd: this.launchCwd,
      backend: this.backend,
      shellPid: this.shellPid,
      shellBirth: this.shellBirth,
      shellTty: this.shellTty,
      cli: this.cli,
      client: this.client,
      host: this.host,
      hostAttempt: this.hostAttempt,
      registryAbsentBefore: this.registryAbsentBefore,
      registryAbsentAfter: this.registryAbsentAfter,
      ready: this.ready,
      refused: this.refused,
      exit: this.#exitFacts ?? null,
      surface: this.surface,
      loaderRows: this.loaderRows,
      herdr: this.herdr,
    }
  }

  async reclaim(): Promise<PublicDaemonLaunchFacts> {
    if (this.#closed) return await this.close()
    const payload = await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_RECLAIM', {}, 240_000)
    this.#closed = true
    this.#exitFacts = payload.exitCode === null || payload.exitCode === undefined
      ? { code: null, signal: null }
      : { code: Number(payload.exitCode), signal: payload.exitSignal ?? null }
    return {
      launchId: this.launchId,
      label: this.label,
      profile: this.profile,
      alias: this.alias,
      sessionId: this.sessionId,
      launchCwd: this.launchCwd,
      backend: this.backend,
      shellPid: this.shellPid,
      shellBirth: this.shellBirth,
      shellTty: this.shellTty,
      cli: this.cli,
      client: this.client,
      host: this.host,
      hostAttempt: this.hostAttempt,
      registryAbsentBefore: this.registryAbsentBefore,
      registryAbsentAfter: this.registryAbsentAfter,
      ready: this.ready,
      refused: this.refused,
      exit: this.#exitFacts,
      surface: this.surface,
      loaderRows: this.loaderRows,
      herdr: this.herdr,
    }
  }

  async daemonStatus(): Promise<PublicDaemonStatusFacts> {
    return await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_STATUS', {}, 240_000) as PublicDaemonStatusFacts
  }

  async stopHost(): Promise<PublicDaemonHostFacts> {
    return await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_STOP', {}, 300_000) as PublicDaemonHostFacts
  }

  async signalCli(): Promise<{
    launchId: string
    pid: number
    birth: string
    signal: 'SIGTERM'
    outcome: PublicDaemonTermOrder
  }> {
    return await this.#scene.publicDaemonRequest(this.launchId, 'PUBLIC_DAEMON_TERMINATE_CLI', {}) as {
      launchId: string; pid: number; birth: string; signal: 'SIGTERM'; outcome: PublicDaemonTermOrder
    }
  }

  readHerdrInvocations(): Array<{ ppid: number; argv: string[] }> {
    const path = this.herdr?.logPath
    assert(path !== undefined && path !== '', `${this.label}: this launch has no controlled Herdr log`)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf8').split('\n')
    if (lines.at(-1) !== '') lines.pop()
    return lines.filter(line => line !== '').map((line) => {
      const [rawPpid, ...argv] = line.split('\t')
      const ppid = Number(rawPpid)
      assert(Number.isInteger(ppid) && ppid > 0, `${this.label}: the Herdr fake wrote a malformed line`)
      return { ppid, argv }
    })
  }
}

class ProcessScene implements SplitProcessScene {
  readonly runId: string
  readonly workDir: string
  readonly candidate: CandidateFacts
  readonly installation: SplitProcessInstallation
  readonly scope: SplitProcessScopeFacts
  readonly scopeDir: string
  readonly #supervisor: SupervisorClient
  readonly #tmpBase: string
  readonly #clients: ProcessClient[] = []
  readonly #publicLaunches: PublicDaemon[] = []

  constructor(
    facts: Record<string, any>,
    supervisor: SupervisorClient,
    runId: string,
    tmpBase: string,
  ) {
    this.runId = runId
    this.workDir = String(facts.workDir)
    this.candidate = facts.candidate as CandidateFacts
    this.installation = facts.installation as SplitProcessInstallation
    this.scope = facts.scope as SplitProcessScopeFacts
    this.scopeDir = join(this.installation.dshHome, 'run', 'dsh-pi-tui', this.scope.scopeId)
    this.#supervisor = supervisor
    this.#tmpBase = tmpBase
  }

  get supervisorPids(): { worker: number; supervisor: number | undefined } {
    return this.#supervisor.pids
  }

  get tmpBase(): string {
    return this.#tmpBase
  }

  async waitSupervisorExit(timeoutMs = 60_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return await this.#supervisor.waitExit(timeoutMs)
  }

  /** The durable receipt of THIS Scene, readable after the Supervisor exits. */
  async readSupervisorReceipt(): Promise<SupervisorReceipt> {
    const own = this.#ownReceipt()
    assert(own !== undefined, 'this Scene has no durable Supervisor receipt')
    return own
  }

  async request(type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    return await this.#supervisor.request(type, payload, { timeoutMs }) as Record<string, any>
  }

  async clientRequest(clientId: string, type: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    return await this.request(type, { clientId, ...payload }, type === 'CLOSE_PROCESS_CLIENT' ? 240_000 : 120_000)
  }

  async startHost(options: StartProcessHostOptions = {}): Promise<SplitProcessHostHandle> {
    const payload = await this.request('START_HOST', {
      ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
      ...(options.crashSignal === undefined ? {} : { crashSignal: options.crashSignal }),
      ...(options.shellCompletionLocality === undefined ? {} : { shellCompletionLocality: options.shellCompletionLocality }),
      ...(options.holdTool === undefined ? {} : { holdTool: options.holdTool }),
      ...(options.holdChild === undefined ? {} : { holdChild: options.holdChild }),
      ...(options.questionEligibility === undefined ? {} : { questionEligibility: options.questionEligibility }),
      ...(options.timedQuestion === undefined ? {} : { timedQuestion: options.timedQuestion }),
      ...(options.cancelAgent === undefined ? {} : { cancelAgent: options.cancelAgent }),
      ...(options.goalArmed === undefined ? {} : { goalArmed: options.goalArmed }),
      ...(options.unownedJob === undefined ? {} : { unownedJob: options.unownedJob }),
      ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    }, 600_000)
    const host: SplitProcessHostHandle = {
      hostId: String(payload.hostId),
      entryId: String(payload.hostId),
      generation: Number(payload.generation),
      ready: payload.ready as Record<string, any>,
      workRoot: String(payload.workRoot),
      scopeId: String(payload.scopeId),
      pgid: payload.pgid === null || payload.pgid === undefined ? null : Number(payload.pgid),
      entryRealpath: String(payload.entryRealpath),
      scenario: payload.scenario ?? null,
      crashSignal: payload.crashSignal ?? null,
      workloadRoot: payload.workloadRoot ?? null,
      holdReleasePath: payload.holdReleasePath ?? null,
      jobWorkRoot: payload.jobWorkRoot ?? null,
      toolReleasePath: payload.toolReleasePath ?? null,
      childReleasePath: payload.childReleasePath ?? null,
      eligibilityBarrierPath: payload.eligibilityBarrierPath ?? null,
      timedAfterBarrierPath: payload.timedAfterBarrierPath ?? null,
      timedDuplicateBarrierPath: payload.timedDuplicateBarrierPath ?? null,
      timedExpiredBarrierPath: payload.timedExpiredBarrierPath ?? null,
      cancelAgentBarrierPath: payload.cancelAgentBarrierPath ?? null,
      goalPatchPath: payload.goalPatchPath ?? null,
      unownedJobArmPath: payload.unownedJobArmPath ?? null,
      unownedJobReleasePath: payload.unownedJobReleasePath ?? null,
      maintenanceReleasePath: payload.maintenanceReleasePath ?? null,
      scheduleDeletePath: payload.scheduleDeletePath ?? null,
      exited: false,
    }
    return host
  }

  #entryHandle(payload: Record<string, any>): EntryQualificationHandle {
    return {
      entryId: String(payload.entryId),
      kind: payload.kind as EntryQualificationHandle['kind'],
      label: String(payload.label),
      mode: payload.mode as EntryQualificationHandle['mode'],
      pid: Number(payload.pid),
      birth: payload.birth === null || payload.birth === undefined ? null : String(payload.birth),
      pgid: payload.pgid === null || payload.pgid === undefined ? null : Number(payload.pgid),
      scratch: payload.scratch === null || payload.scratch === undefined ? null : String(payload.scratch),
      barriers: (payload.barriers ?? {}) as Record<string, string>,
      ...(payload.coStarted === null || payload.coStarted === undefined ? {} : { coStarted: Number(payload.coStarted) }),
    }
  }

  async startHostAttempts(options: {
    mode: HostAttemptMode
    scratchTarget?: string
    signal?: 'SIGTERM' | 'SIGINT'
  }): Promise<HostAttemptHandle[]> {
    const payload = await this.request('START_HOST_ATTEMPTS', {
      mode: options.mode,
      ...(options.scratchTarget === undefined ? {} : { scratchTarget: options.scratchTarget }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, 240_000)
    const attempts = (payload.attempts as Record<string, any>[]).map(facts => {
      const handle = this.#entryHandle(facts) as HostAttemptHandle
      return Object.assign(handle, { kind: 'host-attempt' as const, mode: facts.mode as HostAttemptMode })
    })
    return attempts
  }

  async startQualificationClients(options: {
    mode: QualificationClientMode
    count?: number
    refusal?: DiscoveryRefusal
    foundationBarrier?: boolean
  }): Promise<QualificationClientHandle[]> {
    const payload = await this.request('START_QUALIFICATION_CLIENTS', {
      mode: options.mode,
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
      ...(options.foundationBarrier === undefined ? {} : { foundationBarrier: options.foundationBarrier }),
    }, 240_000)
    return (payload.clients as Record<string, any>[]).map(facts => {
      const handle = this.#entryHandle(facts) as QualificationClientHandle
      return Object.assign(handle, {
        kind: 'qualification-client' as const,
        mode: facts.mode as QualificationClientMode,
        ...(facts.refusal === null || facts.refusal === undefined ? {} : { refusal: facts.refusal as DiscoveryRefusal }),
      })
    })
  }

  async entryRecordFacts(handle: EntryQualificationHandle): Promise<EntryRecordFacts> {
    const payload = await this.request('ENTRY_RECORDS', { entryId: handle.entryId }, 60_000)
    return {
      entryId: String(payload.entryId),
      kind: String(payload.kind),
      mode: payload.mode === null || payload.mode === undefined ? null : String(payload.mode),
      pid: payload.pid === null || payload.pid === undefined ? null : Number(payload.pid),
      birth: payload.birth === null || payload.birth === undefined ? null : String(payload.birth),
      exited: payload.exited === true,
      exitCode: payload.exitCode === null || payload.exitCode === undefined ? null : Number(payload.exitCode),
      exitSignal: payload.exitSignal === null || payload.exitSignal === undefined ? null : String(payload.exitSignal),
      stderrMarkers: payload.stderrMarkers as EntryStderrMarkers,
      stderrBytes: Number(payload.stderrBytes),
      records: (payload.records ?? []) as EntryRecord[],
      ...(payload.crossHome === null || payload.crossHome === undefined
        ? {}
        : { crossHome: payload.crossHome as Record<string, any> }),
    }
  }

  async entryRecords(handle: EntryQualificationHandle): Promise<EntryRecord[]> {
    return (await this.entryRecordFacts(handle)).records
  }

  async waitEntryRecord(
    handle: EntryQualificationHandle,
    match: EntryRecordMatch,
    timeoutMs = 240_000,
  ): Promise<EntryRecord> {
    return await this.request('WAIT_ENTRY_RECORD', {
      entryId: handle.entryId,
      match,
      timeoutMs,
    }, timeoutMs + 30_000) as EntryRecord
  }

  async entryStatus(handle: QualificationClientHandle): Promise<EntryRecord> {
    return await this.request('QUALIFICATION_CLIENT_STATUS', { entryId: handle.entryId }, 90_000) as EntryRecord
  }

  async qualificationControl(
    handle: QualificationClientHandle,
    control: {
      op: 'qualification-host-foundation' | 'qualification-drop-websocket'
      requestId: string
      workspacePath?: string
      workspaceResume?: true
      schedule?: true
    },
  ): Promise<void> {
    await this.request('QUALIFICATION_CLIENT_CONTROL', {
      entryId: handle.entryId,
      control,
    }, 60_000)
  }

  async signalEntry(handle: EntryQualificationHandle | SplitProcessHostHandle, signal: EntrySignal | 'SIGHUP'): Promise<void> {
    await this.request('SIGNAL_ENTRY', { entryId: handle.entryId, signal }, 60_000)
  }

  async finishEntry(handle: EntryQualificationHandle | SplitProcessHostHandle): Promise<EntryTerminalFacts> {
    const terminal = await this.request('FINISH_ENTRY', { entryId: handle.entryId }, 600_000) as EntryTerminalFacts
    if ('hostId' in handle) {
      handle.exited = true
      handle.exitResult = { code: terminal.exit.code, signal: terminal.exit.signal as NodeJS.Signals | null }
    }
    return terminal
  }

  async acceptHostWinner(handle: HostAttemptHandle): Promise<SplitProcessHostHandle> {
    const payload = await this.request('ACCEPT_HOST_WINNER', { entryId: handle.entryId }, 120_000)
    const host: SplitProcessHostHandle = {
      hostId: String(payload.hostId),
      entryId: String(payload.entryId ?? payload.hostId),
      generation: Number(payload.generation),
      ready: payload.ready as Record<string, any>,
      workRoot: String(payload.workRoot),
      scopeId: String(payload.scopeId),
      pgid: payload.pgid === null || payload.pgid === undefined ? null : Number(payload.pgid),
      entryRealpath: String(payload.entryRealpath),
      exited: false,
    }
    return host
  }

  async runBootstrapCli(mode: 'inherited-host-role' | 'direct-help'): Promise<BootstrapCliFacts> {
    return await this.request('RUN_BOOTSTRAP_CLI', { mode }, 240_000) as BootstrapCliFacts
  }

  async setInstallationFault(
    fault: 'host-runtime-absent' | 'host-bootstrap-absent' | 'client-bootstrap-drift' | 'client-domain-module-absent',
  ): Promise<InstallFaultFacts> {
    return await this.request('SET_INSTALLATION_FAULT', { fault }, 180_000) as InstallFaultFacts
  }

  async restoreInstallation(): Promise<void> {
    await this.request('RESTORE_INSTALLATION', {}, 180_000)
  }

  async startIdentityWitness(kind: 'live-non-host' | 'linux-zombie'): Promise<IdentityWitnessHandle> {
    return await this.request('START_IDENTITY_WITNESS', { kind }, 120_000) as IdentityWitnessHandle
  }

  async finishIdentityWitness(handle: IdentityWitnessHandle): Promise<void> {
    await this.request('FINISH_IDENTITY_WITNESS', { entryId: handle.entryId }, 120_000)
  }

  async reclaimDiscoveredHost(client: QualificationClientHandle | SplitProcessClient): Promise<DiscoveredHostTerminalFacts> {
    return await this.request('RECLAIM_DISCOVERED_HOST',
      'clientId' in client ? { clientId: client.clientId } : { entryId: client.entryId },
      240_000) as DiscoveredHostTerminalFacts
  }

  async assertEntrySeatsFree(): Promise<void> {
    await this.request('ASSERT_ENTRY_SEATS_FREE', {}, 120_000)
  }

  releaseBarrier(handle: EntryQualificationHandle, name: string): void {
    const path = handle.barriers[name]
    assert(typeof path === 'string' && path !== '', `${handle.label}: no preallocated ${name} barrier`)
    const rel = relative(this.workDir, path)
    assert(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`),
      `${handle.label}: the ${name} barrier escapes the Scene root`)
    // The Supervisor preallocates this exact path. Re-prove the real parent is
    // still inside the Scene before writing; a symlinked parent must fail.
    const parent = realpathSync(dirname(path))
    const parentRel = relative(this.workDir, parent)
    assert(parentRel !== '..' && !parentRel.startsWith(`..${sep}`),
      `${handle.label}: the ${name} barrier parent escapes the Scene root`)
    // wx is the final-path decision: an existing file or dangling symlink
    // fails closed and is never followed.
    try {
      writeFileSync(path, 'release\n', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`${handle.label}: the ${name} barrier already exists`)
      }
      throw error
    }
  }

  async hostStatus(host: SplitProcessHostHandle): Promise<Record<string, any>> {
    assert(!host.exited, `Host ${host.hostId} is not alive`)
    return await this.request('HOST_STATUS', { hostId: host.hostId }, 60_000)
  }

  async stopHost(host: SplitProcessHostHandle): Promise<SplitProcessClientExitFacts> {
    assert(!host.exited, `Host ${host.hostId} is not alive`)
    const payload = await this.request('STOP_HOST', { hostId: host.hostId }, 120_000)
    host.exited = true
    host.exitResult = { code: payload.code ?? null, signal: payload.signal ?? null }
    assert(host.exitResult.code === 0 && host.exitResult.signal === null,
      `Host ${host.hostId} shutdown was ${JSON.stringify(host.exitResult)}`)
    return host.exitResult
  }

  #processClientPayload(options: StartProcessClientOptions): Record<string, unknown> {
    return {
      label: options.label,
      cwd: options.cwd,
      home: options.home,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.cols === undefined ? {} : { cols: options.cols }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
      ...(options.hmr === undefined ? {} : { hmr: options.hmr }),
      ...(options.dropPromptAck === undefined ? {} : { dropPromptAck: options.dropPromptAck }),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.startupStop === undefined ? {} : { startupStop: options.startupStop }),
      ...(options.expectedFailure === undefined ? {} : { expectedFailure: options.expectedFailure }),
      ...(options.privateRpcProof === undefined ? {} : { privateRpcProof: options.privateRpcProof }),
      ...(options.readAuthorityProof === undefined ? {} : { readAuthorityProof: options.readAuthorityProof }),
      ...(options.holdSerialize === undefined ? {} : { holdSerialize: options.holdSerialize }),
      ...(options.invalidWorkspacePath === undefined ? {} : { invalidWorkspacePath: options.invalidWorkspacePath }),
      ...(options.recoverFromHostId === undefined ? {} : { recoverFromHostId: options.recoverFromHostId }),
      ...(options.attachRecoveredHostId === undefined ? {} : { attachRecoveredHostId: options.attachRecoveredHostId }),
    }
  }

  async startClient(options: StartProcessClientOptions): Promise<SplitProcessClient> {
    if (options.startupStop !== undefined || options.expectedFailure !== undefined) {
      throw new Error('startClient: pre-ready stop/failure returns terminal-only facts; use startClientStop/startClientFailure')
    }
    const payload = await this.request('START_PROCESS_CLIENT', this.#processClientPayload(options), 600_000)
    const client = new ProcessClient(this, payload)
    this.#clients.push(client)
    return client
  }

  async startClientStop(
    options: StartProcessClientOptions & { startupStop: ProcessStartupStopStage },
  ): Promise<SplitProcessClientStopFacts> {
    return await this.request('START_PROCESS_CLIENT', this.#processClientPayload(options), 600_000) as SplitProcessClientStopFacts
  }

  async startClientFailure(
    options: StartProcessClientOptions & { expectedFailure: ProcessClientExpectedFailure },
  ): Promise<SplitProcessClientFailureFacts> {
    return await this.request('START_PROCESS_CLIENT', this.#processClientPayload(options), 600_000) as SplitProcessClientFailureFacts
  }

  async sendStalePeerResult(
    handle: QualificationClientHandle,
    kind: 'question' | 'approval',
  ): Promise<Record<string, any>> {
    return await this.request('PEER_SEND_STALE_RESULT', { entryId: handle.entryId, kind }, 90_000)
  }

  async startPublicDaemon(options: StartPublicDaemonOptions): Promise<PublicDaemonLaunch> {
    const payload = await this.request('START_PUBLIC_DAEMON', {
      label: options.label,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.alias === undefined ? {} : { alias: options.alias }),
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.cols === undefined ? {} : { cols: options.cols }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
      ...(options.surface === undefined ? {} : { surface: options.surface }),
      ...(options.loaderDump === undefined ? {} : { loaderDump: options.loaderDump }),
      ...(options.herdr === undefined ? {} : { herdr: options.herdr }),
      ...(options.replayCommand === undefined ? {} : { replayCommand: options.replayCommand }),
      ...(options.ownWorkspace === undefined ? {} : { ownWorkspace: options.ownWorkspace }),
    }, 600_000)
    const launch = new PublicDaemon(this, payload)
    this.#publicLaunches.push(launch)
    return launch
  }

  async startPublicDaemonColdPair(options: {
    launches: [PublicDaemonColdPairLaunchOptions, PublicDaemonColdPairLaunchOptions]
  }): Promise<PublicDaemonColdPair> {
    const payload = await this.request('START_PUBLIC_DAEMON_COLD_PAIR', {
      launches: options.launches,
    }, 900_000)
    const launches = (payload.launches ?? []).map((facts: Record<string, any>) => {
      const launch = new PublicDaemon(this, facts)
      this.#publicLaunches.push(launch)
      return launch
    })
    if (launches.length !== 2) throw new Error('START_PUBLIC_DAEMON_COLD_PAIR did not return two launch handles')
    return {
      pairId: String(payload.pairId),
      winner: payload.winner as PublicDaemonHostFacts,
      launches: launches as [PublicDaemonLaunch, PublicDaemonLaunch],
    }
  }

  async runPublicDaemonHeadless(options: {
    label: string
    backend: 'daemon'
    args?: PublicDaemonArgs
  }): Promise<{ exit: { code: number | null; signal: string | null }; text: string }> {
    return await this.request('PUBLIC_DAEMON_HEADLESS', {
      label: options.label,
      backend: options.backend,
      ...(options.args === undefined ? {} : { args: options.args }),
    }, 240_000) as { exit: { code: number | null; signal: string | null }; text: string }
  }

  async publicDaemonRequest(
    launchId: string,
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<Record<string, any>> {
    return await this.request(type, { launchId, ...payload }, timeoutMs) as Record<string, any>
  }

  async runPublicAuthorityControl(): Promise<Record<string, any>> {
    return await this.request('PUBLIC_AUTHORITY_CONTROL', {}, 300_000) as Record<string, any>
  }

  async publicDaemonParallelReady(launch: PublicDaemonLaunch): Promise<void> {
    const auditRunId = process.env[PARALLEL_AUDIT_ENV]
    if (auditRunId === undefined || auditRunId === '') return
    const pair = process.env[PARALLEL_AUDIT_PAIR_ENV]
    if (pair === undefined || pair === '') return
    if (pair !== 'public-daemon-entry') {
      throw new Error('publicDaemonParallelReady: SPLIT_VITEST_PARALLEL_AUDIT_PAIR must be public-daemon-entry')
    }
    assert(/^[A-Za-z0-9._-]+$/u.test(auditRunId), `INPUT_UNQUALIFIED: ${PARALLEL_AUDIT_ENV} must match [A-Za-z0-9._-]+`)
    assert(launch.ready && launch.host !== null && launch.cli !== null && launch.client !== null,
      'public-daemon-entry: the public launch is not ready with its Host/CLI/Client identities')
    const live = this.#livePublicProcess(launch.cli) && this.#livePublicProcess(launch.client)
      && this.#liveKernelIdentity(launch.host.pid, launch.host.birth, 'public Host') !== undefined
    assert(live, 'public-daemon-entry: the public launch identities are not fresh-live at the overlap checkpoint')
    await this.report('parallel-ready', {
      label: 'public-daemon-entry',
      runId: this.runId,
      workerPid: process.pid,
      sceneRoot: this.workDir,
      profileDir: this.installation.profileDir,
      dshHome: this.installation.dshHome,
      candidateSha256: this.candidate.candidateSha256,
      scopeId: this.scope.scopeId,
      launchId: launch.launchId,
      publicHostPid: launch.host.pid,
      publicHostBirth: launch.host.birth,
      publicHostInstanceId: launch.host.instanceId ?? null,
      publicCliPid: launch.cli.pid,
      publicCliBirth: launch.cli.birth,
      publicClientPid: launch.client.pid,
      publicClientBirth: launch.client.birth,
      shellPid: launch.shellPid,
      shellBirth: launch.shellBirth,
      sessionId: launch.sessionId,
      activeStartedAt: new Date().toISOString(),
    })
    const started = Date.now()
    for (;;) {
      const other = this.#findOtherParallelScene(auditRunId, 'host-file-completion')
      if (other !== undefined && this.#isReceiptSceneLive(other)) {
        this.#assertPublicParallelSeparation(other, launch)
        const ownReceipt = this.#ownReceipt()
        assert(ownReceipt !== undefined, 'public-daemon-entry: this Scene has no durable Supervisor receipt')
        if (this.#isReceiptSceneLive(ownReceipt)) {
          await this.report('parallel-overlap', {
            label: 'public-daemon-entry',
            otherRunId: other.runId,
            otherLabel: 'host-file-completion',
            otherHostPid: other.host?.pid ?? null,
            checkedAt: new Date().toISOString(),
          })
          return
        }
      }
      if (Date.now() - started >= 120_000) {
        throw new Error('public-daemon-entry: the host-file-completion Scene never reported a live parallel-ready checkpoint')
      }
      await sleep(100)
    }
  }

  async publicDaemonParallelRelease(): Promise<void> {
    const auditRunId = process.env[PARALLEL_AUDIT_ENV]
    if (auditRunId === undefined || auditRunId === '') return
    const pair = process.env[PARALLEL_AUDIT_PAIR_ENV]
    if (pair === undefined || pair === '') return
    if (pair !== 'public-daemon-entry') {
      throw new Error('publicDaemonParallelRelease: SPLIT_VITEST_PARALLEL_AUDIT_PAIR must be public-daemon-entry')
    }
    await this.report('parallel-released', { label: 'public-daemon-entry', activeEndedAt: new Date().toISOString() })
  }

  #livePublicProcess(identity: PublicProcessIdentity | null): boolean {
    if (identity === null) return false
    return this.#liveKernelIdentity(identity.pid, identity.birth, identity.entry) !== undefined
  }

  #assertPublicParallelSeparation(other: SupervisorReceipt, launch: PublicDaemonLaunch): void {
    const own = this.#ownReceipt()
    assert(own !== undefined, 'public-daemon-entry: this Scene has no durable Supervisor receipt')
    assert(launch.host !== null && launch.cli !== null && launch.client !== null,
      'public-daemon-entry: the public launch lost its identities')
    assert(other.sceneRoot !== this.workDir, 'the two parallel Scenes share a Scene root')
    assert(other.installation?.dshHome !== this.installation.dshHome, 'the two parallel Scenes share a DSH home')
    assert(other.installation?.profileDir !== this.installation.profileDir, 'the two parallel Scenes share a profile')
    assert(other.scope?.scopeId !== this.scope.scopeId, 'the two parallel Scenes share a Host scope/seat')
    const otherSeat = other.scope?.hostSeat?.path ?? other.scope?.hostSeat?.name
    const ownSeat = own.scope?.hostSeat?.path ?? own.scope?.hostSeat?.name
    assert(typeof otherSeat === 'string' && otherSeat !== ''
      && typeof ownSeat === 'string' && ownSeat !== ''
      && otherSeat !== ownSeat, 'the two parallel Scenes share the Host seat')
    assert(other.host?.pid !== launch.host.pid, 'the two parallel Scenes share a Host process')
    assert(other.worker?.pid !== own.worker?.pid, 'the two parallel Scenes share a Worker PID')
    assert(other.worker?.ppid === process.ppid && own.worker?.ppid === process.ppid,
      'a parallel Scene Worker is not a child of this Vitest main')
    assert(other.candidate?.sha256 === this.candidate.candidateSha256, 'the two parallel Scenes used different candidates')
    const internalClients = other.processClients ?? []
    assert(internalClients.length > 0, 'the host-file-completion Scene reported no Client')
    for (const entry of internalClients) {
      assert(entry.clientId !== launch.launchId, 'the two parallel Scenes share a Client identity')
      assert(entry.sessionId !== launch.sessionId, 'the two parallel Scenes share a native session')
      assert(entry.shellPid !== launch.shellPid, 'the two parallel Scenes share a native shell PID')
      assert(entry.shellPid !== launch.cli?.pid && entry.shellPid !== launch.client?.pid,
        'the two parallel Scenes share a public CLI/Client PID')
      for (const business of entry.businessIdentities ?? []) {
        assert(business.pid !== launch.cli?.pid && business.pid !== launch.client?.pid,
          'the two parallel Scenes share a public CLI/Client business PID')
      }
    }
  }

  async sessionIds(): Promise<string[]> {
    return listSessionIds(this.installation.dshHome)
  }

  async publicScopeState(): Promise<PublicScopeStateFacts> {
    return await this.request('PUBLIC_SCOPE_STATE', {}, 60_000) as PublicScopeStateFacts
  }

  sessionEvents(sessionId: string): SessionEvent[] | undefined {
    return sessionsModule.hostSessionEvents(this.installation.dshHome, sessionId)
  }

  hostSessionLogCount(): number {
    return sessionsModule.hostSessionLogCount(this.installation.dshHome)
  }

  async waitForNewSessionId(before: ReadonlySet<string>, label: string, timeoutMs = 120_000): Promise<string> {
    const started = Date.now()
    for (;;) {
      const added = listSessionIds(this.installation.dshHome).filter(id => !before.has(id))
      if (added.length === 1) return added[0]!
      if (added.length > 1) {
        throw new Error(`${label}: ${String(added.length)} new Host Sessions appeared: ${JSON.stringify(added)}`)
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`${label}: no new Host Session appeared within ${String(timeoutMs)}ms`)
      }
      await sleep(50)
    }
  }

  async waitForHostSessionHeader(sessionId: string, label: string, timeoutMs = 120_000): Promise<SessionEvent> {
    return await sessionsModule.waitForHostSessionHeader(this.installation.dshHome, sessionId, label, timeoutMs)
  }

  async waitForSessionEvent(
    sessionId: string,
    afterIndex: number,
    predicate: (event: SessionEvent) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<SessionEvent> {
    return await sessionsModule.waitForHostSessionEventAfter(
      this.installation.dshHome, sessionId, afterIndex, predicate, label, timeoutMs)
  }

  async report(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.request('REPORT', { event, detail }, 30_000)
  }

  async parallelReady(
    label: 'host-file-completion' | 'preset-defaults' | 'public-daemon-entry',
    host: SplitProcessHostHandle,
    client: SplitProcessClient,
  ): Promise<void> {
    const auditRunId = process.env[PARALLEL_AUDIT_ENV]
    if (auditRunId === undefined || auditRunId === '') return
    const pair = process.env[PARALLEL_AUDIT_PAIR_ENV]
    if (pair !== undefined && pair !== 'public-daemon-entry') {
      throw new Error(`INPUT_UNQUALIFIED: ${PARALLEL_AUDIT_PAIR_ENV} has an unknown value ${JSON.stringify(pair)}`)
    }
    const publicPair = pair === 'public-daemon-entry'
    if (publicPair && label !== 'host-file-completion') {
      throw new Error(`${String(label)}: the public-daemon-entry audit pair is host-file-completion + public-daemon-entry only`)
    }
    assert(/^[A-Za-z0-9._-]+$/u.test(auditRunId), `INPUT_UNQUALIFIED: ${PARALLEL_AUDIT_ENV} must match [A-Za-z0-9._-]+`)
    const ownHostStatus = await this.hostStatus(host)
    const ownState = await client.state()
    assert(ownState.exited === false && ownState.sessionListed === true,
      `${label}: this Scene's Client is not live at the parallel-ready checkpoint`)
    await this.report('parallel-ready', {
      label,
      runId: this.runId,
      workerPid: process.pid,
      sceneRoot: this.workDir,
      profileDir: this.installation.profileDir,
      dshHome: this.installation.dshHome,
      candidateSha256: this.candidate.candidateSha256,
      scopeId: this.scope.scopeId,
      hostId: host.hostId,
      hostPid: host.ready?.localHost?.hostPid ?? null,
      hostPidLive: ownHostStatus?.pid ?? null,
      clientId: client.clientId,
      clientSessionId: client.sessionId,
      clientBusinessPid: client.ready?.businessPid ?? null,
      clientShellPid: client.ready?.shellPid ?? null,
      activeStartedAt: new Date().toISOString(),
    })
    const otherLabel = publicPair ? 'public-daemon-entry' : (label === 'host-file-completion' ? 'preset-defaults' : 'host-file-completion')
    const started = Date.now()
    for (;;) {
      const other = this.#findOtherParallelScene(auditRunId, otherLabel)
      if (other !== undefined) {
        if (otherLabel === 'public-daemon-entry') this.#assertPublicCounterpartSeparation(other, host, client)
        else this.#assertParallelSeparation(other, host, client)
        const ownReceipt = this.#ownReceipt()
        assert(ownReceipt !== undefined, `${label}: this Scene has no durable Supervisor receipt`)
        // A kernel read can be transiently unavailable under system load; the
        // STATIC missing birth still fails, while an unreadable live PID keeps
        // polling within this bounded overlap window.
        if (this.#isReceiptSceneLive(other) && this.#isReceiptSceneLive(ownReceipt)) {
          // Re-check THIS Scene after the other side was observed: both live
          // intervals genuinely intersect.
          await this.hostStatus(host)
          const after = await client.state()
          assert(after.exited === false && after.sessionListed === true,
            `${label}: this Scene's Client stopped during the overlap check`)
          await this.report('parallel-overlap', {
            label,
            otherRunId: other.runId,
            otherLabel,
            otherHostPid: other.host?.pid ?? null,
            checkedAt: new Date().toISOString(),
          })
          return
        }
      }
      if (Date.now() - started >= 120_000) {
        throw new Error(`${label}: the other split-process Scene never reported a live parallel-ready checkpoint`)
      }
      await sleep(100)
    }
  }

  async parallelRelease(label: 'host-file-completion' | 'preset-defaults' | 'public-daemon-entry'): Promise<void> {
    const auditRunId = process.env[PARALLEL_AUDIT_ENV]
    if (auditRunId === undefined || auditRunId === '') return
    await this.report('parallel-released', { label, activeEndedAt: new Date().toISOString() })
  }

  #receipts(): SupervisorReceipt[] {
    const root = join(this.#tmpBase, 'split-resources')
    if (!existsSync(root)) return []
    const receipts: SupervisorReceipt[] = []
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json')) continue
      try {
        receipts.push(JSON.parse(readFileSync(join(root, name), 'utf8')) as SupervisorReceipt)
      } catch {
        // An atomic rename means a parsed failure is a foreign/incomplete file,
        // never this run's durable receipt.
      }
    }
    return receipts
  }

  #findOtherParallelScene(auditRunId: string, otherLabel: string): SupervisorReceipt | undefined {
    return this.#receipts().find(receipt => receipt.kind === 'process'
      && receipt.parentRunId === auditRunId
      && receipt.runId !== this.runId
      && typeof receipt.sceneRoot === 'string'
      && (receipt.notes ?? []).some(note => note?.event === 'parallel-ready' && note.detail?.label === otherLabel))
  }

  #assertParallelSeparation(other: SupervisorReceipt, host: SplitProcessHostHandle, client: SplitProcessClient): void {
    const own = this.#ownReceipt()
    assert(own !== undefined, 'this parallel Scene has no durable Supervisor receipt')
    assert(other.sceneRoot !== this.workDir, 'the two parallel Scenes share a Scene root')
    assert(other.installation?.dshHome !== this.installation.dshHome, 'the two parallel Scenes share a DSH home')
    assert(other.installation?.profileDir !== this.installation.profileDir, 'the two parallel Scenes share a profile')
    assert(other.scope?.scopeId !== this.scope.scopeId, 'the two parallel Scenes share a Host scope/seat')
    const otherSeat = other.scope?.hostSeat?.path ?? other.scope?.hostSeat?.name
    const ownSeat = own.scope?.hostSeat?.path ?? own.scope?.hostSeat?.name
    assert(typeof otherSeat === 'string' && otherSeat !== ''
      && typeof ownSeat === 'string' && ownSeat !== ''
      && otherSeat !== ownSeat, 'the two parallel Scenes share the Host seat')
    assert(other.host?.pid !== host.ready?.localHost?.hostPid, 'the two parallel Scenes share a Host process')
    assert(other.worker?.pid !== own.worker?.pid, 'the two parallel Scenes share a Worker PID')
    // Both real Workers of one audit are children of THIS Vitest main; the PPID
    // is shared by design, and #isReceiptSceneLive re-proves the live edge.
    assert(other.worker?.ppid === process.ppid && own.worker?.ppid === process.ppid,
      'a parallel Scene Worker is not a child of this Vitest main')
    // The serialized birth is the start timestamp; on Linux two distinct
    // processes started in the same clock tick carry the same string. The
    // live check below binds each birth to its own PID, so PID inequality plus
    // per-PID liveness is the process-identity separation.
    assert(other.candidate?.sha256 === this.candidate.candidateSha256, 'the two parallel Scenes used different candidates')
    const otherClients = other.processClients ?? []
    assert(otherClients.length > 0, 'the other parallel Scene reported no Client')
    const ownClient = own.processClients?.find(value => value.clientId === client.clientId)
    assert(ownClient !== undefined, 'this parallel Scene Client is missing from its receipt')
    for (const entry of otherClients) {
      assert(entry.clientId !== client.clientId, 'the two parallel Scenes share a Client identity')
      assert(entry.sessionId !== client.sessionId, 'the two parallel Scenes share a native session')
      assert(typeof entry.scratch === 'string' && entry.scratch !== ''
        && typeof ownClient.scratch === 'string' && ownClient.scratch !== ''
        && entry.scratch !== ownClient.scratch, 'the two parallel Scenes share a Client scratch')
      for (const business of entry.businessIdentities ?? []) {
        for (const ownEntry of own.processClients ?? []) {
          assert(business.pid !== ownEntry.shellPid, 'the two parallel Scenes share a Client shell/business PID')
          for (const ownBusiness of ownEntry.businessIdentities ?? []) {
            assert(business.pid !== ownBusiness.pid,
              'the two parallel Scenes share a business Client process')
          }
        }
      }
    }
  }

  #assertPublicCounterpartSeparation(
    other: SupervisorReceipt,
    host: SplitProcessHostHandle,
    client: SplitProcessClient,
  ): void {
    const own = this.#ownReceipt()
    assert(own !== undefined, 'host-file-completion: this Scene has no durable Supervisor receipt')
    assert(other.sceneRoot !== this.workDir, 'the two parallel Scenes share a Scene root')
    assert(other.installation?.dshHome !== this.installation.dshHome, 'the two parallel Scenes share a DSH home')
    assert(other.installation?.profileDir !== this.installation.profileDir, 'the two parallel Scenes share a profile')
    assert(other.scope?.scopeId !== this.scope.scopeId, 'the two parallel Scenes share a Host scope/seat')
    const otherSeat = other.scope?.hostSeat?.path ?? other.scope?.hostSeat?.name
    const ownSeat = own.scope?.hostSeat?.path ?? own.scope?.hostSeat?.name
    assert(typeof otherSeat === 'string' && otherSeat !== ''
      && typeof ownSeat === 'string' && ownSeat !== ''
      && otherSeat !== ownSeat, 'the two parallel Scenes share the Host seat')
    assert(other.host?.pid !== host.ready?.localHost?.hostPid, 'the two parallel Scenes share a Host process')
    assert(other.worker?.pid !== own.worker?.pid, 'the two parallel Scenes share a Worker PID')
    assert(other.worker?.ppid === process.ppid && own.worker?.ppid === process.ppid,
      'a parallel Scene Worker is not a child of this Vitest main')
    assert(other.candidate?.sha256 === this.candidate.candidateSha256, 'the two parallel Scenes used different candidates')
    const launches = other.publicLaunches ?? []
    const launch = launches.find(value => value.readyAt !== undefined && value.host !== null && value.cli !== null && value.client !== null)
    assert(launch !== undefined, 'the public-daemon-entry counterpart reported no ready public launch')
    const hostIdentity = this.#liveKernelIdentity(launch.host?.pid, launch.host?.birth, 'public Host')
    const cliIdentity = this.#liveKernelIdentity(launch.cli?.pid, launch.cli?.birth, 'public CLI')
    const clientIdentity = this.#liveKernelIdentity(launch.client?.pid, launch.client?.birth, 'public Client')
    assert(hostIdentity !== undefined && cliIdentity !== undefined && clientIdentity !== undefined,
      'the public-daemon-entry counterpart identities are not fresh-live at the overlap checkpoint')
    assert(launch.host?.pid !== host.ready?.localHost?.hostPid, 'the two parallel Scenes share a public Host PID')
    assert(launch.cli?.pid !== client.ready.businessPid && launch.client?.pid !== client.ready.businessPid,
      'the two parallel Scenes share a business Client PID')
    assert(launch.shellPid !== client.ready.shellPid, 'the two parallel Scenes share a native shell PID')
    assert(launch.sessionId !== client.sessionId, 'the two parallel Scenes share a native session')
  }

  #ownReceipt(): SupervisorReceipt | undefined {
    return this.#receipts().find(receipt => receipt.runId === this.runId)
  }

  /** The fresh live kernel identity of one captured PID/birth, or undefined. */
  #liveKernelIdentity(
    pid: number | null | undefined,
    birth: string | undefined,
    label: string,
  ): KernelProcessIdentity | undefined {
    assert(typeof pid === 'number' && Number.isInteger(pid) && pid > 0, `${label}: no real PID`)
    assert(typeof birth === 'string' && birth !== '', `${label}: no recorded kernel birth`)
    const observation = readKernelProcess(pid)
    if (observation.kind !== 'alive') return undefined
    if (nativeContract.classifyKernelLiveness(observation).state !== 'alive') return undefined
    return nativeContract.serializeKernelIdentity(observation.identity) === birth
      ? observation.identity
      : undefined
  }

  #isSameLiveKernel(pid: number | null | undefined, birth: string | undefined, label: string): boolean {
    return this.#liveKernelIdentity(pid, birth, label) !== undefined
  }

  /**
   * Re-prove the receipt names live, still-same kernel identities: both real
   * Workers, the Host and every Client shell/business process. A Worker must
   * still be a live child of THIS Vitest main (the same parent edge the receipt
   * recorded), so a dead Worker whose Host/Clients survive is not mistaken for
   * the live Scene.
   */
  #isReceiptSceneLive(other: SupervisorReceipt): boolean {
    assert(other.worker !== undefined, 'the parallel Scene receipt has no Worker identity')
    const worker = this.#liveKernelIdentity(other.worker.pid, other.worker.birth,
      'the parallel Scene Worker')
    if (worker === undefined || worker.platform === 'win32') return false
    assert(other.worker.ppid === process.ppid && worker.ppid === process.ppid,
      'the parallel Scene Worker is not a live child of this Vitest main')
    let live: boolean
    if (other.host !== undefined) {
      live = this.#isSameLiveKernel(other.host.pid, other.host.birth, 'the parallel Scene Host')
    } else {
      const publicHosts = other.publicHosts ?? []
      if (publicHosts.length === 0) return false
      live = publicHosts.every(host => this.#isSameLiveKernel(host.pid, host.birth,
        'the parallel public Host'))
    }
    for (const entry of other.processClients ?? []) {
      live = this.#isSameLiveKernel(entry.shellPid, entry.shellBirth,
        'the parallel Scene Client shell') && live
      for (const business of entry.businessIdentities ?? []) {
        live = this.#isSameLiveKernel(business.pid, business.birth,
          'the parallel Scene Client business process') && live
      }
    }
    for (const launch of other.publicLaunches ?? []) {
      for (const [kind, identity] of [['CLI', launch.cli], ['Client', launch.client]] as const) {
        if (identity === null || identity === undefined) continue
        live = this.#isSameLiveKernel(identity.pid, identity.birth,
          `the parallel public ${kind}`) && live
      }
      if (launch.shellPid !== null && launch.shellPid !== undefined) {
        live = this.#isSameLiveKernel(launch.shellPid, launch.shellBirth ?? undefined,
          'the parallel public shell') && live
      }
    }
    return live
  }

  /**
   * Normal teardown: close every Client the test left open (graceful /exit only
   * with a proven current non-destructive choice), then let the Supervisor own
   * the final proof and root removal. Cleanup failures are returned, never
   * swallowed.
   */
  async dispose(): Promise<void> {
    const errors: Error[] = []
    for (const client of [...this.#clients].reverse()) {
      if (client.closed) continue
      if (client.terminalKind === 'business-hangup' || client.terminalKind === 'host-replacement-refusal') {
        // These modes have no normal `/exit` path: only their real terminal may
        // be closed with the declared contract. An unqualified one stays owned
        // by the Supervisor's FINALIZE compensation.
        const state = await client.state().catch(() => undefined)
        if (state?.exited === true) {
          try {
            await client.close()
          } catch (error) {
            errors.push(asError(error))
          }
        }
        continue
      }
      try {
        await client.exitGracefully()
      } catch (error) {
        errors.push(asError(error))
      }
    }
    for (const launch of [...this.#publicLaunches].reverse()) {
      if (launch.closed) continue
      try {
        await launch.reclaim()
      } catch (error) {
        errors.push(asError(error))
      }
    }
    const clientsClosed = this.#clients.every(client => client.closed)
      && this.#publicLaunches.every(launch => launch.closed)
      && errors.length === 0
    try {
      await this.request('FINALIZE', { clientsClosed }, 240_000)
    } catch (error) {
      errors.push(new Error(`Supervisor FINALIZE failed: ${asError(error).message}`))
    }
    try {
      const exit = await this.#supervisor.waitExit(60_000)
      if (exit.code !== 0 || exit.signal !== null) {
        errors.push(new Error(`Supervisor exited abnormally: ${JSON.stringify(exit)}`))
      }
    } catch (error) {
      errors.push(asError(error))
    }
    if (errors.length > 0) {
      throw new AggregateError(errors,
        `split-process Scene cleanup failed with ${String(errors.length)} error(s): ${errors.map(error => error.message).join(' | ')}; evidence root: ${this.workDir}`)
    }
  }
}

async function createScene(): Promise<ProcessScene> {
  const tmpBase = requireAbsoluteDirectory('SPLIT_VITEST_TMP_BASE')
  const tarball = requireCandidateTarball()
  const candidate = profileModule.inspectImmutableSplitCandidate(tarball)
  const parentRunId = process.env.SPLIT_VITEST_RUN_ID ?? process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID
  const runId = `split-process-${randomUUID()}`
  const supervisor = new SupervisorClient({ runId })
  try {
    const facts = await supervisor.request('BOOTSTRAP_PROCESS', {
      tarball: candidate.tarball,
      expectedSha256: candidate.candidateSha256,
      tmpBase,
      workerPid: process.pid,
      workerPpid: process.ppid,
      sceneId: runId,
      ...(parentRunId === undefined || parentRunId === '' ? {} : { parentRunId }),
    }, { timeoutMs: 1_200_000 }) as Record<string, any>
    return new ProcessScene(facts, supervisor, runId, tmpBase)
  } catch (error) {
    try {
      await supervisor.close({ timeoutMs: 300_000, allowKill: false })
    } catch (closeError) {
      throw new AggregateError([error, closeError],
        'BOOTSTRAP_PROCESS failed and the Supervisor did not reach a bounded exit')
    }
    throw error
  }
}

/**
 * Create the ONE typed Scene of a business file.
 *
 * A file owns exactly one Scene and must `dispose()` it; each worker gets a
 * unique Supervisor receipt and a unique Scene root under the run's private
 * base.
 */
export async function createSplitProcessScene(): Promise<SplitProcessScene> {
  return await createScene()
}

const CLIENT_CLOSE_OWNER_KEYS = ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs'] as const

/**
 * Business-level Keep disconnect: clear any draft, submit `/exit`, take the
 * default Keep row only when the CURRENT painted frame shows the busy exit
 * choice, then require normal native close (0/null) and a zero-owner
 * `client-closed` product record. Distinct from teardown-only `exitGracefully`.
 */
export async function keepAndDisconnect(client: SplitProcessClient, label: string): Promise<void> {
  await client.press('Ctrl+U')
  await client.submit('/exit')
  const deadline = Date.now() + 60_000
  let choiceTaken = false
  for (;;) {
    const state = await client.state().catch(() => undefined)
    if (state !== undefined && state.exited) break
    if (!choiceTaken) {
      const frame = await client.text().catch(() => '')
      if (frame.includes('Disconnect from dsh-pi-tui') && frame.includes('> Keep working and disconnect')) {
        await client.press('Enter')
        choiceTaken = true
      }
    }
    if (Date.now() >= deadline) {
      const frame = await client.text().catch(() => '')
      throw new Error(`${label}: did not exit after /exit; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
  const closed = await client.close()
  if (closed.code !== 0 || closed.signal !== null) {
    throw new Error(`${label}: Supervisor Keep close exited with ${JSON.stringify(closed)}`)
  }
  const inventory = readOfficialClientRecords(client.recordFile, client.label)
    .filter(record => record.m4b2s === 'client-closed')
    .at(-1)
  if (inventory === undefined) {
    throw new Error(`${label}: official close inventory missing`)
  }
  for (const owner of CLIENT_CLOSE_OWNER_KEYS) {
    if (inventory.owners?.[owner] !== 0) {
      throw new Error(`${label}: ${owner} owner remains (${String(inventory.owners?.[owner])})`)
    }
  }
}

export type { SessionEvent }
