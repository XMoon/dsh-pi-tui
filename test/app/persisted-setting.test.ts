/**
 * R8-E PR-4: the persisted-setting adapter's exact semantic contract.
 *
 * These are pure/structural cases for owner resolution, Host Config field
 * projection and the ONE CAS writer. The real Direct/Remote ConfigPort parity
 * and the real generated-Client chain are covered by the neighbouring
 * `test/runtime/parity/extension-config-parity.test.ts` and
 * `test/integration/extension-config-settings-pr2.test.ts` suites.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commitPersistedSetting,
  readPersistedSetting,
  resolvePersistedSettingOwner,
  type PersistedSettingRecord,
} from '../../src/app/client-extensions/persisted-setting.ts'
import type { ExtensionConfigDataOp, ExtensionConfigRead, ExtensionConfigsConfig, SectionMutationOutcome } from '../../src/runtime/config-port.ts'
import type { ClientExtensionObservation } from '../../src/app/client-extensions/mount-owner.ts'

function record(): PersistedSettingRecord {
  return {
    id: 'p1',
    owner: '10:plugin-a',
    registrationToken: 3,
    mode: 'persisted',
    currentValue: 'alpha',
    persisted: {
      path: ['label'],
      choices: [
        { id: 'alpha', op: 'set', value: 'alpha' },
        { id: 'omega', op: 'set', value: 'omega' },
        { id: 'inherit', op: 'unset' },
      ],
    },
  }
}

function activeObservation(entryId = 'pi-tui-client-a'): ClientExtensionObservation {
  return { packageName: '@r8-pr1-fixture/a', phase: 'active', entryId }
}

class FakeConfig implements ExtensionConfigsConfig {
  effective: unknown = { label: 'alpha' }
  inherited: unknown = { label: 'alpha' }
  user: unknown = {}
  revision = 4
  generation: object = { host: 1 }
  /** Simulate a Host/Connection replacement between mutation settle and the
   *  consumer's final readback. */
  generationAfterMutation: object | undefined
  /** Simulate the official Split JSON RPC carrier, which serializes -0 as 0. */
  jsonRoundTripMutations = false
  readonly mutations: { packageName: string; ops: readonly ExtensionConfigDataOp[]; revision: number }[] = []
  mutation: 'accepted' | 'conflict' | 'rejected' | 'outcome-unconfirmed' = 'accepted'
  readKind: 'ready' | 'stale' | 'unavailable' | 'unreadable' = 'ready'
  readReason = 'not current'

  read(packageName: string): ExtensionConfigRead {
    if (this.readKind !== 'ready') return { kind: this.readKind, reason: this.readReason }
    return {
      kind: 'ready',
      packageName,
      generation: this.generation,
      revision: this.revision,
      effective: this.effective,
      inherited: this.inherited,
      user: this.user,
      userDataPresent: Object.keys(this.user as object).length > 0,
    }
  }

  async refresh(): Promise<void> {}

  async mutate(packageName: string, ops: readonly ExtensionConfigDataOp[], revision: number): Promise<SectionMutationOutcome> {
    this.mutations.push({ packageName, ops, revision })
    if (this.mutation === 'conflict') return { kind: 'conflict', reason: 'revision changed' }
    if (this.mutation === 'rejected') return { kind: 'rejected', reason: 'Host refused the field' }
    if (this.mutation === 'outcome-unconfirmed') {
      return { kind: 'outcome-unconfirmed', reason: 'transport cancelled after dispatch' }
    }
    const user = structuredClone(this.user) as Record<string, unknown>
    const op = ops[0]!
    if (op.op === 'set') {
      user[op.path[0]!] = this.jsonRoundTripMutations
        ? JSON.parse(JSON.stringify(op.value)) as unknown
        : op.value
    } else {
      // Official ConfigEditor: unset restores the inherited effective value;
      // a sibling USER override keeps the leaf present, otherwise it deletes.
      const inherited = (this.inherited as Record<string, unknown>)[op.path[0]!]
      if (inherited === undefined) delete user[op.path[0]!]
      else user[op.path[0]!] = structuredClone(inherited)
    }
    this.user = user
    this.effective = { ...(this.inherited as Record<string, unknown>), ...user }
    this.revision += 1
    if (this.generationAfterMutation !== undefined) this.generation = this.generationAfterMutation
    return { kind: 'accepted' }
  }
}

