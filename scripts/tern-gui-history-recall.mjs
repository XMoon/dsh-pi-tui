/**
 * TSP I-B §7.5 REAL GUI-WINDOW evidence flow.
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs \
 *     scripts/tern-gui-history-recall.mjs --out <fresh evidence directory>
 *
 * ONE official Direct/TSP production composition runs inside a REAL Tern GUI
 * window on a real display. The subject's events.jsonl and sdk-wire.jsonl
 * record production handlers/seams/wire facts; the GUI flow reads the client's
 * real node tree, layout, PNG, caret and control-injected key events. A `ctl
 * key` reply never proves a key arrived from the wire alone.
 *
 * Evidence boundary: the input is GUI_CONTROL (`tern ctl key|commit|click`),
 * NOT physical OS input. The OS window, real rendering and live-window
 * light/dark appearance are exercised; OS physical input, IME and the OS
 * accessibility bridge are NOT_VERIFIED. Hard logical-line navigation is
 * proven; soft-wrap visual-row parity is a known difference. Native bracketed
 * paste may be unsupported by the control channel and is reported honestly.
 * @module scripts/tern-gui-history-recall
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect, visibleSpan, containedXY } from './tern-pane-geometry.mjs'

const ROWS = ['oldest recall row', 'middle recall row', 'newest recall row']
const RECALL = [...ROWS].reverse()
const SESSION_A = 'session-recall-a'
const SESSION_B = 'session-recall-b'
// The real GUI window enforces a native minimum size. The requested four
// bands are measured; cells that fit are exact assertions, clamped bands are
// recorded rather than falsely passing.
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '900x700', width: 900, height: 700 },
  { name: '400x600', width: 400, height: 600, optionalClamp: true },
  { name: '900x360', width: 900, height: 360, optionalClamp: true },
]
const APPEARANCES = ['light', 'dark']
const THREE_LINE_DRAFT = 'hard-line-one\nhard-line-two\nhard-line-three'
const COMMITTED_PASTE_DRAFT = 'paste-line-1\npaste-line-2 🚀'
const SUBMIT_DRAFT = 'submit-only-current-draft'

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const records = h => {
  const path = eventPath(h)
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}
const wireRecords = h => {
  const path = wirePath(h)
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}
/**
 * The SDK's OWN wire recorder keeps the exact `ui.editor` `text`/`cursor`
 * props. Tern's visible DOM renders a hard newline as a separate visual line
 * and its `sf-ed-text` node can read as spaces, so DOM text is NOT byte-exact
 * for multi-line drafts. Fold every frame's `add`/`set`/`text` ops and keep
 * the latest composer editor props. The picker's search/chevron editor nodes
 * are deliberately excluded: the claim is the ONE composer's wire state.
 */
