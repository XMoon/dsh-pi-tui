/**
 * The per-open MCP servers controller (FR3 S3) — the ONE Client-local owner of
 * one open `Settings · Tools · MCP servers` page's transient state.
 *
 * It owns ONLY transient, per-open facts: the open token, one abortable watch,
 * the latest validated projection, the selected name, the one in-flight
 * operation, the restart confirmation and ONE transient notice. The Host MCP
 * manager remains the only fleet/status authority, and `ConfigPort.
 * mcpServerSources` remains the only configuration-source evidence. There is no
 * second server registry, no second fleet, no cached status.
 *
 * Rules pinned here:
 *
 * - Opening starts exactly ONE watch; `refresh` retires it before opening a
 *   new one (never two current watchers).
 * - No authoritative list yet is `loading`; an observation invalidation is a
 *   truthful `read-error`/`unavailable`, never an empty list.
 * - `configured` is never a source verdict: the source is derived from the
 *   official settings key set, and only after two consecutive current reads
 *   agree. A settling key set leaves the source `Unknown` instead of guessing
 *   `Plugin-owned`.
 * - Probe/restart results belong to the operation's Host generation and page
 *   token; a late result is discarded instead of mutating the new page.
 * - A dispatched restart is never claimed cancelled, never retried, and after a
 *   lost settlement stays `outcome-unconfirmed`.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/mcp-servers
 */

import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager/types'
import type { McpServerSources, McpServerSourcesConfig } from '../../runtime/config-port.ts'
import type {
  McpServerGeneration,
  McpServerPort,
  McpServerProbeValue,
  McpServerView,
  McpServerWatchEvent,
} from '../../runtime/mcp-server-port.ts'

/** The configuration-source verdict a row may display. */
export type McpServerSourceLabel = 'Configured' | 'Plugin-owned' | 'Retained/removed' | 'Unknown'

/** One row of the validated projection. */
export interface McpServersRow {
  readonly name: string
  readonly status: McpManagedServerStatus
  /** The config-source verdict; `Unknown` when the evidence is not current. */
  readonly source: McpServerSourceLabel
}

/** The page's observation phase. */
export type McpServersPhase = 'loading' | 'ready' | 'read-error' | 'unavailable'

/** One in-flight/settled operation, as the page paints it. */
export interface McpServersOperationState {
  readonly kind: 'probe' | 'restart'
  readonly name: string
  readonly phase: 'running' | 'settled' | 'failed'
  /** The user-facing single-line result (never a secret). */
  readonly text?: string
}

/** The probe result last settled by THIS page (already classified). */
export interface McpServersProbeReport {
  readonly name: string
  readonly kind: 'passed' | 'connect-failed' | 'list-failed' | 'cleanup-unconfirmed'
  readonly value: McpServerProbeValue
}

/** The render-facing snapshot; the page never reads the Host directly. */
export interface McpServersSnapshot {
  readonly phase: McpServersPhase
  readonly phaseReason?: string
  /** The official manager order, never re-sorted by this controller. */
  readonly rows: readonly McpServersRow[]
  readonly selectedName?: string
  /** The name awaiting the user's restart confirmation (`y`/`Esc` only). */
  readonly confirmingName?: string
  readonly operation?: McpServersOperationState
  readonly lastProbe?: McpServersProbeReport
  /** The ONE transient notice of this open. */
  readonly notice?: { readonly text: string; readonly kind: 'info' | 'error' }
}

/** One owned async task entry (the command layer supplies `runOwned`). */
export type McpServersRunOwned = (
  label: string,
  task: () => Promise<void>,
  options?: { readonly signal?: AbortSignal },
) => void

/** Construction dependencies of one per-open controller. */
export interface McpServersControllerDeps {
  readonly port: McpServerPort
  readonly sources: McpServerSourcesConfig
  readonly requestRender: () => void
  readonly runOwned: McpServersRunOwned
}

/** Bound on the confirmation re-read a settling key set triggers (no loop). */
const MAX_SOURCE_CONFIRMATION_READS = 2

