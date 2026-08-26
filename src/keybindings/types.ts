/**
 * The user-orchestrable keybinding architecture (plan:
 * temp/20260825/dsh-pi-tui-keybinding-customization-implementation-plan-2026-08-24.md).
 *
 * The pipeline the plan mandates:
 *
 * ```text
 * Physical Key
 *     ↓
 * Semantic Action ID
 *     ↓
 * Context-aware resolver
 *     ↓
 * Host handler
 * ```
 *
 * This module defines the CONTRACT types only: action ids, scopes,
 * definitions, the context the resolver reads, the compiled rules, and the
 * resolution/snapshot shapes. The runtime pieces live in
 * definitions.ts / context.ts / effective-keymap.ts / conflicts.ts /
 * config.ts / leader.ts / manager.ts / action-dispatcher.ts / hints.ts.
 *
 * Design rules (plan §2, §4, §15):
 * - terminal protocol is NEVER configurable;
 * - plugins never receive raw terminal bytes;
 * - focused components own context-local keymaps;
 * - the user configures which KEY an ACTION maps to (never the reverse);
 * - business code stops knowing physical keys (M1);
 * - the same key may legally map to different actions in disjoint scopes;
 * - a conflict is: same key AND overlapping scope AND same effective
 *   priority — never a bare "declared twice" check.
 * @module @xmoon76/dsh-pi-tui/keybindings/types
 */

import type { KeyId } from '@xmoon76/pi-tui'

/**
 * The stable semantic action ids of the HOST surface (plan §3.2). The
 * `app.*` family is the Host global surface; `question.*` and `tasks.*`
 * are focused-component actions (plan §3.3) that only resolve while the
 * corresponding component owns the seat.
 */
export type AppKeybindingId =
  // Input / Agent
  | 'app.input.submit'
  | 'app.input.queue'
  | 'app.input.steer'
  | 'app.input.dequeue'
  | 'app.agent.interrupt'
  | 'app.exit.request'
  // Transcript
  | 'app.transcript.search'
  | 'app.transcript.search.next'
  | 'app.transcript.search.previous'
  | 'app.transcript.search.close'
  | 'app.transcript.toggleExpand'
  | 'app.transcript.toggleThinking'
  | 'app.transcript.toggleFullscreen'
  // Editor / Clipboard
  | 'app.editor.external'
  | 'app.clipboard.pasteMedia'
  // Permissions / Panels
  | 'app.permission.cycle'
  | 'app.todo.toggle'
  | 'app.tasks.open'
  | 'app.history.search'
  // Local shell
  | 'app.shell.dismissSettled'
  // Session / Model (reserved for later unification; no default keys)
  | 'app.session.open'
  | 'app.session.new'
  | 'app.session.resume'
  | 'app.model.open'
  // Focused component: the user-questions flow (plan §3.3)
  | 'question.confirm'
  | 'question.cancel'
  | 'question.previous'
  | 'question.next'
  | 'question.cursorUp'
  | 'question.cursorDown'
  | 'question.pageUp'
  | 'question.pageDown'
  | 'question.toggleExpand'
  // Focused component: the task browser (plan §3.3)
  | 'tasks.confirm'
  | 'tasks.cancel'
  | 'tasks.cursorUp'
  | 'tasks.cursorDown'
  | 'tasks.pageUp'
  | 'tasks.pageDown'
  | 'tasks.cycleType'
  | 'tasks.interrupt'

/**
 * The static context contract of one binding (plan §4). The first version
 * has no user-written `when` expressions; `scope` is the internal static
 * context contract and may later compile into a when predicate.
 */
export type KeybindingScope =
  | 'global'
  | 'editor'
  | 'overlay'
  | 'search'
  | 'question'
  | 'approval'
  | 'viewer'
  | 'agent-running'
  | 'tasks'

/** One action definition (plan §4). */
export interface AppKeybindingDefinition {
  readonly id: AppKeybindingId
  readonly defaultKeys: readonly KeyId[]
  readonly description: string
  readonly category: string
  readonly scope: KeybindingScope
  /** Whether the user may override this action's keys (M3). */
  readonly configurable: boolean
  /** Availability tier (convergence §7): 'implemented' (default) has
   * real host behavior; 'reserved' is NOT implemented in this version —
   * never user-configurable, never a bindable no-op. */
  readonly availability?: 'implemented' | 'reserved'
  /** Whether the HOST ladder consumes this action's keys. `false` marks
   * actions whose default key belongs to a focused component (e.g. Enter
   * stays with the fork editor's submit path — paste-burst/backslash
   * semantics); the builtin rule is then NOT compiled, but a user override
   * still is (a custom submit key routes through submitDraft). */
  readonly hostResolved?: boolean
}

