/**
 * Read-only Host-liveness observation foundation for the M4 split Host.
 *
 * The observer answers one question over the REAL Host services that are
 * actually mounted: can this process positively observe current work or a
 * future keepalive obligation, and which sources cannot be observed at all?
 * It never drives business work, never owns a Session or Job record, never
 * polls, and never authorizes a Host shutdown. A snapshot is a transient
 * observation with a volatile epoch; C2-C still needs its own admission and
 * drain authority before any automatic lifecycle decision.
 *
 * Sources and their authority:
 *
 * ```text
 * agent    DSH AgentRegistry.list() + Agent.status + inbox depths
 * goal     DSH GoalService.get(agent) (only when the service is mounted)
 * jobs     DSH JobRegistry.list() + list(owner) + jobs.events({owners:'all'})
 * schedule DSH ScheduleService.catalog() (only when the service is mounted)
 * pending  rc.4 has no public pending enumeration: UNKNOWN while Gateway is live
 * write    rc.4 has no process-wide in-flight write inventory: UNKNOWN while
 *          the Session persistence owner is live
 * other    active Loader rows outside the official/xmoon namespaces are
 *          unqualified autonomous Host sources
 * ```
 *
 * A source that was mounted and later disappears is UNKNOWN, never ABSENT:
 * only a service that never appeared in this Host process is ABSENT.
 *
 * Deliberately not covered here (C2-C admission gaps, not per-snapshot proof):
 * an Agent create/resume before its registry publication, a Job producer's
 * synchronous window before `registered`, plugin-internal timers, and
 * process-wide write flushes. The snapshot reports the resulting coverage gaps
 * as reasons/states; it never turns them into idle.
 *
 * @module app/remote-process/host-activity
 */

import type { Context } from '@deepseek-ai/cordis'

/** The three-state answer; `OBSERVED_QUIESCENT` is never a shutdown authorization. */
export type ActivityVerdict = 'BLOCKED' | 'OBSERVED_QUIESCENT' | 'UNKNOWN'

/** One per-source availability fact. */
export type HostActivitySourceState = 'ACTIVE' | 'IDLE' | 'ABSENT' | 'UNKNOWN'

/** Stable diagnostic reasons. A reason never carries a body, id or path. */
export type ActivityReason =
  | 'agent-running'
  | 'agent-inbox'
  | 'agent-maintenance-unproven'
  | 'goal-armed'
  | 'job-running'
  | 'job-stopping'
  | 'child-active'
  | 'pending-interaction-unobservable'
  | 'schedule-active'
  | 'source-unavailable'
  | 'unqualified-host-source'
  | 'inflight-write-unproven'
  | 'observation-changed'

/** Every source key always present in a snapshot. */
export const HOST_ACTIVITY_SOURCES = [
  'agent',
  'jobs',
  'goal',
  'schedule',
  'pending',
  'write',
  'other',
] as const

/** One source key of {@link HostActivitySnapshot.sourceStates}. */
export type HostActivitySource = (typeof HOST_ACTIVITY_SOURCES)[number]

/** One transient, read-only observation of the split Host. */
export interface HostActivitySnapshot {
  /** Diagnostic priority: BLOCKED wins over UNKNOWN, and UNKNOWN over quiescence. */
  readonly verdict: ActivityVerdict
  /** Volatile observation invalidation sequence; never a durable work ledger. */
  readonly epoch: number
  /** Deduplicated diagnostic reasons, in source evaluation order. */
  readonly reasons: readonly ActivityReason[]
  /** Per-source current-window state. */
  readonly sourceStates: Readonly<Record<HostActivitySource, HostActivitySourceState>>
}

/** The Host-entry-owned observer handle. */
export interface HostLivenessObserver {
  /** Read one bounded, current snapshot. Never throws for a failing source. */
  snapshot(): Promise<HostActivitySnapshot>
  /** Release every event subscription synchronously. Idempotent. */
  close(): void
}

/** Default deadline for one snapshot inside the serialized status control path. */
export const HOST_ACTIVITY_OBSERVATION_DEADLINE_MS = 3_000

