/**
 * The keybinding registry (M5, plan §10 item 5): plugin keybinding
 * METADATA only — the actual routing is Host-owned (the InputRouter, M6).
 * A plugin declares a normalized key + a semantic ACTION; the host maps
 * actions to its own execution paths. The registry stores the declared
 * bindings; the InputRouter (M6) resolves them against the fixed
 * precedence ladder.
 *
 * Contract (plan §11):
 * - keys are NORMALIZED (the host's key identity — never raw escape
 *   sequences; a plugin can never interpret terminal bytes);
 * - actions are SEMANTIC (the plan's action list: submit-draft,
 *   queue-draft, steer-draft, cancel-activity, open-search,
 *   toggle-fullscreen, cycle-permission, ...) — the host executes;
 * - reserved Host lifecycle keys cannot be claimed by a plugin (the
 *   registry REJECTS a reserved key loudly);
 * - unload removes the bindings (fiber-bound);
 * - duplicates are an explicit conflict error.
 *
 * Protected actions (plan §10): {@link PROTECTED_HOST_ACTIONS} is the
 * action-level abstraction of the host's safety-critical set
 * (app.exit.request / app.agent.interrupt / app.input.submit). The
 * registry keeps the KEY-level reservation (RESERVED_HOST_KEYS) as the
 * compatibility guard; a plugin binding a protected action to a NEW key
 * is ADDITIVE (the host's own handler still executes — the runner routes
 * the semantic action through the host paths), so it is allowed. The
 * protected set is what the USER-config surface and the viewer guard use.
 * @module @xmoon76/dsh-pi-tui/keybinding-registry
 */

import { describeKey, type NormalizedKey, type TuiAction, type TuiKeybindingContribution, type TuiKeybindingHandle, type TuiKeybindingRegistrySnapshot } from './extension/public-types.ts'
import { PROTECTED_HOST_ACTIONS } from './keybindings/definitions.ts'

export { PROTECTED_HOST_ACTIONS }


/** Internal registration record. */
interface BindingRecord {
  readonly id: string
  readonly key: NormalizedKey
  readonly action: TuiAction
  readonly description: string | undefined
  readonly owner: string
  disposed: boolean
}

/**
 * The keys a PLUGIN can never claim (plan §11.3 — the Stable v1 plugin
 * registration compatibility guard). This inventory is NOT the runtime
 * source of truth: the InputRouter's runtime reservation is ACTION-driven
 * (hostResolves — a key is reserved only while an ACTIVE host action
 * binds it), and the user-orchestrable keymap (src/keybindings/
 * definitions.ts) owns the effective keys. This list exists ONLY to
 * reject plugin registrations on the host's DEFAULT lifecycle keys
 * (Ctrl+C/D exit, Ctrl+S steer-all, Ctrl+F search, Ctrl+O expand, Ctrl+T
 * todo, Ctrl+G external editor, Ctrl+R history search, Ctrl+V clipboard,
 * Ctrl+Enter queue, Enter submit, Esc cancel, Shift+Tab permission,
 * Alt+Up dequeue, Alt+T thinking, Alt+K dismiss). When a NEW default
 * host lifecycle key lands, extend THIS list in the same commit so
 * plugins cannot claim it; the runtime reservation needs no change (it
 * follows the keymap).
 */
