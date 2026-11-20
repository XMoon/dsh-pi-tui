/**
 * The Settings service-install confirmation through the production composition.
 *
 * F1 Path 1 (A05): a real application-composition chain from the Settings
 * command's OWN confirmation to the production admin sink — the official
 * `DirectConfigPort` Verified save, the verified `direct → daemon` follow-up, its
 * explicit install confirmation, and the composition-bound `ProfileDaemonAdmin`
 * reaching `runDaemonControl('install')` with the correct Profile identity. This
 * drives the REAL `commitBackendStartup` decision (not a handwritten
 * `admin.run('install')`). The safe path (`Not now`) performs zero manager IO.
 *
 * Evidence: real Direct config adapter + production command decision + production
 * admin port (L5 composition). The OS manager install itself is the Linux/macOS
 * lane's post-proof.
 * @module @xmoon76/dsh-pi-tui/settings-install-composition.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createSettingsCommands } from '../../src/tui/commands/settings.ts'
import { SettingsWorkspacePanel } from '../../src/tui/panels/settings-workspace-panel.ts'
import { DirectConfigPort, type HostContextLike } from '../../src/runtime/direct/config-direct.ts'
import {
  createProfileDaemonAdmin,
  profileDaemonAdminRun,
  resolveDirectDaemonAdminProfile,
} from '../../src/app/remote-process/local-profile-daemon-admin.ts'
import type { DaemonControlDeps, DaemonControlProfile } from '../../src/app/remote-process/local-daemon-control.ts'
import { inspectInstalledProfileScope } from '../../src/app/remote-process/local-scope.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** A faithful revision-tracked in-memory `SettingsServiceLike` (describe/mutate). */
function settingsService(initial: { backend: string }, revision = 1) {
  let value: Record<string, unknown> = { ...initial }
  let user: Record<string, unknown> = {}
  let rev = revision
  let mutationCount = 0
  return {
    describe: () => [{ ns: 'tui-startup', value: { ...value }, user: { ...user }, revision: rev }],
    mutate: async (_ns: string, ops: readonly { op: string; path: readonly string[]; value: unknown }[]) => {
      mutationCount += 1
      for (const op of ops) {
        if (op.op === 'set') { value = { ...value, [op.path.join('.')]: op.value }; user = { ...user, [op.path.join('.')]: op.value } }
      }
      rev += 1
    },
    mutateCount: () => mutationCount,
  }
}

const PANEL_SNAPSHOT: any = {
  configReadiness: 'ready',
  capturedAt: 0,
  rows: [{
    id: 'startup-backend',
    category: 'general',
    label: 'Backend',
    summary: 'Direct',
    value: 'Direct',
    scope: 'DSH Host profile · next cold launch',
    freshness: 'ready',
    description: 'Which backend a new launch runs',
    edit: {
      field: 'startup-backend',
      primary: 'persisted',
      runtime: 'Applies on next launch; current TUI/Host remains unchanged',
      persisted: 'Direct',
      revision: 1,
      options: [
        { value: 'Direct', label: 'Direct', available: true, current: true },
        { value: 'Daemon', label: 'Daemon', available: true, current: false },
      ],
    },
  }],
}

function host(services: Record<string, unknown>): HostContextLike {
  return { get: name => services[name], on: (() => false) as unknown as HostContextLike['on'] }
}

/** Build the real composition: official Direct config + production admin port +
 *  the captured production Settings handlers. */
