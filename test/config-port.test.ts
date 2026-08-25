/**
 * Adapter contract tests for the Direct config port
 * (runtime/direct/config-direct.ts, migration M1.9): the port is the
 * semantic boundary — consumers depend on `ConfigPort`, the Direct
 * adapter owns the `ctx` access AND the Host schema knowledge (the
 * `llm-pi-ai` / `permission` / `agent-presets` settings namespaces), and
 * a Remote adapter must satisfy the SAME contract in a later milestone.
 * These tests pin the contract with a fake Host context: no generic
 * settings god API leaks, secrets appear only as write parameters, and
 * missing services degrade without crashing.
 * @module @xmoon76/dsh-pi-tui/config-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DirectConfigPort, type HostContextLike } from '../src/runtime/direct/config-direct.ts'

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name], on: () => {} }
}

function settings(doc: Record<string, unknown>, writes: Array<{ ns: string; ops: unknown }> = []) {
  return {
    get: (ns: string) => doc[ns],
    mutate: async (ns: string, ops: unknown) => { writes.push({ ns, ops }) },
  }
}

function port(services: Record<string, unknown>): DirectConfigPort {
  return new DirectConfigPort(host(services), undefined, (sessionId) =>
    sessionId === 'session-live' ? { session: { id: 'session-live' } } : undefined)
}

// ── provider profiles ─────────────────────────────────────────────────────

test('providers listCredentialOptions merges the directory over PER-ENTRY sections', () => {
  const providers = port({
    settings: settings({
      'llm-pi-ai': { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } },
      'llm-deepseek': { deepseek: { apiKeyEnv: 'DEEPSEEK_LEGACY' } },
    }),
    llm: {
      listConfigurableProviders: () => [
        { provider: 'acme', displayName: 'Acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] },
        // A NON-llm-pi-ai entry: its profile lives in its OWN section.
        { provider: 'deepseek', displayName: 'DeepSeek legacy', settingsNs: 'llm-deepseek', settingsPath: ['deepseek'] },
      ],
    },
  }).providers
  const options = providers.listCredentialOptions()
  const acme = options.find(option => option.route === 'acme')
  assert.ok(acme !== undefined)
  assert.equal(acme.ref, 'ACME_KEY', 'the apiKeyEnv from the llm-pi-ai section wins')
  assert.equal(acme.configured, true)
  // The conventional llm-pi-ai providers.<route> slot is keyless-writable.
  assert.equal(acme.canProvisionProfile, true)
  const legacy = options.find(option => option.route === 'deepseek')
  assert.ok(legacy !== undefined, 'the llm-deepseek entry is read from ITS OWN section')
  assert.equal(legacy.ref, 'DEEPSEEK_LEGACY')
  assert.equal(legacy.configured, true)
  // A route whose profile lives in its OWN section has no keyless-writable
  // slot (the adapter refuses writes outside llm-pi-ai providers.<route>).
  assert.equal(legacy.canProvisionProfile, false)
  const official = options.find(option => option.route === 'deepseek-official')
  assert.ok(official !== undefined)
  assert.equal(official.canProvisionProfile, false, 'the builtin has no provider-profile slot')
  // The client DTO carries SEMANTIC flags only — no Host schema fact
  // (settings namespace/path) ever crosses the port.
  for (const option of options) {
    assert.equal('settingsNs' in option, false, 'no settings namespace on the client DTO')
    assert.equal('settingsPath' in option, false, 'no settings path on the client DTO')
  }
})

test('providers listCredentialOptions falls back to the settings-only reader without the llm service', () => {
  const providers = port({
    settings: settings({ 'llm-pi-ai': { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } } }),
  }).providers
  const options = providers.listCredentialOptions()
  assert.equal(options.length, 2, 'deepseek official + the acme route')
  assert.equal(options[0]!.route, 'deepseek-official')
  assert.equal(options[0]!.canProvisionProfile, false, 'the builtin has no keyless-writable slot')
  assert.equal(options[1]!.ref, 'ACME_KEY')
  assert.equal(options[1]!.canProvisionProfile, true, 'the settings-only fallback slot is keyless-writable')
  assert.equal(port({}).providers.available(), false)
  assert.deepEqual(port({}).providers.listCredentialOptions().map(option => option.route), ['deepseek-official'])
})

test('providers degrade when reading an unregistered settings namespace', () => {
  const providers = port({
    settings: {
      get: () => { throw new Error('namespace not registered') },
      mutate: async () => {},
    },
  }).providers
  // The settings-only fallback sees no section: only the official target.
  assert.deepEqual(providers.listCredentialOptions().map(option => option.route), ['deepseek-official'])
})

test('providers writeProfile owns the llm-pi-ai schema (the wizard never names a namespace)', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({ settings: settings({}, writes) }).providers
  await providers.writeProfile('acme', { api: 'openai-completions', baseURL: 'http://x' })
  assert.deepEqual(writes, [
    { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: { api: 'openai-completions', baseURL: 'http://x' } }] },
  ])
})

test('providers writeKeylessProfile writes an EMPTY profile at the adapter-resolved location', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: {
      listConfigurableProviders: () => [
        { provider: 'acme', displayName: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] },
      ],
    },
  }).providers
  assert.deepEqual(await providers.writeKeylessProfile('acme'), { kind: 'written' })
  assert.deepEqual(writes, [{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: {} }] }])
  // The conventional fallback slot when the llm directory is absent.
  const writes2: Array<{ ns: string; ops: unknown }> = []
  assert.deepEqual(await port({ settings: settings({}, writes2) }).providers.writeKeylessProfile('acme'), { kind: 'written' })
  assert.deepEqual(writes2, [{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: {} }] }])
})

test('providers reject malformed routes before writing a settings path', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({ settings: settings({}, writes) }).providers
  await assert.rejects(() => providers.writeKeylessProfile('../escape'), /invalid provider route/)
  await assert.rejects(() => providers.writeProfile('acme/escape', {}), /invalid provider route/)
  assert.deepEqual(writes, [])
})

test('providers refuse a keyless write for the deepseek official BUILTIN (no profile slot, even in the settings-only fallback)', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({ settings: settings({}, writes) }).providers
  // Without the llm service the conventional slot would otherwise accept
  // ANY route — the builtin must be refused explicitly so the write
  // outcome always agrees with the option DTO's canProvisionProfile.
  assert.deepEqual(await providers.writeKeylessProfile('deepseek-official'), {
    kind: 'skipped',
    reason: 'the deepseek official builtin has no provider-profile slot',
  })
  assert.deepEqual(writes, [], 'the builtin never reaches a settings mutate')
  // A real route keeps the conventional fallback write.
  const writes2: Array<{ ns: string; ops: unknown }> = []
  assert.deepEqual(await port({ settings: settings({}, writes2) }).providers.writeKeylessProfile('acme'), { kind: 'written' })
  assert.deepEqual(writes2, [{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: {} }] }])
})

test('providers never advertise a keyless slot for an INVALID route (the flag agrees with the write refusal)', async () => {
  // A hostile directory entry with a route that fails the provider-route
  // pattern: the write would refuse it, so the DTO must not advertise a
  // writable slot (one shared rule drives both).
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: {
      listConfigurableProviders: () => [
        { provider: '../escape', displayName: 'Esc', settingsNs: 'llm-pi-ai', settingsPath: ['providers', '../escape'] },
      ],
    },
  }).providers
  assert.equal(providers.listCredentialOptions().find(option => option.route === '../escape')?.canProvisionProfile, false)
  await assert.rejects(() => providers.writeKeylessProfile('../escape'), /invalid provider route/)
  assert.deepEqual(writes, [])
  // The settings-only fallback too: a hostile providers dict key fails the
  // same rule — never advertised as writable.
  const writes2: Array<{ ns: string; ops: unknown }> = []
  const fallback = port({
    settings: settings({ 'llm-pi-ai': { providers: { '../escape': { apiKeyEnv: 'X' } } } }, writes2),
  }).providers
  assert.equal(fallback.listCredentialOptions().find(option => option.route === '../escape')?.canProvisionProfile, false)
})

test('providers writeKeylessProfile refuses when the settings service is absent (never a silent no-op)', async () => {
  await assert.rejects(() => port({}).providers.writeKeylessProfile('acme'), /settings service unavailable/)
})

test('providers writeKeylessProfile refuses a hostile directory entry (namespace/path redirect)', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: {
      listConfigurableProviders: () => [
        // A malformed/hostile directory entry redirecting the write
        // outside the adapter-owned provider-config schema.
        { provider: 'acme', displayName: 'acme', settingsNs: 'any-namespace', settingsPath: ['evil', 'path'] },
      ],
    },
  }).providers
  assert.deepEqual(await providers.writeKeylessProfile('acme'), { kind: 'skipped', reason: 'hostile or malformed directory entry for acme' })
  assert.deepEqual(writes, [], 'hostile directory metadata can never reach a mutate')
  // The option DTO says the SAME thing: a route whose directory entry is
  // not a conventional llm-pi-ai providers.<route> slot is not
  // keyless-writable (one shared rule drives the flag and the write).
  assert.equal(providers.listCredentialOptions().find(option => option.route === 'acme')?.canProvisionProfile, false)
  const writes2: Array<{ ns: string; ops: unknown }> = []
  const providers2 = port({
    settings: settings({}, writes2),
    llm: {
      listConfigurableProviders: () => [
        { provider: 'acme', displayName: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'OTHER-ROUTE'] },
      ],
    },
  }).providers
  assert.deepEqual(await providers2.writeKeylessProfile('acme'), { kind: 'skipped', reason: 'hostile or malformed directory entry for acme' })
  assert.deepEqual(writes2, [], 'a path whose leaf is NOT the route is refused')
})

test('providers writeKeylessProfile writes NOTHING when the route vanished from the directory', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: { listConfigurableProviders: () => [] },
  }).providers
  assert.deepEqual(await providers.writeKeylessProfile('acme'), { kind: 'skipped', reason: 'no configurable-provider entry for acme' })
  assert.deepEqual(writes, [], 'a directory race must never fall back to a guessed slot')
})

test('config DTOs are DETACHED — mutating a returned value never aliases Host data', async () => {
  const records = [{ key: 'llm-pi-ai/openai', kind: 'oauth' }]
  const flows = [
    { key: 'llm-pi-ai/openai', label: 'openai', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  const config = port({
    credentials: {
      set: async () => {},
      unset: async () => {},
      deleteRecord: async () => {},
      describe: async () => ({ configured: true, source: 'env' }),
      listRecords: async () => records,
    },
    authorization: {
      list: () => flows,
      begin: async () => ({ status: 'authorized' }),
    },
    permissionPresets: { get names() { return ['workspace-write'] } },
    settings: settings({ 'llm-pi-ai': { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } } }),
  })
  const recordsOut = await config.credentials.listRecords()
  ;(recordsOut as Array<{ key: string }>)[0]!.key = 'MUTATED'
  assert.equal(records[0]!.key, 'llm-pi-ai/openai', 'the credential records are never aliased')
  const targets = config.authorization.listTargets()
  ;(targets[0]!.methods as unknown as Array<{ id: string }>)[0]!.id = 'MUTATED'
  assert.equal(flows[0]!.methods[0]!.id, 'oauth', 'the flow methods are never aliased')
  const names = config.permissions.presetNames()
  ;(names as string[])[0] = 'MUTATED'
  assert.deepEqual(flows.length > 0 ? [] : [], [])
  const options = config.providers.listCredentialOptions()
  const acme = options.find(option => option.route === 'acme')
  assert.ok(acme !== undefined)
  // The client DTO never carries a Host schema fact (namespace/path).
  assert.equal('settingsNs' in acme, false)
  assert.equal('settingsPath' in acme, false)
  // The DTO is detached: mutating the returned option never reaches the
  // Host section (the settings fake holds the live document).
  ;(acme as { ref: string }).ref = 'MUTATED'
  const again = config.providers.listCredentialOptions()
  assert.equal(again.find(option => option.route === 'acme')!.ref, 'ACME_KEY', 'the merged options are never aliased')
})

// ── credentials ───────────────────────────────────────────────────────────

test('credentials forward set/unset/delete/describe/list and never echo secrets in reads', async () => {
  const calls: string[] = []
  const credentials = port({
    credentials: {
      set: async (ref: string) => { calls.push(`set:${ref}`) },
      unset: async (ref: string) => { calls.push(`unset:${ref}`) },
      deleteRecord: async (key: string) => { calls.push(`delete:${key}`) },
      describe: async (ref: string) => ({ configured: ref === 'DEEPSEEK_API_KEY', source: 'env' }),
      listRecords: async () => [{ key: 'llm-pi-ai/openai', kind: 'oauth' }],
    },
  }).credentials
  assert.equal(credentials.available(), true)
  await credentials.setReference('DEEPSEEK_API_KEY', 'sk-secret')
  await credentials.unsetReference('DEEPSEEK_API_KEY')
  await credentials.deleteRecord('llm-pi-ai/openai')
  assert.deepEqual(calls, ['set:DEEPSEEK_API_KEY', 'unset:DEEPSEEK_API_KEY', 'delete:llm-pi-ai/openai'])
  assert.deepEqual(await credentials.describeReference('DEEPSEEK_API_KEY'), { configured: true, source: 'env' })
  assert.deepEqual(await credentials.listRecords(), [{ key: 'llm-pi-ai/openai', kind: 'oauth' }])
})

test('credentials degrade when the service is absent', async () => {
  const credentials = port({}).credentials
  assert.equal(credentials.available(), false)
  assert.deepEqual(await credentials.describeReference('X'), { configured: false })
  assert.deepEqual(await credentials.listRecords(), [])
  await assert.rejects(() => credentials.setReference('X', 'secret'), /unavailable/)
})

// ── authorization ─────────────────────────────────────────────────────────

test('authorization listTargets maps the seam entries to detached targets', () => {
  const authorization = port({
    authorization: {
      list: () => [
        { key: 'llm-pi-ai/openai', label: 'openai', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: true },
        { key: 'other/key', label: 'other', methods: [{ id: 'm', label: 'M' }], inFlight: false },
      ],
      begin: async () => ({ status: 'authorized' }),
    },
  }).authorization
  assert.equal(authorization.available(), true)
  const targets = authorization.listTargets()
  assert.equal(targets.length, 2)
  assert.equal(targets[0]!.route, 'openai', 'llm-pi-ai scope maps to the route')
  assert.equal(targets[0]!.inFlight, true)
  assert.equal(targets[1]!.route, undefined, 'foreign scopes carry no route')
})

test('authorization begins one flow as an EVENT surface and degrades when absent', async () => {
  const begins: string[] = []
  const events: import('../src/runtime/config-port.ts').AuthorizationFlowEvent[] = []
  const authorization = port({
    authorization: {
      list: () => [],
      begin: async (request: {
        key: string
        interaction: {
          notify: (n: unknown) => void
          prompt: (prompt: { kind: string; message: string; signal?: AbortSignal }) => Promise<string>
        }
      }) => {
        begins.push(request.key)
        // The adapter bridges the upstream interaction into detached
        // events: a notice, then a prompt awaiting the human's answer.
        request.interaction.notify({ message: 'progress' })
        const answer = await request.interaction.prompt({ kind: 'text', message: 'enter' })
        return { status: answer === 'typed' ? 'authorized' as const : 'cancelled' as const }
      },
    },
  }).authorization
  const off = authorization.onEvent((event) => { events.push(event) })
  const started = await authorization.begin({ key: 'llm-pi-ai/openai' })
  assert.equal(started.kind, 'started')
  assert.equal(begins.length, 1)
  await settle()
  // Answer the bridged prompt with the REAL attempt/prompt ids the
  // adapter emitted (the upstream flow awaits the answer).
  const promptEvent = events.find(event => event.kind === 'prompt')
  assert.ok(promptEvent !== undefined && promptEvent.kind === 'prompt')
  const attemptId = promptEvent.attemptId
  const promptId = promptEvent.promptId
  await authorization.respond(attemptId, promptId, 'typed')
  await settle()
  off()
  assert.ok(events.some(event => event.kind === 'notice' && event.notice.message === 'progress'), 'the notice flows as an event')
  assert.ok(events.some(event => event.kind === 'prompt' && event.prompt.kind === 'text'), 'the prompt flows as an event')
  assert.ok(events.some(event => event.kind === 'settled' && event.status === 'authorized'), 'the settlement flows as an event')
  assert.equal(port({}).authorization.available(), false)
  assert.deepEqual(port({}).authorization.listTargets(), [])
  assert.deepEqual(await port({}).authorization.begin({ key: 'x' }), { kind: 'unavailable' })
  assert.deepEqual(await authorization.cancel('attempt-1'), undefined)
})

test('authorization bridges an ALREADY-ABORTED prompt signal as a non-decline withdrawal', async () => {
  // The flow may withdraw a prompt before the bridge even registers (its
  // signal already aborted): the bridge must reject its pending promise
  // and surface prompt-withdrawn IMMEDIATELY — never leave the promise
  // unresolved until some later abort event (which never comes).
  const controller = new AbortController()
  controller.abort(new Error('losing race'))
  const events: import('../src/runtime/config-port.ts').AuthorizationFlowEvent[] = []
  const authorization = port({
    authorization: {
      list: () => [],
      begin: async (request: {
        key: string
        interaction: {
          notify: (n: unknown) => void
          prompt: (prompt: { kind: string; message: string; signal?: AbortSignal }) => Promise<string>
        }
      }) => {
        try {
          await request.interaction.prompt({ kind: 'text', message: 'enter', signal: controller.signal })
          return { status: 'authorized' as const }
        } catch (error) {
          // The bridge rejection is a NON-decline cancellation.
          assert.notEqual((error as { name?: string }).name, 'AuthorizationDeclinedError')
          return { status: 'cancelled' as const }
        }
      },
    },
  }).authorization
  const off = authorization.onEvent((event) => { events.push(event) })
  const started = await authorization.begin({ key: 'llm-pi-ai/openai' })
  assert.equal(started.kind, 'started')
  await settle()
  off()
  const withdrawn = events.find(event => event.kind === 'prompt-withdrawn')
  assert.ok(withdrawn !== undefined, 'the already-aborted prompt surfaces prompt-withdrawn')
  assert.ok(events.some(event => event.kind === 'settled' && event.status === 'cancelled'), 'the withdrawal settles the attempt')
})

test('authorization cancel() rejects pending prompt bridges IMMEDIATELY', async () => {
  // A cancel must not leave the client's prompt UI hanging until the
  // upstream settles: the pending bridge promise rejects right away.
  const events: import('../src/runtime/config-port.ts').AuthorizationFlowEvent[] = []
  let promptSettled = false
  const authorization = port({
    authorization: {
      list: () => [],
      begin: async (request: {
        key: string
        interaction: {
          notify: (n: unknown) => void
          prompt: (prompt: { kind: string; message: string; signal?: AbortSignal }) => Promise<string>
        }
      }) => {
        // The upstream flow awaits the prompt forever (it never honors
        // its signal); only the bridge rejection releases it.
        try {
          await request.interaction.prompt({ kind: 'text', message: 'enter' })
          promptSettled = true
          return { status: 'authorized' as const }
        } catch {
          promptSettled = true
          return { status: 'cancelled' as const }
        }
      },
    },
  }).authorization
  const off = authorization.onEvent((event) => { events.push(event) })
  const started = await authorization.begin({ key: 'llm-pi-ai/openai' })
  assert.equal(started.kind, 'started')
  await settle()
  const promptEvent = events.find(event => event.kind === 'prompt')
  assert.ok(promptEvent !== undefined && promptEvent.kind === 'prompt')
  await authorization.cancel(promptEvent.attemptId)
  await settle()
  off()
  assert.equal(promptSettled, true, 'cancel rejects the pending bridge immediately (the upstream await releases)')
})

test('authorization cancel() emits prompt-withdrawn so the UI closes even if the flow never settles', async () => {
  // A cancel must close the client's prompt UI EVEN IF the upstream flow
  // ignores its abort signal and never settles: the adapter emits the
  // withdrawal event itself, never waiting on the upstream settlement.
  const events: import('../src/runtime/config-port.ts').AuthorizationFlowEvent[] = []
  let promptSettled = false
  const authorization = port({
    authorization: {
      list: () => [],
      begin: async (request: {
        key: string
        interaction: {
          notify: (n: unknown) => void
          prompt: (prompt: { kind: string; message: string; signal?: AbortSignal }) => Promise<string>
        }
      }) => {
        // The upstream flow NEVER settles (a wedged/ignored abort); only
        // the bridge rejection releases the prompt await, and even then
        // no `settled` event is emitted.
        try {
          await request.interaction.prompt({ kind: 'text', message: 'enter' })
          promptSettled = true
        } catch {
          promptSettled = true
        }
        return await new Promise<{ status: 'authorized' }>(() => {}) // never settles
      },
    },
  }).authorization
  const off = authorization.onEvent((event) => { events.push(event) })
  const started = await authorization.begin({ key: 'llm-pi-ai/openai' })
  assert.equal(started.kind, 'started')
  await settle()
  const promptEvent = events.find(event => event.kind === 'prompt')
  assert.ok(promptEvent !== undefined && promptEvent.kind === 'prompt')
  await authorization.cancel(promptEvent.attemptId)
  await settle()
  off()
  assert.equal(promptSettled, true, 'cancel rejects the pending bridge immediately')
  const withdrawn = events.find(event => event.kind === 'prompt-withdrawn'
    && event.attemptId === promptEvent.attemptId && event.promptId === promptEvent.promptId)
  assert.ok(withdrawn !== undefined,
    `cancel must emit prompt-withdrawn for the open prompt (the UI closes without a settled event):\n${JSON.stringify(events)}`)
})

test('a caller-signal abort with a NEVER-SETTLING provider finalizes the attempt (no retention)', async () => {
  // The provider drives a prompt and then IGNORES its signal forever. The
  // caller-signal abort must route through the SAME idempotent
  // finalization as cancel(): reject the pending bridge, emit
  // prompt-withdrawn, dispose the caller-abort listener and remove the
  // attempt — a provider that never settles cannot retain the attempt,
  // the controller or the listener (repeated aborted logins leave
  // nothing behind).
  const events: import('../src/runtime/config-port.ts').AuthorizationFlowEvent[] = []
  let promptSettled = false
  const controller = new AbortController()
  let adds = 0
  let removes = 0
  const signal = controller.signal
  const originalAdd = signal.addEventListener.bind(signal)
  const originalRemove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') adds += 1
    return originalAdd(type as 'abort', listener as () => void, options as boolean | EventListenerOptions | undefined)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') removes += 1
    return originalRemove(type as 'abort', listener as () => void, options as boolean | EventListenerOptions | undefined)
  }) as typeof signal.removeEventListener
  const authorization = port({
    authorization: {
      list: () => [],
      begin: async (request: {
        key: string
        interaction: {
          notify: (n: unknown) => void
          prompt: (prompt: { kind: string; message: string; signal?: AbortSignal }) => Promise<string>
        }
      }) => {
        // The upstream flow NEVER settles, even when its signal aborts.
        try {
          await request.interaction.prompt({ kind: 'text', message: 'enter' })
          promptSettled = true
        } catch {
          promptSettled = true
        }
        return await new Promise<{ status: 'authorized' }>(() => {}) // never settles
      },
    },
  }).authorization
  const off = authorization.onEvent((event) => { events.push(event) })
  const started = await authorization.begin({ key: 'llm-pi-ai/openai', signal })
  assert.equal(started.kind, 'started')
  await settle()
  const promptEvent = events.find(event => event.kind === 'prompt')
  assert.ok(promptEvent !== undefined && promptEvent.kind === 'prompt')
  controller.abort() // runner teardown: the provider never settles
  await settle()
  off()
  assert.equal(promptSettled, true, 'the pending bridge rejected on the caller abort')
  const withdrawn = events.find(event => event.kind === 'prompt-withdrawn'
    && event.attemptId === promptEvent.attemptId && event.promptId === promptEvent.promptId)
  assert.ok(withdrawn !== undefined,
    `the caller abort must emit prompt-withdrawn (the UI closes):\n${JSON.stringify(events)}`)
  assert.equal(adds, 1, 'one caller-abort listener registered')
  assert.equal(removes, 1, 'the finalization disposed it — no leak on the long-lived signal')
})

/** Flush the microtask queue (the event bridge is promise-based). */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { resolve() })
  await new Promise<void>((resolve) => { resolve() })
}

