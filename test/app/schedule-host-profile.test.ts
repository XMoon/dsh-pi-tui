/**
 * S5-PR4 L5: the Host Schedule domain through a REAL profile boot.
 *
 * The fixture provisions the production composition of THIS checkout — the
 * official `@deepseek-ai/dsh-base` bundle layer plus this bundle's own
 * `cordis.patch.yml` (and its generated preset mirrors) — through the official
 * `boot()` Loader, then exercises the official Host Schedule domain: exactly one
 * `schedule`/`sessionController`/`fileUploads`/`connection` row, a `new_once`
 * target whose reserved Session is created by the official Session controller,
 * the delivery receipt, the persisted `{source:{kind:'schedule'}}` inbox message
 * read back through real Session persistence, an existing cold Session target,
 * and the post-commit `schedule/changed` notification.
 *
 * The ONE deliberate fixture deviation: the TUI surface admission gate
 * (`tui-startup` + `tui-app`) is stood down so the Host rows mount headlessly;
 * every Host row keeps its production package and config. No fake Context, no
 * mocked Schedule service, no hand-built Schedule instance.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-host-profile.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { boot, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import type { ScheduleCatalogEntry, ScheduleService } from '@deepseek-ai/dsh-schedule'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { DirectSchedulePort, type DirectScheduleHostContext } from '../../src/runtime/direct/schedule-direct.ts'
import { ScheduleWorkspaceController } from '../../src/app/schedule/workspace-controller.ts'
import type { SessionReader } from '../../src/runtime/session-reader-port.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const TUI_BUNDLE = '@xmoon76/dsh-pi-tui'

/** The headless Host overlay: the whole real profile, with only the TUI
 *  surface admission gate stood down. */
const HEADLESS_HOST_PATCHES = [
  { id: 'hmr', disabled: true },
  { id: 'tui-startup', disabled: true },
  { id: 'tui-app', disabled: true },
  { id: 'pi-tui-extension-host', disabled: true },
  { id: 'pi-tui-builtins', disabled: true },
  { id: 'pi-tui-performance-host', disabled: true },
  { id: 'pi-tui-visual-tools', disabled: true },
  { id: 'pi-tui-web-preferences', disabled: true },
  { id: 'workspace-files', inject: [] },
  { id: 'webserver', inject: [] },
  { id: 'workspace-controller', inject: [] },
  { id: 'pi-tui-schedule', inject: ['sessionController'] },
  { id: 'pi-tui-direct-connection', inject: ['credentials', 'webServer'] },
  { id: 'pi-tui-direct-file-upload', inject: ['agents', 'attachments', 'commands', 'connection'] },
  {
    id: 'pi-tui-direct-session-controller',
    inject: [
      'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm', 'remoteAccess',
      'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'typertGateway', 'workspaceRegistry',
    ],
  },
]

interface BootedHost {
  readonly ctx: Context
  readonly workRoot: string
  dispose(): Promise<void>
}

