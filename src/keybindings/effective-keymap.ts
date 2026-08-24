/**
 * The EffectiveKeymap (plan §7/§8/§2 M2): compiles Host defaults + user
 * overrides + plugin contributions into a unified read model of RULES, and
 * resolves raw input against the live context.
 *
 * The InputRouter (input-router.ts) keeps its protocol/capture/focus
 * precedence — the keymap is consulted ONLY when the ladder allows
 * keybinding resolution (plan §8: the InputRouter must NOT be deleted).
 *
 * Priorities (plan §8 / §15):
 * - plugin: 10 (a plugin binding never beats a Host action);
 * - builtin / composition: 100;
 * - user: 200 (a user override beats the builtin default).
 *
 * Conflicts (same key + overlapping scope + same priority) are deactivated
 * with a diagnostic — never silent last-write-wins (plan §15/§16).
 * @module @xmoon76/dsh-pi-tui/keybindings/effective-keymap
 */

import { matchesKey, type KeyId } from '@xmoon76/pi-tui'
import { detectConflicts } from './conflicts.ts'
import { formatKeyId } from './hints.ts'
import type {
  AppKeybindingDefinition,
  AppKeybindingId,
  EffectiveBindingRule,
  KeybindingContext,
  KeybindingResolution,
  KeybindingScope,
  KeybindingSource,
  KeymapSnapshot,
  UserKeybindingsConfig,
} from './types.ts'

/** The priority ladder of the effective keymap. */
export const PRIORITY = {
  plugin: 10,
  builtin: 100,
  composition: 100,
  user: 200,
} as const

/** One plugin keybinding contribution compiled into the keymap. */
export interface PluginKeybindingRule {
  readonly id: string
  readonly action: string
  readonly key: KeyId
}

/** The conditional affordance rules synthesized by the host (plan §5):
 * `↓` + empty editor + active tasks → app.tasks.open. */
export interface CompositionRule {
  readonly action: AppKeybindingId
  readonly key: KeyId
  readonly predicate: (context: KeybindingContext) => boolean
}

export interface EffectiveKeymapOptions {
  readonly definitions: Readonly<Record<string, AppKeybindingDefinition>>
  /** User overrides (M3); `false` disables the action's keys entirely. */
  readonly userBindings?: UserKeybindingsConfig
  /** Plugin contributions (source 'plugin', lowest priority). */
  readonly pluginRules?: readonly PluginKeybindingRule[]
  /** Conditional affordance rules (source 'composition'). */
  readonly compositionRules?: readonly CompositionRule[]
  /** Safe mode: ignore user overrides (plan §17). */
  readonly safeMode?: boolean
  /** Diagnostic sink (fail-soft reporting, plan §16). */
  readonly onDiagnostic?: (message: string) => void
  /** When set, only definitions whose scope is in this set compile rules.
   * The HOST keymap includes the non-capturing scopes only — the
   * focused-component actions (the question and tasks families) and the
   * search overlay keys live in their own contexts and must never resolve
   * in the host ladder (plan §3.3). */
  readonly includeScopes?: ReadonlySet<KeybindingScope>
}

/** The compiled, conflict-checked rule set. */
export class EffectiveKeymap {
  private readonly definitions: Readonly<Record<string, AppKeybindingDefinition>>
  private readonly userBindings: UserKeybindingsConfig
  private readonly pluginRules: readonly PluginKeybindingRule[]
  private readonly compositionRules: readonly CompositionRule[]
  private readonly safeMode: boolean
  private readonly onDiagnostic: (message: string) => void
  private readonly includeScopes: ReadonlySet<KeybindingScope> | undefined

  private revision = 0
  private activeRules: EffectiveBindingRule[] = []
  private conflicts: ReturnType<typeof detectConflicts>['conflicts'] = []

  constructor(options: EffectiveKeymapOptions) {
    this.definitions = options.definitions
    this.userBindings = options.userBindings ?? {}
    this.pluginRules = options.pluginRules ?? []
    this.compositionRules = options.compositionRules ?? []
    this.safeMode = options.safeMode ?? false
    this.onDiagnostic = options.onDiagnostic ?? (() => {})
    this.includeScopes = options.includeScopes
    this.rebuild()
  }

