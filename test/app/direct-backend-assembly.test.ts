/**
 * Direct backend assembly tests (Pre-M3 PR1): the Direct semantic adapters are
 * constructed by ONE assembly owner and exposed only through `Backend`. The
 * Job observation port that P1 added as a runner-local side channel must be
 * served by the backend instead, so the migration can never grow a second
 * semantic port that bypasses the vocabulary.
 * @module @xmoon76/dsh-pi-tui/direct-backend-assembly.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createDirectRuntimeBackend } from '../../src/runtime/direct/backend-direct.ts'
import { DIRECT_IMPLEMENTED_CAPABILITIES } from '../../src/runtime/capability.ts'
import type { DirectBackendDeps, DirectLiveAgentLike } from '../../src/runtime/direct/backend-direct.ts'
import type { TuiSettingsConfig, TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { compositionSource } from '../support/composition-surface.ts'

function makeDeps(overrides: Partial<DirectBackendDeps> = {}): DirectBackendDeps {
  const diag: Diag = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    dispose: () => {},
  }
  return {
    ctx: { get: () => undefined, on: () => () => false },
    diag,
    tuiSettings: undefined,
    sessionCwd: () => process.cwd(),
    modelSelections: {
      current: () => undefined,
      select: () => {},
      serializeImageAdmission: async (_agent, operation) => operation(),
      durableProjectionForSession: () => ({ lastUsed: null, next: null }),
    },
    ownerPool: { claim: () => undefined, park: () => {} },
    compose: async () => ({ setup: () => {} }),
    agentFor: () => undefined,
    queueAgentFor: () => undefined,
    shellCandidates: async () => [],
    liveResolvers: { sessionOf: () => undefined, agentOf: () => undefined },
    ...overrides,
  }
}

test('the Direct assembly exposes the Job observation port through the Backend', () => {
  const backend = createDirectRuntimeBackend(makeDeps())
  assert.equal(backend.kind, 'direct')
  assert.equal(typeof backend.jobObservation.open, 'function')
  assert.equal(typeof backend.pluginManager.snapshot, 'function')
  assert.ok(backend.capabilities.has('job-observation'))
  assert.equal(typeof backend.schedule.catalog, 'function', 'S5-PR4: the Host Schedule port is a required backend member')
  assert.deepEqual([...backend.capabilities].sort(), [...DIRECT_IMPLEMENTED_CAPABILITIES].sort())
})

test('each backend domain is served by its own adapter instance', () => {
  const backend = createDirectRuntimeBackend(makeDeps())
  const ports = [
    backend.subagent,
    backend.sessionReader,
    backend.pendingInputReader,
    backend.sessionWriter,
    backend.sessionLifecycle,
    backend.interaction,
    backend.catalog,
    backend.config,
    backend.hostFile,
    backend.sessionArchive,
    backend.sessionMarkdown,
    backend.hostCommand,
    backend.pluginManager,
    backend.jobObservation,
    backend.sessionWorkspaceFacts,
    backend.schedule,
  ]
  assert.equal(new Set(ports).size, ports.length, 'no adapter instance may serve two domains')
})

test('the runner no longer constructs the Direct Job observation adapter itself', () => {
  const source = compositionSource()
  assert.doesNotMatch(source, /DirectJobObservationPort/,
    'the composition surface must consume backend.jobObservation instead of constructing the Direct adapter')
})


// ── The assembled Direct shell adapter gates on the LIVE official authorities ──

interface ShellAssemblyState {
  cwd: string | undefined
  policy: string
}

interface ShellAssembly {
  readonly backend: ReturnType<typeof createDirectRuntimeBackend>
  readonly state: ShellAssemblyState
  readonly spawns: SubprocessSpawnSpec[]
  readonly confineCalls: readonly string[][]
}

const shellSession = { id: 's' }

/**
 * The REAL `createDirectRuntimeBackend()` composition with the minimal official
 * Host capabilities the Direct user-shell adapter reads: the official
 * `workingDirectory` owner and the live `tuiSettings` document stand in for the
 * production services, everything else keeps the assembly baseline.
 */