/** Constructor options; the deadline exists so the control queue cannot be held forever. */
export interface HostActivityObserverOptions {
  readonly observationDeadlineMs?: number
}

/** Minimal structural Agent contract this observer reads (no Host package import). */
interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly inbox: {
    readonly nextTurn: readonly unknown[]
    readonly nextStep: readonly unknown[]
  }
}

/** Minimal structural AgentRegistry contract. */
interface AgentRegistryLike {
  list(): readonly AgentLike[]
  roots?(): readonly AgentLike[]
}

/** Minimal structural Job projection the observer classifies. */
interface JobViewLike {
  readonly id: string
  readonly status: string
}

/** Minimal structural Job event payload. */
interface JobEventLike {
  readonly type: string
  readonly job?: JobViewLike
}

/** Minimal structural JobRegistry contract. */
interface JobRegistryLike {
  list(caller?: string): readonly JobViewLike[]
  readonly events: {
    subscribe(
      filter: { readonly owners: 'all' },
      listener: (event: JobEventLike) => void,
    ): () => void
  }
}

/** Minimal structural Goal view; only phase and process-local activation matter. */
interface GoalViewLike {
  readonly phase: string
  readonly activation: string
}

/** Minimal structural GoalService contract. */
interface GoalServiceLike {
  get(agent: unknown): GoalViewLike | undefined
}

/** Minimal structural Schedule catalog row. */
interface ScheduleCatalogEntryLike {
  readonly status: 'active' | 'inactive'
}

/** Minimal structural ScheduleService contract. */
interface ScheduleServiceLike {
  catalog(): Promise<readonly ScheduleCatalogEntryLike[]>
}

/** Minimal structural Loader row. */
interface LoaderEntryLike {
  readonly options?: {
    readonly id?: string
    readonly name?: string
    readonly disabled?: boolean
  }
  readonly fiber?: { readonly state?: number }
}

/** Minimal structural Loader contract. */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/** Cordis `FiberState` values used by Loader source qualification. */
const FIBER_PENDING = 0
const FIBER_LOADING = 1
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/**
 * Loader rows explicitly qualified as passive in the pinned stock Host
 * composition, bound to BOTH their row id and the exact plugin identity.
 * The map is the rc.4 Host-only roster that was reviewed as passive or as
 * belonging to one of the observer's own source families; `schedule` is
 * qualified when a profile mounts the official Schedule row. A row id reused
 * with a different plugin, an unknown active row, a custom plugin or a future
 * official autonomous service fails closed as an unqualified Host source.
 */
