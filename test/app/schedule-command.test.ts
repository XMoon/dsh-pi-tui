/**
 * S5-PR4 L6 command surface: `/schedule` admission.
 *
 * The command is a sessionless local entry with NO argument grammar: a bare
 * `/schedule` leases the ONE workspace over the selected backend and performs no
 * Session/model/Host write by itself; `/schedule anything` is an explicit
 * parameter error; TSP keeps its generic unsupported-capability refusal because
 * `schedule` is not in the TSP-admitted builtin set.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerScheduleCommand } from '../../src/tui/commands/schedule.ts'
import {
  HOST_COMMAND_CATALOG,
  LOCAL_COMMANDS,
  SESSIONLESS_COMMANDS,
  classifyCommandLine,
} from '../../src/domain/command/policy.ts'
import { TSP_SUPPORTED_TUI_BUILTINS, tspBuiltinAvailability } from '../../src/app/command/tsp-capability.ts'
import { openScheduleWorkspace } from '../../src/app/schedule/runtime.ts'
import type { TuiCommandSpec } from '../../src/commands.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  SchedulePort,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleViewRequest,
  ScheduleViewResult,
} from '../../src/runtime/schedule-port.ts'
import type { SessionReader } from '../../src/runtime/session-reader-port.ts'

/** Register the command over a recording registrar and return its spec. */
function register(open: () => import('@deepseek-ai/dsh-commands').CommandResult): TuiCommandSpec {
  let spec: TuiCommandSpec | undefined
  registerScheduleCommand({
    openScheduleWorkspace: open,
    registerTuiCommand: value => { spec = value },
  })
  assert.ok(spec !== undefined, 'the command registered no specification')
  return spec
}

function invocation(rawInput: string): Parameters<TuiCommandSpec['handler']>[0] {
  return {
    commandId: 'command-1' as never,
    agent: {} as never,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

test('L6C: a bare /schedule leases the ONE workspace and takes no arguments', async () => {
  let opens = 0
  const spec = register(() => {
    opens += 1
    return { kind: 'success' }
  })
  assert.equal(spec.name, 'schedule')
  assert.equal(spec.aliases, undefined, '/schedule has no alias and no second entry')
  assert.deepEqual(await spec.handler(invocation('')), { kind: 'success' })
  assert.equal(opens, 1)
  const refused = await spec.handler(invocation(' build'))
  assert.equal(refused.kind, 'error')
  assert.match(refused.kind === 'error' ? refused.text : '', /does not take arguments/u)
  assert.equal(opens, 1, 'an argument never reaches the workspace')
})

test('L6C: /schedule is sessionless, local, host-reserved and NOT TSP-admitted', () => {
  assert.equal(SESSIONLESS_COMMANDS.has('schedule'), true)
  assert.equal(LOCAL_COMMANDS.has('schedule'), true)
  assert.equal(HOST_COMMAND_CATALOG.has('schedule'), true, 'the catalog is derived from the two official sets')
  // `/tasks` keeps its own Job/Subagent semantics: `/schedule` is not its alias.
  assert.equal(LOCAL_COMMANDS.has('tasks'), true)
  assert.equal(TSP_SUPPORTED_TUI_BUILTINS.has('schedule'), false, 'TSP refuses /schedule through its generic capability gate')
  // The REAL TSP gate (not just the roster read): a sessionless `/schedule` line
  // is an admitted Client command that the TSP renderer cannot present, so it
  // lands on the generic unsupported verdict (draft restored, nothing executed).
  assert.deepEqual(
    tspBuiltinAvailability({ kind: 'client-command', source: 'tui' }, 'schedule', {}, ''),
    { kind: 'unsupported' },
  )
})

test('L6C: a sessionless /schedule line classifies as a Client command, never a Host line', () => {
  assert.deepEqual(
    classifyCommandLine({
      hostOriginClaim: undefined,
      tuiCommand: true,
      extensionCommand: false,
      skillInvocation: false,
    }),
    { kind: 'client-command', source: 'tui' },
  )
})

class ReadOnlyPort implements SchedulePort {
  readonly calls: string[] = []
  readonly listeners = new Set<() => void>()

  async catalog(): Promise<readonly ScheduleCatalogEntry[]> {
    this.calls.push('catalog')
    return []
  }
  async list(_request: ScheduleListRequest): Promise<ScheduleListResult> {
    this.calls.push('list')
    return { items: [], shown: 0, total: 0, limit: 100, offset: 0 }
  }
  async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
    this.calls.push('view')
    return { id: request.id, code: 'schedule_not_found' }
  }
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    this.calls.push('history')
    return { id: request.id, code: 'schedule_not_found' }
  }
  async deliveryLimits(): Promise<{ readonly newSessionIntervalSeconds: number }> {
    this.calls.push('deliveryLimits')
    return { newSessionIntervalSeconds: 60 }
  }
  async create(): Promise<ScheduleCatalogEntry> {
    this.calls.push('create')
    throw new Error('a bare open must never create')
  }
  async edit(_request: ScheduleEditRequest): Promise<ScheduleEditResult> {
    this.calls.push('edit')
    throw new Error('a bare open must never edit')
  }
  async run(_request: ScheduleRunRequest): Promise<ScheduleRunResult> {
    this.calls.push('run')
    throw new Error('a bare open must never run')
  }
  async deleteInactive(): Promise<{ deleted: number }> {
    this.calls.push('deleteInactive')
    throw new Error('a bare open must never clear')
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

const sessionReader: SessionReader = {
  list: async () => [],
  projectionBatch: async () => new Map(),
  search: async () => undefined,
  blank: () => undefined,
  measureContext: () => undefined,
  turnOutline: () => undefined,
  sessionStatus: () => undefined,
}

test('L6C: opening the workspace over the selected backend performs READS only', async () => {
  const port = new ReadOnlyPort()
  const updates: unknown[] = []
  let close: (() => void) | undefined
  const opened = openScheduleWorkspace({
    port,
    sessionReader,
    runOwned: (_label, task) => { void task() },
    captureSessionSwitch: () => async () => ({ kind: 'failed', message: 'unused' }),
    app: () => ({
      openScheduleWorkspace: (bindings: import('../../src/tui-app.ts').ScheduleWorkspaceBindings) => {
        assert.equal(bindings.snapshot().status, 'loading', 'the panel is leased before the first Host read')
        close = bindings.onClose
        return {
          close: () => bindings.onClose?.(),
          update: (snapshot: unknown) => updates.push(snapshot),
        }
      },
    }) as unknown as import('../../src/tui-app.ts').TuiApp,
  })
  assert.deepEqual(opened, { kind: 'success' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(port.calls, ['catalog', 'deliveryLimits'], 'a bare open reads the catalog and limits only')
  assert.ok(updates.length >= 1, 'the ready snapshot reaches the leased panel')
  close?.()
  assert.equal(port.listeners.size, 0, 'closing the lease disposes the controller subscriptions')
})

test('L6C: without a PiTui renderer the command answers a real error and leases nothing', () => {
  const port = new ReadOnlyPort()
  const result = openScheduleWorkspace({
    port,
    sessionReader,
    runOwned: () => {},
    captureSessionSwitch: () => async () => ({ kind: 'failed', message: 'unused' }),
    app: () => undefined,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.kind === 'error' ? result.text : '', /Pi-TUI renderer only/u)
  assert.deepEqual(port.calls, [], 'no Host read happens without a surface')
})
