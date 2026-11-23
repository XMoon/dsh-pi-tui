/**
 * The `Host · Web UI` page contract (PR-A), driven directly on its own grant.
 *
 * The page owns NO authority: these cases prove the PRESENTATION state machine
 * around the two injected writers — the phase/Esc ladder, the first-focus
 * rules, the generation binding of the runtime actions and the honest outcome
 * words. The Settings lease itself (root mount, first-frame deeplink, pointer
 * route) is proven by `test/app/settings-workspace-visual.test.ts` and
 * `test/tui/settings-workspace-panel.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/web-ui-settings-page.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { mountEmbeddedPage, type EmbeddedPageMount } from '../support/embedded-page-harness.ts'
import { WebUiSettingsPage, type WebUiSettingsPageIntents } from '../../src/tui/panels/web-ui-settings-page.ts'
import type { WebAccessStatus } from '../../src/runtime/web-access-port.ts'
import type { WebStartupPreferenceState } from '../../src/runtime/config-port.ts'
import type { SettingsWorkspaceCommitOutcome } from '../../src/tui/panels/settings-workspace-panel.ts'

interface PageHarnessOptions {
  readonly columns?: number
  readonly rows?: number
  readonly backendKind?: 'direct' | 'remote'
  readonly status?: WebAccessStatus
  readonly readFailure?: string
  readonly toggleFailure?: string
  readonly settledStatus?: WebAccessStatus
  readonly preference?: WebStartupPreferenceState | undefined
  readonly readiness?: 'ready' | 'stale' | 'unavailable'
  readonly commit?: SettingsWorkspaceCommitOutcome
  readonly commitFailure?: string
  readonly copy?: boolean
  readonly urlFailure?: string
  /** Hold the official URL reply until `releaseUrl()`: the Host-replacement
   *  window between the RPC settling and the Client sink. */
  readonly holdUrl?: boolean
  /** Start DISCONNECTED (no Connection generation): the port rejects a status
   *  read, exactly like the real Remote adapter. */
  readonly disconnected?: boolean
  /** Hold every status read; the case resolves each one by index. */
  readonly holdRead?: boolean
}

interface PageHarness {
  readonly page: WebUiSettingsPage
  readonly vt: VirtualTerminal
  readonly mount: EmbeddedPageMount
  readonly frame: () => string
  readonly bar: () => string
  readonly reads: () => number
  readonly writes: () => readonly boolean[]
  readonly urlReads: () => number
  readonly opened: () => readonly string[]
  readonly copied: () => readonly string[]
  readonly commits: () => readonly string[]
  readonly commitRevisions: () => readonly number[]
  readonly diagnoses: () => readonly { label: string; detail: Record<string, unknown> }[]
  readonly doneCalls: () => number
  readonly generation: { value: object | undefined }
  readonly bumpGeneration: () => void
  /** The Split Host connects: a fresh generation is committed and observed. */
  readonly connect: () => void
  /** Resolve (or reject) the N-th held status read. */
  readonly resolveRead: (index: number, result: WebAccessStatus | { readonly error: string }) => void
  /** Replace the LIVE Config authority (the Remote mirror's invalidation). */
  readonly setAuthority: (
    readiness: 'ready' | 'stale' | 'unavailable',
    preference: WebStartupPreferenceState | undefined,
  ) => void
  readonly releaseToggle: () => void
  readonly releaseUrl: () => void
  readonly key: (data: string) => Promise<void>
  readonly flush: () => Promise<void>
  readonly close: () => void
}