/** Set equality for two key sets (order-insensitive). */
function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(name => rightSet.has(name))
}

/** One-line, control-character-free diagnostic text (never a secret). */
function singleLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberate control-byte scrub of Host diagnostics
  const sanitized = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
  const collapsed = sanitized.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed
}

/** The controller of one open page. */
export class McpServersController {
  private readonly deps: McpServersControllerDeps
  /** This open's identity: every late callback is fenced on it. */
  private openToken = 0
  private started = false
  private disposed = false
  private watchController: AbortController | undefined
  private phase: McpServersPhase = 'loading'
  private phaseReason: string | undefined
  private generation: McpServerGeneration | undefined
  private readonly servers = new Map<string, McpServerView>()
  private readonly order: string[] = []
  private selected: string | undefined
  private confirming: string | undefined
  private operation: McpServersOperationState | undefined
  private operationController: AbortController | undefined
  private lastProbe: McpServersProbeReport | undefined
  private notice: { text: string; kind: 'info' | 'error' } | undefined
  /** The last READY key set that a second consecutive read confirmed. */
  private confirmedKeySet: ReadonlySet<string> | undefined
  /** The last committed source verdict (evidence for `confirmedKeySet`). */
  private sources: McpServerSources = { kind: 'unavailable', reason: 'not read' }
  /** Bumped on every roster frame so a stale source read cannot land. */
  private rosterEpoch = 0

  constructor(deps: McpServersControllerDeps) {
    this.deps = deps
  }

  /** Open the page: start the ONE observation. Idempotent. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.openWatch()
  }

  /**
   * Close the page: retire the open token FIRST, then abort the observation
   * and any in-flight probe. A restart already dispatched is NOT claimed
   * cancelled: it simply stops being this page's business.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.openToken += 1
    this.watchController?.abort()
    this.watchController = undefined
    this.operationController?.abort()
    this.operationController = undefined
    this.operation = undefined
    this.confirming = undefined
    this.notice = undefined
    this.lastProbe = undefined
    this.servers.clear()
    this.order.length = 0
  }

  /** The current render-facing snapshot. */
  snapshot(): McpServersSnapshot {
    const rows: McpServersRow[] = this.order.map(name => {
      const view = this.servers.get(name) as McpServerView
      return { name, status: view.status, source: this.sourceOf(view) }
    })
    return {
      phase: this.phase,
      ...this.phaseReason === undefined ? {} : { phaseReason: this.phaseReason },
      rows: Object.freeze(rows),
      ...this.selected === undefined ? {} : { selectedName: this.selected },
      ...this.confirming === undefined ? {} : { confirmingName: this.confirming },
      ...this.operation === undefined ? {} : { operation: this.operation },
      ...this.lastProbe === undefined ? {} : { lastProbe: this.lastProbe },
      ...this.notice === undefined ? {} : { notice: this.notice },
    }
  }

  /** Whether a Host operation may be issued right now. */
  canOperate(): boolean {
    return this.phase === 'ready'
      && this.selected !== undefined
      // A SETTLED result stays visible but never blocks the next action; only
      // an in-flight operation or an open confirmation owns the page.
      && this.operation?.phase !== 'running'
      && this.confirming === undefined
  }

  /** Whether the selected server may be probed/restarted right now. */
  canOperateSelected(): boolean {
    return this.canOperate() && this.selected !== undefined && this.servers.has(this.selected)
  }

  /**
   * Move the selection inside the caller's visible (filtered) name list while
   * preserving the Host's own order. A missing selected name starts at the
   * first visible row.
   */
  move(delta: number, visibleNames: readonly string[]): void {
    if (this.disposed || visibleNames.length === 0) return
    // A confirmation belongs to the exact selected server: moving away cancels
    // it (the user must re-enter the confirmation for another target).
    this.confirming = undefined
    const index = this.selected === undefined ? -1 : visibleNames.indexOf(this.selected)
    if (index === -1) {
      this.selected = visibleNames[delta >= 0 ? 0 : visibleNames.length - 1]
    } else {
      const next = (index + delta + visibleNames.length) % visibleNames.length
      this.selected = visibleNames[next]
    }
    this.deps.requestRender()
  }

