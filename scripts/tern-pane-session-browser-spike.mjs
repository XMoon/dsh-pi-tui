/**
 * Real Tern Headless ability spike and interaction evidence for the standalone
 * Session Browser demo. Run from the repository root:
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-spike.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ancestorsOf, containedXY, rect, visibleSpan } from './tern-pane-geometry.mjs'

const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((row) => row.frame).map((row) => row.frame)
const lastFrame = (h) => frames(h).at(-1)
const choose = (h, snapshot, text) => snapshot.nodes
  .filter((node) => h.descendantsText(node).includes(text) && rect(node).every(Number.isFinite) && rect(node)[2] > 0 && rect(node)[3] > 0)
  .sort((a, b) => rect(a)[2] * rect(a)[3] - rect(b)[2] * rect(b)[3])[0]
const selectedRowNode = (h, snapshot, text) => snapshot.nodes.find((node) => {
  const classes = (node.class ?? '').split(' ')
  return classes.includes('pk-row') && classes.includes('sel') && h.descendantsText(node).includes(text)
})
const wouldResume = (h) => records(h).filter((row) => row.wouldResume)
const typeText = async (h, text) => {
  for (const key of text) await h.key(key === ' ' ? 'Space' : key, 70)
}
const tailVisible = (chains, node) => {
  if (node === undefined) return false
  const [, y, , height] = rect(node)
  const bottom = y + height
  return height > 0 && visibleSpan(chains, node, 'y') >= Math.min(8, height)
    && ancestorsOf(chains, node).every((ancestor) => {
      const [, ancestorY, , ancestorHeight] = rect(ancestor)
      return ancestorHeight === 0 || (bottom >= ancestorY - 0.5 && bottom <= ancestorY + ancestorHeight + 0.5)
    })
}
export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-session-browser-demo.mts')
  const booted = await h.launch(subject, { ready: 'DEMO ONLY' })
  h.check('the standalone demo connects inside the real Tern pane', booted)
  if (!booted) return
  await h.sleep(900)

  let snap = h.snapshot()
  let frame = lastFrame(h)
  const boot = records(h).find((row) => row.ready)?.caps
  const clientLine = readFileSync(join(h.root, 'run.log'), 'utf8').split('\n').find((line) => line.startsWith('TERN '))
  h.measure('client and advertised picker capabilities', JSON.stringify({ tern: clientLine, kinds: boot?.kinds, features: boot?.features, viewport: h.ctl('stats').viewport }))
  h.check('the rendered title makes DEMO ONLY visible', h.has(snap, 'DEMO ONLY'), h.texts(snap).join(' | '))
  h.check('the baseline tree has the full synthetic roster and at least four workspaces',
    frame?.mainCount === 55 && frame.workspaceCount >= 4 && frame.ids.length >= 8, JSON.stringify(frame))
  h.check('Current remains independent from the selected row in the workspace tree',
    frame?.layout === 'tree' && frame.scope === 'workspace' && frame.selectedId === 'session-fork-b0000002'
    && frame.ids.includes('session-current-a0000001'), JSON.stringify(frame))
  h.check('subagent rows are excluded from the browser projection',
    !frame?.ids.some((id) => id.includes('subagent-')), JSON.stringify(frame?.ids))
  const depthById = Object.fromEntries(frame?.depths?.map((item) => [item.id, item.depth]) ?? [])
  h.check('the fork chain reaches depth two while orphan and cycle degrade to roots',
    depthById['session-current-a0000001'] === 0 && depthById['session-fork-b0000002'] === 1
    && depthById['session-rewind-c0000003'] === 2 && depthById['session-orphan-i0000009'] === 0
    && depthById['session-cycle-j0000010'] === 0, JSON.stringify(depthById))
  h.check('tree order keeps a parent before its newer child',
    frame?.ids.indexOf('session-fork-b0000002') >= 0
    && frame.ids.indexOf('session-rewind-c0000003') > frame.ids.indexOf('session-fork-b0000002'),
    JSON.stringify({ ids: frame?.ids, parent: 'session-fork-b0000002', newerChild: 'session-rewind-c0000003' }))
  h.measure('native picker classes and visible scope labels', JSON.stringify({
    classes: [...new Set(snap.nodes.flatMap((node) => (node.class ?? '').split(' ').filter(Boolean)))].filter((name) => name.includes('pk-')),
    scopes: h.texts(snap).filter((text) => text.includes('workspace')),
    rows: snap.nodes.filter((node) => node.tag === 'button').map((node) => h.descendantsText(node)),
  }))
  h.capture('wide-1280x800-browse', 'tree browse, Current differs from selected')
  const initialPickerId = frame?.pickerId
  await h.key('F5', 250)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('the metadata-pending state keeps roster identities but withholds title and preset enrichment',
    frame?.metadataReady === false && frame.ids.length >= 8 && frame.pickerId === initialPickerId
    && h.has(snap, 'fork-b00') && !h.has(snap, 'Review API retry strategy'), JSON.stringify(frame))
  h.capture('metadata-pending', 'synthetic roster before title and preset enrichment')
  await h.key('F5', 250)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('metadata enrichment restores the same picker identity and visible title',
    frame?.metadataReady === true && frame.pickerId === initialPickerId && h.has(snap, 'Review API retry strategy'), JSON.stringify(frame))
  h.capture('metadata-enriched', 'same Picker after synthetic metadata arrives')

  const rootRow = choose(h, snap, 'Fix API timeout')
  const childRow = choose(h, snap, 'Review API retry strategy')
  const grandchildRow = choose(h, snap, 'Follow-up: retry budget and backoff')
  const indent = (node) => node === undefined ? null : Math.round(rect(node)[0])
  const rootX = indent(rootRow)
  const childX = indent(childRow)
  const grandchildX = indent(grandchildRow)
  h.check('the client paints three visible lineage labels with progressively deeper indentation',
    rootRow !== undefined && childRow !== undefined && grandchildRow !== undefined
    && containedXY(snap.chains, rootRow) && containedXY(snap.chains, childRow) && containedXY(snap.chains, grandchildRow)
    && childX - rootX >= 8 && grandchildX - childX >= 8,
    JSON.stringify({ root: rootRow && h.descendantsText(rootRow), child: childRow && h.descendantsText(childRow), grandchild: grandchildRow && h.descendantsText(grandchildRow), x: [rootX, childX, grandchildX] }))
  h.measure('client row nesting geometry', JSON.stringify({ root: rootX, child: childX, grandchild: grandchildX }))

  const beforeForgedEvents = wouldResume(h).length
  await h.key('F2', 250)
  await h.key('F3', 250)
  const admissionRecords = records(h)
  h.check('stale action token and wrong session ID are rejected before any simulated Resume',
    admissionRecords.some((row) => row.control === 'stale-action')
    && admissionRecords.some((row) => row.rejected === 'stale-or-wrong-page')
    && admissionRecords.some((row) => row.control === 'wrong-session-id')
    && admissionRecords.some((row) => row.rejected === 'not-a-visible-session' && row.item === 'session-never-offered')
    && wouldResume(h).length === beforeForgedEvents,
    JSON.stringify(admissionRecords.filter((row) => row.control || row.rejected)))

  const scopeTarget = choose(h, snap, 'All workspaces')
  const scopeClicked = scopeTarget === undefined ? false : await h.click(snap.chains, scopeTarget)
  frame = lastFrame(h)
  h.check('a real pointer click on All workspaces reveals every main session in five workspaces',
    scopeClicked && frame?.scope === 'all' && frame.mainCount === 55 && frame.workspaceCount >= 4 && frame.ids.length === 55
    && !frame.ids.some((id) => id.includes('subagent-')), `clicked=${scopeClicked} :: ${JSON.stringify(frame)}`)
  h.capture('wide-all-workspaces', 'all five workspace groups and 55 main sessions')

  await h.key('Home', 250)
  for (let index = 0; index < 25; index += 1) await h.key('Down', 100)
  frame = lastFrame(h)
  snap = h.snapshot()
  const middleSelected = frame?.selectedTitle === null ? undefined : selectedRowNode(h, snap, frame?.selectedTitle)
  h.check('Down moves the visible selection into the middle of the grouped 55-row tree',
    frame?.scope === 'all' && frame.selectedIndex === 25 && frame.selectedId === frame.ids[25]
    && middleSelected !== undefined && containedXY(snap.chains, middleSelected) && frame.pickerId === initialPickerId,
    JSON.stringify({ frame, selectedRow: middleSelected && { text: h.descendantsText(middleSelected), rect: rect(middleSelected) } }))
  h.capture('all-workspaces-middle', 'keyboard selection and scroll in the middle of the full roster')

  await h.key('End', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  const finalSelected = frame?.selectedTitle === null ? undefined : selectedRowNode(h, snap, frame?.selectedTitle)
  h.check('End reaches and paints the last grouped session in the full roster',
    frame?.selectedIndex === 54 && frame.selectedId === frame.ids.at(-1)
    && finalSelected !== undefined && containedXY(snap.chains, finalSelected),
    JSON.stringify({ id: frame?.selectedId, count: frame?.ids.length, row: finalSelected && { text: h.descendantsText(finalSelected), rect: rect(finalSelected) } }))
  h.capture('all-workspaces-last-row', 'last ordered session remains visible after End')

  const thisWorkspace = choose(h, snap, 'This workspace')
  const workspaceClicked = thisWorkspace === undefined ? false : await h.click(snap.chains, thisWorkspace)
  frame = lastFrame(h)
  h.check('the inverse native scope click restores the workspace-only roster and repairs an out-of-scope selection',
    workspaceClicked && frame?.scope === 'workspace' && frame.mainCount === 55 && frame.ids.length >= 8
    && frame.selectedId === 'session-current-a0000001' && !frame.ids.some((id) => id.includes('linux-') || id.includes('title-f') || id.includes('content-g') || id.includes('both-h')),
    `clicked=${workspaceClicked} :: ${JSON.stringify(frame)}`)

  for (let index = 0; index < 5; index += 1) await h.key('Down', 100)
  frame = lastFrame(h)
  snap = h.snapshot()
  let selectionBeforeSearch = frame?.selectedId
  const workspaceMid = frame?.selectedTitle === null ? undefined : selectedRowNode(h, snap, frame?.selectedTitle)
  h.check('the same Picker keeps a reachable non-first selection in workspace scope',
    frame?.scope === 'workspace' && frame.selectedIndex === 5 && frame.selectedId === frame.ids[5]
    && workspaceMid !== undefined && containedXY(snap.chains, workspaceMid) && frame.pickerId === initialPickerId,
    JSON.stringify({ frame, row: workspaceMid && { text: h.descendantsText(workspaceMid), rect: rect(workspaceMid) } }))
  h.capture('workspace-middle', 'pre-search selection to restore after layout change')

  await h.resize(700, 600)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('browse resize to split preserves scope, selection, and Picker identity',
    frame?.scope === 'workspace' && frame.selectedId === selectionBeforeSearch && frame.pickerId === initialPickerId, JSON.stringify(frame))
  const splitButtons = snap.nodes.filter((node) => node.tag === 'button' && ['Close', 'Details', 'Resume'].some((label) => h.descendantsText(node).includes(label)))
  h.check('the split viewport keeps all three native footer actions visible',
    splitButtons.length === 3 && splitButtons.every((node) => containedXY(snap.chains, node)),
    JSON.stringify(splitButtons.map((node) => ({ text: h.descendantsText(node), rect: rect(node), contained: containedXY(snap.chains, node) }))))
  const splitActionX = ['Close', 'Details', 'Resume'].map((label) => {
    const button = splitButtons.find((node) => h.descendantsText(node).trim().startsWith(label))
    return button === undefined ? null : rect(button)[0]
  })
  h.check('the native footer presents Close, Details, Resume in the planned order',
    splitActionX.every((x) => x !== null) && splitActionX[0] < splitActionX[1] && splitActionX[1] < splitActionX[2], JSON.stringify(splitActionX))
  h.capture('split-700x600-browse', 'footer and scope at common split width')
  const splitDetails = splitButtons.find((node) => h.descendantsText(node).trim().startsWith('Details'))
  const splitDetailsClicked = splitDetails === undefined ? false : await h.click(snap.chains, splitDetails)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('a real 700x600 footer Details click opens the selected row without a third page',
    splitDetailsClicked && frame?.page === 'details' && frame.selectedId === selectionBeforeSearch
    && !snap.nodes.some((node) => node.tag === 'button' && h.descendantsText(node).includes('Resume')),
    `clicked=${splitDetailsClicked} :: ${JSON.stringify(frame)}`)
  h.check('browse Details omits content that was not matched by a search',
    frame?.page === 'details' && !h.has(snap, 'Search excerpt (synthetic Host mock)'), JSON.stringify(frame))
  h.capture('split-700x600-details', 'real footer click opens read-only Details')
  const splitBack = choose(h, snap, 'Back to sessions')
  const splitBackClicked = splitBack === undefined ? false : await h.click(snap.chains, splitBack)
  frame = lastFrame(h)
  h.check('pointer Back at split width restores the same workspace selection',
    splitBackClicked && frame?.page === 'browser' && frame.selectedId === selectionBeforeSearch && frame.pickerId === initialPickerId,
    `clicked=${splitBackClicked} :: ${JSON.stringify(frame)}`)
  snap = h.snapshot()
  const splitResumeButton = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith('Resume'))
  const beforeSplitResume = wouldResume(h).length
  const splitResumeClicked = splitResumeButton === undefined ? false : await h.click(snap.chains, splitResumeButton)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('a second real 700x600 footer click records exactly one local Resume',
    splitResumeClicked && wouldResume(h).length === beforeSplitResume + 1
    && wouldResume(h).at(-1)?.wouldResume === selectionBeforeSearch
    && wouldResume(h).at(-1)?.source === 'footer-action'
    && frame?.selectedId === selectionBeforeSearch && frame.resumeNoticeId === selectionBeforeSearch
    && h.has(snap, 'Current') && h.has(snap, 'Would resume'),
    `clicked=${splitResumeClicked} :: ${JSON.stringify(frame)} :: ${JSON.stringify(wouldResume(h).slice(beforeSplitResume))}`)

  await h.resize(400, 600)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('narrow browse resize preserves the same scope and selected session',
    frame?.scope === 'workspace' && frame.selectedId === selectionBeforeSearch && frame.pickerId === initialPickerId, JSON.stringify(frame))
  const narrowButtons = snap.nodes.filter((node) => node.tag === 'button' && ['Close', 'Details', 'Resume'].some((label) => h.descendantsText(node).includes(label)))
  h.check('the narrow viewport keeps the Resume action in a visible hit target',
    narrowButtons.some((node) => h.descendantsText(node).includes('Resume') && containedXY(snap.chains, node)),
    JSON.stringify(narrowButtons.map((node) => ({ text: h.descendantsText(node), rect: rect(node), contained: containedXY(snap.chains, node) }))))
  h.capture('narrow-400x600-browse', 'narrow browse and footer')
  const narrowScopeTrigger = choose(h, snap, 'This workspace')
  const narrowScopeOpened = narrowScopeTrigger === undefined ? false : await h.click(snap.chains, narrowScopeTrigger)
  frame = lastFrame(h)
  snap = h.snapshot()
  const allScopeOption = choose(h, snap, 'All workspaces')
  h.check('the narrow scope control opens an All workspaces choice without changing the current scope',
    narrowScopeOpened && frame?.scope === 'workspace' && allScopeOption !== undefined,
    JSON.stringify({ clicked: narrowScopeOpened, frame, option: allScopeOption && rect(allScopeOption) }))
  const allScopeClicked = allScopeOption === undefined ? false : await h.click(snap.chains, allScopeOption)
  frame = lastFrame(h)
  h.check('the narrow scope choice reaches all 55 main sessions without changing Picker identity',
    allScopeClicked && frame?.scope === 'all' && frame.ids.length === 55 && frame.pickerId === initialPickerId, JSON.stringify(frame))
  snap = h.snapshot()
  const allScopeTrigger = choose(h, snap, 'All workspaces')
  const allScopeMenuOpened = allScopeTrigger === undefined ? false : await h.click(snap.chains, allScopeTrigger)
  frame = lastFrame(h)
  snap = h.snapshot()
  const workspaceScopeOption = choose(h, snap, 'This workspace')
  h.check('the All workspaces menu exposes a visible This workspace choice',
    allScopeMenuOpened && frame?.scope === 'all' && workspaceScopeOption !== undefined
    && containedXY(snap.chains, workspaceScopeOption),
    JSON.stringify({ clicked: allScopeMenuOpened, frame, option: workspaceScopeOption && rect(workspaceScopeOption) }))
  h.capture('narrow-scope-all-menu', 'All workspaces is selected and This workspace is visibly available')
  const workspaceScopeClicked = workspaceScopeOption === undefined ? false : await h.click(snap.chains, workspaceScopeOption)
  frame = lastFrame(h)
  h.check('the narrow scope choice returns to the same workspace selection',
    workspaceScopeClicked && frame?.scope === 'workspace' && frame.selectedId === selectionBeforeSearch && frame.pickerId === initialPickerId,
    JSON.stringify(frame))
  h.capture('narrow-scope-restored', 'narrow scope control returns to the original workspace')

  await typeText(h, 'timeout')
  snap = h.snapshot()
  frame = lastFrame(h)
  const contentOnlyId = 'session-content-g0000007'
  const contentOnlyNode = choose(h, snap, 'worker log · connection timeout observed')
  const contentSource = frame?.searchSources?.find((hit) => hit.id === contentOnlyId)
  const metadataSource = frame?.searchSources?.find((hit) => hit.id === 'session-title-f0000006')
  const combinedSource = frame?.searchSources?.find((hit) => hit.id === 'session-both-h0000008')
  const contentRect = contentOnlyNode === undefined ? [0, 0, 0, 0] : rect(contentOnlyNode)
  const contentReadable = contentOnlyNode !== undefined && containedXY(snap.chains, contentOnlyNode)
    && visibleSpan(snap.chains, contentOnlyNode, 'y') >= Math.min(8, contentRect[3])
  h.check('typing a content query switches the same native Picker to global cards',
    frame?.layout === 'cards' && frame.query === 'timeout' && frame.scope === 'all'
    && frame.selectedId === contentOnlyId && frame.pickerId === initialPickerId, JSON.stringify(frame))
  const queryControl = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-search'))
  const scopeRegion = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-scopes'))
  const searchTitle = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-title'))
  h.check('narrow search keeps a contained query control and the DEMO ONLY title while hiding scopes',
    queryControl !== undefined && containedXY(snap.chains, queryControl) && scopeRegion === undefined
    && searchTitle !== undefined && h.descendantsText(searchTitle).includes('DEMO ONLY')
    && h.has(snap, 'Global · Content matches') && h.has(snap, 'docs/research'),
    JSON.stringify({ query: queryControl && { text: h.descendantsText(queryControl), rect: rect(queryControl), contained: containedXY(snap.chains, queryControl) }, scopes: scopeRegion && rect(scopeRegion), title: searchTitle && h.descendantsText(searchTitle) }))
  h.check('content-only result is visible and comes from a different workspace',
    frame?.ids.includes(contentOnlyId) && contentSource?.source === 'Content' && contentSource.cwd !== '/demo/app/backend/研发团队🚀/service-with-a-deliberately-long-synthetic-name'
    && contentReadable,
    `ids=${JSON.stringify(frame?.ids)} :: source=${JSON.stringify(contentSource)} :: text=${contentOnlyNode === undefined ? 'not in tree' : h.descendantsText(contentOnlyNode)} :: rect=${JSON.stringify(contentRect)} :: visibleY=${contentOnlyNode === undefined ? 0 : visibleSpan(snap.chains, contentOnlyNode, 'y')}`)
  h.check('the metadata-only control has no matching content excerpt',
    frame?.ids.includes('session-title-f0000006') && metadataSource?.source === 'Metadata', JSON.stringify(metadataSource))
  h.check('the combined control is classified as both metadata and content',
    frame?.ids.includes('session-both-h0000008') && combinedSource?.source === 'Both', JSON.stringify(combinedSource))
  h.capture('global-search-400x600', 'visible content-only, metadata-only and combined synthetic matches')
  await h.resize(700, 600)
  frame = lastFrame(h)
  h.check('resize preserves the in-progress global query, current result, and Picker identity',
    frame?.query === 'timeout' && frame.selectedId === contentOnlyId && frame.pickerId === initialPickerId,
    JSON.stringify(frame))
  h.capture('global-search-resize-700x600', 'same query and native Picker after resize')
  await h.resize(400, 600)
  frame = lastFrame(h)
  h.check('returning to the narrow viewport still preserves query and current result',
    frame?.query === 'timeout' && frame.selectedId === contentOnlyId && frame.pickerId === initialPickerId,
    JSON.stringify(frame))
  await h.key('Down', 250)
  frame = lastFrame(h)
  snap = h.snapshot()
  const metadataOnlyCard = choose(h, snap, 'Connection timeout in worker pool')
  h.check('keyboard can select the metadata-only result for Details',
    frame?.selectedId === 'session-title-f0000006' && metadataOnlyCard !== undefined
    && containedXY(snap.chains, metadataOnlyCard), JSON.stringify(frame))
  const metadataDetailsButton = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith('Details'))
  const metadataDetailsClicked = metadataDetailsButton === undefined ? false : await h.click(snap.chains, metadataDetailsButton)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('Details omits content when the current result matched metadata only',
    metadataDetailsClicked && frame?.page === 'details' && frame.selectedId === 'session-title-f0000006'
    && !h.has(snap, 'Search excerpt (synthetic Host mock)'), JSON.stringify(frame))
  await h.key('Escape', 400)
  frame = lastFrame(h)
  h.check('Back from metadata-only Details preserves the query and selected result',
    frame?.page === 'browser' && frame.query === 'timeout' && frame.selectedId === 'session-title-f0000006', JSON.stringify(frame))

  await h.key('Escape', 500)
  frame = lastFrame(h)
  h.check('clearing search restores the previous browse scope and selected session',
    frame?.layout === 'tree' && frame.scope === 'workspace' && frame.selectedId === selectionBeforeSearch, JSON.stringify(frame))
  await h.resize(700, 600)
  await typeText(h, 'connection timeout')
  frame = lastFrame(h)
  snap = h.snapshot()
  const exactPhraseHit = frame?.searchSources?.find((hit) => hit.id === contentOnlyId)
  const exactPhraseCard = choose(h, snap, 'worker log · connection timeout observed')
  const exactPhraseInput = snap.nodes.find((node) => (node.class ?? '').split(' ').includes('pk-search'))
  h.check('the plan query connection timeout returns a visible content-only Host mock match',
    frame?.query === 'connection timeout' && frame.scope === 'all' && frame.layout === 'cards'
    && frame.ids.includes(contentOnlyId) && exactPhraseHit?.source === 'Content'
    && exactPhraseCard !== undefined && containedXY(snap.chains, exactPhraseCard)
    && exactPhraseInput !== undefined && h.descendantsText(exactPhraseInput).includes('connection timeout')
    && h.has(snap, 'Global · Content matches'),
    JSON.stringify({ frame, input: exactPhraseInput && h.descendantsText(exactPhraseInput), card: exactPhraseCard && h.descendantsText(exactPhraseCard) }))
  h.capture('global-search-connection-timeout-700x600', 'plan query visible at medium width with its content-only other-workspace hit')
  await h.key('Escape', 500)
  frame = lastFrame(h)
  h.check('clearing the exact plan query restores the same browse selection',
    frame?.layout === 'tree' && frame.scope === 'workspace' && frame.selectedId === selectionBeforeSearch, JSON.stringify(frame))
  await h.resize(400, 600)
  frame = lastFrame(h)
  h.check('returning to narrow browse after the exact query keeps workspace selection',
    frame?.scope === 'workspace' && frame.selectedId === selectionBeforeSearch, JSON.stringify(frame))

  await typeText(h, 'worker log')
  frame = lastFrame(h)
  snap = h.snapshot()
  const crossWorkspaceHit = frame?.searchSources?.find((hit) => hit.id === 'session-content-g0000007')
  const crossWorkspaceCard = choose(h, snap, 'Notes from the nightly run')
  h.check('a content-only phrase absent from This workspace still finds the other workspace globally',
    frame?.query === 'worker log' && frame.scope === 'all' && frame.layout === 'cards'
    && frame.ids.length === 1 && frame.selectedId === 'session-content-g0000007'
    && crossWorkspaceHit?.source === 'Content' && crossWorkspaceHit.cwd === '/demo/docs/research'
    && crossWorkspaceCard !== undefined && containedXY(snap.chains, crossWorkspaceCard)
    && h.has(snap, 'Global · Content matches') && h.has(snap, 'docs/research'),
    JSON.stringify({ frame, card: crossWorkspaceCard && h.descendantsText(crossWorkspaceCard) }))
  h.capture('global-content-only-other-workspace', 'global query from workspace scope returns one content-only result with its cwd')
  const contentDetailsButton = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith('Details'))
  const contentDetailsClicked = contentDetailsButton === undefined ? false : await h.click(snap.chains, contentDetailsButton)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('Details carries the bounded excerpt for this actual content search hit',
    contentDetailsClicked && frame?.page === 'details' && frame.selectedId === 'session-content-g0000007'
    && h.has(snap, 'Search excerpt (synthetic Host mock)')
    && h.has(snap, 'worker log · connection timeout observed in a synthetic Host excerpt.'), JSON.stringify(frame))
  await h.key('Escape', 400)
  frame = lastFrame(h)
  h.check('Back from content-hit Details preserves the global query and result',
    frame?.page === 'browser' && frame.query === 'worker log' && frame.selectedId === 'session-content-g0000007', JSON.stringify(frame))
  await h.key('Escape', 500)
  frame = lastFrame(h)
  h.check('clearing the cross-workspace query restores the prior browse scope and selected row',
    frame?.scope === 'workspace' && frame.selectedId === selectionBeforeSearch, JSON.stringify(frame))

  await typeText(h, 'nohit')
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('no-match search produces the native empty result with no selected item',
    frame?.layout === 'cards' && frame.query === 'nohit' && frame.ids.length === 0
    && frame.selectedId === null && frame.total === 0 && h.has(snap, 'No sessions match') && h.has(snap, 'nohit'), JSON.stringify(frame))
  h.capture('search-no-match', 'global query with no synthetic results')
  const rejectionStart = records(h).filter((row) => row.rejected === 'disabled-keyboard-action').length
  const resumeCountBeforeNoMatch = wouldResume(h).length
  await h.key('Tab', 200)
  await h.key('Return', 200)
  await h.key('Left', 200)
  await h.key('Return', 200)
  const noMatchRejections = records(h).filter((row) => row.rejected === 'disabled-keyboard-action').slice(rejectionStart)
  h.check('no-match Details and Resume remain disabled at the live action cursor',
    noMatchRejections.some((row) => row.action === 'resume') && noMatchRejections.some((row) => row.action === 'details')
    && wouldResume(h).length === resumeCountBeforeNoMatch, JSON.stringify(noMatchRejections))
  await h.key('Escape', 400)
  frame = lastFrame(h)
  h.check('clearing no-match search still restores scope and selection',
    frame?.scope === 'workspace' && frame.selectedId === selectionBeforeSearch, JSON.stringify(frame))

  const beforeMouse = wouldResume(h).length
  snap = h.snapshot()
  const persistRow = choose(h, snap, 'Persist session')
  const selectedByMouse = persistRow === undefined ? false : await h.click(snap.chains, persistRow)
  frame = lastFrame(h)
  h.check('mouse-select only highlights the clicked session and returns focus to list',
    selectedByMouse && frame?.selectedId === 'session-persist-d0000004' && frame.zone === 'list' && wouldResume(h).length === beforeMouse,
    `clicked=${selectedByMouse} :: ${JSON.stringify(frame)} :: wouldResume=${wouldResume(h).length}`)
  await h.key('Return', 500)
  snap = h.snapshot()
  const localResumeNotice = choose(h, snap, 'Would resume')
  h.check('Enter after mouse selection records exactly one wouldResume and paints its local notice',
    wouldResume(h).length === beforeMouse + 1 && wouldResume(h).at(-1)?.wouldResume === 'session-persist-d0000004'
    && lastFrame(h)?.resumeNoticeId === 'session-persist-d0000004' && h.has(snap, 'Would resume')
    && localResumeNotice !== undefined && containedXY(snap.chains, localResumeNotice),
    JSON.stringify({ frame: lastFrame(h), notice: localResumeNotice && { text: h.descendantsText(localResumeNotice), rect: rect(localResumeNotice) } }))
  h.capture('would-resume-local', 'demo-only badge after list Enter; no session transition')
  h.check('simulated Resume never changes the fixed Current identity', lastFrame(h)?.selectedId === 'session-persist-d0000004'
    && records(h).filter((row) => row.wouldResume).every((row) => row.count === 1), JSON.stringify(lastFrame(h)))

  const beforeFooterResume = wouldResume(h).length
  snap = h.snapshot()
  const resumeButton = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith('Resume'))
  const footerClicked = resumeButton === undefined ? false : await h.click(snap.chains, resumeButton)
  snap = h.snapshot()
  h.check('the visible native Resume hit target records one footer-only wouldResume notice',
    footerClicked && wouldResume(h).length === beforeFooterResume + 1 && wouldResume(h).at(-1)?.wouldResume === 'session-persist-d0000004'
    && wouldResume(h).at(-1)?.source === 'footer-action' && lastFrame(h)?.resumeNoticeId === 'session-persist-d0000004'
    && h.has(snap, 'Would resume'),
    `clicked=${footerClicked} :: ${JSON.stringify(resumeButton && { text: h.descendantsText(resumeButton), rect: rect(resumeButton) })} :: ${JSON.stringify(wouldResume(h).slice(beforeFooterResume))}`)

  await h.key('End', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  const narrowLastRow = frame?.selectedTitle === null ? undefined : selectedRowNode(h, snap, frame?.selectedTitle)
  h.check('End scrolls the narrow Browser to its last workspace row without hiding the footer',
    frame?.selectedIndex === frame.ids.length - 1 && frame.selectedId === frame.ids.at(-1)
    && narrowLastRow !== undefined && containedXY(snap.chains, narrowLastRow)
    && ['Close', 'Details', 'Resume'].every((label) => snap.nodes.some((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith(label) && containedXY(snap.chains, node))),
    JSON.stringify({ frame, lastRow: narrowLastRow && { text: h.descendantsText(narrowLastRow), rect: rect(narrowLastRow) } }))
  h.capture('narrow-400x600-end', 'End reaches the final row while native footer remains visible')
  await h.key('Home', 300)
  await h.key('Tab', 250)
  await h.key('Tab', 250)
  const beforeCurrent = wouldResume(h).length
  snap = h.snapshot()
  const disabledResume = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith('Resume'))
  const disabledClick = disabledResume === undefined ? false : await h.click(snap.chains, disabledResume)
  await h.key('Return', 500)
  const currentGuardRecords = records(h)
  h.check('Current footer click and focused Enter cannot record wouldResume',
    disabledClick && lastFrame(h)?.selectedId === 'session-current-a0000001' && lastFrame(h)?.zone === 'actions'
    && wouldResume(h).length === beforeCurrent && currentGuardRecords.some((row) => row.rejected === 'disabled-keyboard-action' && row.action === 'resume'),
    `clicked=${disabledClick} :: ${JSON.stringify(disabledResume && { text: h.descendantsText(disabledResume), rect: rect(disabledResume) })} :: ${JSON.stringify(currentGuardRecords.filter((row) => row.rejected))}`)
  snap = h.snapshot()
  h.capture('current-resume-disabled', 'Current badge with disabled Resume footer and negative control')

  await h.key('Tab', 250)
  await h.key('Return', 500)
  h.check('Current also fails the direct list-Enter simulation guard',
    wouldResume(h).length === beforeCurrent && records(h).some((row) => row.rejected === 'would-resume' && row.reason === 'already-current'), JSON.stringify(records(h).filter((row) => row.rejected)))

  await h.resize(1280, 800)
  await h.key('Down', 250)
  await h.key('Tab', 250)
  await h.key('Tab', 250)
  await h.key('Left', 250)
  await h.key('Return', 700)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('Details replaces the picker instead of opening a third page', frame?.page === 'details' && !snap.nodes.some((node) => node.tag === 'button' && h.descendantsText(node).includes('Resume')), JSON.stringify(frame))
  h.check('browse Details for a row with stored mock content still omits Search excerpt',
    frame?.selectedId === 'session-fork-b0000002' && frame.query === ''
    && !h.has(snap, 'Search excerpt (synthetic Host mock)'), JSON.stringify(frame))
  h.capture('details-1280x800', 'browse Details omits content without a current search hit')
  const beforeDetailResume = wouldResume(h).length
  await h.key('F4', 250)
  let detailsGuardRecords = records(h)
  h.check('a Details-page Resume action is rejected at the current reader node',
    detailsGuardRecords.some((row) => row.control === 'details-page-resume')
    && detailsGuardRecords.some((row) => row.rejected === 'stale-or-wrong-page')
    && wouldResume(h).length === beforeDetailResume && lastFrame(h)?.page === 'details',
    JSON.stringify(detailsGuardRecords.filter((row) => row.control === 'details-page-resume' || row.rejected === 'stale-or-wrong-page')))

  const firstReaderEpoch = frame?.readerEpoch
  const firstReaderId = frame?.readerId
  const back = choose(h, snap, 'Back to sessions')
  const backClicked = back === undefined ? false : await h.click(snap.chains, back)
  frame = lastFrame(h)
  h.check('a real pointer click on the native Back row returns to the same selection',
    backClicked && frame?.page === 'browser' && frame?.selectedId === 'session-fork-b0000002',
    `clicked=${backClicked} :: ${JSON.stringify(frame)}`)

  await h.key('Tab', 250)
  await h.key('Tab', 250)
  frame = lastFrame(h)
  snap = h.snapshot()
  const focusedDetails = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).trim().startsWith('Details'))
  h.check('Back leaves keyboard focus on Details, not Close',
    frame?.page === 'browser' && frame.zone === 'actions' && frame.actionCursor === 1
    && focusedDetails !== undefined && h.descendantsText(focusedDetails).includes('[Enter]'),
    JSON.stringify({ frame, detailsAction: focusedDetails && h.descendantsText(focusedDetails) }))
  await h.key('Tab', 200)
  await typeText(h, 'Host-mock long excerpt:')
  frame = lastFrame(h)
  h.check('long Details scrolling starts from a real content hit rather than browse content',
    frame?.query === 'Host-mock long excerpt:' && frame.selectedId === 'session-fork-b0000002'
    && frame.searchSources.some((hit) => hit.id === frame.selectedId && hit.source === 'Content'), JSON.stringify(frame))
  await h.key('Tab', 200)
  await h.key('Return', 700)
  frame = lastFrame(h)
  h.check('the scroll test uses a new Reader node and epoch after the pointer Back control',
    frame?.page === 'details' && frame.selectedId === 'session-fork-b0000002'
    && frame.readerEpoch > firstReaderEpoch && frame.readerId !== firstReaderId, JSON.stringify(frame))
  const secondReaderEpoch = frame?.readerEpoch
  const secondReaderId = frame?.readerId
  await h.key('F4', 250)
  detailsGuardRecords = records(h)
  h.check('the Details-page action negative control still cannot resume',
    detailsGuardRecords.filter((row) => row.control === 'details-page-resume').length >= 2
    && wouldResume(h).length === beforeDetailResume && lastFrame(h)?.page === 'details',
    JSON.stringify(detailsGuardRecords.filter((row) => row.control === 'details-page-resume')))

  await h.resize(400, 440)
  snap = h.snapshot()
  const excerptNodeBefore = choose(h, snap, 'Host-mock long excerpt:')
  const excerptTailWasVisible = tailVisible(snap.chains, excerptNodeBefore)
  h.check('the long synthetic excerpt extends below the short Details viewport before End',
    excerptNodeBefore !== undefined && !excerptTailWasVisible,
    JSON.stringify({ rect: excerptNodeBefore && rect(excerptNodeBefore), visibleY: excerptNodeBefore && visibleSpan(snap.chains, excerptNodeBefore, 'y'), tailVisible: excerptTailWasVisible }))
  h.capture('details-short-400x440-before-end', 'long Details body before the real End key')
  await h.key('End', 500)
  const scrollRecords = records(h).filter((row) => row.readerScroll)
  snap = h.snapshot()
  const identityTail = choose(h, snap, 'Read-only identity confirmation')
  const excerptNode = choose(h, snap, 'Host-mock long excerpt:')
  h.check('End makes the long excerpt tail and final identity readable through negotiated scrolling',
    boot?.features?.includes('scroll') && scrollRecords.at(-1)?.readerScroll === 'end'
    && scrollRecords.at(-1)?.readerId === secondReaderId && scrollRecords.at(-1)?.epoch === secondReaderEpoch
    && tailVisible(snap.chains, excerptNode) && tailVisible(snap.chains, identityTail),
    `caps=${JSON.stringify(boot?.features)} :: scroll=${JSON.stringify(scrollRecords.at(-1))} :: excerpt=${JSON.stringify(excerptNode && { rect: rect(excerptNode), visibleY: visibleSpan(snap.chains, excerptNode, 'y'), tailVisible: tailVisible(snap.chains, excerptNode) })} :: identity=${JSON.stringify(identityTail && { rect: rect(identityTail), visibleY: visibleSpan(snap.chains, identityTail, 'y'), tailVisible: tailVisible(snap.chains, identityTail) })}`)
  h.capture('details-tail-400x440', 'after real End key and negotiated SDK scroll op')
  const backAtTail = choose(h, snap, 'Back to sessions')
  h.measure('Back row placement after scrolling', JSON.stringify({ rect: backAtTail && rect(backAtTail), visibleY: backAtTail && visibleSpan(snap.chains, backAtTail, 'y'), fullyContained: backAtTail !== undefined && containedXY(snap.chains, backAtTail) }))
  await h.key('Escape', 500)
  frame = lastFrame(h)
  const staleControlsBeforeAliveKey = records(h).filter((row) => row.control === 'stale-action').length
  await h.key('F2', 250)
  h.check('Escape from Details creates a new Browser frame and leaves the Tern pane running',
    frame?.page === 'browser' && frame.selectedId === 'session-fork-b0000002' && frame.readerEpoch === secondReaderEpoch
    && lastFrame(h)?.page === 'browser' && records(h).filter((row) => row.control === 'stale-action').length === staleControlsBeforeAliveKey + 1,
    JSON.stringify({ afterEscape: frame, final: lastFrame(h) }))
  await h.key('Escape', 400)
  h.check('clearing the long-excerpt query returns to browse without carrying a snippet',
    lastFrame(h)?.query === '' && lastFrame(h)?.scope === 'workspace'
    && lastFrame(h)?.selectedId === 'session-fork-b0000002', JSON.stringify(lastFrame(h)))

  const beforeScenarioResume = wouldResume(h).length
  await h.resize(400, 600)
  await h.key('F1', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  const loadingState = snap.nodes.some((node) => {
    const classes = (node.class ?? '').split(' ')
    return classes.includes('pk-state') && classes.includes('loading')
  })
  h.check('F1 exposes the native loading skeleton without roster rows',
    frame?.scenario === 'loading' && frame.phase === 'loading' && frame.ids.length === 0
    && frame.selectedId === null && loadingState, JSON.stringify({ frame, loadingState }))
  h.capture('scenario-loading', 'loading state with Resume and Details disabled')
  const loadingRejectStart = records(h).filter((row) => row.rejected === 'disabled-keyboard-action').length
  await h.key('Tab', 200)
  await h.key('Tab', 200)
  await h.key('Return', 200)
  const loadingRejection = records(h).filter((row) => row.rejected === 'disabled-keyboard-action').slice(loadingRejectStart)
  h.check('Resume cannot be activated while the synthetic roster is loading',
    loadingRejection.some((row) => row.action === 'resume') && wouldResume(h).length === beforeScenarioResume, JSON.stringify(loadingRejection))

  await h.key('F1', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('F1 exposes a fail-closed listing error without session rows',
    frame?.scenario === 'error' && frame.phase === 'error' && frame.ids.length === 0
    && frame.selectedId === null && h.has(snap, 'Synthetic roster unavailable'), JSON.stringify(frame))
  h.capture('scenario-error', 'synthetic listing failure with actions disabled')
  const errorRejectStart = records(h).filter((row) => row.rejected === 'disabled-keyboard-action').length
  await h.key('Tab', 200)
  await h.key('Tab', 200)
  await h.key('Return', 200)
  await h.key('Left', 200)
  await h.key('Return', 200)
  const errorRejections = records(h).filter((row) => row.rejected === 'disabled-keyboard-action').slice(errorRejectStart)
  h.check('Details and Resume cannot be activated after the listing error',
    errorRejections.some((row) => row.action === 'resume') && errorRejections.some((row) => row.action === 'details')
    && wouldResume(h).length === beforeScenarioResume, JSON.stringify(errorRejections))

  await h.key('F1', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('F1 exposes the explicit empty-list state separately from loading and error',
    frame?.scenario === 'empty' && frame.phase === 'ready' && frame.ids.length === 0
    && frame.selectedId === null && h.has(snap, 'No synthetic sessions in this scenario.'), JSON.stringify(frame))
  h.capture('scenario-empty', 'ready empty-list control')

  await h.key('F1', 300)
  await typeText(h, 'timeout')
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('content-search-unavailable keeps metadata matches but omits content-only results',
    frame?.scenario === 'search-unavailable' && frame.query === 'timeout'
    && frame.ids.includes('session-title-f0000006') && frame.ids.includes('session-both-h0000008')
    && !frame.ids.includes('session-content-g0000007') && frame.searchSources.every((hit) => hit.source === 'Metadata')
    && h.has(snap, 'Global · Content unavailable'), JSON.stringify(frame))
  h.capture('scenario-content-search-unavailable', 'metadata results remain available without content search')
  await h.key('Escape', 400)
  const selectionBeforeUnavailable = lastFrame(h)?.selectedId
  await typeText(h, 'worker log')
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('an unavailable content-only no-match is not presented as an ordinary zero-result search',
    frame?.scenario === 'search-unavailable' && frame.query === 'worker log' && frame.ids.length === 0
    && frame.total === 0 && frame.searchSources.length === 0
    && h.has(snap, 'No metadata matches; content search unavailable.')
    && !h.has(snap, 'No sessions match'), JSON.stringify({ frame, texts: h.texts(snap) }))
  h.capture('content-unavailable-no-metadata-match', 'native error explains incomplete content search, not ordinary no-match')
  const unavailableResumeCount = wouldResume(h).length
  const unavailableRejectStart = records(h).filter((row) => row.rejected === 'disabled-keyboard-action' && row.action === 'resume').length
  await h.key('Tab', 200)
  await h.key('Return', 200)
  const unavailableRejections = records(h).filter((row) => row.rejected === 'disabled-keyboard-action' && row.action === 'resume').slice(unavailableRejectStart)
  h.check('an unavailable content-only no-match cannot record Resume',
    wouldResume(h).length === unavailableResumeCount && unavailableRejections.length > 0, JSON.stringify(unavailableRejections))
  await h.key('Escape', 400)
  frame = lastFrame(h)
  h.check('clearing unavailable no-match restores the browse scope and selection',
    frame?.scenario === 'search-unavailable' && frame.query === '' && frame.scope === 'workspace'
    && frame.selectedId === selectionBeforeUnavailable, JSON.stringify(frame))

  await h.key('F1', 300)
  await typeText(h, 'pagination')
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('hasMore reports a four-item synthetic page of twelve without auto-pagination',
    frame?.scenario === 'has-more' && frame.query === 'pagination' && frame.hasMore === true
    && frame.ids.length === 4 && frame.total === 12 && frame.searchSources.every((hit) => hit.source === 'Content')
    && h.has(snap, 'Global · More matches · refine'), JSON.stringify(frame))
  h.capture('scenario-has-more', 'bounded synthetic search page and explicit refinement hint')
  for (let index = 0; index < 3; index += 1) await h.key('Down', 150)
  frame = lastFrame(h)
  snap = h.snapshot()
  const lastPaginationCard = choose(h, snap, 'Synthetic session 04')
  h.check('Down reaches the last result on the bounded page without auto-fetching more',
    frame?.query === 'pagination' && frame.hasMore === true && frame.ids.length === 4
    && frame.selectedId === frame.ids.at(-1) && lastPaginationCard !== undefined && containedXY(snap.chains, lastPaginationCard),
    JSON.stringify({ frame, card: lastPaginationCard && { text: h.descendantsText(lastPaginationCard), rect: rect(lastPaginationCard) } }))
  h.capture('scenario-has-more-last-results', 'keyboard navigation reaches the fourth already-fetched result')
  await h.key('Escape', 400)

  await h.key('F1', 300)
  frame = lastFrame(h)
  h.check('the scenario cycle returns to the normal synthetic roster',
    frame?.scenario === 'normal' && frame.phase === 'ready' && frame.ids.length >= 8 && frame.mainCount === 55, JSON.stringify(frame))

  await h.resize(400, 440)
  await typeText(h, 'session-long-')
  frame = lastFrame(h)
  snap = h.snapshot()
  const longId = frame?.selectedId
  h.check('the long-identifier metadata control selects a 160+ character ID and CJK title',
    frame?.query === 'session-long-' && frame.ids.length === 1 && longId?.startsWith('session-long-')
    && Array.from(longId ?? '').length >= 160 && frame.ids[0] === longId
    && frame.selectedTitle?.startsWith('超长标题🚀') && Array.from(frame.selectedTitle).length >= 160
    && frame.searchSources[0]?.source === 'Both', JSON.stringify(frame))
  h.capture('long-id-search-400x440', 'synthetic long identifier and CJK title search result')
  await h.key('Tab', 200)
  await h.key('Left', 200)
  await h.key('Return', 700)
  frame = lastFrame(h)
  snap = h.snapshot()
  const longTitleNode = choose(h, snap, 'Title 超长标题🚀')
  const longIdNode = choose(h, snap, 'Session ID session-long-')
  h.check('Details exposes wrapped long title and long ID fields in the read-only Reader',
    frame?.page === 'details' && frame.selectedId === longId
    && longTitleNode !== undefined && longIdNode !== undefined
    && visibleSpan(snap.chains, longTitleNode, 'y') > 0 && visibleSpan(snap.chains, longIdNode, 'y') > 0,
    JSON.stringify({ frame, title: longTitleNode && { rect: rect(longTitleNode), text: h.descendantsText(longTitleNode).slice(0, 48) }, id: longIdNode && { rect: rect(longIdNode), text: h.descendantsText(longIdNode).slice(0, 48) } }))
  h.capture('long-details-400x440-start', 'wrapped CJK title, long identifier, and synthetic workspace')
  await h.key('End', 500)
  snap = h.snapshot()
  const longExcerptTail = choose(h, snap, 'Host-mock long excerpt:')
  const longIdentityTail = choose(h, snap, 'Read-only identity confirmation')
  h.check('End exposes the tail of the long synthetic excerpt and identity without a real session read',
    records(h).filter((row) => row.readerScroll).at(-1)?.readerScroll === 'end'
    && tailVisible(snap.chains, longExcerptTail) && tailVisible(snap.chains, longIdentityTail)
    && wouldResume(h).length === beforeScenarioResume,
    JSON.stringify({ excerpt: longExcerptTail && { rect: rect(longExcerptTail), visibleY: visibleSpan(snap.chains, longExcerptTail, 'y') }, identity: longIdentityTail && { rect: rect(longIdentityTail), visibleY: visibleSpan(snap.chains, longIdentityTail, 'y') } }))
  h.capture('long-details-400x440-tail', 'full-text tail and final identity after negotiated scrolling')
  await h.key('Escape', 400)
  frame = lastFrame(h)
  h.check('Escape from the long Details Reader returns to the same search result',
    frame?.page === 'browser' && frame.query === 'session-long-' && frame.selectedId === longId, JSON.stringify(frame))
  await h.key('Escape', 400)
  frame = lastFrame(h)
  h.check('clearing the long-ID query restores its pre-search scope and selected session',
    frame?.layout === 'tree' && frame.scope === 'workspace' && frame.selectedId === 'session-current-a0000001', JSON.stringify(frame))

  snap = h.snapshot()
  h.capture('short-400x440-browse', 'short viewport after reader return')
  h.measure('short viewport bounds and visible row clipping', JSON.stringify({ viewport: h.ctl('stats').viewport, rows: snap.nodes.filter((node) => node.tag === 'button').map((node) => ({ text: h.descendantsText(node), rect: rect(node), ySpan: visibleSpan(snap.chains, node, 'y') })) }))

  await h.resize(400, 600)
  frame = lastFrame(h)
  h.check('the narrow keyboard-scope probe starts in This workspace with the same Current and selection',
    frame?.scope === 'workspace' && frame.selectedId === 'session-current-a0000001' && frame.pickerId === initialPickerId,
    JSON.stringify(frame))
  h.capture('narrow-scope-keyboard-before', 'narrow scope state before keyboard navigation')
  await h.key('Tab', 250)
  frame = lastFrame(h)
  h.check('Tab focuses the native narrow scope control', frame?.zone === 'scopes' && frame.scope === 'workspace', JSON.stringify(frame))
  await h.key('Enter', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('Enter on the narrow scope control selects All workspaces without losing Current or selection',
    frame?.zone === 'list' && frame.scope === 'all' && frame.ids.length === 55
    && frame.selectedId === 'session-current-a0000001' && frame.pickerId === initialPickerId
    && h.has(snap, 'All workspaces'), JSON.stringify(frame))
  h.capture('narrow-scope-keyboard-all', 'All workspaces selected by the focused keyboard scope control')
  await h.key('Tab', 250)
  await h.key('Enter', 300)
  frame = lastFrame(h)
  snap = h.snapshot()
  h.check('Enter returns the narrow scope control to This workspace',
    frame?.zone === 'list' && frame.scope === 'workspace' && frame.selectedId === 'session-current-a0000001'
    && frame.pickerId === initialPickerId && h.has(snap, 'This workspace'), JSON.stringify(frame))
  h.capture('narrow-scope-keyboard-workspace', 'workspace scope restored by the focused keyboard control')
  await h.key('Tab', 250)
  await h.key('Tab', 250)
  await h.key('Tab', 250)
  frame = lastFrame(h)
  h.check('Tab cycles through Scope and Footer back to the list after a scope change',
    frame?.zone === 'list' && frame.scope === 'workspace', JSON.stringify(frame))
  await h.key('F10', 500)
  const recordsAtEnd = records(h)
  h.check('the synthetic writer log contains no production-shaped side effect',
    recordsAtEnd.every((row) => row.wouldResume === undefined || row.source === 'list-enter' || row.source === 'footer-action' || row.source === 'footer-keyboard' || row.source === 'row-activate'),
    JSON.stringify(recordsAtEnd.filter((row) => row.wouldResume)))
}
