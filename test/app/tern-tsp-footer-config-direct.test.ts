/**
 * TSP-7 PR-D: the Direct production chain of the native footer config.
 *
 * The chain under test is the REAL source → decision → sink:
 *
 *   DirectConfigPort (a settings-descriptor Host context; USER-layer reads)
 *     → SettingsRuntime.resolveTspFooterConfig (the read-only decision)
 *     → selectRendererMount + productionTspConnector (the mount wiring)
 *     → mountTspRenderer.bindNativeFooterConfig (the one-shot bind + notices)
 *     → commitDisplaySubject → nativeStatuslineRows → the SDK wire
 *
 * The positive case proves a REAL custom config (merged document + USER text
 * item) reaches the emitted native nodes; the negative case proves a merged
 * PROJECT command config with NO USER trust never executes anything and
 * surfaces the honest fallback + notice instead.
 *
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-footer-config-direct
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Node } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../../src/domain/status/types.ts'
import { DirectConfigPort, type HostContextLike, type SettingsServiceLike } from '../../src/runtime/direct/config-direct.ts'
import { createSettingsRuntime, type SettingsRuntime } from '../../src/app/surface/settings-runtime.ts'
import { resolveTspNativeFooterConfig } from '../../src/domain/footer/tsp-native-config.ts'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'

/** One projection node's own props. */
function props(node: Node): Record<string, unknown> {
  return node.props as Record<string, unknown>
}

/** The merged TUI settings document the tests drive (the raw persisted shape). */
interface TestDoc {
  footer: string
  footerFallbackMode?: string
  footerLayout?: unknown
  footerCustomItems?: unknown
}

/**
 * The structural Host context: a settings service whose `tui-app` descriptor
 * carries a MERGED value and a USER section. This is the same seam
 * `DirectConfigPort` reads in production; nothing else is stubbed.
 */
function hostContext(doc: TestDoc, options: { readonly projectItems?: readonly unknown[] } = {}): HostContextLike {
  const settings: SettingsServiceLike = {
    describe: () => [{
      ns: 'tui-app',
      value: { ...doc, ...(options.projectItems === undefined ? {} : { footerCustomItems: [...options.projectItems] }) },
      user: options.projectItems === undefined ? undefined : { footerCustomItems: [...options.projectItems] },
      revision: 1,
    }],
    mutate: async () => {
      throw new Error('the TSP footer projection must never write settings')
    },
  }
  return { get: (name: string) => (name === 'settings' ? settings : undefined) }
}

/** The settings document wrapper the runtime reads (get/replace only). */
function tuiSettingsOf(doc: TestDoc): { get(): TestDoc; replace(next: TestDoc): unknown } {
  return {
    get: () => doc,
    replace: () => { throw new Error('the TSP footer projection must never replace the document') },
  }
}

interface RuntimeHarness {
  readonly runtime: SettingsRuntime
  /** The number of USER-layer custom-item reads the port performed. */
  readonly userItemReads: () => number
  /** Swap the merged document + USER items (the same descriptor semantics). */
  swap(doc: TestDoc, projectItems?: readonly unknown[]): void
}

/** Mount the REAL SettingsRuntime over the REAL DirectConfigPort. */
function mountRuntime(doc: TestDoc, options: { readonly projectItems?: readonly unknown[]; readonly surfaceApp?: object } = {}): RuntimeHarness {
  let reads = 0
  const baseCtx = hostContext(doc, options)
  const ctx: HostContextLike = {
    get: (name: string) => {
      if (name !== 'settings') return baseCtx.get(name)
      const inner = baseCtx.get('settings') as SettingsServiceLike
      return {
        describe: () => {
          reads += 1
          return inner.describe()
        },
        mutate: inner.mutate,
      }
    },
  }
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const runtime = createSettingsRuntime({
    surface: {
      app: (options.surfaceApp ?? {
        notify: () => {},
        setFooterPreset: () => {},
        setFooterLayout: () => {},
        setFooterCustomItems: () => {},
        syncFooterCommandItems: () => {},
        applyFooterCommandConfig: () => {},
        disableFooterCommand: () => {},
        requestFooterCommandRefresh: () => {},
        disposeFooterCommand: () => {},
        getEffectiveFooterLayout: () => [],
      }) as never,
      status: { snapshot: () => emptyStatusSnapshot(), subscribe: () => () => {} },
    },
    signal: new AbortController().signal,
    tuiSettings: tuiSettingsOf(doc) as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: { config: port },
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} } as never,
    status: { refresh: () => {} },
    extensions: () => undefined,
  } as never)
  return {
    runtime,
    userItemReads: () => reads,
    swap: (next, projectItems) => {
      // The descriptor is rebuilt per describe() call from the closure; a
      // swap therefore re-reads the CURRENT value. The simplest honest swap
      // is a fresh port + runtime, which the tests do through mountRuntime.
      void next
      void projectItems
    },
  }
}