async function mount(options: PageHarnessOptions = {}): Promise<PageHarness> {
  const vt = new VirtualTerminal(options.columns ?? 100, options.rows ?? 30)
  const generation = { value: (options.disconnected === true ? undefined : {}) as object | undefined }
  const listeners = new Set<() => void>()
  let status: WebAccessStatus = options.status ?? { state: 'enabled' }
  let preference = 'preference' in options
    ? options.preference
    : { autoStart: false, revision: 1, userOverridden: false } satisfies WebStartupPreferenceState
  let readiness = options.readiness ?? 'ready'
  let reads = 0
  const writes: boolean[] = []
  const urlReads = { count: 0 }
  const opened: string[] = []
  const copied: string[] = []
  const commits: string[] = []
  const commitRevisions: number[] = []
  const diagnoses: { label: string; detail: Record<string, unknown> }[] = []
  let doneCalls = 0
  let pageRef: WebUiSettingsPage | undefined
  let heldToggle: (() => void) | undefined
  let heldUrl: (() => void) | undefined
  const heldReads: Array<(result: WebAccessStatus | Error) => void> = []
  const tasks: Promise<void>[] = []
  const intents: WebUiSettingsPageIntents = {
    backendKind: options.backendKind ?? 'remote',
    readStatus: async () => {
      reads += 1
      // The real Remote adapter's single-call fence rejects a read while no
      // Host generation exists.
      if (generation.value === undefined) throw new Error('the Client is not connected to a Host')
      if (options.holdRead === true) {
        return await new Promise<WebAccessStatus>((resolve, reject) => {
          heldReads.push(result => { if (result instanceof Error) reject(result); else resolve(result) })
        })
      }
      if (options.readFailure !== undefined) throw new Error(options.readFailure)
      return status
    },
    setEnabled: async (enabled) => {
      if (options.toggleFailure === undefined && options.settledStatus === undefined) {
        // Default: the Host adopts the request.
        await new Promise<void>(resolve => { heldToggle = resolve })
      }
      writes.push(enabled)
      if (options.toggleFailure !== undefined) throw new Error(options.toggleFailure)
      status = options.settledStatus ?? (enabled ? { state: 'enabled' } : { state: 'disabled' })
      return status
    },
    getAuthenticatedUrl: async () => {
      urlReads.count += 1
      if (options.urlFailure !== undefined) throw new Error(options.urlFailure)
      if (options.holdUrl === true) await new Promise<void>(resolve => { heldUrl = resolve })
      return { url: 'http://127.0.0.1:4321/?token=SECRET-LAUNCH-TOKEN' }
    },
    openUrl: (url) => { opened.push(url); return true },
    copyToClipboard: async (text) => { copied.push(text); return options.copy ?? true },
    readPreference: () => preference,
    configReadiness: () => readiness,
    commitAutostart: async (value, revision) => {
      commits.push(value)
      commitRevisions.push(revision)
      if (options.commitFailure !== undefined) throw new Error(options.commitFailure)
      return options.commit ?? { outcome: 'verified' }
    },
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
  const page = new WebUiSettingsPage(intents)
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
    urlReads: () => urlReads.count,
    opened: () => opened,
    copied: () => copied,
    commits: () => commits,
    commitRevisions: () => commitRevisions,
    diagnoses: () => diagnoses,
    doneCalls: () => doneCalls,
    generation,
    bumpGeneration: () => {
      generation.value = {}
      for (const listener of [...listeners]) listener()
    },
    connect: () => {
      generation.value = {}
      for (const listener of [...listeners]) listener()
    },
    setAuthority: (nextReadiness, nextPreference) => {
      readiness = nextReadiness
      preference = nextPreference
    },
    resolveRead: (index, result) => {
      const settle = heldReads[index]
      if (settle === undefined) throw new Error(`no held read at index ${index}`)
      settle(typeof result === 'object' && 'error' in result ? new Error(result.error) : result)
    },
    releaseToggle: () => { heldToggle?.(); heldToggle = undefined },
    releaseUrl: () => { heldUrl?.(); heldUrl = undefined },
    key,
    flush: () => settleAll(vt),
    close: () => mountRef.close(),
  }
}

async function settleAll(vt: VirtualTerminal): Promise<void> {
  // The page's owned tasks settle on their own owner; a HELD write stays
  // pending, so this only drains microtasks and paints — it never awaits a
  // dispatch the case intentionally keeps open.
  for (let round = 0; round < 8; round += 1) await Promise.resolve()
  await vt.waitForRender()
}

