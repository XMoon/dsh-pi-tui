/**
 * The conflict model (plan §15): a conflict is
 *
 * ```text
 * same key
 * AND overlapping scope
 * AND same effective priority
 * ```
 *
 * — never a bare "declared twice" check. Examples:
 *
 * ```text
 * Esc + question → question.cancel        legal (different keymaps)
 * Esc + agent-running → app.agent.interrupt
 *
 * Ctrl+R + editor → app.history.search   conflict (same keymap, same scope)
 * Ctrl+R + editor → app.session.rename
 * ```
 *
 * Conflicting rules are DEACTIVATED (fail-soft, plan §16): neither fires,
 * the diagnostic lists both, and every other rule keeps working. There is
 * deliberately NO silent last-write-wins.
 * @module @xmoon76/dsh-pi-tui/keybindings/conflicts
 */

import type { EffectiveBindingRule, KeybindingConflict, KeybindingScope } from './types.ts'
import type { KeyId } from '@xmoon76/pi-tui'

/** The scopes that are mutually exclusive capturing surfaces: when one is
 * active the others are not (they live in different keymaps anyway — the
 * host keymap never mixes them with app.* rules). */
const CAPTURING_SCOPES: ReadonlySet<KeybindingScope> = new Set([
  'question',
  'approval',
  'overlay',
  'search',
  'viewer',
  'tasks',
])

/** Whether two scopes can be active at the same time (plan §15). The
 * capturing scopes (question/approval/overlay/search/viewer/tasks) are
 * mutually exclusive surfaces: while one is active the host ladder never
 * resolves (the InputRouter's precedence owns the key first), so a
 * capturing-scope rule NEVER conflicts with a non-capturing rule or with a
 * DIFFERENT capturing scope. The non-capturing scopes
 * (global/editor/agent-running) all overlap with each other. */
export function scopesOverlap(left: KeybindingScope, right: KeybindingScope): boolean {
  if (left === right) return true
  const leftCapturing = CAPTURING_SCOPES.has(left)
  const rightCapturing = CAPTURING_SCOPES.has(right)
  if (leftCapturing || rightCapturing) return false
  return true
}

/** Detect conflicts among a set of rules. Returns the conflicting rules
 * (to be deactivated) and the conflict records (for diagnostics). */
export function detectConflicts(rules: readonly EffectiveBindingRule[]): {
  readonly conflicts: readonly KeybindingConflict[]
  readonly deactivated: ReadonlySet<string>
} {
  const byKey = new Map<KeyId, EffectiveBindingRule[]>()
  for (const rule of rules) {
    const list = byKey.get(rule.key) ?? []
    list.push(rule)
    byKey.set(rule.key, list)
  }
  const conflicts: KeybindingConflict[] = []
  const deactivated = new Set<string>()
  for (const [key, keyRules] of byKey) {
    if (keyRules.length < 2) continue
    // Group by priority; only same-priority rules can conflict.
    const byPriority = new Map<number, EffectiveBindingRule[]>()
    for (const rule of keyRules) {
      const list = byPriority.get(rule.priority) ?? []
      list.push(rule)
      byPriority.set(rule.priority, list)
    }
    for (const [priority, priorityRules] of byPriority) {
      if (priorityRules.length < 2) continue
      // Find the maximal set of pairwise-overlapping scopes. Simple
      // approach: every rule whose scope overlaps with at least one other
      // rule's scope in this group joins the conflict.
      const involved = new Set<EffectiveBindingRule>()
      for (let i = 0; i < priorityRules.length; i += 1) {
        for (let j = i + 1; j < priorityRules.length; j += 1) {
          const left = priorityRules[i]!
          const right = priorityRules[j]!
          if (scopesOverlap(left.scope, right.scope)) {
            involved.add(left)
            involved.add(right)
          }
        }
      }
      if (involved.size === 0) continue
      for (const rule of involved) deactivated.add(rule.id)
      conflicts.push({
        key,
        actions: [...involved]
          .sort((a, b) => a.action.localeCompare(b.action))
          .map(rule => ({ action: rule.action, scope: rule.scope, source: rule.source, ruleId: rule.id })),
      })
    }
  }
  return { conflicts, deactivated }
}
