/**
 * Headless tests for the /preset command surface: the sessionless roster
 * (no session created before one exists), the one-Enter switch through the
 * SettingsList values mechanism, the blank-session recompose path, the
 * started-session refusal, and the English display copy.
 * @module @xmoon76/dsh-pi-tui/preset-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { SESSIONLESS_COMMANDS } from '../src/index.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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

/** A stub runner with a MUTABLE pending preset and an optional recompose. */
function stubRunner(options: {
  ctx: Context
  app: TuiApp
  agent: Agent | undefined
  recomposeBlank?: (id: string) => Promise<{ kind: 'switched'; preset: string } | { kind: 'locked' }>
  ensureCalls?: string[]
}): { runner: TuiCommandRunner; pending: { value: string | undefined } } {
  const pending = { value: undefined as string | undefined }
  const runner: TuiCommandRunner = {
    ctx: options.ctx,
    app: options.app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return options.agent },
    ensureSession: async () => { options.ensureCalls?.push('ensureSession') },
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    agents: {} as never,
    sessions: { flush: async () => {} },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    get pendingPreset() { return pending.value },
    set pendingPreset(id: string | undefined) { pending.value = id },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: options.recomposeBlank ?? (async () => ({ kind: 'switched', preset: 'standard' })),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    enterView: async () => {},
    requestExit: () => {},
    exit: () => {},
  }
  return { runner, pending }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent: undefined as unknown as Agent,
    rawInput,
    signal: new AbortController().signal,
  }
}

/** Register the TUI commands and return the /preset surface under test. */
function setup(options: {
  rows?: { id: string; name?: string; description?: string; trust?: string }[]
  agent?: Agent
  recomposeBlank?: (id: string) => Promise<{ kind: 'switched'; preset: string } | { kind: 'locked' }>
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
  const ensureCalls: string[] = []
  const { runner, pending } = stubRunner({
    ctx, app, agent: options.agent, recomposeBlank: options.recomposeBlank, ensureCalls,
  })
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'preset')
  assert.ok(def?.handler !== undefined, 'preset handler missing')
  const run = async (rawInput: string): Promise<unknown> =>
    (def!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, view, pending, presets, ensureCalls }
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
  assert.ok(view.includes('Code mode (code)'), `roster row missing:\n${view}`)
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