// ── permissions ───────────────────────────────────────────────────────────

test('permissions read names and the persisted default, and persist the default', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const permissions = port({
    permissionPresets: { get names() { return ['workspace-write', 'danger-full-access'] } },
    settings: settings({ permission: { defaultPreset: 'workspace-write' } }, writes),
  }).permissions
  assert.deepEqual(permissions.presetNames(), ['workspace-write', 'danger-full-access'])
  assert.equal(permissions.defaultPreset(), 'workspace-write')
  await permissions.setDefaultPreset('danger-full-access')
  assert.deepEqual(writes, [{ ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }] }])
  assert.equal(port({}).permissions.defaultPreset(), undefined, 'no settings -> no default')
})

test('applyPermissionPreset runs the OFFICIAL command line through the resolved agent', async () => {
  const executed: Array<{ line: string }> = []
  const permissions = port({
    permissionPresets: { get names() { return ['workspace-write', 'danger-full-access'] } },
    commands: {
      execute: async (_agent: unknown, line: string) => { executed.push({ line }); return { ok: true } },
    },
  }).permissions
  assert.deepEqual(await permissions.applyPermissionPreset('session-live', 'danger-full-access'), { kind: 'applied' })
  assert.deepEqual(executed, [{ line: '/permission danger-full-access' }])
  assert.deepEqual(await permissions.applyPermissionPreset('session-other', 'danger-full-access'), { kind: 'unavailable', cause: 'permission' })
  assert.deepEqual(await port({}).permissions.applyPermissionPreset('session-live', 'danger-full-access'), { kind: 'unavailable', cause: 'commands' })
})

