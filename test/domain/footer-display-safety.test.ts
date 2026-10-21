/**
 * Builtin footer fields are terminal chrome: every externally sourced value
 * (workspace cwd/project/branch, model provider/id/effort, agent-preset label,
 * host versions) is folded onto ONE safe physical row at span construction.
 * The generic `renderSpans()` stays a color-only pass, and the Footer Command
 * / extension-span contracts keep their own policies.
 *
 * Two evidence levels: the builtin item renderer over a hostile snapshot, and
 * the REAL default-footer paint through a scripted terminal (captured writes),
 * so a persisted/Host value cannot inject a control sequence or a row break.
 * @module @xmoon76/dsh-pi-tui/footer-display-safety.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { createBuiltinFooterRegistry } from '../../src/tui/footer/builtin-items.ts'
import { renderSpans } from '../../src/tui/footer/composer.ts'
import type { FooterItemRef } from '../../src/tui/footer/presentation-types.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../../src/domain/status/types.ts'
import { TuiApp, type StatusData } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const registry = createBuiltinFooterRegistry()
const CONTEXT = { taskBrowserAvailable: true, extensionFooterText: '' }

/** Strip ANSI SGR sequences for text-level assertions. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

/** LF, CRLF, TAB and an OSC 52 clipboard payload in every external field. */
const HOSTILE = 'Evil\nName\r\nTabbed\tX\u001b]52;c;YXR0YWNr\u0007tail'
/** `sanitizeDisplayText` then fold: TAB becomes three spaces, CRLF becomes one
 *  LF, the OSC payload disappears, and every surviving break becomes a space. */
const COLLAPSED = 'Evil Name Tabbed   Xtail'

function hostileSnapshot(): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.agentPreset = { id: 'code', label: HOSTILE, shortLabel: HOSTILE }
  snap.composition.model = {
    provider: HOSTILE,
    id: HOSTILE,
    displayName: HOSTILE,
    reasoningEffort: HOSTILE,
  }
  snap.workspace = { cwd: `/root/${HOSTILE}`, project: HOSTILE, branch: HOSTILE }
  snap.host = { dshVersion: HOSTILE, tuiVersion: HOSTILE }
  return snap as StatusSnapshot
}

/** Every builtin item that renders an externally sourced string, with its
 *  declared formats (the hostile value must survive in each one). */
const EXTERNAL_ITEMS: Readonly<Record<string, readonly string[]>> = {
  model: ['badge', 'plain', 'compact'],
  cwd: ['short', 'basename', 'full'],
  'git-branch': ['plain', 'label'],
  project: ['plain'],
  'agent-preset': ['badge', 'compact'],
  reasoning: ['plain'],
  version: ['tui', 'dsh', 'both'],
}

test('every externally sourced builtin footer span is one safe physical row', () => {
  const snapshot = hostileSnapshot()
  for (const [id, formats] of Object.entries(EXTERNAL_ITEMS)) {
    const def = registry.get(id)
    assert.ok(def !== undefined, `item ${id} must be registered`)
    for (const format of formats) {
      const ref: FooterItemRef = { id, format }
      const segment = def.render(snapshot, ref, 'preferred', CONTEXT)
      assert.ok(segment !== null, `${id}/${format} must render the hostile fixture`)
      const text = plain(renderSpans(segment.spans))
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text),
        `${id}/${format} carries a control character or row break: ${JSON.stringify(text)}`)
      assert.ok(!text.includes('YXR0YWNr'), `${id}/${format} carries the OSC payload: ${JSON.stringify(text)}`)
      assert.ok(text.includes(COLLAPSED), `${id}/${format} loses the collapsed readable value: ${JSON.stringify(text)}`)
    }
  }
})

/** Every TuiApp constructed here is disposed after each test. */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

test('the REAL default footer paints hostile model/cwd/branch on one physical row each', async () => {
  const vt = new VirtualTerminal(200, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  // Distinct hostile values per field, so each assertion proves ITS own field.
  const modelHostile = 'Model\nName\r\nTabbed\tX\u001b]52;c;YXR0YWNr\u0007tail'
  const cwdHostile = 'cwd\nPart\r\nTabbed\tY\u001b]52;c;YXR0YWNr\u0007tail'
  const branchHostile = 'branch\nPart\r\nTabbed\tZ\u001b]52;c;YXR0YWNr\u0007tail'
  const modelCollapsed = 'Model Name Tabbed   Xtail'
  const cwdCollapsed = 'cwd Part Tabbed   Ytail'
  const branchCollapsed = 'branch Part Tabbed   Ztail'
  const status: StatusData = {
    model: `${modelHostile}/${modelHostile} @${modelHostile}`,
    cwd: `/root/${cwdHostile}`,
    branch: branchHostile,
    turns: 0,
    steps: 0,
    permission: 'workspace-write',
  }
  app.setStatus(status)
  await vt.waitForRender()

  const rows = [...app.footerRenderRowsForTest()]
  assert.ok(rows.length > 0, 'the default footer rendered')
  for (const row of rows) {
    const text = plain(row)
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text),
      `a footer row carries a control character or row break: ${JSON.stringify(text)}`)
    assert.ok(!text.includes('YXR0YWNr'), `a footer row carries the OSC payload: ${JSON.stringify(text)}`)
  }
  const footer = rows.map(plain).join('\n')
  assert.ok(footer.includes(modelCollapsed), `the collapsed model identity survives:\n${footer}`)
  assert.ok(footer.includes(`root/${cwdCollapsed}`), `the collapsed cwd survives:\n${footer}`)
  assert.ok(footer.includes(branchCollapsed), `the collapsed branch survives:\n${footer}`)

  const raw = vt.writes.join('')
  assert.ok(!raw.includes('YXR0YWNr'), 'no OSC 52 payload from footer fields reaches the terminal')
  assert.ok(!raw.includes('\u001b]52'), 'no raw OSC introducer from footer fields reaches the terminal')
  assert.ok(!raw.includes('\u009b'), 'no raw C1 byte from footer fields reaches the terminal')
})