const QUALIFIED_HOST_ROWS: ReadonlyMap<string, string> = new Map(
  `include=cordis:include plugin-manager=@deepseek-ai/dsh-plugin-manager
timer=@deepseek-ai/cordis-plugin-timer hmr=@deepseek-ai/dsh-hmr
llm=@deepseek-ai/dsh-llm deepseek-llm-api-extensions=@deepseek-ai/dsh-deepseek-llm-api-extensions
session=@deepseek-ai/dsh-session session-log-deepseek=@deepseek-ai/dsh-session-log-deepseek
typert=@deepseek-ai/dsh-typert-registry typert-loader=@deepseek-ai/dsh-typert-loader
typert-gateway=@deepseek-ai/dsh-api-gateway remote-access=@deepseek-ai/dsh-api-remote-access
session-title=@deepseek-ai/dsh-session-title session-title-llm=@deepseek-ai/dsh-session-title-first-prompt-llm
user-questions=@deepseek-ai/dsh-user-questions agent=@deepseek-ai/dsh-agent
plugin-package-inventory-deepseek=@deepseek-ai/dsh-plugin-package-inventory-deepseek agent-default-model=@deepseek-ai/dsh-agent-default-model
jobs=@deepseek-ai/dsh-jobs-local llm-retry=@deepseek-ai/dsh-llm-retry
config-editor=@deepseek-ai/dsh-config-editor settings=@deepseek-ai/dsh-settings
authorization=@deepseek-ai/dsh-authorization deepseek-account=@deepseek-ai/dsh-deepseek-account-platform
credentials=@deepseek-ai/dsh-credentials-local llm-pi-ai=@deepseek-ai/dsh-llm-pi-ai
session-persistence-jsonl=@deepseek-ai/dsh-session-persistence-jsonl attachment-local=@deepseek-ai/dsh-attachment-local
session-query-sqlite=@deepseek-ai/dsh-session-query-sqlite working-directory=@deepseek-ai/dsh-working-directory
tool-working-directory=@deepseek-ai/dsh-tool-working-directory session-projection=@deepseek-ai/dsh-session-projection
storage=@deepseek-ai/dsh-storage storage-json=@deepseek-ai/dsh-storage-json
storage-domain=@deepseek-ai/dsh-storage-domain session-projection-cache=@deepseek-ai/dsh-session-projection-cache
otel=@deepseek-ai/dsh-otel session-telemetry-otel=@deepseek-ai/dsh-session-telemetry-otel
subprocess=@deepseek-ai/dsh-subprocess-local sandbox=@deepseek-ai/dsh-sandbox-local
sandbox-policy=@deepseek-ai/dsh-sandbox-policy bash-sandbox=@deepseek-ai/dsh-bash-sandbox
approval=@deepseek-ai/dsh-user-approval permission=@deepseek-ai/dsh-permission-presets
shell-env=@deepseek-ai/dsh-shell-env fs-observation-policy=@deepseek-ai/dsh-fs-observation-policy
skill=@deepseek-ai/dsh-skill commands=@deepseek-ai/dsh-commands
command-feedback=@deepseek-ai/dsh-command-feedback goal=@deepseek-ai/dsh-goal
goal-round-driver=@deepseek-ai/dsh-goal-round-driver token-meter=@deepseek-ai/dsh-token-meter
subagent=@deepseek-ai/dsh-subagent subagent-spawn-in-process=@deepseek-ai/dsh-subagent-spawn-in-process
subagent-fork-in-process=@deepseek-ai/dsh-subagent-fork-in-process ptc-runtime=@deepseek-ai/dsh-ptc-runtime-node
timeout-policy=@deepseek-ai/dsh-tool-call-timeout-policy spill-local=@deepseek-ai/dsh-spill-local
spill-policy=@deepseek-ai/dsh-spill-policy session-checkpoint-policy=@deepseek-ai/dsh-session-checkpoint-policy
image-offload=@deepseek-ai/dsh-compaction-image-offload repeat-tool-reminder=@deepseek-ai/dsh-repeat-tool-reminder
web=@deepseek-ai/dsh-web web-search-deepseek=@deepseek-ai/dsh-web-search-deepseek
web-deepseek-api=@deepseek-ai/dsh-web-deepseek-api web-fetch-http=@deepseek-ai/dsh-web-fetch-http
mcp-resources=@deepseek-ai/dsh-mcp-resources tools=@deepseek-ai/dsh-tools
system-prompt=@deepseek-ai/dsh-system-prompt agent-loop=@deepseek-ai/dsh-agent-loop
fs-sandbox=@deepseek-ai/dsh-fs-sandbox llm-deepseek=@deepseek-ai/dsh-llm-deepseek-api-key
llm-deepseek-account=@deepseek-ai/dsh-llm-deepseek-account tui-startup=@xmoon76/dsh-pi-tui/startup
pi-tui-performance-host=@xmoon76/dsh-pi-tui/performance-host workspace-files=@deepseek-ai/dsh-api-workspace-files
pi-tui-visual-tools=@xmoon76/dsh-pi-tui/visual-tools webserver=@deepseek-ai/dsh-host-webserver
job-controller=@deepseek-ai/dsh-api-job-controller workspace=@deepseek-ai/dsh-workspace
file-reference-local=@deepseek-ai/dsh-file-reference-local agent-preset-registry=@deepseek-ai/dsh-agent-preset-registry
subagent-model-selection-settings=@deepseek-ai/dsh-tool-subagent/model-selection-settings cordis-host-runner=@deepseek-ai/dsh-cordis-host-runner
preset-standard=@deepseek-ai/dsh-agent-preset preset-ptc=@deepseek-ai/dsh-agent-preset
preset-minimal=@deepseek-ai/dsh-agent-preset preset-cordis=@deepseek-ai/dsh-agent-preset
split-host-connection=@deepseek-ai/dsh-client-connection split-host-api-remotes=@deepseek-ai/dsh-api-remotes
split-host-file-upload=@deepseek-ai/dsh-client-file-upload split-host-session-stats=@deepseek-ai/dsh-session-stats
split-host-turn-outline=@deepseek-ai/dsh-session-turn-outline split-host-session-controller=@deepseek-ai/dsh-api-session-controller
split-host-settings-controller=@deepseek-ai/dsh-api-settings-controller split-host-session-log-download=@deepseek-ai/dsh-session-log-export
split-host-pi-tui-runtime=@xmoon76/dsh-pi-tui/host-runtime schedule=@deepseek-ai/dsh-schedule`.trim().split(/\s+/u).map(entry => {
    const separator = entry.indexOf('=')
    return [entry.slice(0, separator), entry.slice(separator + 1)] as const
  }),
)

