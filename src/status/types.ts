/**
 * Unified status semantics (plan M0): the ONE vocabulary the footer, the
 * extension snapshots and the command protocol consume. Every section is a
 * FACT projection — deeply readonly, no secrets, no live Agent/Session/
 * Context/terminal, no session events, no preformatted display strings.
 *
 * Naming rules (plan §2.1): Preset = a set of configuration; Policy = a
 * behavior rule; State = the current state; `Mode` survives only where
 * upstream or the existing surface already names it (Sandbox Mode / Plan
 * Mode / Focus Mode). There is deliberately NO generic `mode` field.
 * @module @xmoon76/dsh-pi-tui/status
 */

/** What the user is currently looking at (plan §4.6). */
export interface ViewStatus {
  readonly subject:
    | { readonly kind: 'main' }
    | {
        readonly kind: 'subagent'
        readonly id: string
        readonly label?: string
        readonly mode: 'one-shot' | 'continuable'
        /** Store-snapshot activity (running = live record, inactive =
         * persisted only). Display fact of the viewer identity block. */
        readonly activity?: 'running' | 'inactive'
      }
}

/** UI keyboard focus and screen state (plan §4.5). Distinct from Focus Mode. */
export interface SurfaceStatus {
  readonly focusedSeat: 'editor' | 'overlay' | 'editor-panel' | 'none'
  readonly fullscreen: boolean
}

/** How the agent is composed (plan §4.1). NOT permission, NOT plan. */
export interface CompositionStatus {
  readonly agentPreset?: {
    readonly id: string
    readonly label: string
    readonly shortLabel?: string
  }
  readonly model?: {
    readonly provider?: string
    readonly id: string
    readonly displayName: string
    readonly reasoningEffort?: string
  }
}

/** The agent's current access/approval constraints (plan §4.2). */
export interface AccessStatus {
  readonly permissionPreset?: {
    readonly id: string
    readonly label: string
    readonly matched: boolean
  }
  readonly sandbox?: {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly enforcement?: 'full' | 'partial'
  }
  readonly approval?: {
    readonly policy: 'ask' | 'never'
  }
}

/** Plan collaboration state (plan §4.3). `pending` = a user selection not
 * yet committed as the effective state. */
export interface PlanStatus {
  readonly effective: boolean
  readonly pending?: boolean
}

/** Focus Mode: the TUI's own presentation + behavioral policy (plan §4.4). */
export interface InteractionStatus {
  readonly focusMode: boolean
}

/** The workspace the display subject lives in (plan §4.7). */
export interface WorkspaceStatus {
  readonly cwd: string
  readonly project?: string
  readonly branch?: string
}

/** The machine's run phase (plan §4.8). Precedence is fixed by
 * {@link deriveActivityPhase}; the footer never re-derives it. */
export type RunPhase =
  | 'idle'
  | 'working'
  | 'waiting-approval'
  | 'waiting-question'
  | 'compacting'
  | 'applying-compaction'

/** Activity facts (plan §4.8). `busy` is the machine-behavior fact the
 * Esc/cancel path reads; it is NOT the same as `phase`. */
export interface ActivityStatus {
  readonly phase: RunPhase
  readonly busy: boolean
  readonly queuedCount: number
  readonly taskCount: number
  readonly childAgentCount: number
  readonly todoCount: number
}

/** Structured usage facts (plan §4.9). Display words belong to formatters,
 * never to this snapshot. */
export interface UsageStatus {
  readonly context?: {
    readonly usedTokens?: number
    readonly windowTokens?: number
    readonly percent?: number
  }
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly cacheHitPct?: number
  /** Model performance facts. Field names are frozen for the status
   * contract; the SEMANTICS are: `llmMs` = the session LIFETIME LLM wall
   * (kept for /stats and analysis, not shown in the default footer),
   * `firstTokenMs` = the RECENT (last 5) average time-to-first-token,
   * `tokensPerSec` = the RECENT (last 5) effective output throughput
   * (Σ output / Σ full LLM wall). */
  readonly performance: {
    readonly llmMs: number
    readonly firstTokenMs: number
    readonly tokensPerSec: number
  }
  readonly turns: number
  readonly steps: number
}

/** Host identity facts (plan §4.10). */
export interface HostStatus {
  readonly dshVersion?: string
  readonly tuiVersion: string
}

/** The unified status snapshot (plan §5): the ONLY input the footer
 * composer, the extension snapshot derivations and the command protocol
 * consume. */
export interface StatusSnapshot {
  readonly view: ViewStatus
  readonly surface: SurfaceStatus
  readonly composition: CompositionStatus
  readonly access: AccessStatus
  readonly collaboration: {
    readonly plan: PlanStatus
  }
  readonly interaction: InteractionStatus
  readonly workspace: WorkspaceStatus
  readonly activity: ActivityStatus
  readonly usage: UsageStatus
  readonly host: HostStatus
}

/** A partial update merged into the store (section-level; a section is
 * replaced as a whole). */
export type StatusPatch = {
  readonly [K in keyof StatusSnapshot]?: StatusSnapshot[K]
}

/** The empty baseline: every optional fact absent, counts zeroed. */
export function emptyStatusSnapshot(): StatusSnapshot {
  return {
    view: { subject: { kind: 'main' } },
    surface: { focusedSeat: 'editor', fullscreen: false },
    composition: {},
    access: {},
    collaboration: { plan: { effective: false } },
    interaction: { focusMode: false },
    workspace: { cwd: '' },
    activity: {
      phase: 'idle',
      busy: false,
      queuedCount: 0,
      taskCount: 0,
      childAgentCount: 0,
      todoCount: 0,
    },
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 0, firstTokenMs: 0, tokensPerSec: 0 },
      turns: 0,
      steps: 0,
    },
    host: { tuiVersion: '0.0.0' },
  }
}