const wireEditor = h => {
  const nodes = new Map()
  const isComposerEditor = id => id === 'dock.quiet-composer.composer' || id === 'dock.composer'
  const visit = node => {
    if (node === undefined || node === null || typeof node !== 'object') return
    if (typeof node.id === 'string' && node.k === 'editor') nodes.set(node.id, node.p ?? {})
    for (const child of node.c ?? []) visit(child)
    for (const slot of ['head', 'end', 'foot']) {
      const value = node.p?.[slot]
      if (value && typeof value === 'object') visit(value)
    }
  }
  for (const line of wireRecords(h)) {
    if (line.dir !== 'out' || line.verb !== 'f') continue
    for (const op of line.body?.ops ?? []) {
      if (op[0] === 'add') visit(op[4])
      if (op[0] === 'del' && typeof op[1] === 'string') nodes.delete(op[1])
      if (op[0] === 'set' && typeof op[2] === 'string') {
        const previous = nodes.get(op[2]) ?? {}
        const patch = op[3] ?? {}
        const next = { ...previous }
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key]
          else next[key] = value
        }
        nodes.set(op[2], next)
      }
      if (op[0] === 'text' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? {}
        const before = typeof previous.text === 'string' ? previous.text : ''
        const text = op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '')
        nodes.set(op[1], { ...previous, text })
      }
    }
  }
  const entries = [...nodes.entries()].filter(([id]) => isComposerEditor(id))
  const [id, props] = entries.at(-1) ?? []
  if (id === undefined || typeof props.text !== 'string') return undefined
  return { id, text: props.text, cursor: typeof props.cursor === 'number' ? props.cursor : 0, attrs: props }
}
const nodeClass = node => String(node?.class ?? '').split(/\s+/u).filter(Boolean)
const hasClass = (node, token) => nodeClass(node).includes(token)
const visibleNodes = snap => snap.nodes.filter(node => {
  const box = rect(node)
  return box[2] > 0 || box[3] > 0
})
const editorNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-editor'))
const editorTextNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-ed-text'))
const caretNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-caret'))
const dockNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-dock'))
const mainNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-main'))
const pickerNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-picker'))
const overlayNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-overlay'))
const domEditorText = snap => String(editorTextNode(snap)?.text ?? '')
const editorFacts = h => {
  const snap = h.snapshot()
  const editor = editorNode(snap)
  const textNode = editorTextNode(snap)
  const caret = caretNode(snap)
  const wire = wireEditor(h)
  return {
    text: wire?.text ?? domEditorText(snap),
    domText: domEditorText(snap),
    cursor: wire?.cursor,
    wireId: wire?.id,
    wireAvailable: wire !== undefined,
    focused: editor !== undefined && hasClass(editor, 'focused'),
    editorRect: editor === undefined ? undefined : rect(editor),
    textRect: textNode === undefined ? undefined : rect(textNode),
    caretRect: caret === undefined ? undefined : rect(caret),
    caretY: caret === undefined ? undefined : rect(caret)[1],
    caretX: caret === undefined ? undefined : rect(caret)[0],
    textNodeContainedXY: textNode === undefined ? false : containedXY(snap.chains, textNode),
    textVisibleSpanY: textNode === undefined ? 0 : visibleSpan(snap.chains, textNode, 'y'),
    editorContainedXY: editor === undefined ? false : containedXY(snap.chains, editor),
  }
}
const facts = (h, label) => {
  const value = editorFacts(h)
  h.measure(`facts ${label}`, JSON.stringify(value))
  return value
}
const waitUntil = async (h, label, predicate, { limit = 120, intervalMs = 250 } = {}) => {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}
const requiredWait = async (h, label, predicate, options) => {
  const ok = await waitUntil(h, label, predicate, options)
  h.check(label, ok, ok ? '' : JSON.stringify({ events: records(h).slice(-8), texts: h.texts(h.snapshot()).slice(-20) }))
  return ok
}
const insertText = async (h, text, settleMs = 350) => {
  h.send('commit', JSON.stringify(text))
  await h.sleep(settleMs)
}
const checkDraft = (h, label, expected) => {
  const snap = h.snapshot()
  const actual = editorFacts(h)
  h.check(label, actual.text === expected, JSON.stringify({ expected, actual, texts: h.texts(snap).slice(-10) }))
  return actual
}
const clearDraft = async (h, label) => {
  const start = editorFacts(h)
  if (start.text === '') {
    h.measure(`${label} already empty`, JSON.stringify(start))
    return start
  }
  await h.key('End', 180)
  let keys = 0
  while ((wireEditor(h)?.text ?? '') !== '' && keys < 180) {
    await h.key('Backspace', 45)
    keys += 1
  }
  const actual = editorFacts(h)
  const ok = actual.text === ''
  if (ok) h.measure(`${label} cleared by real End+Backspace keys`, JSON.stringify({ keys, start }))
  else h.check(`${label} cleared by real End+Backspace keys`, false, JSON.stringify({ keys, start, actual }))
  return actual
}
const safeSend = async (h, label, ...args) => {
  try {
    const reply = h.send(...args)
    await h.sleep(250)
    h.measure(label, JSON.stringify({ args, reply }))
    return true
  } catch (error) {
    h.measure(`${label} NOT_VERIFIED`, `${String(error)} :: control channel does not provide this input`)
    return false
  }
}
const caseCount = h => records(h).filter(entry => entry.kind === 'case.received').length
const sendCase = async (h, command) => {
  const ordinal = caseCount(h)
  const full = `${command} ${ordinal}`
  writeFileSync(join(h.root, 'case'), `${full}\n`)
  const done = await requiredWait(h, `subject handled case ${command}`, () =>
    records(h).some(entry => (entry.kind === 'case.done' || entry.kind === 'case.failed') && entry.command === full),
    { limit: 120 })
  if (!done) return undefined
  const result = records(h).filter(entry => entry.kind === 'case.done' && entry.command === full).at(-1)
    ?? records(h).filter(entry => entry.kind === 'case.failed' && entry.command === full).at(-1)
  if (result?.error !== undefined) h.check(`case ${command} reported no error`, false, JSON.stringify(result))
  return result
}
const countsBefore = h => records(h).filter(entry => entry.kind === 'writer.prompt').length
const promptTextOf = entry => entry?.message?.content?.[0]?.text ?? JSON.stringify(entry?.message ?? '')
const finish = (h, extra = {}) => {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}
const writeLedger = (h, name, value) => {
  const path = join(h.root, name)
  writeFileSync(path, `${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined

const geometryCell = (h, snap, appearance, viewport, captureId, out) => {
  const dock = dockNode(snap)
  const main = mainNode(snap)
  const editor = editorNode(snap)
  const caret = caretNode(snap)
  const state = h.ctl('state')
  const stats = h.ctl('stats')
  const box = node => node === undefined ? undefined : rect(node)
  const contained = node => node === undefined ? false : containedXY(snap.chains, node)
  const spanY = node => node === undefined ? 0 : visibleSpan(snap.chains, node, 'y')
  const wire = wireEditor(h)
  const cell = {
    viewport: viewport.name,
    requested: [viewport.width, viewport.height],
    actualViewport: stats.viewport?.slice(0, 2),
    exactRequested: stats.viewport?.[0] === viewport.width && stats.viewport?.[1] === viewport.height,
    appearance,
    resolvedTheme: state.theme,
    main: { rect: box(main), containedXY: contained(main), spanY: spanY(main) },
    dock: { rect: box(dock), containedXY: contained(dock), spanY: spanY(dock) },
    editor: { rect: box(editor), containedXY: contained(editor), spanY: spanY(editor) },
    caret: { rect: box(caret), containedXY: contained(caret), spanY: spanY(caret) },
    focus: { editorFocused: editor !== undefined && hasClass(editor, 'focused'), stateFocus: state.focus ?? null },
    draft: wire?.text,
    cursor: wire?.cursor,
    clipping: {
      dockVisible: dock !== undefined && spanY(dock) > 4 && contained(dock),
      editorVisible: editor !== undefined && spanY(editor) > 4 && contained(editor),
      caretVisible: caret !== undefined && spanY(caret) > 4 && contained(caret),
      mainFullyContained: main !== undefined && contained(main),
    },
    png: join(out, 'shots', `${captureId}.png`),
    nodeTree: join(out, `${captureId}.tree.json`),
  }
  const visibleCore = box(main) !== undefined && box(dock) !== undefined && box(editor) !== undefined && box(caret) !== undefined
    && cell.clipping.dockVisible && cell.clipping.editorVisible && cell.clipping.caretVisible && cell.focus.editorFocused
  if (viewport.optionalClamp && !cell.exactRequested) {
    h.check(`${viewport.name} ${appearance}: real GUI window reports its native minimum-size clamp honestly`,
      cell.resolvedTheme === appearance && cell.actualViewport?.length === 2, JSON.stringify(cell))
    h.measure(`${viewport.name} ${appearance}: clamped core visibility measurement`, JSON.stringify({ visibleCore, cell }))
  } else {
    h.check(`${viewport.name} ${appearance}: the real GUI window took the viewport, resolved ${appearance}, and kept focus/caret/Main/Dock observable`,
      cell.resolvedTheme === appearance && cell.exactRequested && visibleCore, JSON.stringify(cell))
  }
  h.measure(`${viewport.name} ${appearance}: Main/Dock/caret/focus/clipping`, JSON.stringify(cell))
  return cell
}

export default async function (h) {
  const out = h.root
  const subject = join(h.repo, 'scripts', 'tern-pane-history-recall-ux-subject.mts')
  const ternBin = process.env.TERN_BIN ?? 'tern'
  const ternVersion = execFileSync(ternBin, ['--version'], { encoding: 'utf8' }).trim()
  const lock = readFileSync(join(h.repo, 'pnpm-lock.yaml'), 'utf8')
  const sdkPin = /'@stencil-hq\/tern':\s*\n\s*specifier: 0\.2\.0\s*\n\s*version: 0\.2\.0/u.test(lock)
    ? '0.2.0' : 'UNVERIFIED'
  const integrity = lock.match(/'@stencil-hq\/tern@0\.2\.0':\s*\n\s*resolution: \{integrity: ([^}]+)\}/u)?.[1] ?? 'UNVERIFIED'
  h.measure('tern version', ternVersion)
  h.measure('SDK lock/integrity', JSON.stringify({ pin: sdkPin, integrity }))
  h.check('the pinned SDK is @stencil-hq/tern 0.2.0 with a lock integrity',
    sdkPin === '0.2.0' && integrity.startsWith('sha512-'), `pin=${sdkPin} integrity=${integrity}`)

  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))
  await h.resize(1280, 800)
  writeFileSync(join(out, 'case'), '')
  h.check('the production Direct/TSP subject launches in a pane of the real GUI window',
    await h.launch(subject, { ready: 'dsh-pi-tui' }))
  if (!await requiredWait(h, 'the official Direct fixture and production renderer are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'renderer.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'seam.resetInputHistory'
      && JSON.stringify(entry.entries) === JSON.stringify(RECALL)
      && (entry.owner === SESSION_A || entry.owner === undefined))
    && h.classNodes(h.snapshot(), 'sf-region').length > 0,
    { limit: 240 })) {
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  const ready = records(h).find(entry => entry.kind === 'fixture.ready')
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  const reset = records(h).find(entry => entry.kind === 'seam.resetInputHistory'
    && JSON.stringify(entry.entries) === JSON.stringify(RECALL)
    && (entry.owner === SESSION_A || entry.owner === undefined))
  h.measure('boot seed source', JSON.stringify({
    owner: reset?.owner ?? null,
    policy: 'sessionless activateBootRecall or Session A hydration reset are both accepted; both read the same seeded cwd JSONL',
    status: 'REAL_GUI_RUN_ON_FROZEN_TREE',
  }))
  h.measure('subject capabilities', JSON.stringify(subjectReady?.caps))
  h.check('the shipped SDK capabilities cover the TSP editor, pickers and styles',
    ['editor', 'picker', 'overlay', 'input', 'el'].every(kind => subjectReady?.caps?.kinds?.includes(kind))
    && ['styles', 'flow', 'dock'].every(feature => subjectReady?.caps?.features?.includes(feature)),
    JSON.stringify(subjectReady?.caps))
  h.check('three newest-first history rows were committed through the production display seam',
    reset?.entries?.length === 3 && JSON.stringify(reset.entries) === JSON.stringify(RECALL)
    && reset?.newestFirst === true, JSON.stringify(reset))
  writeLedger(h, 'environment.json', {
    ternVersion, sdkPin, integrity, caps: subjectReady?.caps, ready, seamReset: reset,
    bootSeed: 'sessionless activateBootRecall or Session A hydration reset are both accepted; same pre-existing cwd JSONL rows',
    sourceDeltaStatus: 'REAL_GUI_RUN_ON_FROZEN_TREE',
  })

  h.capture('00-empty-composer-1280x800-light', 'the production Direct composer before recall')

  // 1. Single-line ↑/↓: newest-first, then the exact draft/caret restore.
  const empty = checkDraft(h, 'the composer starts empty', '')
  await h.key('ArrowUp', 450)
  const up1 = checkDraft(h, 'the first unmodified ArrowUp recalls the newest row', RECALL[0])
  h.check('the first recalled row places the caret at its start', up1.caretX === empty.caretX,
    JSON.stringify({ empty, up1 }))
  h.capture('01-recall-newest-1280x800-light', 'the newest history row in the real editor')
  await h.key('ArrowUp', 450)
  checkDraft(h, 'the second unmodified ArrowUp recalls the middle row', RECALL[1])
  await h.key('ArrowUp', 450)
  checkDraft(h, 'the third unmodified ArrowUp recalls the oldest row', RECALL[2])
  h.capture('02-recall-oldest-1280x800-light', 'the oldest history row in the real editor')
  await h.key('ArrowUp', 450)
  checkDraft(h, 'an ArrowUp past the oldest row stays on the oldest row', RECALL[2])
  await h.key('ArrowDown', 450)
  checkDraft(h, 'ArrowDown walks newer to the middle row', RECALL[1])
  await h.key('ArrowDown', 450)
  checkDraft(h, 'ArrowDown walks newer to the newest row', RECALL[0])
  const beforeRestore = editorFacts(h)
  await h.key('ArrowDown', 450)
  const restored = checkDraft(h, 'ArrowDown leaving index 0 restores the exact empty draft', '')
  h.check('the restored caret is the pre-browse caret',
    restored.caretX === empty.caretX && restored.caretY === empty.caretY,
    JSON.stringify({ empty, beforeRestore, restored }))
  h.capture('03-draft-restored-1280x800-light', 'the empty draft and caret after the recall browse')
  writeLedger(h, 'single-line-recall.json', { empty, rows: RECALL, beforeRestore, restored })

  // 2. Three hard logical lines: Shift+Enter first, then ↑/↓ by hard lines.
  await clearDraft(h, 'case2')
  await insertText(h, 'hard-line-one')
  checkDraft(h, 'the first hard line is exact', 'hard-line-one')
  await h.key('Shift+Enter', 400)
  const afterShiftEnter = checkDraft(h, 'Shift+Enter inserts a real hard newline', 'hard-line-one\n')
  const beforeShiftEnter = facts(h, 'before-shift-enter-not-persisted')
  h.check('Shift+Enter moved the visible caret to a new line',
    afterShiftEnter.caretY > empty.caretY && afterShiftEnter.text.includes('\n'),
    JSON.stringify({ empty, beforeShiftEnter, afterShiftEnter }))
  await insertText(h, 'hard-line-two')
  checkDraft(h, 'the second hard line is exact', 'hard-line-one\nhard-line-two')
  await h.key('Shift+Enter', 400)
  checkDraft(h, 'the second Shift+Enter inserts another hard newline', 'hard-line-one\nhard-line-two\n')
  await insertText(h, 'hard-line-three')
  const start = checkDraft(h, 'Shift+Enter builds the three-line draft', THREE_LINE_DRAFT)
  h.capture('04-three-hard-lines-1280x800-light', 'three real hard logical lines in the production editor')
  await h.key('ArrowUp', 400)
  const up1Hard = facts(h, 'hard-up-1')
  h.check('the first unmodified ArrowUp moves to the previous HARD logical line, not into recall',
    up1Hard.text === THREE_LINE_DRAFT && up1Hard.caretY < start.caretY && up1Hard.caretX <= start.caretX,
    JSON.stringify({ start, up1Hard }))
  await h.key('ArrowUp', 400)
  const up2Hard = facts(h, 'hard-up-2')
  h.check('the second unmodified ArrowUp moves to the first HARD logical line',
    up2Hard.text === THREE_LINE_DRAFT && up2Hard.caretY < up1Hard.caretY,
    JSON.stringify({ up1Hard, up2Hard }))
  await h.key('ArrowUp', 400)
  const lineStart = facts(h, 'hard-up-3-to-start')
  h.check('the third ArrowUp moves to the first hard line start',
    lineStart.text === THREE_LINE_DRAFT && lineStart.caretY === up2Hard.caretY && lineStart.caretX < up2Hard.caretX,
    JSON.stringify({ up2Hard, lineStart }))
  await h.key('ArrowUp', 400)
  const afterHardUp = checkDraft(h, 'only an ArrowUp at the first hard line enters recall', RECALL[0])
  h.check('recall was entered from the first hard line', afterHardUp.text === RECALL[0], JSON.stringify({ lineStart, afterHardUp }))
  await h.key('ArrowDown', 400)
  const afterRecallDown = checkDraft(h, 'ArrowDown from recalled index 0 restores the three-line draft', THREE_LINE_DRAFT)
  h.check('the restored caret is on the third hard line (the exact pre-browse caret)',
    afterRecallDown.caretY === start.caretY && afterRecallDown.caretX === start.caretX,
    JSON.stringify({ start, afterRecallDown }))
  await h.key('ArrowDown', 400)
  const afterLastDown = editorFacts(h)
  h.check('a second ArrowDown stays inside the draft at its last hard-line caret',
    afterLastDown.text === THREE_LINE_DRAFT && afterLastDown.caretY === start.caretY && afterLastDown.caretX === start.caretX,
    JSON.stringify(afterLastDown))
  h.capture('05-hardline-navigation-1280x800-light', 'hard-line up/down and exact draft/caret restore')
  writeLedger(h, 'hard-line-navigation.json', {
    draft: THREE_LINE_DRAFT, start, up1Hard, up2Hard, lineStart, afterHardUp, afterRecallDown,
    softWrap: 'KNOWN_DIFFERENCE: hard logical lines only',
  })

  // 3. Multiline/emoji paste attempt + ↓ draft restore.
  // First prove what the headless control channel can and cannot do.
  const pasteCmd = await safeSend(h, 'tern ctl paste', 'paste')
  const pasteArgCmd = await safeSend(h, 'tern ctl paste text', 'paste', JSON.stringify('alpha\nbeta 🚀'))
  const clipboardOk = await safeSend(h, 'tern ctl clipboard text', 'clipboard', 'text', JSON.stringify('clip-line-1\nclip-line-2 🚀'))
  const ctrlV = editorFacts(h)
  await safeSend(h, 'tern ctl key Control+v', 'key', 'Control+v')
  const afterCtrlV = editorFacts(h)
  const nativePasteTextChanged = afterCtrlV.text !== ctrlV.text
  h.measure('native bracketed paste', JSON.stringify({
    pasteCmd, pasteArgCmd, clipboardOk, ctrlVBefore: ctrlV.text, afterCtrlV: afterCtrlV.text,
    pasteMediaEvents: records(h).filter(entry => entry.kind === 'handler.pasteMedia').length,
    verdict: nativePasteTextChanged ? 'PASTE_TEXT_OBSERVED' : 'NOT_VERIFIED: control channel did not deliver a bracketed paste text insert',
  }))
  if (!nativePasteTextChanged) {
    h.measure('multiline/emoji draft restore', 'using the PROVEN control `commit` hard-newline path; native paste remains NOT_VERIFIED')
  }
  await clearDraft(h, 'paste case')
  await insertText(h, COMMITTED_PASTE_DRAFT, 550)
  const pasted = checkDraft(h, 'the control-committed multiline emoji draft is byte-exact', COMMITTED_PASTE_DRAFT)
  h.check('the multiline emoji draft really holds the emoji and a hard newline',
    pasted.text.includes('🚀') && pasted.text.includes('\n'), JSON.stringify(pasted))
  h.capture('06-committed-multiline-emoji-1280x800-light', 'real multiline/emoji draft with a hard logical line')
  await h.key('ArrowUp', 400)
  const pasteLine1 = editorFacts(h)
  h.check('ArrowUp in the multiline emoji draft moves by its hard logical line first',
    pasteLine1.text === COMMITTED_PASTE_DRAFT && pasteLine1.caretY < pasted.caretY,
    JSON.stringify({ pasted, pasteLine1 }))
  await h.key('ArrowUp', 400)
  const pasteLineStart = editorFacts(h)
  h.check('the second ArrowUp moves to the first hard line start',
    pasteLineStart.text === COMMITTED_PASTE_DRAFT && pasteLineStart.caretY === pasteLine1.caretY && pasteLineStart.caretX < pasteLine1.caretX,
    JSON.stringify({ pasteLine1, pasteLineStart }))
  await h.key('ArrowUp', 400)
  const pasteRecall = checkDraft(h, 'ArrowUp at the first pasted hard line recalls the newest row', RECALL[0])
  await h.key('ArrowDown', 400)
  const pasteRestored = checkDraft(h, 'ArrowDown restores the exact multiline emoji draft', COMMITTED_PASTE_DRAFT)
  h.check('the restored emoji draft keeps the exact pre-browse caret',
    pasteRestored.caretX === pasted.caretX && pasteRestored.caretY === pasted.caretY,
    JSON.stringify({ pasted, pasteLine1, pasteLineStart, pasteRecall, pasteRestored }))
  h.capture('07-paste-draft-restored-1280x800-light', 'the exact multiline emoji draft and caret after recall')
  writeLedger(h, 'paste-multiline-emoji.json', {
    draft: COMMITTED_PASTE_DRAFT, pasted, pasteLine1, pasteLineStart, pasteRecall, pasteRestored,
    nativePaste: nativePasteTextChanged ? 'OBSERVED' : 'NOT_VERIFIED',
    input: 'GUI_CONTROL commit text with embedded \\n (proven hardline path); paste/clipboard/Ctrl+V attempted and recorded',
  })

  // 4. A production picker preempts the composer seat, then closes. The
  // quick Model/Effort panel is the production `modelPresentation.openQuick`
  // route; its directory is the declared scripted fixture stand-in.
  const seatBefore = editorFacts(h)
  const seatOpen = await sendCase(h, 'seat-open')
  const menuOpened = await waitUntil(h, 'the production picker owns the composer seat', () => {
    const snap = h.snapshot()
    return pickerNode(snap) !== undefined || overlayNode(snap) !== undefined
      || h.texts(snap).some(text => String(text).includes('All models & details') || String(text).includes('Scripted Model'))
  }, { limit: 40, intervalMs: 150 })
  const menuSnap = h.snapshot()
  h.check('the production quick menu/picker became visible', menuOpened && seatOpen?.opened === true,
    JSON.stringify({ seatOpen, picker: pickerNode(menuSnap)?.class, overlay: overlayNode(menuSnap)?.class, texts: h.texts(menuSnap).slice(-20) }))
  h.capture('08-picker-seat-open-1280x800-light', 'production picker preempts the composer seat')
  await h.key('ArrowUp', 400)
  const menuDraft = editorFacts(h)
  h.check('ArrowUp while the picker owns the seat does not recall into the composer',
    menuDraft.text === seatBefore.text && menuDraft.caretX === seatBefore.caretX && menuDraft.caretY === seatBefore.caretY,
    JSON.stringify({ seatBefore, menuDraft }))
  await h.key('Escape', 500)
  const menuClosed = await waitUntil(h, 'Escape closed the production picker', () => {
    const snap = h.snapshot()
    return pickerNode(snap) === undefined && overlayNode(snap) === undefined
      && !h.texts(snap).some(text => String(text).includes('All models & details'))
  }, { limit: 40, intervalMs: 150 })
  const afterMenuClose = editorFacts(h)
  await sendCase(h, 'seat-close')
  h.check('the production picker closes and the exact draft/caret survive',
    menuClosed && afterMenuClose.text === seatBefore.text && afterMenuClose.caretX === seatBefore.caretX && afterMenuClose.caretY === seatBefore.caretY,
    JSON.stringify({ menuClosed, seatBefore, afterMenuClose }))
  h.capture('09-picker-seat-closed-1280x800-light', 'composer seat restored after the picker closed')
  writeLedger(h, 'picker-seat.json', { seatBefore, menuDraft, menuClosed, afterMenuClose, seatOpen })

  // 5. A→B session switch fence through the PRODUCTION formal display owners.
  // The `beginInputHistoryScope(B)` + `resetInputHistory([], B)` commit is the
  // decisive scope fence and is recorded by the subject hook. The full Host
  // `/sessions` Resume transition is not driven here and is NOT_VERIFIED.
  await clearDraft(h, 'pre-switch')
  await h.key('ArrowUp', 450)
  const preSwitchRow = checkDraft(h, 'pre-switch ↑ recalls Session A\'s newest row', RECALL[0])
  const switchStart = records(h).length
  const switchCase = await sendCase(h, 'switch')
  const switchTrace = records(h).slice(switchStart)
  const seamReset = switchTrace.filter(entry => entry.kind === 'seam.resetInputHistory')
  const seamBegin = switchTrace.filter(entry => entry.kind === 'seam.beginInputHistoryScope')
  h.check('the formal B scope owners retired the A browse',
    switchCase?.fenced === true && seamBegin.some(entry => entry.owner === SESSION_B)
    && seamReset.some(entry => entry.owner === SESSION_B && entry.entries?.length === 0),
    JSON.stringify({ switchCase, seamBegin, seamReset }))
  await h.key('ArrowDown', 450)
  const afterFenceDown = editorFacts(h)
  h.check('↓ after the A→B fence does not restore the outgoing browse draft',
    afterFenceDown.text !== '' && !['', THREE_LINE_DRAFT, COMMITTED_PASTE_DRAFT].includes(afterFenceDown.text),
    JSON.stringify({ preSwitchRow, afterFenceDown }))
  await clearDraft(h, 'after-fence')
  await h.key('ArrowUp', 450)
  const afterBResetUp = editorFacts(h)
  h.check('empty composer after the B projection reset cannot recall A rows',
    !RECALL.includes(afterBResetUp.text), JSON.stringify({ afterFenceDown, afterBResetUp }))
  h.measure('A→B production Host transition', 'NOT_VERIFIED: the full Host switch via the real /sessions Browser Resume was not driven in this headless UX lane; the formal display-seam A→B fence above is the recorded production-owner evidence')
  h.capture('10-session-switch-fence-1280x800-light', 'formal A→B scope fence')
  writeLedger(h, 'session-switch-fence.json', {
    preSwitchRow, switchCase, seamBegin, seamReset, afterFenceDown, afterBResetUp,
    realSessionsBrowser: 'NOT_VERIFIED',
    switchTrace: switchTrace.filter(entry => entry.kind?.startsWith('seam.') || entry.kind === 'writer.prompt'),
  })

  // 6. The final Enter submits ONLY the current draft.
  await clearDraft(h, 'final-enter')
  await insertText(h, SUBMIT_DRAFT)
  const finalDraft = checkDraft(h, 'the final editor holds exactly the current draft', SUBMIT_DRAFT)
  const promptsBefore = countsBefore(h)
  await h.key('Enter', 1200)
  const submitted = await requiredWait(h, 'the final Enter reaches the settled production Direct writer', () =>
    records(h).filter(entry => entry.kind === 'writer.prompt').length > promptsBefore, { limit: 100 })
  const prompts = records(h).filter(entry => entry.kind === 'writer.prompt')
  const lastPrompt = prompts.at(-1)
  const submittedText = promptTextOf(lastPrompt)
  h.check('the final Enter submits ONLY the current draft',
    submitted && prompts.length === promptsBefore + 1
    && submittedText === SUBMIT_DRAFT
    && !RECALL.some(row => submittedText.includes(row))
    && !submittedText.includes(THREE_LINE_DRAFT)
    && !submittedText.includes(COMMITTED_PASTE_DRAFT),
    JSON.stringify({ finalDraft, promptsBefore, prompts: prompts.length, lastPrompt, submittedText }))
  const afterSubmit = editorFacts(h)
  h.check('the visible composer no longer holds the submitted draft after Enter',
    afterSubmit.text === '', JSON.stringify(afterSubmit))
  h.capture('11-final-enter-1280x800-light', 'the real composer after the final Enter submission')
  writeLedger(h, 'final-enter.json', { finalDraft, promptsBefore, prompts, lastPrompt, afterSubmit })

  // 7. Eight real appearance/geometry cells. Each cell records Main/Dock
  // dimensions, visibility/clipping through the geometry oracle, focus, the
  // caret position, the PNG, the node tree and the layout's resolved theme.
  const cells = []
  for (const viewport of VIEWPORTS) {
    await h.resize(viewport.width, viewport.height)
    for (const appearance of APPEARANCES) {
      await h.send('plugins', 'run', `appearance:${appearance}`)
      await h.sleep(300)
      const id = h.capture(`cell-${viewport.name}-${appearance}`, `history recall UX ${viewport.name} ${appearance}`)
      const cell = geometryCell(h, h.snapshot(), appearance, viewport, id, out)
      cells.push(cell)
    }
  }
  await h.send('plugins', 'run', 'appearance:light')
  writeLedger(h, 'geometry-cells.json', cells)

  // 8. Source→sink/key/caret ledger, honest lane boundaries and soft wrap.
  const caseEvents = records(h).filter(entry => entry.kind?.startsWith('case.') || entry.kind === 'writer.prompt')
  const keyCommands = readFileSync(join(out, 'run.log'), 'utf8').split('\n')
    .filter(line => line.startsWith('SEND ok ["key"') || line.startsWith('SEND ok ["commit"') || line.startsWith('SEND ok ["type"') || line.startsWith('SEND ok ["click"'))
  writeLedger(h, 'key-events.jsonl', keyCommands.join('\n'))
  writeLedger(h, 'draft-caret-changes.json', {
    singleLine: RECALL,
    threeLine: THREE_LINE_DRAFT,
    committedMultilineEmoji: COMMITTED_PASTE_DRAFT,
    final: SUBMIT_DRAFT,
    caretFacts: facts(h, 'final-ledger'),
  })
  const laneLedger = {
    ternVersion,
    sdk: { pin: sdkPin, integrity, installedCapabilities: subjectReady?.caps },
    sourceDeltaStatus: 'REAL_GUI_RUN_ON_FROZEN_TREE',
    bootSeed: 'REAL GUI run used the owner-approved production boot seed or Session A reseed from the same cwd JSONL; no second reader',
    CLIENT_INTERACTIVE: 'REAL_TERN_GUI window GUI_CONTROL lane; production Direct composition; native window, node tree/PNG/caret/wire/events read back',
    GUI_PHYSICAL_OS: 'REAL_TERN_GUI window rendering verified; OS physical keyboard/IME remains NOT_VERIFIED',
    inputMode: 'GUI_CONTROL (tern ctl key|commit|click); ctl key is control-injected, not physical OS input',
    hardNewline: 'PROVEN: ctl key Shift+Enter inserts \\n in the real editor (sdk-wire.jsonl exact text + DOM caret movement)',
    nativePaste: nativePasteTextChanged ? 'OBSERVED for text insert' : 'NOT_VERIFIED: tern ctl paste is not available; clipboard + Ctrl+v only routes pasteMedia intent',
    softWrap: 'KNOWN_DIFFERENCE: this PR guarantees HARD LOGICAL LINE navigation only; visual soft-wrap line movement is not claimed',
    NOT_VERIFIED: [
      'OS physical keyboard / IME and OS screen-reader bridge',
      'soft-wrap visual line navigation',
      nativePasteTextChanged ? 'native paste text insert observed' : 'native bracketed paste text insert',
      'full A→B Host switch via real /sessions Browser Resume (formal display-seam fence is recorded)',
    ],
    cases: caseEvents,
    keyCommands: keyCommands.length,
    assertions: join(out, 'assertions.json'),
  }
  writeLedger(h, 'lane-ledger.json', laneLedger)
  h.measure('soft-wrap known difference', laneLedger.softWrap)
  h.measure('GUI_CONTROL vs physical OS input', laneLedger.inputMode)
  h.measure('CLIENT_INTERACTIVE verdict', laneLedger.CLIENT_INTERACTIVE)
  h.measure('source-delta status', laneLedger.sourceDeltaStatus)
  finish(h, {
    tern: ternVersion,
    sdk: { pin: sdkPin, integrity },
    cells,
    CLIENT_INTERACTIVE: 'REAL_TERN_GUI_CONTROL',
    GUI_PHYSICAL_OS: 'REAL_WINDOW_VERIFIED_OS_INPUT_NOT_VERIFIED',
    sourceDeltaStatus: 'REAL_GUI_RUN_ON_FROZEN_TREE',
    bootSeed: laneLedger.bootSeed,
    hardNewline: laneLedger.hardNewline,
    nativePaste: laneLedger.nativePaste,
    softWrap: 'KNOWN_DIFFERENCE_HARD_LOGICAL_LINES_ONLY',
    AtoB_FENCE: 'FORMAL_DISPLAY_SEAM_FENCE_RECORDED_FULL_HOST_SWITCH_NOT_VERIFIED',
  })
}
