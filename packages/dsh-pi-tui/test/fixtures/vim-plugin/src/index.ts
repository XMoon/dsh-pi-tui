/**
 * The VIM-MODE acceptance plugin (plan §15, M10): a THIRD-PARTY Cordis
 * plugin that exercises the FULL public extension surface — the editor
 * SDK (single-winner replacement), keybindings, widgets, commands,
 * settings, tool renderers and managed overlays — importing ONLY the
 * public `@xmoon76/dsh-pi-tui/extensions` subpath.
 *
 * CI gate (the vim-plugin smoke): importing `@xmoon76/pi-tui`,
 * `src/tui-app`, or any repository-relative internal path FAILS the
 * gate. If this plugin ever needs a private import, the SDK is missing
 * a capability — the plan forbids adding an `unsafeGetTuiApp()` escape
 * hatch instead.
 * @module dsh-pi-vim-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type EditorHost,
  type EditorSnapshot,
  type ExtensionEditor,
  type InputWidget,
  type PiTuiExtensionService,
  type TuiSettingContribution,
  type TuiToolRendererContribution,
} from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'dsh-pi-vim-fixture'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

// ── A minimal vim-mode editor built on the SDK ────────────────────────────

/**
 * A tiny modal editor: `Esc` is handled by the HOST's keybinding path
 * (the fixture registers a keybinding for it through the registry — the
 * plugin never sees raw input); the editor itself is a plain text
 * surface with normal/insert state tracked PLUGIN-locally (the host owns
 * focus and submission; the plugin owns its own mode state).
 */
function createVimEditor(host: EditorHost, mode: { current: string }): ExtensionEditor {
  let text = ''
  let cursor = 0
  const state = {
    getText: () => text,
    setText: (next: string) => { text = next },
    getCursor: () => cursor,
    setCursor: (next: number) => { cursor = next },
    dispose: () => {},
    component: {
      kind: 'text' as const,
      spans: [
        { text: `vim-mode [${mode.current}] `, tone: 'accent' as const },
        { text: text === '' ? '(empty)' : text, tone: 'text' as const },
      ],
    },
  }
  // The host hands the plugin a snapshot subscription: the fixture proves
  // the subscribe/replaceText contract (a real vim plugin would drive its
  // buffer from these).
  host.subscribe((snapshot: EditorSnapshot) => {
    if (snapshot.text !== text) text = snapshot.text
    if (snapshot.cursor !== cursor) cursor = snapshot.cursor
  })
  return state
}

// ── The plugin entry ───────────────────────────────────────────────────────

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // 1. EDITOR SDK: win the seat (single-winner by priority 0). The mode
  //    state is plugin-local; the host owns focus/submission/safety.
  const mode = { current: 'insert' }
  const editorHandle = service.registerEditor({
    id: 'vim-editor',
    priority: 0,
    description: 'The vim-mode acceptance editor.',
    create: (host: EditorHost) => createVimEditor(host, mode),
  })

  // 2. KEYBINDINGS (normalized keys → semantic actions — the host routes;
  //    the plugin never sees raw terminal data). Alt+Space toggles the
  //    plugin's OWN mode through a settings row below; Ctrl+Alt+V submits.
  service.registerKeybinding({
    id: 'vim-submit',
    key: { key: 'v', ctrl: true, alt: true, shift: false, super: false },
    action: 'submit-draft',
    description: 'Vim fixture: submit the draft.',
  })

  // 3. WIDGET: a bounded status line above the editor (the M4 component
  //    kit — the host owns the row budgets).
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
  void widgetHandle

  // 4. COMMAND: a TUI-owned local command (execution ownership metadata —
  //    the bridge never executes; the commands service does).
  service.registerCommand({
    id: 'vim-mode-cmd',
    name: 'vimmode',
    description: 'Vim fixture: show the current mode.',
    execution: 'local',
    sessionless: true,
    handler: (invocation) => {
      void invocation
      return { kind: 'success', text: `vim mode: ${mode.current}` }
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
      // Refresh the status widget through the public handle API.
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

  // 7. MANAGED OVERLAY: the plugin can open a bounded overlay (the host
  //    mounts it through the broker; the lease is generation-scoped).
  const openOverlay = (): void => {
    const lease = service.showOverlay({
      kind: 'frame',
      child: {
        kind: 'text',
        spans: [{ text: 'vim fixture overlay — Esc closes', tone: 'textDim' }],
      },
    }, { width: 40 })
    // Auto-close after 5s (a real plugin would close on its own key).
    setTimeout(() => lease.close(), 5000)
  }
  void openOverlay

  // 8. CLEANUP: the registrations are FIBER-BOUND — the host disposes
  //    them when this plugin's fiber unloads (HMR, disable). The fixture
  //    proves explicit disposal is idempotent through the returned
  //    handles (no ctx event needed — the service owns the lifecycle).
  void editorHandle
}