test('persisted owner resolution: only a live owner -> unique ACTIVE Client entry is writable', () => {
  const ownerEntryIds = new Map([['10:plugin-a', 'pi-tui-client-a']])
  const resolved = resolvePersistedSettingOwner(record(), ownerEntryIds, [activeObservation()])
  assert.deepEqual(resolved, {
    kind: 'ready',
    packageName: '@r8-pr1-fixture/a',
    entryId: 'pi-tui-client-a',
    registrationToken: 3,
  })
  assert.equal(resolvePersistedSettingOwner(record(), new Map(), [activeObservation()]).kind, 'unavailable')
  assert.equal(resolvePersistedSettingOwner(record(), ownerEntryIds, [{ ...activeObservation(), phase: 'error' }]).kind, 'unavailable')
  assert.equal(resolvePersistedSettingOwner(record(), ownerEntryIds, [activeObservation(), activeObservation()]).kind, 'unavailable')
  // A runtime-only record never resolves through the persisted path.
  assert.equal(resolvePersistedSettingOwner({ ...record(), mode: 'runtime', persisted: undefined }, ownerEntryIds, [activeObservation()]).kind, 'unavailable')
})

test('persisted read projects EFFECTIVE/INHERITED/USER leaves without fabricating a default', () => {
  const config = new FakeConfig()
  const read = readPersistedSetting(record(), '@r8-pr1-fixture/a', config)
  assert.equal(read.mode, 'ready')
  if (read.mode !== 'ready') return
  assert.equal(read.effective, 'alpha')
  assert.equal(read.inherited, 'alpha')
  assert.equal(read.user, undefined)
  assert.equal(read.userFieldPresent, false)
  assert.equal(read.overriddenDisplay, 'No')
  assert.equal(read.candidateId, 'inherit')
  assert.equal(read.revision, 4)

  config.user = { label: 'omega' }
  config.effective = { label: 'omega' }
  const userRead = readPersistedSetting(record(), '@r8-pr1-fixture/a', config)
  assert.equal(userRead.mode, 'ready')
  if (userRead.mode !== 'ready') return
  assert.equal(userRead.userFieldPresent, true)
  assert.equal(userRead.user, 'omega')
  assert.equal(userRead.candidateId, 'omega')
  assert.equal(userRead.overriddenDisplay, 'Yes')

  // A USER value is not the effective authority. An external higher-precedence
  // override must leave every declared choice unselected even when the USER
  // field still carries a declared value.
  config.user = { label: 'omega' }
  config.effective = { label: 'gamma' }
  const externalWithUser = readPersistedSetting(record(), '@r8-pr1-fixture/a', config)
  assert.equal(externalWithUser.mode, 'ready')
  if (externalWithUser.mode !== 'ready') return
  assert.equal(externalWithUser.effective, 'gamma')
  assert.equal(externalWithUser.user, 'omega')
  assert.equal(externalWithUser.candidateId, undefined)
  assert.equal(externalWithUser.overriddenDisplay, 'Yes')

  config.user = {}
  const externalWithoutUser = readPersistedSetting(record(), '@r8-pr1-fixture/a', config)
  assert.equal(externalWithoutUser.mode, 'ready')
  if (externalWithoutUser.mode !== 'ready') return
  assert.equal(externalWithoutUser.effective, 'gamma')
  assert.equal(externalWithoutUser.userFieldPresent, false)
  assert.equal(externalWithoutUser.candidateId, undefined)

  config.readKind = 'stale'
  assert.deepEqual(readPersistedSetting(record(), '@r8-pr1-fixture/a', config), { mode: 'stale', reason: 'not current' })
})

test('persisted read uses own-property traversal and never invokes accessors', () => {
  const config = new FakeConfig()
  let accessed = false
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'label', {
    enumerable: true,
    get: () => { accessed = true; return 'gotcha' },
  })
  config.user = hostile
  const read = readPersistedSetting(record(), '@r8-pr1-fixture/a', config)
  assert.equal(accessed, false)
  assert.equal(read.mode, 'ready')
  if (read.mode !== 'ready') return
  assert.equal(read.userFieldPresent, false)
})

