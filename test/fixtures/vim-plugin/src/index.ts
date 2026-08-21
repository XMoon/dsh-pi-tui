/**
 * The VIM-MODE acceptance fixture (plan §15, M10): a THIRD-PARTY Cordis
 * plugin that validates the Stable editor-extension seam — the editor SDK
 * (single-winner replacement, semantic input events, create/dispose) —
 * importing ONLY the public `@xmoon76/dsh-pi-tui/extensions` subpath.
 * The remaining public surfaces (keybindings, widgets, commands, settings,
 * tool renderers, managed overlays) have their own dedicated tests; this
 * fixture is NOT a Stable-API completeness proof (plan §7).
 *
 * The editor is a minimal modal editor (P1-6): insert mode (printable
 * text, Backspace, Left/Right, Esc → normal), normal mode (i → insert,
 * h/l → move, x → delete). It consumes SEMANTIC EditorInputEvents — the
 * host normalizes terminal protocols (legacy/CSI-u/modifyOtherKeys), so
 * the plugin never parses raw terminal bytes. Enter / Ctrl+Enter / Ctrl+S
 * stay HOST-owned (submission is never re-implemented in the plugin).
 *
 * CI gate (the vim-plugin smoke): importing `@xmoon76/pi-tui`,
 * `src/tui-app`, or any repository-relative internal path FAILS the
 * gate. If a STABLE plugin ever needs a private import, the SDK is missing
 * a capability — the plan forbids adding an `unsafeGetTuiApp()` escape
 * hatch instead.
 * @module dsh-pi-vim-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type EditorHost,
  type EditorInputEvent,
  type EditorSnapshot,
  type ExtensionEditor,
  type InputWidget,
  type NormalizedKey,
  type PiTuiExtensionService,
  type TuiSettingContribution,
  type TuiToolRendererContribution,
} from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'dsh-pi-vim-fixture'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

// ── A minimal modal editor built on the SDK ────────────────────────────────

/** The fixture's mode state machine: insert (text editing) and normal
 * (navigation + deletion via h/l/x/i). The host owns submission. */
type VimMode = 'insert' | 'normal'

/** Whether a normalized key is a plain printable (no modifiers). */
function isPlainKey(key: NormalizedKey): boolean {
  return !key.ctrl && !key.alt && !key.shift && !key.super
    && key.key.length === 1 && key.key.charCodeAt(0) >= 32 && key.key.charCodeAt(0) <= 126
}

/**
 * A minimal modal editor that follows the ExtensionEditor protocol (P1-6):
 * insert mode (printable text, Backspace, Left/Right, Esc → normal) and
 * normal mode (i → insert, h/l → move, x → delete). Input arrives as
 * SEMANTIC {@link EditorInputEvent}s — the host normalized the terminal
 * protocol, so legacy and CSI-u encodings behave identically. The host
 * snapshot subscription is DISPOSED with the editor, host-driven state
 * is adopted through a single update + host.invalidate(), and the view
 * is rebuilt from the CURRENT plugin state (never a captured snapshot).
 * The plugin owns its mode state; the host owns focus, submission and
 * session safety.
 */
