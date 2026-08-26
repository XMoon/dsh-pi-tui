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
 * - actions are SEMANTIC and WHITELISTED (the public `TuiAction` set —
 *   submit-draft, queue-draft, steer-draft, cancel-activity, open-search,
 *   toggle-fullscreen, cycle-permission — enforced at RUNTIME by
 *   {@link TUI_ACTIONS}: a JS/`as any` plugin can never register a
 *   Host-private `app.*` action and reach the Host dispatcher, round-12
 *   finding) — the host executes;
 * - reserved Host lifecycle keys cannot be claimed by a plugin (the
 *   registry REJECTS a reserved key loudly), and plain printable keys
 *   (letters, the spacebar) are rejected too (they never reach the
 *   plugin stage — round-12 finding);
 * - unload removes the bindings (fiber-bound);
 * - duplicates are an explicit conflict error.
 *
 * Protected actions (plan §10): {@link PROTECTED_HOST_ACTIONS} is the
 * action-level abstraction of the host's safety-critical set
 * (app.exit.request / app.agent.interrupt / app.input.submit). The
 * registry keeps the KEY-level reservation (RESERVED_HOST_KEYS) as the
 * compatibility guard. The ACTION whitelist is the other half of the
 * boundary: the protected `app.*` actions are HOST-PRIVATE and are never
 * plugin-bindable — a plugin may only trigger the public semantic
 * actions, which the runner routes through the host's own execution
 * paths (round-12 finding). The protected set is what the USER-config
 * surface and the viewer guard use.
 * @module @xmoon76/dsh-pi-tui/keybinding-registry
 */

import { describeKey, type NormalizedKey, type TuiAction, type TuiKeybindingContribution, type TuiKeybindingHandle, type TuiKeybindingRegistrySnapshot } from './extension/public-types.ts'
import type { KeyId } from '@xmoon76/pi-tui'
import { canonicalizeKeyId } from './keybindings/key-identity.ts'
import { PROTECTED_HOST_ACTIONS } from './keybindings/definitions.ts'

export { PROTECTED_HOST_ACTIONS }

/** The PUBLIC semantic actions a Stable plugin may trigger (the
 * `TuiAction` union — the extension API's capability boundary). The
 * runner's `onExtensionAction` switch executes exactly these; the HOST
 * `app.*` actions are private to the Host and are NEVER reachable from a
 * plugin-registered action string (review finding: the registry had no
 * runtime action whitelist, so a JS/`as any` plugin could register
 * `app.exit.request` and the plugin-owned winner would then enter the
 * Host dispatcher — the AppActionDispatcher must never execute a
 * plugin-supplied string). Kept in sync with `TuiAction` in
 * extension/public-types.ts. */
export const TUI_ACTIONS: ReadonlySet<TuiAction> = new Set<TuiAction>([
  'submit-draft',
  'queue-draft',
  'steer-draft',
  'cancel-activity',
  'open-search',
  'toggle-fullscreen',
  'cycle-permission',
])

/** Whether a NORMALIZED key is a plain printable (a plugin binding for a
 * printable key would swallow typing — the router keeps printable keys
 * with the editor's text entry, so the binding could never fire; the
 * registration must be rejected, never advertised as an effective rule —
 * review finding). The `space` key name (the spacebar) is printable too.
 * Mirrors the InputRouter's isPrintableKey — both guards must agree. */
export function isPlainPrintableNormalizedKey(key: NormalizedKey): boolean {
  if (key.ctrl || key.alt || key.shift || key.super) return false
  if (key.key === 'space') return true
  return key.key.length === 1 && key.key.charCodeAt(0) >= 32 && key.key.charCodeAt(0) <= 126
}


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

/** Canonicalize a NORMALIZED key (the plugin public shape): collapse
 * base-key aliases (esc→escape, return→enter) and order modifiers
 * ctrl→shift→alt→super, so a plugin registering `esc` or `return` is
 * found by the runtime's `escape`/`enter` lookups and duplicate
 * detection sees one identity (convergence finding). The public
 * NormalizedKey contract is unchanged. */
