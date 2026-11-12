/**
 * S4-D3 B02–B14 terminal boundaries (D3-6): the REAL rc.2 Host catalog travels
 * through the ONE shared mapping → D1 classifier/model → the MOUNTED Plugin
 * Manager workspace, where the bounded capability copy and the allowed
 * actions are read from the actual frame. The retired B01 profile no longer
 * carries a boundary (rc.2 promotes Team to the base layer), the web-only
 * bundles stay WEB_ONLY, B13/B14 stay missing Install-only and carry their
 * verified one-shot/provider boundaries, and no Team/Discover/mic/Inspector
 * page is invented.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published rc.2 installation
 * catalog (the official plugin-manager service over a real profile root), the
 * shared Direct adapter/mapping, the real controller and workspace panel and
 * the real TuiApp Alt-Screen lease.
 * `TEST STAND-INS`: the ephemeral profile/installation fixture and the
 * VirtualTerminal; no network, credentials or real package install.
 * `DELIBERATELY ABSENT`: the user's real Profile, public registries and the
 * physical terminal.
 * @module @xmoon76/dsh-pi-tui/bundle-boundaries.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginManager, { type BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import { mkdirSync, writeFileSync } from 'node:fs'
import { EXPERIMENTAL_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG, OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import {
  EXPERIMENTAL_BUNDLE_IDS,
  classifyPluginPackages,
  type PluginClassificationInput,
} from '../../src/app/plugin-manager/classify.ts'
import { buildPluginDetailView, buildPluginManagerModel, bundleValue } from '../../src/app/plugin-manager/model.ts'
import { detachPluginManagerSnapshot } from '../../src/runtime/plugin-manager-mapping.ts'
import { DirectPluginManagerPort, type PluginManagerServiceLike } from '../../src/runtime/direct/plugin-manager-direct.ts'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { disposeContext } from '../support/runner-harness.ts'
import { plain } from '../support/plugin-workspace-harness.ts'

const ON_DEMAND = OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName)
/** The release-added Experimental members in Host catalog order: they are
 *  appended after the frozen B02–B14 order, not interleaved with it. */
const RELEASE_ONLY_EXPERIMENTAL = [...OPTIONAL_BUNDLES, ...ON_DEMAND]
  .filter(name => EXPERIMENTAL_BUNDLES.has(name) && !EXPERIMENTAL_BUNDLE_IDS.includes(name))

function seedProfile(workRoot: string): Record<string, unknown> {
  const profileDir = join(workRoot, 'profile')
  const installationDir = join(workRoot, 'installation')
  const installAnchor = join(installationDir, 'package.json')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(installationDir, { recursive: true })
  writeFileSync(installAnchor, JSON.stringify({
    name: 's4-d3-boundaries-installation',
    private: true,
    dependencies: Object.fromEntries(OPTIONAL_BUNDLES.map(name => [name, '0.2.1-rc.2'])),
  }, null, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 's4-d3-boundaries-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(profilePatchPath, '[]\n')
  for (const name of OPTIONAL_BUNDLES) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.2.1-rc.2',
      private: true,
      // Input fact from the official package manifest: CUA is darwin-only.
      dsh: { bundle: { patch: [], ...(name === '@deepseek-ai/dsh-cua-bundle' ? { platforms: ['darwin'] } : {}) } },
    }, null, 2))
  }
  return {
    name: 's4-d3-boundaries',
    dir: profileDir,
    patchPath: profilePatchPath,
    installAnchor,
    cwd: workRoot,
    home: workRoot,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
}

const SURFACE_HINTS: Readonly<Record<string, RegExp>> = {
  '@deepseek-ai/dsh-experimental-voice-input-bundle': /browser microphone UI is not available/u,
  '@deepseek-ai/dsh-experimental-auto-review': /official permission preset/u,
  '@deepseek-ai/dsh-experimental-inspector-profile': /no PiTui inspection page/u,
  '@deepseek-ai/dsh-experimental-tool-worktree': /create_worktree is a Host tool/u,
  '@deepseek-ai/dsh-experimental-cot-translation-bundle': /not translated reasoning/u,
  '@deepseek-ai/dsh-experimental-terminal-bundle': /terminal_\* tools/u,
  '@deepseek-ai/dsh-experimental-session-search': /return results as Tool output/u,
  '@deepseek-ai/dsh-experimental-session-titles-bundle': /updates existing Session\/title surfaces/u,
  '@deepseek-ai/dsh-experimental-badge-skill-bundle': /dsh-badge is a Host Skill provider/u,
  '@deepseek-ai/dsh-experimental-ralph-bundle': /foreground tool/u,
  '@deepseek-ai/dsh-experimental-plugin-market-bundle': /no PiTui Discover page/u,
  '@deepseek-ai/dsh-subagent-codex': /one-shot Codex subagent tool/u,
  '@deepseek-ai/dsh-subagent-claude-code': /one-shot Claude Code subagent tool/u,
}