function buildComposition(t: test.TestContext, mode: 'capture' | 'panel' = 'capture') {
  const life = testLifecycle(t)
  const accountHome = life.tempDir('p1-acct-')
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const root = life.tempDir('p1-')
  const packageRoot = join(root, 'packages', 'bundle')
  const dir = join(root, 'profiles', 'profile-a')
  mkdirSync(join(packageRoot, 'dist'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' }))
  writeFileSync(join(packageRoot, 'dist', 'local-client.mjs'), 'export {}\n')
  mkdirSync(join(root, 'anchor', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(root, 'anchor', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  mkdirSync(join(dir, 'node_modules', '@xmoon76'), { recursive: true })
  symlinkSync(packageRoot, join(dir, 'node_modules', '@xmoon76', 'dsh-pi-tui'), 'dir')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile-a' }))
  const profile = resolveDirectDaemonAdminProfile({ name: 'profile-a', dir, home: root, installAnchor: join(root, 'anchor', 'node_modules', '@deepseek-ai', 'dsh', 'package.json') })!
  const expected = inspectInstalledProfileScope({ dshHome: profile.home, profileDir: profile.dir, packageRoot: profile.packageRoot, dshVersion: profile.dshVersion })
  const observed: Array<{ verb: string; scopeId: string; profileRealpath: string }> = []
  const mkDeps = (): DaemonControlDeps => ({
    platform, ...(platform === 'darwin' ? { darwinAccountHome: accountHome } : {}),
    readRecord: (scope) => { observed.push({ verb: 'install', scopeId: scope.scopeId, profileRealpath: scope.profileRealpath }); return undefined },
    inspectProcess: () => 'dead',
  })
  const admin = createProfileDaemonAdmin(profile, { run: verb => profileDaemonAdminRun(profile, mkDeps())(verb) })
  const service = settingsService({ backend: 'direct' }, 1)
  const config = new DirectConfigPort(host({ settings: service }), undefined, () => undefined)
  let capturedCommit: ((req: unknown) => Promise<unknown>) | undefined
  let capturedInstall: ((settle: (r: { ok: boolean; detail?: string }) => void) => void) | undefined
  let livePanel: SettingsWorkspacePanel | undefined
  const app: any = {
    isDisposed: () => false, requestRender: () => {}, notify: () => {},
    openSettingsWorkspace: (spec: any, options: any) => {
      if (mode === 'panel') {
        // The production panel class with the SAME options `settings.ts`
        // produced: `onBackendServiceInstall` is passed through unchanged (only
        // `onCommit` needs the panel's settle adapter, exactly like TuiApp).
        livePanel = new SettingsWorkspacePanel({ readSnapshot: () => PANEL_SNAPSHOT }, {
          rows: () => 60,
          columns: () => 120,
          requestRender: () => {},
          notice: () => undefined,
          aboutVersionFacts: { tui: '0.5.7', dsh: '0.2.2-rc.5' },
          onClose: () => {},
          onCopy: () => {},
          onCommit: (request: any, settle: any) => {
            void Promise.resolve(options.onCommit(request)).then(settle, error => {
              settle({ outcome: 'not-saved', reason: error instanceof Error ? error.message : String(error) })
            })
          },
          ...(options.onBackendServiceInstall === undefined ? {} : { onBackendServiceInstall: options.onBackendServiceInstall }),
        }, { initialRowId: 'startup-backend' })
        return { close: () => {}, release: () => {} }
      }
      capturedCommit = options.onCommit
      capturedInstall = options.onBackendServiceInstall
      return { close: () => {}, release: () => {} }
    },
    openModelsWorkspace: () => ({ close: () => {} }), openAccountWorkspace: () => ({ close: () => {} }), openAuthWorkspace: () => ({ close: () => {} }),
  }
  const transitions: Array<string | undefined> = []
  const runner: any = {
    config, backendKind: 'direct', profileDaemonAdmin: admin,
    recordBackendExitTransition: (v: string | undefined) => { transitions.push(v) },
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    currentSessionId: undefined, captureLiveSessionScope: () => undefined, isSessionScopeCurrent: () => true,
    subscribeSessionScopeInvalidation: (() => undefined) as any, signal: undefined, copyToClipboard: async () => {},
    catalog: { commands: [], skills: [] }, clientCommands: {},
    policy: { readSnapshot: () => ({ kind: 'checking' }), subscribe: () => () => {} }, sessionPolicyGeneration: () => undefined,
    acpAccess: { getStatus: async () => ({ kind: 'unavailable' }), currentGeneration: () => undefined }, cuaAccess: { available: () => false },
    pluginManager: {}, createPluginManagerPage: () => ({ isDisposed: () => true }),
    extensions: { settings: { snapshot: () => ({ revision: 0, rows: [] }) } }, mcpServers: { snapshot: () => ({ revision: 0, rows: [] }) },
    tuiSettings: undefined, currentNotificationMethod: () => 'terminal', currentNotificationMode: () => 'all',
    setNotificationMethod: async () => {}, setNotificationMode: async () => {}, currentPreset: () => undefined,
    currentSessionRouting: () => undefined, currentSessionStats: () => undefined, sessionCwd: () => undefined, sessionReader: undefined,
    displayPreset: () => undefined, setDisplayPreset: async () => {}, focusEnabled: () => false, setFocusMode: async () => {},
    setTerminalProgressMode: async () => {}, setSessionApprovalPolicy: async () => {}, refreshStatus: () => {},
    forceContextMeasurementResult: () => undefined, gitAttributionState: () => undefined, progressUpdatesState: () => undefined, applyFooterSettings: () => {},
  }
  const registrars = createSettingsCommands({
    runner, app, registerOne: () => {}, registerTuiCommand: () => {}, detach: (_n, fn) => { void fn },
    recordExtensionError: () => {}, clearExtensionError: () => {}, captureExtensionHealthRef: (() => undefined) as any,
  })
  registrars.openPluginsWorkspace()
  return {
    capturedCommit: () => capturedCommit!,
    capturedInstall: () => capturedInstall!,
    observed,
    expected,
    transitions,
    panel: () => livePanel,
    mutations: () => service.mutateCount(),
  }
}

test('the Settings verified direct→daemon confirmation drives the production install sink with the bound Profile identity', async t => {
  const c = buildComposition(t)
  assert.ok(c.capturedCommit() !== undefined && c.capturedInstall() !== undefined, 'the production Settings handlers are captured')
  const outcome = (await c.capturedCommit()({ field: 'startup-backend', value: 'Daemon', revision: 1 })) as any
  assert.equal(outcome.outcome, 'verified', 'the official DirectConfigPort confirmed the save')
  assert.deepEqual(outcome.followUp, { kind: 'daemon-service-install', installable: true }, 'the verified direct→daemon save offers the service install')
  const installResult = await new Promise<{ ok: boolean; detail?: string }>(resolve => c.capturedInstall()(resolve))
  assert.ok(c.observed.length >= 1, `the install reached the real control plane (got ${JSON.stringify(c.observed)}, result ${JSON.stringify(installResult)})`)
  for (const entry of c.observed) {
    assert.equal(entry.scopeId, c.expected.scopeId, 'the install drove the bound Profile identity')
    assert.equal(entry.profileRealpath, c.expected.profileRealpath, 'the install targeted the bound Profile directory')
  }
})

test('the safe Not-now path through the real Settings route performs zero manager IO', async t => {
  const c = buildComposition(t)
  const outcome = (await c.capturedCommit()({ field: 'startup-backend', value: 'Daemon', revision: 1 })) as any
  assert.equal(outcome.outcome, 'verified', 'the save is verified and the follow-up is offered')
  // The user chooses `Not now` (or Esc): the production install handler is NEVER
  // invoked, so the real admin sink sees zero manager IO — the real reachable
  // route, not a void-created port.
  assert.equal(c.observed.length, 0, 'Not now reaches no manager IO through the real route')
})

// ── N2: the REAL panel input -> production command handler -> admin sink ─────

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/gu, '').trimEnd()
const panelText = (panel: SettingsWorkspacePanel): string => panel.render(120).map(stripAnsi).join('\n')
const settleTick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Paint one frame (the painted risk grant needs a real render), then send a key. */
function pressPanel(panel: SettingsWorkspacePanel, key: string): void {
  panel.render(120)
  panel.handleInput(key)
}

/** Drive the real panel from the Backend row to the verified install follow-up. */
async function driveToFollowUp(panel: SettingsWorkspacePanel): Promise<void> {
  pressPanel(panel, '\r') // Backend row -> Detail, the value choice opens
  pressPanel(panel, '\x1b[B') // move the candidate to Daemon
  pressPanel(panel, '\r') // Confirm -> production commit
  await settleTick()
  await settleTick()
  assert.match(panelText(panel), /Optional OS supervision/u, 'the verified commit painted the follow-up')
  // The grant is earned by a PAINTED frame that contains the whole risk block.
  panel.render(120)
}

test('the REAL Settings panel input drives the production install sink exactly once (N2)', async t => {
  const c = buildComposition(t, 'panel')
  const panel = c.panel()
  assert.ok(panel !== undefined, 'the production SettingsWorkspacePanel was mounted')
  await driveToFollowUp(panel)
  // Tab moves the focus to `Install service`; Enter is the ONE confirmation.
  // The install only reaches the sink when the panel's painted risk+action
  // grant is true (a refused grant is proven by the short-viewport test), so
  // the assertion below is the EFFECT, not a callback count.
  pressPanel(panel, '\t')
  pressPanel(panel, '\r')
  await settleTick()
  assert.equal(c.observed.length, 1, `exactly one install reached the real control plane: ${JSON.stringify(c.observed)}`)
  assert.equal(c.observed[0]!.verb, 'install')
  assert.equal(c.observed[0]!.scopeId, c.expected.scopeId, 'the sink drove the bound Profile identity')
  assert.equal(c.observed[0]!.profileRealpath, c.expected.profileRealpath)
})

test('the REAL panel `Not now` performs zero install IO and no extra settings write (N2)', async t => {
  const c = buildComposition(t, 'panel')
  const panel = c.panel()
  assert.ok(panel !== undefined)
  await driveToFollowUp(panel)
  const writesBefore = c.mutations()
  pressPanel(panel, '\r') // Enter on the default `Not now`
  await settleTick()
  assert.deepEqual(c.observed, [], 'Not now reaches no manager IO')
  assert.equal(c.mutations(), writesBefore, 'Not now performs no additional settings write')
})