/** Reasons that positively establish current work or a future keepalive obligation. */
const BLOCKING_REASONS: ReadonlySet<ActivityReason> = new Set([
  'agent-running',
  'agent-inbox',
  'goal-armed',
  'job-running',
  'job-stopping',
  'child-active',
  'schedule-active',
])

/** The dedicated timeout marker: a hung read is UNKNOWN, never an empty source. */
const OBSERVATION_TIMEOUT = Symbol('host-activity-observation-timeout')

/** Reject a source read after the caller's bound. */
async function withDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return operation
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(OBSERVATION_TIMEOUT) }, deadlineMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Build one ordered, deduplicated reason list. */
function reasonList(reasons: ReadonlySet<ActivityReason>): ActivityReason[] {
  return [...reasons]
}

/** A snapshot that claims nothing after the observer stopped reading. */
function closedSnapshot(epoch: number): HostActivitySnapshot {
  const sourceStates = Object.fromEntries(
    HOST_ACTIVITY_SOURCES.map(source => [source, 'UNKNOWN']),
  ) as Record<HostActivitySource, HostActivitySourceState>
  return {
    verdict: 'UNKNOWN',
    epoch,
    reasons: ['source-unavailable'],
    sourceStates,
  }
}

/**
 * The Host-process observer. Construction only subscribes to official live
 * signals and starts no work; snapshot() performs the reads.
 */
export class HostActivityObserver implements HostLivenessObserver {
  private readonly context: Context
  private readonly observationDeadlineMs: number
  private readonly subscriptions: Array<() => unknown> = []
  /** Short-lived active Job identity hints: official list reads stay authoritative. */
  private readonly jobHints = new Map<string, 'running' | 'stopping'>()
  /** Services observed in this Host process; a later absence is UNKNOWN, not ABSENT. */
  private readonly seenSources = new Set<HostActivitySource>()
  private currentEpoch = 0
  private closed = false

  constructor(context: Context, options: HostActivityObserverOptions = {}) {
    this.context = context
    this.observationDeadlineMs = options.observationDeadlineMs ?? HOST_ACTIVITY_OBSERVATION_DEADLINE_MS
    try {
      this.subscribe()
    } catch (error) {
      // Never leave a half-installed observer behind: a failed construction
      // releases the listeners it already registered and rethrows.
      this.closed = true
      for (const dispose of this.subscriptions.splice(0).reverse()) dispose()
      throw error
    }
  }