  /** Recompile the rule set (after a user/plugin/safe-mode change). */
  rebuild(): void {
    const rules: EffectiveBindingRule[] = []
    const diagnostics: string[] = []
    // The conditional predicate of one action (the composition rules):
    // a USER override of a conditional action must keep the SAME
    // predicate — e.g. a remap of app.tasks.open must not open the task
    // browser with a non-empty editor or no active tasks (plan §5).
    const predicateByAction = new Map<string, (context: KeybindingContext) => boolean>()
    for (const composition of this.compositionRules) {
      predicateByAction.set(composition.action, composition.predicate)
    }
    // 1. Builtin defaults (skipped for actions the user disabled, for
    // actions outside the keymap's scope set, and for actions whose
    // default key belongs to a focused component — hostResolved: false).
    for (const definition of Object.values(this.definitions)) {
      if (this.includeScopes !== undefined && !this.includeScopes.has(definition.scope)) continue
      const userValue = this.safeMode ? undefined : this.userBindings[definition.id as AppKeybindingId]
      if (userValue === false) {
        diagnostics.push(`keybinding "${definition.id}" disabled by user config`)
        continue
      }
      if (userValue !== undefined) {
        // 2. User overrides replace the builtin keys for this action.
        // (`false` was handled above, so this is a key or key list.) A
        // conditional action's user rules inherit its predicate.
        const predicate = predicateByAction.get(definition.id)
        const keys = Array.isArray(userValue) ? userValue : [userValue]
        for (const key of keys) {
          rules.push({ ...this.rule(definition, key, 'user', PRIORITY.user), ...predicate === undefined ? {} : { predicate } })
        }
        continue
      }
      if (definition.hostResolved === false) continue
      for (const key of definition.defaultKeys) {
        rules.push(this.rule(definition, key, 'builtin', PRIORITY.builtin))
      }
    }
    // 3. Composition (conditional affordance) rules. Skipped when the user
    // DISABLED the action (`false` disables every source of its keys).
    for (const composition of this.compositionRules) {
      const definition = this.definitions[composition.action]
      if (definition === undefined) continue
      if (this.includeScopes !== undefined && !this.includeScopes.has(definition.scope)) continue
      if (!this.safeMode && this.userBindings[composition.action] === false) continue
      rules.push({
        id: `${composition.action}@composition`,
        action: composition.action,
        key: composition.key,
        source: 'composition',
        scope: definition.scope,
        priority: PRIORITY.composition,
        predicate: composition.predicate,
      })
    }
    // 4. Plugin contributions (lowest priority; never beats a Host rule).
    for (const plugin of this.pluginRules) {
      rules.push({
        id: plugin.id,
        action: plugin.action,
        key: plugin.key,
        source: 'plugin',
        scope: 'global',
        priority: PRIORITY.plugin,
      })
    }
    // 5. Conflict detection: deactivate conflicting rules, report them.
    const { conflicts, deactivated } = detectConflicts(rules)
    this.conflicts = conflicts
    this.activeRules = rules.filter(rule => !deactivated.has(rule.id))
    for (const conflict of conflicts) {
      const names = conflict.actions.map(entry => `${entry.ruleId} (${entry.scope}, ${entry.source})`).join(' vs ')
      diagnostics.push(`keybinding conflict on ${formatKeyId(conflict.key)}: ${names} — neither binding was activated`)
    }    for (const message of diagnostics) this.onDiagnostic(message)
    this.revision += 1
  }

  private rule(
    definition: AppKeybindingDefinition,
    key: KeyId,
    source: KeybindingSource,
    priority: number,
  ): EffectiveBindingRule {
    return {
      id: `${definition.id}@${source}`,
      action: definition.id,
      key,
      source,
      scope: definition.scope,
      priority,
    }
  }

  /** Resolve one raw input event against the live context. Predicates are
   * evaluated ONLY for keys that match (a lazy context field like
   * `editorEmpty` must not be read on every keystroke). */
  resolve(data: string, context: KeybindingContext): KeybindingResolution | undefined {
    let best: EffectiveBindingRule | undefined
    for (const rule of this.activeRules) {
      if (!matchesKey(data, rule.key)) continue
      if (rule.predicate !== undefined && !rule.predicate(context)) continue
      if (best === undefined
        || rule.priority > best.priority
        || (rule.priority === best.priority && rule.id < best.id)) {
        best = rule
      }
    }
    if (best === undefined) return undefined
    return { action: best.action, key: best.key, source: best.source, ruleId: best.id }
  }

  /** The action one raw event resolves to (context-aware), or undefined. */
  actionFor(data: string, context: KeybindingContext): string | undefined {
    return this.resolve(data, context)?.action
  }

  /** Whether the raw event matches ANY effective key of one action
   * (context predicates are NOT applied — use {@link resolve} when the
   * rule is conditional). */
  matches(data: string, action: string): boolean {
    for (const rule of this.activeRules) {
      if (rule.action !== action) continue
      if (matchesKey(data, rule.key)) return true
    }
    return false
  }

  /** The effective keys of one action (all sources). */
  keysFor(action: string): KeyId[] {
    const keys = new Set<KeyId>()
    for (const rule of this.activeRules) {
      if (rule.action === action) keys.add(rule.key)
    }
    return [...keys]
  }

  /** The primary (first) effective key of one action, or undefined. */
  primaryKeyFor(action: string): KeyId | undefined {
    const keys = this.keysFor(action)
    return keys[0]
  }

  /** The human hint for one action's primary key (plan §18). */
  keyHint(action: string): string {
    const key = this.primaryKeyFor(action)
    return key === undefined ? '' : formatKeyId(key)
  }

  /** The current conflicts (diagnostics). */
  conflictsList(): ReturnType<typeof detectConflicts>['conflicts'] {
    return this.conflicts
  }

  /** The immutable read model (plan §2 M2). */
  snapshot(): KeymapSnapshot {
    const byAction = new Map<string, { keys: KeyId[]; scope: string; source: KeybindingSource }>()
    for (const rule of this.activeRules) {
      const entry = byAction.get(rule.action) ?? { keys: [], scope: rule.scope, source: rule.source }
      entry.keys.push(rule.key)
      byAction.set(rule.action, entry)
    }
    return {
      revision: this.revision,
      bindings: [...byAction.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([action, entry]) => ({
          action,
          keys: entry.keys,
          scope: entry.scope as AppKeybindingDefinition['scope'],
          source: entry.source,
        })),
      conflicts: this.conflicts,
    }
  }
}