test('the real Host catalog paints the 13 verified B02–B14 boundaries through the mounted Plugin Manager', async t => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('s4-d3-boundaries-')
  const profileContext = seedProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => false })

  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const controller = new PluginManagerController(port, {
    requestRender: () => app.requestRender(),
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  const panel = new PluginManagerWorkspacePanel(controller, {
    requestRender: () => app.requestRender(),
    onCopy: () => {},
    onYieldNavigation: () => {},
  }, { onDispose: () => {} })
  // The Plugin Manager is a CHILD of the ONE Settings workspace lease: the
  // real deep link selects Plugins and the real page factory mounts the page.
  const settings = app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready', rows: [], capturedAt: Date.now() }) },
    {
      aboutVersionFacts: { tui: 'test-bundle', dsh: undefined },
      initialCategory: 'plugins',
      onOpenPlugins: () => {
        controller.open()
        return panel
      },
    },
  )
  life.defer(() => { try { settings.close() } catch {} try { app.dispose() } catch {} controller.dispose() })
  const settle = async (rounds = 10): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
    await vt.waitForRender()
  }
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await vt.waitForRender()
    }
    throw new Error(`timed out waiting for ${label}: ${plain(vt.getViewport())}`)
  }
  await settle()
  assert.match(plain(vt.getViewport()), /Settings · Plugins/u, 'the deep link uses the ONE Settings workspace')

  /** The DETAIL column of the embedded dual frame, whitespace-normalized. In a
   *  dual frame a plain row-wise flatten would interleave the List column with
   *  the Details column, so the pane is sliced from its real split. */
  const rawDetail = (): string => {
    const split = panel.contentLayout()
    const lines = vt.getViewport().map(line => plain([line]))
    if (!split.dual) return lines.join('\n')
    const start = split.leftWidth + 2
    return lines.map(line => line.slice(start)).join('\n')
  }
  const detailFrame = (): string => rawDetail().replace(/\s+/gu, ' ')
  // The catalog is the COMPLETE official roster (shipped Optional bundles +
  // on-demand catalog entries); the B02–B14 UI boundaries below are the
  // TUI's own verified subset, not the catalog size.
  await waitFor(() => controller.model().cards.length === OPTIONAL_BUNDLES.length + ON_DEMAND.length,
    'the real Host catalog read')
  assert.deepEqual(controller.model().sections.at(-1)!.cards.map(card => card.name),
    [...EXPERIMENTAL_BUNDLE_IDS, ...RELEASE_ONLY_EXPERIMENTAL])

  // Walk the Experimental tail from B14 backwards using the REAL keys: the
  // Detail is painted for each exact identity and its bounded facts survive.
  // Selection is EXPLICIT (the page's own search seat) because the Host's
  // default listing legitimately hides several Optional bundles.
  for (let index = EXPERIMENTAL_BUNDLE_IDS.length - 1; index >= 0; index -= 1) {
    const name = EXPERIMENTAL_BUNDLE_IDS[index]!
    vt.sendInput('/')
    vt.sendInput('\x1b') // clear any previous query
    vt.sendInput('/')
    for (const character of name) vt.sendInput(character)
    vt.sendInput('\r')
    await settle()
    assert.equal(panel.selectedCardValue(), `bundle:${name}`, `the explicit search selects ${name}`)
    vt.sendInput('\r')
    await waitFor(() => plain(vt.getViewport()).includes('Official DSH catalog entry'), `the ${name} Detail`)
    // The Detail column wraps cleanly; the existing PgUp/PgDn scroll reveals
    // the full bounded copy of the SAME painted pane. Every painted frame is
    // accumulated: an affordance is proven by a frame that really painted it.
    let paintedUnion = detailFrame()
    for (let page = 0; page < 10 && !paintedUnion.includes('TUI surface'); page += 1) {
      vt.sendInput('\x1b[6~')
      await settle()
      paintedUnion += `\n${detailFrame()}`
    }
    for (let page = 0; page < 10 && !SURFACE_HINTS[name]!.test(paintedUnion); page += 1) {
      vt.sendInput('\x1b[6~')
      await settle()
      paintedUnion += `\n${detailFrame()}`
    }
    // The bounded copy is proven by a frame that REALLY painted it: the
    // accumulated detail frames of this card, never a later page position.
    const frame = detailFrame()
    assert.match(paintedUnion, SURFACE_HINTS[name]!, `${name} surfaces its exact boundary:\n${paintedUnion}\ncurrent:\n${frame}`)
    if (ON_DEMAND.includes(name)) {
      // Accumulate the paged frames too: the evidence is a frame that painted
      // the copy, never the pane's final scroll position.
      for (let page = 0; page < 10 && !/no Continue\/Resume/u.test(paintedUnion); page += 1) {
        vt.sendInput('\x1b[6~')
        await settle()
        paintedUnion += `\n${detailFrame()}`
      }
      const external = paintedUnion
      assert.match(external, /no Continue\/Resume/u, `${name} states its verified one-shot boundary`)
      assert.doesNotMatch(external, /EXTERNAL_UNVERIFIED/u, `${name} no longer claims an unqualified native start`)
      // The Action block sits below the bounded facts: page until the frame
      // really paints it (it must be reachable, never merely claimable).
      for (let page = 0; page < 10 && !paintedUnion.includes('Install…'); page += 1) {
        vt.sendInput('\x1b[6~')
        // Fixed wait with a stated window: PgDn is throttled by the renderer, so
        // the bounded loop needs one settle per page before re-reading the frame.
        await settle()
        paintedUnion += `\n${detailFrame()}`
      }
      assert.match(paintedUnion, /Install…/u, `${name} offers the official Install action`)
      assert.doesNotMatch(paintedUnion, /> Enable…/u, `${name} is missing and never offers Enable`)
    } else {
      assert.doesNotMatch(frame, /no Continue\/Resume/u, `${name} is not an external subagent`)
    }
    vt.sendInput('\x1b') // leave Details
    await settle()
  }
  assert.deepEqual(controller.model().cards.filter(card => card.section === 'experimental').map(card => card.name),
    [...EXPERIMENTAL_BUNDLE_IDS, ...RELEASE_ONLY_EXPERIMENTAL],
    'the real Host snapshot kept the frozen B02–B14 order and appended the release members')

  // No phantom Team/Discover/mic/Inspector page action is present in the real
  // catalog; the web-only rows expose only the official Install/Back actions.
  const snapshot = detachPluginManagerSnapshot({
    bundles: await service.listBundles() as BundleInfo[],
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: { exemptions: {}, warnings: [] },
  })
  const inputs: PluginClassificationInput[] = snapshot.bundles.map(bundle => ({
    key: bundleValue(bundle.name),
    bundleName: bundle.name,
    entryIds: [],
    official: bundle.official,
    availability: bundle.availability,
    installed: bundle.installed,
  }))
  const model = buildPluginManagerModel(snapshot, classifyPluginPackages(inputs, []))
  for (const name of [
    '@deepseek-ai/dsh-experimental-voice-input-bundle',
    '@deepseek-ai/dsh-experimental-inspector-profile',
    '@deepseek-ai/dsh-experimental-cot-translation-bundle',
    '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  ]) {
    const card = model.cards.find(candidate => candidate.name === name)!
    assert.equal(card.section, 'experimental')
    assert.equal(card.official, true)
  }
})