  /** Subscribe to the official change signals that invalidate a snapshot. */
  private subscribe(): void {
    const invalidate = (): void => { this.invalidate() }
    for (const event of [
      'agent/created',
      'agent/disposed',
      'agent/status',
      'agent/inbox/inserted',
      'agent/inbox/claimed',
      'agent/inbox/discarded',
      'goal/changed',
      'schedule/changed',
      'internal/status',
    ] as const) {
      this.subscriptions.push(this.context.on(event, invalidate))
    }
    const jobs = this.context.reflect.get('jobs') as JobRegistryLike | undefined
    if (jobs === undefined) return
    this.seenSources.add('jobs')
    this.subscriptions.push(jobs.events.subscribe({ owners: 'all' }, event => {
      // Output/progress do not change the registry's activity state.
      if (event.type === 'output' || event.type === 'progress') return
      const job = event.job
      if (job !== undefined) {
        if (event.type === 'registered') {
          this.jobHints.set(job.id, job.status === 'stopping' ? 'stopping' : 'running')
        } else if (event.type === 'stopping') {
          this.jobHints.set(job.id, 'stopping')
        } else if (event.type === 'settled' || event.type === 'removed') {
          this.jobHints.delete(job.id)
        }
      }
      this.invalidate()
    }))
  }

  /** Advance the epoch and refresh which services are currently mounted. */
  private invalidate(): void {
    if (this.closed) return
    this.currentEpoch += 1
    this.noteMountedSources()
  }

  /** Remember every source service seen in this process. */
  private noteMountedSources(): void {
    if (this.context.reflect.get('jobs') !== undefined) this.seenSources.add('jobs')
    if (this.context.reflect.get('goals') !== undefined) this.seenSources.add('goal')
    if (this.context.reflect.get('schedule') !== undefined) this.seenSources.add('schedule')
    if (this.context.reflect.get('typertGateway') !== undefined) this.seenSources.add('pending')
    if (this.context.reflect.get('sessionPersistence') !== undefined) this.seenSources.add('write')
  }

  /** Map a missing service to ABSENT (never mounted) or UNKNOWN (mounted earlier). */
  private unavailableState(source: HostActivitySource, reasons: Set<ActivityReason>): HostActivitySourceState {
    if (!this.seenSources.has(source)) return 'ABSENT'
    reasons.add('source-unavailable')
    return 'UNKNOWN'
  }

  /** Read every live Agent (children included) and classify current work. */
  private readAgents(reasons: Set<ActivityReason>): {
    readonly state: HostActivitySourceState
    readonly agents: readonly AgentLike[]
    readonly readable: boolean
  } {
    const registry = this.context.reflect.get('agents') as AgentRegistryLike | undefined
    if (registry === undefined) {
      reasons.add('source-unavailable')
      return { state: 'UNKNOWN', agents: [], readable: false }
    }
    let agents: readonly AgentLike[]
    try {
      agents = registry.list()
    } catch {
      reasons.add('source-unavailable')
      return { state: 'UNKNOWN', agents: [], readable: false }
    }
    let roots: Set<AgentLike> | undefined
    if (typeof registry.roots === 'function') {
      try {
        roots = new Set(registry.roots())
      } catch {
        roots = undefined
      }
    }
    let state: HostActivitySourceState = 'IDLE'
    let maintenanceGap = false
    for (const agent of agents) {
      let running: boolean
      let pending: number
      try {
        running = agent.status === 'running'
        pending = agent.inbox.nextTurn.length + agent.inbox.nextStep.length
      } catch {
        // A live registry entry that cannot be read is a coverage gap, never
        // an idle Agent.
        reasons.add('source-unavailable')
        return { state: 'UNKNOWN', agents, readable: false }
      }
      if (running) {
        reasons.add('agent-running')
        state = 'ACTIVE'
      }
      if (pending > 0) {
        reasons.add('agent-inbox')
        state = 'ACTIVE'
      }
      if (!running && pending === 0) maintenanceGap = true
      if (roots !== undefined && !roots.has(agent) && (running || pending > 0)) {
        reasons.add('child-active')
      }
    }
    if (maintenanceGap) {
      // rc.4 has no synchronous `maintenanceRunning` getter: an idle Agent can
      // still own `runMaintenance()`, so quiescence is not certifiable.
      reasons.add('agent-maintenance-unproven')
      if (state === 'IDLE') state = 'UNKNOWN'
    }
    return { state, agents, readable: true }
  }