  /** Select one exact visible name (a pointer/keyboard activation). */
  select(name: string, visibleNames: readonly string[]): void {
    if (this.disposed || !this.servers.has(name)) return
    if (!visibleNames.includes(name)) return
    if (this.selected !== name) {
      this.selected = name
      this.confirming = undefined
    }
    this.deps.requestRender()
  }

  /** Re-open the observation (the `r` action): one watcher at a time. */
  refresh(): void {
    if (this.disposed) return
    this.openWatch()
    this.deps.requestRender()
  }

  /** Start ONE probe of the selected server. */
  probe(): void {
    if (!this.canOperateSelected()) return
    const name = this.selected as string
    if (this.confirming !== undefined) return
    this.runProbe(name)
  }

  /** Enter the restart confirmation for the selected server. */
  beginRestart(): void {
    if (!this.canOperateSelected()) return
    this.confirming = this.selected
    this.notice = undefined
    this.deps.requestRender()
  }

  /** Answer the restart confirmation. Only `y` executes; anything else cancels. */
  answerRestart(confirmed: boolean): void {
    if (this.disposed || this.confirming === undefined) return
    const name = this.confirming
    this.confirming = undefined
    if (!confirmed) {
      this.notice = { text: 'Restart cancelled', kind: 'info' }
      this.deps.requestRender()
      return
    }
    if (this.selected !== name || !this.servers.has(name) || this.operation?.phase === 'running') return
    this.runRestart(name)
  }

  /** Clear the ONE transient notice (the page's Esc at a settled state). */
  clearNotice(): void {
    if (this.disposed || this.notice === undefined) return
    this.notice = undefined
    this.deps.requestRender()
  }

  private currentGeneration(): McpServerGeneration | undefined {
    return this.generation
  }

  private sourceOf(view: McpServerView): McpServerSourceLabel {
    if (this.sources.kind !== 'ready') return 'Unknown'
    const configured = view.configured
    if (configured && this.confirmedKeySet?.has(view.name) === true) return 'Configured'
    if (!configured) return 'Retained/removed'
    // A live entry whose key the CURRENT settings set does not hold is
    // plugin-owned ONLY once two consecutive current reads confirmed the key
    // set; while the set is still settling the honest answer is Unknown.
    return this.confirmedKeySet === undefined ? 'Unknown' : 'Plugin-owned'
  }

  private openWatch(): void {
    this.watchController?.abort()
    const controller = new AbortController()
    this.watchController = controller
    const token = this.openToken
    if (this.phase !== 'loading') {
      // A refresh keeps the last-known rows but marks them non-current until
      // the new authority speaks.
      this.phase = 'loading'
      this.phaseReason = undefined
    }
    this.deps.runOwned('MCP servers watch', async () => {
      const iterator = this.deps.port.watch(controller.signal)[Symbol.asyncIterator]()
      try {
        while (!controller.signal.aborted) {
          const result = await iterator.next()
          if (result.done === true) return
          if (controller.signal.aborted || token !== this.openToken || this.disposed) return
          this.acceptWatchEvent(result.value)
        }
      } finally {
        await iterator.return?.(undefined)
      }
    }, { signal: controller.signal })
  }

