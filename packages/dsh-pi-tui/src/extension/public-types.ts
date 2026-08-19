/**
 * Public extension contracts for the dsh-pi-tui extension platform.
 *
 * These types are the ONLY surface a third-party plugin may import (through
 * `@xmoon76/dsh-pi-tui/extensions`). Everything here must stay free of
 * private pi-tui types, `TuiApp`, terminal types, and repository paths — the
 * packed `.d.mts` leak gate enforces that.
 *
 * M1–M4 scope: registry primitives, the chrome slots, the immutable
 * surface/session/activity snapshots, and the structured component kit
 * (`ExtensionView`). Contributions are plain data (rendered by the host);
 * plugins never touch components, terminals, or the TuiApp.
 * @module @xmoon76/dsh-pi-tui/extensions
 */


/** The semantic color palette shape a theme contribution may supply. The
 * host maps it onto its own palette at apply time; a plugin supplies hex
 * colours only (never ANSI, never terminal escapes). */
export interface TuiColorPalette {
  primary: string
  accent: string
  text: string
  textStrong: string
  textDim: string
  textMuted: string
  border: string
  borderFocus: string
  success: string
  warning: string
  error: string
  diffAdded: string
  diffRemoved: string
  diffAddedStrong: string
  diffRemovedStrong: string
  diffGutter: string
  diffMeta: string
  roleUser: string
  shellMode: string
}

/** One autocomplete suggestion item (structural — the host maps it onto
 * its editor's item shape). */
export interface TuiAutocompleteItem {
  value: string
  label: string
  description?: string
}

/** One suggestion batch from a plugin provider. */
export interface TuiAutocompleteSuggestions {
  items: readonly TuiAutocompleteItem[]
  prefix: string
}

/** The editor's suggestion query a plugin provider answers. */
export interface TuiAutocompleteQuery {
  lines: readonly string[]
  cursorLine: number
  cursorCol: number
  signal: AbortSignal
  force?: boolean
}

/**
 * A plugin autocomplete provider (structural — NEVER the fork's interface,
 * so the public declarations stay free of private pi-tui types).
 */
export interface TuiAutocompleteProvider {
  getSuggestions(query: TuiAutocompleteQuery): Promise<TuiAutocompleteSuggestions | null>
}

/** API version of the extension surface (bumped only on breaking changes). */
export const API_VERSION = 1 as const

/** Capability identifiers, feature-detected via {@link PiTuiApiInfo}. */
export type PiTuiCapability =
  | 'slot.chrome.header.badge'
  | 'slot.input.dock.item'
  | 'slot.chrome.footer.status'
  | 'slot.input.widget'
  | 'surface.snapshot'

/** Slot identities this package knows; unknown names are rejected at registration. */
export type PiTuiSlotName =
  | 'chrome.header.badge'
  | 'input.dock.item'
  | 'chrome.footer.status'
  | 'input.widget.above'
  | 'input.widget.below'

/** Slot semantics: how competing contributions resolve. */
export type PiTuiSlotSemantic = 'list' | 'single'

/** What a plugin may know about the host (M1: version + capabilities only). */
export interface PiTuiApiInfo {
  /** The extension API version; 1 for the M0–M3 foundation. */
  readonly apiVersion: typeof API_VERSION
  /** The `@xmoon76/dsh-pi-tui` package version (semver string). */
  readonly hostVersion: string
  /** Capabilities the host currently supports; feature-detect, never parse the version. */
  readonly capabilities: ReadonlySet<PiTuiCapability>
}

/** Common registration metadata every contribution carries. */
export interface RegistrationSpec {
  /** Stable diagnostic identity, unique per (slot, owner). */
  readonly id: string
  /**
   * Deterministic ordering for `list` slots: `order` ASC, then `id` ASC.
   * Load order NEVER decides conflicts.
   */
  readonly order?: number
  /** Winner selection for `single` slots: lowest `priority` wins. */
  readonly priority?: number
  /** Human-readable description for diagnostics and future /status output. */
  readonly description?: string
}

/** Live control of one registered contribution. */
export interface RegistrationHandle<T> {
  /** The registration id (stable diagnostic identity). */
  readonly id: string
  /**
   * Request a re-render of this contribution. Batched: N invalidates in one
   * tick produce ONE render request on the active screen.
   */
  invalidate(): void
  /**
   * Replace the contribution value in place. The handle keeps its identity:
   * owner, id and lifetime are unchanged by a replacement.
   */
  replace(next: T): void
  /** Remove the contribution. Idempotent; a disposed handle is inert. */
  dispose(): void
}