/** Provision one profile over THIS checkout and boot it through the real Loader. */
async function bootHost(root: string): Promise<BootedHost> {
  const profileDir = join(root, 'profile')
  const installationDir = join(root, 'installation')
  // One flat installation tree over THIS checkout's own dependency graph: the
  // packages the root declares directly plus the hoisted virtual store. The
  // profile links it exactly like a real `dsh plugin add` installation.
  const nodeModules = join(installationDir, 'node_modules')
  const familyDir = join(nodeModules, '@deepseek-ai')
  mkdirSync(familyDir, { recursive: true })
  mkdirSync(join(nodeModules, '@xmoon76'), { recursive: true })
  for (const source of [
    join(REPO_ROOT, 'node_modules', '@deepseek-ai'),
    join(REPO_ROOT, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai'),
  ]) {
    for (const name of readdirSync(source)) {
      const target = join(familyDir, name)
      if (existsSync(target)) continue
      symlinkSync(realpathSync(join(source, name)), target, 'dir')
    }
  }
  if (!existsSync(join(nodeModules, TUI_BUNDLE))) symlinkSync(REPO_ROOT, join(nodeModules, TUI_BUNDLE), 'dir')
  writeFileSync(join(installationDir, 'package.json'), JSON.stringify({ name: 'schedule-host-profile-installation', private: true }, null, 2))
  mkdirSync(profileDir, { recursive: true })
  if (!existsSync(join(profileDir, 'node_modules'))) symlinkSync(nodeModules, join(profileDir, 'node_modules'), 'dir')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'schedule-host-profile',
    private: true,
    dsh: { profile: { bundles: [BASE_BUNDLE, TUI_BUNDLE] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const installationManifest = join(installationDir, 'package.json')
  const profile = loadProfileDirectory('dsh', profileDir, installationManifest)
  assert.deepEqual(profile.skippedBundles, [], 'the real profile must compose both bundle layers')
  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...HEADLESS_HOST_PATCHES,
  ]
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const workRoot = join(root, 'work')
  mkdirSync(workRoot, { recursive: true })
  const previousHome = process.env.DSH_HOME
  const previousUserHome = process.env.HOME
  process.env.DSH_HOME = home
  process.env.HOME = home
  try {
    const ctx = await boot('dsh', join(profileDir, 'cordis.yml'), patches, hostCtx => {
      hostCtx.provide('profileContext', {
        name: 'schedule-host-profile',
        dir: profileDir,
        patchPath: join(profileDir, 'cordis.patch.yml'),
        installAnchor: installationManifest,
        cwd: workRoot,
        home,
        startedBundles: profile.layers.map(layer => layer.packageName),
        overlays: [],
        telemetryDisabledEnv: undefined,
      })
      hostCtx.provide('cmdlineArgs', [])
    }, pathToFileURL(installationManifest).href)
    return {
      ctx,
      workRoot,
      dispose: async () => { await ctx.fiber.dispose() },
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousUserHome === undefined) delete process.env.HOME
    else process.env.HOME = previousUserHome
  }
}

function rowIds(ctx: Context): string[] {
  const loader = ctx.get('loader') as unknown as { readonly store?: Record<string, unknown> }
  const ids: string[] = []
  const seen = new Set<unknown>()
  const walk = (tree: unknown): void => {
    if (tree === null || typeof tree !== 'object' || seen.has(tree)) return
    seen.add(tree)
    const store = (tree as { readonly store?: Record<string, unknown> }).store
    if (store === undefined) return
    for (const entry of Object.values(store)) {
      const id = (entry as { readonly options?: { readonly id?: unknown } }).options?.id
      if (typeof id === 'string') ids.push(id)
      walk((entry as { readonly subtree?: unknown }).subtree)
    }
  }
  walk(loader)
  return ids
}

function scheduledInboxMessages(events: readonly unknown[], receiptId: string): Array<{ readonly id: string; readonly text: string }> {
  const describe = (message: { readonly id: unknown; readonly content?: readonly unknown[] }): { readonly id: string; readonly text: string } => ({
    id: String(message.id),
    text: (message.content ?? [])
      .map(part => (typeof (part as { readonly text?: unknown }).text === 'string' ? (part as { readonly text: string }).text : ''))
      .join(''),
  })
  const scheduled = (source: unknown): boolean =>
    (source as { readonly kind?: unknown } | undefined)?.kind === 'schedule'
  const out: Array<{ readonly id: string; readonly text: string }> = []
  for (const rawEvent of events) {
    const event = rawEvent as {
      readonly type?: unknown
      readonly data?: { readonly inserted?: readonly ({ readonly id: unknown; readonly source?: unknown; readonly content?: readonly unknown[] } | undefined)[] }
    }
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data?.inserted ?? []) {
      if (message !== undefined && scheduled(message.source) && String(message.id) === receiptId) {
        out.push(describe(message))
      }
    }
  }
  return out
}

async function scheduleMessages(
  persistence: SessionPersistence,
  sessionId: string,
  receiptId: string,
): Promise<Array<{ readonly id: string; readonly text: string }>> {
  const handle = await persistence.open(sessionId as Parameters<SessionPersistence['open']>[0], 'read')
  try {
    const { events } = await handle.read()
    return scheduledInboxMessages(events, receiptId)
  } finally {
    await handle.close()
  }
}

test('the Schedule receipt observer counts inbox insertions, not later message consumption', () => {
  const message = { id: 'receipt-1', source: { kind: 'schedule' }, content: [{ type: 'text', text: PROMPT }] }
  const consumed = scheduledInboxMessages([
    { type: 'agent/inbox/spliced', data: { inserted: [message] } },
    { type: 'user/message', data: message },
  ], 'receipt-1')
  assert.equal(consumed.length, 1, 'later consumption of the same receipt identity is not another inbox insertion')

  const duplicateInsertions = scheduledInboxMessages([
    { type: 'agent/inbox/spliced', data: { inserted: [message] } },
    { type: 'agent/inbox/spliced', data: { inserted: [message] } },
  ], 'receipt-1')
  assert.equal(duplicateInsertions.length, 2, 'two actual inbox insertions of one receipt identity remain visible')
})

const PROMPT = 'schedule host profile probe'

test('L5: the real profile mounts ONE Host Schedule closure and delivers through it', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir("schedule-host-profile")
  const host = await bootHost(root)
  life.defer(() => host.dispose())

  const ids = rowIds(host.ctx)
  const count = (id: string): number => ids.filter(candidate => candidate === id).length
  assert.equal(count('pi-tui-schedule'), 1, 'exactly one Host Schedule row')
  assert.equal(count('pi-tui-direct-session-controller'), 1, 'exactly one Direct Session controller row')
  assert.equal(count('pi-tui-direct-file-upload'), 1, 'exactly one Direct FileUploads row')
  assert.equal(count('pi-tui-direct-connection'), 1, 'exactly one Direct Connection row')
  assert.equal(count('split-host-session-controller'), 0, 'a Direct Host mounts no split Session controller')

  const schedule = host.ctx.get('schedule') as unknown as ScheduleService
  const controller = host.ctx.get('sessionController') as unknown as SessionController
  const persistence = host.ctx.get('sessionPersistence') as unknown as SessionPersistence
  assert.ok(schedule !== undefined, 'the official Host Schedule service is live')
  assert.ok(controller !== undefined, 'the official Host Session controller is live')
  assert.ok(host.ctx.get('fileUploads') !== undefined, 'the official FileUploads service is live')
  assert.ok(host.ctx.get('connection') !== undefined, 'the official Host Connection is live')
  assert.deepEqual(schedule.deliveryLimits(), { newSessionIntervalSeconds: 60 })

  const changes: number[] = []
  const unsubscribe = host.ctx.on('schedule/changed', () => { changes.push(Date.now()) })

  const created = await schedule.remoteCreate({
    title: 'host profile new_once',
    prompt: PROMPT,
    timing: { kind: 'after', after_seconds: 60 },
    target: { kind: 'new_once' },
  })
  assert.equal(created.status, 'active')
  assert.equal(created.target.kind, 'new_once')
  const reservedSessionId = (created.target as { readonly sessionId: string }).sessionId
  assert.ok(changes.length >= 1, 'the durable create committed the official schedule/changed notification')

  const ran = await schedule.run({ id: created.id })
  assert.equal('code' in ran, false, 'the manual run was admitted')
  const delivered = ran as ScheduleCatalogEntry
  assert.ok(delivered.lastDelivery !== undefined, 'the Host acknowledged a durable inbox delivery')
  assert.equal(delivered.target.kind, 'session', 'the first delivery created the reserved Session')
  assert.equal((delivered.target as { readonly sessionId: string }).sessionId, reservedSessionId)
  assert.equal(delivered.lastDelivery?.targetSessionId, reservedSessionId)
  assert.equal(delivered.lastDelivery?.messageId !== undefined, true)

  const messages = await scheduleMessages(persistence, reservedSessionId, delivered.lastDelivery!.messageId!)
  const delivery = messages.filter(message => message.id === delivered.lastDelivery?.messageId)
  assert.equal(delivery.length, 1, 'the persisted inbox message carries the receipt identity')
  assert.match(delivery[0].text, /schedule host profile probe/u, 'the persisted message is the delivered prompt')

  // An existing (cold) Session target delivers through the same official route.
  const plain = await controller.create({})
  const existing = await schedule.remoteCreate({
    title: 'host profile cold session',
    prompt: PROMPT,
    timing: { kind: 'after', after_seconds: 60 },
    target: { kind: 'session', sessionId: plain.sessionId as never },
  })
  const ranExisting = await schedule.run({ id: existing.id })
  assert.equal('code' in ranExisting, false)
  const existingDelivery = (ranExisting as ScheduleCatalogEntry).lastDelivery
  assert.equal(existingDelivery?.targetSessionId, plain.sessionId)
  const existingMessages = await scheduleMessages(persistence, plain.sessionId, existingDelivery!.messageId!)
  assert.equal(
    existingMessages.filter(message => message.id === existingDelivery?.messageId).length,
    1,
    'the chosen cold Session durably accepted the message',
  )

  const history = await schedule.remoteHistory({ id: created.id, limit: 20 })
  assert.ok('records' in history, 'the delivery history page read back')
  assert.equal(history.records.length, 1)
  assert.equal(history.records[0].prompt, PROMPT, 'the receipt carries the sent prompt')

  const beforeDelete = changes.length
  await schedule.remoteEdit({ id: existing.id, action: 'delete' })
  assert.equal(changes.length > beforeDelete, true, 'a later commit still notifies while subscribed')
  unsubscribe()
  const settled = changes.length
  const extra = await schedule.remoteCreate({
    title: 'host profile unsubscribed',
    prompt: PROMPT,
    timing: { kind: 'after', after_seconds: 60 },
    target: { kind: 'new_once' },
  })
  await schedule.remoteEdit({ id: extra.id, action: 'delete' })
  assert.equal(changes.length, settled, 'the unsubscribed listener never hears another commit')
  const afterDelete = await schedule.view({ id: existing.id })
  assert.equal('code' in afterDelete, true, 'the deleted task is really gone')
})

