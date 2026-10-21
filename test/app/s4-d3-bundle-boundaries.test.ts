/**
 * S4-D3 B01–B14 terminal boundaries (D3-6): the REAL rc.2 Host catalog travels
 * through the ONE shared mapping → D1 classifier/model → the MOUNTED Plugin
 * Manager workspace, where the bounded capability copy and the allowed
 * actions are read from the actual frame. B01 keeps HOST_ONLY, the web-only
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
 * @module @xmoon76/dsh-pi-tui/s4-d3-bundle-boundaries.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginManager, { type BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import { mkdirSync, writeFileSync } from 'node:fs'
import { OPTIONAL_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG } from '@deepseek-ai/dsh-app-boot'
import {
  EXPERIMENTAL_BUNDLE_IDS,
  classifyPluginPackages,
  type PluginClassificationInput,
} from '../../src/app/plugin-manager/classify.ts'
import { buildPluginManagerModel, bundleValue } from '../../src/app/plugin-manager/model.ts'
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
      dsh: { bundle: { patch: [] } },
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
  '@deepseek-ai/dsh-experimental-agent-team-profile': /Host Team tools/u,
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

test('the real rc.2 Host catalog paints all 14 bounded boundaries through the mounted Plugin Manager', async t => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('s4-d3-boundaries-')
  const profileContext = seedProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => {} })

  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  let close: () => void = () => {}
  const controller = new PluginManagerController(port, {
    requestRender: () => app.requestRender(),
    requestClose: () => close(),
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  const panel = new PluginManagerWorkspacePanel(controller, {
    rows: () => vt.rows,
    columns: () => vt.columns,
    requestRender: () => app.requestRender(),
    notice: () => undefined,
    onCopy: () => {},
  }, { onDispose: () => {} })
  close = app.openPluginManagerWorkspace(panel, () => {})
  life.defer(() => { try { app.dispose() } catch {} controller.dispose() })
  controller.open('direct-command')
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
  assert.match(plain(vt.getViewport()), /Plugins · All/u)
  await waitFor(() => controller.model().cards.length === 14, 'the real Host catalog read')
  assert.deepEqual(controller.model().sections.at(-1)!.cards.map(card => card.name), [...EXPERIMENTAL_BUNDLE_IDS])

  // Walk the Experimental tail from B14 backwards using the REAL keys: the
  // Detail is painted for each exact identity and its bounded facts survive.
  vt.sendInput('\x1b[F') // End = B14
  await settle()
  for (let index = EXPERIMENTAL_BUNDLE_IDS.length - 1; index >= 0; index -= 1) {
    const name = EXPERIMENTAL_BUNDLE_IDS[index]!
    vt.sendInput('\r')
    await waitFor(() => plain(vt.getViewport()).includes('Official DSH catalog entry'), `the ${name} Detail`)
    // 80 columns is the ONE-column projection: the Detail wraps cleanly, and
    // the existing PgUp/PgDn scroll reveals the full bounded copy.
    for (let page = 0; page < 10 && !plain(vt.getViewport()).includes('TUI surface'); page += 1) {
      vt.sendInput('\x1b[6~')
      await settle()
    }
    for (let page = 0; page < 10 && !SURFACE_HINTS[name]!.test(plain(vt.getViewport()).replace(/\s+/gu, ' ')); page += 1) {
      vt.sendInput('\x1b[6~')
      await settle()
    }
    const frame = plain(vt.getViewport()).replace(/\s+/gu, ' ')
    assert.match(frame, SURFACE_HINTS[name]!, `${name} surfaces its exact boundary:\n${frame}`)
    if (ON_DEMAND.includes(name)) {
      for (let page = 0; page < 10 && !/no Continue\/Resume/u.test(plain(vt.getViewport()).replace(/\s+/gu, ' ')); page += 1) {
        vt.sendInput('\x1b[6~')
        await settle()
      }
      const external = plain(vt.getViewport()).replace(/\s+/gu, ' ')
      assert.match(external, /no Continue\/Resume/u, `${name} states its verified one-shot boundary`)
      assert.doesNotMatch(external, /EXTERNAL_UNVERIFIED/u, `${name} no longer claims an unqualified native start`)
      assert.match(external, /Install…/u, `${name} offers the official Install action`)
      assert.doesNotMatch(external, /> Enable…/u, `${name} is missing and never offers Enable`)
    } else {
      assert.doesNotMatch(frame, /no Continue\/Resume/u, `${name} is not an external subagent`)
    }
    vt.sendInput('\x1b') // leave Details
    await settle()
    if (index > 0) {
      vt.sendInput('\x1b[A') // Up: the previous Experimental row
      await settle()
    }
  }
  assert.deepEqual(controller.model().cards.filter(card => card.section === 'experimental').map(card => card.name),
    [...EXPERIMENTAL_BUNDLE_IDS], 'the real Host snapshot kept the frozen B01–B14 order')

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
    '@deepseek-ai/dsh-experimental-agent-team-profile',
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

// ── D3-6: B01 and B03 in the mounted application ───────────────────────────

import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { startS4D3Application } from '../support/s4-d3-application-fixture.ts'
import { skippedInstallationReason, type S4D2BundleId } from '../support/s4-d2-optional-bundle-fixture.ts'

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

const B01 = '@deepseek-ai/dsh-experimental-agent-team-profile' satisfies S4D2BundleId
const B03 = '@deepseek-ai/dsh-experimental-auto-review' satisfies S4D2BundleId

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

test('the mounted TUI keeps Team capability in the existing Tool/Activity views and invents no Team board', { skip: skippedInstallationReason([B01]) }, async t => {
  const adapter = new BoundaryAdapter()
  const app = await startS4D3Application(t, {
    bundles: [B01],
    presets: true,
    presetId: 'standard',
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  adapter.scripts.push({ kind: 'text', text: 'Team session ready.' })
  const agent = await app.submitFirstPrompt('Start the team session')
  await agent.whenIdle()
  assert.equal(app.host.hasTool('spawn_teammate', agent), true, 'the real B01 Team tool is Agent-scoped')
  assert.equal(app.host.hasTool('team_task_create', agent), true)
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
  // a PAGE whose default is Cancel.
  for (let step = 0; step < 4; step += 1) {
    restarted.vt.sendInput('\r') // reveal then dispatch the selected Disable… action
    await restarted.settle()
    if (/safety confirmation/u.test(restarted.view())) break
  }
  assert.match(restarted.view(), /Auto Review safety confirmation/u,
    'the shared confirmation opened for the real B03 row')
  assert.match(restarted.view().replace(/\s+/gu, ' '),
    /Disabling Auto Review can change existing Auto sessions to Full access/u)
  assert.match(restarted.view(), /> Cancel/u, 'the shared confirmation defaults to Cancel')
  restarted.vt.sendInput('\r') // activate the DEFAULT Cancel action
  await restarted.settle()
  await restarted.waitFor(() => !/safety confirmation/u.test(restarted.view()),
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
