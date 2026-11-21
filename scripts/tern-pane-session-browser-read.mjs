/**
 * Real Tern headless qualification for the production Workspace-first Session
 * Browser: official Folder items, incremental expansion, manual collapse,
 * session selection, the Details Reader and the Host directory path chooser.
 *
 * Every premise is read from the CURRENT production contract: the picker frame
 * carries no `scope`, Workspace facts arrive through the read owner's
 * `sessionWorkspaceFacts`, and Folders are Picker ITEMS (`workspace:<id>`), not
 * PickerGroups. Nothing here asserts the retired flat 54/56-row tree.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedX, containedXY, rect } from './tern-pane-geometry.mjs'

const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((entry) => entry.frame).map((entry) => entry.frame)
const lastFrame = (h) => frames(h).at(-1)
const caps = (h) => records(h).find((entry) => entry.caps)?.caps
const notices = (h) => records(h).filter((entry) => entry.notice).map((entry) => entry.notice)
const addDirectoryRecords = (h) => records(h).filter((entry) => entry.addDirectory).map((entry) => entry.addDirectory)
const addSettlements = (h) => records(h).filter((entry) => entry.addDirectorySettlement).map((entry) => entry.addDirectorySettlement)
const classTokens = (node) => String(node.class ?? '').split(/\s+/u).filter(Boolean)
const hasClass = (node, token) => classTokens(node).includes(token)
const nodesWith = (snap, token) => snap.nodes.filter((node) => hasClass(node, token))
const findClass = (node, token) => {
  if (node === undefined) return undefined
  if (hasClass(node, token)) return node
  for (const child of node.children ?? []) {
    const found = findClass(child, token)
    if (found !== undefined) return found
  }
  return undefined
}
const pickerNode = (snap) => nodesWith(snap, 'sf-picker')[0]
const allRows = (snap) => nodesWith(snap, 'pk-row')
// The client draws an indent `pk-chev leaf` on every child row; only a Folder
// row carries the real disclosure chevron (without `leaf`). Row KIND is therefore
// read from that chevron, never from a flat index.
const disclosureOf = (node) => {
  const chevron = findClass(node, 'pk-chev')
  return chevron !== undefined && !hasClass(chevron, 'leaf') ? chevron : undefined
}
const folderRows = (snap) => allRows(snap).filter((node) => String(node.id ?? '').startsWith('pk-workspace:'))
const sessionRows = (snap) => allRows(snap).filter((node) => String(node.id ?? '').startsWith('pk-session:'))
const overlayNode = (snap) => nodesWith(snap, 'sf-overlay')[0]
const overlayBody = (snap) => nodesWith(snap, 'sf-ov-body')[0]
const frameItems = (frame) => Array.isArray(frame?.items) ? frame.items : []
const itemById = (frame, id) => frameItems(frame).find((item) => item.id === id)
const itemIds = (frame) => frameItems(frame).map((item) => item.id)
const sessionIds = (frame) => itemIds(frame).filter((id) => id.startsWith('session:'))
const waitFrame = async (h, predicate, label, limit = 80) => {
  for (let step = 0; step < limit; step += 1) {
    if (predicate(lastFrame(h))) return true
    await h.sleep(100)
  }
  const frame = lastFrame(h)
  h.log(`WAIT-FAIL ${label} frame=${JSON.stringify(frame)?.slice(0, 600)}`)
  return false
}
const keyText = async (h, text) => {
  for (const character of text) await h.key(character, 120)
}
const press = async (h, name, count = 1, settleMs = 220) => {
  for (let step = 0; step < count; step += 1) await h.key(name, settleMs)
}
const buttonFor = (h, snap, label) => nodesWith(snap, 'pk-btn')
  .find((node) => h.descendantsText(node).replace(' [Enter]', '') === label)
const folderRow = (h, snap, label) => folderRows(snap)
  .find((node) => h.descendantsText(node).includes(label))
const disclosure = (row) => row === undefined ? undefined : findClass(row, 'pk-chev')
const sessionRow = (h, snap, title) => sessionRows(snap)
  .find((node) => h.descendantsText(node).includes(title))
const detailBodyId = (frame) => String(frame?.readerBodyKey ?? '')
const tailPosition = (h) => {
  const snap = h.snapshot()
  // Tern's tree view truncates long text values, while retaining the full laid-out rect.
  // This Host excerpt is the final Reader text node, so its bottom is the tail position.
  const excerpt = snap.nodes.find((node) => String(node.text ?? '').startsWith('The Host-selected excerpt starts away from the matched text.'))
  const body = overlayBody(snap)
  if (excerpt === undefined || body === undefined) return undefined
  const excerptBox = rect(excerpt)
  const bodyBox = rect(body)
  return {
    tailBottom: excerptBox[1] + excerptBox[3],
    bodyTop: bodyBox[1],
    bodyBottom: bodyBox[1] + bodyBox[3],
    excerptHeight: excerptBox[3],
    bodyHeight: bodyBox[3],
  }
}

export default async function (h) {
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-session-browser-read-subject.mts')
  const booted = await h.launch(subject, { ready: 'Sessions' })
  h.check('the production Workspace-first Session Browser boots in the real Tern pane', booted, h.texts(h.snapshot()).join(' | ').slice(0, 300))
  if (!booted) return

  h.measure('real client and negotiated Browser capabilities',
    `${caps(h)?.term ?? '?'} ${caps(h)?.ver ?? '?'} :: kinds=${JSON.stringify(caps(h)?.kinds ?? [])} :: features=${JSON.stringify(caps(h)?.features ?? [])}`)
  h.check('the real client advertises every required Browser kind and native scrolling',
    ['picker', 'row', 'overlay', 'text'].every((kind) => (caps(h)?.kinds ?? []).includes(kind))
    && (caps(h)?.features ?? []).includes('scroll'),
    JSON.stringify({ kinds: caps(h)?.kinds, features: caps(h)?.features }))

  // ── 1. Boot: two official Folders, Current first, the other collapsed ─────
  const initialReady = await waitFrame(h, (frame) => frame?.page === 'browse' && frame?.state === 'ready'
    && itemById(frame, 'workspace:ws-current') !== undefined
    && itemById(frame, 'workspace:ws-other') !== undefined, 'official Workspace folders')
  let frame = lastFrame(h)
  const bootIds = itemIds(frame)
  const currentFolder = itemById(frame, 'workspace:ws-current')
  const otherFolder = itemById(frame, 'workspace:ws-other')
  const bootPickerKey = frame?.pickerKey
  h.check('the first page is the native workspace Tree: Folder ITEMS, Current first, no retired scope property',
    initialReady && frame?.layout === 'tree' && frame?.scope === undefined
    && currentFolder?.open === true && currentFolder?.depth === 0
    && otherFolder?.open === false && otherFolder?.depth === 0
    && bootIds[0] === 'workspace:ws-current' && bootIds[1] === 'session:session-current',
    JSON.stringify({ layout: frame?.layout, scope: frame?.scope, ids: bootIds, current: currentFolder, other: otherFolder }))
  h.check('the Current Folder is labelled Current, owns eight expanded ordinary rows and a Show more row',
    String(currentFolder?.label).startsWith('Current · Project')
    && bootIds.filter((id) => id.startsWith('session:')).length === 8
    && itemById(frame, 'more:ws-current') !== undefined,
    JSON.stringify({ label: currentFolder?.label, sessions: sessionIds(frame), more: itemById(frame, 'more:ws-current') }))
  h.check('the other official Workspace is collapsed with no child Session and no Show more row',
    otherFolder !== undefined
    && !bootIds.some((id) => id.startsWith('session:session-other-') || id === 'session:session-content' || id === 'more:ws-other'),
    JSON.stringify({ ids: bootIds }))
  h.check('the first page keeps the current Session selected and separately marked as current',
    frame?.selected === 'session:session-current'
    && JSON.stringify(frame?.current) === JSON.stringify(['session:session-current']),
    JSON.stringify({ selected: frame?.selected, current: frame?.current }))

  // The client animates an entered list row (class `arr-a`): let the layout settle
  // before a rect is used as a visibility/containment proof.
  await h.sleep(600)
  const bootSnap = h.snapshot()
  const bootCurrentFolderRow = folderRow(h, bootSnap, 'Current · Project')
  const bootOtherFolderRow = folderRow(h, bootSnap, 'Other')
  h.check('the real client paints one native Picker with both Folder rows and their disclosure chevrons',
    pickerNode(bootSnap) !== undefined
    && nodesWith(bootSnap, 'sf-picker').length === 1
    && bootCurrentFolderRow !== undefined && findClass(bootCurrentFolderRow, 'pk-chev') !== undefined
    && bootOtherFolderRow !== undefined && findClass(bootOtherFolderRow, 'pk-chev') !== undefined
    && sessionRows(bootSnap).length === 8,
    JSON.stringify({
      pickers: nodesWith(bootSnap, 'sf-picker').length,
      folders: folderRows(bootSnap).map((node) => h.descendantsText(node)),
      sessions: sessionRows(bootSnap).map((node) => h.descendantsText(node).slice(0, 60)),
    }))
  h.capture('session-browser-workspace-tree-current-1280x800',
    'boot: Current Workspace Folder expanded first, the other official Folder collapsed')

  // The same tree at three pane sizes (Before the other Folder is expanded).
  const TREE_SIZES = [
    { w: 900, h: 640, name: '900x640' },
    { w: 560, h: 640, name: '560x640' },
    // The narrowest claimed pane: the enabled primary Resume action must stay
    // inside the client's action bar after the Folder-only actions are dropped.
    { w: 400, h: 600, name: '400x600' },
  ]
  for (const size of TREE_SIZES) {
    await h.resize(size.w, size.h)
    const ready = await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'tree'
      && JSON.stringify(itemIds(value)) === JSON.stringify(bootIds), `${size.name} folder tree`)
    const snap = h.snapshot()
    const resumeButton = buttonFor(h, snap, 'Resume')
    h.check(`${size.name}: one native Picker keeps the same Folder items and Current-first tree`,
      ready && lastFrame(h)?.pickerKey === bootPickerKey && pickerNode(snap) !== undefined
      && folderRow(h, snap, 'Current · Project') !== undefined && sessionRows(snap).length === 8,
      JSON.stringify({ pickerKey: lastFrame(h)?.pickerKey, folder: folderRow(h, snap, 'Current · Project') !== undefined, rows: sessionRows(snap).length }))
    h.check(`${size.name}: the primary Resume action is fully contained in the real action bar`,
      resumeButton !== undefined && containedXY(snap.chains, resumeButton),
      JSON.stringify({ resume: resumeButton === undefined ? 'missing' : rect(resumeButton),
        picker: pickerNode(snap) === undefined ? 'missing' : rect(pickerNode(snap)) }))
    h.capture(`session-browser-workspace-tree-current-${size.name}`, `official Folder tree at ${size.name}`)
  }
  await h.resize(1280, 800)
  await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'tree', 'back to 1280x800')

  // ── 2. Keyboard: select the other Folder, Enter expands it, Show more ─────
  await h.key('End', 500)
  const otherSelected = await waitFrame(h, (value) => value?.selected === 'workspace:ws-other', 'End selects the last Folder item')
  h.check('keyboard End selects the other official Folder without expanding it',
    otherSelected && lastFrame(h)?.layout === 'tree'
    && itemById(lastFrame(h), 'workspace:ws-other')?.open === false,
    JSON.stringify({ selected: lastFrame(h)?.selected, other: itemById(lastFrame(h), 'workspace:ws-other') }))
  h.capture('session-browser-workspace-folders-1280x800',
    'After: keyboard selection reaches the other official Folder; both Folder items are visible')

  await h.key('Return', 700)
  const expanded = await waitFrame(h, (value) => itemById(value, 'workspace:ws-other')?.open === true
    && itemById(value, 'session:session-other-00') !== undefined, 'Enter expands the other Folder')
  frame = lastFrame(h)
  const firstBatch = sessionIds(frame).filter((id) => id.startsWith('session:session-other-'))
  h.check('Enter on the other Folder expands it to the first five ordinary history rows and one Show more row',
    expanded && firstBatch.length === 5
    && JSON.stringify(firstBatch) === JSON.stringify(['session:session-other-00', 'session:session-other-01', 'session:session-other-02', 'session:session-other-03', 'session:session-other-04'])
    && itemById(frame, 'more:ws-other')?.detail.startsWith('8 remaining') === true
    && itemById(frame, 'session:session-other-05') === undefined,
    JSON.stringify({ firstBatch, more: itemById(frame, 'more:ws-other'), next: itemById(frame, 'session:session-other-05') }))
  h.check('Folder and Show more expansion never emits a Resume intent',
    !records(h).some((entry) => entry.resumeIntent), JSON.stringify(records(h).filter((entry) => entry.resumeIntent)))

  await press(h, 'Down', 6)
  const moreSelected = await waitFrame(h, (value) => value?.selected === 'more:ws-other', 'Show more is selected')
  await h.key('Return', 700)
  const revealed = await waitFrame(h, (value) => itemById(value, 'session:session-other-05') !== undefined, 'Show more reveals the next batch')
  frame = lastFrame(h)
  const secondBatch = sessionIds(frame).filter((id) => id.startsWith('session:session-other-'))
  h.check('Enter on Show more reveals the next history batch and keeps the remaining watermark',
    moreSelected && revealed && secondBatch.length === 10
    && JSON.stringify(secondBatch.slice(5)) === JSON.stringify(['session:session-other-05', 'session:session-other-06', 'session:session-other-07', 'session:session-other-08', 'session:session-other-09'])
    && itemById(frame, 'more:ws-other')?.detail.startsWith('3 remaining') === true
    && itemById(frame, 'session:session-other-10') === undefined,
    JSON.stringify({ secondBatch, more: itemById(frame, 'more:ws-other') }))
  h.check('the Current Folder stays expanded and separately marked while the other Folder grows',
    itemById(frame, 'workspace:ws-current')?.open === true
    && itemById(frame, 'session:session-current') !== undefined
    && JSON.stringify(frame?.current) === JSON.stringify(['session:session-current']),
    JSON.stringify({ current: itemById(frame, 'workspace:ws-current'), marker: frame?.current }))
  await press(h, 'Up', 6)
  const otherRowSelected = await waitFrame(h, (value) => value?.selected === 'session:session-other-04', 'keyboard selects a revealed other-Workspace Session')
  h.check('keyboard navigation selects a revealed Session row and enables Resume/Details',
    otherRowSelected
    && lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Resume'))?.disabled === undefined
    && lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Details'))?.disabled === undefined,
    JSON.stringify({ selected: lastFrame(h)?.selected, actions: lastFrame(h)?.actions }))
  h.capture('session-browser-workspace-expanded-1280x800',
    'After: the other official Folder expanded with its incremental history rows')

  for (const size of TREE_SIZES) {
    await h.resize(size.w, size.h)
    const ready = await waitFrame(h, (value) => value?.page === 'browse' && itemById(value, 'workspace:ws-other')?.open === true
      && itemById(value, 'session:session-other-09') !== undefined, `${size.name} expanded tree`)
    const snap = h.snapshot()
    h.check(`${size.name}: the expanded Folder keeps its ten visible rows and Show more item`,
      ready && lastFrame(h)?.pickerKey === bootPickerKey && pickerNode(snap) !== undefined
      && sessionIds(lastFrame(h)).filter((id) => id.startsWith('session:session-other-')).length === 10,
      JSON.stringify({ pickerKey: lastFrame(h)?.pickerKey, rows: sessionRows(snap).length }))
    h.capture(`session-browser-workspace-expanded-${size.name}`, `expanded other Folder at ${size.name}`)
  }
  await h.resize(1280, 800)
  await waitFrame(h, (value) => itemById(value, 'workspace:ws-other')?.open === true, 'back to expanded 1280x800')

  // ── 3. Pointer: the other Folder's disclosure collapses and re-expands ────
  await press(h, 'Home', 1)
  await press(h, 'Down', 10)
  await waitFrame(h, (value) => value?.selected === 'workspace:ws-other', 'bring the other Folder row into view')
  let collapseSnap = h.snapshot()
  let collapseRow = folderRow(h, collapseSnap, 'Other')
  const chevron = disclosure(collapseRow)
  const collapseClicked = chevron !== undefined && await h.click(collapseSnap.chains, chevron)
  const collapsed = await waitFrame(h, (value) => itemById(value, 'workspace:ws-other')?.open === false, 'real pointer collapses the Folder')
  frame = lastFrame(h)
  h.check('a real pointer click on the Folder disclosure collapses it and hides every child and Show more item',
    collapseClicked && collapsed
    && itemById(frame, 'workspace:ws-other')?.open === false
    && !itemIds(frame).some((id) => id.startsWith('session:session-other-') || id === 'more:ws-other')
    && sessionIds(frame).length === 8
    && !h.classNodes(h.snapshot(), 'pk-row').some((node) => h.descendantsText(node).includes('other-0')),
    JSON.stringify({ collapseClicked, ids: itemIds(frame) }))
  h.capture('session-browser-workspace-collapsed-1280x800',
    'After: the real pointer collapsed the other Folder; manual collapse hides its children')

  const expandSnap = h.snapshot()
  const expandRow = folderRow(h, expandSnap, 'Other')
  const expandChevron = disclosure(expandRow)
  const expandClicked = expandChevron !== undefined && await h.click(expandSnap.chains, expandChevron)
  const reexpanded = await waitFrame(h, (value) => itemById(value, 'workspace:ws-other')?.open === true
    && itemById(value, 'session:session-other-09') !== undefined, 'real pointer re-expands the Folder')
  h.check('a second real pointer click re-expands the same Folder with its retained history watermark',
    expandClicked && reexpanded
    && sessionIds(lastFrame(h)).filter((id) => id.startsWith('session:session-other-')).length === 10
    && itemById(lastFrame(h), 'more:ws-other') !== undefined,
    JSON.stringify({ expandClicked, selected: lastFrame(h)?.selected, rows: sessionIds(lastFrame(h)).length }))

  // ── 4. Current row disabled Resume; keyboard and pointer Session selection ─
  await press(h, 'Home', 1)
  await press(h, 'Down', 1)
  const currentSelected = await waitFrame(h, (value) => value?.selected === 'session:session-current', 'select the Current Session row')
  const currentResume = lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Resume'))
  const currentResumeButton = buttonFor(h, h.snapshot(), 'Resume')
  h.check('the Current Session row keeps the primary Resume disabled with the action-metadata reason',
    currentSelected
    && currentResume?.primary === true
    && currentResume?.disabled === 'The current session is already active.'
    && currentResumeButton !== undefined && hasClass(currentResumeButton, 'off'),
    JSON.stringify({ selected: lastFrame(h)?.selected, action: currentResume, button: currentResumeButton?.class }))
  h.capture('session-browser-footer-current-disabled-1280x800',
    'Current Session row: Resume stays primary and disabled; the reason is action metadata')

  await press(h, 'Down', 1)
  const longSelected = await waitFrame(h, (value) => value?.selected === 'session:session-long', 'keyboard selects the long row')
  const longResume = lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Resume'))
  h.check('keyboard selection of a listed non-current Session enables the primary Resume and Details',
    longSelected && longResume?.primary === true && longResume?.disabled === undefined
    && lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Details'))?.disabled === undefined,
    JSON.stringify({ selected: lastFrame(h)?.selected, actions: lastFrame(h)?.actions }))

  // End reaches the last item (the other Folder's Show more row); five steps up
  // lands on the row just above the pointer target.
  await press(h, 'End', 1)
  await press(h, 'Up', 6)
  await waitFrame(h, (value) => value?.selected === 'session:session-other-04', 'keyboard brings the pointer target into view')
  const pointerSnap = h.snapshot()
  const pointerTarget = sessionRow(h, pointerSnap, 'other-05')
  const pointerClicked = pointerTarget !== undefined && await h.click(pointerSnap.chains, pointerTarget)
  const pointerSelected = await waitFrame(h, (value) => value?.selected === 'session:session-other-05', 'real pointer selects a Session row')
  h.check('a real pointer click on a Session row changes selection only: no Resume intent, no switch',
    pointerClicked && pointerSelected
    && JSON.stringify(lastFrame(h)?.current) === JSON.stringify(['session:session-current'])
    && !records(h).some((entry) => entry.resumeIntent)
    && !records(h).some((entry) => entry.switchSession || entry.apply),
    JSON.stringify({ pointerClicked, selected: lastFrame(h)?.selected, current: lastFrame(h)?.current,
      intents: records(h).filter((entry) => entry.resumeIntent) }))
  const pointerResume = lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Resume'))
  h.check('the pointer-selected non-current Session enables Resume and Details in the real footer',
    pointerResume?.primary === true && pointerResume?.disabled === undefined
    && lastFrame(h)?.actions?.find((action) => String(action.label).startsWith('Details'))?.disabled === undefined,
    JSON.stringify({ actions: lastFrame(h)?.actions }))

  // ── 5. Details via the real footer action; Esc returns to the same Browser ─
  await press(h, 'Home', 1)
  await press(h, 'Down', 2)
  await waitFrame(h, (value) => value?.selected === 'session:session-long', 'select the long title Session for Details')
  await h.key('Tab', 500)
  const footerFocused = await waitFrame(h, (value) => Array.isArray(value?.actions)
    && value.actions.some((action) => String(action.label) === 'Details [Enter]'), 'Tab focuses the Details footer action')
  await h.key('Return', 900)
  const detailsOpened = await waitFrame(h, (value) => value?.page === 'details' && value?.readerBodyKey !== undefined, 'Details Reader')
  frame = lastFrame(h)
  let snap = h.snapshot()
  const readerOverlay = overlayNode(snap)
  const readerBody = overlayBody(snap)
  const longReaderText = (frame?.texts ?? []).map((entry) => String(entry.text))
  h.check('the real footer Details action opens one native scrolling Reader for the selected Session',
    footerFocused && detailsOpened && pickerNode(snap) === undefined
    && readerOverlay !== undefined && readerBody !== undefined
    && detailBodyId(frame).startsWith('session-browser-details-body-'),
    JSON.stringify({ page: frame?.page, body: frame?.readerBodyKey, overlay: readerOverlay !== undefined, body: readerBody !== undefined }))
  h.check('the Reader carries the complete long Host title as one grid value, not a truncated row',
    longReaderText.some((text) => text.startsWith('Needle long session title') && text.includes('unicode 資料 🚀'))
    && longReaderText.includes('session-long')
    && longReaderText.includes('Persisted session'),
    `textCount=${longReaderText.length}`)
  // The grid really wraps: the long title value is taller than the client's own
  // Back-row line height, and every grid keeps its full width inside the body.
  const backRow = h.classNodes(snap, 'sf-t-accent').find((node) => h.descendantsText(node).includes('Back'))
  const LINE = backRow === undefined ? 0 : rect(backRow)[3]
  const grids = h.classNodes(snap, 'sf-kv')
  const subclassOf = (node, name) => {
    const out = []
    const walk = (entry) => {
      if (classTokens(entry).includes(name)) out.push(entry)
      for (const child of entry.children ?? []) walk(child)
    }
    if (node !== undefined) walk(node)
    return out
  }
  const longValue = grids.flatMap((grid) => subclassOf(grid, 'sf-kv-v'))
    .find((node) => h.descendantsText(node).startsWith('Needle long session title'))
  h.check('the long title FOLDS inside its grid value column instead of being cut',
    LINE > 0 && longValue !== undefined && rect(longValue)[3] > 1.5 * LINE
    && containedX(snap.chains, longValue),
    JSON.stringify({ line: LINE, value: longValue === undefined ? 'missing' : rect(longValue) }))
  h.capture('session-browser-reader-long-title-1280x800',
    'Details Reader: the complete long title folds inside its value column')

  await h.key('Escape', 900)
  const backToBrowser = await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'tree', 'Esc returns to the Browser')
  frame = lastFrame(h)
  h.check('Esc from the Reader returns to the SAME Browser instance, selection and Folder expansion',
    backToBrowser && frame?.pickerKey === bootPickerKey && frame?.selected === 'session:session-long'
    && itemById(frame, 'workspace:ws-other')?.open === true
    && sessionIds(frame).filter((id) => id.startsWith('session:session-other-')).length === 10,
    JSON.stringify({ page: frame?.page, pickerKey: frame?.pickerKey, selected: frame?.selected, other: itemById(frame, 'workspace:ws-other') }))
  const treeIdsBeforeSearch = itemIds(frame)
  h.capture('session-browser-tree-after-reader-1280x800',
    'After the Reader: the same Browser, selection and Folder expansion')

  // ── 6. Search: global Cards, the Host-only content hit, then the same tree ─
  await keyText(h, 'needle')
  const searched = await waitFrame(h, (value) => value?.layout === 'cards' && value?.query === 'needle'
    && value?.state === 'ready' && frameItems(value).length === 2, 'global Host content search')
  frame = lastFrame(h)
  const cardIds = itemIds(frame)
  const longCard = itemById(frame, 'session:session-long')
  const contentCard = itemById(frame, 'session:session-content')
  h.check('a non-empty query switches the same Picker to global Cards and keeps the Host-only content hit listed',
    searched && frame?.pickerKey === bootPickerKey && frame?.scope === undefined
    && JSON.stringify(cardIds) === JSON.stringify(['session:session-long', 'session:session-content'])
    && frame?.total === 2,
    JSON.stringify({ layout: frame?.layout, query: frame?.query, ids: cardIds, scope: frame?.scope, total: frame?.total }))
  h.check('metadata and Host content results keep Reader order; the Host-only snippet is not client-filtered by query text',
    longCard?.badges?.some((badge) => badge.text === 'Both') === true
    && String(longCard?.detail).includes('Tail-bound evidence')
    && contentCard?.badges?.some((badge) => badge.text === 'Content') === true
    && String(contentCard?.detail).includes('Truncated Host excerpt')
    && !String(contentCard?.detail).toLowerCase().includes('needle')
    && !String(contentCard?.label).toLowerCase().includes('needle'),
    JSON.stringify({ longCard, contentCard }))
  await h.sleep(700)
  const cardSnap = h.snapshot()
  const clientLongCard = sessionRow(h, cardSnap, 'Needle long session title')
  const clientContentCard = sessionRow(h, cardSnap, 'A title without the search term')
  h.check('the real Tern client paints both global Cards, including the content-only card whose metadata omits the literal query',
    clientLongCard !== undefined && containedXY(cardSnap.chains, clientLongCard)
    && clientContentCard !== undefined && containedXY(cardSnap.chains, clientContentCard)
    && sessionRows(cardSnap).length === 2,
    JSON.stringify({ rows: sessionRows(cardSnap).map((node) => h.descendantsText(node).slice(0, 80)) }))
  h.capture('session-browser-workspace-search-1280x800',
    'Global Cards: both the metadata+content card and the Host-only content hit are listed')

  for (const size of TREE_SIZES) {
    await h.resize(size.w, size.h)
    const ready = await waitFrame(h, (value) => value?.layout === 'cards' && value?.query === 'needle'
      && frameItems(value).length === 2, `${size.name} search cards`)
    const sizeSnap = h.snapshot()
    h.check(`${size.name}: the same global Cards and the Host-only hit remain listed`,
      ready && lastFrame(h)?.pickerKey === bootPickerKey && sessionRows(sizeSnap).length === 2
      && itemById(lastFrame(h), 'session:session-content') !== undefined,
      JSON.stringify({ pickerKey: lastFrame(h)?.pickerKey, rows: sessionRows(sizeSnap).length }))
    h.capture(`session-browser-workspace-search-${size.name}`, `global Cards at ${size.name}`)
  }

  // The Host excerpt + tail, on the negotiated Reader, at the short pane.
  await h.resize(560, 640)
  await waitFrame(h, (value) => value?.layout === 'cards' && value?.query === 'needle', 'short-pane Cards before Reader')
  await h.key('Tab', 500)
  await h.key('Return', 900)
  const cardDetailsOpened = await waitFrame(h, (value) => value?.page === 'details' && value?.readerBodyKey !== undefined, 'Details from the long card')
  frame = lastFrame(h)
  snap = h.snapshot()
  const cardGrids = h.classNodes(snap, 'sf-kv')
  const excerptTexts = (frame?.texts ?? []).map((entry) => String(entry.text))
  const negotiatedKv = (caps(h)?.kinds ?? []).includes('kv')
  h.check('the Reader from the search card carries the complete Host excerpt tail as wrapped prose',
    cardDetailsOpened && negotiatedKv && cardGrids.length === 4
    && excerptTexts.some((text) => text.includes('END-OF-DETAILS-TAIL'))
    && excerptTexts.some((text) => text === 'Matching content'),
    JSON.stringify({ page: frame?.page, grids: cardGrids.length, excerpt: excerptTexts.filter((text) => text.includes('END-OF-DETAILS-TAIL')).length }))
  await h.sleep(400)
  const beforeTail = tailPosition(h)
  h.check('the Host excerpt tail begins below the short 560x640 Reader viewport before scrolling',
    beforeTail !== undefined && beforeTail.tailBottom - beforeTail.bodyBottom > 200,
    JSON.stringify(beforeTail))
  let tail = beforeTail
  let attempts = 0
  while (attempts < 6 && tail !== undefined && tail.tailBottom > tail.bodyBottom + 8) {
    await h.key('End', 650)
    await h.sleep(120)
    tail = tailPosition(h)
    attempts += 1
  }
  const scrollRecords = records(h).filter((entry) => entry.nativeScroll).map((entry) => entry.nativeScroll)
  h.check('End scroll reaches the actual Host excerpt tail inside the 560x640 Reader body',
    tail !== undefined && tail.tailBottom <= tail.bodyBottom + 8 && attempts > 0,
    JSON.stringify({ attempts, beforeTail, afterTail: tail }))
  h.check('the native Reader scroll op targets this exact reading epoch/body',
    scrollRecords.length > 0 && scrollRecords.at(-1).to === 'end'
    && String(scrollRecords.at(-1).id).endsWith(detailBodyId(frame)),
    JSON.stringify({ body: frame?.readerBodyKey, scroll: scrollRecords.at(-1) }))
  h.capture('session-browser-reader-excerpt-tail-560x640',
    'Details at the actual Host excerpt tail in the short negotiated Reader')

  await h.key('Escape', 900)
  const backToCards = await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'cards' && value?.query === 'needle', 'Esc returns to Cards')
  h.check('Esc at the Reader tail returns to the same global Cards and selected Session',
    backToCards && lastFrame(h)?.selected === 'session:session-long' && lastFrame(h)?.pickerKey === bootPickerKey,
    JSON.stringify({ page: lastFrame(h)?.page, query: lastFrame(h)?.query, selected: lastFrame(h)?.selected }))
  await h.resize(1280, 800)
  await waitFrame(h, (value) => value?.layout === 'cards' && value?.query === 'needle', 'cards back at 1280x800')

  await h.key('Escape', 700)
  const cleared = await waitFrame(h, (value) => value?.layout === 'tree' && value?.query === '', 'Escape clears the query')
  frame = lastFrame(h)
  h.check('clearing the query returns to the workspace Tree with the SAME Folder expansion state',
    cleared && frame?.pickerKey === bootPickerKey && frame?.selected === 'session:session-long'
    && JSON.stringify(itemIds(frame)) === JSON.stringify(treeIdsBeforeSearch)
    && itemById(frame, 'workspace:ws-other')?.open === true
    && sessionIds(frame).filter((id) => id.startsWith('session:session-other-')).length === 10,
    JSON.stringify({ ids: itemIds(frame), before: treeIdsBeforeSearch, other: itemById(frame, 'workspace:ws-other') }))
  h.capture('session-browser-tree-restored-1280x800',
    'After clearing the query: the same Tree, selection and retained Folder expansion')

  // ── retained S3 PR-C coverage: the read-only migration row ────────────────
  const migrationItem = itemById(frame, 'session:session-migration')
  h.check('the real Tree row keeps the read-only migration state in its row detail',
    migrationItem !== undefined && String(migrationItem.detail).includes('Migration required'),
    JSON.stringify({ migrationItem }))
  await press(h, 'Home', 1)
  await press(h, 'Down', 3)
  await waitFrame(h, (value) => value?.selected === 'session:session-migration', 'select the migration row')
  await h.key('Tab', 500)
  await h.key('Return', 900)
  const migrationDetails = await waitFrame(h, (value) => value?.page === 'details', 'migration row Details')
  const migrationTexts = (lastFrame(h)?.texts ?? []).map((entry) => String(entry.text))
  h.check('the Details State paints the read-only migration state beside the persisted state',
    migrationDetails && migrationTexts.some((text) => text.includes('Migration required'))
    && migrationTexts.some((text) => text.includes('Persisted session')),
    JSON.stringify(migrationTexts.filter((text) => text.includes('Migration') || text.includes('Persisted'))))
  h.capture('session-browser-migration-details-1280x800',
    'Details of the migration-required Session: a read-only state label, no control')
  await h.key('Escape', 900)
  await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'tree', 'migration Details back to Browser')

  // ── 7. Add directory: the SAME native Picker in Host absolute-path mode ───
  const beforePathSnap = h.snapshot()
  const addDirectoryButton = buttonFor(h, beforePathSnap, 'Add directory')
  const addDirectoryClicked = addDirectoryButton !== undefined && await h.click(beforePathSnap.chains, addDirectoryButton)
  const pathOpened = await waitFrame(h, (value) => value?.page === 'browse' && value?.title === 'Add directory', 'Add directory path mode')
  frame = lastFrame(h)
  const pathActions = frame?.actions ?? []
  h.check('the real footer Add directory action opens the SAME Picker in Host absolute-path mode',
    addDirectoryClicked && pathOpened && frame?.layout === 'tree'
    && frame?.title === 'Add directory' && frame?.query === ''
    && frame?.focus === 'list' && frame?.state === 'ready'
    && itemIds(frame).length === 0 && frame?.total === 0,
    JSON.stringify({ title: frame?.title, query: frame?.query, layout: frame?.layout, items: itemIds(frame), total: frame?.total }))
  h.check('the path mode footer is exactly Use directory (confirm-directory) plus the cancel action, and the picker key is unchanged',
    pathActions.length === 2
    && String(pathActions[0]?.id).startsWith('confirm-directory#') && pathActions[0]?.label === 'Use directory'
    && pathActions[1]?.id === 'close' && pathActions[1]?.label === 'Cancel'
    && frame?.pickerKey === bootPickerKey,
    JSON.stringify({ actions: pathActions, pickerKey: frame?.pickerKey }))
  h.measure('the TSP and PiTUI path modes use the same Cancel wording',
    JSON.stringify({ label: pathActions[1]?.label, id: pathActions[1]?.id }))
  const pathSnap = h.snapshot()
  const useDirectoryButton = buttonFor(h, pathSnap, 'Use directory')
  h.check('the real client paints the Add directory title and both path-mode buttons',
    h.has(pathSnap, 'Add directory') && useDirectoryButton !== undefined && buttonFor(h, pathSnap, 'Cancel') !== undefined
    && pathActions.some((action) => action.disabled === undefined),
    JSON.stringify({ title: h.texts(pathSnap).filter((text) => text.includes('directory') || text.includes('Directory')), button: useDirectoryButton === undefined ? 'missing' : h.descendantsText(useDirectoryButton) }))
  h.capture('session-browser-path-mode-1280x800', 'Add directory: the same Picker in Host absolute-path mode')

  for (const size of TREE_SIZES) {
    await h.resize(size.w, size.h)
    const ready = await waitFrame(h, (value) => value?.title === 'Add directory', `${size.name} path mode`)
    h.check(`${size.name}: path mode keeps the same title, empty query and both actions`,
      ready && lastFrame(h)?.pickerKey === bootPickerKey && lastFrame(h)?.query === ''
      && (lastFrame(h)?.actions ?? []).length === 2,
      JSON.stringify({ title: lastFrame(h)?.title, actions: lastFrame(h)?.actions }))
    h.capture(`session-browser-path-mode-${size.name}`, `Host absolute-path mode at ${size.name}`)
  }
  await h.resize(1280, 800)
  await waitFrame(h, (value) => value?.title === 'Add directory', 'path mode back at 1280x800')

  await keyText(h, '/host/refused')
  const typed = await waitFrame(h, (value) => value?.title === 'Add directory' && value?.query === '/host/refused', 'absolute path typed')
  h.check('the typed absolute Host path becomes the same Picker query and the real client shows it',
    typed && h.has(h.snapshot(), '/host/refused'),
    JSON.stringify({ query: lastFrame(h)?.query, texts: h.texts(h.snapshot()).filter((text) => text.includes('/host')) }))
  h.capture('session-browser-path-typed-1280x800', 'Add directory: retained absolute Host path before submit')

  const submitsBefore = addDirectoryRecords(h).length
  await h.key('Return', 120)
  const submitting = await waitFrame(h, (value) => value?.title === 'Add directory'
    && (value?.actions ?? []).some((action) => String(action.id).startsWith('confirm-directory#')
      && action.disabled === 'Directory verification is in progress.'), 'Host directory verification in flight')
  h.check('the first Enter submits exactly one Host verification and disables the visible Use directory action',
    submitting && addDirectoryRecords(h).length === submitsBefore + 1
    && addDirectoryRecords(h).at(-1)?.path === '/host/refused',
    JSON.stringify({ records: addDirectoryRecords(h), actions: lastFrame(h)?.actions }))
  // While submitting, the panel fences keys and events: two more Enters and a
  // path edit must neither submit again nor change the retained path.
  await h.key('Return', 60)
  await h.key('Return', 60)
  await h.key('x', 60)
  await h.sleep(300)
  const stillSubmitting = lastFrame(h)
  h.check('Enter repeats and key edits while the Host verification is in flight are fenced (one submission, path intact)',
    addDirectoryRecords(h).length === submitsBefore + 1
    && stillSubmitting?.query === '/host/refused'
    && stillSubmitting?.title === 'Add directory'
    && (stillSubmitting?.actions ?? []).some((action) => action.disabled === 'Directory verification is in progress.'),
    JSON.stringify({ submitted: addDirectoryRecords(h).length, query: stillSubmitting?.query, actions: stillSubmitting?.actions }))

  const refusalSeen = await waitFrame(h, (value) => value?.query === '/host/refused'
    && (value?.actions ?? []).some((action) => String(action.id).startsWith('confirm-directory#') && action.disabled === undefined), 'Host refusal settles')
  frame = lastFrame(h)
  h.check('a settled Host refusal keeps the path in the SAME path mode and re-enables Use directory',
    refusalSeen && frame?.title === 'Add directory' && frame?.query === '/host/refused'
    && frame?.layout === 'tree' && itemIds(frame).length === 0
    && (frame?.actions ?? []).length === 2,
    JSON.stringify({ title: frame?.title, query: frame?.query, actions: frame?.actions }))
  h.check('the Host refusal is delivered as the real error notice, with the submitted path recorded',
    notices(h).some((notice) => notice.kind === 'error' && String(notice.message).includes('Host refused the directory'))
    && addSettlements(h).length === 1 && addSettlements(h)[0]?.outcome?.kind === 'failed'
    && addDirectoryRecords(h).length === 1,
    JSON.stringify({ notices: notices(h), settlements: addSettlements(h) }))
  h.capture('session-browser-path-refused-1280x800',
    'After: a Host refusal retains the absolute path in the same path mode')

  const retrySnap = h.snapshot()
  const retryButton = buttonFor(h, retrySnap, 'Use directory')
  const retryClicked = retryButton !== undefined && await h.click(retrySnap.chains, retryButton)
  const retried = await waitFrame(h, () => addDirectoryRecords(h).length === 2, 'Use directory retries the retained path')
  h.check('a real click on the visible Use directory action retries the SAME retained Host path',
    retryClicked && retried
    && addDirectoryRecords(h)[1]?.path === '/host/refused',
    JSON.stringify({ clicked: retryClicked, paths: addDirectoryRecords(h).map((entry) => entry.path) }))
  const successSeen = await waitFrame(h, (value) => value?.title === 'Sessions' && value?.layout === 'tree', 'Host success returns to the Browser tree')
  frame = lastFrame(h)
  h.check('Host success closes the path chooser and restores the same Browser tree and Folder expansion',
    successSeen && frame?.pickerKey === bootPickerKey && frame?.query === ''
    && itemById(frame, 'workspace:ws-other')?.open === true
    && sessionIds(frame).filter((id) => id.startsWith('session:session-other-')).length === 10
    // No Folder is selected after the path round trip, so neither Folder-only
    // action (Use directory / New session) is offered.
    && (frame?.actions ?? []).length === 4
    && !(frame?.actions ?? []).some((action) => String(action.id).startsWith('new-session#')),
    JSON.stringify({ title: frame?.title, pickerKey: frame?.pickerKey, actions: frame?.actions, ids: itemIds(frame) }))
  h.check('the registered canonical Host path is announced as the real info notice',
    notices(h).some((notice) => notice.kind === 'info' && notice.message === 'Directory added: /host/canonical')
    && addSettlements(h).length === 2 && addSettlements(h)[1]?.outcome?.kind === 'registered',
    JSON.stringify({ notices: notices(h), settlements: addSettlements(h) }))
  h.capture('session-browser-path-registered-1280x800',
    'After: Host registration closes path mode and returns to the same workspace Tree')

  // ── retained Resume coverage: one real footer intent, pending, no switch ──
  const beforeResumeSnap = h.snapshot()
  const resumeButton = buttonFor(h, beforeResumeSnap, 'Resume')
  const resumeSelected = lastFrame(h)?.selected
  const resumeClicked = resumeButton !== undefined && await h.click(beforeResumeSnap.chains, resumeButton)
  const intentSeen = await waitFrame(h, () => records(h).some((entry) => entry.resumeIntent), 'real footer Resume intent')
  const resumePending = await waitFrame(h, (value) => (value?.actions ?? []).some((action) =>
    String(action.label).startsWith('Resume') && action.disabled === 'Switching sessions…'), 'Resume pending state')
  const resumeIntents = records(h).filter((entry) => entry.resumeIntent)
  h.check('the real footer Resume click emits exactly one eligible intent and never fakes a Session switch',
    resumeClicked && intentSeen && resumePending
    && resumeIntents.length === 1
    && resumeIntents[0]?.resumeIntent?.sessionId === String(resumeSelected ?? '').replace(/^session:/u, '')
    && resumeIntents[0]?.resumeIntent?.currentSessionId === 'session-current'
    && resumeIntents[0]?.resumeIntent?.source === 'footer'
    && !records(h).some((entry) => entry.apply || entry.switchSession),
    JSON.stringify({ resumeClicked, selected: resumeSelected, intents: resumeIntents,
      businessSwitches: records(h).filter((entry) => entry.apply || entry.switchSession) }))
  const pendingSnap = h.snapshot()
  const pendingResume = buttonFor(h, pendingSnap, 'Resume')
  const pendingRepeat = pendingResume !== undefined && await h.click(pendingSnap.chains, pendingResume)
  await h.sleep(400)
  h.check('a second footer Resume click during the pending settlement dispatches no extra intent',
    records(h).filter((entry) => entry.resumeIntent).length === 1
    && lastFrame(h)?.current?.[0] === 'session:session-current',
    JSON.stringify({ pendingRepeat, intents: records(h).filter((entry) => entry.resumeIntent).length,
      disabled: (lastFrame(h)?.actions ?? []).find((action) => String(action.label).startsWith('Resume'))?.disabled }))
  h.capture('session-browser-footer-resume-pending-1280x800',
    'Resume intent is pending; this read harness never performs a business Session switch')

  h.measure('run totals', JSON.stringify({
    frames: frames(h).length,
    readCalls: records(h).filter((entry) => entry.read).map((entry) => entry.read.method),
    resumes: records(h).filter((entry) => entry.resumeIntent).length,
    submittedPaths: addDirectoryRecords(h).map((entry) => entry.path),
    nativeScrolls: scrollRecords,
    contentOnlyCardPainted: clientContentCard !== undefined,
  }))
}
