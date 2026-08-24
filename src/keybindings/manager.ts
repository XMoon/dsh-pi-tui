/**
 * The Host keybinding manager (plan §2 M1/M2/M3/M6): the stateful facade
 * the app and the runner use. It owns:
 *
 * - the effective keymap (defaults + user overrides + plugin rules);
 * - the leader state machine (M6);
 * - fail-soft diagnostics (plan §16);
 * - safe mode (plan §17: ignore user overrides).
 *
 * The manager NEVER executes business behavior — it only resolves keys to
 * semantic actions. Execution lives in the AppActionDispatcher.
 * @module @xmoon76/dsh-pi-tui/keybindings/manager
 */

import type { KeyId } from '@xmoon76/pi-tui'
import { matchesKey } from '@xmoon76/pi-tui'
import { APP_KEYBINDINGS } from './definitions.ts'
import { EffectiveKeymap, type CompositionRule, type PluginKeybindingRule } from './effective-keymap.ts'
import { formatLeaderSequence, formatKeyId } from './hints.ts'
import { LeaderStateMachine } from './leader.ts'
import type {
  AppKeybindingId,
  KeybindingContext,
  KeybindingResolution,
  KeymapSnapshot,
  LeaderBinding,
  LeaderConfig,
  UserKeybindingsConfig,
} from './types.ts'

/** The conditional affordance rules (plan §5): the empty-editor ↓ task
 * browser. Kept as a composition rule so a user remap of app.tasks.open
 * replaces the ACTION, while the affordance itself stays conditional. */
const TASKS_OPEN_AFFORDANCE: CompositionRule = {
  action: 'app.tasks.open',
  key: 'down',
  predicate: (context) => context.focusedSeat === 'editor' && context.editorEmpty && context.tasksActive,
}

export interface HostKeybindingManagerOptions {
  /** Called after every rebuild (the app repaints hints/footer). */
  readonly onInvalidate?: () => void
  /** Called when the leader pending state changes (which-key hint). */
  readonly onLeaderStateChange?: () => void
  /** Called when a leader sequence completes (the app dispatches). */
  readonly onLeaderActivate?: (action: string) => void
  /** The leader timeout in ms (defaults to the config default). */
  readonly leaderTimeoutMs?: number
}

/** The stateful keybinding facade. */
export class HostKeybindingManager {
  private readonly onInvalidate: () => void
  private readonly onLeaderStateChange: () => void
  private readonly onLeaderActivate: (action: string) => void
  private readonly leaderTimeoutMs: number

  private userBindings: UserKeybindingsConfig = {}
  private leaderConfig: LeaderConfig | undefined
  private leaderBindings: readonly LeaderBinding[] = []
  private pluginRules: readonly PluginKeybindingRule[] = []
  private safeMode = false
  private diagnostics: string[] = []

  private keymap: EffectiveKeymap
  private leader: LeaderStateMachine | undefined
  private disposed = false

  constructor(options: HostKeybindingManagerOptions = {}) {
    this.onInvalidate = options.onInvalidate ?? (() => {})
    this.onLeaderStateChange = options.onLeaderStateChange ?? (() => {})
    this.onLeaderActivate = options.onLeaderActivate ?? (() => {})
    this.leaderTimeoutMs = options.leaderTimeoutMs ?? 1500
    this.keymap = this.buildKeymap()
  }

  private buildKeymap(): EffectiveKeymap {
    return new EffectiveKeymap({
      definitions: APP_KEYBINDINGS,
      userBindings: this.safeMode ? {} : this.userBindings,
      pluginRules: this.pluginRules,
      compositionRules: [TASKS_OPEN_AFFORDANCE],
      safeMode: this.safeMode,
      // The HOST keymap resolves the non-capturing scopes only: the
      // focused-component actions (question.*/tasks.*) and the search
      // overlay keys live in their own contexts (plan §3.3) and must never
      // resolve in the host ladder.
      includeScopes: new Set(['global', 'editor', 'agent-running']),
      onDiagnostic: (message) => this.diagnostics.push(message),
    })
  }

  private rebuild(): void {
    if (this.disposed) return
    this.diagnostics = []
    // Leader bindings: a duplicate completing key is ambiguous — neither
    // fires (plan §6 M6: ambiguous prefix is a diagnostic).
    const byKey = new Map<KeyId, LeaderBinding[]>()
    for (const binding of this.leaderBindings) {
      const list = byKey.get(binding.key) ?? []
      list.push(binding)
      byKey.set(binding.key, list)
    }
    const leaderBindings: LeaderBinding[] = []
    for (const [key, list] of byKey) {
      if (list.length > 1) {
        this.diagnostics.push(
          `keybinding: ambiguous leader sequence <leader>${formatKeyId(key)} (${list.map(binding => binding.action).join(' vs ')}) — neither fires`,
        )
        continue
      }
      leaderBindings.push(list[0]!)
    }
    this.keymap = this.buildKeymap()
    // Rebuild the leader machine (its bindings/config may have changed).
    this.leader?.dispose()
    this.leader = undefined
    if (this.leaderConfig !== undefined) {
      this.leader = new LeaderStateMachine(this.leaderConfig, leaderBindings, {
        onActivate: (action) => this.onLeaderActivate(action),
        onStateChange: () => this.onLeaderStateChange(),
      })
    }
    this.onInvalidate()
  }

  // ── Configuration ──────────────────────────────────────────────────────

