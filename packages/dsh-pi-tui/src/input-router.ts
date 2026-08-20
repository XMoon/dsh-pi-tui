/**
 * The InputRouter (M6, plan §11): the Host-owned input precedence ladder.
 *
 * The router does NOT own the surface state — TuiApp does. The router owns
 * the RULES: given raw terminal input and a narrow context view of the
 * surface's live state, it decides what the input means and routes it
 * through the fixed precedence:
 *
 * ```text
 * terminal protocol replies / press-filtering
 *   ↓
 * active question / editor-seat capturing flow
 *   ↓
 * active approval
 *   ↓
 * read-only viewer guard
 *   ↓
 * active overlay (search owns its keys)
 *   ↓
 * reserved Host lifecycle shortcuts
 *   ↓
 * default editor
 *   ↓
 * non-capturing plugin keybindings (M5 registry, normalized keys)
 * ```
 *
 * Contract (plan §11):
 * - plugins receive ONLY the normalized key identity
 *   ({@link NormalizedKey} — key + ctrl/alt/shift/super), never raw escape
 *   sequences; there is deliberately NO `onTerminalInput(raw)` seam;
 * - terminal protocol replies (Kitty press/repeat/release filtering) are
 *   handled BEFORE plugins — a plugin can never see them;
 * - reserved Host lifecycle keys (the M5 RESERVED_HOST_KEYS inventory)
 *   are handled before plugin bindings and cannot be preempted;
 * - a plugin binding is consulted ONLY when nothing earlier consumed the
 *   input AND the editor did not consume it (non-capturing, last in the
 *   ladder);
 * - the router never executes plugin code on the raw input path: it maps
 *   a normalized key to a SEMANTIC action (TuiAction), and TuiApp
 *   executes the action through its host-owned paths.
 * @module @xmoon76/dsh-pi-tui/input-router
 */

import { isKeyRelease, isKeyRepeat, matchesKey, parseKey } from '@xmoon76/pi-tui'
import type { NormalizedKey, TuiAction } from './extension/public-types.ts'

/** The live surface context the router reads (provided by TuiApp). */
export interface InputRouterContext {
  /** Whether a question flow currently owns the editor seat (capturing). */
  readonly questionActive: boolean
  /** Whether an approval prompt is currently shown (capturing). */
  readonly approvalActive: boolean
  /** Whether the read-only subagent viewer is up and no overlay is open. */
  readonly viewerLocked: boolean
  /** Whether any overlay (picker/settings/search/...) is mounted. */
  readonly hasOverlay: boolean
  /** Whether the transcript-search overlay is open (owns its keys). */
  readonly searchActive: boolean
  /** Whether background tasks are active (the ↓/Ctrl+J browser trigger). */
  readonly tasksActive: boolean
  /** The current editor draft (for task-browser gating). */
  readonly editorText: string
  /** Whether the external-editor launch is currently in flight. */
  readonly externalEditorInFlight: boolean
  /** Whether the editor should see plain text (true normally; false while
   * a capturing flow hides it). */
  readonly editorReceivesText: boolean
  /** P1-06: whether the FOCUSED component would consume this raw input.
   * The app-level listener runs BEFORE the focused component sees input
   * (the fork dispatches to listeners first, then the focused component),
   * so the router must ask the editor directly — a plugin binding can
   * only claim keys the focused editor DECLINES. Undefined = no editor
   * probe (default: the plugin binding wins, matching pre-P1-06
   * behavior for surfaces without a seat editor). */
  readonly editorAccepts?: (data: string) => boolean
}

/** The outcome of one input event. */
export type InputRouteResult =
  /** The input was consumed by a capturing/reserved path (or is a
   * protocol artifact); the editor must NOT see it. */
  | { kind: 'consumed' }
  /** The input is a normal editor keystroke (or paste burst). */
  | { kind: 'editor' }
  /** The input maps to a plugin keybinding: the SEMANTIC action to
   * execute (never raw input). */
  | { kind: 'plugin-action'; action: TuiAction }
  /** The input was a protocol reply/release/repeat: drop it entirely. */
  | { kind: 'protocol' }

/**
 * The host-owned input precedence router (M6). One instance per surface;
 * TuiApp feeds raw data + its live context and executes the returned
 * route through its host paths. Pure in the sense that it never mutates
 * surface state — it only decides.
 */
export class InputRouter {
  /**
   * The reserved lifecycle keys handled BEFORE plugins (the same
   * inventory the M5 KeybindingRegistry rejects — plan §11.3). Routing
   * for these stays in TuiApp's host paths; the router just needs to
   * know they exist so a plugin binding for them is never consulted.
   */
  private readonly reservedKeys: readonly NormalizedKey[]

  constructor(reservedKeys: readonly NormalizedKey[]) {
    this.reservedKeys = reservedKeys
  }

