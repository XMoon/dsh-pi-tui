/** Real Tern headless flow through the production Direct runner and Session transition. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect } from './tern-pane-geometry.mjs'

const SOURCE_ID = 'session-source-a-b1b'
const TARGET_ID = 'session-target-b-b1b'
const eventPath = (h) => join(h.root, 'events.jsonl')
const records = (h) => {
  const path = eventPath(h)
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
}
const classTokens = (node) => String(node.class ?? '').split(/\s+/u).filter(Boolean)
const hasClass = (node, token) => classTokens(node).includes(token)
const pickerNode = (h, snapshot = h.snapshot()) => h.classNodes(snapshot, 'sf-picker')[0]
const mainRows = (h, snapshot = h.snapshot()) => h.classNodes(snapshot, 'pk-row').filter((node) => !hasClass(node, 'grp'))
const rowFor = (h, snapshot, sessionId) => mainRows(h, snapshot)
  .find((node) => JSON.stringify(node).includes(sessionId))
const buttonFor = (h, snapshot, label) => h.classNodes(snapshot, 'pk-btn')
  .find((node) => h.descendantsText(node).replace(' [Enter]', '') === label)
const buttonEnabled = (node) => node !== undefined
  && classTokens(node).includes('primary')
  && !classTokens(node).includes('off')
const buttonDisabled = (node) => node !== undefined
  && classTokens(node).includes('primary')
  && classTokens(node).includes('off')
const readerCalls = (h) => records(h).filter((entry) => entry.kind === 'reader.list')
const waitUntil = async (h, label, predicate, { limit = 120, intervalMs = 250 } = {}) => {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}
const keyText = async (h, text) => {
  for (const character of text) await h.key(character, 120)
}
const submitCommand = async (h, command) => {
  await keyText(h, command)
  await h.key('Return', 800)
}
const finish = (h) => {
  const status = h.finish()
  if (status !== 0) process.exitCode = status
}
const requiredWait = async (h, label, predicate) => {
  const ok = await waitUntil(h, label, predicate)
  h.check(label, ok, ok ? '' : JSON.stringify(h.texts(h.snapshot())))
  return ok
}

export default async function (h) {
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-session-browser-direct-subject.mts')
  h.check('the production Direct/TSP subject launches in the real Tern pane', await h.launch(subject))

  if (!await requiredWait(h, 'fixture ready with a live production TSP surface', () =>
    records(h).some((entry) => entry.kind === 'fixture.ready' && entry.run === 'initial')
    && h.classNodes(h.snapshot(), 'sf-region').length > 0)) {
    finish(h)
    return
  }
  h.check('the real Tern client shows the production TSP surface (PiTui fallback is not accepted)',
    h.classNodes(h.snapshot(), 'sf-region').length > 0,
    JSON.stringify(h.classNodes(h.snapshot(), 'sf-region').map((node) => ({ class: node.class, rect: rect(node) }))))

  const firstReadStart = readerCalls(h).length
  await submitCommand(h, '/sessions')
  if (!await requiredWait(h, 'registered /sessions opens the native Browser', () => pickerNode(h) !== undefined)) {
    finish(h)
    return
  }
  if (!await requiredWait(h, 'the Direct Reader lists source A and target B', () =>
    readerCalls(h).length > firstReadStart
    && [SOURCE_ID, TARGET_ID].every((id) => readerCalls(h).at(-1)?.sessionIds.includes(id)))) {
    finish(h)
    return
  }

  const firstRead = readerCalls(h)[firstReadStart]
  const initialPicker = pickerNode(h)
  const initialRows = mainRows(h)
  const sourceRow = rowFor(h, h.snapshot(), SOURCE_ID)
  h.check('the first real Browser read has source A current and B persisted/non-current',
    readerCalls(h).length === firstReadStart + 1
    && firstRead?.currentSessionId === SOURCE_ID
    && firstRead?.liveIds.includes(SOURCE_ID)
    && !firstRead?.liveIds.includes(TARGET_ID)
    && sourceRow !== undefined
    && hasClass(sourceRow, 'cur'),
    JSON.stringify({ firstRead, sourceRow: sourceRow === undefined ? undefined : { class: sourceRow.class, text: h.descendantsText(sourceRow) } }))
  h.check('the real Tern Picker contains the target row before any business action',
    initialPicker !== undefined && initialRows.some((node) => JSON.stringify(node).includes(TARGET_ID)),
    JSON.stringify(initialRows.map((node) => ({ id: node.id, text: h.descendantsText(node) }))))
  h.capture('session-browser-direct-tree-1280x800', 'real Direct Reader rows and Current A')

  const viewports = [
    { name: '900x640', width: 900, height: 640 },
    { name: '560x640', width: 560, height: 640 },
    { name: '400x600', width: 400, height: 600 },
  ]
  for (const size of viewports) {
    await h.resize(size.width, size.height)
    const snapshot = h.snapshot()
    const picker = pickerNode(h, snapshot)
    const rows = mainRows(h, snapshot)
    const target = rowFor(h, snapshot, TARGET_ID)
    h.check(`${size.name}: one native Picker and both Direct rows remain reachable`,
      picker !== undefined && h.classNodes(snapshot, 'sf-picker').length === 1 && rows.length >= 2 && target !== undefined,
      JSON.stringify({ pickerPresent: picker !== undefined, pickers: h.classNodes(snapshot, 'sf-picker').length, rows: rows.length, target: target === undefined ? undefined : h.descendantsText(target) }))
    h.capture(`session-browser-direct-tree-${size.name}`, `real Direct Browser at ${size.name}`)
  }

  const currentSnapshot = h.snapshot()
  const currentResume = buttonFor(h, currentSnapshot, 'Resume')
  h.check('400x600: Current A keeps the primary Resume disabled in the real client',
    buttonDisabled(currentResume), JSON.stringify({ class: currentResume?.class, rect: currentResume === undefined ? undefined : rect(currentResume) }))
  h.measure('400x600 current Resume button geometry', JSON.stringify({
    class: currentResume?.class,
    rect: currentResume === undefined ? undefined : rect(currentResume),
  }))
  h.capture('session-browser-direct-current-disabled-400x600', 'Current A is not a Resume target')

  const beforeTargetSnapshot = h.snapshot()
  const targetRow = rowFor(h, beforeTargetSnapshot, TARGET_ID)
  const targetRowClicked = targetRow !== undefined && await h.click(beforeTargetSnapshot.chains, targetRow)
  if (!await requiredWait(h, 'pointer selection enables Resume for persisted B only', () => {
    const snapshot = h.snapshot()
    const selectedTarget = rowFor(h, snapshot, TARGET_ID)
    return pickerNode(h, snapshot) !== undefined
      && selectedTarget !== undefined && hasClass(selectedTarget, 'sel')
      && buttonEnabled(buttonFor(h, snapshot, 'Resume'))
  })) {
    h.check('pointer selected the target row without starting a switch', false, String(targetRowClicked))
    finish(h)
    return
  }
  const enabledSnapshot = h.snapshot()
  const enabledResume = buttonFor(h, enabledSnapshot, 'Resume')
  const selectedTarget = rowFor(h, enabledSnapshot, TARGET_ID)
  const selectedSource = rowFor(h, enabledSnapshot, SOURCE_ID)
  const enabledRect = enabledResume === undefined ? undefined : rect(enabledResume)
  h.check('target B is selectable without dispatching Resume; A stays Current and the enabled primary is visible',
    targetRowClicked
    && selectedTarget !== undefined && hasClass(selectedTarget, 'sel') && !hasClass(selectedTarget, 'cur')
    && selectedSource !== undefined && hasClass(selectedSource, 'cur')
    && enabledResume !== undefined
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 0
    && readerCalls(h).length === firstReadStart + 1
    && enabledRect !== undefined
    && enabledRect[0] >= 0 && enabledRect[1] >= 0
    && enabledRect[0] + enabledRect[2] <= 400
    && enabledRect[1] + enabledRect[3] <= 600,
    JSON.stringify({ targetRowClicked, class: enabledResume?.class, rect: enabledRect }))
  h.measure('400x600 enabled Resume button geometry', JSON.stringify({ class: enabledResume?.class, rect: enabledRect }))
  h.capture('session-browser-direct-resume-enabled-400x600', 'listed non-current B exposes the visible primary Resume')

  const transitionStart = records(h).length
  const resumeClicked = enabledResume !== undefined && await h.click(enabledSnapshot.chains, enabledResume)
  h.check('the real Tern Footer Resume was clicked once', resumeClicked, JSON.stringify({ class: enabledResume?.class, rect: enabledRect }))
  if (!await requiredWait(h, 'the Direct transition settles its agents.resume(B) sink witness', () =>
    records(h).some((entry) => entry.kind === 'agents.resume.settled' && entry.sessionId === TARGET_ID))) {
    finish(h)
    return
  }
  const transitionTrace = records(h).slice(transitionStart)
  const oldFlushIndex = transitionTrace.findIndex((entry) => entry.kind === 'sessions.flush.settled'
    && entry.sessionId === SOURCE_ID && entry.flushed === true)
  const targetOpenIndex = transitionTrace.findIndex((entry) => entry.kind === 'agents.resume.start'
    && entry.sessionId === TARGET_ID)
  h.check('the existing Direct transition flushes A before official lifecycle open(B)',
    resumeClicked && oldFlushIndex >= 0 && targetOpenIndex > oldFlushIndex
    && transitionTrace.filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 1,
    JSON.stringify(transitionTrace))
  if (!await requiredWait(h, 'the old Browser retires after B becomes the session owner', () => pickerNode(h) === undefined)) {
    finish(h)
    return
  }
  h.capture('session-browser-direct-after-resume-400x600', 'the previous Browser retires after the real Direct transition')

  const postSwitchReadStart = readerCalls(h).length
  await submitCommand(h, '/sessions')
  if (!await requiredWait(h, 'the reopened Browser is owned by B', () =>
    pickerNode(h) !== undefined
    && readerCalls(h).length > postSwitchReadStart
    && readerCalls(h).at(-1)?.currentSessionId === TARGET_ID
    && readerCalls(h).at(-1)?.liveIds.includes(TARGET_ID))) {
    finish(h)
    return
  }
  const postSwitchRead = readerCalls(h)[postSwitchReadStart]
  const postSwitchPicker = pickerNode(h)
  const targetCurrentRow = rowFor(h, h.snapshot(), TARGET_ID)
  const currentResumeAfterSwitch = buttonFor(h, h.snapshot(), 'Resume')
  h.check('authoritative DirectReader reread and real Tern Current both identify B',
    readerCalls(h).length === postSwitchReadStart + 1
    && postSwitchRead?.currentSessionId === TARGET_ID
    && postSwitchRead?.liveIds.includes(TARGET_ID)
    && !postSwitchRead?.liveIds.includes(SOURCE_ID)
    && targetCurrentRow !== undefined
    && hasClass(targetCurrentRow, 'cur'),
    JSON.stringify({ postSwitchRead, targetCurrentRow: targetCurrentRow === undefined ? undefined : { class: targetCurrentRow.class, text: h.descendantsText(targetCurrentRow) } }))
  h.check('Current B keeps Resume primary and disabled after the committed switch',
    postSwitchPicker !== undefined && buttonDisabled(currentResumeAfterSwitch),
    JSON.stringify({ pickerPresent: postSwitchPicker !== undefined, class: currentResumeAfterSwitch?.class }))
  h.capture('session-browser-direct-current-b-400x600', 'authoritative B reread renders B as Current')

  await h.resize(400, 440)
  const detailsBefore = h.snapshot()
  const detailsButton = buttonFor(h, detailsBefore, 'Details')
  const detailsClicked = detailsButton !== undefined && await h.click(detailsBefore.chains, detailsButton)
  if (!await requiredWait(h, 'real Direct Reader Details opens at 400x440', () => h.classNodes(h.snapshot(), 'sf-overlay').length > 0)) {
    h.check('Details was reachable from the real Browser', false, String(detailsClicked))
    finish(h)
    return
  }
  h.check('the production Browser Details action opened the Reader', detailsClicked)
  h.capture('session-browser-direct-reader-400x440', 'real Direct Reader in the narrow Tern viewport')
  const readerSnapshot = h.snapshot()
  const backRow = h.classNodes(readerSnapshot, 'sf-row').find((node) =>
    hasClass(node, 'sf-act') && h.descendantsText(node).trim().startsWith('← Back to sessions · Esc'))
  const backClicked = backRow !== undefined && await h.click(readerSnapshot.chains, backRow)
  if (!await requiredWait(h, 'Reader Back returns to the same Browser owner', () =>
    h.classNodes(h.snapshot(), 'sf-overlay').length === 0 && pickerNode(h) !== undefined)) {
    h.check('the real Reader Back row was clickable', false, JSON.stringify({ backClicked, back: backRow === undefined ? undefined : h.descendantsText(backRow) }))
    finish(h)
    return
  }
  h.check('the real Tern Reader Back row is available and restores Browser', backClicked,
    backRow === undefined ? 'Back row missing' : h.descendantsText(backRow))
  h.capture('session-browser-direct-reader-back-400x440', 'Reader Back restores the B-current Browser')

  const beforeClose = h.snapshot()
  const closeButton = buttonFor(h, beforeClose, 'Close')
  const closeClicked = closeButton !== undefined && await h.click(beforeClose.chains, closeButton)
  h.check('the reopened B-current Browser closes before exit', closeClicked)
  if (!await requiredWait(h, 'Browser closes before exit', () => pickerNode(h) === undefined)) {
    finish(h)
    return
  }
  await submitCommand(h, '/exit')
  const settled = await requiredWait(h, 'the initial Direct fixture settles before Tern closes', () =>
    records(h).some((entry) => entry.kind === 'fixture.settled' && entry.run === 'initial'))
  h.check('the initial subject completed production teardown before renderer reconnect', settled)
  if (!await requiredWait(h, 'the initial subject process exits after fixture settlement', () =>
    records(h).some((entry) => entry.kind === 'process.exit' && entry.run === 'initial' && entry.code === 0))) {
    finish(h)
    return
  }

  writeFileSync(join(h.root, 'reconnect.json'), JSON.stringify({ sessionId: TARGET_ID }))
  await h.resize(400, 600)
  h.check('a new production subject reconnects to the same real Tern pane', await h.launch(subject))
  if (!await requiredWait(h, 'the fresh Direct fixture reconnects with B as startup owner', () =>
    records(h).some((entry) => entry.kind === 'fixture.ready' && entry.run === 'reconnect'
      && entry.startupSessionId === TARGET_ID)
    && h.classNodes(h.snapshot(), 'sf-region').length > 0)) {
    finish(h)
    return
  }
  h.capture('session-browser-direct-renderer-reconnected-400x600', 'fresh production Direct renderer reconnects to the same Tern pane')

  const reconnectReadStart = readerCalls(h).length
  await submitCommand(h, '/sessions')
  if (!await requiredWait(h, 'the reconnected Browser rereads persisted B as Current', () => {
    const latest = readerCalls(h).at(-1)
    return pickerNode(h) !== undefined
      && readerCalls(h).length > reconnectReadStart
      && latest?.run === 'reconnect'
      && latest.currentSessionId === TARGET_ID
      && latest.liveIds.includes(TARGET_ID)
  })) {
    finish(h)
    return
  }
  const reconnectRead = readerCalls(h)[reconnectReadStart]
  const reconnectSnapshot = h.snapshot()
  const reconnectTarget = rowFor(h, reconnectSnapshot, TARGET_ID)
  const reconnectResume = buttonFor(h, reconnectSnapshot, 'Resume')
  h.check('renderer reconnect rereads persisted B as Current with Resume disabled',
    readerCalls(h).length === reconnectReadStart + 1
    && reconnectRead?.run === 'reconnect'
    && reconnectRead.currentSessionId === TARGET_ID
    && reconnectRead.liveIds.includes(TARGET_ID)
    && reconnectTarget !== undefined && hasClass(reconnectTarget, 'cur')
    && buttonDisabled(reconnectResume),
    JSON.stringify({ reconnectRead, currentRow: reconnectTarget === undefined ? undefined : { class: reconnectTarget.class, text: h.descendantsText(reconnectTarget) }, resume: reconnectResume?.class }))
  h.capture('session-browser-direct-renderer-reconnected-current-b-400x600', 'reconnected renderer rereads B as Current')

  const reconnectCloseSnapshot = h.snapshot()
  const reconnectClose = buttonFor(h, reconnectCloseSnapshot, 'Close')
  h.check('the reconnected Browser closes before the second graceful exit',
    reconnectClose !== undefined && await h.click(reconnectCloseSnapshot.chains, reconnectClose))
  if (!await requiredWait(h, 'the reconnected Browser closes', () => pickerNode(h) === undefined)) {
    finish(h)
    return
  }
  await submitCommand(h, '/exit')
  const reconnectSettled = await requiredWait(h, 'the reconnected fixture settles before Tern shutdown', () =>
    records(h).some((entry) => entry.kind === 'fixture.settled' && entry.run === 'reconnect'))
  h.check('the reconnected production fixture completes graceful teardown', reconnectSettled)
  if (!await requiredWait(h, 'the reconnected subject process exits after fixture settlement', () =>
    records(h).some((entry) => entry.kind === 'process.exit' && entry.run === 'reconnect' && entry.code === 0))) {
    finish(h)
    return
  }
  h.measure('production source→decision→sink and reconnect trace', JSON.stringify(records(h).filter((entry) =>
    ['reader.list', 'sessions.flush.settled', 'agents.resume.start', 'agents.resume.settled', 'app.exit', 'fixture.settled', 'process.exit'].includes(entry.kind))))
  finish(h)
}