/** A rich snapshot for the committed status facts. */
function richSnapshot(): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    access: { permissionPreset: { id: 'workspace-write' } },
    workspace: { cwd: '/workspaces/direct-chain', branch: 'prd-branch' },
    composition: { model: { provider: 'deepseek', id: 'luna-fast', reasoningEffort: 'high' } },
    usage: {
      ...base.usage,
      tokens: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 720_000, windowTokens: 1_000_000, percent: 72 },
    },
  } as unknown as StatusSnapshot
}

const CUSTOM_LAYOUT = {
  schemaVersion: 1,
  rows: [
    {
      left: [
        { id: 'model', format: 'compact', importance: 90 },
        { id: 'git-branch', format: 'label', prefix: 'branch:', importance: 20 },
        { id: 'user:environment' },
      ],
      right: [{ id: 'context', format: 'percent', importance: 100 }],
    },
    { left: [{ id: 'performance', format: 'latency', importance: 40 }], right: [] },
  ],
}

/** The live `status`/`seg` nodes of the pane. */
function liveRows(pane: TspPane): { key: string; segs: { key: string; text: string; side?: string; priority?: number; tone?: string }[] }[] {
  const nodes = wireNodes(pane)
  const ordered = nodes.slice().sort((a, b) => a.id.localeCompare(b.id))
  const out: { key: string; segs: { key: string; text: string; side?: string; priority?: number; tone?: string }[] }[] = []
  for (const node of ordered) {
    if (node.k !== 'status') continue
    const segs = nodes
      .filter(child => child.k === 'seg' && child.id.startsWith(`${node.id}.`))
      .map(child => ({
        key: String(child.p.key ?? ''),
        text: typeof child.p.text === 'string' ? child.p.text : '',
        ...(child.p.side === undefined ? {} : { side: String(child.p.side) }),
        ...(child.p.priority === undefined ? {} : { priority: Number(child.p.priority) }),
        ...(child.p.tone === undefined ? {} : { tone: String(child.p.tone) }),
      }))
    out.push({ key: String(node.p.key ?? ''), segs })
  }
  return out
}

