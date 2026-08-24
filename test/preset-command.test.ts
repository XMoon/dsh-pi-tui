/**
 * Headless tests for the /preset command surface: the sessionless roster
 * (no session created before one exists), the one-Enter switch through the
 * SettingsList values mechanism, the blank-session recompose path, the
 * started-session refusal, and the English display copy.
 * @module @xmoon76/dsh-pi-tui/preset-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import type { CatalogRefreshOutcome, CatalogRefreshRequest } from '../src/skill-catalog-refresh.ts'
import { SESSIONLESS_COMMANDS } from '../src/index.ts'
import { createDiag } from '../src/diag.ts'
import { customThemesDir, darkColors } from '../src/theme.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — clear all three so the render paths under test stay live.
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A blank or started fake agent. */
function fakeAgent(sessionId: string, events: readonly { type: string }[] = []): Agent {
  return {
    session: { id: sessionId, header: { cwd: '/ws' }, events },
    ctx: { on: () => () => {} },
    options: { provider: 'p', model: 'm' },
  } as unknown as Agent
}

/** The four shipped rows WITH Chinese metadata, exactly as the dsh install's
 * own `config/agent-presets` ships them (the CLI's composeProfile overlay
 * makes that root the effective roster). */
const SHIPPED_ROWS = [
  { id: 'standard', name: '标准模式', description: '功能完整的编码 Agent。', trust: 'system' },
  { id: 'code', name: 'PTC 模式', description: 'Code Mode SDK。', trust: 'system' },
  { id: 'minimal', name: '极简模式', description: '双工具编码 Agent。', trust: 'system' },
  { id: 'cordis', name: '创造模式', description: '自定义 Agent preset。', trust: 'system' },
]

function presetService(rows: { id: string; name?: string; description?: string; trust?: string }[]) {
  const resolved: string[] = []
  return {
    resolved,
    service: {
      defaultId: 'standard',
      list: async () => rows.map(row => ({
        id: row.id,
        trust: row.trust ?? 'system',
        path: `/presets/${row.id}`,
        ...row.name === undefined ? {} : { name: row.name },
        ...row.description === undefined ? {} : { description: row.description },
      })),
      resolve: async (id?: string) => {
        const row = rows.find(candidate => candidate.id === id)
        if (row === undefined) throw new Error(`agent-presets: preset "${id}" not found (available: standard)`)
        resolved.push(id!)
        return { id: row.id, trust: row.trust ?? 'system', path: `/presets/${row.id}` }
      },
      composedPreset: () => undefined,
    },
  }
}