/** One contribution registered under a slot, with its owner identity. */
export interface ContributionRecord<T> {
  readonly slot: PiTuiSlotName
  readonly id: string
  readonly order: number
  readonly priority: number
  readonly description: string | undefined
  /** The Cordis fiber name that owns this registration (diagnostics). */
  readonly owner: string
  /** The live contribution value. */
  readonly value: T
}

/** Health state of one contribution (future /status extension listing). */
export type ContributionState = 'active' | 'shadowed' | 'failed' | 'disposed'

/** Diagnostic health record for one contribution (M1: recorded, surfaced later). */
export interface ContributionHealth {
  readonly id: string
  readonly owner: string
  readonly extensionPoint: string
  readonly state: ContributionState
  /** The error generation this record was produced under (0 = none yet). */
  readonly errorGeneration?: number
  /** The last error message, when the contribution failed (no stack traces). */
  readonly lastError?: string
}

// ── M2: snapshots (immutable, deeply readonly) ─────────────────────────────

/** The live surface's geometry and mode (plan §7.1). */
export interface SurfaceSnapshot {
  readonly surfaceId: string
  /** The surface generation; stable across start/stop/fullscreen/editor
   * round-trips, bumped only by a final dispose (M0 contract). */
  readonly generation: number
  readonly width: number
  readonly height: number
  readonly fullscreen: boolean
  /** Which seat currently owns keyboard focus. */
  readonly focusedSeat: 'editor' | 'overlay' | 'editor-panel' | 'none'
  readonly themeId: string
  readonly themeRevision: number
}

/** The live session's identity and mode (plan §7.2). Secrets, credentials,
 * raw Context and live Agent objects are NEVER included. */
export interface SessionSnapshot {
  readonly sessionId?: string
  readonly title?: string
  readonly workspaceRoot: string
  readonly cwd: string
  readonly branch?: string
  readonly model?: string
  readonly permission?: string
  readonly planMode: boolean
  readonly busy: boolean
  readonly viewerMode: boolean
  /** Completed turns and steps (footer t/s counters). */
  readonly turns: number
  readonly steps: number
}

/** Background activity counts (plan §7.3). */
export interface ActivitySnapshot {
  readonly working: boolean
  readonly workingMessage?: string
  readonly queuedCount: number
  readonly taskCount: number
  readonly childAgentCount: number
  readonly todoCount: number
  /** The rendered todo summary line (`☑ N active · first`), when the host
   * provides one (the first-party builtin dock item renders it). */
  readonly todoSummary?: string
}

/** The store's three named slices (state subscriptions deliver these). */
export interface SurfaceStateValues {
  readonly surface: SurfaceSnapshot
  readonly session: SessionSnapshot
  readonly activity: ActivitySnapshot
}

// ── M2: the first chrome slots' contribution contracts ─────────────────────

/** A header badge: short text with a semantic tone (plan §8.1). */
export interface HeaderBadge {
  readonly text: string
  readonly tone?: 'info' | 'warning' | 'error' | 'success'
}

/** One dock item: a label with optional detail lines (plan §8.2). */
export interface DockItem {
  readonly label: readonly StyledSpan[]
  readonly detail?: readonly StyledSpan[]
  readonly importance?: number
}

/** One footer segment: styled spans with layout hints (plan §8.3). */
export interface FooterSegment {
  readonly spans: readonly StyledSpan[]
  readonly minWidth?: number
  readonly importance?: number
}

/** One styled run of text. The host owns ANSI compilation; plugins supply
 * semantic tokens only (no raw escapes, ever). */
export interface StyledSpan {
  readonly text: string
  readonly tone?: 'primary' | 'accent' | 'text' | 'textStrong' | 'textDim' | 'textMuted'
    | 'border' | 'success' | 'warning' | 'error' | 'roleUser' | 'shellMode'
  readonly emphasis?: 'normal' | 'strong' | 'dim' | 'italic'
}

// ── M4: the structured component kit (plan §9) ────────────────────────────

/**
 * A structured view tree a plugin may contribute to widget slots. Plugins
 * describe WHAT to render with semantic tokens; the host compiles it into
 * private components and owns layout, ANSI compilation, wrapping, width
 * measurement and error isolation. Raw ANSI and terminal escapes are never
 * accepted (the host's render contract, plan §19).
 *
 * The tree is immutable and rebuilt on every contribution change; the host
 * keeps the compiled component LIVE across resizes (the fork's per-frame
 * processed-line reuse, AGENTS.md), so a width change re-wraps instead of
 * freezing the baked lines.
 */