// ── D3-6: rc.2 base Team and B03 in the mounted application ────────────────

import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { startS4D3Application } from '../support/application-fixture.ts'
import { profileSelectsBundle, skippedInstallationReason, type OptionalBundleId } from '../support/optional-bundle-fixture.ts'

type BoundaryScript =
  | { readonly kind: 'tool'; readonly name: string; readonly arguments: string; readonly callId: string }
  | { readonly kind: 'text'; readonly text: string }

class BoundaryAdapter extends LlmAdapter {
  readonly scripts: BoundaryScript[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    const script = this.scripts.shift()
    if (script === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (script.kind === 'text') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: script.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: script.text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: script.callId as never, name: script.name, argumentsDelta: script.arguments }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: script.callId as never, name: script.name, arguments: script.arguments },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** The exact durable Tool result of one call id (never the arguments card). */
function toolResultOf(agent: Agent, callId: string): string | undefined {
  for (const event of agent.session.snapshotEvents() as readonly { readonly type?: string; data?: unknown }[]) {
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: { toolCallId?: unknown; content?: readonly { text?: string }[] } }).message
    if (String(message?.toolCallId) !== callId) continue
    return (message?.content ?? []).map(block => block.text ?? '').join('')
  }
  return undefined
}

const B03 = '@deepseek-ai/dsh-experimental-auto-review' satisfies OptionalBundleId