/** A fake commands service recording the registered definitions. */
function fakeCommands() {
  const defs: { name: string; handler?: unknown }[] = []
  return {
    defs,
    service: {
      register: (def: { name: string; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => [{ name: 'builtin', description: 'a builtin', input: { hint: '' } }],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** A stub runner with a MUTABLE pending preset and an optional recompose.
 * `refreshCatalog` records every request and resolves a scripted outcome
 * (a failed outcome by default, so a test that does not care about the
 * refresh still sees the preset change succeed). */
function stubRunner(options: {
  ctx: Context
  app: TuiApp
  agent: Agent | undefined
  recomposeBlank?: (id: string) => Promise<{ kind: 'switched'; preset: string } | { kind: 'locked' }>
  refreshCatalog?: (request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>
  ensureCalls?: string[]
  tuiSettings?: TuiSettingsLike
  extensions?: TuiCommandRunner['extensions']
  recordExtensionError?: (slot: string, id: string, error: unknown) => void
  clearExtensionError?: (slot: string, id: string) => void
}): { runner: TuiCommandRunner; pending: { value: string | undefined }; refreshes: CatalogRefreshRequest[] } {
  const pending = { value: undefined as string | undefined }
  const refreshes: CatalogRefreshRequest[] = []
  const runner: TuiCommandRunner = {
    ctx: options.ctx,
    app: options.app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return options.agent },
    ensureSession: async () => { options.ensureCalls?.push('ensureSession') },
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: options.tuiSettings,
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(options.ctx as never, () => undefined),
    config: new DirectConfigPort(options.ctx as never, undefined, () => undefined),
    commandRegistry: options.ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort(() => undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return pending.value },
    set pendingPreset(id: string | undefined) { pending.value = id },
    get effectivePresetId() { return pending.value },
    refreshCatalog: async (request) => {
      refreshes.push(request)
      return options.refreshCatalog?.(request) ?? { kind: 'failed', error: 'not wired in tests' }
    },
    recomposeBlank: options.recomposeBlank ?? (async () => ({ kind: 'switched', preset: 'standard' })),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: options.extensions,
    recordExtensionError: options.recordExtensionError,
    clearExtensionError: options.clearExtensionError,
    exit: () => {},
  }
  return { runner, pending, refreshes }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent: undefined as unknown as Agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

/** Register the TUI commands and return the /preset surface under test. */
function setup(options: {
  rows?: { id: string; name?: string; description?: string; trust?: string }[]
  agent?: Agent
  recomposeBlank?: (id: string) => Promise<{ kind: 'switched'; preset: string } | { kind: 'locked' }>
  refreshCatalog?: (request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>
  settings?: { get(ns: string): unknown; mutate(ns: string, patch: unknown[]): Promise<unknown> }
  tuiSettings?: TuiSettingsLike
  extensions?: TuiCommandRunner['extensions']
  recordExtensionError?: (slot: string, id: string, error: unknown) => void
  clearExtensionError?: (slot: string, id: string) => void
  width?: number
}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.width ?? 100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const presets = presetService(options.rows ?? SHIPPED_ROWS)
  ctx.provide('agentPresets', presets.service as never)
  if (options.settings !== undefined) ctx.provide('settings', options.settings as never)
  const ensureCalls: string[] = []
  const { runner, pending, refreshes } = stubRunner({
    ctx,
    app,
    agent: options.agent,
    recomposeBlank: options.recomposeBlank,
    refreshCatalog: options.refreshCatalog,
    ensureCalls,
    tuiSettings: options.tuiSettings,
    extensions: options.extensions,
    recordExtensionError: options.recordExtensionError,
    clearExtensionError: options.clearExtensionError,
  })
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'preset')
  assert.ok(def?.handler !== undefined, 'preset handler missing')
  const run = async (rawInput: string): Promise<unknown> =>
    (def!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  const runCommand = async (name: string, rawInput = ''): Promise<unknown> => {
    const found = commands.defs.find(entry => entry.name === name)
    assert.ok(found?.handler !== undefined, `${name} handler missing`)
    return (found!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, runCommand, view, pending, presets, ensureCalls, refreshes }
}

test('/preset is in the sessionless dispatch gate', () => {
  // The gate is exactly where /preset used to create a session before the
  // user could switch (dispatchViaSession -> ensureSession). It must keep
  // /preset out of that path.
  assert.ok(SESSIONLESS_COMMANDS.has('preset'), 'SESSIONLESS_COMMANDS must keep /preset sessionless')
})

test('/preset with no session opens the English roster and creates nothing', async () => {
  const t = setup({})
  const result = await t.run('')
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  const view = await t.view()
  assert.ok(view.includes('Standard mode (standard)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('PTC mode (code)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('Minimal mode (minimal)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('Creator mode (cordis)'), `roster row missing:\n${view}`)
  assert.ok(!view.includes('标准模式'), `Chinese preset name leaked:\n${view}`)
  assert.ok(!view.includes('PTC 模式'), `Chinese preset name leaked:\n${view}`)
  // The selected row's full description renders below the list (web parity);
  // the wrap may split the trailing annotations across lines.
  assert.ok(view.includes('Full coding agent with file editing'), `description missing:\n${view}`)
  assert.ok(view.includes('· system'), `annotations missing:\n${view}`)
  assert.ok(view.includes('default'), `annotations missing:\n${view}`)
  t.app.stop()
})

test('/preset <id> with no session sets the pending preset, creating nothing', async () => {
  const t = setup({})
  const result = await t.run('minimal')
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(t.pending.value, 'minimal')
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  t.app.stop()
})

test('/preset <id> with no session rejects an unknown id', async () => {
  const t = setup({})
  const result = await t.run('nope') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not found/)
  assert.equal(t.pending.value, undefined)
  assert.deepEqual(t.ensureCalls, [])
  t.app.stop()
})

test('/preset picker with no session sets the pending preset on one Enter', async () => {
  const t = setup({})
  await t.run('')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.pending.value, 'standard')
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('new sessions will start on preset standard'), `notify missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `roster still open:\n${view}`)
  t.app.stop()
})

test('/preset picker switches a blank session with one Enter', async () => {
  const recomposed: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    recomposeBlank: async (id) => { recomposed.push(id); return { kind: 'switched', preset: id } },
  })
  await t.run('')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.deepEqual(recomposed, ['standard'], 'Enter must confirm the switch (values mechanism)')
  assert.equal(t.pending.value, undefined)
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('session preset switched to standard'), `notify missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `roster still open:\n${view}`)
  t.app.stop()
})

test('/preset <id> switches a blank session', async () => {
  const recomposed: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    recomposeBlank: async (id) => { recomposed.push(id); return { kind: 'switched', preset: id } },
  })
  const result = await t.run('minimal')
  assert.deepEqual(result, { kind: 'success', text: 'session preset switched to minimal' })
  assert.deepEqual(recomposed, ['minimal'])
  t.app.stop()
})

test('/preset with a started session refuses without offering a roster', async () => {
  const recomposed: string[] = []
  const t = setup({
    agent: fakeAgent('s1', [{ type: 'turn/start' }]),
    recomposeBlank: async (id) => { recomposed.push(id); return { kind: 'locked' } },
  })
  const result = await t.run('') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /only available in a new session/)
  const view = await t.view()
  assert.ok(!view.includes('Standard mode (standard)'), `roster offered for a started session:\n${view}`)
  assert.ok(view.includes('only available in a new session'), `notify missing:\n${view}`)
  assert.deepEqual(recomposed, [])
  t.app.stop()
})

test('/preset <id> with a started session refuses with the locked text', async () => {
  let recomposed = 0
  const t = setup({
    agent: fakeAgent('s1', [{ type: 'turn/start' }]),
    recomposeBlank: async () => { recomposed += 1; return { kind: 'locked' } },
  })
  const result = await t.run('minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /has already started; its agent preset is fixed/)
  assert.equal(recomposed, 1)
  t.app.stop()
})

/** A skills-only applied outcome shaped like the coordinator's standing
 * install (the shape /preset and /reload report). */
function standingOutcome(skills: string[], notice?: string): CatalogRefreshOutcome {
  return {
    kind: 'applied',
    snapshot: Object.freeze({
      commands: Object.freeze([]),
      scopedCommands: Object.freeze([]),
      skills: Object.freeze(skills.map(name => Object.freeze({ name, description: name }))),
      issues: Object.freeze([]),
    }),
    ...notice === undefined ? {} : { notice },
  }
}

test('/preset <id> with no session requests a STANDING refresh of the new preset, creating nothing', async () => {
  const t = setup({ refreshCatalog: async () => standingOutcome(['glab']) })
  const result = await t.run('code')
  assert.equal(t.pending.value, 'code')
  assert.equal(t.refreshes.length, 1, 'the preset choice must request one standing refresh')
  assert.equal(t.refreshes[0]?.source, 'preset')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'code' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  t.app.stop()
})

test('/preset <id> with no session surfaces the standing degradation notice', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome(['global-skill'], 'skill catalog unavailable for preset "code": preset exploded'),
  })
  const result = await t.run('code') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'new sessions will start on preset code')
  assert.equal(t.pending.value, 'code')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('preset exploded'), `degradation notice missing:\n${view}`)
  t.app.stop()
})

test('/preset default <id> with no override requests a standing refresh of the new default', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }); return undefined },
    },
  })
  const result = await t.run('default code') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'default preset set: code')
  assert.equal(mutated.length, 1)
  assert.equal(t.refreshes.length, 1, 'an unmasked default change must refresh the standing catalog')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'code' })
  t.app.stop()
})

