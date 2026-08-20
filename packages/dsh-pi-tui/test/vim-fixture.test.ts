/**
 * P1-6 acceptance: the vim acceptance plugin is a REAL modal editor. The
 * fixture's apply() runs in a real Cordis context; its editor wins the
 * seat through the public SDK and its handleInput state machine performs
 * insert-mode editing (printable text, Backspace, Left/Right, Esc) and
 * normal-mode navigation/deletion (i/h/l/x) on SEMANTIC events — the
 * host normalized the terminal protocol, so legacy and CSI-u encodings
 * behave identically. Host-owned submission (Enter/Ctrl+Enter/Ctrl+S)
 * is never re-implemented in the plugin.
 * @module @xmoon76/dsh-pi-tui/vim-fixture.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import { TuiApp } from '../src/tui-app.ts'
import { EditorRegistry } from '../src/editor-registry.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A minimal provider fiber that provides tuiStartup (the host's gate). */
function startupPlugin(ctx: Context): void {
  ctx.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: '/ws' })
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Load the vim fixture at runtime (its module shape matches the Loader).
 * The fixture imports ONLY the public `@xmoon76/dsh-pi-tui/extensions`
 * subpath (the vim-plugin smoke gates that against the packed tarball);
 * here it resolves against the built dist via the workspace package.
 * The path is built dynamically so the main tsconfig (which excludes
 * test/fixtures) never follows this import for typechecking. */
/** Load the vim fixture at runtime (its module shape matches the Loader).
 * The fixture imports ONLY the public `@xmoon76/dsh-pi-tui/extensions`
 * subpath (the vim-plugin smoke gates that against the packed tarball);
 * here it resolves against the BUILT dist via a temporary symlink exactly
 * like the smoke's offline-safe mirror (a real profile resolves the same
 * way). The symlink is removed afterwards. The path is built dynamically
 * so the main tsconfig (which excludes test/fixtures) never follows this
 * import for typechecking. */
async function loadVimFixture(): Promise<(ctx: Context) => void> {
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { mkdirSync, rmSync, symlinkSync, existsSync } = await import('node:fs')
  const dir = dirname(fileURLToPath(import.meta.url))
  const fixtureDir = join(dir, 'fixtures', 'vim-plugin')
  const linkDir = join(fixtureDir, 'node_modules', '@xmoon76')
  const link = join(linkDir, 'dsh-pi-tui')
  const packageRoot = join(dir, '..')
  if (!existsSync(link)) {
    mkdirSync(linkDir, { recursive: true })
    symlinkSync(packageRoot, link, 'dir')
  }
  try {
    const mod = await import(join(fixtureDir, 'src', 'index.ts'))
    return (mod as { apply(ctx: Context): void }).apply
  } finally {
    // Leave the symlink in place for the test run; it is gitignored and
    // the smoke creates its own scratch copies. (Removing it mid-run could
    // break a second load.)
  }
}

test('P1-6: the vim fixture is a REAL modal editor — insert and normal modes over semantic events', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin(startupPlugin)
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber
    const vimFiber = ctx.plugin(await loadVimFixture())
    await vimFiber

    // The fixture's editor wins the seat through the public SDK.
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as {
      _ledger(): unknown
      editors: EditorRegistry
      commands: { hasAny(): boolean }
      settings: { hasAny(): boolean }
      keybindings: { hasAny(): boolean; actionFor(key: import('../src/extension/public-types.ts').NormalizedKey): import('../src/extension/public-types.ts').TuiAction | undefined }
      renderers: { hasAny(): boolean }
      themes: { hasAny(): boolean }
      autocomplete: { hasAny(): boolean }
    }
    assert.equal(service.editors.winner()?.id, 'vim-editor', 'the vim fixture must win the editor seat')
    assert.equal(service.commands.hasAny(), true, 'the fixture registers a command')
    assert.equal(service.settings.hasAny(), true, 'the fixture registers a setting')
    assert.equal(service.keybindings.hasAny(), true, 'the fixture registers a keybinding')
    assert.equal(service.renderers.hasAny(), true, 'the fixture registers a tool renderer')

    const vt = new VirtualTerminal(80, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
      editorRegistry: service.editors,
      pluginActionFor: (key) => service.keybindings.actionFor(key),
    })
    app.start()
    await vt.waitForRender()
    assert.equal(app.seatEditorForTest().id, 'vim-editor', 'the vim fixture occupies the seat')

    // INSERT mode: printable typing appends (semantic key events).
    vt.sendInput('h')
    vt.sendInput('e')
    vt.sendInput('l')
    vt.sendInput('l')
    vt.sendInput('o')
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hello', 'insert mode must accept printable text (P1-6)')
    assert.equal(app.seatEditorForTest().getCursor(), 5)

    // Backspace deletes backward.
    vt.sendInput('\x7f')
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hell', 'insert mode Backspace must delete (P1-6)')
    assert.equal(app.seatEditorForTest().getCursor(), 4)

    // Esc → NORMAL mode; typing is now consumed as commands, not text.
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hell', 'Esc exits insert mode; normal-mode keys never type')
    vt.sendInput('a')
    vt.sendInput('b')
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hell', 'normal mode must not insert text (P1-6)')

    // h/l move the cursor; x deletes at the cursor.
    vt.sendInput('h') // cursor 4 → 3
    await vt.waitForRender()
    assert.equal(app.seatEditorForTest().getCursor(), 3)
    vt.sendInput('x') // delete 'l' at index 3
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hel', 'normal mode x must delete at the cursor (P1-6)')
    assert.equal(app.seatEditorForTest().getCursor(), 3)
    vt.sendInput('l')
    await vt.waitForRender()
    assert.equal(app.seatEditorForTest().getCursor(), 3, 'l moves right (clamped at the end)')

    // i → INSERT again; typing resumes.
    vt.sendInput('i')
    await vt.waitForRender()
    vt.sendInput('!')
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hel!', 'i returns to insert mode (P1-6)')

    // LEGACY vs CSI-u encodings normalize to the SAME semantic keys:
    // backspace legacy \x7f and CSI-u \x1b[127;1u both delete backward.
    const before = app.getDraft()
    vt.sendInput('\x1b[127;1u')
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'hel', `CSI-u backspace must behave identically to legacy (P1-5): ${before} -> ${app.getDraft()}`)

    // Host-owned submission: Enter submits through the HOST path and
    // clears the plugin draft — the plugin never re-implements it.
    const submitted: string[] = []
    const app2 = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} }, {
      editorRegistry: service.editors,
      pluginActionFor: (key) => service.keybindings.actionFor(key),
    })
    app2.start()
    await vt.waitForRender()
    vt.sendInput('draft')
    await vt.waitForRender()
    vt.sendInput('\r')
    await vt.waitForRender()
    assert.deepEqual(submitted, ['draft'], 'Enter submits through the host path (P1-6)')
    assert.equal(app2.getDraft(), '', 'the host submit clears the plugin draft')
    app2.stop()

    app.stop()
  } finally {
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})