test('PAGE: the enabled first focus is Open in browser; the disabled one is Enable Web', async () => {
  const enabled = await mount({ status: { state: 'enabled' } })
  assert.match(enabled.frame(), /^> Open in browser/mu)
  enabled.close()
  const disabled = await mount({ status: { state: 'disabled' } })
  assert.match(disabled.frame(), /^> Enable Web/mu)
  assert.equal(disabled.reads(), 1, 'one Host read on mount, never a poll')
  disabled.close()
})

test('PAGE: with no Host action the editable preference is the first focus, else Refresh', async () => {
  const direct = await mount({ backendKind: 'direct' })
  assert.match(direct.frame(), /Serving\s+Unavailable · Split Host only/u)
  assert.match(direct.frame(), /^> Start automatically/mu, 'the editable preference owns the focus')
  assert.equal(direct.reads(), 0, 'Direct performs no Host read')
  direct.close()
  const noPreference = await mount({ backendKind: 'direct', preference: undefined, readiness: 'unavailable' })
  assert.match(noPreference.frame(), /^> Refresh/mu, 'with no editable preference, Refresh owns the focus')
  assert.match(noPreference.frame(), /Start automatically\s+Unavailable/u, 'the value is never defaulted')
  noPreference.close()
})

test('PAGE: the Esc ladder cancels a confirmation before leaving, and leaves no write behind', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await h.key('\x1b[B') // Open -> Copy
  await h.key('\x1b[B') // Copy -> Disable
  await h.key('\r') // in-page confirmation
  assert.match(h.frame(), /Stop serving the Web UI\? Existing browser credentials and sessions are not revoked\./u)
  assert.equal(h.doneCalls(), 0, 'the confirmation does not leave the page')
  await h.key('\x1b')
  assert.match(h.frame(), /Serving\s+Enabled/u, 'Esc cancels the confirmation only')
  assert.equal(h.writes().length, 0)
  assert.equal(h.doneCalls(), 0)
  await h.key('\x1b')
  assert.equal(h.doneCalls(), 1, 'the plain page Esc is the root leave')
  h.close()
})

test('PAGE: the next-start candidate ladder stages zero writes and saves only on Confirm save', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await h.key('\x1b[B')
  await h.key('\x1b[B')
  await h.key('\x1b[B') // Disable -> Start automatically
  assert.match(h.frame(), /^> Start automatically/mu)
  await h.key('\r') // candidate choice
  assert.match(h.frame(), /Choose the value the next Host start applies:/u)
  assert.match(h.frame(), /Off\s+\[current\]/u, 'the current candidate carries the whole state chip')
  assert.equal(h.commits().length, 0)
  await h.key('\r') // stage the focused candidate (On)
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  await h.key('\x1b') // back to the candidates
  assert.match(h.frame(), /Choose the value the next Host start applies:/u)
  await h.key('\x1b') // cancel the choice
  assert.match(h.frame(), /Serving\s+Enabled/u)
  assert.equal(h.commits().length, 0, 'the whole ladder staged zero writes')
  assert.equal(h.doneCalls(), 0)
  h.close()
})

test('PAGE: a pending runtime write leaves on Esc while its owner keeps settling, diagnosed', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  await h.key('\r') // Enable Web
  assert.match(h.frame(), /Waiting for the answer…/u)
  assert.match(h.bar(), /Back \[Esc\]/u, 'a pending write offers no second action')
  assert.equal(h.writes().length, 0, 'the Host call is still running')
  await h.key('\x1b')
  assert.equal(h.doneCalls(), 1, 'Esc leaves the page; it never cancels the dispatched write')
  h.releaseToggle()
  await h.flush()
  assert.equal(h.writes().length, 1, 'the request settled under its own owner')
  assert.equal(h.diagnoses().length, 1, 'the gone page diagnoses the real outcome')
  assert.equal(h.diagnoses()[0]?.label, 'web ui runtime write')
  assert.equal(h.diagnoses()[0]?.detail.dispatched, true)
  h.close()
})

