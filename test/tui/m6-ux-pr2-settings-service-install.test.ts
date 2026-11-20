/**
 * M6 UX PR2 Step C: the ONE optional service-install follow-up inside the SAME
 * Settings lease.
 *
 * Evidence level: mounted panel behaviour (L2). It proves the verified
 * `direct → daemon` follow-up is presented exactly once, that `Not now`/Esc
 * perform zero admin IO, that a single explicit confirmation drives exactly one
 * install through the command layer, and that a stale or superseded settlement
 * never repaints a newer follow-up.
 * @module @xmoon76/dsh-pi-tui/m6-ux-pr2-settings-service-install.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SettingsWorkspacePanel,
  type SettingsWorkspaceCommitOutcome,
  type SettingsWorkspacePanelIntents,
  type SettingsWorkspaceSnapshot,
} from '../../src/tui/panels/settings-workspace-panel.ts'

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/gu, '').trimEnd()

const backendRow = () => ({
  id: 'startup-backend' as const,
  category: 'general',
  label: 'Backend',
  summary: 'Daemon',
  value: 'Daemon',
  scope: 'DSH Host profile · next cold launch',
  freshness: 'ready' as const,
  description: 'Which backend a new launch runs',
  edit: {
    field: 'startup-backend' as const,
    primary: 'persisted' as const,
    runtime: 'Applies on next launch; current TUI/Host remains unchanged',
    persisted: 'Daemon',
    revision: 3,
    options: [
      { value: 'Direct', label: 'Direct', available: true, current: false },
      { value: 'Daemon', label: 'Daemon', available: true, current: true },
    ],
  },
})

const SNAPSHOT: SettingsWorkspaceSnapshot = {
  configReadiness: 'ready',
  capturedAt: 0,
  rows: [backendRow()],
} as SettingsWorkspaceSnapshot

function setup(options: {
  readonly installable?: boolean
  readonly onBackendServiceInstall?: (settle: (result: { ok: boolean; detail?: string }) => void) => void
  readonly snapshot?: () => SettingsWorkspaceSnapshot
} = {}): {
  readonly panel: SettingsWorkspacePanel
  readonly settlements: ((outcome: SettingsWorkspaceCommitOutcome) => void)[]
  readonly installCalls: () => number
  readonly renders: () => number
} {
  let renders = 0
  let installCalls = 0
  const settlements: ((outcome: SettingsWorkspaceCommitOutcome) => void)[] = []
  const intents: SettingsWorkspacePanelIntents = {
    aboutVersionFacts: { tui: '0.5.7', dsh: '0.2.2-rc.5' },
    rows: () => 40,
    columns: () => 120,
    requestRender: () => { renders += 1 },
    notice: () => undefined,
    onClose: () => {},
    onCopy: () => {},
    onCommit: (request, settle) => {
      settlements.push(settle)
      void request
    },
    ...(options.onBackendServiceInstall === undefined
      ? {}
      : {
          onBackendServiceInstall: (settle) => {
            installCalls += 1
            options.onBackendServiceInstall!(settle)
          },
        }),
  }
  const panel = new SettingsWorkspacePanel(
    { readSnapshot: options.snapshot ?? (() => SNAPSHOT) },
    intents,
    { initialRowId: 'startup-backend' },
  )
  return { panel, settlements, installCalls: () => installCalls, renders: () => renders }
}

const renderText = (panel: SettingsWorkspacePanel): string =>
  panel.render(120).map(stripAnsi).join('\n')

/** Paint a frame (the painted grants need a real render), then deliver one key. */
const press = (panel: SettingsWorkspacePanel, key: string): void => {
  panel.render(120)
  panel.handleInput(key)
}