export type ExtensionView =
  | TextView
  | MarkdownView
  | SpacerView
  | StackView
  | FrameView
  | RowsView

/** One line of text: styled spans, optionally wrapped at the view width. */
export interface TextView {
  readonly kind: 'text'
  readonly spans: readonly StyledSpan[]
  /** Whether long content wraps onto further rows (default true). */
  readonly wrap?: boolean
}

/** One block of Markdown, rendered with the host's markdown palette. */
export interface MarkdownView {
  readonly kind: 'markdown'
  readonly markdown: string
}

/** A run of empty rows (vertical spacing). */
export interface SpacerView {
  readonly kind: 'spacer'
  readonly rows: number
}

/**
 * A vertical or horizontal stack of views. Vertical stacks distribute the
 * available height between children (basis/grow/shrink semantics like the
 * fork's VStack); horizontal stacks place children side by side. Empty
 * children render nothing.
 */
export interface StackView {
  readonly kind: 'stack'
  readonly direction: 'vertical' | 'horizontal'
  readonly children: readonly ExtensionView[]
  readonly gap?: number
  /** Stack-layout hints (vertical direction): basis/grow/shrink. */
  readonly basis?: number
  readonly grow?: number
  readonly shrink?: number
}

/**
 * A bordered frame around one child view (padding 1, the host's border
 * token). An absent child renders nothing (abdication).
 */
export interface FrameView {
  readonly kind: 'frame'
  readonly child?: ExtensionView
  /** The child's content width budget (cells); defaults to the host budget. */
  readonly width?: number
}

/** A fixed set of rows, each rendered at the current view width. */
export interface RowsView {
  readonly kind: 'rows'
  readonly rows: readonly ExtensionView[]
  /** Max rows to render (budget); excess rows are dropped. */
  readonly maxRows?: number
}

/**
 * A widget contribution for the `input.widget.above` / `input.widget.below`
 * slots: one structured view with layout hints. The host owns the row
 * budget (plan §19 — minimum editor usability always wins) and truncates or
 * collapses low-importance widgets first; a widget can never push the
 * editor off-screen.
 */
export interface InputWidget {
  /** The view tree to render. */
  readonly view: ExtensionView
  /** Layout weight: lower importance widgets collapse first under pressure. */
  readonly importance?: number
  /** Preferred max rows (budget); the host may grant fewer. */
  readonly maxHeight?: number
}

// ── M5: commands / themes / autocomplete / settings / keybindings ──────────

/** One command contribution (plan §10): ownership metadata over an
 * existing command. The bridge does NOT execute — the commands service
 * does. `/name args...` ALWAYS keeps `invocation.rawInput` verbatim. */
export interface TuiCommandContribution {
  readonly id: string
  /** The slash-command name WITHOUT the leading slash. */
  readonly name: string
  readonly description: string
  /** Execution ownership: local (never steered) vs submission (session
   * policy). Busy Enter classifies by the EFFECTIVE ownership. */
  readonly execution: 'local' | 'submission'
  /** Whether the command may run without a live session. */
  readonly sessionless?: boolean
  /** Optional autocomplete provider for this command's arguments
   * (the structural {@link TuiAutocompleteProvider}). */
  readonly argumentProvider?: TuiAutocompleteProvider
  /** Optional local handler; absent = metadata-only ownership (the
   * commands service handler runs). */
  readonly handler?: TuiLocalCommandHandler
}

/** The local command handler signature (invocation carries the VERBATIM
 * raw input — never re-parsed or rewritten). Returns the commands
 * service's result shape (`{ kind: 'success' }` / `{ kind: 'error',
 * text }`) so the runner's notify path is shared. */
export interface TuiLocalCommandHandler {
  (invocation: { commandId: string; rawInput: string; signal: AbortSignal }):
    | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
    | { readonly kind: 'error'; readonly text: string }
    | Promise<{ readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number } | { readonly kind: 'error'; readonly text: string }>
}

/** A live handle on one command contribution. */
export interface TuiCommandHandle {
  readonly id: string
  dispose(): void
}

