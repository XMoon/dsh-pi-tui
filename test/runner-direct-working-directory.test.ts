/**
 * S2/PR-B §B2 — the Direct effective working directory on the REAL TUI path
 * (L6): a committed `working_directory` change moves the status/footer fact and
 * the terminal-LOCAL OSC 7 projection of the live Session, while the Session
 * header (the original project, the roster grouping fact) is untouched.
 *
 * FIXTURES (real): (1) the Direct TSP fixture — real Cordis composition, the
 * real `workingDirectory` owner, a real JSONL Session, a real Agent created
 * through the runner's own startup path, the real `working_directory` tool row
 * and the real runner; the observation tap is the PRODUCTION sink
 * `StatusStore.update` (the patch the footer renders from), patched without
 * binding and passing every call through. (2) the PiTui runner harness — the
 * PHYSICAL footer frame in a virtual terminal plus the OSC 7 bytes on the
 * terminal (the TSP pane deliberately owns its own cwd presentation, so OSC 7
 * is only meaningful on the PiTui branch). ABSENT: a real model request,
 * network, the user's real DSH_HOME.
 *
 * @module @xmoon76/dsh-pi-tui/runner-direct-working-directory.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as toolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { StatusStore } from '../src/domain/status/store.ts'
import { ternCwdSequence } from '../src/tui/terminal/tern.ts'
import { createDirectTspFixture, waitFor } from './support/direct-tsp-fixture.ts'
import {
  disposeContext,
  fakeSession,
  makeHarness,
  mountRunner,
  settle,
  installVirtualProcessTerminal,
} from './support/runner-harness.ts'
import { installProbe } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Tap the PRODUCTION status sink without replacing it: every call continues
 *  through the original unbound function on the real receiver. */
function recordStatusWorkspaceCwds(): { readonly cwds: string[]; restore(): void } {
  const cwds: string[] = []
  const originalStatusUpdate = StatusStore.prototype.update
  StatusStore.prototype.update = function (patch) {
    const cwd = patch.workspace?.cwd
    if (typeof cwd === 'string' && cwd !== '') cwds.push(cwd)
    return originalStatusUpdate.call(this, patch)
  }
  return { cwds, restore() { StatusStore.prototype.update = originalStatusUpdate } }
}

test('a committed cd moves the status workspace of the live Session and never the header', async t => {
  const life = testLifecycle(t)
  const recorded = recordStatusWorkspaceCwds()
  life.defer(recorded.restore)
  const fixture = await createDirectTspFixture(life, { workingDirectory: true })
  // The fixture's preset declarations compose no tools of their own; the
  // official tool row is mounted on the Host registry so the REAL
  // `working_directory` call runs through the real ToolRuntime.
  await fixture.ctx.plugin(toolWorkingDirectory)
  await waitFor('renderer', () => fixture.pane.output.text().includes('dock.composer'))

  // The session is created by the RUNNER's own startup path (the same path the
  // TUI uses), so its header cwd is the real launch directory.
  fixture.pane.key('hello\r')
  await waitFor('live session', () => [...fixture.ctx.agents.list()].length === 1)
  const agent = [...fixture.ctx.agents.list()][0] as unknown as Agent
  const sessionId = String(agent.session.id)
  const launchCwd = agent.session.header.cwd
  assert.equal(typeof launchCwd, 'string', 'the session header records the launch project')
  assert.ok(recorded.cwds.includes(launchCwd as string), 'the status fact starts at the header project')

  const target = join(fixture.workRoot, 'moved-workspace')
  mkdirSync(target, { recursive: true })
  await fixture.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('s2b-runner-cd'),
    name: 'working_directory',
    arguments: { cd: target },
    agent,
  })

  // The committed change reaches the cwd-dependent presentation of the live
  // Session: the footer/status workspace fact follows the effective directory.
  await waitFor('status workspace follows', () => recorded.cwds.at(-1) === target)
  assert.equal(agent.session.header.cwd, launchCwd, 'the header keeps the ORIGINAL project')

  // The Session roster (the browser/grouping fact) still reports the original
  // project: a cd never re-groups a Session.
  const query = fixture.ctx.get('sessionQuery') as {
    listSessions(signal?: AbortSignal): Promise<readonly { header: { id: string; cwd?: string } }[]>
  }
  const rows = await query.listSessions()
  assert.equal(rows.find(row => String(row.header.id) === sessionId)?.header.cwd, launchCwd)

  await fixture.settle()
})