function canonicalNormalizedKey(key: NormalizedKey): NormalizedKey {
  const parts: string[] = []
  if (key.ctrl) parts.push('ctrl')
  if (key.shift) parts.push('shift')
  if (key.alt) parts.push('alt')
  if (key.super) parts.push('super')
  parts.push(key.key)
  const canonicalKeyId = canonicalizeKeyId(parts.join('+') as KeyId)
  const canonicalParts = canonicalKeyId.split('+')
  const base = canonicalParts[canonicalParts.length - 1]!
  return {
    key: base,
    ctrl: canonicalParts.includes('ctrl'),
    shift: canonicalParts.includes('shift'),
    alt: canonicalParts.includes('alt'),
    super: canonicalParts.includes('super'),
  }
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
  /** Change listeners: invoked on EVERY register/dispose/disposeOwner
   * AFTER the repaint invalidation — consumers (the runner's
   * HostKeybindingManager sync) resync the effective keymap so plugin
   * bindings registered after mount fire and unloaded ones stop
   * (convergence finding: the initial snapshot sync is not enough). */
  private readonly listeners = new Set<() => void>()

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /** Subscribe to keybinding set changes (register/dispose/unload). The
   * listener is called after every mutation; returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notifyChanged(): void {
    this.onInvalidate()
    for (const listener of this.listeners) listener()
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
    // THE ACTION WHITELIST (review finding): only the PUBLIC TuiAction set
    // may be registered. A Host-private `app.*` action string would be
    // routed to the Host dispatcher by the plugin-owned winner — a Stable
    // plugin must never trigger a Host-private semantic action. The
    // TuiAction TYPE enforces this at compile time; this is the RUNTIME
    // enforcement for JS plugins / `as any` callers.
    if (!TUI_ACTIONS.has(contribution.action)) {
      throw new Error(
        `keybinding action "${contribution.action}" is not a public TuiAction (a Stable plugin may only trigger the public semantic actions)`,
      )
    }
    // CANONICALIZE FIRST (convergence finding): the reserved-key check
    // must see the canonical identity — a plugin registering `esc` or
    // `return` is bound to the reserved `escape`/`enter` and must be
    // rejected, not accepted under an alias spelling.
    const canonicalKey = canonicalNormalizedKey(contribution.key)
    // PLAIN PRINTABLE REJECTION (review finding): the router keeps plain
    // printable keys (and the spacebar) with the editor's text entry, so
    // a plugin binding on one can never fire. Accepting it would
    // advertise an "effective rule" that never executes — rejected here,
    // mirroring the config parser's Host-side rule. Modified chords
    // (ctrl+space) stay bindable — they really reach the plugin stage.
    if (isPlainPrintableNormalizedKey(canonicalKey)) {
      throw new Error(
        `keybinding for "${describeKey(canonicalKey)}" is a plain printable key and cannot be bound by a plugin (it would never reach the plugin stage)`,
      )
    }
    if (isReservedHostKey(canonicalKey)) {
      throw new Error(
        `keybinding for "${describeKey(canonicalKey)}" is reserved by the host and cannot be claimed by a plugin`,
      )
    }
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (keyEquals(record.key, canonicalKey)) {
        throw new Error(`duplicate keybinding for "${describeKey(canonicalKey)}" (owner "${record.owner}")`)
      }
    }
    this.records.set(contribution.id, {
      id: contribution.id,
      key: canonicalKey,
      action: contribution.action,
      description: contribution.description,
      owner,
      disposed: false,
    })
    this.revision += 1
    this.notifyChanged()
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
    this.notifyChanged()
  }

  /** Dispose every binding owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.records]) {
      if (record.owner === owner) this.dispose(id)
    }
  }

  /** The action bound to one normalized key, or undefined. */
  actionFor(key: NormalizedKey): TuiAction | undefined {
    const canonical = canonicalNormalizedKey(key)
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (keyEquals(record.key, canonical)) return record.action
    }
    return undefined
  }

  /** The contribution id bound to one normalized key, or undefined. */
  idFor(key: NormalizedKey): string | undefined {
    const canonical = canonicalNormalizedKey(key)
    for (const record of this.records.values()) {
      if (record.disposed) continue
      if (keyEquals(record.key, canonical)) return record.id
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