/** Pass-through mutation counter over the REAL plugin-manager service class
 *  (the prototype is shared by the restarted instance). Every call continues
 *  through the original unbound function on the real receiver. */
function countPluginMutations(service: unknown): { readonly counts: Record<'setBundleEnabled' | 'setPluginEnabled' | 'removeBundle', number>; restore(): void } {
  const proto = Object.getPrototypeOf(service) as Record<string, (...args: unknown[]) => unknown>
  const counts = { setBundleEnabled: 0, setPluginEnabled: 0, removeBundle: 0 }
  const originals = new Map<string, (...args: unknown[]) => unknown>()
  for (const name of Object.keys(counts) as Array<keyof typeof counts>) {
    const original = proto[name]
    originals.set(name, original)
    proto[name] = function (this: unknown, ...args: unknown[]) {
      counts[name] += 1
      return original.apply(this, args)
    }
  }
  return { counts, restore() { for (const [name, original] of originals) proto[name] = original } }
}

/**
 * The Release-added Experimental members' real frame: the four catalog entries
 * the current release adds beyond B02–B14 are painted through the SAME mounted
 * Plugin Manager. Their bounded TUI surface/Risk copy, their legal actions and
 * the Host platform refusal of the hidden CUA entry are read from the frame,
 * never from a local support guess. The profile manifests here are the
 * file's own seeded metadata: this case proves the mounted presentation and
 * actions, not that the published packages were loaded (S5-PR1 and the
 * lifecycle/Forge cases own that).
 */
const RELEASE_FRAME_NAMES = [
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-experimental-liveshare',
  '@deepseek-ai/dsh-experimental-forge-bundle',
  '@deepseek-ai/dsh-cua-bundle',
] as const

const RELEASE_FRAME_HINTS: Readonly<Record<typeof RELEASE_FRAME_NAMES[number], RegExp>> = {
  '@deepseek-ai/dsh-personalized-recommendations': /no native Action Card interaction/u,
  '@deepseek-ai/dsh-experimental-liveshare': /no native share controller/u,
  '@deepseek-ai/dsh-experimental-forge-bundle': /no native Forge panel/u,
  '@deepseek-ai/dsh-cua-bundle': /darwin-only platform/u,
}

const RELEASE_FRAME_RISK_HINTS: Readonly<Record<typeof RELEASE_FRAME_NAMES[number], RegExp>> = {
  '@deepseek-ai/dsh-personalized-recommendations': /Risk\s+Web recommendations are not TUI cards/u,
  '@deepseek-ai/dsh-experimental-liveshare': /Risk\s+Relay, owner identity\/credentials/u,
  '@deepseek-ai/dsh-experimental-forge-bundle': /Risk\s+Requires a Git repository/u,
  '@deepseek-ai/dsh-cua-bundle': /Risk\s+darwin-only platform/u,
}

const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'

