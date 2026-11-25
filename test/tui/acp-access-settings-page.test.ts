/**
 * The `Host · ACP access` page contract (PR-B), driven directly on its own
 * grant.
 *
 * The page owns NO authority: these cases prove the PRESENTATION state machine
 * around the injected writers — the phase/Esc ladder, the first-focus rules,
 * the single-dispatch runtime admission (current observation -> ONE live
 * preflight -> ONE `setEnabled` -> ONE read-back), the generation binding of
 * every runtime action, the revision fence of the next-start preference and
 * the Client-local copy of the exact Profile command. The Settings lease
 * itself (root mount, typed deeplink, row ownership, pointer route) is proven
 * by `test/app/settings-workspace-visual.test.ts` and
 * `test/app/settings-acp-controls.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/acp-access-settings-page.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, type TuiMouseEvent } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { mountEmbeddedPage, type EmbeddedPageMount } from '../support/embedded-page-harness.ts'
import { AcpAccessSettingsPage, acpStdioCommand, type AcpAccessSettingsPageIntents } from '../../src/tui/panels/acp-access-settings-page.ts'
import type { AcpAccessStatus } from '../../src/runtime/acp-access-port.ts'
import type { AcpStartupPreferenceState } from '../../src/runtime/config-port.ts'
import type { SettingsWorkspaceCommitOutcome } from '../../src/tui/panels/settings-workspace-panel.ts'

interface PageHarnessOptions {
  readonly columns?: number
  readonly rows?: number
  readonly backendKind?: 'direct' | 'remote'
  readonly status?: AcpAccessStatus
  readonly readFailure?: string
  /** The officially proven Profile identity; `undefined` = not proven. */
  readonly profile?: string | undefined
  readonly preference?: AcpStartupPreferenceState | undefined
  readonly readiness?: 'ready' | 'stale' | 'unavailable'
  readonly commitOutcome?: SettingsWorkspaceCommitOutcome
  readonly commitFailure?: string
  readonly copy?: boolean
  readonly copyFailure?: string
  /** Apply the requested Host state and THEN throw (a lost receipt). */
  readonly writeFailureAfterApply?: string
  /** Record the write but leave the Host state unchanged (a disagreement the
   *  read-back really observes). */
  readonly ignoreWrite?: boolean
  /** Hold the clipboard write until `releaseCopy()`. */
  readonly holdCopy?: boolean
  /** Hold the Host toggle until `releaseWrite()`. */
  readonly holdWrite?: boolean
  /** Start DISCONNECTED (no Connection generation). */
  readonly disconnected?: boolean
  /** Hold every status read; the case resolves each one by index. */
  readonly holdRead?: boolean
  /** Hold every status read AFTER the page-entry read (read #2 onward). */
  readonly holdSecondRead?: boolean
}

interface PageHarness {
  readonly page: AcpAccessSettingsPage
  readonly vt: VirtualTerminal
  readonly mount: EmbeddedPageMount
  readonly frame: () => string
  readonly bar: () => string
  readonly reads: () => number
  readonly writes: () => readonly boolean[]
  readonly writeGenerations: () => readonly unknown[]
  readonly copied: () => readonly string[]
  readonly commits: () => readonly { readonly value: 'On' | 'Off'; readonly revision: number; readonly generation: object }[]
  readonly diagnoses: () => readonly { readonly label: string; readonly detail: Record<string, unknown> }[]
  readonly doneCalls: () => number
  readonly generation: { value: object | undefined }
  readonly bumpGeneration: () => void
  /** Replace the Connection generation WITHOUT notifying (a replacement the page
   *  has not observed yet: the painted fact is already stale). */
  readonly replaceGenerationSilently: () => void
  readonly connect: () => void
  readonly resolveRead: (index: number, result: AcpAccessStatus | { readonly error: string }) => void
  readonly setAuthority: (
    readiness: 'ready' | 'stale' | 'unavailable',
    preference: (Omit<AcpStartupPreferenceState, 'generation'> & { readonly generation?: object }) | undefined,
  ) => void
  readonly setStatus: (status: AcpAccessStatus) => void
  readonly releaseWrite: () => void
  readonly releaseCopy: () => void
  readonly key: (data: string) => Promise<void>
  readonly flush: () => Promise<void>
  readonly close: () => void
}

