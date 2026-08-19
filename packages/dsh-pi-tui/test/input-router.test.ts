/**
 * M6 InputRouter tests (plan §11): the host-owned precedence ladder and
 * normalized-key plugin bindings.
 *
 * Gates:
 * - Kitty press/repeat/release filtered BEFORE everything (a plugin never
 *   sees a protocol artifact);
 * - capturing question/approval own input before plugins;
 * - reserved Host lifecycle keys cannot be preempted by plugins;
 * - a plugin binding receives ONLY the normalized key → SEMANTIC action
 *   (never raw input);
 * - plain printable keys never fire a plugin binding (typing wins);
 * - non-capturing plugin bindings fire LAST, only when nothing earlier
 *   consumed the input.
 * @module @xmoon76/dsh-pi-tui/input-router.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { InputRouter } from '../src/input-router.ts'
import { RESERVED_HOST_KEYS } from '../src/keybinding-registry.ts'
import type { NormalizedKey, TuiAction } from '../src/extension/public-types.ts'

function context(overrides: Partial<Parameters<InputRouter['route']>[1]> = {}): Parameters<InputRouter['route']>[1] {
  return {
    questionActive: false,
    approvalActive: false,
    viewerLocked: false,
    hasOverlay: false,
    searchActive: false,
    tasksActive: false,
    editorText: '',
    externalEditorInFlight: false,
    editorReceivesText: true,
    ...overrides,
  }
}

function router(): InputRouter {
  return new InputRouter(RESERVED_HOST_KEYS)
}

function noBindings(): (key: NormalizedKey) => TuiAction | undefined {
  return () => undefined
}

test('InputRouter: Kitty release/repeat events are protocol artifacts, never seen by plugins', () => {
  const r = router()
  // Kitty protocol flag 2: release events carry `:3` in the sequence
  // (`\x1b[<codepoint>;<modifier>:3u`), repeats carry `:2`.
  const release = '\x1b[111;1:3u'
  assert.equal(r.route(release, context(), noBindings()).kind, 'protocol')
  const repeat = '\x1b[111;1:2u'
  assert.equal(r.route(repeat, context(), noBindings()).kind, 'protocol')
})

test('InputRouter: a question flow owns input before plugins', () => {
  const r = router()
  const result = r.route('x', context({ questionActive: true }), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed')
})

test('InputRouter: an approval prompt owns input before plugins', () => {
  const r = router()
  const result = r.route('y', context({ approvalActive: true }), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed')
})

test('InputRouter: the read-only viewer locks everything except Esc/Ctrl+O', () => {
  const r = router()
  const locked = context({ viewerLocked: true })
  assert.equal(r.route('a', locked, () => 'open-search' as TuiAction).kind, 'consumed')
  // Esc and Ctrl+O pass the VIEWER branch (the host runs the viewer-exit
  // and fold-toggle paths); they are reserved lifecycle keys, so the
  // router reports them consumed — never a plugin binding, never the
  // editor.
  assert.equal(r.route('\x1b', locked, () => 'open-search' as TuiAction).kind, 'consumed')
  assert.equal(r.route('\x1b[111;13u', locked, () => 'open-search' as TuiAction).kind, 'consumed')
})

test('InputRouter: reserved host lifecycle keys never reach a plugin binding', () => {
  const r = router()
  // Ctrl+C is reserved: the host ladder handles it; the router reports the
  // route as consumed BEFORE the plugin stage (the plugin can never claim
  // it — the M5 registry already rejects registration).
  const result = r.route('\x03', context(), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed')
  // Enter is reserved too.
  const enter = r.route('\r', context(), () => 'open-search' as TuiAction)
  assert.equal(enter.kind, 'consumed')
})

test('InputRouter: a plugin binding fires for a normalized non-printable key', () => {
  const r = router()
  let seen: NormalizedKey | undefined
  const result = r.route('\x1b[1;5C', context(), (key) => {
    seen = key
    return 'open-search'
  })
  assert.equal(result.kind, 'plugin-action')
  if (result.kind === 'plugin-action') assert.equal(result.action, 'open-search')
  assert.deepEqual(seen, { key: 'right', ctrl: true, alt: false, shift: false, super: false })
})

test('InputRouter: plain printable keys never fire a plugin binding (typing wins)', () => {
  const r = router()
  const result = r.route('a', context(), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'editor', 'a plain letter is the editor\'s')
})

test('InputRouter: overlays keep their keys (a plugin binding does not fire under an overlay)', () => {
  const r = router()
  const result = r.route('\x1b[1;5C', context({ hasOverlay: true }), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'editor', 'the overlay/focused component owns the key')
})

test('InputRouter: search overlay owns its keys', () => {
  const r = router()
  const search = context({ searchActive: true })
  assert.equal(r.route('\x1b', search, noBindings()).kind, 'consumed', 'Esc closes search')
  assert.equal(r.route('\r', search, noBindings()).kind, 'consumed', 'Enter jumps next')
})

test('InputRouter: normalize() returns the public key identity (never raw)', () => {
  const r = router()
  assert.deepEqual(r.normalize('\x1b[A'), { key: 'up', ctrl: false, alt: false, shift: false, super: false })
  assert.deepEqual(r.normalize('\x1b[1;5A'), { key: 'up', ctrl: true, alt: false, shift: false, super: false })
  assert.deepEqual(r.normalize('x'), { key: 'x', ctrl: false, alt: false, shift: false, super: false })
  assert.equal(r.normalize('multi-char'), undefined, 'paste bursts never normalize')
  assert.deepEqual(r.normalize('\x1b'), { key: 'escape', ctrl: false, alt: false, shift: false, super: false }, 'bare Esc is a key')
})

test('InputRouter: CSI-u + modifyOtherKeys normalize (v0.1.8 matrix)', () => {
  const r = router()
  // CSI-u arrows (shift modifier).
  assert.deepEqual(r.normalize('\x1b[1;2A'), { key: 'up', ctrl: false, alt: false, shift: true, super: false })
  // Kitty CSI-u Ctrl+O: the fork's parseKey reports the super bit for the
  // 13 modifier (ctrl+super+o) — the router consumes the fork's
  // normalization verbatim (the host's matchesKey is the routing
  // authority; parseKey is the plugin key identity).
  assert.deepEqual(r.normalize('\x1b[111;13u'), { key: 'o', ctrl: true, alt: false, shift: false, super: true })
  // zellij's super modifier bit (128): the fork's parseKey ignores it and
  // reports the plain arrow (matchesKey likewise — bit 128 is dropped).
  assert.deepEqual(r.normalize('\x1b[1;129B'), { key: 'down', ctrl: false, alt: false, shift: false, super: false })
  // Esc.
  assert.deepEqual(r.normalize('\x1b'), { key: 'escape', ctrl: false, alt: false, shift: false, super: false })
  // Tab.
  assert.deepEqual(r.normalize('\t'), { key: 'tab', ctrl: false, alt: false, shift: false, super: false })
})

// ── TuiApp integration: a plugin keybinding fires through the host ─────────

test('TuiApp: a plugin keybinding fires the semantic action (headless)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // M6: a plugin binding for Ctrl+Alt+X → open-search (a non-printable
    // normalized key). The resolver receives RAW input and returns the
    // SEMANTIC action — the plugin never sees raw data.
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // A minimal pluginActionFor emulating the runner's registry resolver:
    // normalize via the app's InputRouter, then map the key.
    pluginActionFor: (data) => {
      const key = app.normalizeKey(data)
      if (key === undefined) return undefined
      if (key.key === 'x' && key.ctrl && key.alt) return 'open-search'
      return undefined
    },
  })
  app.start()
  await vt.waitForRender()
  // Ctrl+Alt+X as a legacy sequence (ESC + Ctrl+X = \x18): the fork's
  // parseKey maps it to ctrl+alt+x — a non-printable normalized key the
  // plugin binding can claim.
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'])
  // A plain letter never fires a binding.
  vt.sendInput('a')
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'plain typing must not fire a binding')
  // A reserved key never fires a binding.
  vt.sendInput('\x03') // Ctrl+C
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'reserved keys must not fire a binding')
  app.stop()
})
