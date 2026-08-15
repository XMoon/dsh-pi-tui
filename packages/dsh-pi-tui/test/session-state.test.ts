/**
 * Headless tests for session-scoped state isolation: the skill command
 * catalog refresh race (an old session's late refresh must not clobber the
 * new session's commands) and the TuiApp per-session override clearing.
 * @module @xmoon76/dsh-pi-tui/session-state.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A promise the test resolves manually, to stage late completions. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** A minimal fake agent whose identity marks which session a refresh ran for. */
function fakeAgent(sessionId: string): Agent {
  return {
    session: { id: sessionId, header: { cwd: '/ws' } },
  } as unknown as Agent
}

/** A stub runner with a MUTABLE generation and live agent (the test plays
 * the session switch by mutating state). */
function stubRunner(ctx: Context, app: TuiApp, state: { agent: Agent | undefined; generation: number }): TuiCommandRunner {
  return {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return state.agent },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    agents: {} as never,
    sessions: { flush: async () => {} },
    cwd: '/ws',
    signal: new AbortController().signal,
    get sessionGeneration() { return state.generation },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    enterView: async () => {},
    exit: () => {},
  }
}

/** A fake commands service recording registrations, and a fake skills
 * service whose catalog is controllable per agent. */
function fakeServices() {
  const registered: string[] = []
  const disposers = new Map<string, () => void>()
  const catalogs = new Map<object, { promise: Promise<readonly { name: string; description: string }[]>; resolve: (v: readonly { name: string; description: string }[]) => void }>()
  const commands = {
    register: (def: { name: string }): (() => void) => {
      registered.push(def.name)
      const disposer = (): void => {
        const index = registered.indexOf(def.name)
        if (index !== -1) registered.splice(index, 1)
      }
      disposers.set(def.name, disposer)
      return disposer
    },
    list: () => [{ name: 'builtin', description: 'a builtin', input: { hint: '' } }],
    find: () => undefined,
    execute: async () => undefined,
  }
  const skills = {
    list: (options: { scope?: object }): Promise<readonly { name: string; description: string }[]> => {
      const scope = options.scope ?? {}
      const existing = catalogs.get(scope)
      if (existing !== undefined) return existing.promise
      const gate = deferred<readonly { name: string; description: string }[]>()
      catalogs.set(scope, gate)
      return gate.promise
    },
    get: async () => undefined,
  }
  return {
    registered,
    catalogs,
    commands: { ...commands, dispose: (name: string) => disposers.get(name)?.() },
    skills,
  }
}

test('a stale skill refresh cannot register commands into a newer session', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const { refreshSkills } = registerTuiCommands(stubRunner(ctx, app, state))

  // Session A's refresh starts and hangs on the catalog fetch.
  const refreshA = refreshSkills()
  // The session switches to B while A's catalog is still loading.
  state.agent = fakeAgent('session-b')
  state.generation = 2
  const refreshB = refreshSkills()
  // B's catalog arrives: its commands register.
  services.catalogs.get(state.agent)?.resolve([{ name: 'skill-b', description: 'b' }])
  await refreshB
  assert.ok(services.registered.includes('skill-b'), 'the current session\'s commands must register')
  // A's catalog lands LATE: the generation check must drop it entirely.
  for (const [scope, gate] of services.catalogs) {
    if (scope !== state.agent) gate.resolve([{ name: 'skill-a', description: 'a' }])
  }
  await refreshA
  assert.ok(!services.registered.includes('skill-a'), 'a stale refresh must not register old-session commands')
  assert.ok(services.registered.includes('skill-b'), 'the new session\'s commands survive the stale refresh')
  app.stop()
})

test('clearSessionOverrides drops per-message expansion toggles', () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
  const messageA = { kind: 'thinking', turn: 0 }
  const messageB = { kind: 'tool', turn: 1 }
  overrides.set(messageA, true)
  overrides.set(messageB, true)
  assert.equal(overrides.size, 2)
  app.clearSessionOverrides()
  assert.equal(overrides.size, 0, 'session-scoped expansion overrides must clear on switch')
  app.stop()
})