export const RESERVED_HOST_KEYS: readonly NormalizedKey[] = [
  { key: 'c', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+C exit
  { key: 'd', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+D exit
  { key: 's', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+S steer all
  { key: 'f', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+F transcript search
  { key: 'f', ctrl: true, alt: false, shift: true, super: false },      // Ctrl+Shift+F search
  { key: 'o', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+O expand
  { key: 't', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+T todo panel
  { key: 'g', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+G external editor
  { key: 'r', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+R input-history search
  { key: 'v', ctrl: true, alt: false, shift: false, super: false },     // Ctrl+V clipboard image intake
  // Ctrl+J is deliberately NOT reserved/bound: legacy terminals send it
  // as LF, which the editor treats as Enter, so the chord was unreliable
  // in practice — the task browser is reached via ↓ (empty editor) and
  // `/tasks` instead, and a plugin may bind Ctrl+J itself.
  { key: 'enter', ctrl: true, alt: false, shift: false, super: false }, // Ctrl+Enter queue
  { key: 'enter', ctrl: false, alt: false, shift: false, super: false }, // Enter submit
  { key: 'escape', ctrl: false, alt: false, shift: false, super: false }, // Esc cancel
  { key: 'tab', ctrl: false, alt: false, shift: true, super: false },   // Shift+Tab permission cycle
  { key: 'up', ctrl: false, alt: true, shift: false, super: false },    // Alt+Up dequeue
  { key: 't', ctrl: false, alt: true, shift: false, super: false },     // Alt+T thinking detail toggle
  { key: 'k', ctrl: false, alt: true, shift: false, super: false },     // Alt+K dismiss settled local shell cards
]

/** Whether a key is reserved by the host lifecycle (the single check the
 * registry and the InputRouter (M6) both use). */
export function isReservedHostKey(key: NormalizedKey): boolean {
  return RESERVED_HOST_KEYS.some(reserved => keyEquals(reserved, key))
}

function keyEquals(left: NormalizedKey, right: NormalizedKey): boolean {
  return left.key === right.key && left.ctrl === right.ctrl && left.alt === right.alt
    && left.shift === right.shift && left.super === right.super
}

/**
 * The keybinding registry (metadata only until the InputRouter lands in
 * M6). One instance backs the runner; the extension service exposes
 * registration; the InputRouter consults {@link actionFor}.
 */
export class KeybindingRegistry {
  private readonly records = new Map<string, BindingRecord>()
  private revision = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /**
   * Register one binding. A duplicate id is an error; a RESERVED host key
   * is rejected loudly (plan §11.3); a duplicate (key) is a conflict error.
   * @param contribution - the binding.
   * @param owner - the Cordis fiber name.
   */
  register(contribution: TuiKeybindingContribution, owner: string): TuiKeybindingHandle {
    if (this.records.has(contribution.id)) {
      throw new Error(`duplicate keybinding id "${contribution.id}"`)
    }
    if (contribution.key.key === '') throw new Error('keybinding key must not be empty')
    if (isReservedHostKey(contribution.key)) {
      throw new Error(
        `keybinding for "${describeKey(contribution.key)}" is reserved by the host and cannot be claimed by a plugin`,
      )
    }
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (keyEquals(record.key, contribution.key)) {
        throw new Error(`duplicate keybinding for "${describeKey(contribution.key)}" (owner "${record.owner}")`)
      }
    }
    this.records.set(contribution.id, {
      id: contribution.id,
      key: contribution.key,
      action: contribution.action,
      description: contribution.description,
      owner,
      disposed: false,
    })
    this.revision += 1
    this.onInvalidate()
    return {
      id: contribution.id,
      dispose: () => this.dispose(contribution.id),
    }
  }

  /** Remove one binding by id (idempotent). */
  dispose(id: string): void {
    const record = this.records.get(id)
    if (record === undefined || record.disposed) return
    record.disposed = true
    this.records.delete(id)
    this.revision += 1
    this.onInvalidate()
  }

  /** Dispose every binding owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /** The action bound to one normalized key, or undefined. */
  actionFor(key: NormalizedKey): TuiAction | undefined {
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (keyEquals(record.key, key)) return record.action
    }
    return undefined
  }

  /** The contribution id bound to one normalized key, or undefined. */
  idFor(key: NormalizedKey): string | undefined {
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (keyEquals(record.key, key)) return record.id
    }
    return undefined
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): TuiKeybindingRegistrySnapshot {
    const bindings = [...this.records.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(record => ({
        id: record.id,
        key: record.key,
        action: record.action,
        description: record.description,
        owner: record.owner,
      }))
    return { bindings, revision: this.revision }
  }

  /** Whether any binding is live (health /status). */
  hasAny(): boolean {
    for (const record of this.records.values()) {
      if (!record.disposed) return true
    }
    return false
  }
}