/** A bounded observation of one authoritative fact: the assertion fails with
 *  the last observed state instead of passing on a blind sleep. */
async function waitUntil(
  probe: () => Promise<boolean> | boolean,
  label: string,
  deadlineMs = 120_000,
): Promise<void> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < deadlineMs) {
    try {
      if (await probe()) return
    } catch (error) {
      lastError = error
    }
    // bounded observation window: the Host timer is real elapsed time, so the
    // probe is polled until its deadline instead of sleeping for a fixed guess.
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} did not settle within ${deadlineMs}ms${lastError === undefined ? '' : `: ${String(lastError)}`}`)
}

/** The chooser-only Session reader the controller needs beside the REAL port;
 *  it exposes no second task/Session authority. */
const CHOOSER_SESSIONS: SessionReader = {
  list: async () => [],
  projectionBatch: async () => new Map(),
  search: async () => undefined,
  blank: () => undefined,
  measureContext: () => undefined,
  turnOutline: () => undefined,
  sessionStatus: () => undefined,
}

test('L5: the real DirectSchedulePort drives the controller end to end', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('schedule-host-controller')
  const host = await bootHost(root)
  life.defer(() => host.dispose())

  const port = new DirectSchedulePort({
    get: (name: string) => host.ctx.get(name),
    on: (event, listener) => host.ctx.on(event, listener),
  } satisfies DirectScheduleHostContext)
  const hostSchedule = host.ctx.get('schedule') as unknown as ScheduleService
  const controller = new ScheduleWorkspaceController({
    port,
    sessionReader: CHOOSER_SESSIONS,
    runOwned: (_label, task) => { void task() },
  })
  life.defer(() => controller.dispose())
  controller.open()
  await waitUntil(() => controller.snapshot().status === 'ready', 'the first authoritative read')

  // Create through the REAL port + controller seam (not a fake Port).
  controller.dispatch({ kind: 'open-create' })
  controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'controller host task' })
  controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'controller host prompt' })
  controller.dispatch({ kind: 'save' })
  await controller.whenIdle()
  await waitUntil(() => controller.snapshot().mode === 'detail' && controller.snapshot().detail !== undefined, 'the created task detail')
  const created = controller.snapshot().detail
  assert.ok(created !== undefined)
  const hostRows = await hostSchedule.catalog()
  const persisted = hostRows.find(entry => entry.id === created.id)
  assert.ok(persisted !== undefined, 'the controller create really landed in the Host task store')
  assert.equal(persisted.kind, 'after')
  assert.equal(persisted.kind === 'after' ? persisted.afterSeconds : undefined, 3600,
    'the new-task default is one hour after Host acceptance')

  // Edit through the controller: one CAS update on the revision the detail read.
  controller.dispatch({ kind: 'open-edit' })
  await waitUntil(() => controller.snapshot().mode === 'editor', 'the editor')
  controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'controller host task renamed' })
  controller.dispatch({ kind: 'save' })
  await controller.whenIdle()
  await waitUntil(() => controller.snapshot().detail?.title === 'controller host task renamed', 'the edited title readback')
  const edited = await hostSchedule.view({ id: persisted.id })
  assert.equal('code' in edited, false)
  assert.equal((edited as ScheduleCatalogEntry).title, 'controller host task renamed')

  // The `new` target creates a FRESH Session for each delivery.
  const newTarget = await hostSchedule.remoteCreate({
    title: 'controller new target',
    prompt: PROMPT,
    timing: { kind: 'after', after_seconds: 60 },
    target: { kind: 'new' },
  })
  const ranNew = await hostSchedule.run({ id: newTarget.id })
  assert.equal('code' in ranNew, false)
  const newDelivery = (ranNew as ScheduleCatalogEntry).lastDelivery
  assert.ok(newDelivery !== undefined, 'the `new` target delivered')
  assert.equal((ranNew as ScheduleCatalogEntry).target.kind, 'new')
  const deliveredNew = await scheduleMessages(host.ctx.get('sessionPersistence') as unknown as SessionPersistence, newDelivery.targetSessionId, newDelivery.messageId)
  assert.ok(deliveredNew.some(message => message.id === newDelivery.messageId),
    'the Session created by the `new` target durably accepted the message')
})

test('L5: a durable task survives a Host restart with its committed occurrence', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('schedule-host-restart')
  const first = await bootHost(root)
  const firstSchedule = first.ctx.get('schedule') as unknown as ScheduleService
  const created = await firstSchedule.remoteCreate({
    title: 'restart one-shot',
    prompt: PROMPT,
    timing: { kind: 'after', after_seconds: 3600 },
    target: { kind: 'new_once' },
  })
  await first.dispose()

  const second = await bootHost(root)
  life.defer(() => second.dispose())
  const schedule = second.ctx.get('schedule') as unknown as ScheduleService
  const catalog = await schedule.catalog()
  const persisted = catalog.find(entry => entry.id === created.id)
  assert.ok(persisted !== undefined, 'the durable task survived the Host restart')
  assert.equal(persisted.scheduledAt, created.scheduledAt, 'the committed occurrence is stable across the restart')
  assert.equal(catalog.filter(entry => entry.id === created.id).length, 1, 'the restart mounted no duplicate task')

  // The due-instant timer/DST semantics are qualified with the OFFICIAL injected
  // clock in `test/runtime/direct/schedule-timing.test.ts` (the same real
  // ScheduleService over real storage, exactly like the upstream suite); this
  // test proves the real PROFILE composition and its durable restart.
})