  /** Read the official Goal view for every live Agent. */
  private readGoals(
    agents: readonly AgentLike[],
    agentsReadable: boolean,
    reasons: Set<ActivityReason>,
  ): HostActivitySourceState {
    const goals = this.context.reflect.get('goals') as GoalServiceLike | undefined
    if (goals === undefined) return this.unavailableState('goal', reasons)
    this.seenSources.add('goal')
    if (!agentsReadable) {
      reasons.add('source-unavailable')
      return 'UNKNOWN'
    }
    let state: HostActivitySourceState = 'IDLE'
    for (const agent of agents) {
      let goal: GoalViewLike | undefined
      try {
        goal = goals.get(agent)
      } catch {
        reasons.add('source-unavailable')
        return 'UNKNOWN'
      }
      if (goal !== undefined && goal.phase === 'active' && goal.activation === 'armed') {
        reasons.add('goal-armed')
        state = 'ACTIVE'
      }
    }
    return state
  }

  /** Merge the unowned list, every live Agent's owner-scoped list, and job hints. */
  private readJobs(
    agents: readonly AgentLike[],
    agentsReadable: boolean,
    reasons: Set<ActivityReason>,
  ): HostActivitySourceState {
    const jobs = this.context.reflect.get('jobs') as JobRegistryLike | undefined
    if (jobs === undefined) return this.unavailableState('jobs', reasons)
    this.seenSources.add('jobs')
    const byId = new Map<string, JobViewLike>()
    try {
      for (const job of jobs.list()) byId.set(job.id, job)
      if (agentsReadable) {
        for (const agent of agents) {
          for (const job of jobs.list(agent.id)) byId.set(job.id, job)
        }
      }
    } catch {
      reasons.add('source-unavailable')
      return 'UNKNOWN'
    }
    // A registered hint that is no longer visible through any authoritative
    // list is still treated as potentially live; the hint is removed by the
    // official settled/removed event and never becomes a second registry.
    for (const [id, status] of this.jobHints) {
      if (!byId.has(id)) byId.set(id, { id, status })
    }
    let state: HostActivitySourceState = 'IDLE'
    for (const job of byId.values()) {
      if (job.status === 'running') {
        reasons.add('job-running')
        state = 'ACTIVE'
      } else if (job.status === 'stopping') {
        reasons.add('job-stopping')
        state = 'ACTIVE'
      }
    }
    if (!agentsReadable) {
      // The unowned list is readable, but owned coverage is not: fail closed.
      reasons.add('source-unavailable')
      if (state === 'IDLE') return 'UNKNOWN'
    }
    return state
  }

  /** Read the official Host Schedule catalog when the service is actually mounted. */
  private async readSchedule(reasons: Set<ActivityReason>): Promise<HostActivitySourceState> {
    const schedule = this.context.reflect.get('schedule') as ScheduleServiceLike | undefined
    if (schedule === undefined) return this.unavailableState('schedule', reasons)
    this.seenSources.add('schedule')
    let entries: readonly ScheduleCatalogEntryLike[]
    try {
      entries = await withDeadline(schedule.catalog(), this.observationDeadlineMs)
    } catch {
      // A hung or rejected catalog is an unreadable source, never an empty one.
      reasons.add('source-unavailable')
      return 'UNKNOWN'
    }
    let state: HostActivitySourceState = 'IDLE'
    for (const entry of entries) {
      if (entry.status === 'active') {
        reasons.add('schedule-active')
        state = 'ACTIVE'
      }
    }
    return state
  }

  /** rc.4 cannot enumerate Gateway pending interactions. */
  private readPending(reasons: Set<ActivityReason>): HostActivitySourceState {
    const gateway = this.context.reflect.get('typertGateway')
    if (gateway === undefined) return this.unavailableState('pending', reasons)
    this.seenSources.add('pending')
    reasons.add('pending-interaction-unobservable')
    return 'UNKNOWN'
  }

  /** rc.4 cannot enumerate in-flight Session writes. */
  private readWrite(reasons: Set<ActivityReason>): HostActivitySourceState {
    const persistence = this.context.reflect.get('sessionPersistence')
    if (persistence === undefined) return this.unavailableState('write', reasons)
    this.seenSources.add('write')
    reasons.add('inflight-write-unproven')
    return 'UNKNOWN'
  }