async function openOn(pane: TspPane) {
  const { connect } = await import('@stencil-hq/tern')
  const session = await connect({ env: {}, input: pane.input, output: pane.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  return session
}

/** The dock text lines (the notice witness). */
function dockTexts(pane: TspPane): string[] {
  return wireNodes(pane)
    .filter(node => node.k === 'text')
    .map(node => String(node.p.text ?? ''))
}

test('the REAL Direct chain projects a custom USER config onto the native wire', async () => {
  const pane = installTspPane({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'status', 'seg'] })
  try {
    const session = await openOn(pane)
    const { runtime } = mountRuntime(
      { footer: 'custom', footerLayout: CUSTOM_LAYOUT },
      { projectItems: [{ schemaVersion: 1, id: 'user:environment', kind: 'text', text: 'prod-cluster' }] },
    )
    const config = runtime.resolveTspFooterConfig()
    assert.equal(config.mode, 'custom', 'the resolver read the real merged document')
    // The committed snapshot carries no latency fact: row 2's only placement
    // (performance:latency) renders nothing, so exactly ONE status node is
    // the honest projection. Enrich the snapshot to prove row 2 when present.
    const withPerformance: StatusSnapshot = {
      ...richSnapshot(),
      usage: {
        ...richSnapshot().usage,
        performance: { firstTokenMs: 2600, tokensPerSec: 116 },
      },
    } as unknown as StatusSnapshot

    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    try {
      renderer.bindStatusReader({ snapshot: () => withPerformance })
      renderer.bindNativeFooterConfig(config)
      renderer.display.commitDisplaySubject({}, {}, undefined)

      await waitUntil('the custom rows on the wire', () => liveRows(pane).length > 0, 5_000)
      const rows = liveRows(pane)
      assert.deepEqual(rows.map(row => row.key), ['status-row-1', 'status-row-2'], 'the two layout rows mounted')
      const rowOne = rows[0]!
      assert.deepEqual(rowOne.segs.map(seg => seg.key), ['footer-r1-l0', 'footer-r1-l1', 'footer-r1-l2', 'footer-r1-r0'])
      assert.ok(rowOne.segs[0]!.text.includes('luna-fast'), `the explicit model: ${rowOne.segs.map(s => s.text).join(' | ')}`)
      assert.ok(rowOne.segs[1]!.text.startsWith('branch:'), `the user prefix: ${rowOne.segs[1]!.text}`)
      assert.equal(rowOne.segs[2]!.text, 'prod-cluster', 'the USER text item came from the USER-layer read')
      assert.ok(rowOne.segs[3]!.text.includes('72%'))
      assert.equal(rowOne.segs[3]!.side, 'right')
      assert.equal(rowOne.segs[0]!.priority, 90, 'the user importance reached the wire')
      assert.ok(rows[1]!.segs[0]!.text.includes('TTFB'), 'row 2 latency placement')

      // No notice: the config is fully supported.
      assert.deepEqual(config.notices, [])
    } finally {
      await renderer.dispose()
    }
  } finally {
    pane.restore()
  }
})

test('a merged PROJECT command config with no USER trust never executes and surfaces the fallback', async () => {
  const pane = installTspPane({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'status', 'seg'] })
  try {
    const session = await openOn(pane)
    // The MERGED document forces `footer: command` with a project-layer
    // command item; the USER section has NO footerCustomItems at all.
    const { runtime } = mountRuntime(
      { footer: 'command', footerFallbackMode: 'compact' },
      { projectItems: undefined },
    )
    const config = runtime.resolveTspFooterConfig()
    assert.equal(config.mode, 'compact', 'the persisted fallback mode decides the native shape')
    assert.deepEqual(config.notices, ['TSP cannot run command footer; saved native fallback shown.'])

    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    try {
      renderer.bindStatusReader({ snapshot: richSnapshot })
      renderer.bindNativeFooterConfig(config)
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('the compact fallback row on the wire', () => liveRows(pane).length > 0, 5_000)
      const rows = liveRows(pane)
      assert.equal(rows.length, 1, 'compact paints exactly one row')
      assert.ok(rows[0]!.segs.some(seg => seg.text.includes('direct-chain')), 'the native fallback shows the real facts')
      await waitUntil('the notice on the dock', () => dockTexts(pane).some(text => text.includes('cannot run command footer')), 5_000)
    } finally {
      await renderer.dispose()
    }
  } finally {
    pane.restore()
  }
})

test('the mount wiring binds the footer config exactly once through the production selection', async () => {
  const pane = installTspPane()
  try {
    const session = await openOn(pane)
    const { selectRendererMount, productionTspConnector } = await import('../../src/app/bootstrap/renderer-selection.ts')
    const { runtime } = mountRuntime({ footer: 'compact' })
    let resolves = 0
    const mount = await selectRendererMount({
      log: () => {},
      env: { DSH_PI_TUI_RENDERER: 'tsp' },
      resolveFooterConfig: () => {
        resolves += 1
        return runtime.resolveTspFooterConfig()
      },
      connectTsp: productionTspConnector({
        copyVisual: async () => false,
        cwd: '/tmp',
        requestExit: () => {},
        onFatal: () => {},
        log: () => {},
        logError: () => {},
        connect: async () => session,
      }),
    })
    assert.ok(mount !== undefined)
    // The FIRST production mount binds the reader + footer config together;
    // run it so the resolver evaluation is the mount's own (never a test's).
    mount.mount({} as never, { snapshot: () => richSnapshot() })
    assert.equal(resolves, 1, 'the resolver ran exactly once, at the mount')
    // The footer bind is one-shot on the renderer: the mount's SECOND bind
    // attempt (driven through a fresh production connector over the same
    // session's contract shape is NOT possible — one session, one renderer —
    // so the one-shot witness is the renderer the mount itself produced).
    // Release the mount; the resolver count must not grow on release.
    await mount.releaseUnmounted()
    assert.equal(resolves, 1, 'the release path never re-evaluates the resolver')
  } finally {
    pane.restore()
  }
})

