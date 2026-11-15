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
import type {
  McpConfigWriteOutcome,
  McpServerConfiguration,
  McpServerConfigurationConfig,
  McpServerSources,
  McpServerSourcesConfig,
} from '../../runtime/config-port.ts'
import type {
  McpServerGeneration,
  McpServerPort,
  McpServerProbeValue,
  McpServerView,
  McpServerWatchEvent,
} from '../../runtime/mcp-server-port.ts'
import {
  diffMcpServerDraft,
  mcpAddOps,
  mcpEditOps,
  mcpRemoveOps,
  mcpSetEnabledOps,
  validateMcpServerDraft,
  type McpClassifiedServerEntry,
  type McpDraftIssue,
  type McpServerEntryDraft,
  type McpServerTransport,
  type McpSettingsPathOp,
} from '../../domain/mcp/server-config.ts'

/** The configuration-source verdict a row may display. */
export type McpServerSourceLabel = 'Configured' | 'Plugin-owned' | 'Retained/removed' | 'Unknown'

/** One row of the validated projection. */
export interface McpServersRow {
  readonly name: string
  /** Whether the official manager still holds a LIVE entry for this name. A
   *  retained cleanup record (`false`) is diagnostic only and NOT operable. */
  readonly configured: boolean
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
  /** FR4: the actionable CRUD facets of the selected server (undefined = none). */
  readonly selectedConfig?: McpSelectedConfigFacet
  /** FR4: the open configuration editor, when one is open. */
  readonly editor?: McpEditorSnapshot
  /** FR4: the pending CRUD confirmation (delete/reset/toggle), when open. */
  readonly configConfirm?: McpConfigConfirmSnapshot
  /** FR4: the ONE configuration-action status slot. */
  readonly configStatus?: McpConfigStatus
  /** FR4: the current configuration snapshot (for source/provenance display). */
  readonly config?: McpServerConfiguration
}

/** FR4: what may be done with the currently selected server. */
export interface McpSelectedConfigFacet {
  readonly name: string
  readonly provenance: McpClassifiedServerEntry['provenance']
  /** Enable/Disable is always possible for a config-owned entry. */
  readonly canToggle: boolean
  /** Only a User-added entry can be deleted permanently. */
  readonly canDelete: boolean
  /** Only an entry whose EFFECTIVE configuration differs from the base can be
   *  reset to inherited (a USER patch key alone is not an override). */
  readonly canReset: boolean
  /** The current saved `enabled` value (undefined when unreadable). */
  readonly enabled?: boolean
}

/** FR4: the page-facing projection of the open editor. */
export interface McpEditorSnapshot {
  readonly mode: 'add' | 'edit'
  readonly name: string
  /** Edit keeps the name read-only (rename = Add then Delete). */
  readonly nameEditable: boolean
  readonly transport: McpServerTransport
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly { readonly key: string; readonly value: string }[]
  readonly cwd: string
  readonly url: string
  readonly headers: readonly { readonly key: string; readonly value: string }[]
  readonly enabled: boolean
  /** Whether the draft differs from the entry it was opened from. */
  readonly dirty: boolean
  /** The validation issues of the CURRENT draft (empty = dispatchable). */
  readonly issues: readonly McpDraftIssue[]
  /** The config revision this form was opened at (the CAS token). */
  readonly capturedRevision: number
}

/** FR4: one pending CRUD confirmation. */
export interface McpConfigConfirmSnapshot {
  readonly kind: 'delete' | 'reset' | 'toggle' | 'save'
  readonly name: string
  /** For `toggle`: the enabled value that would be written. */
  readonly nextEnabled?: boolean
  /** For `save`: the external-capability sentence the user acknowledges. */
  readonly warning?: string
  /** The config revision the question was asked at: the answer is refused when
   *  the namespace moved in the meantime (a confirmation is a decision about a
   *  SPECIFIC configuration, never about whatever is current when `y` lands). */
  readonly capturedRevision: number
}

/** FR4: the ONE configuration-action status slot. */
export type McpConfigStatus =
  | { readonly kind: 'saving'; readonly text: string }
  | { readonly kind: 'saved'; readonly text: string }
  | { readonly kind: 'conflict'; readonly text: string }
  | { readonly kind: 'rejected'; readonly text: string }
  | { readonly kind: 'unconfirmed'; readonly text: string }
  | { readonly kind: 'unavailable'; readonly text: string }

/** The marker the HTTP external-service disclosure carries, so a compacted
 *  Action Bar can keep the target host instead of dropping the whole fact. */
export const MCP_HTTP_TARGET_MARKER = 'Target: '

/** The fixed FR4 user-facing wording (one source for page + tests). */
export const MCP_CONFIG_TEXT = {
  saving: 'Saving configuration…',
  saved: 'Saved · waiting for Host reconcile',
  conflict: 'Not saved · configuration changed; refresh to review',
  unconfirmed: 'Outcome unconfirmed; inspect the Host configuration before retrying',
  unavailable: 'Unavailable · Host settings not current',
  deleted: 'Config removed · waiting for Host reconcile',
  // The official `unset` restores the INHERITED VALUE into the user layer (it
  // cannot remove the user entry itself), so the wording claims only what the
  // Host really did: the inherited configuration is back in force.
  reset: 'Inherited configuration restored',
  toggleOn: 'Configuration saved · the server will start',
  toggleOff: 'Configuration saved · the server will stop',
  /** The external-capability disclosure an Add/Edit Save must acknowledge. */
  externalCommand: 'Enabling this server can execute an external command.',
  externalService: 'Enabling this server can send data to an external service.',
} as const

/** The mutable draft the editor holds while open. */
interface McpEditorDraftState {
  name: string
  transport: McpServerTransport
  command: string
  args: string[]
  env: Map<string, string>
  cwd: string
  url: string
  headers: Map<string, string>
  enabled: boolean
  /** The EXPLICIT storage form of each env/header value, keyed `${field}:${key}`.
   *  Absent means `reference` (the contract default); the user's choice is never
   *  inferred from the typed text. */
  forms: Map<string, 'reference' | 'literal'>
}