  /** Apply the parsed user configuration (M3). */
  setUserConfiguration(config: {
    readonly bindings: UserKeybindingsConfig
    readonly leader: LeaderConfig | undefined
    readonly leaderBindings: readonly LeaderBinding[]
  }): void {
    this.userBindings = config.bindings
    this.leaderConfig = config.leader
    this.leaderBindings = config.leaderBindings
    this.rebuild()
  }

  /** Safe mode (plan §17): ignore user overrides, keep builtin defaults.
   * Plugin keybindings still load. */
  setSafeMode(enabled: boolean): void {
    if (this.safeMode === enabled) return
    this.safeMode = enabled
    this.rebuild()
  }

  /** Whether safe mode is active. */
  isSafeMode(): boolean {
    return this.safeMode
  }

  /** Replace the plugin contributions (the runner wires the keybinding
   * registry's snapshot). A no-op when the rules are unchanged (the
   * runner may call this on every registry invalidation). */
  setPluginRules(rules: readonly PluginKeybindingRule[]): void {
    if (this.pluginRules.length === rules.length
      && this.pluginRules.every((rule, index) => {
        const next = rules[index]!
        return rule.id === next.id && rule.action === next.action && rule.key === next.key
      })) {
      return
    }
    this.pluginRules = rules
    this.rebuild()
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  /** Resolve one raw input event against the live context. */
  resolve(data: string, context: KeybindingContext): KeybindingResolution | undefined {
    return this.keymap.resolve(data, context)
  }

  /** The action one raw event resolves to (context-aware), or undefined. */
  actionFor(data: string, context: KeybindingContext): string | undefined {
    return this.keymap.actionFor(data, context)
  }

  /** Whether the raw event matches ANY effective key of one action
   * (context predicates NOT applied — use {@link resolve} for
   * conditional rules). */
  matches(data: string, action: AppKeybindingId): boolean {
    return this.keymap.matches(data, action)
  }

  /** Whether the raw event matches the action's DEFAULT keys. Used for
   * the non-configurable overlay/component keys (search overlay,
   * question/tasks flows) whose effective keys are always the defaults —
   * they never resolve in the host keymap (plan §3.3). */
  matchesDefault(data: string, action: AppKeybindingId): boolean {
    const definition = APP_KEYBINDINGS[action]
    if (definition === undefined) return false
    return definition.defaultKeys.some(key => matchesKey(data, key))
  }

  /** The effective keys of one action. */
  keysFor(action: AppKeybindingId): KeyId[] {
    return this.keymap.keysFor(action)
  }

  /** The primary effective key of one action, or undefined. */
  primaryKeyFor(action: AppKeybindingId): KeyId | undefined {
    return this.keymap.primaryKeyFor(action)
  }

  /** The human hint for one action (plan §18): the primary key, the
   * leader sequence when the action is only leader-bound, or the default
   * key for non-configurable overlay/component actions. */
  keyHint(action: AppKeybindingId): string {
    const direct = this.keymap.keyHint(action)
    if (direct !== '') return direct
    const leaderBinding = this.leaderBindings.find(binding => binding.action === action)
    if (leaderBinding !== undefined) return formatLeaderSequence(leaderBinding.key)
    const definition = APP_KEYBINDINGS[action]
    if (definition !== undefined && definition.defaultKeys.length > 0) {
      return formatKeyId(definition.defaultKeys[0]!)
    }
    return ''
  }

  /** The immutable read model (diagnostics + /keybindings). The
   * capturing-scope actions (search overlay, question/tasks flows) are not
   * in the host keymap; their defaults are merged in for display. */
  snapshot(): KeymapSnapshot {
    const snapshot = this.keymap.snapshot()
    const present = new Set(snapshot.bindings.map(binding => binding.action))
    const merged = [...snapshot.bindings]
    for (const [id, definition] of Object.entries(APP_KEYBINDINGS)) {
      if (present.has(id)) continue
      if (definition.defaultKeys.length === 0) continue
      merged.push({
        action: id,
        keys: [...definition.defaultKeys],
        scope: definition.scope,
        source: 'builtin',
      })
    }
    merged.sort((left, right) => left.action.localeCompare(right.action))
    return { ...snapshot, bindings: merged }
  }

  /** The fail-soft diagnostics of the last rebuild. */
  diagnosticsList(): readonly string[] {
    return [...this.diagnostics]
  }

  /** The current keymap revision. */
  revision(): number {
    return this.keymap.snapshot().revision
  }

  // ── Leader (M6) ────────────────────────────────────────────────────────

  /** The leader machine (undefined when no leader key is configured). */
  leaderMachine(): LeaderStateMachine | undefined {
    return this.leader
  }

  /** Cancel any pending leader sequence (focus transitions). */
  cancelLeader(): void {
    this.leader?.cancel()
  }

  /** Dispose the manager (clears the leader timer). */
  dispose(): void {
    this.disposed = true
    this.leader?.dispose()
    this.leader = undefined
  }
}

/** Convert the public normalized key shape (the plugin registry's
 * identity) into the fork's KeyId grammar (the keymap's identity). */
export function normalizedKeyToKeyId(key: { readonly key: string; readonly ctrl: boolean; readonly alt: boolean; readonly shift: boolean; readonly super: boolean }): KeyId {
  const parts: string[] = []
  if (key.ctrl) parts.push('ctrl')
  if (key.alt) parts.push('alt')
  if (key.shift) parts.push('shift')
  if (key.super) parts.push('super')
  parts.push(key.key)
  return parts.join('+') as KeyId
}