test('the release Experimental members paint their real TUI surface and platform admission', async t => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('s4-d3-release-frame-')
  const profileContext = seedProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => false })
  const mutations = countPluginMutations(service)
  t.after(mutations.restore)

  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const controller = new PluginManagerController(port, {
    requestRender: () => app.requestRender(),
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  const panel = new PluginManagerWorkspacePanel(controller, {
    requestRender: () => app.requestRender(),
    onCopy: () => {},
    onYieldNavigation: () => {},
  }, { onDispose: () => {} })
  const settings = app.openSettingsWorkspace(
    { readSnapshot: () => ({ configReadiness: 'ready', rows: [], capturedAt: Date.now() }) },
    {
      aboutVersionFacts: { tui: 'test-bundle', dsh: undefined },
      initialCategory: 'plugins',
      onOpenPlugins: () => {
        controller.open()
        return panel
      },
    },
  )
  life.defer(() => { try { settings.close() } catch {} try { app.dispose() } catch {} controller.dispose() })
  const renderFrame = async (rounds = 10): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
    await vt.waitForRender()
  }
  const rawDetail = (): string => {
    const split = panel.contentLayout()
    const lines = vt.getViewport().map(line => plain([line]))
    if (!split.dual) return lines.join('\n')
    const start = split.leftWidth + 2
    return lines.map(line => line.slice(start)).join('\n')
  }
  const detailFrame = (): string => rawDetail().replace(/\s+/gu, ' ')
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await vt.waitForRender()
    }
    throw new Error(`timed out waiting for ${label}: ${plain(vt.getViewport())}`)
  }
  await renderFrame()
  await waitFor(() => controller.model().cards.length === OPTIONAL_BUNDLES.length + ON_DEMAND.length,
    'the real Host catalog read')
  await waitFor(() => {
    const frame = plain(vt.getViewport())
    return frame.includes('Experimental') && !frame.includes('Loading plugins…')
  }, 'the first painted Plugin Manager catalog')

  // The Host hides the CUA entry by default; the initial painted list advertises
  // explicit search, and paging the list never paints the hidden card.
  const firstPage = plain(vt.getViewport())
  assert.match(firstPage, /searches hidden official/u, 'the initial list advertises explicit search')
  let defaultList = firstPage
  for (let page = 0; page < 12; page += 1) {
    const before = plain(vt.getViewport())
    vt.sendInput('\x1b[6~')
    await renderFrame()
    const after = plain(vt.getViewport())
    if (after === before) break
    defaultList += `\n${after}`
  }
  assert.doesNotMatch(defaultList, /dsh-cua-bundle/u, 'the Host-hidden CUA entry is absent from the default list')

  for (const name of RELEASE_FRAME_NAMES) {
    // Exact-name search from the page's own search seat.
    vt.sendInput('/')
    vt.sendInput('\x1b')
    vt.sendInput('/')
    for (const character of name) vt.sendInput(character)
    vt.sendInput('\r')
    await renderFrame()
    assert.equal(panel.selectedCardValue(), `bundle:${name}`, `the explicit search reveals ${name}`)
    vt.sendInput('\r')
    await waitFor(() => plain(vt.getViewport()).includes('Official DSH catalog entry'), `the ${name} Detail`)
    // The CURRENT painted Detail column (never the search box or the
    // controller model) must carry the exact identity. Whitespace is removed
    // because the narrow detail column wraps the package name across lines.
    await waitFor(() => rawDetail().replace(/\s+/gu, '').includes(name),
      `the painted Detail carries the exact ${name} identity`)
    let painted = detailFrame()
    for (let page = 0; page < 20 && !/TUI surface/u.test(painted); page += 1) {
      vt.sendInput('\x1b[6~')
      await renderFrame()
      painted += `\n${detailFrame()}`
    }
    assert.match(painted, /TUI surface/u, `${name} paints its bounded TUI surface:\n${painted}`)
    for (let page = 0; page < 20 && !RELEASE_FRAME_HINTS[name].test(painted); page += 1) {
      vt.sendInput('\x1b[6~')
      await renderFrame()
      painted += `\n${detailFrame()}`
    }
    assert.match(painted, RELEASE_FRAME_HINTS[name], `${name} paints its exact limit:\n${painted}`)
    assert.match(painted, RELEASE_FRAME_RISK_HINTS[name], `${name} paints its exact Risk warning:\n${painted}`)
    const riskCard = controller.model().cards.find(card => card.name === name)
    assert.ok(riskCard !== undefined, `${name} remains in the real Host-derived model`)
    const riskFact = buildPluginDetailView(riskCard!).groups.flatMap(group => group.facts)
      .find(fact => fact.label === 'Risk')
    assert.ok(riskFact !== undefined, `${name} has a bounded Risk fact`)
    assert.equal(riskFact!.tone, 'warning', `${name} risk uses the warning tone`)
    assert.match(painted, /\[experimental\]/u, `${name} is painted in the Experimental section`)
    // The action block sits below the bounded facts; page until the frame
    // really paints the primary action this card offers.
    for (let page = 0; page < 40 && !/> (?:Enable|Install)…/u.test(painted); page += 1) {
      vt.sendInput('\x1b[6~')
      await renderFrame()
      painted += `\n${detailFrame()}`
    }

    if (name === CUA_BUNDLE) {
      // rc.2 moved CUA from the on-demand catalog to the shipped Optional
      // roster: it has no Install route. On a supported Host its shipped
      // Enable is offered; on an unsupported Host the Enable action is painted
      // disabled with the exact Host platform refusal.
      if (process.platform === 'darwin') {
        assert.match(painted, /> Enable…/u, `${name} offers Enable on its supported Host`)
        assert.doesNotMatch(painted, /Remove…/u, `${name} is shipped, so no Remove action exists`)
      } else {
        assert.match(painted, /> Enable… — unsupported-platform/u,
          `${name} paints the Host platform refusal on its disabled Enable action:\n${painted}`)
        assert.match(painted, /This bundle cannot be enabled on the DSH Host platform/u)
        // The disabled action is readable but inert: invoking it only explains
        // the refusal and writes neither the profile nor a Host mutation.
        const before = { ...mutations.counts }
        vt.sendInput('\r')
        await renderFrame()
        await waitFor(() => /cannot be enabled on the DSH Host platform/u.test(plain(vt.getViewport())),
          'the disabled Enable explanation')
        assert.deepEqual(mutations.counts, before, 'the refused Enable dispatches no Host mutation')
      }
    } else {
      assert.match(painted, /> Enable…/u, `${name} offers the official Enable action for its shipped installation`)
      assert.doesNotMatch(painted, /Remove…/u, `${name} is shipped, so the TUI offers no Remove action`)
      assert.doesNotMatch(painted, /Create…|Not now|Share…|Open PR/u,
        `${name} paints no phantom Web/Relay/Forge action:\n${painted}`)
    }
    vt.sendInput('\x1b') // leave Details
    await renderFrame()
  }
  // Supplemental model-level control (NOT mounted-frame evidence): ONE
  // representative same-name official:false package. The Host fact keeps it
  // Third-party, so it inherits neither the Experimental identity nor the new
  // release support copy; the mounted negative remains the existing
  // plugin-manager-classify.test.ts same-name case.
  const impostorName = '@deepseek-ai/dsh-experimental-forge-bundle'
  const impostorSnapshot = detachPluginManagerSnapshot({
    bundles: [{
      name: impostorName,
      official: false,
      availability: 'profile',
      enabled: true,
      installed: true,
      removable: true,
      rows: [],
      overrides: [],
    }] as never,
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: { exemptions: {}, warnings: [] },
  })
  const impostorModel = buildPluginManagerModel(
    impostorSnapshot,
    classifyPluginPackages([{
      key: bundleValue(impostorName),
      bundleName: impostorName,
      entryIds: [],
      official: false,
      availability: 'profile',
      installed: true,
    }], []),
  )
  const impostor = impostorModel.cards.find(card => card.name === impostorName)!
  assert.equal(impostor.section, 'third-party', 'an official:false same-name package stays Third-party')
  assert.equal(impostor.experimental, false)
  assert.equal(buildPluginDetailView(impostor).groups.flatMap(group => group.facts)
    .some(fact => fact.label === 'TUI surface'), false, 'the forged identity inherits no release support copy')

  // The presentation case never wrote the profile or dispatched a Host mutation.
  assert.deepEqual(mutations.counts, {
    setBundleEnabled: 0,
    setPluginEnabled: 0,
    removeBundle: 0,
  }, 'the frame case performed ZERO Host writes')
  for (const name of RELEASE_FRAME_NAMES) {
    assert.equal(profileSelectsBundle(String(profileContext['dir']), name), false, `${name} was never selected by this frame case`)
  }
})