test('/preset default <id> masked by a pending preset does NOT refresh', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async () => undefined,
    },
  })
  t.pending.value = 'minimal'
  const result = await t.run('default code') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(t.refreshes.length, 0, 'the pending override masks the new default — no refresh')
  t.app.stop()
})

test('/reload with no session refreshes the STANDING catalog and reports the skill count', async () => {
  const t = setup({ refreshCatalog: async () => standingOutcome(['glab', 'find-skills']) })
  const result = await t.runCommand('reload') as { kind: string; text: string }
  assert.ok(result.kind === 'success')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('reloaded'), `reload notify missing:\n${view}`)
  assert.ok(view.includes('2 human skills'), `skill count missing:\n${view}`)
  assert.equal(t.refreshes.length, 1)
  assert.equal(t.refreshes[0]?.source, 'reload')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: undefined },
    'the effective preset id (none pending) resolves to the deployment default')
  t.app.stop()
})

function reloadSettings(theme: string, onGet?: (count: number) => void): TuiSettingsLike {
  let reads = 0
  let currentTheme = theme
  return {
    get: () => {
      reads += 1
      onGet?.(reads)
      return { theme: currentTheme, iconStyle: 'emoji', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', focusMode: 'off' }
    },
    replace: doc => { currentTheme = doc.theme as string },
  }
}

function themeExtensions(paletteFor: (name: string) => typeof darkColors | undefined): NonNullable<TuiCommandRunner['extensions']> {
  return { themes: { paletteFor } } as unknown as NonNullable<TuiCommandRunner['extensions']>
}

test('/reload theme autodetect rechecks the latest persisted choice before applying', async () => {
  let settingsReads = 0
  const t = setup({
    tuiSettings: reloadSettings('auto', count => { settingsReads = count }),
  })
  let resolveBackground!: (value: { red: number; green: number; blue: number } | undefined) => void
  const pending = new Promise<{ red: number; green: number; blue: number } | undefined>(resolve => { resolveBackground = resolve })
  t.app.autoDetectTheme = async (options) => {
    assert.equal(options?.shouldApply?.(), true)
    // Simulate the settings panel changing the choice while OSC 11 is in flight.
    t.app.applyTheme('light')
    assert.equal(options?.shouldApply?.(), false)
    await pending
  }
  const result = await t.runCommand('reload') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.ok(settingsReads >= 2, 'the late guard must read settings again')
  resolveBackground(undefined)
  t.app.stop()
})

test('/reload custom file theme applies without touching plugin health', async () => {
  const name = `reload-custom-${randomUUID()}`
  const file = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, colors: { primary: '#123456' } }))
  const cleared: string[] = []
  const recorded: string[] = []
  try {
    const t = setup({
      tuiSettings: reloadSettings(`custom:${name}`),
      extensions: themeExtensions(() => undefined),
      clearExtensionError: (_slot, id) => cleared.push(id),
      recordExtensionError: (_slot, id) => recorded.push(id),
    })
    const result = await t.runCommand('reload') as { kind: string }
    assert.equal(result.kind, 'success')
    assert.deepEqual(cleared, [], 'custom-file success must not clear plugin health')
    assert.deepEqual(recorded, [], 'custom-file success must not record plugin health')
    t.app.stop()
  } finally {
    rmSync(file, { force: true })
  }
})