test('PAGE: a Host generation change revokes the actions and re-reads before any new action', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  const readsBefore = h.reads()
  h.bumpGeneration()
  await h.flush()
  assert.ok(h.reads() > readsBefore, 'the new Host is re-read')
  assert.match(h.frame(), /Serving\s+Enabled/u)
  h.close()
})

test('PAGE: a generation change during a pending write reports Outcome unconfirmed', async () => {
  const h = await mount({ status: { state: 'disabled' } })
  await h.key('\r') // Enable, held
  h.bumpGeneration()
  await h.flush()
  assert.match(h.frame(), /Status\s+Outcome unconfirmed/u)
  assert.equal(h.writes().length, 0, 'the toggle had not even settled yet')
  h.close()
})

test('PAGE: a lost toggle receipt is Outcome unconfirmed and is never retried', async () => {
  const h = await mount({ status: { state: 'disabled' }, toggleFailure: 'the connection dropped after dispatch' })
  await h.key('\r')
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'exactly one dispatch')
  assert.match(h.frame(), /Status\s+Outcome unconfirmed/u)
  assert.match(h.frame(), /the Host may have applied the request/u)
  await h.flush()
  assert.deepEqual(h.writes(), [true], 'no automatic retry')
  h.close()
})

test('PAGE: the launch URL is requested only by an explicit Open/Copy and never painted', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await h.flush()
  assert.equal(h.urlReads(), 0)
  await h.key('r') // refresh
  assert.equal(h.urlReads(), 0)
  await h.key('\r') // Open in browser
  await h.flush()
  assert.equal(h.urlReads(), 1)
  assert.deepEqual(h.opened(), ['http://127.0.0.1:4321/?token=SECRET-LAUNCH-TOKEN'])
  assert.match(h.frame(), /Status\s+Browser open requested/u)
  assert.doesNotMatch(h.frame(), /SECRET-LAUNCH-TOKEN/u)
  await h.key('\x1b[B')
  await h.key('\r') // Copy access link
  await h.flush()
  assert.equal(h.urlReads(), 2, 'exactly one URL request per explicit action')
  assert.deepEqual(h.copied(), ['http://127.0.0.1:4321/?token=SECRET-LAUNCH-TOKEN'])
  assert.match(h.frame(), /Status\s+Link copied/u)
  assert.doesNotMatch(h.frame(), /SECRET-LAUNCH-TOKEN/u)
  h.close()
})

test('PAGE: a refused URL or clipboard is an honest error, never a fake success', async () => {
  const refused = await mount({ status: { state: 'enabled' }, urlFailure: 'the Host refused the link' })
  await refused.key('\r')
  await refused.flush()
  assert.match(refused.frame(), /Status\s+Open failed/u)
  assert.match(refused.frame(), /the Host refused the link/u)
  refused.close()
  const noClipboard = await mount({ status: { state: 'enabled' }, copy: false })
  await noClipboard.key('\x1b[B')
  await noClipboard.key('\r')
  await noClipboard.flush()
  assert.match(noClipboard.frame(), /Status\s+Clipboard unavailable/u)
  noClipboard.close()
})

test('PAGE: an unreadable Host state revokes every action and states the real failure', async () => {
  const h = await mount({ status: { state: 'enabled' }, readFailure: 'the Client is not connected to a Host' })
  assert.match(h.frame(), /Serving\s+Unavailable/u)
  assert.match(h.frame(), /the Client is not connected to a Host/u)
  assert.match(h.frame(), /^> Start automatically/mu, 'no Host action: the editable preference owns the focus')
  assert.doesNotMatch(h.frame(), /> (?:Open in browser|Copy access link|Disable Web…)/u)
  h.close()
})

test('PAGE: a short grant keeps ONE scrollable column and the Esc affordance', async () => {
  const h = await mount({ status: { state: 'enabled' }, columns: 44, rows: 8 })
  assert.match(h.frame(), /Settings|Current Host/u)
  assert.match(h.bar(), /Back \[Esc\]/u, 'the physical last row keeps the Esc affordance')
  await h.key('\x1b[F') // End scrolls to the preference facts
  assert.match(h.frame(), /Start automatically/u, 'the preference survives the short grant')
  await h.key('\x1b[B') // moving the cursor returns to the selected row
  assert.match(h.frame(), /^> /mu)
  h.close()
})