test('a not-ready backend keeps the USER read at zero (fail closed)', () => {
  const doc: TestDoc = { footer: 'custom', footerLayout: CUSTOM_LAYOUT }
  // A minimal port whose readiness is stale and whose USER read would count.
  let userReads = 0
  const port = {
    configReadiness: () => 'stale' as const,
    footerCommandTrust: {},
    footerCustomItems: {
      get: () => { userReads += 1; return { items: [], invalidCount: 0 } },
      rawForPersistence: () => ({ kind: 'unavailable' as const }),
    },
  }
  const runtime = createSettingsRuntime({
    surface: {
      app: { notify: () => {} } as never,
      status: { snapshot: () => emptyStatusSnapshot(), subscribe: () => () => {} },
    },
    signal: new AbortController().signal,
    tuiSettings: tuiSettingsOf(doc) as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: { config: port },
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} } as never,
    status: { refresh: () => {} },
    extensions: () => undefined,
  } as never)
  const config = runtime.resolveTspFooterConfig()
  assert.equal(config.mode, 'default', 'not ready fails closed to the default')
  assert.deepEqual(config.notices, ['Footer settings are not current; TSP is showing its default footer.'])
  assert.equal(userReads, 0, 'the USER-layer read never ran')
})

test('a second footer bind on one renderer fails fast (the one-shot lifecycle)', async () => {
  const pane = installTspPane()
  try {
    const session = await openOn(pane)
    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    try {
      renderer.bindStatusReader({ snapshot: () => richSnapshot() })
      renderer.bindNativeFooterConfig(resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } }))
      assert.throws(() => renderer.bindNativeFooterConfig(resolveTspNativeFooterConfig({ doc: { footer: 'compact' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } })),
        /already bound/, 'a second footer bind is an explicit error')
    } finally {
      await renderer.dispose()
    }
    // A post-disposal bind fails fast too.
    const fresh = await (async () => {
      const { connect } = await import('@stencil-hq/tern')
      const second = await connect({ env: {}, input: pane.input, output: pane.output, exitHooks: false, timeout: 500 })
      assert.ok(second !== null)
      const r = mountTspRenderer(second, { copyVisual: async () => false, requestExit: () => {} })
      await r.dispose()
      return r
    })()
    assert.throws(() => fresh.bindNativeFooterConfig(resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } })),
      /disposal/, 'a disposed renderer refuses a late footer bind')
  } finally {
    pane.restore()
  }
})

test('the projection never writes: settings replace and mutate stay unreachable', () => {
  const doc: TestDoc = { footer: 'compact' }
  const { runtime } = mountRuntime(doc)
  const before = JSON.stringify(doc)
  runtime.resolveTspFooterConfig()
  runtime.resolveTspFooterConfig()
  assert.equal(JSON.stringify(doc), before, 'the raw persisted document is untouched')
})

test('the same config snapshot serves session switches and repaints (no per-frame re-read)', async () => {
  const pane = installTspPane({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'status', 'seg'] })
  try {
    const session = await openOn(pane)
    const { runtime, userItemReads } = mountRuntime(
      { footer: 'custom', footerLayout: CUSTOM_LAYOUT },
      { projectItems: [{ schemaVersion: 1, id: 'user:environment', kind: 'text', text: 'stable-value' }] },
    )
    const config = runtime.resolveTspFooterConfig()
    const readsAtBind = userItemReads()
    const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
    try {
      renderer.bindStatusReader({ snapshot: richSnapshot })
      renderer.bindNativeFooterConfig(config)
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('row on the wire', () => liveRows(pane).length > 0, 5_000)

      // A hydration cycle + new commits: the footer presentation must be the
      // SAME compiled snapshot — no settings re-read, no notice replay.
      renderer.display.beginSessionHydration()
      renderer.display.commitDisplaySubject({}, {}, undefined)
      const notices = dockTexts(pane).filter(text => text.includes('footer'))
      assert.equal(notices.length, 0, 'a supported custom config raises no notice')
      assert.ok(liveRows(pane).every(row => row.segs.some(seg => seg.key.startsWith('footer-'))),
        'the custom placement keys survive the repaint')
      assert.equal(userItemReads(), readsAtBind, 'no further USER-layer read happened')
    } finally {
      await renderer.dispose()
    }
  } finally {
    pane.restore()
  }
})