async function mount(options: PageHarnessOptions = {}): Promise<PageHarness> {
  const vt = new VirtualTerminal(options.columns ?? 100, options.rows ?? 30)
  const generation = { value: (options.disconnected === true ? undefined : {}) as object | undefined }
  let settingsAuthority: object = {}
  const listeners = new Set<() => void>()
  let status: AcpAccessStatus = options.status ?? { state: 'enabled' }
  let preference = 'preference' in options
    ? options.preference
    : { autoStart: false, revision: 1, userOverridden: false, generation: settingsAuthority } satisfies AcpStartupPreferenceState
  let readiness = options.readiness ?? 'ready'
  let reads = 0
  const writes: boolean[] = []
  const writeGenerations: unknown[] = []
  const copied: string[] = []
  const commits: { value: 'On' | 'Off'; revision: number; generation: object }[] = []
  const diagnoses: { label: string; detail: Record<string, unknown> }[] = []
  let doneCalls = 0
  let pageRef: AcpAccessSettingsPage | undefined
  let heldWrite: (() => void) | undefined
  let heldCopy: (() => void) | undefined
  const heldReads: Array<(result: AcpAccessStatus | Error) => void> = []
  const tasks: Promise<void>[] = []
  const intents: AcpAccessSettingsPageIntents = {
    backendKind: options.backendKind ?? 'remote',
    readStatus: async () => {
      reads += 1
      // The real Remote adapter's single-call fence rejects a read while no
      // Host generation exists.
      if (generation.value === undefined) throw new Error('the Client is not connected to a Host')
      if (options.holdRead === true || (options.holdSecondRead === true && reads >= 2)) {
        return await new Promise<AcpAccessStatus>((resolve, reject) => {
          heldReads.push(result => { if (result instanceof Error) reject(result); else resolve(result) })
        })
      }
      if (options.readFailure !== undefined) throw new Error(options.readFailure)
      return status
    },
    setEnabled: async (enabled: boolean, expectedGeneration?: unknown) => {
      writes.push(enabled)
      writeGenerations.push(expectedGeneration)
      if (options.holdWrite === true) await new Promise<void>(resolve => { heldWrite = resolve })
      if (options.ignoreWrite !== true) status = enabled ? { state: 'enabled' } : { state: 'disabled' }
      if (options.writeFailureAfterApply !== undefined) throw new Error(options.writeFailureAfterApply)
      return status
    },
    readPreference: () => preference,
    configReadiness: () => readiness,
    commitAutostart: async (value, revision, commitGeneration) => {
      commits.push({ value, revision, generation: commitGeneration })
      if (options.commitFailure !== undefined) throw new Error(options.commitFailure)
      if (options.commitOutcome !== undefined) return options.commitOutcome
      if (!Object.is(commitGeneration, settingsAuthority)) {
        return { outcome: 'not-saved', reason: 'the Host settings authority changed since this choice was read' }
      }
      preference = preference === undefined
        ? undefined
        : { ...preference, autoStart: value === 'On', revision: preference.revision + 1, userOverridden: true, generation: settingsAuthority }
      return { outcome: 'verified' }
    },
    copyToClipboard: async (text) => {
      copied.push(text)
      if (options.holdCopy === true) await new Promise<void>(resolve => { heldCopy = resolve })
      if (options.copyFailure !== undefined) throw new Error(options.copyFailure)
      return options.copy ?? true
    },
    profileName: 'profile' in options ? options.profile : 'pi-tui',
    currentGeneration: () => generation.value,
    subscribeGeneration: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    runOwned: (_label, task, onError) => {
      const promise = Promise.resolve().then(task).catch((error: unknown) => { onError(error) })
      tasks.push(promise)
    },
    diagnose: (label, detail) => { diagnoses.push({ label, detail }) },
    requestRender: () => { mountRef.requestRender() },
    // The Settings ROOT's `done` closes the specialist and disposes THIS page
    // instance (the same lifetime a real workspace teardown has).
    done: () => {
      doneCalls += 1
      pageRef?.dispose()
    },
  }
  const page = new AcpAccessSettingsPage(intents)
  pageRef = page
  const mountRef = mountEmbeddedPage(vt, page)
  await settleAll(vt)
  const key = async (data: string): Promise<void> => {
    vt.sendInput(data)
    await settleAll(vt)
  }
  return {
    page,
    vt,
    mount: mountRef,
    frame: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
    bar: () => stripTerminalSequences(vt.getViewport().at(-1) ?? ''),
    reads: () => reads,
    writes: () => writes,
    writeGenerations: () => writeGenerations,
    copied: () => copied,
    commits: () => commits,
    diagnoses: () => diagnoses,
    doneCalls: () => doneCalls,
    generation,
    bumpGeneration: () => {
      generation.value = {}
      settingsAuthority = {}
      if (preference !== undefined) preference = { ...preference, generation: settingsAuthority }
      for (const listener of [...listeners]) listener()
    },
    replaceGenerationSilently: () => {
      generation.value = {}
      settingsAuthority = {}
      if (preference !== undefined) preference = { ...preference, generation: settingsAuthority }
    },
    connect: () => {
      generation.value = {}
      for (const listener of [...listeners]) listener()
    },
    resolveRead: (index, result) => {
      const settle = heldReads[index]
      if (settle === undefined) throw new Error(`no held read at index ${index}`)
      settle(typeof result === 'object' && 'error' in result ? new Error(result.error) : result)
    },
    setAuthority: (nextReadiness, nextPreference) => {
      readiness = nextReadiness
      preference = nextPreference === undefined
        ? undefined
        : { ...nextPreference, generation: nextPreference.generation ?? settingsAuthority }
    },
    setStatus: (next) => { status = next },
    releaseWrite: () => { heldWrite?.(); heldWrite = undefined },
    releaseCopy: () => { heldCopy?.(); heldCopy = undefined },
    key,
    flush: () => settleAll(vt),
    close: () => mountRef.close(),
  }
}

async function settleAll(vt: VirtualTerminal): Promise<void> {
  // The page's owned tasks settle on their own owner; a HELD write stays
  // pending, so this only drains microtasks and paints — it never awaits a
  // dispatch the case intentionally keeps open.
  for (let round = 0; round < 10; round += 1) await Promise.resolve()
  await vt.waitForRender()
}

/** Walk the painted cursor onto the row with this exact label. */
async function highlight(h: PageHarness, label: string): Promise<void> {
  for (let step = 0; step < 12; step += 1) {
    if (new RegExp(`^> ${label}`, 'mu').test(h.frame())) return
    await h.key('\x1b[B')
  }
  assert.fail(`the "${label}" row never owned the selection:\n${h.frame()}`)
}

/* ------------------------------------------------------------ the command */