test('persisted commit sends exactly ONE CAS mutation and verifies the authoritative readback', async () => {
  const config = new FakeConfig()
  const recordValue = record()
  const owner = { packageName: '@r8-pr1-fixture/a', entryId: 'pi-tui-client-a', registrationToken: 3 }
  const verified = await commitPersistedSetting(recordValue, owner, 'omega', config, 4, config.generation)
  assert.deepEqual(verified, { outcome: 'verified' })
  assert.equal(config.mutations.length, 1)
  assert.deepEqual(config.mutations[0], {
    packageName: '@r8-pr1-fixture/a',
    ops: [{ op: 'set', path: ['label'], value: 'omega' }],
    revision: 4,
  })
  assert.equal(readPersistedSetting(recordValue, '@r8-pr1-fixture/a', config).mode, 'ready')

  // Reset is one official unset of the SAME sub-path, never a whole-data write.
  config.user = { label: 'omega' }
  config.revision += 1
  const reset = await commitPersistedSetting(recordValue, owner, 'inherit', config, config.revision, config.generation)
  assert.deepEqual(reset, { outcome: 'verified' })
  assert.deepEqual(config.mutations[1]?.ops, [{ op: 'unset', path: ['label'] }])
})

test('persisted current/commit use JSON scalar equality for signed zero', async () => {
  const config = new FakeConfig()
  config.jsonRoundTripMutations = true
  config.inherited = { label: 'alpha' }
  config.effective = { label: 0 }
  config.user = { label: -0 }
  const zeroRecord: PersistedSettingRecord = {
    ...record(),
    id: 'zero',
    currentValue: '-0',
    persisted: {
      path: ['label'],
      choices: [
        { id: 'zero', op: 'set', value: -0 },
        { id: 'inherit', op: 'unset' },
      ],
    },
  }
  const read = readPersistedSetting(zeroRecord, '@r8-pr1-fixture/a', config)
  assert.equal(read.mode, 'ready')
  if (read.mode !== 'ready') return
  assert.equal(read.candidateId, 'zero', 'the official RPC carrier normalizes -0 to 0; both are the same JSON scalar')
  const owner = { packageName: '@r8-pr1-fixture/a', entryId: 'pi-tui-client-a', registrationToken: 3 }
  assert.deepEqual(
    await commitPersistedSetting(zeroRecord, owner, 'zero', config, read.revision, read.generation),
    { outcome: 'verified' },
  )
  assert.equal(config.mutations.length, 1)
  assert.equal((config.user as Record<string, unknown>).label, 0)
})

test('persisted commit never verifies a second readback from a replaced Host generation', async () => {
  const config = new FakeConfig()
  config.generationAfterMutation = { host: 2 }
  const owner = { packageName: '@r8-pr1-fixture/a', entryId: 'pi-tui-client-a', registrationToken: 3 }
  assert.deepEqual(
    await commitPersistedSetting(record(), owner, 'omega', config, 4, config.generation),
    { outcome: 'indeterminate', reason: 'the Host authority changed before verification; refresh before trying again' },
  )
  // The PORT already performed its own generation-checked mutation; this
  // consumer never retries or attributes the value to the old Host.
  assert.equal(config.mutations.length, 1)
})

test('persisted commit refuses stale registration/revision and never retries unconfirmed writes', async () => {
  const config = new FakeConfig()
  const recordValue = record()
  const owner = { packageName: '@r8-pr1-fixture/a', entryId: 'pi-tui-client-a', registrationToken: 3 }
  // Stale registration token.
  assert.equal((await commitPersistedSetting(recordValue, { ...owner, registrationToken: 2 }, 'omega', config, 4, config.generation)).outcome, 'not-saved')
  // Stale captured revision: refused BEFORE any dispatch.
  assert.equal((await commitPersistedSetting(recordValue, owner, 'omega', config, 3, config.generation)).outcome, 'not-saved')
  assert.equal(config.mutations.length, 0)
  // Unknown candidate.
  assert.equal((await commitPersistedSetting(recordValue, owner, 'missing', config, 4, config.generation)).outcome, 'not-saved')
  // Dispatched-but-unconfirmed must stay indeterminate and must not retry.
  config.mutation = 'outcome-unconfirmed'
  assert.deepEqual(
    await commitPersistedSetting(recordValue, owner, 'omega', config, 4, config.generation),
    { outcome: 'indeterminate', reason: 'transport cancelled after dispatch' },
  )
  assert.equal(config.mutations.length, 1)
  // A Host conflict is a definite not-saved with the frozen refresh wording.
  config.mutation = 'conflict'
  assert.deepEqual(
    await commitPersistedSetting(recordValue, owner, 'omega', config, 4, config.generation),
    { outcome: 'not-saved', reason: 'Host Config changed; refresh and review' },
  )
})