/**
 * The user-facing value of one action in the settings document (plan §12):
 * - a string: a single key;
 * - an array: multiple keys;
 * - `false`: disable the user binding for this action (the action keeps
 *   its builtin default unless the user ALSO disabled it — see
 *   {@link UserKeybindingsConfig} semantics in config.ts);
 * - a `<leader>X` string: a leader-sequence binding (M6).
 */
export type UserKeybindingValue = KeyId | readonly KeyId[] | false

/**
 * The user keybinding overrides (plan §13). `false` DISABLES the action's
 * user binding; the action then falls back to its builtin default keys
 * (the plan's fail-soft rule: a bad entry never disables the whole map).
 */
export type UserKeybindingsConfig = Partial<Record<AppKeybindingId, UserKeybindingValue>>

/**
 * The live surface context the resolver reads (plan §6). TuiApp builds it
 * in ONE place (`keybindingContext()`); the resolver never reaches into
 * TuiApp private fields, so the resolution logic stays unit-testable.
 */
export interface KeybindingContext {
  /** Which seat owns the editor right now. */
  readonly focusedSeat: 'editor' | 'overlay' | 'editor-panel' | 'none'
  /** A user-questions flow currently owns the seat (capturing). */
  readonly questionActive: boolean
  /** An approval prompt is currently shown (capturing). */
  readonly approvalActive: boolean
  /** The subagent viewer mode. */
  readonly viewerMode: 'none' | 'readonly' | 'continuable'
  /** The transcript-search overlay is open (owns its keys). */
  readonly searchActive: boolean
  /** Any non-search overlay is mounted (owns the focused component). */
  readonly overlayActive: boolean
  /** The agent is currently running (busy). */
  readonly agentRunning: boolean
  /** The focused editor's draft is empty. */
  readonly editorEmpty: boolean
  /** The editor's autocomplete dropdown is open. */
  readonly autocompleteActive: boolean
  /** Background tasks/subagents are active (the ↓ browser affordance). */
  readonly tasksActive: boolean
}

/** Where an effective rule came from (plan §7). */
export type KeybindingSource = 'builtin' | 'plugin' | 'composition' | 'user'

/** Who EXECUTES a rule's key (convergence §3). `editor` rules are the
 * fork-editor-owned submit triggers: they participate in the unified
 * model (canonical/conflict/shadow/snapshot/read-model) but are NEVER
 * resolved by the HOST ladder — `resolve`/`hostResolves`/
 * `hostActiveKeys`/`hostKeysFor` exclude them, and the fork editor (via
 * `onEditorSubmitSync`) executes them, preserving paste-burst and
 * backslash-newline semantics. */
export type RuleOwner = 'host' | 'editor' | 'plugin'

/** One compiled rule of the effective keymap (plan §7). */
export interface EffectiveBindingRule {
  readonly id: string
  readonly action: string
  readonly key: KeyId
  readonly source: KeybindingSource
  readonly scope: KeybindingScope
  readonly priority: number
  /** The executor: 'host' (Host ladder), 'editor' (fork editor-owned),
   * or 'plugin' (a Stable plugin binding). */
  readonly owner: RuleOwner
  /** Optional context predicate (e.g. the empty-editor ↓ affordance). */
  readonly predicate?: (context: KeybindingContext) => boolean
}

/** The outcome of one resolution (plan §7). */
export interface KeybindingResolution {
  readonly action: string
  readonly key: KeyId
  readonly source: KeybindingSource
  readonly ruleId: string
}

/** One detected conflict (plan §15): same key + overlapping scope + same
 * effective priority. Never silently last-write-wins. */
export interface KeybindingConflict {
  readonly key: KeyId
  readonly actions: readonly {
    readonly action: string
    readonly scope: KeybindingScope
    readonly source: KeybindingSource
    /** The deactivated rule id (diagnostics). */
    readonly ruleId: string
  }[]
}

/** The immutable read model of the effective keymap (plan §2 M2). */
export interface KeymapSnapshot {
  readonly revision: number
  readonly bindings: readonly {
    readonly action: string
    readonly keys: readonly KeyId[]
    readonly scope: KeybindingScope
    readonly source: KeybindingSource
    /** The `<leader>X` completing keys of this action (M6), separate
     * from the direct `keys`: an action can have BOTH (e.g.
     * `['ctrl+z', '<leader>t']`). Display renders them with the leader
     * prefix. Absent = no leader bindings. */
    readonly leaderKeys?: readonly KeyId[]
  }[]
  readonly conflicts: readonly KeybindingConflict[]
}

/** The leader (M6) configuration. */
export interface LeaderConfig {
  /** The leader key (e.g. `ctrl+x`); undefined disables the leader. */
  readonly key: KeyId | undefined
  /** How long a pending leader sequence stays armed, in ms. */
  readonly timeoutMs: number
}

/** One leader-sequence binding (`<leader>t` → action). */
export interface LeaderBinding {
  readonly action: AppKeybindingId
  /** The completing key (e.g. `t` for `<leader>t`). */
  readonly key: KeyId
}