test('the physical footer and the OSC 7 write follow the Session workingDirectory projection', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-wd-live-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  // The pane is a Tern pane: the ONLY terminal that receives the OSC 7 cwd.
  const previousTerm = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'tern'
  life.defer(() => {
    if (previousTerm === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTerm
  })
  const vt = new VirtualTerminal(100, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const cwdWrites: string[] = []
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    if (data.startsWith('\x1b]7;')) cwdWrites.push(data)
    originalWrite(data)
  }
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  // The ORIGINAL project (the header) and the EFFECTIVE directory (the
  // official `workingDirectory` projection) are different directories: the
  // footer must render the effective one.
  const originalProject = join(home, 'roster-project', 'origin')
  const committed = join(home, 'live-project', 'moved')
  const later = join(home, 'later-project', 'again')
  for (const dir of [originalProject, committed, later]) mkdirSync(dir, { recursive: true })

  const sessionId = 'session-working-directory-live'
  const session = fakeSession({
    id: sessionId,
    header: {
      id: sessionId,
      cwd: originalProject,
      createdAt: 1_700_000_000_000,
      version: SESSION_FORMAT_VERSION,
    },
    events: [],
  })
  const harness = makeHarness(home, [session], { provider: 'p', model: 'm' })
  context = new Context()
  let effective: string = committed
  context.provide('sessionProjections', {
    snapshot: (_session: unknown, keys?: readonly string[]) => ({
      values: keys?.includes('workingDirectory') === true ? { workingDirectory: effective } : {},
    }),
    stateOf: () => undefined,
  })
  fiber = await mountRunner(context, home, harness, { sessionId }, { sessionId })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  await vt.waitForRender()

  // The footer's cwd item renders the EFFECTIVE directory (short form: the
  // last two segments), never the header's original project.
  assert.match(view(), /live-project\/moved/, `the footer must render the effective directory:\n${view()}`)
  assert.ok(!view().includes('roster-project/origin'), 'the header project is never the live workspace')

  // A committed change and its durable event move the footer AND the
  // terminal-local OSC 7 write (the status owner's refresh, not a repaint
  // coincidence).
  effective = later
  const next = session.append!('working-directory/change', { cwd: later }) as SessionEvent
  context.emit('session/event', session as never, next)
  await settle()
  await vt.waitForRender()
  assert.match(view(), /later-project\/again/, `the footer must follow the committed change:\n${view()}`)
  const expected = ternCwdSequence(later)
  assert.notEqual(expected, undefined)
  assert.ok(
    cwdWrites.includes(expected as string),
    `the terminal-local OSC 7 write must carry the committed directory (saw ${JSON.stringify(cwdWrites)})`,
  )
})

test('an UNAVAILABLE working-directory read never falls back to the header project', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-wd-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const previousTerm = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'tern'
  life.defer(() => {
    if (previousTerm === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTerm
  })
  const vt = new VirtualTerminal(100, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const cwdWrites: string[] = []
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    if (data.startsWith('\x1b]7;')) cwdWrites.push(data)
    originalWrite(data)
  }
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose(): Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const originalProject = join(home, 'roster-project', 'origin')
  mkdirSync(originalProject, { recursive: true })
  const sessionId = 'session-working-directory-failure'
  const session = fakeSession({
    id: sessionId,
    header: {
      id: sessionId,
      cwd: originalProject,
      createdAt: 1_700_000_000_000,
      version: SESSION_FORMAT_VERSION,
    },
    events: [],
  })
  const harness = makeHarness(home, [session], { provider: 'p', model: 'm' })
  context = new Context()
  // The projection authority is READABLE at open (the effective B) and then
  // starts FAILING: the status owner must treat that as UNKNOWN — never as the
  // immutable header project.
  let failing = false
  let effective: string | undefined = join(home, 'live-project', 'moved')
  mkdirSync(effective, { recursive: true })
  context.provide('sessionProjections', {
    snapshot: (_session: unknown, keys?: readonly string[]) => {
      if (failing) throw new Error('projection authority unavailable')
      return { values: keys?.includes('workingDirectory') === true ? { workingDirectory: effective } : {} }
    },
    stateOf: () => undefined,
  })
  fiber = await mountRunner(context, home, harness, { sessionId }, { sessionId })
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  await vt.waitForRender()
  assert.match(view(), /live-project\/moved/, 'the readable authority paints the effective directory')

  failing = true
  effective = undefined
  // The footer paints the VALUE, not a label. Its cwd row is the model row
  // (`[p/m]  <cwd> …`); the welcome card paints a cwd too, so the state word
  // must be asserted on the FOOTER row specifically.
  const stripLine = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '')
  const footerRow = (): string => stripLine(vt.getViewport().find(line => stripLine(line).trimStart().startsWith('[p/m]')) ?? '')
  assert.match(footerRow(), /live-project\/moved/u, 'the footer row carries the effective directory before the failure')

  // The durable change event drives the SAME production refresh path
  // (`refreshWorkspaceFacts`), which re-reads the now-failing authority.
  const next = session.append!('working-directory/change', { cwd: join(home, 'elsewhere') }) as SessionEvent
  context.emit('session/event', session as never, next)
  await settle()
  await vt.waitForRender()
  const after = view()
  assert.ok(!after.includes('roster-project/origin'),
    `the failed read must not present the header project as the workspace:\n${after}`)
  assert.ok(!cwdWrites.some(write => write.includes('roster-project')),
    `the failed read must not publish the header project through OSC 7: ${JSON.stringify(cwdWrites)}`)
  assert.ok(!footerRow().includes('roster-project'),
    'the footer cwd fact stays unknown while the authority is unavailable')
  // Plan §B2 UI: the unavailable state has WORDS, not a blank slot — asserted on
  // the FOOTER row itself.
  assert.match(footerRow(), /Unavailable/u,
    `the footer cwd row states the unknown directory:\n${after}`)
})

