/**
 * S2/PR-B §B1 / S2-16 — the rc.2 external catalog leaf on the REAL Task Center
 * path (L6).
 *
 * SOURCE → DECISION → SINK: the official `subagents.listDescendants` catalog
 * carries a v2 `mode: 'external'` entry; the Task Center row projection keeps
 * it visible with its durable classification and NEVER opens a viewer, offers
 * Stop/Continue, or presents a local child it does not have.
 *
 * FIXTURE (real): the runner + real TuiApp on a virtual terminal, the real
 * `/tasks` command path and the real row/panel projection. STAND-IN: the
 * official descendant catalog source (the test supplies the catalog entries the
 * Host would return). ABSENT: a real subagent provider process.
 *
 * @module @xmoon76/dsh-pi-tui/task-center-external-leaf.test
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
import { VirtualTerminal } from './virtual-terminal.ts'

const SESSION = 'session-external-parent'

test('the REAL Task Center lists an external leaf as visible, non-openable and stop-less', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-external-leaf-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(120, 40)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose(): Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const session = fakeSession({
    id: SESSION,
    header: { id: SESSION, cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer'),
  })
  // The OFFICIAL catalog shape: one local continuable child and one rc.2 v2
  // external execution with NO local child Session.
  let descendantReads = 0
  const harness = makeHarness(home, [session], { provider: 'p', model: 'm' }, undefined, undefined, {
    listDescendants: async () => {
      descendantReads += 1
      return [
        { kind: 'child', id: 'child-local', label: 'local research', mode: 'continuable', parentId: '', depth: 1 },
        { kind: 'child', id: 'child-external', label: 'external run', mode: 'external', parentId: '', depth: 1 },
      ]
    },
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: SESSION }, { sessionId: SESSION })
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  await vt.waitForRender()

  // The completion popup opens on the bare token; Enter accepts it AND submits
  // the line through the REAL submission path (a second Enter would activate
  // the browser's first row).
  vt.sendInput('/tasks')
  await settle()
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  assert.ok(descendantReads > 0, 'the real Task Center read the official descendant catalog')
  const frame = view()
  assert.match(frame, /external · external run/u, `the external leaf is listed with its classification:\n${frame}`)
  assert.match(frame, /External/u, 'the status word states External')
  assert.match(frame, /local research/u, 'local children keep their own rows')

  // Select the external row and press Enter: no viewer opens, no Stop is
  // advertised, and the refusal states why.
  const externalRow = vt.getViewport().findIndex(line => line.replace(/\u001b\[[0-9;]*m/g, '').includes('external · external run'))
  assert.ok(externalRow >= 0)
  // The picker cursor starts on the first row; move to the external row.
  for (let step = 0; step < 4; step += 1) {
    vt.sendInput('\x1b[B')
    await settle()
    if (view().includes('›  external · external run') || view().includes('> external · external run')) break
  }
  await vt.waitForRender()
  const selected = view()
  assert.doesNotMatch(selected, /S stop/u, 'an external leaf never advertises Stop')
  assert.doesNotMatch(selected, /Continue/u, 'an external leaf never advertises Continue')
  const viewersBefore = probe.apps.length
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  assert.match(view(), /external subagent: no local session to open/u, 'Enter states why nothing opened')
  assert.equal(probe.apps.length, viewersBefore, 'no second surface was mounted')
})
