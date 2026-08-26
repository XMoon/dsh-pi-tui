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
 * Internal stage seam (phase-1 tier architecture, plan §9): the ladder
 * above is the host-owned routing path, and future Advanced/Unstable
 * capture stages seat into it at fixed points. NOT exported, NOT usable
 * by plugins yet, and no behavior changes with this phase — the mapping
 * below only documents where a future stage plugs in:
 *
 * ```text
 * InternalInputStage  ladder position
 * 'preDecode'         before terminal protocol replies / press-filtering
 *                    (raw bytes interception — future unstable raw hook)
 * 'preHost'           between protocol replies and the question/approval
 *                    capture (future pre-host interception)
 * 'focused'           after host modal capture, before the editor
 *                    (future focused-component input ownership)
 * 'binding'           the existing non-capturing plugin keybinding stage
 *                    (already present, at the bottom of the ladder)
 * ```
 *
 * Contract (plan §11):
 * - plugins receive ONLY the normalized key identity
 *   ({@link NormalizedKey} — key + ctrl/alt/shift/super), never raw escape
 *   sequences; there is deliberately NO `onTerminalInput(raw)` seam;
 * - terminal protocol replies (Kitty press/repeat/release filtering) are
 *   handled BEFORE plugins — a plugin can never see them;
 * - host lifecycle keys are handled before plugin bindings and cannot be
 *   preempted — the reservation is ACTION-DRIVEN via
 *   {@link InputRouterContext.hostResolves} (a key is reserved only while
 *   an ACTIVE host action binds it; the static RESERVED_HOST_KEYS list is
 *   only the plugin REGISTRATION guard, never a runtime reservation);
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
  /** The subagent viewer's input mode: `readonly` locks every key except
   * Esc/Ctrl+O; `continuable` keeps the editor LIVE (the HOST consumes
   * Enter and the parent-owned chords before the router is consulted);
   * `none` = no viewer. */
  readonly viewerInputMode: 'none' | 'readonly' | 'continuable'
  /** Whether any overlay (picker/settings/search/...) is mounted. */
  readonly hasOverlay: boolean
  /** Whether the transcript-search overlay is open (owns its keys). */
  readonly searchActive: boolean
  /** P1-06: whether the FOCUSED component would consume this raw input.
   * The app-level listener runs BEFORE the focused component sees input
   * (the fork dispatches to listeners first, then the focused component),
   * so the router must ask the editor directly — a plugin binding can
   * only claim keys the focused editor DECLINES. Undefined = no editor
   * probe (default: the plugin binding wins, matching pre-P1-06
   * behavior for surfaces without a seat editor). */
  readonly editorAccepts?: (data: string) => boolean
  /** Whether one raw input matches the EFFECTIVE keys of a semantic
   * action (the app supplies this from its keymap — review finding: the
   * router's hard-coded physical keys for the read-only viewer fold
   * pass-through and the search overlay must follow a user remap). */
  readonly matchesEffective?: (action: string, data: string) => boolean
  /** Whether the HOST keymap currently binds one raw input to an ACTIVE
   * host action (the app supplies this from its effective keymap). The
   * router reserves a key for the host ONLY when a host action is live
   * for it — a remapped-away old key (e.g. Ctrl+V after pasteMedia moved
   * to Ctrl+P) is NOT reserved and falls through to the editor/plugin
   * (PR review finding — the runtime reservation is action-driven, never
   * a static physical-key list). */
  readonly hostResolves?: (data: string) => boolean
  /** The HOST dispatcher already DECLINED this exact input (e.g.
   * pasteMedia without a handler returned false). The reservation must
   * be SKIPPED — the key must reach the editor/plugin remainder, never
   * be re-reserved by the same host action (convergence §6/§4.9). */
  readonly hostDeclined?: boolean
  /** Whether a replacement editor must receive an editor-routed key before
   * plugin bindings are considered. TuiApp flips this off only after the
   * replacement editor explicitly declines the key. */
  readonly editorReplacement?: boolean
}

/** The semantic actions the router's physical-key seams consult the
 * EFFECTIVE keymap for (review finding). The ids are the user-orchestrable
 * action strings (src/keybindings/definitions.ts); the router keeps them
 * as plain constants so it never imports the keybindings module. */
const TUI_ACTION_FOLD = 'app.transcript.toggleExpand'
const TUI_ACTION_SEARCH = 'app.transcript.search'

/** The outcome of one input event. */
export type InputRouteResult =
  /** The input was consumed by a capturing/reserved path (or is a
   * protocol artifact); the editor must NOT see it. */
  | { kind: 'consumed' }
  /** The input is a normal editor keystroke (or paste burst). */
  | { kind: 'editor' }
  /** The input is an editor keystroke inside the INTERACTIVE (continuable)
   * subagent viewer: the same editor dispatch as `editor`, but the
   * semantic submission target is the viewed SUBAGENT (Enter and the
   * parent-owned chords are consumed by the HOST before the router). */
  | { kind: 'viewer-editor' }
  /** The input maps to a plugin keybinding: the SEMANTIC action to
   * execute (never raw input). */
  | { kind: 'plugin-action'; action: TuiAction; key: NormalizedKey }
  /** The input was a protocol reply/release/repeat: drop it entirely. */
  | { kind: 'protocol' }