test('the child viewer states Unavailable for an unreadable child cwd and never the parent project', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-wd-child-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const previousTerm = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'tern'
  life.defer(() => {
    if (previousTerm === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTerm
  })
  const vt = new VirtualTerminal(120, 40)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose(): Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parentProject = join(home, 'roster-project', 'origin')
  const childProject = join(home, 'child-project')
  mkdirSync(parentProject, { recursive: true })
  mkdirSync(childProject, { recursive: true })
  const parent = fakeSession({
    id: 'session-child-cwd-parent',
    header: { id: 'session-child-cwd-parent', cwd: parentProject, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [],
  })
  const child = fakeSession({
    id: 'child-cwd-subject',
    header: {
      id: 'child-cwd-subject',
      cwd: childProject,
      createdAt: 1_700_000_001_000,
      version: SESSION_FORMAT_VERSION,
      parentSession: 'session-child-cwd-parent',
    },
    events: [],
  })
  let childReadable = true
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, {
    // The child is a REAL local catalog entry (the same source the Task Center
    // reads); the parent is the display fallback candidate that must never be
    // borrowed for the child's workspace.
    listDescendants: async () => [{
      kind: 'child', id: 'child-cwd-subject', label: 'child subject', mode: 'continuable', parentId: '', depth: 1,
    }],
  })
  context = new Context()
  context.provide('sessionProjections', {
    snapshot: (session: { readonly header?: { readonly id?: string; readonly cwd?: string } }, keys?: readonly string[]) => {
      if (session?.header?.id === 'child-cwd-subject' && !childReadable) {
        throw new Error('child projection authority unavailable')
      }
      return {
        values: keys?.includes('workingDirectory') === true && session?.header?.cwd !== undefined
          ? { workingDirectory: session.header.cwd }
          : {},
      }
    },
    // The registry contract the composition's other readers use (a missing
    // method here is a fatal, not a degradation).
    stateOf: () => undefined,
    cachedSnapshot: () => undefined,
    register: () => () => {},
  } as never)
  // The child is LIVE in this process (the viewer attaches a retained child):
  // its status read is the authority the footer consults.
  await (harness.agents as { resume(init: { resumeSessionId: string }): Promise<unknown> })
    .resume({ resumeSessionId: 'child-cwd-subject' })
  fiber = await mountRunner(context, home, harness, { sessionId: 'session-child-cwd-parent' }, { sessionId: 'session-child-cwd-parent' })
  const view = (): string => vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n')
  await vt.waitForRender()

  // Open the child viewer through the REAL Task Center path.
  vt.sendInput('/tasks')
  await settle()
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  assert.match(view(), /child subject/u, `the child row is listed:\n${view()}`)
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  assert.match(view(), /child-project/u, `the readable child cwd is painted:\n${view()}`)
  const childCwdRow = vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))
    .findIndex(line => line.includes('child-project'))
  assert.ok(childCwdRow >= 0, 'the child footer row carries the child workspace')
  assert.ok(!vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))[childCwdRow]!.includes('roster-project/origin'),
    'the parent project is never the child workspace')

  // The child's projection starts FAILING: the child viewer's workspace fact is
  // UNKNOWN and must be stated in words on the footer line itself.
  childReadable = false
  // A durable child event drives the viewer's own refresh (the same production
  // path a real child change takes), which re-reads the now-failing authority.
  const childEvent = child.append!('working-directory/change', { cwd: join(home, 'elsewhere') }) as SessionEvent
  context.emit('session/event', child as never, childEvent)
  await settle()
  await vt.waitForRender()
  const childFooterLine = vt.getViewport().map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))[childCwdRow] ?? ''
  assert.match(childFooterLine, /Unavailable/u,
    `the child's unknown directory is stated on the child footer row:\n${view()}`)
  assert.ok(!childFooterLine.includes('roster-project/origin'), 'still never the parent project')
})