test('the client command is the exact Profile token with POSIX quoting', () => {
  assert.equal(acpStdioCommand('pi-tui'), 'dsh --profile pi-tui acp stdio')
  assert.equal(acpStdioCommand('work profile'), "dsh --profile 'work profile' acp stdio")
  assert.equal(acpStdioCommand("it's"), "dsh --profile 'it'\\''s' acp stdio")
  assert.equal(acpStdioCommand('a$b;c'), "dsh --profile 'a$b;c' acp stdio")
  assert.equal(acpStdioCommand('/abs/path'), 'dsh --profile /abs/path acp stdio')
})

/* --------------------------------------------------------------- focus */

test('the enabled first focus is Copy client command; the disabled one is Enable ACP', async () => {
  const enabled = await mount({ status: { state: 'enabled' } })
  assert.match(enabled.frame(), /^> Copy client command/mu)
  assert.match(enabled.frame(), /Current Host\s*\n\s+Listener\s+Enabled/u)
  assert.match(enabled.frame(), /Access\s+Local Unix socket · Same OS user/u)
  assert.match(enabled.frame(), /Disable ACP…\s+Disconnects active ACP clients/u)
  assert.equal(enabled.reads(), 1, 'one Host read on mount, never a poll')
  enabled.close()
  const disabled = await mount({ status: { state: 'disabled' } })
  assert.match(disabled.frame(), /^> Enable ACP/mu)
  assert.match(disabled.frame(), /Listener\s+Disabled/u)
  disabled.close()
})

test('with no proven Profile the Copy target is absent and stated unavailable', async () => {
  const h = await mount({ status: { state: 'disabled' }, profile: undefined })
  assert.match(h.frame(), /^> Enable ACP/mu, 'the runtime action owns the focus')
  assert.doesNotMatch(h.frame(), /Copy client command/u, 'no copy row exists')
  assert.match(h.frame(), /Client command unavailable · Profile identity not verified/u)
  assert.match(h.frame(), /The Host listener must be enabled before the client can connect\./u)
  assert.match(h.frame(), /Closing an ACP View detaches it; Host Sessions, Agents and TUI remain\./u)
  h.close()
})

test('Direct states Split Host only, offers no toggle and still edits the preference', async () => {
  const h = await mount({ backendKind: 'direct', profile: undefined })
  assert.match(h.frame(), /Listener\s+Unavailable · Split Host only/u)
  assert.match(h.frame(), /Access\s+Unavailable/u)
  assert.doesNotMatch(h.frame(), /Enable ACP|Disable ACP/u, 'Direct owns no local ACP listener')
  assert.equal(h.reads(), 0, 'Direct performs no fake Host read')
  assert.match(h.frame(), /^> Start automatically/mu, 'the editable preference owns the focus')
  const direct = await mount({ backendKind: 'direct', profile: 'pi-tui' })
  assert.match(direct.frame(), /^> Copy client command/mu,
    'the proven Profile\'s Copy is the first focus when no runtime toggle exists')
  assert.match(direct.frame(), /dsh --profile pi-tui acp stdio/u)
  direct.close()
  const noPreference = await mount({ backendKind: 'direct', preference: undefined, readiness: 'unavailable', profile: undefined })
  assert.match(noPreference.frame(), /^> Refresh/mu, 'with no editable preference, Refresh owns the focus')
  assert.match(noPreference.frame(), /Start automatically\s+Unavailable/u, 'the value is never defaulted')
  noPreference.close()
})

/* ------------------------------------------------------------- runtime */

test('Enable ACP dispatches ONE fenced write after ONE live preflight and reaches Verified', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  await h.key('\r') // Enable ACP
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'exactly one Host toggle')
  assert.deepEqual(h.writeGenerations(), [h.generation.value], 'the generation the state was read under')
  assert.equal(h.reads(), 3, 'entry read + preflight + ONE read-back')
  assert.match(h.frame(), /Listener\s+Enabled/u)
  assert.match(h.frame(), /Status\s+Verified/u)
  assert.match(h.bar(), /Refresh \[R\] · Back \[Esc\]/u)
  h.close()
})

test('an already-enabled Host is zero-write Not changed with the real state', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  await highlight(h, 'Enable ACP')
  // The Host reached the target between the painted frame and the preflight.
  h.setStatus({ state: 'enabled' })
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.writes(), [], 'the preflight admitted no write')
  assert.match(h.frame(), /Status\s+Not changed/u)
  assert.match(h.frame(), /the listener already reports Enabled/u)
  assert.match(h.frame(), /Listener\s+Enabled/u, 'the preflight fact is painted, not a fake Off')
  h.close()
})

test('a changing or unavailable listener is never written by a second request', async () => {
  const changing = await mount({ status: { state: 'disabled' } })
  await highlight(changing, 'Enable ACP')
  changing.setStatus({ state: 'changing' })
  await changing.key('\r')
  await changing.flush()
  assert.deepEqual(changing.writes(), [])
  assert.match(changing.frame(), /Status\s+Not changed/u)
  assert.match(changing.frame(), /an ACP listener change is already in progress/u)
  assert.match(changing.frame(), /Listener\s+Changing…/u)
  changing.close()

  const unavailable = await mount({ status: { state: 'disabled' } })
  await highlight(unavailable, 'Enable ACP')
  unavailable.setStatus({ state: 'unavailable', reason: 'listener is closing' })
  await unavailable.key('\r')
  await unavailable.flush()
  assert.deepEqual(unavailable.writes(), [])
  assert.match(unavailable.frame(), /Status\s+Not changed/u)
  assert.match(unavailable.frame(), /the ACP listener is unavailable/u)
  unavailable.close()
})