  /** Active Loader rows outside the official/xmoon namespaces are unqualified. */
  private readOther(reasons: Set<ActivityReason>): HostActivitySourceState {
    // The Loader is a direct Context service, not a reflect-store entry: read
    // the same owner property the Host readiness audit uses.
    const loader = (this.context as unknown as { readonly loader?: LoaderLike }).loader
    if (loader === undefined) {
      reasons.add('source-unavailable')
      return 'UNKNOWN'
    }
    let entries: LoaderEntryLike[]
    try {
      entries = [...loader.entries()]
    } catch {
      reasons.add('source-unavailable')
      return 'UNKNOWN'
    }
    for (const entry of entries) {
      const state = entry.fiber?.state
      // A row that never started, or has fully disposed, owns no resource.
      if (state === undefined || state === FIBER_PENDING || state === FIBER_DISPOSED) continue
      const id = entry.options?.id ?? ''
      const name = entry.options?.name ?? ''
      const qualified = QUALIFIED_HOST_ROWS.get(id) === name
      if (state === FIBER_FAILED) {
        // A failed Loader row may still hold partially started resources.
        reasons.add('source-unavailable')
        return 'UNKNOWN'
      }
      if (state === FIBER_ACTIVE) {
        // ACTIVE is the only state in which an exact qualified passive row is
        // safe to ignore as a source.
        if (qualified) continue
        reasons.add('unqualified-host-source')
        return 'UNKNOWN'
      }
      if (state === FIBER_LOADING || state === FIBER_UNLOADING) {
        // A qualified identity proves the row's family, not that an in-flight
        // mount/unmount holds no work. Treat every transitional row as
        // UNKNOWN; an unqualified one is additionally named as unqualified.
        reasons.add(qualified ? 'source-unavailable' : 'unqualified-host-source')
        return 'UNKNOWN'
      }
      // Unknown future FiberState values fail closed.
      reasons.add('source-unavailable')
      return 'UNKNOWN'
    }
    return 'IDLE'
  }

  /** Read one bounded snapshot from the real Host services. */
  async snapshot(): Promise<HostActivitySnapshot> {
    if (this.closed) return closedSnapshot(this.currentEpoch)
    const startEpoch = this.currentEpoch
    this.noteMountedSources()
    const reasons = new Set<ActivityReason>()
    const sourceStates = {} as Record<HostActivitySource, HostActivitySourceState>
    const agents = this.readAgents(reasons)
    sourceStates.agent = agents.state
    sourceStates.goal = this.readGoals(agents.agents, agents.readable, reasons)
    sourceStates.jobs = this.readJobs(agents.agents, agents.readable, reasons)
    sourceStates.schedule = await this.readSchedule(reasons)
    sourceStates.pending = this.readPending(reasons)
    sourceStates.write = this.readWrite(reasons)
    sourceStates.other = this.readOther(reasons)
    if (this.closed) return closedSnapshot(this.currentEpoch)
    const endEpoch = this.currentEpoch
    const changedDuringRead = startEpoch !== endEpoch
    if (changedDuringRead) {
      // A change during the read invalidates the whole observation. A positive
      // BLOCKED fact remains visible, but quiescence must never be committed.
      reasons.add('observation-changed')
    }
    let verdict: ActivityVerdict
    if ([...reasons].some(reason => BLOCKING_REASONS.has(reason))) {
      verdict = 'BLOCKED'
    } else if (reasons.size > 0) {
      verdict = 'UNKNOWN'
    } else {
      verdict = 'OBSERVED_QUIESCENT'
    }
    return {
      verdict,
      epoch: endEpoch,
      reasons: reasonList(reasons),
      sourceStates,
    }
  }

  /** Release every subscription synchronously and ignore late callbacks. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const subscriptions = this.subscriptions.splice(0)
    for (const dispose of subscriptions.reverse()) dispose()
  }
}