test('applyPermissionPreset refuses a preset id the composed table does not offer', async () => {
  let executed = 0
  const permissions = port({
    permissionPresets: { get names() { return ['workspace-write'] } },
    commands: {
      execute: async () => { executed += 1; return { ok: true } },
    },
  }).permissions
  assert.deepEqual(
    await permissions.applyPermissionPreset('session-live', 'danger-full-access; rm -rf /'),
    { kind: 'unavailable', cause: 'permission' },
    'a hostile id never reaches the command line',
  )
  assert.equal(executed, 0)
})

// ── preset default ────────────────────────────────────────────────────────

test('presetDefault reads the settings doc with the roster default fallback and persists', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const presetDefault = port({
    settings: settings({ 'agent-presets': { default: 'code' } }, writes),
    agentPresets: { get defaultId() { return 'standard' } },
  }).presetDefault
  assert.equal(presetDefault.available(), true)
  assert.equal(presetDefault.get(), 'code', 'the saved value wins')
  await presetDefault.set('minimal')
  assert.deepEqual(writes, [{ ns: 'agent-presets', ops: [{ op: 'set', path: ['default'], value: 'minimal' }] }])
})

test('presetDefault falls back to the roster default and degrades without settings', () => {
  const presetDefault = port({
    settings: settings({}),
    agentPresets: { get defaultId() { return 'standard' } },
  }).presetDefault
  assert.equal(presetDefault.get(), 'standard')
  assert.equal(port({}).presetDefault.available(), false)
  assert.equal(port({}).presetDefault.get(), undefined)
})

// ── event wiring ──────────────────────────────────────────────────────────

test('credential onChanged subscribes both reference- and record-updated', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  new DirectConfigPort(ctx as never, undefined, () => undefined)
    .credentials.onChanged(() => { refreshes.push('refresh') })
  ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY' as never)
  ctx.emit('credentials/record-updated', 'llm-pi-ai/openai' as never)
  await Promise.resolve()
  assert.deepEqual(refreshes, ['refresh', 'refresh'])
})

test('credential onChanged returns a disposer (a remount never accumulates listeners)', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  const dispose = new DirectConfigPort(ctx as never, undefined, () => undefined)
    .credentials.onChanged(() => { refreshes.push('refresh') })
  ctx.emit('credentials/reference-updated', 'OPENAI_API_KEY' as never)
  await Promise.resolve()
  assert.equal(refreshes.length, 1)
  dispose()
  ctx.emit('credentials/reference-updated', 'OPENAI_API_KEY' as never)
  ctx.emit('credentials/record-updated', 'llm-pi-ai/openai' as never)
  await Promise.resolve()
  assert.deepEqual(refreshes, ['refresh'], 'after dispose no credential event reaches the listener')
})