  private acceptWatchEvent(event: McpServerWatchEvent): void {
    if (event.kind === 'invalidated') {
      this.phase = event.reason === 'unavailable' ? 'unavailable' : 'read-error'
      this.phaseReason = event.reason === 'unavailable'
        ? 'Host MCP Manager is not mounted'
        : 'the Host MCP server observation is not current; press r to refresh'
      this.generation = undefined
      this.confirmedKeySet = undefined
      this.sources = { kind: 'unavailable', reason: event.reason }
      // A late probe/restart result of the replaced observation must not become
      // a fact of the stale page.
      this.operationController?.abort()
      this.operationController = undefined
      if (this.operation?.phase === 'running') {
        this.operation = { ...this.operation, phase: 'failed', text: 'Observation lost; the result was discarded' }
      }
      this.deps.requestRender()
      return
    }
    this.generation = event.roster.generation
    this.phase = 'ready'
    this.phaseReason = undefined
    this.rosterEpoch += 1
    const epoch = this.rosterEpoch
    const previousOrder = [...this.order]
    this.servers.clear()
    this.order.length = 0
    for (const view of event.roster.servers) {
      this.servers.set(view.name, view)
      this.order.push(view.name)
    }
    // Keep the selection by NAME; when that member is gone, fall back to the
    // nearest member by the Host's own stable order (never re-sort).
    if (this.selected !== undefined && !this.servers.has(this.selected)) {
      const index = previousOrder.indexOf(this.selected)
      const fallback = this.order[Math.min(Math.max(index, 0), this.order.length - 1)]
      this.selected = fallback
      this.confirming = undefined
    }
    if (this.selected === undefined && this.order.length > 0) this.selected = this.order[0]
    this.deps.requestRender()
    this.refreshSources(epoch)
  }

  /**
   * Read the configuration-source verdict for the SAME roster generation and
   * confirm a settling key set with a second read. A non-current or failed
   * read leaves every source `Unknown`; it never infers `Plugin-owned`.
   */
  private refreshSources(epoch: number): void {
    this.deps.runOwned('MCP servers source read', async () => {
      for (let attempt = 0; attempt < MAX_SOURCE_CONFIRMATION_READS; attempt += 1) {
        try {
          await this.deps.sources.refresh()
        } catch {
          // The backend records the failure; the read below reports stale.
        }
        if (this.disposed || epoch !== this.rosterEpoch) return
        const verdict = this.deps.sources.read()
        const previous = this.sources
        if (verdict.kind !== 'ready') {
          this.sources = verdict
          this.confirmedKeySet = undefined
          this.deps.requestRender()
          return
        }
        const agreed = previous.kind === 'ready' && sameKeys(previous.configuredNames, verdict.configuredNames)
        this.sources = verdict
        this.confirmedKeySet = agreed ? new Set(verdict.configuredNames) : undefined
        this.deps.requestRender()
        // One settling read gets ONE confirmation read; a changing key set is
        // never looped on (the next roster frame re-drives this).
        if (agreed) return
      }
    })
  }

  private runProbe(name: string): void {
    if (!this.canOperateSelected() || this.selected !== name) return
    const generation = this.currentGeneration()
    if (generation === undefined) return
    const token = this.openToken
    const controller = new AbortController()
    this.operationController = controller
    this.operation = { kind: 'probe', name, phase: 'running' }
    this.notice = undefined
    this.deps.requestRender()
    this.deps.runOwned('MCP server probe', async () => {
      const outcome = await this.deps.port.probe(name, controller.signal)
      // The result belongs to ITS page token and Host generation only.
      if (this.disposed || token !== this.openToken) return
      if (outcome.generation !== generation || this.generation !== generation) return
      if (outcome.kind === 'settled') {
        this.lastProbe = { name, ...classifyProbe(outcome.value) }
        this.operation = { kind: 'probe', name, phase: 'settled', text: probeResultText(this.lastProbe) }
        this.notice = { text: this.operation.text as string, kind: this.lastProbe.kind === 'passed' ? 'info' : 'error' }
      } else {
        this.operation = { kind: 'probe', name, phase: 'failed', text: failureText(outcome.failure) }
        this.notice = { text: this.operation.text as string, kind: 'error' }
      }
      this.operationController = undefined
      this.deps.requestRender()
    }, { signal: controller.signal })
  }

