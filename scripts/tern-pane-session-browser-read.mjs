/** Real Tern headless qualification for the production Session Browser Presenter and Resume affordance. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, rect } from './tern-pane-geometry.mjs'

const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((entry) => entry.frame).map((entry) => entry.frame)
const lastFrame = (h) => frames(h).at(-1)
const caps = (h) => records(h).find((entry) => entry.caps)?.caps
const classTokens = (node) => String(node.class ?? '').split(/\s+/u).filter(Boolean)
const hasClass = (node, token) => classTokens(node).includes(token)
const nodesWith = (snap, token) => snap.nodes.filter((node) => hasClass(node, token))
const pickerNode = (snap) => nodesWith(snap, 'sf-picker')[0]
const cardRows = (snap) => nodesWith(snap, 'pk-row').filter((node) => !hasClass(node, 'grp'))
const overlayNode = (snap) => nodesWith(snap, 'sf-overlay')[0]
const overlayBody = (snap) => nodesWith(snap, 'sf-ov-body')[0]
const frameItems = (frame) => Array.isArray(frame?.items) ? frame.items : []
const waitFrame = async (h, predicate, label, limit = 60) => {
  for (let step = 0; step < limit; step += 1) {
    if (predicate(lastFrame(h))) return true
    await h.sleep(100)
  }
  h.log(`WAIT-FAIL ${label} frame=${JSON.stringify(lastFrame(h))}`)
  return false
}
const keyText = async (h, text) => {
  for (const character of text) await h.key(character, 120)
}
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
  h.check('the production Session Browser Presenter boots in the real Tern pane', booted, h.texts(h.snapshot()).join(' | '))
  if (!booted) return

  h.measure('real client and negotiated Browser capabilities',
    `${caps(h)?.term ?? '?'} ${caps(h)?.ver ?? '?'} :: kinds=${JSON.stringify(caps(h)?.kinds ?? [])} :: features=${JSON.stringify(caps(h)?.features ?? [])}`)
  h.check('the real client advertises every required Browser kind and native scrolling',
    ['picker', 'row', 'overlay', 'text'].every((kind) => (caps(h)?.kinds ?? []).includes(kind))
    && (caps(h)?.features ?? []).includes('scroll'),
    JSON.stringify({ kinds: caps(h)?.kinds, features: caps(h)?.features }))

  const initialReady = await waitFrame(h, (frame) => frame?.page === 'browse' && frame?.state === 'ready', 'initial list')
  let frame = lastFrame(h)
  h.check('the first page is the native workspace Tree with Current separate from selection',
    initialReady && frame?.layout === 'tree' && frame?.scope === 'workspace'
    && frame?.selected === 'session:session-current'
    && JSON.stringify(frame?.current) === JSON.stringify(['session:session-current'])
    && frameItems(frame).length === 54,
    JSON.stringify({ layout: frame?.layout, scope: frame?.scope, selected: frame?.selected, current: frame?.current, count: frameItems(frame).length }))
  const browserKey = frame?.pickerKey
  h.check('the TSP surface exposes one native Picker and no extra page', pickerNode(h.snapshot()) !== undefined)
  h.capture('session-browser-tree-1280x800', 'workspace Tree with 54 main rows and separate Current marker')

  await h.key('Tab', 500)
  await h.key('Return', 800)
  const allScope = await waitFrame(h, (value) => value?.scope === 'all', 'All workspaces scope')
  frame = lastFrame(h)
  h.check('All workspaces restores all 56 listed main rows and preserves the Picker key',
    allScope && frame?.layout === 'tree' && frameItems(frame).length === 56 && frame?.pickerKey === browserKey,
    JSON.stringify({ scope: frame?.scope, count: frameItems(frame).length, pickerKey: frame?.pickerKey }))
  // ── S3 PR-C: the Host-authoritative on-disk format state, painted ─────────
  // A migration-required row is read-only text in the row detail, never a
  // control and never a page of its own.
  const migrationTreeDetail = frameItems(frame)
    .find((item) => item.id === 'session:session-migration')?.detail
  h.check('the real client paints the read-only migration state in the row detail',
    String(migrationTreeDetail ?? '').includes('Migration required'),
    JSON.stringify({ migrationTreeDetail }))
  h.capture('session-browser-migration-row-1280x800', 'migration-required row detail at 1280x800')
  const lineage = new Map(frameItems(frame).map((item) => [item.id, item.depth]))
  h.check('the real all-workspaces tree keeps the cross-workspace child under its listed parent',
    lineage.get('session:session-long') === 1 && lineage.get('session:session-row-00') === 2
    && lineage.get('session:session-row-51') === 53 && lineage.get('session:session-content') === 2,
    JSON.stringify([...lineage.entries()].filter(([id]) => ['session:session-long', 'session:session-row-00', 'session:session-row-51', 'session:session-content'].includes(id))))
  const allIds = frameItems(frame).map((item) => item.id)
  const projected = await waitFrame(h, (value) => frameItems(value).some((item) => item.id === 'session:session-long'
    && String(item.label).startsWith('Needle long session title')), 'projected title appears')
  const longRow = cardRows(h.snapshot()).find((node) => h.descendantsText(node).startsWith('Needle long session title'))
  const pointerSelected = longRow === undefined ? false : await h.click(h.snapshot().chains, longRow)
  const pointerApplied = await waitFrame(h, (value) => value?.selected === 'session:session-long', 'real pointer selects long row')
  h.check('the real client click on an unselected row changes selection only',
    projected && pointerSelected && pointerApplied && lastFrame(h)?.current?.[0] === 'session:session-current'
    && !records(h).some((entry) => entry.resumeIntent),
    JSON.stringify({ projected, pointerSelected, pointerApplied, selected: lastFrame(h)?.selected, current: lastFrame(h)?.current, longRow: longRow === undefined ? 'missing' : h.descendantsText(longRow) }))
  await h.key('Home', 500)
  await waitFrame(h, (value) => value?.selected === allIds[0], 'restore first row after pointer selection')
  await h.key('End', 500)
  const endSelected = await waitFrame(h, (value) => value?.selected === allIds.at(-1), 'End selects final row')
  const endCurrent = lastFrame(h)?.current?.[0]
  await h.key('Home', 500)
  const homeSelected = await waitFrame(h, (value) => value?.selected === allIds[0], 'Home selects first row')
  h.check('native keyboard Home/End update selection while Current remains independently marked',
    endSelected && homeSelected && endCurrent === 'session:session-current'
    && lastFrame(h)?.current?.[0] === 'session:session-current',
    JSON.stringify({ last: allIds.at(-1), endCurrent, frame: lastFrame(h)?.selected, current: lastFrame(h)?.current }))
  h.capture('session-browser-tree-all-1280x800', 'All workspaces retains lineage and keyboard row navigation')

  const viewports = [
    { w: 900, h: 640, name: '900x640' },
    { w: 560, h: 640, name: '560x640' },
    { w: 400, h: 600, name: '400x600' },
  ]
  const viewportEvidence = []
  for (const size of viewports) {
    await h.resize(size.w, size.h)
    const ready = await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'tree', `${size.name} resize`)
    frame = lastFrame(h)
    const snap = h.snapshot()
    const picker = pickerNode(snap)
    const rows = cardRows(snap)
    viewportEvidence.push({ size: size.name, picker: picker !== undefined, rows: rows.length, key: frame?.pickerKey, scope: frame?.scope })
    h.check(`${size.name}: the same native Tree, Picker identity and readable rows remain`,
      ready && frame?.pickerKey === browserKey && frame?.layout === 'tree' && picker !== undefined && rows.length > 0,
      JSON.stringify(viewportEvidence.at(-1)))
    h.capture(`session-browser-tree-${size.name}`, `native Tree after resize to ${size.name}`)
  }
  h.measure('ordinary viewport tree presence and stable Picker identity', JSON.stringify(viewportEvidence))
  await h.key('Tab', 400)
  await h.key('Tab', 400)
  frame = lastFrame(h)
  const currentResumeAction = frame?.actions?.find((action) => String(action.label).startsWith('Resume'))
  const currentResumeButton = nodesWith(h.snapshot(), 'pk-btn').find((node) => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
  h.check('Current keeps primary Resume disabled; expected reason is in action metadata',
    frame?.selected === 'session:session-current'
    && currentResumeAction?.primary === true
    && currentResumeAction?.disabled === 'The current session is already active.'
    && currentResumeButton !== undefined,
    JSON.stringify({ selected: frame?.selected, action: currentResumeAction, buttonClass: currentResumeButton?.class }))
  h.measure('Current Resume footer geometry in the real 400x600 client', JSON.stringify({
    disabled: currentResumeAction?.disabled,
    painted: currentResumeButton !== undefined,
    buttonClass: currentResumeButton?.class,
    buttonBox: currentResumeButton === undefined ? 'none' : rect(currentResumeButton),
  }))
  h.capture('session-browser-footer-current-disabled-400x600', 'Current Resume is disabled; reason is action metadata, not visible in capture')

  const resumeRow = cardRows(h.snapshot()).find((node) => h.descendantsText(node).startsWith('Needle long session title'))
  const resumeRowClicked = resumeRow !== undefined && await h.click(h.snapshot().chains, resumeRow)
  const resumeRowSelected = await waitFrame(h, (value) => value?.selected === 'session:session-long', 'select non-current Resume target')
  h.check('pointer selection of a listed non-current row does not dispatch Resume',
    resumeRowClicked && resumeRowSelected && lastFrame(h)?.current?.[0] === 'session:session-current'
    && !records(h).some((entry) => entry.resumeIntent),
    JSON.stringify({ selected: lastFrame(h)?.selected, current: lastFrame(h)?.current, resumeRowClicked, resumeRowSelected }))
  await h.key('Tab', 400)
  await h.key('Tab', 400)
  frame = lastFrame(h)
  const enabledResumeAction = frame?.actions?.find((action) => String(action.label).startsWith('Resume'))
  const enabledResumeButton = nodesWith(h.snapshot(), 'pk-btn').find((node) => h.descendantsText(node).replace(' [Enter]', '') === 'Resume')
  const resumeButtonContained = enabledResumeButton !== undefined && containedXY(h.snapshot().chains, enabledResumeButton)
  h.check('a listed non-current row enables the primary Resume footer inside the Picker',
    frame?.selected === 'session:session-long'
    && enabledResumeAction?.disabled === undefined
    && enabledResumeAction?.primary === true
    && resumeButtonContained,
    JSON.stringify({ selected: frame?.selected, action: enabledResumeAction, button: enabledResumeButton === undefined ? undefined : rect(enabledResumeButton), contained: resumeButtonContained }))
  h.measure('enabled primary Resume footer geometry in the real 400x600 client', JSON.stringify({
    action: enabledResumeAction,
    buttonClass: enabledResumeButton?.class,
    buttonBox: enabledResumeButton === undefined ? 'none' : rect(enabledResumeButton),
  }))
  h.capture('session-browser-footer-resume-enabled-400x600', 'non-current Resume is enabled and primary')
  const footerResumeClicked = enabledResumeButton !== undefined
    && await h.click(h.snapshot().chains, enabledResumeButton)
  const footerIntentSeen = await waitFrame(h, () => records(h).some((entry) => entry.resumeIntent?.source === 'footer'), 'real footer Resume click')
  const footerPending = await waitFrame(h, (value) => value?.actions?.some((action) =>
    String(action.label).startsWith('Resume') && action.disabled === 'Switching sessions…') === true, 'Resume pending state')
  h.check('real-client footer click emits one intent and does not fake a Session switch',
    footerResumeClicked && footerIntentSeen && footerPending
    && records(h).filter((entry) => entry.resumeIntent).length === 1
    && lastFrame(h)?.current?.[0] === 'session:session-current'
    && !records(h).some((entry) => entry.switchSession || entry.apply),
    JSON.stringify({ footerResumeClicked, footerIntentSeen, footerPending, current: lastFrame(h)?.current,
      intents: records(h).filter((entry) => entry.resumeIntent) }))
  h.capture('session-browser-footer-resume-pending-400x600', 'Resume intent is pending; this read harness does not perform business switching')

  await keyText(h, 'needle')
  const searched = await waitFrame(h, (value) => value?.layout === 'cards' && value?.query === 'needle'
    && value?.state === 'ready' && frameItems(value).length === 2, 'global content search')
  frame = lastFrame(h)
  const ids = frameItems(frame).map((item) => item.id)
  const longCard = frameItems(frame).find((item) => item.id === 'session:session-long')
  const contentCard = frameItems(frame).find((item) => item.id === 'session:session-content')
  h.check('non-empty query switches the same Picker to global Cards and keeps Host-only hits outside the workspace',
    searched && frame?.pickerKey === browserKey && JSON.stringify(ids) === JSON.stringify(['session:session-long', 'session:session-content'])
    && frame?.scope === undefined && frame?.total === 2,
    JSON.stringify({ layout: frame?.layout, query: frame?.query, ids, scope: frame?.scope, total: frame?.total }))
  h.check('metadata and Host results keep Reader order; the content-only excerpt is not client-filtered by query text',
    longCard?.badges?.some((badge) => badge.text === 'Both') === true
    && String(longCard?.detail).includes('Tail-bound evidence')
    && contentCard?.badges?.some((badge) => badge.text === 'Content') === true
    && String(contentCard?.detail).includes('Truncated Host excerpt')
    && !String(contentCard?.detail).toLowerCase().includes('needle'),
    JSON.stringify({ longCard, contentCard }))
  const clientContentRow = cardRows(h.snapshot()).find((node) => h.descendantsText(node).includes('A title without the search term'))
  h.check('the real Tern client paints the content-only card whose snippet omits the literal query',
    clientContentRow !== undefined && containedXY(h.snapshot().chains, clientContentRow),
    clientContentRow === undefined ? 'content-only card absent from client tree' : h.descendantsText(clientContentRow))
  h.capture('session-browser-cards-400x600', 'global Cards include a Host-authoritative content-only hit')

  await h.resize(400, 440)
  await h.sleep(250)
  await h.key('Tab', 500)
  await h.key('Return', 900)
  const detailsOpened = await waitFrame(h, (value) => value?.page === 'details' && value?.readerBodyKey !== undefined, 'Details Reader at 400x440')
  frame = lastFrame(h)
  let snap = h.snapshot()
  const overlay = overlayNode(snap)
  const body = overlayBody(snap)
  h.check('400x440 Details replaces the Picker with one native scrolling Reader',
    detailsOpened && frame?.layout === undefined && overlay !== undefined && body !== undefined
    && frame?.readerBodyKey?.startsWith('session-browser-details-body-') === true,
    JSON.stringify({ page: frame?.page, body: frame?.readerBodyKey, overlay: overlay !== undefined, bodyNode: body !== undefined }))
  h.check('the long Reader contains the complete Host excerpt tail and the selected session identity',
    (frame?.texts ?? []).some((entry) => String(entry.text).includes('session-long'))
    && (frame?.texts ?? []).some((entry) => String(entry.text).includes('END-OF-DETAILS-TAIL')),
    `textCount=${frame?.texts?.length}`)
  h.capture('session-browser-details-top-400x440', 'long Details Reader before End-to-tail scroll')

  const beforeTail = tailPosition(h)
  h.check('the Reader tail begins below the short viewport before scrolling',
    beforeTail !== undefined && beforeTail.tailBottom - beforeTail.bodyBottom > 200,
    JSON.stringify(beforeTail))
  let tail = beforeTail
  let attempts = 0
  while (attempts < 5 && tail !== undefined && tail.tailBottom > tail.bodyBottom + 8) {
    await h.key('End', 650)
    await h.sleep(120)
    tail = tailPosition(h)
    attempts += 1
  }
  const scrollRecords = records(h).filter((entry) => entry.nativeScroll).map((entry) => entry.nativeScroll)
  h.check('End scroll reaches the actual tail inside the 400x440 Reader body',
    tail !== undefined && tail.tailBottom <= tail.bodyBottom + 8 && attempts > 0,
    JSON.stringify({ attempts, beforeTail, afterTail: tail }))
  h.check('the Reader scroll op targets this exact reading epoch/body',
    scrollRecords.length > 0 && scrollRecords.at(-1).to === 'end'
    && String(scrollRecords.at(-1).id).endsWith(String(frame?.readerBodyKey)),
    JSON.stringify({ body: frame?.readerBodyKey, scroll: scrollRecords.at(-1) }))
  h.capture('session-browser-details-tail-400x440', 'Details at the actual end tail in the short Reader viewport')

  await h.key('Escape', 900)
  const back = await waitFrame(h, (value) => value?.page === 'browse' && value?.layout === 'cards', 'Back from Details')
  frame = lastFrame(h)
  h.check('Esc at the Reader tail returns to the same global Cards, query and selected session',
    back && frame?.query === 'needle' && frame?.selected === 'session:session-long' && frame?.pickerKey === browserKey,
    JSON.stringify({ page: frame?.page, query: frame?.query, selected: frame?.selected, pickerKey: frame?.pickerKey }))
  const footerResumeIntents = records(h).filter((entry) => entry.resumeIntent)
  h.check('the real client emitted one eligible Footer Resume intent without claiming a business switch',
    footerResumeIntents.length === 1
    && footerResumeIntents[0]?.resumeIntent?.sessionId === 'session-long'
    && footerResumeIntents[0]?.resumeIntent?.currentSessionId === 'session-current'
    && footerResumeIntents[0]?.resumeIntent?.source === 'footer'
    && !records(h).some((entry) => entry.apply || entry.switchSession),
    JSON.stringify({ footerResumeIntents, businessSwitches: records(h).filter((entry) => entry.apply || entry.switchSession) }))
  h.capture('session-browser-cards-after-reader-400x440', 'Browse state after returning from the Reader tail')

  // ── S3 PR-C: the migration state through the search card and Details ──────
  // (the Tree row detail was asserted right after the All-workspaces scope).
  await h.resize(1280, 800)
  await h.sleep(250)
  // The flow's last Escape returned from Details to Cards with `needle`; this
  // one clears the query so the migration row can be found by its own title.
  await h.key('Escape', 700)
  await keyText(h, 'Legacy')
  await waitFrame(h, (value) => value?.layout === 'cards' && value?.state === 'ready', 'Legacy metadata card')
  const legacyCard = frameItems(lastFrame(h)).find((item) => item.id === 'session:session-migration')
  h.check('the metadata card for the migration-required row keeps the read-only state label',
    legacyCard !== undefined && String(legacyCard.detail).includes('Migration required'),
    JSON.stringify(legacyCard))
  await h.key('Tab', 500)
  await h.key('Return', 900)
  const migrationDetails = await waitFrame(h, (value) => value?.page === 'details', 'migration row Details')
  const migrationDetailsText = (lastFrame(h)?.texts ?? []).map((entry) => String(entry.text))
  h.check('the Details State paints the read-only migration state beside the persisted state',
    migrationDetails && migrationDetailsText.some((text) => text.includes('Migration required')),
    JSON.stringify(migrationDetailsText.filter((text) => text.includes('Migration') || text.includes('Persisted'))))
  h.capture('session-browser-migration-details-1280x800', 'Details of the migration-required Session at 1280x800')

  await h.resize(400, 600)
  await h.sleep(250)
  const narrowDetailsText = (lastFrame(h)?.texts ?? []).map((entry) => String(entry.text))
  h.check('the migration state survives a 400x600 pane without being dropped',
    narrowDetailsText.some((text) => text.includes('Migration required')),
    JSON.stringify(narrowDetailsText.filter((text) => text.includes('Migration'))))
  h.capture('session-browser-migration-details-400x600', 'Details of the migration-required Session at 400x600')

  h.measure('run totals', JSON.stringify({
    frames: frames(h).length,
    readCalls: records(h).filter((entry) => entry.read).map((entry) => entry.read.method),
    nativeScrolls: scrollRecords,
    contentOnlyCardPainted: clientContentRow !== undefined,
  }))
}