/** The open editor's authority binding. */
interface McpEditorState {
  readonly mode: 'add' | 'edit'
  /** The exact entry an Edit was opened on (absent for Add). */
  readonly entry: McpClassifiedServerEntry | undefined
  readonly generation: McpServerGeneration
  readonly revision: number
  draft: McpEditorDraftState
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
  /** FR4: the configuration read/write sub-domain (the ONLY CRUD path). */
  readonly configuration: McpServerConfigurationConfig
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

/** An empty Add draft (stdio is the first transport offered). */
function emptyDraft(): McpEditorDraftState {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: new Map(),
    cwd: '',
    url: '',
    headers: new Map(),
    enabled: true,
    forms: new Map(),
  }
}

/** The mutable draft of one existing entry (its effective transport facts). */
function draftFromEntry(entry: McpClassifiedServerEntry): McpEditorDraftState {
  const effective = entry.effective
  return {
    name: entry.name,
    transport: effective.transport,
    command: effective.command ?? '',
    args: [...effective.args ?? []],
    env: new Map(effective.env ?? []),
    cwd: effective.cwd ?? '',
    url: effective.url ?? '',
    headers: new Map(effective.headers ?? []),
    enabled: effective.enabled !== false,
    // An existing stored value that IS a `${credential:REF}` token is a
    // reference; anything else already in the profile is a literal.
    forms: new Map([
      ...[...(effective.env ?? [])].map(([key, value]): [string, 'reference' | 'literal'] =>
        [`env:${key}`, isCredentialToken(value) ? 'reference' : 'literal']),
      ...[...(effective.headers ?? [])].map(([key, value]): [string, 'reference' | 'literal'] =>
        [`headers:${key}`, isCredentialToken(value) ? 'reference' : 'literal']),
    ]),
  }
}

/** Whether one stored string is exactly an official `${credential:REF}` token. */
function isCredentialToken(value: string): boolean {
  return /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value)
}

/**
 * The external-capability sentence for one draft, or `undefined` when the
 * entry cannot reach anything outside the Host (an unconfigured draft still
 * names its transport, so the disclosure is derived from the TRANSPORT, never
 * from a heuristic about the command's danger).
 */
function externalCapabilityWarning(draft: McpServerEntryDraft): string | undefined {
  if (draft.transport === 'stdio') {
    return draft.command.trim() === '' ? undefined : MCP_CONFIG_TEXT.externalCommand
  }
  if (draft.url.trim() === '') return undefined
  return `${MCP_CONFIG_TEXT.externalService} ${MCP_HTTP_TARGET_MARKER}${safeHostOf(draft.url)}`
}

/**
 * The HOST of one URL for the disclosure, and nothing else: never a path, a
 * query, a userinfo section or a credential. A value that cannot be parsed
 * fails CLOSED to `Unknown target` — echoing the raw string would leak exactly
 * the part the disclosure must never show (a credential template embedded in a
 * malformed URL, a token in a query string).
 */
function safeHostOf(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Unknown target'
  }
  if (parsed.host === '') return 'Unknown target'
  return parsed.host
}

/** Project the mutable draft onto the immutably-typed domain draft. */
function entryDraftOf(draft: McpEditorDraftState): McpServerEntryDraft {
  return {
    transport: draft.transport,
    command: draft.command,
    args: [...draft.args],
    env: new Map(draft.env),
    cwd: draft.cwd,
    url: draft.url,
    headers: new Map(draft.headers),
    enabled: draft.enabled,
  }
}