  private runRestart(name: string): void {
    const generation = this.currentGeneration()
    if (generation === undefined) return
    const token = this.openToken
    const controller = new AbortController()
    this.operationController = controller
    this.operation = { kind: 'restart', name, phase: 'running' }
    this.notice = { text: `Restart requested for ${name} · waiting for Host status`, kind: 'info' }
    this.deps.requestRender()
    this.deps.runOwned('MCP server restart', async () => {
      // EXACTLY ONE dispatch: no retry, no second confirmation.
      const outcome = await this.deps.port.restart(name, controller.signal)
      if (this.disposed || token !== this.openToken) return
      if (outcome.generation !== generation || this.generation !== generation) {
        // The page now speaks for a different Host generation: the dispatched
        // request's settlement is not this page's fact.
        this.operation = { kind: 'restart', name, phase: 'failed', text: RESTART_LOST_NOTE }
        this.notice = { text: RESTART_LOST_NOTE, kind: 'error' }
        this.operationController = undefined
        this.deps.requestRender()
        return
      }
      if (outcome.kind === 'settled') {
        // A resolved restart is NOT connected: the watch stream must prove the
        // new status.
        this.operation = { kind: 'restart', name, phase: 'settled', text: RESTART_WAITING_NOTE }
        this.notice = { text: RESTART_WAITING_NOTE, kind: 'info' }
      } else if (outcome.failure.kind === 'outcome-unconfirmed') {
        this.operation = { kind: 'restart', name, phase: 'failed', text: RESTART_LOST_NOTE }
        this.notice = { text: RESTART_LOST_NOTE, kind: 'error' }
      } else if (outcome.failure.kind === 'rejected') {
        const text = `Restart refused: ${singleLine(outcome.failure.reason)}`
        this.operation = { kind: 'restart', name, phase: 'failed', text }
        this.notice = { text, kind: 'error' }
      } else {
        const text = `Restart could not be dispatched: ${singleLine(outcome.failure.reason)}`
        this.operation = { kind: 'restart', name, phase: 'failed', text }
        this.notice = { text, kind: 'error' }
      }
      this.operationController = undefined
      this.deps.requestRender()
    }, { signal: controller.signal })
  }
}

/** The fixed restart wording (a resolved RPC is never "connected"). */
export const RESTART_WAITING_NOTE = 'Restart settled · awaiting connected status'
/** The fixed lost-settlement wording (never "cancelled" after dispatch). */
export const RESTART_LOST_NOTE = 'Outcome unconfirmed; refresh Host status before retrying'

/** Classify one official probe result into the page's independent facts. */
export function classifyProbe(value: McpServerProbeValue): Omit<McpServersProbeReport, 'name'> {
  if (!value.ok) {
    return { kind: value.stage === 'connect' ? 'connect-failed' : 'list-failed', value }
  }
  if (!value.closeConfirmed || value.cleanupError !== undefined) {
    // `ok: true` with unconfirmed/failed cleanup is NOT a pure success.
    return { kind: 'cleanup-unconfirmed', value }
  }
  return { kind: 'passed', value }
}

/** One single-line probe result sentence. */
export function probeResultText(report: McpServersProbeReport): string {
  const { value } = report
  if (!value.ok) {
    const tools = value.stage === 'connect' ? 'connect' : 'tool listing'
    return `Probe failed at ${tools}: ${singleLine(value.message)}`
  }
  const tools = `${String(value.toolNames.length)}${value.truncated ? '+' : ''} tool${value.toolNames.length === 1 ? '' : 's'}`
  if (report.kind === 'cleanup-unconfirmed') {
    const why = value.cleanupError === undefined ? 'transport closure unconfirmed' : singleLine(value.cleanupError)
    return `Probe connected (${tools}, ${String(value.durationMs)} ms); cleanup not confirmed: ${why}`
  }
  return `Probe passed (${tools}, ${String(value.durationMs)} ms)`
}

/** One single-line operation-failure sentence. */
export function failureText(failure: { readonly kind: string; readonly reason: string }): string {
  switch (failure.kind) {
    case 'rejected': return `Probe refused: ${singleLine(failure.reason)}`
    case 'superseded': return 'Probe result discarded (the Host or page changed)'
    case 'outcome-unconfirmed': return 'Probe outcome unconfirmed'
    default: return `Probe unavailable: ${singleLine(failure.reason)}`
  }
}