test('PAGE: a committed preference re-reads the persisted value, never the requested one', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  await h.key('\x1b[B')
  await h.key('\x1b[B')
  await h.key('\x1b[B') // Start automatically
  await h.key('\r') // candidates
  await h.key('\r') // confirm step
  await h.key('\r') // Confirm save
  await h.flush()
  assert.deepEqual(h.commits(), ['On'], 'the EXISTING writer received the staged candidate')
  assert.match(h.frame(), /Status\s+Verified/u)
  assert.equal(h.writes().length, 0, 'the preference write never toggles the running Host')
  h.close()
})

test('PAGE: a URL reply from a REPLACED Host never reaches the opener', async () => {
  const h = await mount({ status: { state: 'enabled' }, holdUrl: true })
  await h.key('\r') // Open in browser: the URL RPC is held
  await h.flush()
  assert.equal(h.urlReads(), 1)
  h.bumpGeneration()
  await h.flush()
  h.releaseUrl()
  await h.flush()
  assert.deepEqual(h.opened(), [], 'the replaced Host\'s token never reached the Client opener')
  assert.match(h.frame(), /Status\s+Open failed/u, 'the cancelled hand-off is stated')
  assert.match(h.frame(), /the Host changed before the link was handed over/u)
  assert.doesNotMatch(h.frame(), /SECRET-LAUNCH-TOKEN/u)
  assert.equal(h.urlReads(), 1, 'the URL is never requested a second time')
  assert.equal(h.reads(), 2, 'exactly ONE generation re-read (the subscription), never a duplicate')
  h.close()
})

test('PAGE: a URL reply from a REPLACED Host never reaches the clipboard', async () => {
  const h = await mount({ status: { state: 'enabled' }, holdUrl: true })
  await h.key('\x1b[B') // Open -> Copy
  await h.key('\r')
  await h.flush()
  assert.equal(h.urlReads(), 1)
  h.bumpGeneration()
  await h.flush()
  h.releaseUrl()
  await h.flush()
  assert.deepEqual(h.copied(), [], 'the replaced Host\'s token never reached the clipboard')
  assert.match(h.frame(), /Status\s+Clipboard unavailable/u)
  assert.match(h.frame(), /the Host changed before the link was handed over/u)
  h.close()
})

test('PAGE: a /web opened while DISCONNECTED settles Unreadable and recovers on connect', async () => {
  const h = await mount({ status: { state: 'enabled' }, disconnected: true })
  // The initial read really failed with the port's own disconnected error and
  // settled as a usable, truthful frame — not an endless Reading/Checking.
  assert.match(h.frame(), /Serving\s+Unavailable/u)
  assert.match(h.frame(), /the Client is not connected to a Host/u)
  assert.doesNotMatch(h.frame(), /Reading the Host Web state…/u)
  assert.match(h.frame(), /Actions\s*\n\s+Refresh/u, 'the settled page offers Refresh')
  assert.match(h.bar(), /Refresh \[R\] · Back \[Esc\]/u)
  assert.equal(h.reads(), 1)
  assert.equal(h.writes().length, 0, 'a disconnected page offers no Host action')
  // The real reconnection drives exactly ONE authoritative re-read.
  h.connect()
  await h.flush()
  assert.equal(h.reads(), 2)
  assert.match(h.frame(), /Serving\s+Enabled/u)
  assert.match(h.frame(), /Open in browser/u, 'the recovered Host really offers its actions')
  assert.match(h.frame(), /> Start automatically/u,
    'the established focus is kept across the reconnection, never yanked to another row')
  assert.equal(h.writes().length, 0)
  h.close()
})

