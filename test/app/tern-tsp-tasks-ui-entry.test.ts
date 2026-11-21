/**
 * Mouse PR4: the `/tasks` UI entry the TSP first-party Tasks status segment
 * calls.
 *
 * The entry must be the SAME function the registered command (and its
 * `/subagents` alias) runs — one Session admission, one Task Runtime opener —
 * and it must not exist at all when a genuine Host command owns the name. The
 * behaviour is exercised through the REAL registration pass: a Client registry
 * and a Host-side `commands.register` that refuses a duplicate exactly like the
 * official one, with only the unrelated runner members stubbed.
 *
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-tasks-ui-entry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'

/** The name collision message the official Host registry raises. */
const collisionOf = (name: string): string => `command "${name}" is already registered`

interface Assembly {
  readonly installed: ReturnType<typeof registerTuiCommands>
  /** The registration specs the CLIENT registry really received. */
  readonly clientDefinitions: ReadonlyArray<{ readonly name: string; readonly handler?: unknown }>
  readonly admissions: number[]
  readonly browsers: number[]
}

/**
 * Run the production registration pass. `hostOwned` names commands a genuine
 * Host composition already registered, so the Direct compatibility mirror of
 * the TUI registration degrades exactly as it does in production.
 */
function assemble(hostOwned: readonly string[] = []): Assembly {
  const ctx = new Context()
  const admissions: number[] = []
  const browsers: number[] = []
  const clientDefinitions: Array<{ readonly name: string; readonly handler?: unknown }> = []
  const clientCommands = createClientCommandRegistry(parseCommand)
  const registerClient = clientCommands.register.bind(clientCommands)
  const hostOwnedNames = new Set(hostOwned)
  const runnerBase: Record<string, unknown> = {
    ctx,
    // A TSP-shaped composition: no PiTui app owns a terminal here.
    app: undefined,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    signal: new AbortController().signal,
    cwd: '/ws',
    sessionCwd: () => '/ws',
    listScopedCommands: () => [],
    clientCommands: {
      register: (definition: { name: string; handler?: unknown }) => {
        clientDefinitions.push(definition)
        return registerClient(definition as never)
      },
      claimsLine: (parsed: unknown) => clientCommands.claimsLine(parsed as never),
      list: () => clientCommands.list(),
      get: (name: string) => clientCommands.get(name),
      execute: (request: never) => clientCommands.execute(request),
    },
    commandRegistry: {
      register: (definition: { name: string }) => {
        if (hostOwnedNames.has(definition.name)) throw new Error(collisionOf(definition.name))
        return () => {}
      },
      list: () => [],
      find: () => undefined,
      execute: async () => undefined,
    },
    requireLiveSessionScope: async () => { admissions.push(1) },
    openTasksBrowser: () => { browsers.push(1) },
  }
  const runner = new Proxy(runnerBase, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  const installed = registerTuiCommands(runner, undefined, { listGlobalCommands: () => [] })
  return { installed, clientDefinitions, admissions, browsers }
}

test('Mouse PR4: the UI entry IS the registered /tasks handler, and the alias shares it', async () => {
  const { installed, clientDefinitions, admissions, browsers } = assemble()
  const entry = installed.openTasksBrowserUi
  assert.equal(typeof entry, 'function', 'a clean registration installs the UI entry')

  const tasks = clientDefinitions.find(definition => definition.name === 'tasks')
  const subagents = clientDefinitions.find(definition => definition.name === 'subagents')
  assert.ok(tasks?.handler !== undefined, 'the /tasks command registered')
  assert.ok(subagents?.handler !== undefined, 'the /subagents alias registered')
  assert.equal(tasks!.handler, entry,
    'the UI entry is the EXACT function the /tasks command runs — no second interpreter')
  assert.equal(subagents!.handler, entry, 'the alias runs the same function')

  // ONE call = ONE Session admission and ONE Task Runtime opener.
  assert.deepEqual(await entry!(), { kind: 'success' })
  assert.equal(admissions.length, 1, 'the registered handler ran its own Session admission once')
  assert.equal(browsers.length, 1, 'the ONE Task Runtime opener ran once')
})

test('Mouse PR4: a Host-owned /tasks name leaves the UI entry undefined; other commands still register', () => {
  const { installed, clientDefinitions } = assemble(['tasks'])
  assert.equal(installed.openTasksBrowserUi, undefined,
    'a genuine Host /tasks command must not be shadowed by a TUI UI entry')
  assert.ok(installed.registrationFailures.some(failure => failure.startsWith('/tasks:')),
    'the degraded registration is reported, never silent')
  // The alias still registered and every other builtin still installed.
  assert.ok(clientDefinitions.some(definition => definition.name === 'subagents'))
  assert.ok(clientDefinitions.some(definition => definition.name === 'model'))
  assert.ok(clientDefinitions.some(definition => definition.name === 'sessions'))
})

test('Mouse PR4: a Host-owned /subagents alias name also disables the UI entry', () => {
  const { installed } = assemble(['subagents'])
  assert.equal(installed.openTasksBrowserUi, undefined,
    'the alias is part of the same command family; a Host alias owner refuses the entry')
})

test('Mouse PR4: the entry runs once per call — it holds no queue, latch or retry', async () => {
  const { installed, admissions, browsers } = assemble()
  const entry = installed.openTasksBrowserUi!
  await Promise.all([entry(), entry()])
  assert.equal(admissions.length, 2, 'two invocations are two Sessions admissions (the command owns them)')
  assert.equal(browsers.length, 2, 'and two opener calls — the entry itself never suppresses one')
})