test('the Disable risk confirmation stages zero writes and Cancel leaves the Host untouched', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Disable ACP…')
  await h.key('\r')
  // The complete risk sentence is a first-class wrapped fact of this phase.
  assert.match(h.frame(), /Disable the local ACP listener\? All connected ACP clients will be disconnected\. Host sessions,/u)
  assert.match(h.frame(), /Agents and this TUI will keep running\./u)
  assert.match(h.bar(), /Confirm \[Enter\] · Cancel \[Esc\]/u)
  assert.deepEqual(h.writes(), [], 'the first step never writes')
  await h.key('\x1b')
  assert.match(h.frame(), /Listener\s+Enabled/u, 'Esc cancels the confirmation only')
  assert.deepEqual(h.writes(), [])
  assert.equal(h.doneCalls(), 0)
  await highlight(h, 'Disable ACP…')
  await h.key('\r')
  await h.key('\r') // the SECOND explicit confirmation
  await h.flush()
  assert.deepEqual(h.writes(), [false], 'only the confirmed step dispatches ONE Host disable')
  assert.match(h.frame(), /Listener\s+Disabled/u)
  assert.match(h.frame(), /Status\s+Verified/u)
  h.close()
})

test('a lost Host receipt is Outcome unconfirmed and is never replayed', async () => {
  const h = await mount({ status: { state: 'disabled' }, writeFailureAfterApply: 'the connection dropped after dispatch' })
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'exactly one dispatch')
  assert.match(h.frame(), /Status\s+Outcome unconfirmed/u)
  assert.match(h.frame(), /the Host may have applied the request/u)
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'no automatic retry')
  h.close()
})

test('a write the Host does not reflect is Not saved', async () => {
  // The Host accepted the request but still reports the old state: the read-back
  // is the authority and disagrees with the requested target.
  const h = await mount({ status: { state: 'disabled' }, ignoreWrite: true })
  await highlight(h, 'Enable ACP')
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.writes(), [true])
  assert.match(h.frame(), /Status\s+Not saved/u)
  assert.match(h.frame(), /the request reported success, but the Host reads Disabled/u)
  h.close()
})

test('a Host generation change during a pending write is Outcome unconfirmed and never replays', async () => {
  const h = await mount({ status: { state: 'disabled' }, holdWrite: true })
  await h.key('\r') // Enable, held in flight
  assert.match(h.frame(), /Waiting for the answer…/u)
  h.bumpGeneration()
  await h.flush()
  assert.match(h.frame(), /Status\s+Outcome unconfirmed/u)
  assert.deepEqual(h.writes(), [true])
  h.releaseWrite()
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'the old Host request is never replayed against the new one')
  h.close()
})

test('a Host replacement DURING the preflight is a definitive zero-write Not changed', async () => {
  // The second status read is the mandatory live preflight: hold it unresolved
  // and replace the Host before `setEnabled` can be invoked.
  const h = await mount({ status: { state: 'disabled' }, holdSecondRead: true })
  assert.match(h.frame(), /^> Enable ACP/mu)
  assert.equal(h.reads(), 1, 'only the page-entry read settled')
  await h.key('\r') // Enable ACP: the live preflight is now held
  assert.equal(h.reads(), 2)
  assert.match(h.frame(), /Waiting for the answer…/u)
  h.bumpGeneration() // Host A -> B while the preflight promise is unresolved
  await h.flush()
  assert.deepEqual(h.writes(), [], 'ZERO Host writes were invoked before the preflight settled')
  assert.match(h.frame(), /Status\s+Not changed/u, 'a pre-dispatch abort is definitive, never unconfirmed')
  assert.match(h.frame(), /the Host changed before the request was sent/u)
  assert.doesNotMatch(h.frame(), /Outcome unconfirmed/u)
  // The stale preflight reply is discarded and the CURRENT Host is read.
  h.resolveRead(0, { state: 'disabled' })
  await h.flush()
  assert.deepEqual(h.writes(), [], 'the stale reply never dispatches either')
  h.resolveRead(1, { state: 'enabled' })
  await h.flush()
  assert.match(h.frame(), /Listener\s+Enabled/u, 'the replacement Host owns the painted fact')
  assert.match(h.frame(), /^> Copy client command/mu, 'only the new Host state admits its action')
  const diagnostic = h.diagnoses().find(entry => entry.label === 'acp access runtime write')
  assert.ok(diagnostic !== undefined)
  assert.equal(diagnostic.detail.invoked, false)
  assert.equal(diagnostic.detail.stage, 'preflight')
  h.close()
})

test('a retired INVOKED write reports invocation honestly, never a false no-dispatch', async () => {
  // The call is really invoked and even applied; the page leaves before the
  // rejected reply arrives. `invoked` must not be derived from fulfillment.
  const h = await mount({ status: { state: 'disabled' }, holdWrite: true, writeFailureAfterApply: 'the reply was lost' })
  await h.key('\r') // Enable ACP: setEnabled is invoked and held
  assert.match(h.frame(), /Waiting for the answer…/u)
  await h.key('\x1b') // leave the page while the invoked write is in flight
  assert.equal(h.doneCalls(), 1)
  h.releaseWrite() // the Host applies the request, then the reply throws
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'the invoked write is dispatched exactly once and never replayed')
  const diagnostic = h.diagnoses().find(entry => entry.label === 'acp access runtime write')
  assert.ok(diagnostic !== undefined, 'the retired page still diagnoses the invoked write')
  assert.equal(diagnostic.detail.invoked, true, 'invocation is the fact, not the rejected promise')
  assert.equal(diagnostic.detail.result, 'rejected')
  assert.equal(typeof diagnostic.detail.failure, 'string')
  h.close()
})

test('a painted observation from a replaced Host dispatches nothing', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  await highlight(h, 'Enable ACP')
  // The Host is replaced WITHOUT a notification: the painted observation is
  // already stale when the user's action arrives, so no write may be sent.
  h.replaceGenerationSilently()
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.writes(), [], 'the generation fence rejected the stale action')
  assert.match(h.frame(), /Status\s+Not changed/u)
  assert.match(h.frame(), /the Host changed before the request was sent/u)
  h.close()
})