test('/reload custom file theme failure does not record plugin health', async () => {
  const name = `reload-custom-failing-${randomUUID()}`
  const file = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, colors: { primary: '#123456' } }))
  const recorded: string[] = []
  try {
    const t = setup({
      tuiSettings: reloadSettings(`custom:${name}`),
      extensions: themeExtensions(() => undefined),
      recordExtensionError: (_slot, id) => recorded.push(id),
    })
    t.app.applyPalette = () => { throw new Error('custom palette failed') }
    const result = await t.runCommand('reload') as { kind: string }
    assert.equal(result.kind, 'success')
    assert.deepEqual(recorded, [], 'custom-file failure must not create plugin health')
    t.app.stop()
  } finally {
    rmSync(file, { force: true })
  }
})

test('/reload plugin theme failure records and later success clears its health', async () => {
  const name = `reload-plugin-${randomUUID()}`
  const recorded: string[] = []
  const cleared: string[] = []
  const t = setup({
    tuiSettings: reloadSettings(`custom:${name}`),
    extensions: themeExtensions(candidate => candidate === name ? darkColors : undefined),
    recordExtensionError: (_slot, id) => recorded.push(id),
    clearExtensionError: (_slot, id) => cleared.push(id),
  })
  t.app.applyPalette = () => { throw new Error('plugin palette failed') }
  await t.runCommand('reload')
  assert.deepEqual(recorded, [name], 'plugin palette failure must record its contribution')
  t.app.applyPalette = () => {}
  await t.runCommand('reload')
  assert.deepEqual(cleared, [name], 'a later plugin palette success must clear its contribution')
  t.app.stop()
})

test('/reload unknown theme does not create plugin health', async () => {
  const name = `reload-missing-${randomUUID()}`
  const recorded: string[] = []
  const t = setup({
    tuiSettings: reloadSettings(`custom:${name}`),
    extensions: themeExtensions(() => undefined),
    recordExtensionError: (_slot, id) => recorded.push(id),
  })
  const result = await t.runCommand('reload') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.deepEqual(recorded, [], 'unknown host theme must not create plugin health')
  t.app.stop()
})

test('/reload with a pending preset reports the standing degradation notice', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome([], 'skill catalog unavailable for preset "code": preset exploded'),
  })
  t.pending.value = 'code'
  await t.runCommand('reload')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('0 human skills'), `skill count missing:\n${view}`)
  assert.ok(view.includes('preset exploded'), `degradation notice missing:\n${view}`)
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'code' })
  t.app.stop()
})

test('/reload with a live agent refreshes the AGENT target, never the standing path', async () => {
  const t = setup({
    agent: fakeAgent('s1', []),
    refreshCatalog: async () => ({
      kind: 'applied',
      snapshot: Object.freeze({
        commands: Object.freeze([Object.freeze({ name: 'builtin', description: 'b' })]),
        scopedCommands: Object.freeze([]),
        skills: Object.freeze([]),
        issues: Object.freeze([]),
      }),
    }),
  })
  await t.runCommand('reload')
  assert.equal(t.refreshes.length, 1)
  assert.equal(t.refreshes[0]?.target.kind, 'agent', 'a live session must refresh the agent target')
  t.app.stop()
})
