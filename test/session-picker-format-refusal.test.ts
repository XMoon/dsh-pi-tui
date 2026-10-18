/**
 * S2/PR-B §B1 / S2-16 — an UNREADABLE stored Session on the real Session
 * Picker path (L6).
 *
 * SOURCE → DECISION → SINK: the official persistence refuses a stored Session
 * it cannot read (unsupported/newer format) with its own diagnostic; the TUI
 * must SHOW that refusal on the user's surface and never mount the unreadable
 * log as if it had opened.
 *
 * FIXTURE (real): the runner + real TuiApp on a virtual terminal, the real
 * `/sessions` command and picker path. STAND-IN: the resume operation itself
 * (the harness rejects with the OFFICIAL refusal message the persistence
 * throws). ABSENT: a corrupt artifact on disk (the reader-level proof lives in
 * `session-v4-rc2-persistence.test.ts`).
 *
 * @module @xmoon76/dsh-pi-tui/session-picker-format-refusal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  disposeContext,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
} from './support/runner-harness.ts'
import { installProbe } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'

const CURRENT = 'session-format-current'
const REFUSED = 'session-format-newer'

/** The OFFICIAL refusal text the JSONL persistence throws for a newer format. */
const REFUSAL = 'stored Session uses newer format v5; this build writes v4'

for (const [columns, rows] of [[120, 40], [80, 10], [44, 20]] as const) test(`the real Session Picker format refusal at ${columns}x${rows}`, async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-format-refusal-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(columns, rows)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose(): Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const current = fakeSession({
    id: CURRENT,
    // The picker's default scope is the CURRENT DIRECTORY: give the rows the
    // runner's client cwd so the roster itself is what this test exercises.
    header: { id: CURRENT, cwd: process.cwd(), createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('current answer'),
  })
  const refused = fakeSession({
    id: REFUSED,
    header: { id: REFUSED, cwd: process.cwd(), createdAt: 1_700_000_001_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('stored answer'),
  })
  const harness = makeHarness(home, [current, refused], { provider: 'p', model: 'm' }, undefined, undefined, undefined, undefined, undefined, new Error(REFUSAL))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: CURRENT }, { sessionId: CURRENT })
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  await vt.waitForRender()

  // Open the real picker through the real command path.
  vt.sendInput('/sessions')
  await settle()
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  // The picker lists BOTH stored Sessions (short display ids) in the current
  // directory scope; the newer (refused) row sorts first.
  for (const line of vt.getViewport()) {
    assert.ok(visibleWidth(line) <= columns, `no frame row overflows ${columns} cells: ${JSON.stringify(line)}`)
  }
  assert.match(view(), /2\/2/u, `the picker lists the stored Sessions:\n${view()}`)
  if (columns >= 120) {
    assert.match(view(), /format-n/u)
    assert.match(view(), /format-c/u)
  }

  // The boot resumed the initial Session; record that count so the assertion
  // below covers only the resume THIS Enter triggered.
  const resumesBefore = harness.resumeSessionIds.length
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  // The refusal came from the REFUSED row, not from whichever row happened to
  // be selected: this Enter's resume attempt names that exact stored Session.
  assert.deepEqual(harness.resumeSessionIds.slice(resumesBefore), [REFUSED],
    'the picker resumed the newer-format Session the user selected')
  const after = view()
  const noticeText = (probe.apps.at(-1) as unknown as {
    currentNotice?: () => { readonly text: string } | undefined
  }).currentNotice?.()?.text
  assert.equal(noticeText?.includes(REFUSAL), true,
    `the refusal notice is the official message, got: ${String(noticeText)}`)
  if (columns >= 120) {
    assert.ok(after.includes(REFUSAL), `the refusal text reaches the user's surface:\n${after}`)
  }
  // The unreadable Session's own content is never mounted as if it had opened.
  assert.doesNotMatch(after, /stored answer/u, 'the refused log content is never presented')
  // The failed transition leaves a sessionless surface with the explicit
  // refusal (this harness cannot prove the runner restores a previous owner
  // after a failed resume — recorded as NOT_VERIFIED in the S2 evidence).
})