test('an unreadable Host state revokes every action and states the real failure', async () => {
  const h = await mount({ status: { state: 'enabled' }, readFailure: 'the Client is not connected to a Host' })
  assert.match(h.frame(), /Listener\s+Unavailable/u)
  assert.match(h.frame(), /Access\s+Unavailable/u)
  assert.match(h.frame(), /the Client is not connected to a Host/u)
  assert.doesNotMatch(h.frame(), /> (?:Enable ACP|Disable ACP…)/u)
  assert.match(h.frame(), /^> Copy client command/mu,
    'with no runtime toggle the proven Profile\'s Copy owns the focus')
  h.close()
})

test('the page opened while DISCONNECTED settles Unreadable and recovers on connect', async () => {
  const h = await mount({ status: { state: 'enabled' }, disconnected: true })
  assert.match(h.frame(), /Listener\s+Unavailable/u)
  assert.match(h.frame(), /the Client is not connected to a Host/u)
  assert.doesNotMatch(h.frame(), /Reading the Host ACP state…/u)
  assert.match(h.bar(), /Refresh \[R\] · Back \[Esc\]/u)
  assert.equal(h.writes().length, 0, 'a disconnected page offers no Host action')
  h.connect()
  await h.flush()
  assert.equal(h.reads(), 2)
  assert.match(h.frame(), /Listener\s+Enabled/u)
  assert.match(h.frame(), /Copy client command/u)
  h.close()
})

test('a superseded status reply is never painted as the current Host fact', async () => {
  const h = await mount({ status: { state: 'disabled' }, holdRead: true })
  h.bumpGeneration()
  await h.flush()
  h.resolveRead(0, { state: 'enabled' })
  await h.flush()
  assert.doesNotMatch(h.frame(), /Listener\s+Enabled/u, 'the replaced Host reply is never painted')
  assert.match(h.frame(), /Listener\s+Checking…/u)
  h.resolveRead(1, { state: 'disabled' })
  await h.flush()
  assert.match(h.frame(), /Listener\s+Disabled/u, 'only the current Host reply settles the fact')
  h.close()
})

/* -------------------------------------------------------------- clipboard */

test('Copy client command copies the exact command and calls no Host', async () => {
  const h = await mount({ status: { state: 'enabled' }, profile: 'work profile', holdCopy: true })
  const readsBefore = h.reads()
  await h.key('\r') // Copy client command
  assert.match(h.frame(), /Copying the client command…/u)
  assert.match(h.bar(), /Back \[Esc\]/u, 'a pending copy offers no second action')
  h.releaseCopy()
  await h.flush()
  assert.deepEqual(h.copied(), ["dsh --profile 'work profile' acp stdio"])
  assert.match(h.frame(), /Status\s+Client command copied/u)
  assert.equal(h.reads(), readsBefore, 'a copy performs no Host read')
  assert.deepEqual(h.writes(), [])
  h.close()
})

test('a false or failing clipboard is an honest error, never a fake copy', async () => {
  const refused = await mount({ status: { state: 'enabled' }, copy: false })
  await refused.key('\r')
  await refused.flush()
  assert.match(refused.frame(), /Status\s+Clipboard unavailable/u)
  refused.close()
  const thrown = await mount({ status: { state: 'enabled' }, copyFailure: 'the clipboard is not mounted' })
  await thrown.key('\r')
  await thrown.flush()
  assert.match(thrown.frame(), /Status\s+Clipboard unavailable/u)
  assert.match(thrown.frame(), /the clipboard is not mounted/u)
  thrown.close()
})

test('a pending copy left by Esc is diagnosed and never revives the page', async () => {
  const h = await mount({ status: { state: 'enabled' }, holdCopy: true })
  await h.key('\r')
  await h.key('\x1b')
  assert.equal(h.doneCalls(), 1, 'Esc leaves the page; it never cancels the clipboard operation')
  h.releaseCopy()
  await h.flush()
  assert.deepEqual(h.copied(), ['dsh --profile pi-tui acp stdio'])
  assert.equal(h.diagnoses().length, 1)
  assert.equal(h.diagnoses()[0]?.label, 'acp access client command copy')
  assert.equal(h.diagnoses()[0]?.detail.copied, true)
  h.close()
})

/* ------------------------------------------------------- next Host start */

test('the next-start ladder stages zero writes and saves the captured revision only on Confirm', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Start automatically')
  assert.match(h.frame(), /Start automatically\s+Off \(default\) · Change…/u)
  await h.key('\r') // candidates
  assert.match(h.frame(), /Choose the value the next Host start applies:/u)
  assert.match(h.frame(), /Off\s+\[current\]/u, 'the current candidate carries the whole state chip')
  assert.equal(h.commits().length, 0)
  await h.key('\r') // stage the focused candidate (On)
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  await h.key('\x1b') // back to the candidates
  assert.match(h.frame(), /Choose the value the next Host start applies:/u)
  await h.key('\x1b') // cancel the choice
  assert.match(h.frame(), /Listener\s+Enabled/u)
  assert.equal(h.commits().length, 0, 'the whole ladder staged zero writes')
  assert.equal(h.doneCalls(), 0)
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  await h.key('\r') // Confirm save
  await h.flush()
  const commits = h.commits()
  assert.equal(commits.length, 1, 'the EXISTING writer received exactly one request')
  assert.equal(commits[0]!.value, 'On')
  assert.equal(commits[0]!.revision, 1, 'the writer received the captured revision')
  assert.equal(typeof commits[0]!.generation, 'object', 'and the captured settings authority')
  assert.match(h.frame(), /Status\s+Verified/u)
  assert.match(h.frame(), /Start automatically\s+On · Change…/u, 'the persisted value is re-read, not optimistically assumed')
  assert.deepEqual(h.writes(), [], 'the preference write never toggles the running Host')
  h.close()
})

