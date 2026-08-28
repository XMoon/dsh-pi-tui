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
import { detectConflicts, scopesOverlap } from './conflicts.ts'
import { canonicalizeKeyId } from './key-identity.ts'
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
  RuleOwner,
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
  /** The full resolution set: every non-deactivated rule (shadowed rules
   * stay — the resolver picks the highest-priority predicate-passing
   * candidate across ALL owners, so a conditional top trigger with a
   * false predicate lets a shadowed lower rule fire in context). */
  private activeRules: EffectiveBindingRule[] = []
  /** The READ-MODEL set: top triggers only, where "top" means an
   * UNCONDITIONAL higher-priority rule (a conditional top trigger cannot
   * permanently hide a lower rule — in the contexts where its predicate
   * fails the lower rule genuinely fires, so the read model keeps
   * advertising it; review finding). Every read API — keysFor/keyHint/
   * snapshot/hostActiveKeys/hostKeysFor/editorKeysFor — projects from
   * this ONE set (review finding: snapshot used to iterate the raw set
   * and re-advertised replaced builtins). */
  private visibleRules: EffectiveBindingRule[] = []
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
    // Same-action + same-canonical-key declarations DEDUPE (plan §6.1):
    // `['ctrl+s', 'ctrl+s']` (or alias spellings of one key) is ONE
    // trigger, never a self-conflict. Tracked by action+canonicalKey; the
    // FIRST declaration (highest source priority among identical ones)
    // wins. This runs before conflict detection so a duplicated key never
    // deactivates itself.
    const isDuplicate = (action: string, key: KeyId): boolean =>
      rules.some(rule => rule.action === action && rule.key === key)
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
        // (`false` was handled above, so this is a key, key list, or the
        // LEADER-ONLY EMPTY-ARRAY marker.) A conditional action's user
        // rules inherit its predicate.
        const predicate = predicateByAction.get(definition.id)
        const keys = Array.isArray(userValue) ? userValue : [userValue]
        for (const key of keys) {
          const rule = { ...this.rule(definition, key, 'user', PRIORITY.user), ...predicate === undefined ? {} : { predicate } }
          if (!isDuplicate(rule.action, rule.key)) rules.push(rule)
        }
        // For an EDITOR-OWNED action (submit) the BUILTIN also compiles as
        // an owner=editor rule: a NON-EMPTY user override (priority 200)
        // shadows it when effective, but if the override CONFLICTS away
        // (e.g. submit=ctrl+x vs history=ctrl+x), the builtin Enter
        // survives the shadow as the fail-soft (convergence §4.5 — no
        // fabricated fallback: the builtin was always a declared rule, it
        // just gets shadowed by a WORKING override). The LEADER-ONLY
        // marker (an EMPTY user array) is a full replacement declaration
        // and does NOT compile the builtin fallback either — the leader
        // sequence is the only trigger (review round 37: the unified
        // override contract — a leader-only submit must not keep the
        // builtin Enter declared in the unified model, so resolve(Enter)
        // returns undefined and matches(Enter, submit) is false). Explicit
        // `false` was handled above and skips this entirely.
        if (definition.hostResolved === false && keys.length > 0) {
          for (const key of definition.defaultKeys) {
            const rule = this.rule(definition, key, 'builtin', PRIORITY.builtin)
            if (!isDuplicate(rule.action, rule.key)) rules.push(rule)
          }
        }
        continue
      }
      if (definition.hostResolved === false) {
        // The editor-owned defaults (submit's Enter) DO compile — as
        // owner=editor rules — so the unified model sees them
        // (conflict/shadow/read-model); the Host resolver excludes them
        // (convergence §3 finding: submit participates in the model, the
        // fork editor executes it).
        for (const key of definition.defaultKeys) {
          const rule = this.rule(definition, key, 'builtin', PRIORITY.builtin)
          if (!isDuplicate(rule.action, rule.key)) rules.push(rule)
        }
        continue
      }
      for (const key of definition.defaultKeys) {
        const rule = this.rule(definition, key, 'builtin', PRIORITY.builtin)
        if (!isDuplicate(rule.action, rule.key)) rules.push(rule)
      }
    }
    // 3. Composition (conditional affordance) rules. Skipped when the user
    // DISABLED the action (`false` disables every source of its keys).
    for (const composition of this.compositionRules) {
      const definition = this.definitions[composition.action]
      if (definition === undefined) continue
      if (this.includeScopes !== undefined && !this.includeScopes.has(definition.scope)) continue
      if (!this.safeMode && this.userBindings[composition.action] === false) continue
      const compositionRule = {
        id: `${composition.action}@composition:${canonicalizeKeyId(composition.key)}`,
        action: composition.action,
        key: canonicalizeKeyId(composition.key),
        source: 'composition' as const,
        scope: definition.scope,
        priority: PRIORITY.composition,
        owner: 'host' as const,
        predicate: composition.predicate,
      }
      if (!isDuplicate(compositionRule.action, compositionRule.key)) rules.push(compositionRule)
    }
    // 4. Plugin contributions (lowest priority; never beats a Host rule).
    for (const plugin of this.pluginRules) {
      // The rule id is NAMESPACED (convergence finding): the public
      // contribution id is arbitrary and could equal a HOST rule id
      // (e.g. `app.input.steer@builtin:ctrl+s`); deactivation is by id,
      // so a plugin-id collision would deactivate the HOST rule too. The
      // `plugin:` prefix is impossible for a host rule (host ids are
      // `${action}@${source}:${key}`) and preserves the public id for
      // diagnostics.
      const pluginRule = {
        id: `plugin:${plugin.id}`,
        action: plugin.action,
        key: canonicalizeKeyId(plugin.key),
        source: 'plugin' as const,
        scope: 'global' as const,
        priority: PRIORITY.plugin,
        owner: 'plugin' as const,
      }
      if (!isDuplicate(pluginRule.action, pluginRule.key)) rules.push(pluginRule)
    }
    // 5. Conflict detection: deactivate conflicting rules, report them.
    const { conflicts, deactivated: conflicted } = detectConflicts(rules)
    // The deactivation set is mutated below (the editor-owned fail-soft
    // deactivation), so copy the conflict result.
    const deactivated = new Set(conflicted)
    this.conflicts = conflicts
    // 5b. EDITOR-OWNED FAIL-SOFT deactivation (review round 37 — the
    // unified override contract): for an editor-owned action (submit), a
    // WORKING user direct override must remove the builtin default from
    // the RUNTIME resolver too — not just from the read model. The
    // builtin Enter rule compiles as a fail-soft (convergence §4.5) so a
    // CONFLICTED override restores it, but when a user-owned editor rule
    // of the same action is LIVE (not deactivated), the builtin default
    // is removed from the resolution set: resolve(Enter) is undefined and
    // matches(Enter, submit) is false — one effective truth everywhere.
    // (A conflicted-away override has no live user editor rule, so the
    // builtin survives — the documented conflict fail-soft.)
    const userEditorLive = new Set<string>()
    for (const rule of rules) {
      if (deactivated.has(rule.id)) continue
      if (rule.owner === 'editor' && rule.source === 'user') userEditorLive.add(rule.action)
    }
    for (const rule of rules) {
      if (rule.owner === 'editor' && rule.source === 'builtin'
        && userEditorLive.has(rule.action)) {
        deactivated.add(rule.id)
      }
    }
    // 6. PRIORITY SHADOW (plan §6.2, convergence §4.3): for each key, the
    // highest-priority tier that still has a live (non-deactivated) rule
    // is the TOP TRIGGER; every LOWER-priority rule on the same key with
    // an OVERLAPPING scope is SHADOWED for the READ MODEL. Shadowed rules
    // STAY in the resolution set, because shadowing is CONTEXT-AWARE: a
    // conditional high-priority rule whose predicate is FALSE in a given
    // context must NOT block the lower rule from firing (convergence §4.3
    // finding — the resolver picks the highest-priority predicate-passing
    // candidate). READ-MODEL shadowing is therefore CONDITIONAL-AWARE too
    // (review finding): only an UNCONDITIONAL top trigger permanently
    // hides a lower rule; a conditional top trigger (a predicate exists)
    // advertises BOTH the conditional claim and its context fallback —
    // otherwise the read model would hide a key that genuinely fires in
    // half the contexts (keyHint/snapshot lied while the runtime was
    // context-aware). (The higher tier may itself be fully
    // conflict-deactivated; then the next tier is the top — plan §6.3 —
    // provided its rules were DECLARED, never a fabricated builtin
    // fallback.)
    const shadowed = new Set<string>()
    {
      const byKey = new Map<KeyId, EffectiveBindingRule[]>()
      for (const rule of rules) {
        if (deactivated.has(rule.id)) continue
        const list = byKey.get(rule.key) ?? []
        list.push(rule)
        byKey.set(rule.key, list)
      }
      for (const keyRules of byKey.values()) {
        if (keyRules.length < 2) continue
        const maxPriority = Math.max(...keyRules.map(rule => rule.priority))
        const topRules = keyRules.filter(rule => rule.priority === maxPriority)
        // A purely conditional top tier never shadows in the read model.
        if (!topRules.some(rule => rule.predicate === undefined)) continue
        for (const rule of keyRules) {
          if (rule.priority >= maxPriority) continue
          // Only shadow when the scopes actually overlap with a winner.
          const winnerOverlaps = topRules.some(winner =>
            scopesOverlap(rule.scope, winner.scope))
          if (winnerOverlaps) shadowed.add(rule.id)
        }
      }
    }
    // Resolution set: every non-deactivated rule (shadowed rules stay —
    // the resolver's predicate-aware priority pick may need them as
    // context fallbacks).
    this.activeRules = rules.filter(rule => !deactivated.has(rule.id))
    // Read-model set: top triggers only (unconditionally shadowed rules
    // excluded).
    this.visibleRules = rules.filter(rule => !deactivated.has(rule.id) && !shadowed.has(rule.id))
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
    // The rule id is PER KEY (`${action}@${source}:${key}`): conflict
    // deactivation is by id, so a conflict on ONE key of a multi-key
    // action deactivates THAT key only — never the action's other keys
    // (review finding: a shared `${action}@${source}` id chained the
    // deactivation across every key of the action, and the resolve
    // tie-break could not tell the rules apart either).
    // The key is CANONICALIZED at compile time: every spelling of one
    // physical key (esc/escape, ctrl+shift+p / shift+ctrl+p) becomes the
    // SAME rule key, so conflict detection, dedupe, the leader collision
    // and the read model all share one identity (convergence contract).
    // OWNER: a hostResolved:false definition's keys are EXECUTED BY THE
    // FORK EDITOR (the unified model's editor-owned tier — submit) — they
    // never resolve in the Host ladder, but they participate in
    // conflict/shadow/read-model (convergence §3 finding).
    const canonical = canonicalizeKeyId(key)
    const owner: RuleOwner = definition.hostResolved === false ? 'editor' : 'host'
    return {
      id: `${definition.id}@${source}:${canonical}`,
      action: definition.id,
      key: canonical,
      source,
      scope: definition.scope,
      priority,
      owner,
    }
  }

  /** Resolve one raw input event against the live context. Predicates are
   * evaluated ONLY for keys that match (a lazy context field like
   * `editorEmpty` must not be read on every keystroke).
   *
   * OWNER-AWARE WINNER SELECTION (review finding): ALL owners compete —
   * host, editor (the fork-editor-owned submit triggers) and plugin — and
   * the winner is the highest-priority predicate-passing rule. The
   * resolution carries the winner's OWNER; the caller routes execution by
   * it ('host' → the Host dispatcher, 'editor' → the fork editor via
   * hostResolved:false, 'plugin' → the plugin remainder). The owner is
   * NEVER a pre-filter: an editor-owned USER submit override (200) must
   * beat a host builtin (100) on the same key (`submit: ctrl+s` really
   * submits — the old code skipped editor rules BEFORE picking a winner,
   * so steer won at runtime while the read model advertised submit). */
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
    return {
      action: best.action,
      key: best.key,
      source: best.source,
      ruleId: best.id,
      owner: best.owner,
    }
  }

  /** The action one raw event resolves to (context-aware), or undefined. */
  actionFor(data: string, context: KeybindingContext): string | undefined {
    return this.resolve(data, context)?.action
  }

  /** Whether the raw event matches ANY effective key of one action
   * (context predicates are NOT applied — use {@link resolve} when the
   * rule is conditional). */
  matches(data: string, action: string): boolean {
    for (const rule of this.visibleRules) {
      if (rule.action !== action) continue
      if (matchesKey(data, rule.key)) return true
    }
    return false
  }

  /** The read-model projection of ONE action: its visible rules. A
   * working user override already REPLACED the builtin at compile time
   * (the user-declaration branch skips the builtin compilation — unified
   * override contract, review round 37), and any unconditionally shadowed
   * rule was removed by the priority-shadow step, so this set is the
   * effective truth. The editor-owned builtin of submit is additionally
   * filtered here for safety (convergence §4.5: a working user remap
   * never advertises the replaced Enter alongside), though the step-5b
   * deactivation already removes it from the resolution set. This is the
   * SINGLE projection behind keysFor/editorKeysFor/hostKeysFor/snapshot —
   * one fact everywhere (review finding: the snapshot used to iterate the
   * raw visible set and re-advertised a replaced builtin). */
  private visibleRulesFor(action: string): EffectiveBindingRule[] {
    const rules = this.visibleRules.filter(rule => rule.action === action)
    if (!rules.some(rule => rule.source === 'user')) return rules
    return rules.filter(rule => !(rule.owner === 'editor' && rule.source !== 'user'))
  }

  /** The effective keys of one action (all sources, visible rules only —
   * an unconditionally shadowed lower rule is never advertised,
   * convergence §4.3; a conditional top claim keeps its fallback visible,
   * review finding). For an EDITOR-OWNED action with a working user
   * override, the builtin default is replaced (not advertised
   * alongside). */
  keysFor(action: string): KeyId[] {
    return [...new Set(this.visibleRulesFor(action).map(rule => rule.key))]
  }

  /** Every ACTIVE key across all rules (conflict detection: the leader
   * prefix must not collide with an active direct key — PR review
   * finding). NOTE: this includes PLUGIN rules — use
   * {@link hostActiveKeys} for the host-owned reservation/conflict
   * checks (PR review finding: plugin rules must never be treated as
   * Host actions). */
  activeKeys(): KeyId[] {
    const keys = new Set<KeyId>()
    for (const rule of this.activeRules) keys.add(rule.key)
    return [...keys]
  }

  /** Every ACTIVE key of the HOST-owned sources only (builtin / user /
   * composition — PLUGIN and EDITOR rules excluded). The runtime
   * reservation and the leader-prefix collision check must consider only
   * these: a plugin binding is NOT a Host action, so it neither reserves
   * a key in the router nor collides with the leader prefix; an
   * EDITOR-owned submit key is the fork editor's (the leader collision
   * check covers it via the editorSubmitKeysFor sync — PR review
   * finding). */
  hostActiveKeys(): KeyId[] {
    const keys = new Set<KeyId>()
    for (const rule of this.visibleRules) {
      if (rule.owner !== 'host') continue
      keys.add(rule.key)
    }
    return [...keys]
  }

  /** Whether the raw input resolves to a HOST-owned action (plugin and
   * editor rules excluded). WINNER-BASED (review finding): the winner of
   * the unified selection decides — `submit: ctrl+s` (editor-owned
   * winner) is NOT host-resolved, so the router lets the key reach the
   * fork editor instead of swallowing it; the old check returned true
   * whenever ANY host rule matched, so the remapped key was reserved
   * while the read model promised submit. The input router's runtime
   * reservation uses this: a key only a PLUGIN binds is NOT host-reserved
   * and must reach the plugin dispatch stage (PR review finding). */
  hostResolves(data: string, context: KeybindingContext): boolean {
    return this.resolve(data, context)?.owner === 'host'
  }

  /** The effective keys of one action from the HOST sources ONLY
   * (plugin rules excluded — a plugin binding is additive, never a
   * replacement of the host's key; PR review finding). */
  hostKeysFor(action: string): KeyId[] {
    const keys = new Set<KeyId>()
    for (const rule of this.visibleRules) {
      if (rule.owner !== 'host') continue
      if (rule.action === action) keys.add(rule.key)
    }
    return [...keys]
  }

  /** Every ACTIVE key of the PLUGIN-owned rules (owner=plugin — the
   * Stable plugin bindings). The leader-prefix collision check considers
   * these too (round-12 finding): the leader machine feeds BEFORE the
   * plugin stage, so a leader key equal to a live plugin key would
   * silently swallow the plugin binding while the read model still
   * advertised it — the leader must be disabled instead. Visible rules
   * only: a deactivated (conflicted) or unconditionally shadowed plugin
   * key is not a live binding. */
  pluginActiveKeys(): KeyId[] {
    const keys = new Set<KeyId>()
    for (const rule of this.visibleRules) {
      if (rule.owner !== 'plugin') continue
      keys.add(rule.key)
    }
    return [...keys]
  }

  /** Whether one action can fire in the CURRENT context (convergence
   * §4.7/§8.3): the action has at least one effective rule whose
   * predicate passes. Used by the leader machine before dispatching a
   * completion — a leader sequence is another TRIGGER of the same
   * semantic action and must obey the action's context predicate (e.g.
   * the empty-editor ↓ tasks affordance), never a predicate bypass.
   * Actions with no effective rules cannot activate. */
  canActivate(action: string, context: KeybindingContext): boolean {
    // ACTION AVAILABILITY (convergence §4.7 finding): whether the
    // semantic action MAY fire in the current context — INDEPENDENT of
    // whether a direct trigger currently survives. A leader-only action
    // (no direct rules — e.g. app.transcript.toggleFullscreen) is still
    // available; a direct key that got shadowed/conflicted does NOT make
    // the action unavailable to its OTHER triggers (leader sequences).
    //
    // The availability is the action's context PREDICATE set (the
    // composition affordances like the empty-editor ↓ tasks rule):
    // every applicable predicate must be satisfiable. An action with NO
    // predicates is always available (the caller already checked
    // disabled/reserved).
    const definition = this.definitions[action]
    if (definition === undefined) return false
    const predicates = this.compositionRules
      .filter(composition => composition.action === action)
      .map(composition => composition.predicate)
    // Any unconditional effective rule makes the action available too
    // (a user direct binding with no predicate).
    for (const rule of this.activeRules) {
      if (rule.action !== action) continue
      if (rule.predicate === undefined) return true
    }
    if (predicates.length === 0) return true
    return predicates.some(predicate => predicate(context))
  }

  /** The effective EDITOR-OWNED keys of one action (owner=editor — the
   * fork editor executes them; convergence §3). Used by
   * `editorSubmitKeysFor` so the sync and the read model derive ONLY from
   * effective editor rules, never the raw config. */
  editorKeysFor(action: string): KeyId[] {
    return [...new Set(this.visibleRulesFor(action)
      .filter(rule => rule.owner === 'editor')
      .map(rule => rule.key))]
  }

  /** Whether a USER-owned editor rule of one action is in the visible
   * read model (a WORKING direct override). The manager uses it to
   * distinguish a leader-only submit override (no direct user rule — the
   * builtin Enter must be removed) from a builtin-only default (review
   * finding: a leader sequence must not clear the direct keys). */
  editorHasUserRule(action: string): boolean {
    return this.visibleRules.some(rule =>
      rule.action === action && rule.owner === 'editor' && rule.source === 'user')
  }

  /** The visible conditional/composition keys of one action. These are
   * context-gated affordances rather than ordinary user-editable defaults.
   * A user rule inherits its action's composition predicate, and may dedupe
   * the synthesized composition rule when it uses the same key, so source
   * alone cannot identify every conditional trigger. */
  conditionalKeysFor(action: string): KeyId[] {
    const compositionKeys = new Set(this.compositionRules
      .filter(composition => composition.action === action)
      .map(composition => canonicalizeKeyId(composition.key)))
    if (compositionKeys.size === 0) return []
    return [...new Set(this.visibleRules
      .filter(rule => rule.action === action
        && compositionKeys.has(rule.key)
        && (rule.source === 'composition' || rule.predicate !== undefined))
      .map(rule => rule.key))]
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

  /** The immutable read model (plan §2 M2). Projects the SAME visible
   * rules as keysFor/editorKeysFor/keyHint — a working user override
   * never leaves the replaced builtin advertised (review finding: the
   * snapshot used to iterate the raw top-trigger set, so /keybindings
   * showed `Ctrl+X + Enter` for a working submit remap while /help was
   * right). */
  snapshot(): KeymapSnapshot {
    const actions = [...new Set(this.visibleRules.map(rule => rule.action))].sort()
    const bindings = actions.map(action => {
      const rules = this.visibleRulesFor(action)
      return {
        action,
        keys: [...new Set(rules.map(rule => rule.key))],
        scope: rules[0]!.scope as AppKeybindingDefinition['scope'],
        source: rules[0]!.source,
      }
    })
    return {
      revision: this.revision,
      bindings,
      conflicts: this.conflicts,
    }
  }
}