test('PAGE: a status reply from a superseded generation is never painted as current', async () => {
  const h = await mount({ status: { state: 'disabled' }, holdRead: true })
  // Read #1 is in flight for Host A; the Host is then replaced and read #2
  // starts. The OLD reply settles first and must not speak for Host B.
  h.bumpGeneration()
  await h.flush()
  h.resolveRead(0, { state: 'enabled' })
  await h.flush()
  assert.doesNotMatch(h.frame(), /Serving\s+Enabled/u, 'the replaced Host\'s reply is never painted')
  assert.match(h.frame(), /Serving\s+Checking…/u)
  h.resolveRead(1, { state: 'disabled' })
  await h.flush()
  assert.match(h.frame(), /Serving\s+Disabled/u, 'only the current Host\'s reply settles the fact')
  h.close()
})

test('PAGE: a Host rollover revokes the next-start edit grant taken from the old Config mirror', async () => {
  const h = await mount({ status: { state: 'enabled' } })
  // Stage the confirmation through the page's own ladder (zero writes so far).
  await h.key('\x1b[B')
  await h.key('\x1b[B')
  await h.key('\x1b[B') // Start automatically
  await h.key('\r') // candidate choice
  await h.key('\r') // -> confirm-save
  assert.match(h.frame(), /Save the next Host start preference as On\?/u)
  assert.equal(h.commits().length, 0)
  // The Remote Config mirror invalidates on the Host rollover: readiness goes
  // unavailable and no committed preference remains.
  h.setAuthority('unavailable', undefined)
  h.bumpGeneration()
  await h.flush()
  assert.doesNotMatch(h.frame(), /Confirm save|Save the next Host start|Cancel/u,
    'the staged confirmation derived from the old authority is revoked')
  assert.match(h.frame(), /Start automatically\s+Unavailable/u, 'the stale value is never painted as current')
  assert.doesNotMatch(h.frame(), /Change…/u, 'no edit affordance under a non-current authority')
  assert.match(h.frame(), /The Host configuration is unavailable; the next-start preference is read-only\./u)
  // The preference row left the keyboard order entirely: no number of Down
  // presses can focus it, and no Enter can stage or dispatch it.
  for (let step = 0; step < 6; step += 1) {
    await h.key('\x1b[B')
    assert.doesNotMatch(h.frame(), /> Start automatically/u, 'the non-current preference is not focusable')
  }
  assert.equal(h.commits().length, 0, 'zero preference writes under a non-current authority')
  assert.equal(h.writes().length, 0)
  // Reconnection: the NEW Host's mirror commits a CHANGED value + revision.
  h.setAuthority('ready', { autoStart: true, revision: 7, userOverridden: true })
  h.bumpGeneration()
  await h.flush()
  assert.match(h.frame(), /Start automatically\s+On · Change…/u, 'the new value is adopted from the live authority')
  // The staged change must submit the NEW revision, never the old one: the
  // fixture writer refuses any other revision.
  for (let step = 0; step < 8 && !/^> Open in browser/mu.test(h.frame()); step += 1) await h.key('\x1b[B')
  assert.match(h.frame(), /^> Open in browser/mu, 'the focus is deterministic before the staged change')
  for (let step = 0; step < 3; step += 1) await h.key('\x1b[B') // Open -> Copy -> Disable -> Start automatically
  await h.key('\r') // candidates: the OPPOSITE of the persisted On is staged (Off)
  await h.key('\r') // -> confirm-save
  await h.key('\r') // Confirm save
  await h.flush()
  assert.deepEqual(h.commitRevisions(), [7], 'the adoption really refreshed the revision')
  assert.deepEqual(h.commits(), ['Off'])
  assert.match(h.frame(), /Status\s+Verified/u)
  h.close()
})

test('PAGE: a throwing commit is an honest unconfirmed outcome', async () => {
  const h = await mount({ status: { state: 'enabled' }, commitFailure: 'the writer crashed' })
  await h.key('\x1b[B')
  await h.key('\x1b[B')
  await h.key('\x1b[B') // Start automatically
  await h.key('\r') // candidates
  await h.key('\r') // confirm step
  await h.key('\r') // Confirm save
  await h.flush()
  assert.match(h.frame(), /Status\s+Outcome unconfirmed/u)
  assert.match(h.frame(), /the writer crashed/u)
  h.close()
})
