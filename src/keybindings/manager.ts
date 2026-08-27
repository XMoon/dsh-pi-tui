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
import { DEFAULT_LEADER_TIMEOUT_MS } from './config.ts'
import { EffectiveKeymap, type CompositionRule, type PluginKeybindingRule } from './effective-keymap.ts'
import { formatLeaderSequence, formatKeyId } from './hints.ts'
import { LeaderStateMachine } from './leader.ts'
import type {
  AppKeybindingId,
  KeybindingContext,
  KeybindingResolution,
  KeybindingScope,
  KeybindingSource,
  KeymapSnapshot,
  LeaderBinding,
  LeaderConfig,
  UserKeybindingsConfig,
} from './types.ts'

/** The conditional affordance rules (plan §5): the empty-editor ↓ task
 * browser. Kept as a composition rule so a user remap of app.tasks.open
 * replaces the ACTION, while the affordance itself stays conditional.
 * PROMPT-mode only: a shell-mode empty body is composing a command — ↓
 * keeps its editing meaning there, never the browser (the shell-mode
 * exclusion pre-keybindings main had on the raw ↓ routing; the footer's
 * ↓ hint and the routing share this single gate). */
const TASKS_OPEN_AFFORDANCE: CompositionRule = {
  action: 'app.tasks.open',
  key: 'down',
  predicate: (context) => context.focusedSeat === 'editor' && context.editorEmpty
    && context.editorPromptMode && context.tasksActive,
}

export interface HostKeybindingManagerOptions {
  /** Called after every rebuild (the app repaints hints/footer). */
  readonly onInvalidate?: () => void
  /** Called when the leader pending state changes (which-key hint). */
  readonly onLeaderStateChange?: () => void
  /** Called when a leader sequence completes (the app dispatches). */
  readonly onLeaderActivate?: (action: string) => boolean
  /** The leader timeout in ms (defaults to the config default). */
  readonly leaderTimeoutMs?: number
  /**
   * Called after every rebuild with the EFFECTIVE submit keys of
   * `app.input.submit` (an empty array = the action is disabled). The
   * app syncs them into the fork editor's `tui.input.submit` binding so
   * a user remap/disable of submit REALLY moves/removes the editor's
   * Enter submission (review finding — the editor path was previously
   * physical-only and ignored user config).
   */
  readonly onEditorSubmitSync?: (keys: readonly KeyId[]) => void
}

/** The stateful keybinding facade. */
export class HostKeybindingManager {
  private readonly onInvalidate: () => void
  private readonly onLeaderStateChange: () => void
  private readonly onLeaderActivate: (action: string) => boolean
  private readonly onEditorSubmitSync: (keys: readonly KeyId[]) => void
  private readonly leaderTimeoutMs: number

  private userBindings: UserKeybindingsConfig = {}
  private leaderConfig: LeaderConfig | undefined
  private leaderBindings: readonly LeaderBinding[] = []
  /** The ambiguity-filtered, safe-mode-aware leader bindings (what the
   * leader machine actually fires — hints must match, review round 3). */
  private effectiveLeaderBindings: readonly LeaderBinding[] = []
  private pluginRules: readonly PluginKeybindingRule[] = []
  private safeMode = false
  /** True when the leader machine was DISABLED because the leader key
   * collided with an ACTIVE host key (PR review finding — the direct key
   * wins, never a silent shadow). */
  private leaderConfigShadowed = false
  private diagnostics: string[] = []

  private keymap: EffectiveKeymap
  /**
   * MONOTONIC rebuild counter (never restarts): the EffectiveKeymap's own
   * revision resets to 1 on every instance (buildKeymap creates a NEW
   * keymap per rebuild), so consumers keying caches on the keymap
   * revision (the transcript fold-hint cache) must read THIS — a remap,
   * safe-mode flip or plugin sync must invalidate them (review finding).
   */
  private revisionCounter = 0
  private leader: LeaderStateMachine | undefined
  private disposed = false

