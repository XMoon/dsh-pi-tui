/**
 * Phase 3A / PR-C cross-layer row-grant regression (the surviving real
 * `/keybindings` deeplink case, C-T08).
 *
 * The bare `/keybindings` command takes the ONE full-screen Settings lease and
 * mounts the EXISTING `KeybindingEditorPanel` in its body — never the retired
 * 88-column overlay. This case drives the REAL command through a real `TuiApp`
 * and `VirtualTerminal`, so the panel is budgeted by the same chain production
 * uses, and it counts the panel's actual teardown effect.
 *
 * The nested legacy `SettingsList` submenu cases that used to live here were
 * retired in C2-R6 with the `Extensions → Configure extension settings…`
 * transition (the full legacy settings editor is now unreachable); their
 * surviving semantics are mapped in the R6 PR's assertion→coverage ledger to
 * `settings-specialized-editors`, `settings-workspace-visual`, the keybinding
 * editor suite and the vendored SettingsList tests.
 * @module @xmoon76/dsh-pi-tui/surface-row-grant.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { KeybindingEditorPanel } from '../../src/tui/keybindings/ui/list.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'

/** Every TuiApp constructed here is disposed after each test: the process
 * slot (the vendored fork keybindings are process-global) is released only
 * by the FINAL dispose (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function viewportText(vt: VirtualTerminal): string {
  return vt.getViewport().map(stripAnsi).join('\n')
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly invoke: (name: string) => unknown
  /** C2-R5: the panel the bare `/keybindings` deeplink really mounted. */
  readonly deeplink: () => { readonly panel: KeybindingEditorPanel | undefined; readonly teardowns: number }
}

/**
 * Mount the real commands on a real app. The runner is a defaults-permissive
 * stub (every unset dependency is a no-op), matching the existing
 * `/settings` command-entry suites; the pointed-at seams (commands registry,
 * tuiSettings doc, config readiness) are real.
 */
function setup(options: { columns?: number; rows?: number } = {}): Harness {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.columns ?? 120, options.rows ?? 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const defs: Array<{ name: string; handler?: unknown }> = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const doc = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'full',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
    terminalProgress: '9;4+7501',
    wheelScrollLines: '1',
  }
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    currentNotificationMode: () => 'unfocused' as const,
    currentNotificationMethod: () => 'auto' as const,
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    // A sessionless surface: the settings rows see no live scope.
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    // C3 About seams: this fixture composes no StatusRuntime, so the
    // sessionless capture is the only reachable state (no scoped read can
    // start). The subscription STILL must return a real disposer: opening
    // `/settings` builds the About controller, its close calls `dispose()`,
    // and a non-function return would abort the TuiApp teardown and leak the
    // process slot into every later test.
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    tuiSettings: { get: () => doc, replace: () => undefined },
    // The minimal REAL extension registries: this case exercises the static
    // Keyboard shortcuts page, not extension contributions.
    extensions: { themes: new ThemeRegistry(), settings: new SettingsRegistry() } as never,
    createPluginManagerPage: () => undefined,
    config: settingsDirectPageConfig({
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      // The Web provider section is Host-only (S2/PR-B): this stub composes no
      // Host settings plane, so the section reports unavailable and offers no write.
      web: { available: () => false },
      // The credential STORE is not mounted either: the Web section's key row
      // reports unavailable instead of claiming "not configured".
      credentials: { available: () => false },
    }),
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name: string): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  // Test instrumentation ONLY for the same-lease `/keybindings` page: observe
  // the panel the factory registers and count the ACTUAL teardown effect. The
  // command factory registers the panel exactly once; its unregister IS the
  // panel's `onDispose` callback.
  let deeplinkPanel: KeybindingEditorPanel | undefined
  let teardowns = 0
  const originalTrackKeybindingEditor = app.trackKeybindingEditor
  app.trackKeybindingEditor = ((component: Parameters<TuiApp['trackKeybindingEditor']>[0]) => {
    const unregister = originalTrackKeybindingEditor.call(app, component)
    if (component instanceof KeybindingEditorPanel) deeplinkPanel = component
    let released = false
    return () => {
      if (!released) {
        released = true
        teardowns += 1
      }
      unregister()
    }
  }) as TuiApp['trackKeybindingEditor']
  return {
    vt,
    app,
    invoke,
    deeplink: () => ({ panel: deeplinkPanel, teardowns }),
  }
}

test('C-T08: bare /keybindings deeplinks into the ONE Settings lease and disposes its panel once', async () => {
  for (const [columns, rows] of [[80, 24], [120, 40]] as const) {
    const h = setup({ columns, rows })
    h.invoke('keybindings')
    await h.vt.waitForRender()
    let view = viewportText(h.vt)
    // The SAME fullscreen Settings screen: one root header/breadcrumb, one
    // pane header and the page's ONE bar — not the legacy 88-column overlay.
    assert.match(view, /Settings · Input & Terminal · Keyboard shortcuts/, `${columns}x${rows}: the Settings lease must own the screen:\n${view}`)
    assert.match(view, /Search: /, `${columns}x${rows}: the page's input is painted:\n${view}`)
    assert.match(view, /Esc close/, `${columns}x${rows}: the page bar is the physical last row:\n${view}`)
    assert.ok(!view.includes('╭') && !view.includes('╰'), `${columns}x${rows}: no second overlay Frame may be mounted:\n${view}`)
    const panel = h.deeplink().panel
    assert.ok(panel !== undefined, `${columns}x${rows}: the real command must mount the KeybindingEditorPanel:\n${view}`)
    assert.ok(panel.render(68).length <= rows, `${columns}x${rows}: the page is bounded by the Settings frame grant`)
    // First Esc: the page closes and the SAME Settings lease returns to the row.
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    view = viewportText(h.vt)
    assert.match(view, /Settings · Input & Terminal · Rows/, `${columns}x${rows}: the page Esc returns to the source Rows:\n${view}`)
    assert.equal(h.deeplink().teardowns, 1, `${columns}x${rows}: the panel teardown effect must run exactly once`)
    // Second Esc: the row level returns to the rail; third: the Settings lease closes.
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    view = viewportText(h.vt)
    assert.ok(!view.includes('Settings ·'), `${columns}x${rows}: only the whole Settings Esc exits the workspace:\n${view}`)
    h.app.dispose()
    startedApps.delete(h.app)
  }
})