function createVimEditor(host: EditorHost, mode: { current: VimMode }): ExtensionEditor {
  let text = ''
  let cursor = 0
  let disposed = false
  // The subscription is kept and released on dispose (no stale listener
  // after the handoff — round-1 finding 6).
  const unsubscribe = host.subscribe((snapshot: EditorSnapshot) => {
    if (disposed) return
    // Adopt host-driven state; a single update, then invalidate so the
    // live view re-renders with the fresh text.
    if (snapshot.text !== text) {
      text = snapshot.text
      host.invalidate()
    }
    if (snapshot.cursor !== cursor) cursor = snapshot.cursor
  })

  /** The vim state machine: consume one semantic event, mutate the draft. */
  const handleInput = (event: EditorInputEvent): boolean => {
    if (disposed) return true
    // INSERT mode.
    if (mode.current === 'insert') {
      if (event.kind === 'key') {
        const key = event.key
        if (isPlainKey(key)) {
          text = text.slice(0, cursor) + key.key + text.slice(cursor)
          cursor += 1
          host.invalidate()
          return true
        }
        if (key.key === 'backspace' && !key.ctrl && !key.alt) {
          if (cursor > 0) {
            text = text.slice(0, cursor - 1) + text.slice(cursor)
            cursor -= 1
            host.invalidate()
          }
          return true
        }
        if (key.key === 'left' && !key.ctrl && !key.alt) {
          if (cursor > 0) { cursor -= 1; host.invalidate() }
          return true
        }
        if (key.key === 'right' && !key.ctrl && !key.alt) {
          if (cursor < text.length) { cursor += 1; host.invalidate() }
          return true
        }
        if (key.key === 'escape') {
          mode.current = 'normal'
          host.invalidate()
          return true
        }
        // Enter and other host-reserved keys: hand back to the host
        // (submission stays host-owned).
        return false
      }
      // Text runs and pastes insert at the cursor.
      const chunk = event.kind === 'text' ? event.text : event.text
      text = text.slice(0, cursor) + chunk + text.slice(cursor)
      cursor += chunk.length
      host.invalidate()
      return true
    }
    // NORMAL mode.
    if (event.kind === 'key') {
      const key = event.key
      if (isPlainKey(key)) {
        if (key.key === 'i') {
          mode.current = 'insert'
          host.invalidate()
          return true
        }
        if (key.key === 'h') {
          if (cursor > 0) { cursor -= 1; host.invalidate() }
          return true
        }
        if (key.key === 'l') {
          if (cursor < text.length) { cursor += 1; host.invalidate() }
          return true
        }
        if (key.key === 'x') {
          if (cursor < text.length) {
            text = text.slice(0, cursor) + text.slice(cursor + 1)
            host.invalidate()
          }
          return true
        }
        return true // normal-mode keys are consumed (no typing into the draft)
      }
      if (key.key === 'escape') {
        host.invalidate()
        return true // stay in normal mode; Esc is consumed by the editor
      }
      return false // host-reserved keys (Enter etc.) hand back
    }
    return false
  }

  return {
    // The view reads the CURRENT plugin state at compile time (the host
    // compiles it on mount; a state change calls host.invalidate() which
    // repaints — the M4 compiler keeps the child live across resizes).
    component: {
      kind: 'text',
      spans: [
        { text: `vim-mode [${mode.current}] `, tone: 'accent' },
        { text: text === '' ? '(empty)' : text, tone: 'text' },
      ],
    },
    getText: () => text,
    setText: (next: string) => {
      if (disposed) return
      text = next
      host.invalidate()
    },
    getCursor: () => cursor,
    setCursor: (next: number) => {
      if (disposed) return
      cursor = next
      host.invalidate()
    },
    get focused() { return false },
    // P1-6: the SEMANTIC input channel — the host normalized the terminal
    // protocol; the plugin never parses raw escape bytes.
    handleInput,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribe()
    },
  }
}