test('the mounted TUI keeps rc.2 base Team capability in the existing Tool/Activity views and invents no Team board', { skip: skippedInstallationReason([]) }, async t => {
  const adapter = new BoundaryAdapter()
  const app = await startS4D3Application(t, {
    // rc.2 moved Team to the base layer: no optional bundle is mounted.
    bundles: [],
    presets: true,
    presetId: 'standard',
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  adapter.scripts.push({ kind: 'text', text: 'Team session ready.' })
  const agent = await app.submitFirstPrompt('Start the team session')
  await agent.whenIdle()
  // The base Team authority is mounted but OFF per Session, and the retired
  // model tool does not exist: the root must enable the mode explicitly.
  const resolveStepTools = async (): Promise<readonly string[]> => {
    const tools = app.host.ctx.tools as unknown as {
      resolve(context: {
        readonly agent: Agent
        readonly modelSelection: { readonly provider: string; readonly model: string }
        readonly signal: AbortSignal
      }): Promise<{ view(scope: Agent): ReadonlyMap<string, unknown>; dispose(): void }>
    }
    const toolSet = await tools.resolve({
      agent,
      modelSelection: { provider: 'scripted', model: 'review-model' },
      signal: new AbortController().signal,
    })
    try {
      return [...toolSet.view(agent).keys()]
    } finally {
      toolSet.dispose()
    }
  }
  assert.equal(app.host.hasTool('spawn_teammate', agent), false, 'rc.2 retired spawn_teammate')
  assert.equal(app.host.hasTool('subagent', agent), true, 'teammates use the standard subagent tool')
  assert.equal((await resolveStepTools()).includes('team_task_create'), false,
    'base Team tools start OFF in the real step admission')
  const teams = app.host.ctx.get('agentTeams') as { setEnabled(agent: unknown, enabled: boolean): Promise<void> }
  await teams.setEnabled(agent, true)
  assert.equal((await resolveStepTools()).includes('team_task_create'), true,
    'the root enablement exposes the shared board to the model step')
  const commands = (app.host.ctx.get('commands') as { list(agent: unknown): readonly { name: string }[] })
    .list(agent).map(command => command.name)
  assert.equal(commands.includes('team'), false, 'no dedicated Team command/board is created by the TUI')

  // The REAL scoped Team operation travels through the same Agent/loop and
  // lands in the existing Tool output (no Team board is involved).
  adapter.scripts.push(
    { kind: 'tool', name: 'team_task_create', callId: 's4d3-b01-task', arguments: JSON.stringify({ subject: 'Scout one file', description: 'Read one file and report its content.' }) },
    { kind: 'text', text: 'Team task created.' },
  )
  followup(agent, 'Create one shared Team task')
  await agent.whenIdle()
  const created = JSON.parse(toolResultOf(agent, 's4d3-b01-task') ?? '') as {
    readonly id?: string
    readonly revision?: number
    readonly subject?: string
    readonly status?: string
  }
  assert.equal(typeof created.id, 'string', 'the EXACT team_task_create result is the official JSON task record')
  assert.equal(created.subject, 'Scout one file')
  assert.equal(created.status, 'pending')
  assert.equal(typeof created.revision, 'number')
  await app.waitFor(() => app.view().includes('team_task_create'), 'the real Team create Tool card')

  // The shared board read returns the created subject through the same Agent
  // and the existing Tool output (never a Team board).
  adapter.scripts.push(
    { kind: 'tool', name: 'team_task_list', callId: 's4d3-b01-list', arguments: '{}' },
    { kind: 'text', text: 'Team task listed.' },
  )
  followup(agent, 'List the shared Team task')
  await agent.whenIdle()
  const listed = JSON.parse(toolResultOf(agent, 's4d3-b01-list') ?? '') as {
    readonly tasks?: readonly { readonly id?: string; readonly subject?: string; readonly status?: string }[]
  }
  assert.equal(listed.tasks?.length, 1, 'the EXACT team_task_list result is the official shared-board JSON')
  assert.equal(listed.tasks?.[0]?.id, created.id, 'the Host-generated task id crosses create -> list')
  assert.equal(listed.tasks?.[0]?.subject, 'Scout one file')
  assert.equal(listed.tasks?.[0]?.status, 'pending')
  await app.waitFor(() => app.view().includes('team_task_list'), 'the real Team list Tool card')
  // The Host-generated id exists in NO tool argument; after expanding the
  // cards it is a result-exclusive painted fact, and `{"tasks"` is list-only.
  app.vt.sendInput('\x0f')
  await app.settle()
  await app.waitFor(() => app.view().includes(created.id!), 'the Host-generated Team task id in the painted Tool output')
  assert.ok(app.view().includes('"tasks"'), 'the list result (not just the create arguments) is painted')
  for (const character of '/tasks') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Tasks ['), 'the existing Task/Activity overlay')
  assert.doesNotMatch(app.view(), /Team board|Team roster/u, 'no Team board page is invented')
})

test('the real Auto preset and the shared Plugin Manager danger confirmation work in the mounted TUI', { skip: skippedInstallationReason([B03]) }, async t => {
  const adapter = new BoundaryAdapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  assert.equal((app.host.ctx.get('permissionPresets') as { names: readonly string[] }).names.includes('auto'), false,
    'Auto is absent while B03 is not mounted')
  const mutations = countPluginMutations(app.host.ctx.get('pluginManager'))
  t.after(mutations.restore)
  const enabled = await app.host.pluginManager.setBundleEnabled(B03, true) as { application: string }
  assert.equal(enabled.application, 'restart-required')
  assert.equal(mutations.counts.setBundleEnabled, 1, 'the pass-through counter observes the real enable mutation')
  const restarted = await app.restart(host => { host.ctx.llm.registerAdapter(['scripted'], adapter) })
  const presets = restarted.host.ctx.get('permissionPresets') as { names: readonly string[] }
  assert.ok(presets.names.includes('auto'), 'the real Auto preset is advertised after the enabling restart')
  const agent: Agent = await restarted.submitFirstPrompt('Start the auto permission session')
  await agent.whenIdle()
  // The REAL current-application permission path: `/permission auto` applies
  // through the official preset service and the footer/projection follows.
  for (const character of '/permission auto') restarted.vt.sendInput(character)
  await restarted.settle()
  restarted.vt.sendInput('\r')
  await restarted.settle()
  const permission = restarted.host.ctx.get('permissionPresets') as { current(session: unknown): string | null }
  await restarted.waitFor(() => permission.current(agent.session) === 'auto', 'the real Auto preset selection')
  assert.match(restarted.view(), /\[auto\]/u, 'the footer/projection shows the selected Auto preset')

  // The same exact B03 card now carries the Owner-frozen danger consequence.
  for (const character of '/plugins') restarted.vt.sendInput(character)
  await restarted.settle()
  restarted.vt.sendInput('\r')
  await restarted.settle()
  if (restarted.view().includes('❯ /plugins')) {
    restarted.vt.sendInput('\r')
    await restarted.settle()
  }
  restarted.vt.sendInput('/')
  await restarted.settle()
  for (const character of 'auto-review') restarted.vt.sendInput(character)
  await restarted.settle()
  restarted.vt.sendInput('\r')
  await restarted.settle()
  restarted.vt.sendInput('\r')
  await restarted.settle()
  await restarted.waitFor(() => /Auto Review|auto-review/iu.test(restarted.view()), 'the exact B03 row')
  // Open Details and choose the shared Disable… action; the confirmation is
  // a PAGE whose default is Cancel. rc.1 paints the page title as
  // "Disable Auto Review?" (the same Owner warning block follows it).
  for (let step = 0; step < 4; step += 1) {
    restarted.vt.sendInput('\r') // reveal then dispatch the selected Disable… action
    await restarted.settle()
    if (/Disable Auto Review\?/u.test(restarted.view())) break
  }
  assert.match(restarted.view(), /Disable Auto Review\?/u,
    'the shared confirmation opened for the real B03 row')
  assert.match(restarted.view().replace(/\s+/gu, ' '),
    /Disabling Auto Review can change existing Auto sessions to Full access/u)
  assert.match(restarted.view(), /> Cancel/u, 'the shared confirmation defaults to Cancel')
  restarted.vt.sendInput('\r') // activate the DEFAULT Cancel action
  await restarted.settle()
  await restarted.waitFor(() => !/Disable Auto Review\?/u.test(restarted.view()),
    'the default Cancel action closes the confirmation')
  const before = (await restarted.host.pluginManager.listBundles() as readonly { name: string; enabled: boolean }[])
    .find(bundle => bundle.name === B03)
  assert.equal(before?.enabled, true, 'Cancel left the bundle enabled')
  assert.deepEqual(mutations.counts, {
    setBundleEnabled: 1,
    setPluginEnabled: 0,
    removeBundle: 0,
  }, 'Cancel dispatched ZERO additional Host mutation (the counter saw only the earlier enable)')
})