/** One controller of one open page. */
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
  /** Continuity token per listed name: a removed-and-relisted name is a NEW
   *  entry even within one Host generation, so a late operation result for the
   *  previous entry can never be attributed to the replacement. */
  private readonly entryTokens = new Map<string, object>()
  private readonly order: string[] = []
  private selected: string | undefined
  /** The restart confirmation, bound to the Host generation and the exact
   *  roster entry it was opened for: it can never authorize another Host's
   *  same-named server. */
  private confirming: {
    readonly name: string
    readonly generation: McpServerGeneration
    readonly entryToken: object
  } | undefined
  private operation: McpServersOperationState | undefined
  private operationController: AbortController | undefined
  /** Identity of the ONE operation allowed to mutate this page's operation slot.
   *  Every async settlement must still own it before touching state. */
  private operationToken = 0
  private lastProbe: McpServersProbeReport | undefined
  private notice: { text: string; kind: 'info' | 'error' } | undefined
  /** The last READY key set that a second consecutive read confirmed. */
  private confirmedKeySet: ReadonlySet<string> | undefined
  /** The last committed source verdict (evidence for `confirmedKeySet`). */
  private sources: McpServerSources = { kind: 'unavailable', reason: 'not read' }
  /** Bumped on every roster frame so a stale source read cannot land. */
  private rosterEpoch = 0
  /** FR4: the last committed configuration read (same-generation evidence). */
  private configuration: McpServerConfiguration = { kind: 'unavailable', reason: 'not read' }
  /** FR4: the open editor (draft + its authority binding), when open. */
  private editor: McpEditorState | undefined
  /** FR4: the pending CRUD confirmation. */
  private configConfirm: McpConfigConfirmSnapshot | undefined
  /** FR4: the ONE config-action status slot. */
  private configStatus: McpConfigStatus | undefined
  /** FR4: identity of the ONE config write allowed to settle into the slot. */
  private configWriteToken = 0
  /** FR4: identity of the LATEST configuration read (only it may commit). */
  private configReadToken = 0

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
    this.operationToken += 1
    this.configWriteToken += 1
    this.watchController?.abort()
    this.watchController = undefined
    this.operationController?.abort()
    this.operationController = undefined
    this.operation = undefined
    this.confirming = undefined
    this.notice = undefined
    this.lastProbe = undefined
    // FR4: an open draft and a settled status die with the page; a DISPATCHED
    // write is never claimed cancelled (the config write token simply stops
    // this page presenting its result).
    this.editor = undefined
    this.configConfirm = undefined
    this.configStatus = undefined
    this.servers.clear()
    this.order.length = 0
  }

  /** The current render-facing snapshot. */
  snapshot(): McpServersSnapshot {
    const rows: McpServersRow[] = this.order.map(name => {
      const view = this.servers.get(name) as McpServerView
      return { name, configured: view.configured, status: view.status, source: this.sourceOf(view) }
    })
    const selectedFacet = this.selectedConfigFacet()
    return {
      phase: this.phase,
      ...this.phaseReason === undefined ? {} : { phaseReason: this.phaseReason },
      rows: Object.freeze(rows),
      ...this.selected === undefined ? {} : { selectedName: this.selected },
      ...this.confirming === undefined ? {} : { confirmingName: this.confirming.name },
      ...this.operation === undefined ? {} : { operation: this.operation },
      ...this.lastProbe === undefined ? {} : { lastProbe: this.lastProbe },
      ...this.notice === undefined ? {} : { notice: this.notice },
      ...selectedFacet === undefined ? {} : { selectedConfig: selectedFacet },
      ...this.editor === undefined ? {} : { editor: this.editorSnapshot(this.editor) },
      ...this.configConfirm === undefined ? {} : { configConfirm: this.configConfirm },
      ...this.configStatus === undefined ? {} : { configStatus: this.configStatus },
      config: this.configuration,
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
    if (!this.canOperate() || this.selected === undefined) return false
    // A retained cleanup record has no live manager entry: it is diagnostic
    // only and must never offer Probe/Restart. A `disabled` LIVE entry is still
    // configured:true and remains probeable.
    return this.servers.get(this.selected)?.configured === true
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
    const name = this.selected as string
    const generation = this.currentGeneration()
    const entryToken = this.entryTokens.get(name)
    if (generation === undefined || entryToken === undefined) return
    this.confirming = { name, generation, entryToken }
    this.notice = undefined
    this.deps.requestRender()
  }

  /** Answer the restart confirmation. Only `y` executes; anything else cancels. */
  answerRestart(confirmed: boolean): void {
    if (this.disposed || this.confirming === undefined) return
    const confirmation = this.confirming
    this.confirming = undefined
    if (!confirmed) {
      this.notice = { text: 'Restart cancelled', kind: 'info' }
      this.deps.requestRender()
      return
    }
    // The confirmation is authority-bound: the exact Host generation and the
    // exact roster entry that were confirmed must still be current. A name
    // match on another Host is NOT a valid target.
    if (this.selected !== confirmation.name
      || !Object.is(this.currentGeneration(), confirmation.generation)
      || this.entryTokens.get(confirmation.name) !== confirmation.entryToken
      || this.servers.get(confirmation.name)?.configured !== true
      || this.operation?.phase === 'running') return
    this.runRestart(confirmation.name)
  }

  /** Clear the ONE transient notice (the page's Esc at a settled state). */
  clearNotice(): void {
    if (this.disposed || this.notice === undefined) return
    this.notice = undefined
    this.deps.requestRender()
  }

  // ── FR4: configuration CRUD ───────────────────────────────────────────────

  /** The configuration read currently in force for THIS page. */
  configurationState(): McpServerConfiguration {
    return this.configuration
  }

  /** Whether the configuration snapshot is current for this roster generation. */
  private configIsCurrent(): boolean {
    return this.configuration.kind === 'ready'
      && this.generation !== undefined
      && Object.is(this.configuration.generation, this.generation)
  }

  /** The classified config entry of the selected name, when the SAME
   *  generation proves it config-owned. */
  private selectedConfigEntry(): McpClassifiedServerEntry | undefined {
    if (!this.configIsCurrent() || this.configuration.kind !== 'ready') return undefined
    if (this.selected === undefined) return undefined
    return this.configuration.entries.find(entry => entry.name === this.selected)
  }

  /** Whether the page may offer ANY configuration edit right now. A write
   *  already in flight owns the namespace: opening a second confirmation (or a
   *  second save) would dispatch a competing CAS and silently discard the
   *  first settlement, so every CRUD intent is refused until it settles. */
  canEditConfiguration(): boolean {
    return this.phase === 'ready'
      && this.configIsCurrent()
      && this.editor === undefined
      && this.configConfirm === undefined
      && this.operation?.phase !== 'running'
      && !this.configStatusIsInFlight()
  }

  /** Whether `a` (Add) may open right now: a current descriptor is required
   *  (its revision is the CAS token the add will carry). */
  canBeginAdd(): boolean {
    return this.canEditConfiguration() && this.configuration.kind === 'ready'
  }

  /** Whether the selected server may be Edited. */
  canBeginEdit(): boolean {
    return this.canEditConfiguration() && this.selectedConfigEntry() !== undefined
  }

  /** The CRUD facet the Detail action bar paints. */
  private selectedConfigFacet(): McpSelectedConfigFacet | undefined {
    const entry = this.selectedConfigEntry()
    if (entry === undefined) return undefined
    return {
      name: entry.name,
      provenance: entry.provenance,
      canToggle: this.canEditConfiguration(),
      canDelete: entry.provenance === 'user-added' && this.canEditConfiguration(),
      canReset: entry.provenance === 'overridden' && this.canEditConfiguration(),
      ...entry.effective.enabled === undefined ? {} : { enabled: entry.effective.enabled },
    }
  }

  private configStatusIsInFlight(): boolean {
    return this.configStatus?.kind === 'saving'
  }

  /** Re-read the configuration for the current generation (bounded; never a
   *  background poll). Only the LATEST read may commit: two overlapping reads
   *  (a roster-triggered one and a post-write one) must never let the older
   *  result overwrite the newer revision, which would make the next edit pin a
   *  stale CAS token. */
  refreshConfiguration(): void {
    if (this.disposed) return
    const token = this.openToken
    const epoch = this.rosterEpoch
    const readToken = ++this.configReadToken
    this.deps.runOwned('MCP configuration read', async () => {
      try {
        await this.deps.configuration.refresh()
      } catch {
        // The backend records its own readiness fact; the read below reports it.
      }
      if (this.disposed || token !== this.openToken || epoch !== this.rosterEpoch) return
      if (readToken !== this.configReadToken) return
      this.configuration = this.deps.configuration.read()
      this.deps.requestRender()
    })
  }

  /** Open the Add editor (the name is the first editable field). */
  beginAdd(): void {
    if (!this.canBeginAdd()) return
    if (this.configuration.kind !== 'ready') return
    if (this.generation === undefined) return
    this.configConfirm = undefined
    this.configStatus = undefined
    this.editor = {
      mode: 'add',
      entry: undefined,
      generation: this.generation,
      revision: this.configuration.revision,
      draft: emptyDraft(),
    }
    this.deps.requestRender()
  }

  /** Open the Edit editor for the selected server (name read-only). */
  beginEdit(): void {
    if (!this.canBeginEdit()) return
    const entry = this.selectedConfigEntry()
    if (entry === undefined || this.generation === undefined) return
    if (this.configuration.kind !== 'ready') return
    this.configConfirm = undefined
    this.configStatus = undefined
    this.editor = {
      mode: 'edit',
      entry,
      generation: this.generation,
      revision: this.configuration.revision,
      draft: draftFromEntry(entry),
    }
    this.deps.requestRender()
  }

  /** Close the editor. A dirty draft requires the page's discard confirmation
   *  (the page owns that prompt); this is the CONFIRMED close. */
  discardEditor(): void {
    if (this.disposed || this.editor === undefined) return
    this.editor = undefined
    this.deps.requestRender()
  }

  /** Whether the open editor has unsaved changes. */
  editorDirty(): boolean {
    if (this.editor === undefined) return false
    return this.editorSnapshot(this.editor).dirty
  }

  /** Replace one scalar field of the open draft. A synchronous reentrancy
   *  guard: nothing else may have closed the editor in between. */
  /** Replace one scalar field of the open draft.
   *
   *  Every draft mutator carries the SAME two gates: the form must exist, and
   *  no configuration write may be unsettled. Once a Save is dispatched the
   *  draft is FROZEN until it settles — an edit typed after dispatch would be
   *  silently dropped when the write closes the form, and a second submit
   *  would race the first. This is the one `saving` state the page paints. */
  setEditorField(field: 'name' | 'command' | 'cwd' | 'url', value: string): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    if (field === 'name' && this.editor.mode === 'edit') return
    this.editor.draft[field] = value
    this.deps.requestRender()
  }

  /** Switch the draft transport (an explicit user choice). */
  setEditorTransport(transport: McpServerTransport): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    if (this.editor.draft.transport === transport) return
    this.editor.draft.transport = transport
    this.deps.requestRender()
  }

  /** Toggle the draft's `enabled`. */
  setEditorEnabled(enabled: boolean): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    this.editor.draft.enabled = enabled
    this.deps.requestRender()
  }

  /** Insert one empty argument row (each argument is its own row). */
  addEditorArg(): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    this.editor.draft.args.push('')
    this.deps.requestRender()
  }

  /** Edit one argument VALUE. */
  setEditorArg(index: number, value: string): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    if (index < 0 || index >= this.editor.draft.args.length) return
    this.editor.draft.args[index] = value
    this.deps.requestRender()
  }

  /** Remove one argument row. */
  removeEditorArg(index: number): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    if (index < 0 || index >= this.editor.draft.args.length) return
    this.editor.draft.args.splice(index, 1)
    this.deps.requestRender()
  }

  /** Insert one empty env/header row. */
  addEditorDictKey(field: 'env' | 'headers'): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    const dict = field === 'env' ? this.editor.draft.env : this.editor.draft.headers
    // A unique placeholder key: the user renames it; a duplicate real key is
    // refused by `validateMcpServerDraft`'s map-key rules / the official
    // schema, never silently merged.
    let index = dict.size + 1
    while (dict.has(`KEY_${String(index)}`)) index += 1
    dict.set(`KEY_${String(index)}`, '')
    this.deps.requestRender()
  }

  /** Rename one env/header key (a duplicate key is refused by the draft
   *  validation, not merged). */
  renameEditorDictKey(field: 'env' | 'headers', from: string, to: string): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    const dict = field === 'env' ? this.editor.draft.env : this.editor.draft.headers
    if (!dict.has(from) || from === to) return
    if (dict.has(to)) return
    // A base-owned key may not be renamed: the official per-key `unset` on the
    // OLD name RESTORES its inherited value, so the save would leave BOTH the
    // old and the new key in force while the form showed only one. The same
    // base-ownership fact that gates Remove gates Rename; the VALUE stays
    // editable. Refuse loudly instead of silently dropping the edit.
    if (!this.canRemoveDictKey(field, from)) {
      this.configStatus = {
        kind: 'rejected',
        text: 'Not saved · an inherited key cannot be renamed; edit its value or add a new key',
      }
      this.deps.requestRender()
      return
    }
    // Rebuild the map to keep the edited order stable.
    const entries = [...dict.entries()].map(([key, existing]) => key === from ? [to, existing] as const : [key, existing] as const)
    dict.clear()
    for (const [key, existing] of entries) dict.set(key, existing)
    // The storage FORM follows the rename (it is a property of the value, not
    // of its key text).
    const form = this.editor.draft.forms.get(`${field}:${from}`)
    this.editor.draft.forms.delete(`${field}:${from}`)
    if (form !== undefined) this.editor.draft.forms.set(`${field}:${to}`, form)
    this.deps.requestRender()
  }

  /**
   * Set one env/header value. The stored FORM is an explicit user choice: a
   * `${credential:REF}` reference (the default) or a literal persisted in the
   * profile. A reference is written verbatim; a literal is written as typed
   * after the caller acknowledged the persistence risk — the two are never
   * silently converted into one another.
   */
  setEditorDictValue(field: 'env' | 'headers', key: string, value: string, form: 'reference' | 'literal' = 'reference'): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    const dict = field === 'env' ? this.editor.draft.env : this.editor.draft.headers
    if (!dict.has(key)) return
    const formKey = `${field}:${key}`
    if (form === 'literal') {
      dict.set(key, value)
      this.editor.draft.forms.set(formKey, 'literal')
      this.deps.requestRender()
      return
    }
    // A reference names a credential; the REF grammar is the official one.
    const ref = value.trim().replace(/^\$\{credential:/u, '').replace(/\}$/u, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref)) {
      this.configStatus = { kind: 'rejected', text: 'Not saved · a credential reference needs a valid REF name' }
      this.deps.requestRender()
      return
    }
    dict.set(key, `\${credential:${ref}}`)
    this.editor.draft.forms.set(formKey, 'reference')
    this.deps.requestRender()
  }

  /** The stored FORM the form shows (and toggles) for one env/header value. */
  dictValueForm(field: 'env' | 'headers', key: string): 'reference' | 'literal' {
    return this.editor?.draft.forms.get(`${field}:${key}`) ?? 'reference'
  }

  /** Flip the storage form of one env/header value WITHOUT changing its text
   *  meaning: the typed value is re-stored in the newly chosen form. */
  setEditorDictForm(field: 'env' | 'headers', key: string, form: 'reference' | 'literal'): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    const dict = field === 'env' ? this.editor.draft.env : this.editor.draft.headers
    const current = dict.get(key)
    if (current === undefined) return
    if (form === 'literal') {
      // Keep the REFERENCE NAME as the literal text: switching the form must
      // never silently drop what the user typed.
      dict.set(key, current.replace(/^\$\{credential:/u, '').replace(/\}$/u, ''))
      this.editor.draft.forms.set(`${field}:${key}`, 'literal')
      this.deps.requestRender()
      return
    }
    // Target form `reference`: VALIDATE the conversion first. The value and
    // its declared form are a PAIR — a conversion that cannot produce a legal
    // `${credential:REF}` token must leave BOTH untouched (a value shown as a
    // credential reference that is not one is a persistence-semantics lie), so
    // the check happens before any state changes.
    const ref = current.trim().replace(/^\$\{credential:/u, '').replace(/\}$/u, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref)) {
      this.configStatus = { kind: 'rejected', text: 'Not saved · this value cannot become a credential reference (the REF name is invalid); edit the value first' }
      this.deps.requestRender()
      return
    }
    dict.set(key, `\${credential:${ref}}`)
    this.editor.draft.forms.set(`${field}:${key}`, 'reference')
    this.deps.requestRender()
  }

  /**
   * Whether one env/header key of the OPEN entry may be removed. The official
   * per-key `unset` RESTORES a base-owned key (it cannot delete it), so a key
   * the base layer owns is not removable: the removal gate is derived from the
   * SAME descriptor the entry was classified by, never from USER key presence.
   */
  canRemoveDictKey(field: 'env' | 'headers', key: string): boolean {
    if (this.disposed || this.editor === undefined) return false
    const baseKeys = field === 'env' ? this.editor.entry?.baseKeys?.env : this.editor.entry?.baseKeys?.headers
    return baseKeys?.has(key) !== true
  }

  /** Remove one env/header row (User-added keys only — the official per-key
   *  `unset` on a base-owned key would restore the inherited value). */
  removeEditorDictKey(field: 'env' | 'headers', key: string): void {
    if (this.disposed || this.editor === undefined || this.configStatusIsInFlight()) return
    if (!this.canRemoveDictKey(field, key)) return
    const dict = field === 'env' ? this.editor.draft.env : this.editor.draft.headers
    dict.delete(key)
    this.editor.draft.forms.delete(`${field}:${key}`)
    this.deps.requestRender()
  }

  /**
   * Save the open editor. Every local precondition (draft validity, name
   * collision, the form's authority binding) is decided BEFORE any question is
   * asked; a draft that can start an external command or reach an external
   * service then requires ONE explicit acknowledgement, and only the
   * acknowledged answer dispatches the write.
   */
  saveEditor(): void {
    if (this.disposed || this.editor === undefined) return
    if (this.configStatusIsInFlight()) return
    const prepared = this.prepareEditorSave()
    if (prepared.kind === 'refused') {
      this.configStatus = prepared.status
      this.deps.requestRender()
      return
    }
    if (prepared.ops.length === 0) {
      // A zero-diff Edit already IS the saved state: no CAS write at all.
      this.editor = undefined
      this.configStatus = { kind: 'saved', text: MCP_CONFIG_TEXT.saved }
      this.deps.requestRender()
      return
    }
    const warning = externalCapabilityWarning(entryDraftOf(this.editor.draft))
    if (warning !== undefined && this.configConfirm === undefined) {
      this.configConfirm = {
        kind: 'save',
        name: this.editor.draft.name,
        warning,
        capturedRevision: this.editor.revision,
      }
      this.deps.requestRender()
      return
    }
    this.commitEditorSave()
  }

  /**
   * The local preconditions of the open draft: either the ONE op batch to
   * dispatch, or the truthful refusal status. Nothing here writes.
   */
  private prepareEditorSave():
    | { readonly kind: 'ready'; readonly ops: readonly McpSettingsPathOp[]; readonly revision: number; readonly generation: McpServerGeneration }
    | { readonly kind: 'refused'; readonly status: McpConfigStatus } {
    const editor = this.editor
    if (editor === undefined) return { kind: 'refused', status: { kind: 'unavailable', text: MCP_CONFIG_TEXT.unavailable } }
    const name = editor.draft.name
    const draft = entryDraftOf(editor.draft)
    const issues = validateMcpServerDraft(name, draft)
    if (issues.length > 0) {
      return { kind: 'refused', status: { kind: 'rejected', text: `Not saved · ${issues[0]?.message ?? 'invalid draft'}` } }
    }
    // The form's authority binding must still be current BEFORE dispatch: a
    // replaced Host generation never dispatches.
    if (!Object.is(this.generation, editor.generation)) {
      return { kind: 'refused', status: { kind: 'unavailable', text: MCP_CONFIG_TEXT.unavailable } }
    }
    if (editor.mode === 'add') {
      if (editor.entry !== undefined) return { kind: 'refused', status: { kind: 'unavailable', text: MCP_CONFIG_TEXT.unavailable } }
      if (this.nameTaken(name)) {
        return { kind: 'refused', status: { kind: 'rejected', text: 'Not saved · that server name is already in use' } }
      }
      return { kind: 'ready', ops: mcpAddOps(name, draft), revision: editor.revision, generation: editor.generation }
    }
    if (editor.entry === undefined) return { kind: 'refused', status: { kind: 'unavailable', text: MCP_CONFIG_TEXT.unavailable } }
    const ops = mcpEditOps(name, editor.entry.effective, draft, diffMcpServerDraft(editor.entry.effective, draft))
    return { kind: 'ready', ops, revision: editor.revision, generation: editor.generation }
  }

  /** Perform the acknowledged Save (also the no-warning path of {@link saveEditor}). */
  private commitEditorSave(): void {
    if (this.disposed || this.editor === undefined) return
    const editor = this.editor
    const prepared = this.prepareEditorSave()
    if (prepared.kind === 'refused') {
      this.configStatus = prepared.status
      this.deps.requestRender()
      return
    }
    if (prepared.ops.length === 0) {
      this.editor = undefined
      this.configStatus = { kind: 'saved', text: MCP_CONFIG_TEXT.saved }
      this.deps.requestRender()
      return
    }
    this.dispatchConfigWrite(prepared.ops, prepared.revision, prepared.generation, MCP_CONFIG_TEXT.saved, () => {
      // A saved draft closes its editor (a failed/conflicted one keeps it).
      if (this.editor === editor) this.editor = undefined
    })
  }

  /**
   * Whether an Add may NOT use this name. The official manager refuses a
   * configured entry whose key collides with a live plugin registration
   * ("a plugin already registers this server name"), and a retained cleanup
   * record still owns its name, so the collision check covers the EFFECTIVE
   * configuration AND the whole current roster — refusing locally instead of
   * dispatching a write the Host would reject.
   */
  private nameTaken(name: string): boolean {
    if (this.configuration.kind === 'ready' && this.configuration.entries.some(entry => entry.name === name)) {
      return true
    }
    return this.servers.has(name) || this.entryTokens.has(name)
  }

  /** Ask for the Enable/Disable confirmation of the selected server. */
  beginToggle(): void {
    if (!this.canEditConfiguration()) return
    const entry = this.selectedConfigEntry()
    if (entry === undefined || this.configuration.kind !== 'ready') return
    this.editor = undefined
    this.configStatus = undefined
    this.configConfirm = {
      kind: 'toggle',
      name: entry.name,
      nextEnabled: entry.effective.enabled === false,
      capturedRevision: this.configuration.revision,
    }
    this.deps.requestRender()
  }

  /** Ask for the permanent-delete confirmation (User-added entries only). */
  beginDelete(): void {
    if (!this.canEditConfiguration()) return
    const entry = this.selectedConfigEntry()
    if (entry === undefined || entry.provenance !== 'user-added') return
    if (this.configuration.kind !== 'ready') return
    this.editor = undefined
    this.configStatus = undefined
    this.configConfirm = { kind: 'delete', name: entry.name, capturedRevision: this.configuration.revision }
    this.deps.requestRender()
  }

  /** Ask for the reset-to-inherited confirmation (overridden entries only). */
  beginReset(): void {
    if (!this.canEditConfiguration()) return
    const entry = this.selectedConfigEntry()
    if (entry === undefined || entry.provenance !== 'overridden') return
    if (this.configuration.kind !== 'ready') return
    this.editor = undefined
    this.configStatus = undefined
    this.configConfirm = { kind: 'reset', name: entry.name, capturedRevision: this.configuration.revision }
    this.deps.requestRender()
  }

  /**
   * Answer the pending CRUD confirmation. Only an affirmative answer for the
   * EXACT confirmed target (still selected, still the same generation, still
   * the same revision and provenance) dispatches; anything else cancels with
   * zero writes.
   */
  answerConfigConfirm(confirmed: boolean): void {
    if (this.disposed || this.configConfirm === undefined) return
    const confirmation = this.configConfirm
    this.configConfirm = undefined
    if (!confirmed) {
      this.deps.requestRender()
      return
    }
    // A Save answers a question about the FORM's draft (which for an Add has
    // no entry yet and no list selection), so it is dispatched through the
    // editor's own fences instead of the selected-entry ones.
    if (confirmation.kind === 'save') {
      if (this.configuration.kind !== 'ready') {
        this.configStatus = { kind: 'unavailable', text: MCP_CONFIG_TEXT.unavailable }
        this.deps.requestRender()
        return
      }
      if (this.configuration.revision !== confirmation.capturedRevision) {
        this.configStatus = { kind: 'conflict', text: MCP_CONFIG_TEXT.conflict }
        this.refreshConfiguration()
        this.deps.requestRender()
        return
      }
      this.commitEditorSave()
      return
    }
    if (this.selected !== confirmation.name) {
      this.deps.requestRender()
      return
    }
    const entry = this.selectedConfigEntry()
    if (entry === undefined || this.configuration.kind !== 'ready') {
      this.configStatus = { kind: 'unavailable', text: MCP_CONFIG_TEXT.unavailable }
      this.deps.requestRender()
      return
    }
    // The confirmation is a decision about ONE configuration: when the
    // namespace moved after the question was asked, the answer no longer
    // describes it (another editor may have changed the same entry). Refuse,
    // keep zero writes, and re-read so the user decides again on current facts.
    if (this.configuration.revision !== confirmation.capturedRevision) {
      this.configStatus = { kind: 'conflict', text: MCP_CONFIG_TEXT.conflict }
      this.refreshConfiguration()
      this.deps.requestRender()
      return
    }
    const generation = this.configuration.generation
    const revision = this.configuration.revision
    switch (confirmation.kind) {
      case 'delete':
        if (entry.provenance !== 'user-added') return
        this.dispatchConfigWrite(mcpRemoveOps(entry.name), revision, generation, MCP_CONFIG_TEXT.deleted)
        return
      case 'reset':
        if (entry.provenance !== 'overridden') return
        this.dispatchConfigWrite(mcpRemoveOps(entry.name), revision, generation, MCP_CONFIG_TEXT.reset)
        return
      case 'toggle': {
        const nextEnabled = confirmation.nextEnabled === true
        this.dispatchConfigWrite(
          mcpSetEnabledOps(entry.name, nextEnabled),
          revision,
          generation,
          nextEnabled ? MCP_CONFIG_TEXT.toggleOn : MCP_CONFIG_TEXT.toggleOff,
        )
      }
    }
  }

  /** Clear the ONE config status slot (a settled result acknowledged). */
  clearConfigStatus(): void {
    if (this.disposed || this.configStatus === undefined || this.configStatus.kind === 'saving') return
    this.configStatus = undefined
    this.deps.requestRender()
  }

  /**
   * Dispatch EXACTLY ONE official configuration mutation. A dispatched write is
   * never claimed cancelled: closing the page only stops its result being
   * presented here.
   */
  private dispatchConfigWrite(
    ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[],
    revision: number,
    generation: McpServerGeneration,
    successText: string,
    onSaved?: () => void,
  ): void {
    const token = this.openToken
    const writeToken = ++this.configWriteToken
    this.configStatus = { kind: 'saving', text: MCP_CONFIG_TEXT.saving }
    this.notice = undefined
    this.deps.requestRender()
    this.deps.runOwned('MCP configuration write', async () => {
      let outcome: McpConfigWriteOutcome
      try {
        outcome = await this.deps.configuration.mutate(ops, revision, generation)
      } catch (error) {
        outcome = {
          kind: 'failed',
          failure: { kind: 'outcome-unconfirmed', reason: error instanceof Error ? error.message : 'the write result is unknown' },
        }
      }
      if (this.disposed || token !== this.openToken || writeToken !== this.configWriteToken) return
      if (outcome.kind === 'saved') {
        onSaved?.()
        this.configStatus = { kind: 'saved', text: successText }
        // The saved entry's own revision moved: re-read so the next edit pins
        // the CURRENT revision instead of the one this write consumed.
        this.refreshConfiguration()
      } else {
        switch (outcome.failure.kind) {
          case 'conflict':
            this.configStatus = { kind: 'conflict', text: MCP_CONFIG_TEXT.conflict }
            this.refreshConfiguration()
            break
          case 'outcome-unconfirmed':
            this.configStatus = { kind: 'unconfirmed', text: MCP_CONFIG_TEXT.unconfirmed }
            break
          case 'rejected':
            this.configStatus = { kind: 'rejected', text: `Not saved · ${outcome.failure.reason}` }
            break
        }
      }
      this.deps.requestRender()
    })
  }

  private editorSnapshot(editor: McpEditorState): McpEditorSnapshot {
    const draft = entryDraftOf(editor.draft)
    const dirty = editor.entry === undefined
      ? true
      : mcpEditOps(editor.draft.name, editor.entry.effective, draft, diffMcpServerDraft(editor.entry.effective, draft)).length > 0
    return {
      mode: editor.mode,
      name: editor.draft.name,
      nameEditable: editor.mode === 'add',
      transport: editor.draft.transport,
      command: editor.draft.command,
      args: Object.freeze([...editor.draft.args]),
      env: Object.freeze([...editor.draft.env.entries()].map(([key, value]) => ({ key, value }))),
      cwd: editor.draft.cwd,
      url: editor.draft.url,
      headers: Object.freeze([...editor.draft.headers.entries()].map(([key, value]) => ({ key, value }))),
      enabled: editor.draft.enabled,
      dirty,
      issues: validateMcpServerDraft(editor.draft.name, draft),
      capturedRevision: editor.revision,
    }
  }

  private currentGeneration(): McpServerGeneration | undefined {
    return this.generation
  }

  /** Whether the committed source read belongs to the CURRENT roster generation. */
  private sourceMatchesGeneration(): boolean {
    return this.sources.kind === 'ready'
      && this.generation !== undefined
      && Object.is(this.sources.generation, this.generation)
  }

  private sourceOf(view: McpServerView): McpServerSourceLabel {
    // A key set from another Host generation is never combined with this
    // roster: the source is Unknown until a same-generation read is proven.
    if (!this.sourceMatchesGeneration()) return 'Unknown'
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

  /**
   * Retire every fact bound to the REPLACED Host authority: any in-flight
   * operation, the restart confirmation, the last probe report and a completed
   * operation's feedback. A dispatched restart keeps its unconfirmed wording;
   * a probe simply loses its stale result.
   */
  private retireGenerationBoundState(): void {
    this.operationToken += 1
    this.operationController?.abort()
    this.operationController = undefined
    this.confirming = undefined
    this.lastProbe = undefined
    if (this.operation?.phase === 'running') {
      const text = this.operation.kind === 'restart'
        ? RESTART_LOST_NOTE
        : 'Observation lost; the result was discarded'
      this.operation = { ...this.operation, phase: 'failed', text }
      this.notice = { text, kind: 'error' }
    } else {
      this.operation = undefined
      this.notice = undefined
    }
    // FR4: the configuration facts are generation-bound too. The descriptor
    // verdict degrades to unavailable, and an open draft/confirmation bound to
    // the replaced Host dies with it (zero writes). A config write ALREADY
    // DISPATCHED is never claimed cancelled: its settlement simply stops being
    // this page's business — the write token is retired so a late result can
    // never repaint the new Host's page, and the in-flight latch is released so
    // the new authority's page is not locked by the old saving state.
    this.configuration = { kind: 'unavailable', reason: 'the Host authority changed' }
    this.editor = undefined
    this.configConfirm = undefined
    this.configWriteToken += 1
    this.configStatus = undefined
  }

  private acceptWatchEvent(event: McpServerWatchEvent): void {
    if (event.kind === 'invalidated') {
      this.retireGenerationBoundState()
      this.phase = event.reason === 'unavailable' ? 'unavailable' : 'read-error'
      this.phaseReason = event.reason === 'unavailable'
        ? 'Host MCP Manager is not mounted'
        : 'the Host MCP server observation is not current; press r to refresh'
      this.generation = undefined
      this.confirmedKeySet = undefined
      this.sources = { kind: 'unavailable', reason: event.reason }
      // FR4: a non-current observation can never authorize an edit — the
      // configuration verdict degrades to unavailable and every open draft or
      // confirmation is retired (zero writes).
      this.configuration = { kind: 'unavailable', reason: event.reason }
      this.editor = undefined
      this.configConfirm = undefined
      this.entryTokens.clear()
      this.deps.requestRender()
      return
    }
    // A new Host authority replaces every generation-bound display fact: the
    // previous Host's probe report/feedback/confirmation never describes it.
    if (this.generation !== undefined && !Object.is(this.generation, event.roster.generation)) {
      this.retireGenerationBoundState()
      if (this.operation?.kind === 'probe') {
        this.operation = undefined
        this.notice = undefined
      }
    }
    this.generation = event.roster.generation
    this.phase = 'ready'
    this.phaseReason = undefined
    this.rosterEpoch += 1
    // A roster frame is only one half of the non-atomic joint snapshot: the
    // previous settings key set does NOT describe this roster until a fresh
    // same-generation read confirms it. Everything is Unknown in between.
    this.sources = { kind: 'stale', reason: 'the roster changed; the settings source read is pending' }
    this.confirmedKeySet = undefined
    const epoch = this.rosterEpoch
    const previousOrder = [...this.order]
    this.servers.clear()
    this.order.length = 0
    const liveNames = new Set(event.roster.servers.map(view => view.name))
    for (const name of [...this.entryTokens.keys()]) {
      if (liveNames.has(name)) continue
      this.entryTokens.delete(name)
      // A removed (and possibly later re-added) name must not keep the previous
      // entry's probe report or confirmation.
      if (this.lastProbe?.name === name) this.lastProbe = undefined
      if (this.confirming?.name === name) this.confirming = undefined
    }
    for (const view of event.roster.servers) {
      this.servers.set(view.name, view)
      this.order.push(view.name)
      // A continuously listed name keeps its token; a removal + re-add gets a
      // fresh one.
      if (!this.entryTokens.has(view.name)) this.entryTokens.set(view.name, {})
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
    // FR4: the configuration read is bound to the SAME roster generation, so
    // it is re-read with it (never a separate poll).
    this.refreshConfiguration()
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
        if (verdict.kind !== 'ready') {
          this.sources = verdict
          this.confirmedKeySet = undefined
          this.deps.requestRender()
          return
        }
        // The source read must belong to THIS roster generation; a key set
        // from another Host authority is never combined with this roster.
        if (this.generation === undefined || !Object.is(verdict.generation, this.generation)) {
          this.sources = { kind: 'stale', reason: 'the settings source is not from the current Host generation' }
          this.confirmedKeySet = undefined
          this.deps.requestRender()
          return
        }
        const previous = this.sources
        const agreed = previous.kind === 'ready'
          && Object.is(previous.generation, verdict.generation)
          && sameKeys(previous.configuredNames, verdict.configuredNames)
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
    const entryToken = this.entryTokens.get(name)
    if (entryToken === undefined) return
    const token = this.openToken
    const operationToken = ++this.operationToken
    const controller = new AbortController()
    this.operationController = controller
    this.operation = { kind: 'probe', name, phase: 'running' }
    this.notice = undefined
    this.deps.requestRender()
    this.deps.runOwned('MCP server probe', async () => {
      const outcome = await this.deps.port.probe(name, controller.signal)
      // The result belongs to ITS page token, Host generation AND roster entry
      // only. A discarded result still ENDS this page's operation: a permanent
      // "running" latch would disable every later Probe/Restart.
      if (this.disposed || token !== this.openToken || this.operationToken !== operationToken) return
      const generationCurrent = outcome.generation === generation && this.generation === generation
      const entryCurrent = this.entryTokens.get(name) === entryToken
        && this.servers.get(name)?.configured === true
      if (!generationCurrent || !entryCurrent) {
        if (this.operation?.kind === 'probe' && this.operation.name === name) {
          const text = 'Probe result discarded (the Host or server changed)'
          this.operation = { kind: 'probe', name, phase: 'failed', text }
          this.notice = { text, kind: 'error' }
        }
        this.operationController = undefined
        this.deps.requestRender()
        return
      }
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
    const entryToken = this.entryTokens.get(name)
    if (entryToken === undefined) return
    const token = this.openToken
    const operationToken = ++this.operationToken
    const controller = new AbortController()
    this.operationController = controller
    this.operation = { kind: 'restart', name, phase: 'running' }
    this.notice = { text: `Restart requested for ${name} · waiting for Host status`, kind: 'info' }
    this.deps.requestRender()
    this.deps.runOwned('MCP server restart', async () => {
      // EXACTLY ONE dispatch: no retry, no second confirmation.
      const outcome = await this.deps.port.restart(name, controller.signal)
      if (this.disposed || token !== this.openToken || this.operationToken !== operationToken) return
      const generationCurrent = outcome.generation === generation && this.generation === generation
      const entryCurrent = this.entryTokens.get(name) === entryToken
        && this.servers.get(name)?.configured === true
      if (!generationCurrent || !entryCurrent) {
        // The page now speaks for a different Host generation or the target is
        // no longer the listed entry: a dispatched request's settlement is not
        // this page's fact, and it is never claimed cancelled.
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
      } else if (outcome.failure.kind === 'outcome-unconfirmed' || outcome.failure.kind === 'superseded') {
        // A dispatched restart that lost its confirmation is NEVER reported as
        // "could not be dispatched" (Direct's manager-replacement settlement
        // arrives as `superseded` after the call was issued).
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
