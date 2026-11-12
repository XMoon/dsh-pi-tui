/** Real Tern headless flow through the production Direct runner and Session transition. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, rect } from './tern-pane-geometry.mjs'

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
const findClass = (node, token) => {
  if (node === undefined) return undefined
  if (hasClass(node, token)) return node
  for (const child of node.children ?? []) {
    const found = findClass(child, token)
    if (found !== undefined) return found
  }
  return undefined
}
const pickerNode = (h, snapshot = h.snapshot()) => h.classNodes(snapshot, 'sf-picker')[0]
const allRows = (h, snapshot = h.snapshot()) => h.classNodes(snapshot, 'pk-row')
// A child row carries the client's indent `pk-chev leaf`; a Folder row carries
// the real disclosure chevron (no `leaf`). This is the row KIND, not a flat index.
const disclosureOf = (node) => {
  const chevron = findClass(node, 'pk-chev')
  return chevron !== undefined && !hasClass(chevron, 'leaf') ? chevron : undefined
}
const folderRows = (h, snapshot = h.snapshot()) => allRows(h, snapshot)
  .filter((node) => String(node.id ?? '').startsWith('pk-workspace:'))
const sessionRows = (h, snapshot = h.snapshot()) => allRows(h, snapshot)
  .filter((node) => String(node.id ?? '').startsWith('pk-session:'))
const folderRowById = (h, snapshot, workspaceId) => folderRows(h, snapshot)
  .find((node) => node.id === `pk-workspace:${workspaceId}`)
const sessionRowById = (h, snapshot, sessionId) => sessionRows(h, snapshot)
  .find((node) => node.id === `pk-session:${sessionId}`)
const buttonFor = (h, snapshot, label) => h.classNodes(snapshot, 'pk-btn')
  .find((node) => h.descendantsText(node).replace(' [Enter]', '') === label)
const buttonEnabled = (node) => node !== undefined
  && classTokens(node).includes('primary')
  && !classTokens(node).includes('off')
const buttonDisabled = (node) => node !== undefined
  && classTokens(node).includes('primary')
  && classTokens(node).includes('off')
const readerCalls = (h) => records(h).filter((entry) => entry.kind === 'reader.list')
const workspaceRecords = (h) => records(h).filter((entry) => entry.kind === 'workspace.ready')
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
/** Whether the real client keeps this row inside every clipping ancestor. */
const rowVisible = (h, snapshot, id) => {
  const row = sessionRowById(h, snapshot, id)
  return row !== undefined && containedXY(snapshot.chains, row)
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

  const workspace = workspaceRecords(h).find((entry) => entry.run === 'initial')
  h.check('the subject registers one official Workspace through the real Host registry',
    workspace !== undefined && workspace.created === true
    && workspace.path === join(h.root, 'dsh-home')
    && JSON.stringify([...workspace.sessionIds].sort()) === JSON.stringify([SOURCE_ID, TARGET_ID].sort()),
    JSON.stringify(workspace))

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
  const initialSnapshot = h.snapshot()
  const initialPicker = pickerNode(h, initialSnapshot)
  const initialFolder = workspace === undefined ? undefined : folderRowById(h, initialSnapshot, workspace.workspaceId)
  const initialSessionRows = sessionRows(h, initialSnapshot)
  const sourceRow = sessionRowById(h, initialSnapshot, SOURCE_ID)
  const targetRow = sessionRowById(h, initialSnapshot, TARGET_ID)
  h.check('the first real Browser read has source A current and B persisted/non-current',
    readerCalls(h).length === firstReadStart + 1
    && firstRead?.currentSessionId === SOURCE_ID
    && firstRead?.liveIds.includes(SOURCE_ID)
    && !firstRead?.liveIds.includes(TARGET_ID)
    && sourceRow !== undefined
    && hasClass(sourceRow, 'cur'),
    JSON.stringify({ firstRead, sourceRow: sourceRow === undefined ? undefined : { class: sourceRow.class, text: h.descendantsText(sourceRow) } }))
  h.check('the Workspace-first Browser paints the official Workspace as a Folder ITEM with both Sessions as its children',
    initialPicker !== undefined
    && h.classNodes(initialSnapshot, 'sf-picker').length === 1
    && initialFolder !== undefined
    && hasClass(initialFolder, 'pk-row')
    && disclosureOf(initialFolder) !== undefined
    && h.descendantsText(initialFolder).includes('Current · Direct')
    && h.descendantsText(initialFolder).includes('2 sessions')
    && targetRow !== undefined && hasClass(targetRow, 'pk-row')
    && initialSessionRows.length === 2,
    JSON.stringify({
      folder: initialFolder === undefined ? undefined : { id: initialFolder.id, text: h.descendantsText(initialFolder) },
      rows: initialSessionRows.map((node) => ({ id: node.id, text: h.descendantsText(node) })),
      pickers: h.classNodes(initialSnapshot, 'sf-picker').length,
    }))
  h.check('the real Tern Picker contains both child Session rows under the Folder before any business action',
    initialPicker !== undefined && sourceRow !== undefined && targetRow !== undefined
    && h.descendantsText(sourceRow).includes('source-a')
    && h.descendantsText(targetRow).includes('target-b'),
    JSON.stringify(initialSessionRows.map((node) => ({ id: node.id, text: h.descendantsText(node) }))))
  h.capture('session-browser-direct-folder-tree-1280x800',
    'real Direct Workspace folder with Current A and persisted B as child Session rows')

  // ── Folder-aware navigation: collapse and re-expand through the real chevron ─
  // The client selects an unselected Folder on the first click of its head and
  // toggles it on a click while it is selected, so select it through the real
  // keyboard ring first — exactly the folder-aware item list, never a flat index.
  await h.key('Home', 500)
  const folderSelected = await waitUntil(h, 'keyboard selects the official Folder row', () => {
    const row = workspace === undefined ? undefined : folderRowById(h, h.snapshot(), workspace.workspaceId)
    return row !== undefined && hasClass(row, 'sel')
  })
  const collapseSnapshot = h.snapshot()
  const collapseFolder = workspace === undefined ? undefined : folderRowById(h, collapseSnapshot, workspace.workspaceId)
  const collapseChevron = collapseFolder === undefined ? undefined : disclosureOf(collapseFolder)
  const collapseClicked = collapseChevron !== undefined && await h.click(collapseSnapshot.chains, collapseChevron)
  const collapsed = await waitUntil(h, 'real pointer collapses the Folder', () => sessionRows(h).length === 0)
  const collapsedSnapshot = h.snapshot()
  const collapsedFolder = workspace === undefined ? undefined : folderRowById(h, collapsedSnapshot, workspace.workspaceId)
  h.check('a real pointer click on the selected Folder disclosure collapses it and hides every child Session row',
    folderSelected && collapseClicked && collapsed
    && collapsedFolder !== undefined
    && sessionRowById(h, collapsedSnapshot, SOURCE_ID) === undefined
    && sessionRowById(h, collapsedSnapshot, TARGET_ID) === undefined
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 0,
    JSON.stringify({ selected: folderSelected, clicked: collapseClicked,
      folder: collapsedFolder === undefined ? 'missing' : h.descendantsText(collapsedFolder),
      rows: allRows(h, collapsedSnapshot).map((node) => node.id) }))
  h.capture('session-browser-direct-folder-collapsed-1280x800',
    'manual collapse: the official Folder item remains, every child Session row is hidden')

  const expandSnapshot = h.snapshot()
  const expandFolder = workspace === undefined ? undefined : folderRowById(h, expandSnapshot, workspace.workspaceId)
  const expandChevron = expandFolder === undefined ? undefined : disclosureOf(expandFolder)
  const expandClicked = expandChevron !== undefined && await h.click(expandSnapshot.chains, expandChevron)
  const reexpanded = await waitUntil(h, 'real pointer re-expands the Folder', () => sessionRows(h).length === 2)
  // The disclosure keeps the Folder selected; step down the item list twice to
  // land on the current child Session A (target-b sorts first, then source-a).
  await h.key('Down', 300)
  await h.key('Down', 300)
  const currentAgainSelected = await waitUntil(h, 'keyboard returns to the current child A', () => {
    const row = sessionRowById(h, h.snapshot(), SOURCE_ID)
    return row !== undefined && hasClass(row, 'sel')
  })
  const reexpandedSnapshot = h.snapshot()
  const currentAgain = sessionRowById(h, reexpandedSnapshot, SOURCE_ID)
  h.check('a second real pointer click re-expands the Folder and restores A current with B listed',
    expandClicked && reexpanded && currentAgainSelected
    && currentAgain !== undefined && hasClass(currentAgain, 'cur')
    && sessionRowById(h, reexpandedSnapshot, TARGET_ID) !== undefined
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 0,
    JSON.stringify({ clicked: expandClicked, selected: currentAgainSelected,
      rows: sessionRows(h, reexpandedSnapshot).map((node) => ({ id: node.id, class: node.class })) }))
  h.capture('session-browser-direct-folder-expanded-1280x800',
    'the same Folder re-expanded after manual collapse; A is Current again')

  const viewports = [
    { name: '900x640', width: 900, height: 640 },
    { name: '560x640', width: 560, height: 640 },
  ]
  for (const size of viewports) {
    await h.resize(size.width, size.height)
    const ready = await waitUntil(h, `${size.name} folder rows`, () => {
      const snapshot = h.snapshot()
      return pickerNode(h, snapshot) !== undefined && sessionRows(h, snapshot).length === 2
    })
    const snapshot = h.snapshot()
    const picker = pickerNode(h, snapshot)
    const rows = sessionRows(h, snapshot)
    h.check(`${size.name}: one native Picker with the official Folder and both Direct child rows`,
      ready && picker !== undefined && h.classNodes(snapshot, 'sf-picker').length === 1
      && rows.length === 2
      && folderRowById(h, snapshot, workspace.workspaceId) !== undefined
      && rowVisible(h, snapshot, SOURCE_ID) && rowVisible(h, snapshot, TARGET_ID),
      JSON.stringify({ pickerPresent: picker !== undefined, pickers: h.classNodes(snapshot, 'sf-picker').length,
        rows: rows.map((node) => ({ id: node.id, text: h.descendantsText(node) })) }))
    h.capture(`session-browser-direct-folder-tree-${size.name}`, `real Direct Folder tree at ${size.name}`)
  }

  const narrowSnapshot = h.snapshot()
  const currentResume = buttonFor(h, narrowSnapshot, 'Resume')
  h.check('560x640: Current A keeps the primary Resume disabled and fully visible in the real client',
    buttonDisabled(currentResume) && containedXY(narrowSnapshot.chains, currentResume),
    JSON.stringify({ class: currentResume?.class, rect: currentResume === undefined ? undefined : rect(currentResume) }))
  h.measure('560x640 current Resume button geometry', JSON.stringify({
    class: currentResume?.class,
    rect: currentResume === undefined ? undefined : rect(currentResume),
  }))
  h.capture('session-browser-direct-current-disabled-560x640', 'Current A is not a Resume target')

  // ── Real pointer, then keyboard, selection of the Direct child Sessions ────
  // A click on an UNSELECTED child selects it; a click on an already-selected
  // child would activate it. The evidence for "click selects only" therefore
  // starts from Current A and clicks the other child B.
  const selectedCurrent = await waitUntil(h, 'Current A is the initially selected child row', () => {
    const row = sessionRowById(h, h.snapshot(), SOURCE_ID)
    return row !== undefined && hasClass(row, 'sel')
  })
  const beforeTargetSnapshot = h.snapshot()
  const targetRowBefore = sessionRowById(h, beforeTargetSnapshot, TARGET_ID)
  const targetRowClicked = targetRowBefore !== undefined && await h.click(beforeTargetSnapshot.chains, targetRowBefore)
  if (!await requiredWait(h, 'pointer selection keeps Resume enabled for persisted B only', () => {
    const snapshot = h.snapshot()
    const selectedTarget = sessionRowById(h, snapshot, TARGET_ID)
    return pickerNode(h, snapshot) !== undefined
      && selectedTarget !== undefined && hasClass(selectedTarget, 'sel')
      && buttonEnabled(buttonFor(h, snapshot, 'Resume'))
  })) {
    h.check('pointer selected the target row without starting a switch', false, String(targetRowClicked))
    finish(h)
    return
  }
  const pointerSnapshot = h.snapshot()
  const selectedTarget = sessionRowById(h, pointerSnapshot, TARGET_ID)
  const selectedSource = sessionRowById(h, pointerSnapshot, SOURCE_ID)
  h.check('a real pointer click on unselected child B selects it without dispatching Resume; A stays Current',
    selectedCurrent && targetRowClicked
    && selectedTarget !== undefined && hasClass(selectedTarget, 'sel') && !hasClass(selectedTarget, 'cur')
    && selectedSource !== undefined && hasClass(selectedSource, 'cur')
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 0
    && readerCalls(h).length === firstReadStart + 1,
    JSON.stringify({ targetRowClicked, source: selectedSource === undefined ? undefined : selectedSource.class,
      target: selectedTarget === undefined ? undefined : selectedTarget.class }))

  // Keyboard DOWN from B selects the current child A in the SAME folder item
  // list; the primary Resume is disabled for it with the action-metadata reason.
  await h.key('Down', 500)
  const keyboardCurrent = await waitUntil(h, 'keyboard Down selects the current child A', () => {
    const row = sessionRowById(h, h.snapshot(), SOURCE_ID)
    return row !== undefined && hasClass(row, 'sel') && hasClass(row, 'cur')
  })
  const keyboardCurrentSnapshot = h.snapshot()
  h.check('keyboard navigation selects the current child A and keeps Resume disabled',
    keyboardCurrent
    && buttonDisabled(buttonFor(h, keyboardCurrentSnapshot, 'Resume'))
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 0,
    JSON.stringify({ rows: sessionRows(h, keyboardCurrentSnapshot).map((node) => ({ id: node.id, class: node.class })),
      resume: buttonFor(h, keyboardCurrentSnapshot, 'Resume')?.class }))

  // Keyboard UP returns to B; the enabled primary Resume is fully visible.
  await h.key('Up', 500)
  const keyboardSelected = await waitUntil(h, 'keyboard Up selects persisted B', () => {
    const row = sessionRowById(h, h.snapshot(), TARGET_ID)
    return row !== undefined && hasClass(row, 'sel') && !hasClass(row, 'cur')
  })
  const enabledSnapshot = h.snapshot()
  const enabledResume = buttonFor(h, enabledSnapshot, 'Resume')
  h.check('keyboard selection of child B enables the primary Resume without dispatching it',
    keyboardSelected && buttonEnabled(enabledResume)
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === 0,
    JSON.stringify({ rows: sessionRows(h, enabledSnapshot).map((node) => ({ id: node.id, class: node.class })),
      resume: enabledResume?.class }))
  h.check('560x640: the enabled primary Resume footer is fully visible inside the Picker',
    buttonEnabled(enabledResume) && containedXY(enabledSnapshot.chains, enabledResume),
    JSON.stringify({ class: enabledResume?.class, rect: enabledResume === undefined ? undefined : rect(enabledResume) }))
  h.measure('560x640 enabled Resume button geometry', JSON.stringify({
    class: enabledResume?.class,
    rect: enabledResume === undefined ? undefined : rect(enabledResume),
  }))
  h.capture('session-browser-direct-resume-enabled-560x640', 'listed non-current B exposes the visible primary Resume')

  const transitionStart = records(h).length
  const resumeClicked = enabledResume !== undefined && await h.click(enabledSnapshot.chains, enabledResume)
  h.check('the real Tern Footer Resume was clicked once', resumeClicked, JSON.stringify({ class: enabledResume?.class, rect: enabledResume === undefined ? undefined : rect(enabledResume) }))
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
  h.capture('session-browser-direct-after-resume-560x640', 'the previous Browser retires after the real Direct transition')

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
  const postSwitchSnapshot = h.snapshot()
  const targetCurrentRow = sessionRowById(h, postSwitchSnapshot, TARGET_ID)
  const currentResumeAfterSwitch = buttonFor(h, postSwitchSnapshot, 'Resume')
  h.check('authoritative DirectReader reread and real Tern Current both identify child B in the official Folder',
    readerCalls(h).length === postSwitchReadStart + 1
    && postSwitchRead?.currentSessionId === TARGET_ID
    && postSwitchRead?.liveIds.includes(TARGET_ID)
    && !postSwitchRead?.liveIds.includes(SOURCE_ID)
    && targetCurrentRow !== undefined
    && hasClass(targetCurrentRow, 'cur')
    && folderRowById(h, postSwitchSnapshot, workspace.workspaceId) !== undefined
    && h.descendantsText(folderRowById(h, postSwitchSnapshot, workspace.workspaceId)).includes('Current · Direct'),
    JSON.stringify({ postSwitchRead, targetCurrentRow: targetCurrentRow === undefined ? undefined : { class: targetCurrentRow.class, text: h.descendantsText(targetCurrentRow) } }))
  h.check('Current B keeps Resume primary and disabled after the committed switch',
    postSwitchPicker !== undefined && buttonDisabled(currentResumeAfterSwitch),
    JSON.stringify({ pickerPresent: postSwitchPicker !== undefined, class: currentResumeAfterSwitch?.class }))
  h.capture('session-browser-direct-current-b-560x640', 'authoritative B reread renders B as Current child')

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
  await h.resize(560, 640)
  h.check('a new production subject reconnects to the same real Tern pane', await h.launch(subject))
  if (!await requiredWait(h, 'the fresh Direct fixture reconnects with B as startup owner', () =>
    records(h).some((entry) => entry.kind === 'fixture.ready' && entry.run === 'reconnect'
      && entry.startupSessionId === TARGET_ID)
    && records(h).some((entry) => entry.kind === 'workspace.ready' && entry.run === 'reconnect' && entry.created === false)
    && h.classNodes(h.snapshot(), 'sf-region').length > 0)) {
    finish(h)
    return
  }
  h.capture('session-browser-direct-renderer-reconnected-560x640', 'fresh production Direct renderer reconnects to the same Tern pane')

  const reconnectWorkspace = workspaceRecords(h).find((entry) => entry.run === 'reconnect')
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
  const reconnectTarget = sessionRowById(h, reconnectSnapshot, TARGET_ID)
  const reconnectResume = buttonFor(h, reconnectSnapshot, 'Resume')
  const reconnectFolder = reconnectWorkspace === undefined ? undefined : folderRowById(h, reconnectSnapshot, reconnectWorkspace.workspaceId)
  h.check('renderer reconnect rereads persisted B as the Current child of the same official Folder, Resume disabled',
    readerCalls(h).length === reconnectReadStart + 1
    && reconnectRead?.run === 'reconnect'
    && reconnectRead.currentSessionId === TARGET_ID
    && reconnectRead.liveIds.includes(TARGET_ID)
    && reconnectWorkspace !== undefined
    && JSON.stringify([...reconnectWorkspace.sessionIds].sort()) === JSON.stringify([...workspace.sessionIds].sort())
    && reconnectFolder !== undefined
    && h.descendantsText(reconnectFolder).includes('Current · Direct')
    && reconnectTarget !== undefined && hasClass(reconnectTarget, 'cur')
    && buttonDisabled(reconnectResume),
    JSON.stringify({ reconnectRead,
      folder: reconnectFolder === undefined ? undefined : h.descendantsText(reconnectFolder),
      currentRow: reconnectTarget === undefined ? undefined : { class: reconnectTarget.class, text: h.descendantsText(reconnectTarget) },
      resume: reconnectResume?.class }))
  h.capture('session-browser-direct-renderer-reconnected-current-b-560x640', 'reconnected renderer rereads B as the Current child')

  // ── Current B Return through the real native key and pointer paths ────────
  const returnSnapshot = h.snapshot()
  const returnTarget = sessionRowById(h, returnSnapshot, TARGET_ID)
  const returnSelected = returnTarget !== undefined
    && hasClass(returnTarget, 'sel') && hasClass(returnTarget, 'cur')
  const resumeStartsBeforeReturn = records(h).filter((entry) =>
    entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length
  await h.key('Return', 900)
  const keyboardReturned = await requiredWait(h, 'Current keyboard Enter returns from the real Browser',
    () => pickerNode(h) === undefined)
  h.check('real native keyboard Enter on the listed Current Session returns without a second Direct Resume',
    returnSelected && keyboardReturned
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === resumeStartsBeforeReturn,
    JSON.stringify({ returnSelected, keyboardReturned,
      resumeStarts: records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length,
      expected: resumeStartsBeforeReturn }))
  if (!keyboardReturned) {
    finish(h)
    return
  }

  await submitCommand(h, '/sessions')
  if (!await requiredWait(h, 'the Browser reopens for the native pointer witnesses', () => {
    const snapshot = h.snapshot()
    const target = sessionRowById(h, snapshot, TARGET_ID)
    return pickerNode(h, snapshot) !== undefined
      && target !== undefined && hasClass(target, 'sel') && hasClass(target, 'cur')
  })) {
    finish(h)
    return
  }
  await h.key('Down', 500)
  const movedAway = await requiredWait(h, 'keyboard moves the selection off the Current row', () => {
    const target = sessionRowById(h, h.snapshot(), TARGET_ID)
    return target !== undefined && !hasClass(target, 'sel')
  })
  const selectSnapshot = h.snapshot()
  const selectTarget = sessionRowById(h, selectSnapshot, TARGET_ID)
  const selectedByPointer = selectTarget !== undefined && await h.click(selectSnapshot.chains, selectTarget)
  const stillOpen = await requiredWait(h, 'native select on the Current row leaves the Browser open', () => {
    const snapshot = h.snapshot()
    const target = sessionRowById(h, snapshot, TARGET_ID)
    return pickerNode(h, snapshot) !== undefined && target !== undefined && hasClass(target, 'sel')
  })
  h.check('real native select on the Current Session row only selects and never closes',
    movedAway && selectedByPointer && stillOpen
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === resumeStartsBeforeReturn,
    JSON.stringify({ movedAway, selectedByPointer, stillOpen,
      resumeStarts: records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length }))
  if (!stillOpen) {
    finish(h)
    return
  }
  const activateSnapshot = h.snapshot()
  const activateTarget = sessionRowById(h, activateSnapshot, TARGET_ID)
  const activated = activateTarget !== undefined && await h.click(activateSnapshot.chains, activateTarget)
  const activateReturned = await requiredWait(h, 'native activate on the Current row closes the real Browser',
    () => pickerNode(h) === undefined)
  h.check('real native activate on the listed Current Session returns without a Resume',
    activated && activateReturned
    && records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length === resumeStartsBeforeReturn,
    JSON.stringify({ activated, activateReturned,
      resumeStarts: records(h).filter((entry) => entry.kind === 'agents.resume.start' && entry.sessionId === TARGET_ID).length }))
  if (!activateReturned) {
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
    ['reader.list', 'workspace.ready', 'sessions.flush.settled', 'agents.resume.start', 'agents.resume.settled', 'app.exit', 'fixture.settled', 'process.exit'].includes(entry.kind))))
  finish(h)
}
