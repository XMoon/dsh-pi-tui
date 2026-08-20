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

test('InputRouter: Ctrl+F transcript search is reserved from plugin bindings', () => {
  const r = router()
  assert.equal(r.route('\x06', context(), () => 'open-search').kind, 'consumed')
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
  if (result.kind === 'plugin-action') {
    assert.equal(result.action, 'open-search')
    assert.deepEqual(result.key, { key: 'right', ctrl: true, alt: false, shift: false, super: false })
  }
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
  assert.equal(result.kind, 'consumed', 'TuiApp passes consumed overlay keys to the focused overlay component')
})

test('InputRouter: replacement editors get the editor route before plugin bindings', () => {
  const r = router()
  let bindingCalls = 0
  const result = r.route('\x1b[1;7x', context({ editorReplacement: true }), () => {
    bindingCalls += 1
    return 'open-search'
  })
  assert.equal(result.kind, 'editor')
  assert.equal(bindingCalls, 0, 'replacement editor route must not consult plugin bindings')
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

test('TuiApp: a throwing plugin action is isolated and reported with its contribution id', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const errors: Array<{ slot: string; id: string; error: unknown }> = []
  const recovered: Array<{ slot: string; id: string }> = []
  let attempts = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: () => { attempts += 1; if (attempts === 1) throw new Error('action boom') },
    onExtensionError: event => errors.push(event),
    onExtensionRecovered: event => recovered.push(event),
  }, {
    pluginActionFor: key => key.key === 'x' && key.ctrl && key.alt ? 'open-search' : undefined,
    pluginActionIdFor: key => key.key === 'x' && key.ctrl && key.alt ? 'binding-x' : undefined,
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.equal(attempts, 1)
  assert.deepEqual(errors.map(error => ({ slot: error.slot, id: error.id, message: String(error.error) })), [
    { slot: 'keybinding', id: 'binding-x', message: 'Error: action boom' },
  ])
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.equal(attempts, 2)
  assert.deepEqual(recovered, [{ slot: 'keybinding', id: 'binding-x' }])
  app.stop()
})

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
    // it receives the NORMALIZED key (the InputRouter decoded the raw
    // input — the plugin never sees raw data).
    pluginActionFor: (key) => {
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

// ── TuiApp integration: reserved keys never fire through the real path ─────

test('TuiApp: an untracked keybinding error is not reported under the key name', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const errors: unknown[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionError: event => errors.push(event),
  }, {
    pluginActionFor: () => { throw new Error('resolver boom') },
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.deepEqual(errors, [], 'a resolver without a tracked id must not fabricate health identity')
  app.stop()
})

test('TuiApp: Enter / Ctrl+J / Ctrl+Enter never fire a plugin binding (round-1 P1)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // A resolver that would claim EVERY key — the router must stop the
    // reserved ones before it is consulted.
    pluginActionFor: (key) => `open-search` as const,
  })
  app.start()
  await vt.waitForRender()
  // Plain Enter (reserved): must NOT fire — the editor consumes it.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Enter must never fire a plugin binding')
  // Ctrl+J with no tasks (the host handler falls through): the reserved
  // gate must still stop it.
  vt.sendInput('\x1b[106;5u') // kitty ctrl+j — check normalization
  await vt.waitForRender()
  // Ctrl+Enter without an onQueueSubmit handler: reserved, must not fire.
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter
  await vt.waitForRender()
  // Ctrl+O (reserved host fold toggle). Kitty ctrl+o = modifier 5.
  vt.sendInput('\x1b[111;5u')
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'reserved keys must never fire a plugin binding')
  app.stop()
})

test('TuiApp: a plugin binding NEVER steals a key the focused editor owns (P1-06)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const submitted: string[] = []
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // A resolver claiming EVERY non-printable key (arrows, Tab, ...).
    pluginActionFor: (key) => 'open-search' as const,
    editorRegistry: registry,
  })
  app.start()
  await vt.waitForRender()
  // While the HOST editor is focused (the default), ↑ must reach the
  // editor — never fire the plugin binding.
  vt.sendInput('\x1b[A') // legacy up
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Up must reach the focused editor, never the plugin')
  // Tab too (completion trigger in the editor).
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Tab must reach the focused editor, never the plugin')
  // A non-editor key (Ctrl+Alt+X chord) STILL fires the plugin binding —
  // the editor has no claim on it.
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'a chord the editor declines still fires the binding')

  // The same holds with a PLUGIN editor occupying the seat: while its
  // component is focused, arrows belong to it — the binding must not fire.
  registry.register({ id: 'vim', priority: 0, create: () => ({
    component: { kind: 'text', spans: [{ text: 'vim' }] },
    getText: () => 'vim draft',
    setText: () => {},
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => {},
  }) }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // legacy down
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'Down must reach the focused PLUGIN editor, never the plugin binding')
  app.stop()
})

test('TuiApp: submitDraft clears the draft like a normal submit (round-1 P2)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  })
  app.start()
  await vt.waitForRender()
  // Type a draft, then submit via the host-owned path.
  app.setDraft('hello from a plugin action')
  await vt.waitForRender()
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello from a plugin action'])
  assert.equal(app.getDraft(), '', 'the draft must be cleared like a normal submit')
  // An empty draft submits nothing.
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello from a plugin action'])
  app.stop()
})
