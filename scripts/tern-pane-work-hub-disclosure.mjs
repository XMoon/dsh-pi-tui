/**
 * PR3 real-headless-client flow: the native Work Hub retained-Job disclosure in
 * a real Tern pane.
 *
 *   TERN_PANE_CASE=full node scripts/tern-pane-drive.mjs scripts/tern-pane-work-hub-disclosure.mjs
 *   TERN_PANE_CASE=history-only ...
 *   TERN_PANE_CASE=empty ...
 *   TERN_PANE_CASE=long ...
 *   TERN_PANE_CASE=scoped ...
 *
 * It drives the SAME production subject as the GUI lane
 * (`scripts/tern-pane-work-hub-disclosure-subject.mts`) and records the real
 * client's node tree, ancestor clipping, PNG captures, control-injected pointer
 * input and the subject's own zero-business-callback ledger.
 *
 * Evidence tier: REAL_TERN_HEADLESS, not a physical GUI and not OS input.
 * @module scripts/tern-pane-work-hub-disclosure
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { visibleBox } from './tern-pane-geometry.mjs'
import { shellQuote } from './tern-pane-instrument.mjs'

const CASE = process.env.TERN_PANE_CASE ?? 'full'
const records = (h) => {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n')
      .filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const recordsOf = (h, key) => records(h).filter((row) => row[key] !== undefined).map((row) => row[key])
const buttons = (h, snap) => h.classNodes(snap, 'pk-btn')
const buttonText = (h, node) => h.descendantsText(node).trim()
const button = (h, snap, fragment) => buttons(h, snap).find((node) => buttonText(h, node).includes(fragment))
const rows = (h, snap) => h.classNodes(snap, 'pk-row').filter((node) => !String(node.class ?? '').split(' ').includes('grp'))
const rowWithText = (h, snap, text) => rows(h, snap).find((node) => h.descendantsText(node).includes(text))
const span = (snap, node) => visibleBox(snap.chains, node).span
const contained = (snap, node) => node !== undefined && span(snap, node).x > 0 && span(snap, node).y > 0
const paintedBar = (h, snap) => buttons(h, snap).map((node) => `${buttonText(h, node)}@${JSON.stringify(span(snap, node))}`).join(' | ')

async function waitForButton(h, fragment) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const snap = h.snapshot()
    if (button(h, snap, fragment) !== undefined) return snap
    await h.sleep(200)
  }
  return undefined
}

/** Press the production subject's key controls through the real client. */
async function typeText(h, text) {
  for (const char of text) await h.key(char, 120)
}

const BUSINESS_FIELDS = ['select', 'stop', 'expose', 'refresh']

function zeroBusinessCalls(h, label) {
  const facts = Object.fromEntries(BUSINESS_FIELDS.map((field) => [field, recordsOf(h, field).length]))
  h.check(`${label}: the local disclosure made no business call`, BUSINESS_FIELDS.every((field) => facts[field] === 0),
    JSON.stringify(facts))
}

/** Launch the subject with THIS driver's own Node absolute path: the Tern
 *  pane shell may have a stripped PATH where `node` is not resolvable. */
async function launchSubject(h, subject, ready) {
  copyFileSync(subject, join(h.root, `subject${extname(subject)}`))
  writeFileSync(join(h.root, 'launch.sh'), `#!/bin/bash
export TERN_PANE_DIR=${shellQuote(h.root)}
cd ${shellQuote(h.repo)} || exit 1
exec ${shellQuote(process.execPath)} --import tsx/esm ${shellQuote(subject)} 2>> ${shellQuote(join(h.root, 'subject.err'))}
`, { mode: 0o755 })
  h.send('run', './launch.sh')
  return ready === undefined ? true : h.waitFor(ready, { timeoutMs: 30_000 })
}

