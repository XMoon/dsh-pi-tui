/**
 * M4 PR4 external-review P2 — a persisted configuration write started by a
 * SESSIONLESS local command (`/preset default <id>`, `/settings`, `/login`, …)
 * must keep the Client reload gate closed until its own terminal settlement.
 *
 * The test wires the REAL owners:
 * - the REAL `RemoteConfigPort` over a structural fake of the official
 *   generated settings/credentials remotes (the fake is the TEST's Host
 *   boundary; the adapter's write sinks and write lifetime are production code);
 * - the REAL `/reload-client` command definition, registered through the REAL
 *   `ClientCommandRegistry` admission;
 * - the REAL `createClientReloadCommandRequest` owner the composition root
 *   installs, reading the config port's accepted-write lifetime exactly like
 *   `app/bootstrap.ts`.
 *
 * A HELD settings write therefore reaches the SAME gate the split Client uses,
 * and the refusal/acceptance are the command's own fixed outcomes. A read-only
 * describe never registers, so a `/reload` catalog/settings refresh does not
 * block itself out.
 *
 * @module @xmoon76/dsh-pi-tui/client-reload-config-write.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createClientReloadCommandRequest } from '../../src/app/command/client-reload.ts'
import { CLIENT_RELOAD_REFUSAL_NOTICES, registerReloadClientCommand } from '../../src/tui/commands/utility.ts'
import {
  RemoteConfigPort,
  type RemoteConfigRuntimeSource,
  type RemoteSettingsNamespaceView,
} from '../../src/runtime/remote/config-remote.ts'
import type { RemoteResultLike } from '../../src/runtime/remote/session-writer-remote.ts'

/** One accepted write the test holds open at the fake Host boundary. */
interface HeldWrite {
  /** Resolves when the port actually dispatched the write. */
  readonly entered: Promise<void>
  /** Mark the fake Host as having entered the write (test-side call). */
  noteEntered(): void
  /** Resolves with the outcome the fake Host returns once released. */
  readonly settled: Promise<'ok' | 'fail'>
  release(outcome?: 'ok' | 'fail'): void
}

function heldWrite(): HeldWrite {
  let enter!: () => void
  let release!: (outcome: 'ok' | 'fail') => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const settled = new Promise<'ok' | 'fail'>((resolve) => { release = resolve })
  let released = false
  return {
    entered,
    noteEntered: () => { enter() },
    settled,
    release: (outcome = 'ok') => {
      if (released) throw new Error('the held write was released twice')
      released = true
      release(outcome)
    },
  }
}

function namespaceView(ns: string, revision: number): RemoteSettingsNamespaceView {
  return { ns, value: {}, user: {}, revision }
}

const GENERATION = {}
const NO_ACKNOWLEDGING = (): void => {}

/** The structural Host boundary: healthy reads, optionally HELD writes. */
function fakeSource(options: {
  readonly heldSettings?: HeldWrite
  readonly heldCredentials?: HeldWrite
} = {}): RemoteConfigRuntimeSource {
  const settings = {
    describe: async (): Promise<RemoteResultLike<{
      readonly writable: boolean
      readonly hasDocument: boolean
      readonly namespaces: readonly RemoteSettingsNamespaceView[]
    }>> => ({
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: [namespaceView('agent-preset-registry', 7), namespaceView('tui-app', 3)],
      },
    }),
    update: async (): Promise<RemoteResultLike<RemoteSettingsNamespaceView>> => ({ ok: true, value: namespaceView('x', 1) }),
    replace: async (): Promise<RemoteResultLike<RemoteSettingsNamespaceView>> => ({ ok: true, value: namespaceView('x', 1) }),
    mutate: async (ns: string): Promise<RemoteResultLike<RemoteSettingsNamespaceView>> => {
      const held = options.heldSettings
      if (held === undefined) return { ok: true, value: namespaceView(ns, 8) }
      held.noteEntered()
      const outcome = await held.settled
      return outcome === 'ok'
        ? { ok: true, value: namespaceView(ns, 8) }
        : { ok: false, error: { code: 'settings/denied', message: 'the Host refused the settings write' } }
    },
  }
  const credentials = {
    describe: async (): Promise<RemoteResultLike<Record<string, unknown>>> => ({ ok: true, value: {} }),
    set: async (): Promise<RemoteResultLike<void>> => {
      const held = options.heldCredentials
      if (held === undefined) return { ok: true, value: undefined }
      held.noteEntered()
      const outcome = await held.settled
      return outcome === 'ok'
        ? { ok: true, value: undefined }
        : { ok: false, error: { code: 'credentials/denied', message: 'the Host refused the credential write' } }
    },
    unset: async (): Promise<RemoteResultLike<void>> => ({ ok: true, value: undefined }),
  }
  return {
    remote: {
      settings,
      credentials,
      commands: { execute: async () => ({ ok: false, error: { code: 'unsupported', message: 'not used' } }) },
      permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
      agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }) },
      llm: { listConfigurableProviders: async () => ({ ok: true, value: [] }) },
      $on: () => NO_ACKNOWLEDGING,
    },
    connection: {
      generation: {
        getSnapshot: () => GENERATION,
        subscribe: () => NO_ACKNOWLEDGING,
      },
    },
  } as unknown as RemoteConfigRuntimeSource
}