/** The command bridge's observable snapshot. */
export interface TuiCommandBridgeSnapshot {
  readonly entries: readonly {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly execution: 'local' | 'submission'
    readonly sessionless: boolean
    readonly owner: string
  }[]
  readonly revision: number
}

/** One registered theme contribution (M5). */
export interface TuiThemeContribution {
  readonly id: string
  /** The SELECTABLE name (shown in the theme picker). */
  readonly name: string
  /** The semantic palette (hex colours; the host maps it at apply time). */
  readonly palette: TuiColorPalette
  readonly description?: string
}

/** A live handle on one theme contribution. */
export interface TuiThemeHandle {
  readonly id: string
  dispose(): void
}

/** The theme registry's observable snapshot. */
export interface TuiThemeRegistrySnapshot {
  readonly themes: readonly {
    readonly id: string
    readonly name: string
    readonly description: string | undefined
    readonly owner: string
  }[]
  readonly revision: number
}

/** One registered autocomplete provider (M5). `owner` is stamped by the
 * service (the calling fiber) — a plugin never supplies it. */
export interface AutocompleteProviderContribution {
  readonly id: string
  /** The provider (the structural {@link TuiAutocompleteProvider} — never
   * the fork's interface, so the public declarations stay free of private
   * types). */
  readonly provider: TuiAutocompleteProvider
  readonly description?: string
  readonly owner?: string
}

/** A live handle on one autocomplete provider. */
export interface AutocompleteHandle {
  readonly id: string
  dispose(): void
}

/** One registered settings row (M5). */
export interface TuiSettingContribution {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly currentValue: string
  readonly values?: readonly string[]
  /** Return false to keep the old value (rejection). */
  readonly onChange?: (value: string) => boolean | void | Promise<boolean | void>
  readonly order?: number
}

/** A live handle on one settings row. */
export interface TuiSettingHandle {
  readonly id: string
  setValue(value: string): void
  dispose(): void
}

/** The settings registry's observable snapshot. */
export interface TuiSettingsRegistrySnapshot {
  readonly rows: readonly {
    readonly id: string
    readonly label: string
    readonly description: string | undefined
    readonly currentValue: string
    readonly values: readonly string[]
    readonly order: number
    readonly owner: string
  }[]
  readonly revision: number
}

/** The read-side of the command bridge a plugin may consult (M5). The
 * concrete bridge is host-internal; this narrow surface keeps the public
 * declarations free of internal modules. */
export interface TuiCommandBridgeView {
  isLocal(name: string, staticLocal: ReadonlySet<string>): boolean
  snapshot(): TuiCommandBridgeSnapshot
}

/** The read-side of the theme registry (M5). */
export interface TuiThemeRegistryView {
  names(): string[]
  paletteFor(name: string): TuiColorPalette | undefined
  snapshot(): TuiThemeRegistrySnapshot
}

/** The read-side of the settings registry (M5). */
export interface TuiSettingsRegistryView {
  rows(): readonly {
    readonly id: string
    readonly label: string
    readonly description: string | undefined
    readonly currentValue: string
    readonly values: readonly string[]
    readonly order: number
    readonly owner: string
  }[]
  apply(id: string, value: string): Promise<boolean>
  snapshot(): TuiSettingsRegistrySnapshot
}

/** The read-side of the autocomplete registry (M5). */
export interface TuiAutocompleteRegistryView {
  suggest(query: TuiAutocompleteQuery, onError?: (id: string, error: unknown) => void): Promise<TuiAutocompleteSuggestions | null>
  snapshot(): { providers: readonly AutocompleteProviderContribution[]; revision: number }
}

/** The read-side of the keybinding registry (M5). */
export interface TuiKeybindingRegistryView {
  actionFor(key: NormalizedKey): TuiAction | undefined
  snapshot(): TuiKeybindingRegistrySnapshot
}

/** A normalized key identity (the host's normalization, plan §11.2). */
export interface NormalizedKey {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly super: boolean
}

/** The semantic actions a plugin may bind (plan §2.2 / §11). */
export type TuiAction =
  | 'submit-draft'
  | 'queue-draft'
  | 'steer-draft'
  | 'cancel-activity'
  | 'open-search'
  | 'toggle-fullscreen'
  | 'cycle-permission'

/** One keybinding contribution (M5 metadata only; routing in M6). */
export interface TuiKeybindingContribution {
  readonly id: string
  readonly key: NormalizedKey
  readonly action: TuiAction
  readonly description?: string
}

/** A live handle on one keybinding. */
export interface TuiKeybindingHandle {
  readonly id: string
  dispose(): void
}

