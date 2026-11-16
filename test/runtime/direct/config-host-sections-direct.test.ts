/** FR5-B adapter contract: the official Agent-loop, active-shell and
 * session-log sections over controlled Settings descriptors and a real Cordis
 * identity probe. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import {
  DirectAgentLoopSettingsConfig,
  DirectConfigPort,
  DirectSessionLogUploadConfig,
  DirectShellExecutionSettingsConfig,
  type HostContextLike,
  type SettingsMutationOp,
  type SettingsServiceLike,
} from '../../../src/runtime/direct/config-direct.ts'

type Descriptor = { ns: string; value: unknown; base?: unknown; user?: unknown; revision?: number }

class SettingsFixture implements SettingsServiceLike {
  descriptors: Descriptor[]
  describeCalls = 0
  readonly mutations: Array<{ ns: string; ops: readonly SettingsMutationOp[]; revision: number | undefined }> = []
  describeFailure: Error | undefined
  mutateFailureAfterApply: Error | undefined

  constructor(descriptors: Descriptor[]) {
    this.descriptors = structuredClone(descriptors)
  }

  describe(): readonly Descriptor[] {
    this.describeCalls += 1
    if (this.describeFailure !== undefined) throw this.describeFailure
    return structuredClone(this.descriptors)
  }

  async mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
    this.mutations.push({ ns, ops: structuredClone(ops), revision })
    const descriptor = this.descriptors.find(item => item.ns === ns)
    if (descriptor === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    if (revision !== descriptor.revision) {
      throw Object.assign(new Error('settings namespace changed since it was read'), { code: 'SETTINGS_CONFLICT' })
    }
    const user = { ...(descriptor.user as Record<string, unknown> | undefined) }
    const base = descriptor.base as Record<string, unknown>
    for (const op of ops) {
      assert.equal(op.path.length, 1, 'the typed adapter only writes whole fields')
      const field = op.path[0]!
      if (op.op === 'set') user[field] = structuredClone(op.value)
      // The official rc.3 mutate materializes the inherited value instead of
      // deleting a USER field the base provides.
      else if (Object.hasOwn(base, field)) user[field] = structuredClone(base[field])
      else Reflect.deleteProperty(user, field)
    }
    descriptor.user = user
    descriptor.value = { ...base, ...user }
    descriptor.revision = (descriptor.revision ?? 0) + 1
    if (this.mutateFailureAfterApply !== undefined) throw this.mutateFailureAfterApply
  }
}

class CordisSettingsFixture extends Service {
  private readonly backing: SettingsFixture

  constructor(ctx: Context, backing: SettingsFixture) {
    super(ctx, 'settings')
    this.backing = backing
  }

  describe(): readonly Descriptor[] {
    return this.backing.describe()
  }

  mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
    return this.backing.mutate(ns, ops, revision)
  }
}

function contextWith(settings: unknown): HostContextLike {
  return { get: name => name === 'settings' ? settings : undefined }
}

function makeSettings(options: { shell?: 'bash' | 'pwsh' | 'both' | 'none' } = {}): SettingsFixture {
  const descriptors: Descriptor[] = [
    {
      ns: 'agent-loop',
      base: { maxParallelToolCalls: 10 },
      user: { maxParallelToolCalls: 2 },
      value: { maxParallelToolCalls: 2 },
      revision: 4,
    },
    {
      ns: 'session-log-deepseek',
      base: { enabled: true },
      user: { enabled: false },
      value: { enabled: false },
      revision: 3,
    },
  ]
  const shell = options.shell ?? 'bash'
  if (shell === 'bash' || shell === 'both') {
    descriptors.push({
      ns: 'bash-sandbox',
      base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 90_000 },
      value: { timeoutMs: 90_000, maxOutputBytes: 64_000 },
      revision: 7,
    })
  }
  if (shell === 'pwsh' || shell === 'both') {
    descriptors.push({
      ns: 'pwsh-sandbox',
      base: { timeoutMs: 120_000, maxOutputBytes: 64_000 },
      user: {},
      value: { timeoutMs: 120_000, maxOutputBytes: 64_000 },
      revision: 2,
    })
  }
  return new SettingsFixture(descriptors)
}

test('one descriptor read projects Agent loop, session log and the ACTIVE shell row', () => {
  const settings = makeSettings()
  const port = new DirectConfigPort(contextWith(settings), undefined, () => undefined)

  const loop = port.agentLoopSettings.read()
  assert.equal(loop.kind, 'ready')
  if (loop.kind !== 'ready') return
  assert.equal(loop.revision, 4)
  assert.deepEqual(loop.effective, { maxParallelToolCalls: 2 })
  assert.deepEqual(loop.inherited, { maxParallelToolCalls: 10 })
  assert.deepEqual(loop.overridden, { maxParallelToolCalls: true })

  const sessionLog = port.sessionLogUpload.read()
  assert.equal(sessionLog.kind, 'ready')
  if (sessionLog.kind !== 'ready') return
  assert.deepEqual(sessionLog.effective, { enabled: false })
  assert.deepEqual(sessionLog.inherited, { enabled: true })
  assert.deepEqual(sessionLog.overridden, { enabled: true })

  const shell = port.shellExecutionSettings.read()
  assert.equal(shell.kind, 'ready')
  if (shell.kind !== 'ready') return
  assert.equal(shell.revision, 7)
  assert.deepEqual(shell.effective, { executor: 'bash', timeoutMs: 90_000, maxOutputBytes: 64_000 })
  assert.deepEqual(shell.inherited, { executor: 'bash', timeoutMs: 60_000, maxOutputBytes: 64_000 })
  assert.deepEqual(shell.overridden, { executor: false, timeoutMs: true, maxOutputBytes: false })
})

test('the shell read follows the Host ACTIVE row and fails closed when absent or ambiguous', () => {
  const windows = new DirectShellExecutionSettingsConfig(contextWith(makeSettings({ shell: 'pwsh' })))
  const pwsh = windows.read()
  assert.equal(pwsh.kind, 'ready')
  if (pwsh.kind === 'ready') assert.equal(pwsh.effective.executor, 'pwsh')

  const none = new DirectShellExecutionSettingsConfig(contextWith(makeSettings({ shell: 'none' })))
  assert.equal(none.read().kind, 'unavailable')

  const both = new DirectShellExecutionSettingsConfig(contextWith(makeSettings({ shell: 'both' })))
  const ambiguous = both.read()
  assert.equal(ambiguous.kind, 'unreadable')
  if (ambiguous.kind === 'unreadable') assert.match(ambiguous.reason, /ambiguous/u)

  const malformed = new SettingsFixture([{
    ns: 'bash-sandbox',
    base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
    value: { timeoutMs: 0, maxOutputBytes: 64_000 },
    revision: 1,
  }])
  assert.equal(new DirectShellExecutionSettingsConfig(contextWith(malformed)).read().kind, 'unreadable')

  for (const read of [
    new DirectAgentLoopSettingsConfig(contextWith(undefined)).read(),
    new DirectSessionLogUploadConfig(contextWith(new SettingsFixture([]))).read(),
  ]) {
    assert.equal(read.kind, 'unavailable')
  }
})

test('typed numeric writes use the exact CAS and the official unset op', async () => {
  const settings = makeSettings()
  const loop = new DirectAgentLoopSettingsConfig(contextWith(settings))
  const opened = loop.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.deepEqual(await loop.mutate({ maxParallelToolCalls: { kind: 'set', value: 5 } }, opened.revision, opened.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations.at(-1), {
    ns: 'agent-loop',
    ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 5 }],
    revision: 4,
  })
  assert.deepEqual(settings.descriptors.find(entry => entry.ns === 'agent-loop')?.value, { maxParallelToolCalls: 5 })

  const afterSet = loop.read()
  assert.equal(afterSet.kind, 'ready')
  if (afterSet.kind !== 'ready') return
  assert.deepEqual(await loop.mutate({ maxParallelToolCalls: { kind: 'reset' } }, afterSet.revision, afterSet.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations.at(-1)?.ops, [{ op: 'unset', path: ['maxParallelToolCalls'] }])
  // The official unset materializes the inherited value; it never requires the
  // USER field to disappear.
  assert.deepEqual(settings.descriptors.find(entry => entry.ns === 'agent-loop')?.value, { maxParallelToolCalls: 10 })

  // The conflict is a definite Not saved and the draft revision is the fence.
  assert.equal((await loop.mutate({ maxParallelToolCalls: { kind: 'set', value: 6 } }, opened.revision, opened.generation)).kind, 'conflict')
})

test('two shell caps dispatch as ONE mutation on the captured ACTIVE row and never rewrite a sibling cap', async () => {
  const settings = makeSettings()
  const shell = new DirectShellExecutionSettingsConfig(contextWith(settings))
  const opened = shell.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const result = await shell.mutate({
    timeoutMs: { kind: 'set', value: 45_000 },
    maxOutputBytes: { kind: 'reset' },
  }, opened.revision, opened.generation, opened.effective.executor)
  assert.deepEqual(result, { kind: 'accepted' })
  assert.equal(settings.mutations.length, 1, 'both caps are one official mutate call')
  assert.deepEqual(settings.mutations[0], {
    ns: 'bash-sandbox',
    ops: [
      { op: 'set', path: ['timeoutMs'], value: 45_000 },
      { op: 'unset', path: ['maxOutputBytes'] },
    ],
    revision: 7,
  })
  assert.deepEqual(settings.descriptors.find(entry => entry.ns === 'bash-sandbox')?.value, {
    timeoutMs: 45_000,
    maxOutputBytes: 64_000,
  }, 'the reset cap reads back the inherited 64000 while the sibling set stays')
  // The executor identity is a Host observation, never an editable field.
  assert.equal((await shell.mutate({ executor: { kind: 'set', value: 'pwsh' } } as never, opened.revision, opened.generation, 'bash')).kind, 'rejected')
  // A profile that switched the active row refuses the stale page's write.
  const switched = makeSettings({ shell: 'pwsh' })
  const stale = new DirectShellExecutionSettingsConfig(contextWith(switched))
  const staleRead = stale.read()
  assert.equal(staleRead.kind, 'ready')
  if (staleRead.kind !== 'ready') return
  assert.equal((await stale.mutate({ timeoutMs: { kind: 'set', value: 1 } }, staleRead.revision, staleRead.generation, 'bash')).kind, 'rejected')
  assert.equal(switched.mutations.length, 0)
})

test('the session-log switch accepts false, and Reset may read back On without requiring USER deletion', async () => {
  const settings = makeSettings()
  const sessionLog = new DirectSessionLogUploadConfig(contextWith(settings))
  const opened = sessionLog.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.deepEqual(await sessionLog.mutate({ enabled: { kind: 'set', value: true } }, opened.revision, opened.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations.at(-1)?.ops, [{ op: 'set', path: ['enabled'], value: true }])
  // The non-volatile maxBytes field is not part of this typed write at all.
  assert.equal(settings.mutations.at(-1)?.ops.some(op => op.path[0] === 'maxBytes'), false)

  const afterOn = sessionLog.read()
  assert.equal(afterOn.kind, 'ready')
  if (afterOn.kind !== 'ready') return
  assert.deepEqual(await sessionLog.mutate({ enabled: { kind: 'reset' } }, afterOn.revision, afterOn.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations.at(-1)?.ops, [{ op: 'unset', path: ['enabled'] }])
  const readback = sessionLog.read()
  assert.equal(readback.kind, 'ready')
  if (readback.kind !== 'ready') return
  assert.equal(readback.effective.enabled, true, 'Reset reads back the official inherited value')
  assert.deepEqual(settings.descriptors.find(entry => entry.ns === 'session-log-deepseek')?.user, { enabled: true },
    'the official materialization keeps a USER field; Reset success never requires its deletion')
})

test('a replaced Host authority is refused before dispatch, and an unobservable settle is unconfirmed', async () => {
  const settings = makeSettings()
  const loop = new DirectAgentLoopSettingsConfig(contextWith(settings))
  const opened = loop.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const replacement = makeSettings()
  const replaced = new DirectAgentLoopSettingsConfig(contextWith(replacement))
  assert.equal((await replaced.mutate({ maxParallelToolCalls: { kind: 'set', value: 3 } }, opened.revision, opened.generation)).kind, 'rejected')
  assert.equal(replacement.mutations.length, 0)

  settings.mutateFailureAfterApply = new Error('loader reconciliation failed after persistence')
  const settled = await loop.mutate({ maxParallelToolCalls: { kind: 'set', value: 8 } }, opened.revision, opened.generation)
  assert.equal(settled.kind, 'outcome-unconfirmed')
  assert.deepEqual(settings.descriptors.find(entry => entry.ns === 'agent-loop')?.value, { maxParallelToolCalls: 8 },
    'the fixture really applied the edit before the failure, so the outcome cannot be called refused')
})

test('real Cordis lookups create new proxies while the section generation stays the raw service', async () => {
  const ctx = new Context()
  const backing = makeSettings()
  const raw = new CordisSettingsFixture(ctx, backing)
  const firstProxy = ctx.get('settings') as unknown as { readonly [symbols.original]?: object }
  const nextProxy = ctx.get('settings') as unknown as { readonly [symbols.original]?: object }
  assert.notEqual(firstProxy, nextProxy)
  assert.equal(firstProxy[symbols.original], raw)

  const config = new DirectAgentLoopSettingsConfig(ctx)
  const read = config.read()
  const secondRead = config.read()
  assert.equal(read.kind, 'ready')
  assert.equal(secondRead.kind, 'ready')
  if (read.kind !== 'ready' || secondRead.kind !== 'ready') return
  assert.equal(read.generation, raw)
  assert.equal(secondRead.generation, raw)
  assert.deepEqual(await config.mutate({ maxParallelToolCalls: { kind: 'set', value: 4 } }, read.revision, read.generation), { kind: 'accepted' })
})