function shellAssembly(options: {
  readonly cwd?: string | undefined
  readonly policy?: string
  readonly onResolve?: (state: ShellAssemblyState) => void
} = {}): ShellAssembly {
  const state: ShellAssemblyState = {
    cwd: options.cwd ?? '/live/workspace-a',
    policy: options.policy ?? 'bypass',
  }
  const spawns: SubprocessSpawnSpec[] = []
  const confineCalls: string[][] = []
  const agent: DirectLiveAgentLike = {
    session: shellSession,
    status: 'idle',
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    inbox: { nextTurn: [], nextStep: [], replace: () => false, remove: () => false },
  }
  const settings: TuiSettingsConfig = {
    get: () => ({ localShellSandbox: state.policy }) as TuiSettingsDoc,
    replace: () => {},
  }
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => {},
    waitForExit: async () => true,
  }
  const backend = createDirectRuntimeBackend(makeDeps({
    ctx: {
      get: (name: string) => {
        if (name === 'workingDirectory') return { get: () => state.cwd }
        if (name === 'sandboxPolicy') {
          return { resolve: async () => {
            options.onResolve?.(state)
            return { mode: 'workspace-write', workspaceRoot: state.cwd ?? process.cwd() }
          } }
        }
        if (name === 'sandbox') {
          return { confine: async (argv: readonly string[]): Promise<ConfinedArgv> => {
            confineCalls.push([...argv])
            return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
          } }
        }
        if (name === 'subprocess') return { spawn: (spec: SubprocessSpawnSpec) => { spawns.push(spec); return handle } }
        return undefined
      },
      on: () => () => false,
    },
    agentFor: () => agent,
    tuiSettings: settings,
  }))
  return { backend, state, spawns, confineCalls }
}

function shellRequest(overrides: Partial<{ cwd: string; policy: 'bypass' | 'sandbox' }> = {}) {
  return {
    sessionId: 's',
    cwd: '/live/workspace-a',
    command: 'pwd',
    policy: 'bypass' as const,
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('the assembled Direct shell adapter checks the live official cwd and policy at admission', async () => {
  const scene = shellAssembly({ cwd: '/live/workspace-a', policy: 'bypass' })
  const settled = await scene.backend.hostUserShell.execute(shellRequest())
  assert.equal(settled.kind, 'settled')
  assert.equal(scene.spawns.length, 1)
  assert.equal(scene.spawns[0]!.cwd, '/live/workspace-a', 'the run spawns in the official effective cwd')

  // The LIVE official workingDirectory moving is what the request gate reads.
  scene.state.cwd = '/live/workspace-b'
  const movedCwd = await scene.backend.hostUserShell.execute(shellRequest())
  assert.equal(movedCwd.kind, 'unavailable')
  if (movedCwd.kind !== 'unavailable') throw new Error('expected a cwd-currentness refusal')
  assert.match(movedCwd.reason.message, /Host working directory changed/u)
  assert.equal(scene.spawns.length, 1, 'no spawn after the live cwd moved away from the request')

  // The LIVE persisted preference moving is read through the SAME tuiSettings
  // document the submission owner read when it captured the request.
  scene.state.cwd = '/live/workspace-a'
  scene.state.policy = 'sandbox'
  const movedPolicy = await scene.backend.hostUserShell.execute(shellRequest())
  assert.equal(movedPolicy.kind, 'unavailable')
  if (movedPolicy.kind !== 'unavailable') throw new Error('expected a policy-currentness refusal')
  assert.match(movedPolicy.reason.message, /user shell policy changed/u)
  assert.equal(scene.spawns.length, 1, 'no spawn after the live policy moved away from the request')
  assert.equal(scene.confineCalls.length, 0, 'a stale bypass request never enters sandbox preparation')
})

test('the assembled Direct shell adapter rechecks the live cwd immediately before spawn', async () => {
  const scene = shellAssembly({
    cwd: '/live/workspace-a',
    policy: 'sandbox',
    onResolve: state => { state.cwd = '/live/workspace-b' },
  })
  const outcome = await scene.backend.hostUserShell.execute(shellRequest({ cwd: '/live/workspace-a', policy: 'sandbox' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a preparation-currentness refusal')
  assert.match(outcome.reason.message, /Host working directory changed during shell preparation/u)
  assert.equal(scene.confineCalls.length, 1, 'the sandbox preparation the run started still ran exactly once')
  assert.equal(scene.spawns.length, 0, 'the stale request never spawns')
})

test('the assembled Direct shell adapter rechecks the live policy immediately before spawn', async () => {
  const scene = shellAssembly({
    cwd: '/live/workspace-a',
    policy: 'sandbox',
    onResolve: state => { state.policy = 'bypass' },
  })
  const outcome = await scene.backend.hostUserShell.execute(shellRequest({ cwd: '/live/workspace-a', policy: 'sandbox' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a policy-preparation refusal')
  assert.match(outcome.reason.message, /user shell policy changed during shell preparation/u)
  assert.equal(scene.spawns.length, 0, 'the changed preference never runs the request under another policy')
})