/**
 * The host-owned input precedence router (M6). One instance per surface;
 * TuiApp feeds raw data + its live context and executes the returned
 * route through its host paths. Pure in the sense that it never mutates
 * surface state — it only decides.
 */
export class InputRouter {
  /** The keybinding registry rejection of reserved host keys stays with
   * the REGISTRY (RESERVED_HOST_KEYS — Stable v1 plugin compatibility
   * guard). The ROUTER's runtime reservation is ACTION-driven via
   * {@link InputRouterContext.hostResolves} — never a static physical-key
   * list (PR review finding). */
  constructor() {}

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
    // Read-only (one-shot) viewer: ONLY Esc and the fold key pass through
    // — to the HOST paths (viewer-exit, fold-toggle). The router reports
    // them consumed (never a plugin binding, never the editor); every
    // other key is consumed while locked. The fold key resolves the
    // EFFECTIVE keymap (a remap stays authoritative — review finding).
    // An INTERACTIVE (continuable) viewer keeps the editor live — the
    // router's editor routes below become `viewer-editor` (the host has
    // already consumed Enter and the parent-owned chords).
    if (ctx.viewerInputMode === 'readonly') {
      if (matchesKey(data, 'escape')) return { kind: 'consumed' }
      if (ctx.matchesEffective?.(TUI_ACTION_FOLD, data) ?? matchesKey(data, 'ctrl+o')) {
        return { kind: 'consumed' }
      }
      return { kind: 'consumed' }
    }
    // The transcript-search overlay owns its keys. The toggle follows the
    // EFFECTIVE key (a remap of the configurable app.transcript.search
    // still closes/owns the overlay); the fixed close/next/previous stay
    // physical (non-configurable overlay contracts).
    if (ctx.searchActive) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'enter')
        || matchesKey(data, 'shift+enter')
        || (ctx.matchesEffective?.(TUI_ACTION_SEARCH, data) ?? matchesKey(data, 'ctrl+f'))) {
        return { kind: 'consumed' }
      }
      return { kind: 'editor' }
    }
    // Any non-search overlay owns the focused component and captures the
    // editor seat. This check must precede reserved-key routing: TuiApp lets
    // the event continue to the focused overlay component, including Esc and
    // other host-reserved keys.
    if (ctx.hasOverlay) return { kind: 'consumed' }
    // Reserved Host lifecycle shortcuts (the ladder position for the
    // TuiApp's own matchesKey checks): the router must know the reserved
    // set so a plugin can never claim them — but the ROUTING itself stays
    // in TuiApp (its host paths hold the state). The router only reports
    // which reserved key this is (if any), so TuiApp runs its path.
    //
    // EFFECTIVE-ACTION BASED (PR review finding): the reservation follows
    // the LIVE keymap, never a static physical-key list. A key that NO
    // host action currently binds (e.g. Ctrl+V after app.clipboard.
    // pasteMedia was remapped to Ctrl+P) is NOT reserved — it falls
    // through to the editor/plugin instead of being swallowed by a stale
    // physical reservation. The plugin-registration guard
    // (RESERVED_HOST_KEYS) keeps the Stable v1 compatibility rejection;
    // the RUNTIME swallowing here is purely action-driven.
    const normalized = this.normalize(data)
    if (!ctx.hostDeclined && normalized !== undefined && ctx.hostResolves?.(data) === true) {
      return { kind: 'consumed' }
    }
    // A replacement editor is probed by TuiApp before this final plugin
    // stage. The router reports the editor route so that TuiApp can deliver
    // the key, then retry plugin resolution only when the editor declined.
    if (ctx.editorReplacement) return this.viewerEditor(ctx)
    // Non-capturing plugin keybindings are consulted last for the host
    // editor. Printable keys always stay with normal text entry, and an
    // editor-owned binding (navigation, deletion, completion) keeps priority
    // over a plugin action.
    if (normalized !== undefined && !isPrintableKey(normalized)) {
      const action = pluginActionFor(normalized)
      if (action !== undefined) {
        if (ctx.editorAccepts?.(data) === true) return this.viewerEditor(ctx)
        return { kind: 'plugin-action', action, key: normalized }
      }
    }
    return this.viewerEditor(ctx)
  }

  /** The editor route, named for its submission target: inside the
   * interactive subagent viewer the visible editor belongs to the CHILD
   * (the semantic submit target differs, though the dispatch is the
   * same). */
  private viewerEditor(ctx: InputRouterContext): InputRouteResult {
    return ctx.viewerInputMode === 'continuable' ? { kind: 'viewer-editor' } : { kind: 'editor' }
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