  /**
   * Normalize raw terminal input into the public {@link NormalizedKey}
   * shape (the ONLY key identity a plugin ever sees), or undefined when
   * the data is not a single key (paste bursts, multi-char input,
   * bracketed paste). Protocol artifacts (Kitty press/repeat/release)
   * are filtered FIRST.
   * @param data - the raw terminal data.
   */
  normalize(data: string): NormalizedKey | undefined {
    const parsed = parseKey(data)
    if (parsed === undefined) return undefined
    return keyIdToNormalized(parsed)
  }

  /**
   * Route one raw input event through the precedence ladder.
   * @param data - the raw terminal data.
   * @param ctx - the live surface context.
   * @param pluginActionFor - resolves a normalized key to a plugin
   *   action (the M5 keybinding registry), consulted LAST.
   * @returns the routing decision.
   */
  route(
    data: string,
    ctx: InputRouterContext,
    pluginActionFor: (key: NormalizedKey) => TuiAction | undefined,
  ): InputRouteResult {
    // Protocol filtering FIRST (plan §11.2): press/repeat/release events
    // and terminal query replies never reach any later stage.
    if (isKeyRelease(data) || isKeyRepeat(data)) return { kind: 'protocol' }
    // Capturing flows own everything.
    if (ctx.questionActive) return { kind: 'consumed' }
    if (ctx.approvalActive) return { kind: 'consumed' }
    // Read-only viewer: only Esc + Ctrl+O pass through (host paths); the
    // router treats everything else as consumed while locked.
    if (ctx.viewerLocked && !matchesKey(data, 'escape') && !matchesKey(data, 'ctrl+o')) {
      return { kind: 'consumed' }
    }
    // The transcript-search overlay owns its keys.
    if (ctx.searchActive) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'enter')
        || matchesKey(data, 'shift+enter') || matchesKey(data, 'ctrl+f')) {
        return { kind: 'consumed' }
      }
      return { kind: 'editor' }
    }
    // Reserved Host lifecycle shortcuts (the ladder position for the
    // TuiApp's own matchesKey checks): the router must know the reserved
    // set so a plugin can never claim them — but the ROUTING itself stays
    // in TuiApp (its host paths hold the state). The router only reports
    // which reserved key this is (if any), so TuiApp runs its path.
    const normalized = this.normalize(data)
    if (normalized !== undefined && this.isReserved(normalized)) {
      return { kind: 'consumed' }
    }
    // Overlays that are NOT search keep their keys (Esc, Shift+Tab,
    // Alt+↑, Ctrl+Enter, Ctrl+S, Ctrl+G, ↓ all fall through to the
    // overlay/focused component — the editor does not see them).
    // Non-capturing plugin keybindings: consulted LAST, only when nothing
    // earlier consumed the input AND the input is a single normalized key
    // AND the editor is not about to receive a plain keystroke that must
    // win (a plugin binding for a plain printable key would otherwise
    // swallow typing — the editor's own text input has priority).
    // P1-06: the FOCUSED EDITOR is asked FIRST — the app-level listener
    // runs before the focused component receives input, so a plugin
    // binding may only claim a key the focused editor DECLINES (arrows,
    // Tab, multiline cursor movement all belong to the editor while it is
    // focused). The documented "non-capturing, after the editor"
    // precedence is now actual: the editor keeps every key it handles.
    if (normalized !== undefined && !ctx.hasOverlay) {
      const action = pluginActionFor(normalized)
      if (action !== undefined && !isPrintableKey(normalized)) {
        if (ctx.editorAccepts !== undefined && ctx.editorAccepts(data)) {
          // The focused editor owns this key (e.g. ↑/↓/Tab while the
          // editor is focused): the plugin binding is NOT consulted.
          return { kind: 'editor' }
        }
        return { kind: 'plugin-action', action }
      }
    }
    // Everything else is the editor's.
    return { kind: 'editor' }
  }

  /** Whether a normalized key is reserved by the host lifecycle. */
  private isReserved(key: NormalizedKey): boolean {
    return this.reservedKeys.some(reserved =>
      reserved.key === key.key && reserved.ctrl === key.ctrl && reserved.alt === key.alt
        && reserved.shift === key.shift && reserved.super === key.super)
  }
}

/** Convert a fork key-id string (`ctrl+shift+f`, `up`, `alt+up`) into the
 * public normalized shape. */
function keyIdToNormalized(keyId: string): NormalizedKey {
  const parts = keyId.toLowerCase().split('+')
  const key = parts[parts.length - 1] ?? ''
  return {
    key,
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    super: parts.includes('super'),
  }
}

/** Whether a normalized key is a plain printable (a plugin binding for a
 * printable key would swallow typing — the editor's text input wins). */
function isPrintableKey(key: NormalizedKey): boolean {
  if (key.ctrl || key.alt || key.super) return false
  if (key.shift) return false
  return key.key.length === 1 && key.key.charCodeAt(0) >= 32 && key.key.charCodeAt(0) <= 126
}