test('a same-generation Config update refuses the staged confirmation instead of rebasing its revision', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  // Another Config owner writes the profile on the SAME Host generation.
  h.setAuthority('ready', { autoStart: true, revision: 2, userOverridden: true })
  await h.key('\r') // Confirm save
  await h.flush()
  assert.deepEqual(h.commits(), [], 'the stale confirmation dispatched no write')
  assert.match(h.frame(), /Status\s+Not saved/u)
  assert.match(h.frame(), /the configuration changed since this choice was opened; review the new value and confirm again/u)
  assert.match(h.frame(), /Start automatically\s+On · Change…/u, 'the CURRENT value is painted for review')
  h.close()
})

test('a Host rollover revokes the next-start edit grant taken from the old Config mirror', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  h.setAuthority('unavailable', undefined)
  h.bumpGeneration()
  await h.flush()
  assert.doesNotMatch(h.frame(), /Confirm save|Save the next Host start/u, 'the staged confirmation is revoked')
  assert.match(h.frame(), /Start automatically\s+Unavailable/u, 'the stale value is never painted as current')
  assert.doesNotMatch(h.frame(), /Change…/u, 'no edit affordance under a non-current authority')
  assert.equal(h.commits().length, 0, 'zero preference writes under a non-current authority')
  h.close()
})

test('a throwing preference writer is an honest unconfirmed outcome', async () => {
  const h = await mount({ status: { state: 'enabled' }, commitFailure: 'the writer crashed' })
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  await h.key('\r')
  await h.flush()
  assert.match(h.frame(), /Status\s+Outcome unconfirmed/u)
  assert.match(h.frame(), /the writer crashed/u)
  h.close()
})

test('a non-current authority does not scroll the page back to the selected row', async () => {
  const h = await mount({ status: { state: 'enabled' }, columns: 72, rows: 14, profile: 'work profile 中文' })
  await h.key('\x1b[F') // End: read the Client Setup facts at the bottom
  assert.match(h.frame(), /dsh --profile 'work profile 中文' acp stdio/u, 'the quoted CJK command is fully readable')
  assert.match(h.frame(), /The Host listener must be enabled before the client can connect\./u)
  const scrolled = h.frame()

  // The Config authority becomes non-current while the user reads the bottom.
  // This is a read observation, NOT a selection move, so the viewport must stay
  // where the user put it.
  h.setAuthority('unavailable', undefined)
  const reads = h.reads()
  h.mount.requestRender()
  await h.flush()
  assert.match(h.frame(), /dsh --profile 'work profile 中文' acp stdio/u, 'the reader keeps the scrolled viewport')
  assert.doesNotMatch(h.frame(), /Current Host/u, 'no forced scroll back to the selected/current header')
  assert.notEqual(h.frame(), scrolled, 'the repaint reflected the new non-current fact, not a frozen frame')
  assert.match(h.frame(), /Start automatically\s+Unavailable/u)
  assert.equal(h.reads(), reads, 'the repaint performs no extra Host read')
  h.close()
})

test('a short grant keeps ONE scrollable column and the Esc affordance', async () => {
  const h = await mount({ status: { state: 'enabled' }, columns: 44, rows: 8 })
  assert.match(h.frame(), /Current Host/u)
  assert.match(h.bar(), /Back \[Esc\]/u, 'the physical last row keeps the Esc affordance')
  await h.key('\x1b[F') // End scrolls to the Client Setup facts
  assert.match(h.frame(), /dsh --profile pi-tui acp stdio/u, 'the Client Setup command survives the short grant')
  assert.match(h.frame(), /The Host listener must be enabled before the/u)
  assert.match(h.frame(), /Closing an ACP View detaches it; Host/u)
  await h.key('\x1b[B') // moving the cursor returns to the selected row
  assert.match(h.frame(), /^> /mu)
  await h.key('\x1b')
  assert.equal(h.doneCalls(), 1)
  h.close()
})

test('a same-revision Host rollover still retires the staged next-start confirmation', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  // The replacement Host's Config mirror exposes the SAME revision: only the
  // rollover itself can prove the decision belongs to the old authority.
  h.setAuthority('ready', { autoStart: false, revision: 1, userOverridden: false })
  h.bumpGeneration()
  await h.flush()
  assert.doesNotMatch(h.frame(), /Save the next Host start preference|Confirm save/u,
    'the staged confirmation is revoked by the rollover')
  assert.equal(h.commits().length, 0, 'the rollover itself writes nothing')
  assert.match(h.frame(), /> Copy client command/u, 'the clean page returns to its real first focus')
  h.close()
})

test('a silently replaced Host refuses the staged save with zero writes', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  // A replacement WITHOUT a rollover notification keeps the same revision, so
  // the captured generation is the only fence that refuses the submit.
  h.replaceGenerationSilently()
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.commits(), [], 'the stale confirmation dispatched no write')
  assert.match(h.frame(), /Status\s+Not saved/u)
  assert.match(h.frame(), /the configuration changed since this choice was opened/u)
  h.close()
})