  constructor(options: HostKeybindingManagerOptions = {}) {
    this.onInvalidate = options.onInvalidate ?? (() => {})
    this.onLeaderStateChange = options.onLeaderStateChange ?? (() => {})
    this.onLeaderActivate = options.onLeaderActivate ?? (() => true)
    this.onEditorSubmitSync = options.onEditorSubmitSync ?? (() => {})
    this.leaderTimeoutMs = options.leaderTimeoutMs ?? 1500
    this.keymap = this.buildKeymap()
    // Sync the BUILTIN submit keys immediately: the fork's keybindings
    // are PROCESS-GLOBAL, so a fresh manager must restore the default
    // `tui.input.submit` — otherwise a previous TUI instance's remap/
    // disable leaks into this one (PR review finding: remap → stop →
    // new default app kept the old ctrl+x/disabled submit).
    this.onEditorSubmitSync(this.editorSubmitKeysFor())
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
    this.revisionCounter += 1
    // Safe mode (plan §17) ignores the user configuration ENTIRELY —
    // including the leader key and its sequences (a leader sequence is a
    // user override; safe mode must restore the builtin surface).
    const effectiveLeaderConfig = this.safeMode ? undefined : this.leaderConfig
    const effectiveLeaderBindings = this.safeMode
      ? []
      : this.leaderBindings.filter(binding => this.userBindings[binding.action] !== false)
    // Leader bindings: a duplicate completing key across DIFFERENT
    // actions is ambiguous — neither fires (plan §6 M6: ambiguous prefix
    // is a diagnostic). Identical (action, key) pairs are DEDUPED first
    // (e.g. `<leader>h` listed twice for ONE action is not ambiguous —
    // review finding). A binding whose action the user DISABLED (false)
    // never fires either.
    const seenPairs = new Set<string>()
    const byKey = new Map<KeyId, LeaderBinding[]>()
    for (const binding of effectiveLeaderBindings) {
      const pair = `${binding.action}\u0000${binding.key}`
      if (seenPairs.has(pair)) continue
      seenPairs.add(pair)
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
    this.effectiveLeaderBindings = leaderBindings
    // Leader PREFIX collision (PR review finding + round-12 finding): the
    // leader key is fed BEFORE the host ladder AND before the plugin
    // stage, so a leader key that is ALSO an ACTIVE direct key of any
    // host action (e.g. `leader: ctrl+f` swallows app.transcript.search)
    // or a LIVE plugin binding would silently shadow it. Fail-soft: the
    // direct/plugin key wins, the leader machine is DISABLED, and the
    // collision is a diagnostic — never a silent shadow. A leader key
    // that only collides with a DISABLED action's key is fine (no active
    // rule).
    const leaderKey = effectiveLeaderConfig?.key
    // Collision with BOTH the host keymap's active keys AND the
    // EDITOR-OWNED submit keys (hostResolved:false actions — the fork
    // editor's tui.input.submit owns them; the keymap does not list them,
    // so e.g. `leader: enter` would silently swallow Enter — PR review
    // finding) AND the live PLUGIN keys (the leader machine feeds before
    // the plugin stage — round-12 finding).
    const pluginCollision = leaderKey !== undefined
      ? this.keymap.pluginActiveKeys().some(key => key === leaderKey)
      : false
    const leaderCollision = leaderKey !== undefined
      ? this.keymap.hostActiveKeys().some(key => key === leaderKey)
        || this.editorSubmitKeysFor().some(key => key === leaderKey)
        || pluginCollision
      : false
    if (leaderCollision && leaderKey !== undefined) {
      this.diagnostics.push(
        pluginCollision
          ? `keybinding: leader key ${formatKeyId(leaderKey)} is also a live plugin key — the leader machine is disabled (the plugin binding wins)`
          : `keybinding: leader key ${formatKeyId(leaderKey)} is also an active host key — the leader machine is disabled (the direct key wins)`,
      )
      // Disable the leader machine AND its advertised bindings: the
      // direct key wins (never a silent shadow — PR review finding). The
      // effectiveLeaderBindings are cleared here so keyHint /
      // keysLabelFor / snapshot never advertise a leader sequence that
      // cannot fire (the "UI always shows the EFFECTIVE keys" contract).
      this.leaderConfigShadowed = true
      this.effectiveLeaderBindings = []
      this.leader?.dispose()
      this.leader = undefined
    } else {
      this.leaderConfigShadowed = false
      this.leader?.dispose()
      this.leader = undefined
      // Rebuild the leader machine ONLY when it has at least one
      // EFFECTIVE completion (convergence §4.6b): with zero completions
      // (every sequence ambiguous/disabled), the machine must not exist —
      // the leader prefix would otherwise enter a dead pending state that
      // can never complete.
      if (effectiveLeaderConfig !== undefined && effectiveLeaderConfig.key !== undefined && leaderBindings.length > 0) {
        // The manager's leaderTimeoutMs option is the SURFACE-LEVEL
        // override: it wins over the config-parse default (the manager
        // owns the machine's timing; a runner/tests can tune it without
        // touching the user config — convergence finding).
        const machineConfig = this.leaderTimeoutMs !== DEFAULT_LEADER_TIMEOUT_MS
          ? { ...effectiveLeaderConfig, timeoutMs: this.leaderTimeoutMs }
          : effectiveLeaderConfig
        this.leader = new LeaderStateMachine(machineConfig, leaderBindings, {
          onActivate: (action) => this.onLeaderActivate(action),
          onStateChange: () => this.onLeaderStateChange(),
        })
      }
    }
    // Sync the effective submit keys into the fork editor's binding
    // (review finding): a user remap or `false` of app.input.submit must
    // REALLY move/remove the editor's submission — the fork editor routes
    // Enter (or the remapped key) through tui.input.submit. Empty = the
    // action is disabled (no key submits).
    this.onEditorSubmitSync(this.editorSubmitKeysFor())
    this.onInvalidate()
  }

  /** The effective submit keys of `app.input.submit` as the fork editor's
   * `tui.input.submit` should carry them: the action's effective direct
   * keys, or an EMPTY array when disabled (`false`) or safe mode dropped
   * them. `app.input.submit` is hostResolved:false — the host ladder
   * NEVER consumes these keys; the editor owns them, so the sync is the
   * only consumer. */
  editorSubmitKeysFor(): KeyId[] {
    if (this.isDisabled('app.input.submit')) return []
    // A truly LEADER-ONLY submit (a live effective sequence AND no
    // working direct user rule) removes Enter: the leader is the only
    // trigger (checked BEFORE the editor-key fallback — the builtin Enter
    // rule is always in the effective set). A leader sequence NEVER
    // clears the DIRECT keys though (review finding): `submit:
    // ['ctrl+z', '<leader>s']` keeps Ctrl+Z AND gains the leader —
    // additive triggers, exactly like every other action (direct +
    // leader = both fire). editorHasUserRule asks whether the user's
    // direct override is EFFECTIVE (a conflicted-away override does not
    // count).
    if (this.effectiveLeaderBindings.some(binding => binding.action === 'app.input.submit')
      && !this.keymap.editorHasUserRule('app.input.submit')) {
      return []
    }
    // The sync derives ONLY from the effective EDITOR-OWNED rules
    // (convergence §3 finding): submit's rules (builtin Enter + user
    // overrides) compile with owner=editor and participate in the unified
    // model, so a conflicted/shadowed override already vanished from the
    // effective set — no raw-config reading here. A user remap that
    // CONFLICTS away (e.g. submit=ctrl+x vs history=ctrl+x) therefore
    // fails soft back to the builtin Enter; only an explicit `false`
    // disables submission entirely.
    const editorKeys = this.keymap.editorKeysFor('app.input.submit')
    if (editorKeys.length > 0) return editorKeys
    // NO definition-default fallback here (convergence §4.5 finding): the
    // builtin Enter is ALREADY compiled as an effective editor-owned rule,
    // so an empty editorKeysFor means the builtin was SHADOWED or
    // CONFLICTED away — resurrecting it would both violate the read model
    // and re-introduce a runtime/UI mismatch. (Safe mode restores the
    // builtin because the keymap compiles it when the user overrides are
    // ignored; an explicit `false` was handled at the top.)
    return []
  }

  // ── Configuration ──────────────────────────────────────────────────────

  /** Apply the parsed user configuration (M3). */
  setUserConfiguration(config: {
    readonly bindings: UserKeybindingsConfig
    readonly leader: LeaderConfig | undefined
    readonly leaderBindings: readonly LeaderBinding[]
  }): void {
    if (this.disposed) return
    this.userBindings = config.bindings
    this.leaderConfig = config.leader
    this.leaderBindings = config.leaderBindings
    this.rebuild()
  }

  /** Safe mode (plan §17): ignore user overrides, keep builtin defaults.
   * Plugin keybindings still load. */
  setSafeMode(enabled: boolean): void {
    if (this.disposed) return
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
    if (this.disposed) return
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

  /** The effective keys of one action (direct keys only — leader
   * sequences live in {@link leaderKeysFor}). For the editor-owned
   * submit action the read model reflects the fork editor's effective
   * trigger keys (convergence §7: one fact everywhere). */
  keysFor(action: AppKeybindingId): KeyId[] {
    if (action === 'app.input.submit') return this.editorSubmitKeysFor()
    return this.keymap.keysFor(action)
  }

  /** Whether one raw input resolves to a HOST-owned action (PLUGIN rules
   * excluded — a plugin binding is not a Host action and must reach the
   * plugin dispatch stage; PR review finding). */
  hostResolves(data: string, context: KeybindingContext): boolean {
    return this.keymap.hostResolves(data, context)
  }

  /** Whether one action can fire in the CURRENT context (leader
   * completions check this before dispatching — a leader sequence obeys
   * the action's context predicate, convergence §4.7). */
  canActivate(action: AppKeybindingId, context: KeybindingContext): boolean {
    // Editor-owned submit: active whenever it has an EFFECTIVE editor
    // trigger (the fork editor's tui.input.submit or a live leader
    // sequence) — a leader submit completion must activate iff submit
    // itself is available (convergence §4.7).
    if (action === 'app.input.submit') {
      if (this.isDisabled(action)) return false
      return this.editorSubmitKeysFor().length > 0
        || this.effectiveLeaderBindings.some(binding => binding.action === action)
    }
    return this.keymap.canActivate(action, context)
  }

  /** The EFFECTIVE `<leader>X` completing keys of one action (M6),
   * ambiguous/disabled sequences excluded. */
  leaderKeysFor(action: AppKeybindingId): KeyId[] {
    return this.effectiveLeaderBindings
      .filter(binding => binding.action === action)
      .map(binding => binding.key)
  }

  /** The full display label for one action: ALL direct keys and ALL
   * leader sequences, each formatted (e.g. `Ctrl+Z / Leader H`); '' when
   * the action advertises nothing (disabled, or no keys at all). */
  keysLabelFor(action: AppKeybindingId): string {
    if (this.isDisabled(action)) return ''
    const direct = this.keysFor(action).map(formatKeyId)
    const leader = this.leaderKeysFor(action).map(formatLeaderSequence)
    if (direct.length > 0 || leader.length > 0) {
      return [...direct, ...leader].join(' / ')
    }
    // ONLY fixed non-configurable component actions (search
    // close/next/previous, question/tasks flows) may display their
    // defaults — they never resolve in the HOST keymap (plan §3.3) and
    // their keys are NOT user-configurable, so the default IS the
    // effective key (convergence §8: no fabricated fallback for
    // configurable actions — a conflicted/shadowed user override must
    // not resurrect the builtin).
    const definition = APP_KEYBINDINGS[action]
    if (definition !== undefined && !definition.configurable && definition.defaultKeys.length > 0) {
      return definition.defaultKeys.map(formatKeyId).join(' / ')
    }
    return ''
  }

  /** The primary effective key of one action, or undefined. */
  primaryKeyFor(action: AppKeybindingId): KeyId | undefined {
    return this.keymap.primaryKeyFor(action)
  }

  /** The human hint for one action (plan §18): the primary key, the
   * leader sequence when the action is only leader-bound, or the default
   * key for non-configurable overlay/component actions. A DISABLED action
   * (user `false`) advertises nothing (review round 2), and the hint uses
   * the EFFECTIVE leader bindings — an ambiguous sequence that never
   * fires is never advertised (review round 3). */
  keyHint(action: AppKeybindingId): string {
    if (this.isDisabled(action)) return ''
    // The read model is unified through keysFor (editor-owned submit
    // included — convergence §7: one fact everywhere).
    const directKeys = this.keysFor(action)
    const direct = directKeys.length > 0 ? formatKeyId(directKeys[0]!) : ''
    const leaderKeys = this.effectiveLeaderBindings
      .filter(binding => binding.action === action)
      .map(binding => formatLeaderSequence(binding.key))
    if (direct !== '' && leaderKeys.length > 0) {
      // Mixed direct + leader: show both (review finding — the leader
      // sequence used to vanish behind the direct key).
      return [direct, ...leaderKeys].join(' / ')
    }
    if (direct !== '') return direct
    if (leaderKeys.length > 0) return leaderKeys[0]!
    // Same no-fabrication rule as keysLabelFor: only fixed
    // non-configurable component actions display their defaults.
    const definition = APP_KEYBINDINGS[action]
    if (definition !== undefined && !definition.configurable && definition.defaultKeys.length > 0) {
      return formatKeyId(definition.defaultKeys[0]!)
    }
    return ''
  }

  /** Whether the user disabled one action (`false`). */
  private isDisabled(action: AppKeybindingId): boolean {
    return !this.safeMode && this.userBindings[action] === false
  }

  /** The immutable read model (diagnostics + /keybindings). The
   * capturing-scope actions (search overlay, question/tasks flows) are not
   * in the host keymap; their defaults are merged in for display. A
   * DISABLED action is never advertised (review round 2). Leader-only
   * actions (no default keys, only `<leader>X` bindings) are merged in
   * with their leader sequences (review finding: they were advertised by
   * keyHint but absent from the table). */
  snapshot(): KeymapSnapshot {
    const snapshot = this.keymap.snapshot()
    const present = new Set(snapshot.bindings.map(binding => binding.action))
    const leaderKeys = new Map<string, KeyId[]>()
    for (const binding of this.effectiveLeaderBindings) {
      const list = leaderKeys.get(binding.action) ?? []
      list.push(binding.key)
      leaderKeys.set(binding.action, list)
    }
    type MutableSnapshotBinding = {
      action: string
      keys: KeyId[]
      scope: KeybindingScope
      source: KeybindingSource
      leaderKeys?: KeyId[]
    }
    const merged: MutableSnapshotBinding[] = snapshot.bindings.map(binding => ({
      action: binding.action,
      // The snapshot projects the SAME per-action effective keys as
      // keysFor/keyHint (external-review finding): the manager-level
      // projection for app.input.submit is editorSubmitKeysFor, which a
      // LEADER-ONLY override empties — the keymap row alone cannot see
      // the manager-level leader state and would re-advertise the inert
      // builtin Enter. For every other action keysFor is the keymap's own
      // visible-rules projection, so the row is unchanged.
      keys: [...this.keysFor(binding.action as AppKeybindingId)],
      scope: binding.scope,
      source: binding.source,
    }))
    // Actions with BOTH direct and leader keys: attach the leader keys to
    // the existing row (review finding — they were silently dropped).
    for (const binding of merged) {
      const leader = leaderKeys.get(binding.action)
      if (leader === undefined) continue
      binding.leaderKeys = leader
    }
    for (const [id, definition] of Object.entries(APP_KEYBINDINGS)) {
      if (present.has(id)) continue
      if (this.isDisabled(id as AppKeybindingId)) continue
      const leader = leaderKeys.get(id)
      if (leader !== undefined) {
        merged.push({
          action: id,
          keys: [],
          leaderKeys: leader,
          scope: definition.scope,
          source: 'user',
        })
        continue
      }
      // No fabricated builtin fallback for CONFIGURABLE actions (a
      // conflicted/shadowed override must not resurrect the default);
      // only fixed non-configurable component actions display defaults
      // (their keys never resolve in the host keymap, plan §3.3).
      if (definition.defaultKeys.length === 0 || definition.configurable) continue
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

  /** The current keymap revision — MONOTONIC across rebuilds (see
   * {@link revisionCounter}); every effective-key change bumps it, so caches
   * keyed on it (transcript fold hints) rebuild exactly when the keys do. */
  revision(): number {
    return this.revisionCounter
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