// ── The plugin entry ───────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // 1. EDITOR SDK: win the seat (single-winner by priority 0). The mode
  //    state is plugin-local; the host owns focus/submission/safety.
  const mode = { current: 'insert' as VimMode }
  const editorHandle = service.registerEditor({
    id: 'vim-editor',
    priority: 0,
    description: 'The vim-mode acceptance editor.',
    create: (host: EditorHost) => createVimEditor(host, mode),
  })

  // 2. KEYBINDINGS (normalized keys → semantic actions — the host routes;
  //    the plugin never sees raw terminal data). Ctrl+Alt+V submits.
  service.registerKeybinding({
    id: 'vim-submit',
    key: { key: 'v', ctrl: true, alt: true, shift: false, super: false },
    action: 'submit-draft',
    description: 'Vim fixture: submit the draft.',
  })

  // 3. WIDGET: a bounded status line above the editor (the M4 component
  //    kit — the host owns the row budgets). The widget text follows the
  //    CURRENT mode through handle.replace (the async-producer → cache →
  //    replace pattern from the plan §8.4).
  const widgetHandle = service.register<InputWidget>('input.widget.below', {
    id: 'vim-status',
    order: 100,
    description: 'Vim fixture status widget.',
  }, {
    view: {
      kind: 'text',
      spans: [
        { text: 'vim fixture', tone: 'success' },
        { text: ' · mode: ', tone: 'textDim' },
        { text: mode.current, tone: 'accent' },
      ],
    },
    importance: 5,
    maxHeight: 1,
  })
  const refreshWidget = (): void => {
    widgetHandle.replace({
      view: {
        kind: 'text',
        spans: [
          { text: 'vim fixture', tone: 'success' },
          { text: ' · mode: ', tone: 'textDim' },
          { text: mode.current, tone: 'accent' },
        ],
      },
      importance: 5,
      maxHeight: 1,
    })
  }

  // 4. COMMAND: a TUI-owned local command (execution ownership metadata —
  //    the bridge never executes; the commands service does). The command
  //    ALSO exposes the managed-overlay trigger (round-1 finding 4: the
  //    overlay must be actually reachable, not dead code). The overlay is
  //    a TOGGLE (round-2 finding 3: no timer at all — nothing can leak
  //    after unload; the second /vimmode closes the current overlay, and
  //    the host's generation-scoped lease closes it on surface dispose).
  let activeOverlay: { close(): void } | undefined
  service.registerCommand({
    id: 'vim-mode-cmd',
    name: 'vimmode',
    description: 'Vim fixture: show the mode and toggle the fixture overlay.',
    execution: 'local',
    sessionless: true,
    handler: (invocation) => {
      void invocation
      // The managed-overlay path is REAL and triggerable: the command
      // opens the overlay (the host mounts it through the broker); the
      // NEXT invocation closes it. No timer — the lease is generation-
      // scoped and the host closes it on surface dispose.
      if (activeOverlay !== undefined) {
        activeOverlay.close()
        activeOverlay = undefined
        return { kind: 'success', text: `vim mode: ${mode.current} (overlay closed)` }
      }
      activeOverlay = service.showOverlay({
        kind: 'frame',
        child: {
          kind: 'text',
          spans: [{ text: 'vim fixture overlay — /vimmode toggles', tone: 'textDim' }],
        },
      }, { width: 40 })
      return { kind: 'success', text: `vim mode: ${mode.current} (overlay opened)` }
    },
  })

  // 5. SETTING: a plugin settings row (the host renders the /settings
  //    panel; the row's onChange decides acceptance).
  const modeSetting: TuiSettingContribution = {
    id: 'vim-mode-setting',
    label: 'Vim mode',
    description: 'The vim fixture mode (normal/insert).',
    currentValue: mode.current,
    values: ['normal', 'insert'],
    onChange: (value) => {
      if (value !== 'normal' && value !== 'insert') return false
      mode.current = value
      refreshWidget()
      return true
    },
  }
  const settingHandle = service.registerSetting(modeSetting)
  void settingHandle

  // 6. TOOL RENDERER: a custom bash tool card (the keyed renderer slot —
  //    undefined abdicates to the host card).
  const toolRenderer: TuiToolRendererContribution = {
    id: 'vim-bash-card',
    toolName: 'bash',
    description: 'Vim fixture: a custom bash tool card.',
    render: (snapshot) => ({
      kind: 'frame',
      child: {
        kind: 'text',
        spans: [
          { text: 'vim bash ', tone: 'accent' },
          { text: snapshot.status, tone: snapshot.status === 'error' ? 'error' : 'success' },
        ],
      },
    }),
  }
  const rendererHandle = service.registerToolRenderer(toolRenderer)
  void rendererHandle

  // 7. CLEANUP: the registrations are FIBER-BOUND — the host disposes
  //    them when this plugin's fiber unloads (HMR, disable). Explicit
  //    disposal is idempotent through the returned handles.
  void editorHandle
}