test('a verified direct→daemon commit offers the follow-up with the frozen copy and both actions', () => {
  const { panel, settlements } = setup()
  // Open the Backend row's Detail and commit Daemon through the real choice.
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  assert.equal(settlements.length, 1)
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  const text = renderText(panel)
  assert.match(text, /Optional OS supervision/u)
  assert.match(text, /Daemon works without installing a service\./u)
  assert.match(text, /Install creates this Profile's user service only/u)
  assert.match(text, /Not installed by this action/u)
  assert.match(text, /Install service/u)
  assert.match(text, /Not now/u)
})

test('`Not now` (the default focus, Enter) closes the follow-up with zero admin IO', () => {
  let installCalls = 0
  const { panel, settlements } = setup({
    onBackendServiceInstall: () => { installCalls += 1 },
  })
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  press(panel, '\r') // Enter on the default `Not now`
  const text = renderText(panel)
  assert.doesNotMatch(text, /Optional OS supervision/u, 'the follow-up block is withdrawn')
  assert.equal(installCalls, 0, 'the safe default never reaches the install owner')
})

test('Esc withdraws the follow-up with zero admin IO and keeps the verified save', () => {
  let installCalls = 0
  const { panel, settlements } = setup({
    onBackendServiceInstall: () => { installCalls += 1 },
  })
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  press(panel, '\x1b')
  assert.doesNotMatch(renderText(panel), /Optional OS supervision/u)
  assert.equal(installCalls, 0)
})

test('one explicit `Install service` confirmation drives exactly ONE install, then reports the result', async () => {
  let settleInstall: ((result: { ok: boolean; detail?: string }) => void) | undefined
  const { panel, settlements, installCalls } = setup({
    onBackendServiceInstall: (settle) => { settleInstall = settle },
  })
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  // Tab moves the focus to `Install service`; Enter commits it once.
  press(panel, '\t')
  press(panel, '\r')
  assert.equal(installCalls(), 1)
  // The installing seat locks: a second Enter cannot dispatch a second install.
  press(panel, '\r')
  assert.equal(installCalls(), 1, 'the installing seat accepts no second confirmation')
  assert.match(renderText(panel), /Installing service…/u)
  settleInstall!({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(renderText(panel), /Service installed \(or already owned\)/u)
  assert.doesNotMatch(renderText(panel), /Installing service…/u)
})

test('a failed install reports the truthful refusal and keeps the Daemon save', async () => {
  let settleInstall: ((result: { ok: boolean; detail?: string }) => void) | undefined
  const { panel, settlements } = setup({
    onBackendServiceInstall: (settle) => { settleInstall = settle },
  })
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  press(panel, '\t')
  press(panel, '\r')
  settleInstall!({ ok: false, detail: 'the user manager cannot verify the profile unit' })
  await new Promise(resolve => setImmediate(resolve))
  const text = renderText(panel)
  assert.match(text, /Install could not be verified/u)
  assert.doesNotMatch(text, /Service installed/u, 'a refusal never claims a success')
})

test('an installable=false follow-up paints the truthful platform line and no actable install', () => {
  const { panel, settlements } = setup()
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: false } })
  const text = renderText(panel)
  assert.match(text, /Daemon service install is available on/u, 'the truthful platform line is painted')
  assert.doesNotMatch(text, /Install service/u, 'no actable install control exists without the capability')
})

test('a non-verified outcome never offers the follow-up', () => {
  const { panel, settlements } = setup()
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'not-saved', reason: 'the Host settings changed' })
  assert.doesNotMatch(renderText(panel), /Optional OS supervision/u)
})

test('a superseded settlement (a newer request) cannot repaint an older follow-up', () => {
  const { panel, settlements } = setup()
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  const first = settlements[0]!
  first({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  assert.match(renderText(panel), /Optional OS supervision/u, 'the first verified round earns its follow-up')
  // A newer dispatch bumps the request identity: the old settle is now stale.
  press(panel, '\x1b') // Esc withdraws the follow-up
  press(panel, '\r') // rows → detail (choice opens again)
  press(panel, '\x1b[B')
  press(panel, '\r') // Confirm again → a NEW commit request
  assert.equal(settlements.length, 2)
  // The FIRST (stale) settle must never revive a follow-up for this seat.
  first({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  assert.doesNotMatch(renderText(panel), /Optional OS supervision/u, 'a stale settlement never repaints')
})

test('opening a new choice withdraws the follow-up without undoing the verified save', () => {
  const { panel, settlements } = setup()
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  press(panel, '\r') // Change… / Enter opens the choice again
  assert.doesNotMatch(renderText(panel), /Optional OS supervision/u)
  assert.match(renderText(panel), /Daemon/u, 'the verified persisted value is untouched')
})

test('the follow-up survives the settle refresh and stays inside the SAME lease', () => {
  const { panel, settlements } = setup()
  press(panel, '\r') // rows → detail (choice opens on the Backend row)
  press(panel, '\x1b[B') // move candidate to Daemon
  press(panel, '\r') // Confirm
  settlements[0]!({ outcome: 'verified', followUp: { kind: 'daemon-service-install', installable: true } })
  // The settle's own refresh repaints; the follow-up must still be there.
  assert.match(renderText(panel), /Optional OS supervision/u)
})