interface Harness {
  readonly port: RemoteConfigPort
  /** The process-owned requests that reached the sink. */
  readonly requests: number
  /** Execute the REAL registered `/reload-client` line. */
  run(): Promise<{ readonly kind: string; readonly text?: string } | undefined>
}

function startHarness(options: {
  readonly heldSettings?: HeldWrite
  readonly heldCredentials?: HeldWrite
} = {}): Harness {
  const port = new RemoteConfigPort(fakeSource(options))
  let requests = 0
  const request = createClientReloadCommandRequest({
    facts: {
      capable: () => true,
      ready: () => true,
      draftText: () => '',
      stagedImageCount: () => 0,
      stagedFileCount: () => 0,
      // The SAME composition the split Client's bootstrap uses: the config
      // port's accepted persisted writes are part of the unsettled-write fact.
      hasUnsettledUserWrite: () => port.hasUnsettledWrites(),
      hasUnsettledInteraction: () => false,
      hasUnsettledTransition: () => false,
    },
    request: () => {
      requests += 1
      return { kind: 'accepted' }
    },
  })
  const registry = createClientCommandRegistry(parseCommand)
  registerReloadClientCommand({
    runner: { requestClientReload: request },
    registerTuiCommand: (spec) => {
      registry.register({ name: spec.name, description: spec.description, handler: spec.handler })
    },
    recordCommandDraftDisposition: () => {},
  })
  return {
    port,
    get requests() { return requests },
    run: async () => (await registry.execute({
      line: '/reload-client',
      signal: new AbortController().signal,
    }))?.result as { readonly kind: string; readonly text?: string } | undefined,
  }
}

test('a held settings write refuses the reload and releases only at settlement', async () => {
  const held = heldWrite()
  const harness = startHarness({ heldSettings: held })
  await harness.port.describe()
  // A READ never registers: `/reload` settings/catalog refreshes must not block.
  assert.equal(harness.port.hasUnsettledWrites(), false, 'a describe registered as a write')

  const write = harness.port.presetDefault.set('code')
  await held.entered
  assert.equal(harness.port.hasUnsettledWrites(), true,
    'the accepted persisted settings write is unsettled while the Host write is in flight')

  const refused = await harness.run()
  assert.equal(refused?.kind, 'error')
  assert.equal(refused?.text, CLIENT_RELOAD_REFUSAL_NOTICES.submission)
  assert.equal(harness.requests, 0, 'the process request must not be reached while the write is pending')

  held.release('ok')
  await write
  assert.equal(harness.port.hasUnsettledWrites(), false, 'the write terminal settlement releases the lifetime')

  const accepted = await harness.run()
  assert.equal(accepted?.kind, 'success')
  assert.equal(harness.requests, 1, 'the settled write allows exactly one process request')
})

test('a failed settings write releases the lifetime instead of latching it', async () => {
  const held = heldWrite()
  const harness = startHarness({ heldSettings: held })
  await harness.port.describe()
  const write = harness.port.presetDefault.set('code')
  await held.entered
  assert.equal(harness.port.hasUnsettledWrites(), true)
  held.release('fail')
  await assert.rejects(write, /settings\.mutate\(agent-preset-registry\) failed/u)
  assert.equal(harness.port.hasUnsettledWrites(), false, 'a refused write still reaches its terminal settlement')
  const accepted = await harness.run()
  assert.equal(accepted?.kind, 'success')
  assert.equal(harness.requests, 1)
})

test('a held credential write refuses the reload too', async () => {
  const held = heldWrite()
  const harness = startHarness({ heldCredentials: held })
  const write = harness.port.credentials.setReference('provider', 'secret')
  // The lifetime is registered SYNCHRONOUSLY by the adapter's dispatch entry.
  assert.equal(harness.port.hasUnsettledWrites(), true,
    'a dispatched credential write registers synchronously')
  await held.entered
  const refused = await harness.run()
  assert.equal(refused?.kind, 'error')
  assert.equal(refused?.text, CLIENT_RELOAD_REFUSAL_NOTICES.submission)
  assert.equal(harness.requests, 0)
  held.release('ok')
  await write
  assert.equal(harness.port.hasUnsettledWrites(), false)
  const accepted = await harness.run()
  assert.equal(accepted?.kind, 'success')
  assert.equal(harness.requests, 1)
})