test('a page left during the live preflight invokes no Host mutation', async () => {
  const h = await mount({ status: { state: 'disabled' }, holdSecondRead: true })
  await h.key('\r') // Enable ACP: the live preflight is held unresolved
  assert.equal(h.reads(), 2)
  await h.key('\x1b') // the page's own explicit Back retires it
  assert.equal(h.doneCalls(), 1)
  h.resolveRead(0, { state: 'disabled' })
  await h.flush()
  assert.deepEqual(h.writes(), [], 'the retired preflight never invoked a Host mutation')
  const diagnostic = h.diagnoses().find(entry => entry.label === 'acp access runtime write')
  assert.ok(diagnostic !== undefined, 'the invoked=false fact is diagnosed')
  assert.equal(diagnostic.detail.invoked, false)
  assert.equal(diagnostic.detail.stage, 'preflight')
  h.close()
})

test('a short confirm frame withholds the accept until the necessary copy is fully painted', async () => {
  const disable = await mount({ status: { state: 'enabled' }, columns: 34, rows: 24 })
  await highlight(disable, 'Disable ACP…')
  await disable.key('\r')
  const formerAcceptY = rowOf(disable, '> Disable ACP')

  disable.vt.resize(34, 5)
  await disable.flush()
  assert.doesNotMatch(disable.frame(), /> Disable ACP/u, 'the accept row is blank while the risk is incomplete')
  assert.doesNotMatch(disable.bar(), /Confirm \[Enter\]/u, 'the bar advertises no hidden confirm')
  assert.match(disable.bar(), /Cancel \[Esc\]/u, 'Cancel stays reachable')
  // The hidden keyboard/bar routes and a pointer at the former accept cell
  // must all be inert while the necessary copy is unreadable.
  await disable.key('\r')
  await disable.flush()
  disable.page.activateBarSpan('bar:confirm')
  disable.page.handleMouse(mouseEvent(disable, 'press', 3, formerAcceptY))
  disable.page.handleMouse(mouseEvent(disable, 'click', 3, formerAcceptY))
  await disable.flush()
  assert.deepEqual(disable.writes(), [], 'no hidden/former accept route dispatches a partial confirmation')
  assert.match(disable.frame(), /Cancel/u, 'the confirmation is still open for recovery')

  disable.vt.resize(34, 24)
  await disable.flush()
  assert.match(disable.frame(), /> Disable ACP/u, 'the sufficient grant paints a NEW accept row')
  await disable.key('\r')
  await disable.flush()
  assert.deepEqual(disable.writes(), [false], 'the fresh confirmation dispatched exactly once')
  disable.close()

  const save = await mount({ status: { state: 'enabled' }, columns: 34, rows: 24 })
  await highlight(save, 'Start automatically')
  await save.key('\r')
  await save.key('\r')
  const formerSaveY = rowOf(save, '> Confirm save')

  save.vt.resize(34, 5)
  await save.flush()
  assert.doesNotMatch(save.frame(), /> Confirm save/u, 'the save accept is withheld with its lifetime fact offscreen')
  assert.doesNotMatch(save.bar(), /Confirm save/u)
  await save.key('\r')
  await save.flush()
  save.page.activateBarSpan('bar:confirm')
  save.page.handleMouse(mouseEvent(save, 'press', 3, formerSaveY))
  save.page.handleMouse(mouseEvent(save, 'click', 3, formerSaveY))
  await save.flush()
  assert.deepEqual(save.commits(), [], 'no hidden/former save route dispatches a partial confirmation')
  assert.match(save.frame(), /Cancel/u)

  save.vt.resize(34, 24)
  await save.flush()
  assert.match(save.frame(), /> Confirm save/u)
  await save.key('\r')
  await save.flush()
  const commits = save.commits()
  assert.equal(commits.length, 1, 'the recovered confirmation submits once')
  assert.equal(commits[0]!.value, 'On')
  assert.equal(commits[0]!.revision, 1)
  assert.equal(typeof commits[0]!.generation, 'object')
  save.close()
})

test('selecting Cancel never advertises or runs the destructive confirm', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Disable ACP…')
  await h.key('\r')
  await h.key('\x1b[B') // Disable ACP -> Cancel
  assert.match(h.frame(), /^> Cancel/mu)
  assert.doesNotMatch(h.bar(), /Confirm \[Enter\]/u, 'a selected Cancel never advertises an Enter confirm')
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.writes(), [])
  assert.equal(h.doneCalls(), 0)
  assert.match(h.frame(), /Listener\s+Enabled/u, 'Cancel returns to the clean runtime facts')
  h.close()
})

test('Refresh is a real body action and its shortcut acts only while the row is painted', async () => {
  const h = await mount({ status: { state: 'enabled' }, columns: 44, rows: 24 })
  const reads = h.reads()
  // A same-generation external writer changes the live listener: Refresh must
  // perform a real authoritative read, not just repaint a cached fact.
  h.setStatus({ state: 'disabled' })
  await h.key('r')
  await h.flush()
  assert.equal(h.reads(), reads + 1, 'r performs exactly ONE status read')
  assert.match(h.frame(), /Listener\s+Disabled/u, 'the refreshed fact is painted')
  assert.deepEqual(h.writes(), [], 'Refresh never toggles the Host')
  h.close()

  const short = await mount({ status: { state: 'enabled' }, columns: 34, rows: 4 })
  const before = short.reads()
  assert.ok(!short.page.paintedBarSpans().some(span => span.id === 'bar:refresh'),
    'a grant that drops the whole Refresh segment publishes no target')
  await short.key('r')
  await short.flush()
  assert.equal(short.reads(), before, 'the shortcut cannot act on a row this frame did not paint')
  short.close()
})