/** Human-readable key description (diagnostics). */
export function describeKey(key: NormalizedKey): string {
  const parts: string[] = []
  if (key.ctrl) parts.push('Ctrl')
  if (key.alt) parts.push('Alt')
  if (key.shift) parts.push('Shift')
  if (key.super) parts.push('Super')
  parts.push(key.key.length === 1 ? key.key.toUpperCase() : key.key)
  return parts.join('+')
}

/** The keybinding registry's observable snapshot. */
export interface TuiKeybindingRegistrySnapshot {
  readonly bindings: readonly {
    readonly id: string
    readonly key: NormalizedKey
    readonly action: TuiAction
    readonly description: string | undefined
    readonly owner: string
  }[]
  readonly revision: number
}

// ── M7: transcript / tool renderers (plan §12) ─────────────────────────────

/** The semantic snapshot of one TOOL call a renderer may present (plan
 * §12). Immutable, readonly; secrets/credentials/raw Context/live Agent
 * are NEVER included. */
export interface ToolPresentationSnapshot {
  readonly callId: string
  readonly toolName: string
  readonly status: 'ok' | 'error' | 'running'
  readonly arguments?: unknown
  readonly result?: unknown
  /** Whether the card is currently expanded (fold boundary + click
   * override). A renderer may present differently per expansion. */
  readonly expanded: boolean
}

/** The semantic snapshot of one TRANSCRIPT message a renderer may present
 * (plan §12). Kind-specific fields are present only for their kind. */
export interface MessagePresentationSnapshot {
  readonly kind: 'user' | 'assistant' | 'thinking' | 'system' | 'tool' | 'summary'
  readonly turn: number
  /** Present for text-bearing kinds. */
  readonly text?: string
  /** Present for thinking (still streaming). */
  readonly running?: boolean
  /** Present for system (producer label/summary). */
  readonly label?: string
  readonly summary?: string
  /** Present for tool. */
  readonly tool?: ToolPresentationSnapshot
}

/** One registered message renderer (chain slot): may present ANY message;
 * returning undefined abdicates (the chain continues to the next renderer,
 * then the host fallback). */
export interface TuiMessageRendererContribution {
  readonly id: string
  /** Optional scope: only render this message kind (undefined = all). */
  readonly kind?: MessagePresentationSnapshot['kind']
  readonly render: (snapshot: MessagePresentationSnapshot) => ExtensionView | undefined
  readonly description?: string
  /** Chain ordering (ASC); ties break by id ASC. */
  readonly order?: number
}

/** One registered tool renderer (keyed slot): presents the tool card for
 * ONE tool name; undefined abdicates to the next renderer / host fallback.
 * Registered via `transcript.tool.renderer.<toolName>` keys. */
export interface TuiToolRendererContribution {
  readonly id: string
  /** The tool name this renderer presents (the keyed slot's domain key). */
  readonly toolName: string
  readonly render: (snapshot: ToolPresentationSnapshot) => ExtensionView | undefined
  readonly description?: string
  /** Winner selection for the tool name: lowest priority wins (a tie is
   * an error). */
  readonly priority?: number
}

/** A live handle on one renderer contribution. */
export interface TuiRendererHandle {
  readonly id: string
  /** Remove the renderer (idempotent; owner unload also disposes). */
  dispose(): void
}

/** The read-side of the renderer registry (M7): the host's message cache
 * asks it to present a message/tool through the plugin chain. The
 * concrete registry is host-internal. */
export interface TuiRendererRegistryView {
  renderMessage(
    snapshot: MessagePresentationSnapshot,
    onError: (id: string, error: unknown) => void,
  ): { view: ExtensionView; rendererId: string } | undefined
  renderTool(
    snapshot: ToolPresentationSnapshot,
    onError: (id: string, error: unknown) => void,
  ): { view: ExtensionView; rendererId: string } | undefined
  snapshot(): TuiRendererRegistrySnapshot
}

/** The renderer registry's observable snapshot. */
export interface TuiRendererRegistrySnapshot {
  readonly messageRenderers: readonly {
    readonly id: string
    readonly kind: MessagePresentationSnapshot['kind'] | undefined
    readonly description: string | undefined
    readonly owner: string
  }[]
  readonly toolRenderers: readonly {
    readonly id: string
    readonly toolName: string
    readonly description: string | undefined
    readonly owner: string
  }[]
  readonly revision: number
}