export default async function (h) {
  await h.resize(400, 600)
  writeFileSync(join(h.root, 'case'), CASE)
  const subject = join(h.repo, 'scripts', 'tern-pane-work-hub-disclosure-subject.mts')
  const booted = await launchSubject(h, subject, 'Work Hub')
  h.check(`the production Work Hub boots in a real Tern pane (${CASE})`, booted)
  if (!booted) {
    h.measure('subject stderr', readFileSync(join(h.root, 'subject.err'), 'utf8').slice(0, 600))
    return
  }
  h.measure('client caps', JSON.stringify(records(h).find((row) => row.caps)?.caps))

  let snap = h.snapshot()
  h.measure(`initial action bar (${CASE})`, paintedBar(h, snap))
  h.capture(`work-hub-${CASE}-initial-400x600`, 'the initial collapsed Work Hub')

  if (CASE === 'empty') {
    h.check('an empty roster paints only the native Close action', buttons(h, snap).length === 1
      && button(h, snap, 'Close') !== undefined, paintedBar(h, snap))
    h.check('the empty state is the real empty roster text', h.texts(snap).some((text) => text.includes('No tasks are available for this session.')),
      h.texts(snap).join(' | '))
    h.capture(`work-hub-${CASE}-empty`, 'the genuinely empty Work Hub')
    return
  }

  if (CASE === 'scoped') {
    h.check('a Workflow-scoped child subset paints no Jobs disclosure', button(h, snap, 'Show') === undefined,
      paintedBar(h, snap))
    h.check('the scoped subset keeps Close and the readable View details', button(h, snap, 'Close') !== undefined
      && button(h, snap, 'View details') !== undefined, paintedBar(h, snap))
    h.capture(`work-hub-${CASE}-scoped`, 'the scoped subset without global Jobs')
    return
  }

  if (CASE === 'history-only') {
    h.check('history-only paints Close + Show 2 jobs and no dead View details', buttons(h, snap).length === 2
      && button(h, snap, 'Close') !== undefined && button(h, snap, 'Show 2 jobs') !== undefined
      && button(h, snap, 'View details') === undefined, paintedBar(h, snap))
    h.check('both history-only actions are visible in the normal split pane',
      buttons(h, snap).every((node) => contained(snap, node)), paintedBar(h, snap))
    h.check('history-only states the honest active-empty view', h.texts(snap).some((text) => text.includes('No active Jobs in this view.')),
      h.texts(snap).join(' | '))
    const show = button(h, snap, 'Show 2 jobs')
    if (show !== undefined) {
      const clicked = await h.click(snap.chains, show)
      const expanded = await waitForButton(h, 'Hide 2 past jobs')
      h.check('a real pointer click on Show reveals both retained Jobs once', clicked && expanded !== undefined
        && recordsOf(h, 'retired').length === 0, JSON.stringify(records(h).slice(-6)))
      const first = rowWithText(h, expanded ?? h.snapshot(), 'bash · old lint')
      const firstClasses = String(first?.class ?? '').split(/\s+/)
      h.check('the first retained Job is visibly selected, not only a props value',
        contained(expanded ?? h.snapshot(), first) && firstClasses.includes('sel'),
        JSON.stringify(first === undefined ? { present: false } : { classes: firstClasses, box: visibleBox((expanded ?? h.snapshot()).chains, first) }))
      h.capture(`work-hub-${CASE}-expanded`, 'history-only after the Show click')
      const hide = button(h, expanded ?? h.snapshot(), 'Hide 2 past jobs')
      if (hide !== undefined) {
        const hideSnap = expanded ?? h.snapshot()
        await h.click(hideSnap.chains, hide)
        await waitForButton(h, 'Show 2 jobs')
      }
    }
    zeroBusinessCalls(h, 'history-only disclosure')
    return
  }

  // ── full / long: the ordinary work view ─────────────────────────────────
  h.check('the normal view paints Close + Show 2 past jobs + View details', buttons(h, snap).length === 3
    && button(h, snap, 'Close') !== undefined && button(h, snap, 'Show 2 past jobs') !== undefined
    && button(h, snap, 'View details') !== undefined, paintedBar(h, snap))
  h.check('all three actions are visible in the 400x600 split pane',
    buttons(h, snap).every((node) => contained(snap, node)), paintedBar(h, snap))
  const expectedSubagent = CASE === 'long' ? 'subagent · plan 1' : 'subagent · build plan'
  h.check('the default view shows the subagent tree and only the active Job',
    rowWithText(h, snap, expectedSubagent) !== undefined
      && rowWithText(h, snap, 'bash · compile') !== undefined
      && rowWithText(h, snap, 'bash · old lint') === undefined,
    rows(h, snap).map((node) => h.descendantsText(node).slice(0, 40)).join(' | '))
  const titleNode = snap.nodes.find((node) => String(node.class ?? '').split(' ').includes('pk-title'))
  h.measure('header title attribute', JSON.stringify(titleNode?.title))
  h.check('the folded failed Job stays a truthful status fact in the header title',
    String(titleNode?.title ?? '').includes('1 failed') && String(titleNode?.title ?? '').includes('2 retained Jobs hidden'),
    JSON.stringify(titleNode))

  // Keyboard path: the control channel delivers Alt+J as an ESC-prefixed text
  // input, which the SDK decodes as the same exact chord the program handles.
  h.send('type', '\u001bj')
  const altExpanded = await waitForButton(h, 'Hide 2 past jobs')
  h.check('keyboard Alt+J expands the same history through the same transition', altExpanded !== undefined,
    paintedBar(h, altExpanded ?? h.snapshot()))
  h.send('type', '\u001bj')
  const altCollapsed = await waitForButton(h, 'Show 2 past jobs')
  h.check('keyboard Alt+J hides the same history again', altCollapsed !== undefined,
    paintedBar(h, altCollapsed ?? h.snapshot()))
  zeroBusinessCalls(h, 'the Alt+J toggle')

  const showSnap = h.snapshot()
  const show = button(h, showSnap, 'Show 2 past jobs')
  if (show !== undefined) {
    const clicked = await h.click(showSnap.chains, show)
    const expanded = await waitForButton(h, 'Hide 2 past jobs')
    h.check('one real pointer click on Show repaints Hide and reveals both rows', clicked && expanded !== undefined,
      JSON.stringify(records(h).slice(-6)))
    const first = rowWithText(h, expanded ?? h.snapshot(), 'bash · old lint')
    const firstClasses = String(first?.class ?? '').split(/\s+/)
    h.check('the first retained Job is visibly selected after Show (sel class + visible area)',
      contained(expanded ?? h.snapshot(), first) && firstClasses.includes('sel'),
      JSON.stringify(first === undefined ? { present: false } : { classes: firstClasses, box: visibleBox((expanded ?? h.snapshot()).chains, first) }))
    h.check('the selected retained row shows its real terminal status',
      first !== undefined && h.descendantsText(first).includes('completed'),
      first === undefined ? 'row missing' : h.descendantsText(first))
    h.capture(`work-hub-${CASE}-expanded-400x600`, 'the expanded history')

    // The existing read-only Reader round trip: details on the selected row,
    // Back returns to the SAME expanded Hub.
    const details = button(h, expanded ?? h.snapshot(), 'View details')
    if (details !== undefined) {
      const detailsSnap = expanded ?? h.snapshot()
      await h.click(detailsSnap.chains, details)
      const readerOpened = await h.waitFor('← Work')
      h.check('the retained-Job details open the existing Reader', readerOpened, h.texts(h.snapshot()).join(' | ').slice(0, 600))
      h.capture(`work-hub-${CASE}-reader`, 'the retained-Job Reader')
      await h.key('Escape')
      const back = await waitForButton(h, 'Hide 2 past jobs')
      h.check('Back returns to the SAME expanded history', back !== undefined, paintedBar(h, back ?? h.snapshot()))
      // Collapse explicitly: the search claim below is about the FOLDED view.
      if (back !== undefined) {
        const hide = button(h, back, 'Hide 2 past jobs')
        if (hide !== undefined) await h.click(back.chains, hide)
      }
      const collapsed = await waitForButton(h, 'Show 2 past jobs')
      h.check('the history can be folded again by the native action', collapsed !== undefined,
        paintedBar(h, collapsed ?? h.snapshot()))
    }
  }

  // Plain typing is a query; the hidden failed Job is searchable from the
  // COLLAPSED view.
  await typeText(h, 'failed')
  const searchSnap = await (async () => {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const next = h.snapshot()
      if (rowWithText(h, next, 'bash · deploy') !== undefined && button(h, next, 'Show') === undefined) return next
      await h.sleep(200)
    }
    return undefined
  })()
  h.check('typing failed searches the FULL roster while the history is folded', searchSnap !== undefined,
    paintedBar(h, h.snapshot()))
  h.check('a non-empty query paints no history action', searchSnap !== undefined && button(h, searchSnap, 'Show') === undefined
    && button(h, searchSnap, 'Hide') === undefined, searchSnap === undefined ? 'search frame absent' : paintedBar(h, searchSnap))
  if (searchSnap !== undefined) h.capture(`work-hub-${CASE}-search-failed`, 'the hidden failed Job found by search')
  for (let index = 0; index < 'failed'.length; index += 1) await h.key('Backspace', 120)
  const cleared = await waitForButton(h, 'Show 2 past jobs')
  h.check('clearing the query restores the folded manual state', cleared !== undefined,
    paintedBar(h, cleared ?? h.snapshot()))

  // The wide pane keeps the same native action bar.
  await h.resize(1280, 800)
  await h.sleep(400)
  snap = h.snapshot()
  h.check('the wide pane keeps all three actions visible and contained', buttons(h, snap).length === 3
    && buttons(h, snap).every((node) => contained(snap, node)), paintedBar(h, snap))
  h.capture(`work-hub-${CASE}-1280x800`, 'the wide-pane layout')

  // Short and narrow panes: record what the client really does.
  await h.resize(400, 240)
  await h.sleep(400)
  h.measure('short 400x240 action bar', paintedBar(h, h.snapshot()))
  h.capture(`work-hub-${CASE}-400x240`, 'the short-pane layout')
  await h.resize(300, 600)
  await h.sleep(400)
  h.measure('300x600 action bar', paintedBar(h, h.snapshot()))
  h.capture(`work-hub-${CASE}-300x600`, 'the narrower split pane')
  await h.resize(60, 600)
  await h.sleep(400)
  const unavailable = h.snapshot()
  h.check('a below-floor 60px pane states the truthful unavailable line',
    h.texts(unavailable).some((text) => text.includes('Work Hub unavailable at this pane width')),
    h.texts(unavailable).join(' | '))
  h.capture(`work-hub-${CASE}-60x600-unavailable`, 'the below-floor pane')

  // Return to the normal split and close through the native action.
  await h.resize(400, 600)
  await h.sleep(400)
  const closeSnap = h.snapshot()
  const close = button(h, closeSnap, 'Close')
  if (close !== undefined) {
    await h.click(closeSnap.chains, close)
    h.check('a real click on the native Close retires the Hub once', recordsOf(h, 'retired').length === 1,
      JSON.stringify(recordsOf(h, 'retired')))
  }
  zeroBusinessCalls(h, 'the full disclosure journey')
}