test('a preference write accepted without an agreeing readback is Unverified', async () => {
  const h = await mount({
    status: { state: 'enabled' },
    commitOutcome: { outcome: 'unverified', reason: 'the readback disagrees' },
  })
  await highlight(h, 'Start automatically')
  await h.key('\r')
  await h.key('\r')
  await h.key('\r')
  await h.flush()
  assert.match(h.frame(), /Status\s+Unverified/u)
  assert.match(h.frame(), /the readback disagrees/u)
  h.close()
})

test('a silent Host replacement cannot turn an old Change press into a new choice', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Start automatically')
  assert.match(h.frame(), /Start automatically\s+Off \(default\) · Change…/u)

  // A replacement Host exposes the same revision and value, without a rollover
  // notification: the painted row still belongs to the OLD authority.
  h.replaceGenerationSilently()
  await h.key('\r')
  await h.flush()
  assert.doesNotMatch(h.frame(), /Choose the value the next Host start applies:/u,
    'the old painted Change press does not establish a choice from the new authority')
  assert.doesNotMatch(h.frame(), /Save the next Host start preference/u)
  assert.equal(h.commits().length, 0)

  await h.key('\r')
  await h.flush()
  assert.match(h.frame(), /Choose the value the next Host start applies:/u,
    'a fresh frame plus a new explicit gesture admits the current authority')
  assert.equal(h.commits().length, 0, 'even the fresh choice stages zero writes')
  h.close()
})

test('a ready preference without a current authority generation offers no change', async () => {
  const h = await mount({
    status: { state: 'enabled' },
    preference: { autoStart: false, revision: 1, userOverridden: false, generation: undefined },
  })
  assert.match(h.frame(), /Start automatically\s+Off \(default\)/u)
  assert.doesNotMatch(h.frame(), /Change…/u, 'a value without a writable authority identity is read-only')
  const y = rowOf(h, 'Start automatically')
  h.page.handleMouse(mouseEvent(h, 'press', 3, y))
  h.page.handleMouse(mouseEvent(h, 'click', 3, y))
  await h.flush()
  assert.equal(h.commits().length, 0, 'no hidden pointer/Change route can stage a write')
  h.close()
})

/* ------------------------------------------------------------------ mouse */

function mouseEvent(h: PageHarness, type: 'press' | 'click', x: number, y: number): TuiMouseEvent {
  return {
    type, button: 'left', x, y, screenX: x, screenY: y,
    width: h.vt.columns, height: h.vt.rows,
    shift: false, alt: false, ctrl: false,
  } as TuiMouseEvent
}

/** The page-local row index of the painted text (0-based viewport row). */
function rowOf(h: PageHarness, needle: string): number {
  const index = h.vt.getViewport().map(stripTerminalSequences).findIndex(line => line.includes(needle))
  assert.ok(index >= 0, `row "${needle}" not painted:\n${h.frame()}`)
  return index
}

test('a painted row is pointer-reachable through the SAME Enter admission', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  const y = rowOf(h, 'Enable ACP')
  assert.equal(h.page.handleMouse(mouseEvent(h, 'press', 3, y))?.handled, true)
  assert.deepEqual(h.writes(), [], 'a press alone never dispatches')
  assert.equal(h.page.handleMouse(mouseEvent(h, 'click', 3, y))?.handled, true)
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'press+release runs the same ONE Host write')
  h.close()
})

test('a press recorded before a repaint cannot dispatch on a later frame', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  const y = rowOf(h, 'Enable ACP')
  h.page.handleMouse(mouseEvent(h, 'press', 3, y))
  // A repaint changes the grant: the armed gesture must be retired.
  h.page.setMaxRows(h.vt.rows + 1)
  await h.flush()
  assert.equal(h.page.handleMouse(mouseEvent(h, 'click', 3, y)), undefined)
  await h.flush()
  assert.deepEqual(h.writes(), [], 'the stale press never dispatched')
  h.close()
})

test('the Action Bar confirm segment is a delegated target for the SAME confirmation', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await highlight(h, 'Disable ACP…')
  await h.key('\r')
  const spans = h.page.paintedBarSpans()
  assert.deepEqual(spans.map(span => span.id), ['bar:confirm'], 'the root owns the physical row; the page delegates its own spans')
  const escape = h.page.paintedEscapeSpan()
  assert.ok(escape !== undefined, 'the Cancel span is the ROOT Esc affordance, never a second page span')
  assert.ok(spans[0]!.startCol < escape.startCol, 'the two painted segments never overlap')
  h.page.activateBarSpan('bar:confirm')
  await h.flush()
  assert.deepEqual(h.writes(), [false], 'the painted Confirm runs the phase confirm, not the cursor row')
  h.close()
})

test('a pointer click on a row value only selects; a fact row is inert', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  const y = rowOf(h, 'Disable ACP…')
  const line = h.vt.getViewport().map(stripTerminalSequences)[y]!
  const x = line.indexOf('Disconnects active ACP clients')
  assert.ok(x > 0, `the row value must be painted:\n${h.frame()}`)
  assert.equal(h.page.handleMouse(mouseEvent(h, 'press', x, y))?.handled, true)
  assert.equal(h.page.handleMouse(mouseEvent(h, 'click', x, y))?.handled, true)
  await h.flush()
  assert.doesNotMatch(h.frame(), /Disable the local ACP listener\?/u,
    'the value cell is select-only; it never opens the destructive confirm')
  assert.match(h.frame(), /^> Disable ACP…/mu)
  assert.deepEqual(h.writes(), [])
  // A pure fact row publishes no target at all.
  const factY = rowOf(h, 'Listener')
  assert.equal(h.page.handleMouse(mouseEvent(h, 'press', 3, factY)), undefined)
  assert.equal(h.page.handleMouse(mouseEvent(h, 'click', 3, factY)), undefined)
  h.close()
})
