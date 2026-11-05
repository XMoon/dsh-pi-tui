/**
 * TSP I-D §7.3 real-Tern UX evidence lane: the ONE input-completion seat on the
 * PRODUCTION Direct/TSP composition. It keeps EVERY I-C assertion (the leading
 * slash seat, its keys, the click fences, the four viewports × light/dark, the
 * clipping/caret measurements and the real tree/PNG/layout evidence) and adds
 * the I-D journeys: a Host `@` mention, a first-line `/image` argument, a body
 * inline action → directory continuation → file intake → placeholder → submit,
 * and the measured negatives (stale row click, Escape, a higher-owner seat, an
 * empty Host answer, no cross-source substitution, zero accidental submits and
 * the successful-accept single-frame rule).
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-input-completion-ux.mjs \
 *     --out <fresh evidence directory>
 *
 * ONE production Direct composition runs inside a real headless
 * `tern serve --control` pane: `createDirectTspFixture({externalTern:true})`
 * boots the shipped composition, so the mount, the stylesheet install, the mount
 * order, the display seam and the Quiet Composer path are the production ones,
 * and the candidate catalog arrives through the REAL command layer's single
 * commit point (the flow proves that from the recorded call sites instead of
 * assuming it). The subject's `events.jsonl` records the production facts: every
 * key the mount's own input loop pulled, every catalog commit, every composer
 * reducer call, the conditional completion write, the inline stager call, the
 * real Host/Client discovery calls, the real draft-store stages, every input
 * handler call and every settled Direct writer prompt; `sdk-wire.jsonl` carries
 * the exact `ui.editor` `text`/`cursor` props and the row `data-highlight`; the
 * flow reads the real Tern node tree, layout and PNG for what the CLIENT paints.
 * A `ctl key` reply alone never proves a key arrived.
 *
 * LANE HONESTY (docs/guides/tern-pane-testing.md, applied literally):
 *  - every input is `CONTROL_INJECTED_INPUT` (`tern ctl key|commit|click`),
 *    delivered through the control channel; the tier is `REAL_TERN_HEADLESS`.
 *    OS physical keyboard, OS IME and an OS screen reader are NOT_VERIFIED here
 *    and in the GUI twin;
 *  - VISIBILITY: the popup is an absolutely positioned child of the Composer
 *    shell that deliberately overflows the Dock region upward. The geometry
 *    oracle treats EVERY sized ancestor as a clip, so `containedXY`/`visibleSpan`
 *    against the full chain reports every row as clipped — that is the
 *    documented over-approximation, not the client's behaviour (the PNG shows
 *    the rows). The flow therefore identifies the REAL clip chain the guide
 *    asks for: the popup's own scroller plus the ancestors that actually
 *    contain it, and it asks `ctl pick` what the client really has at the row's
 *    centre. `ctl layers` is recorded too; on this build it reports no layers,
 *    which is a measured client fact, not a relaxed oracle;
 *  - a path the client does not render is a `measure`, never a pass: the
 *    ≤3-plain-`ui.text` fallback (a pane without `el`+`styles`) is unreachable
 *    on this client (it negotiates both) and is reported NOT_VERIFIED;
 *  - soft-wrapped visual rows are NOT part of this milestone (the contract is
 *    hard-newline logical lines), so the long-candidate-line case records what
 *    the client really does with one long row instead of asserting parity;
 *  - if the client cannot keep the list visible or the caret operable at some
 *    size, that is a FAILED assertion in the ledger, not a reworded pass.
 * @module scripts/tern-pane-input-completion-ux
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect, visibleSpan, containedXY, visiblePoint } from './tern-pane-geometry.mjs'

const ROWS = ['oldest recall row', 'middle recall row', 'newest recall row']
const RECALL = [...ROWS].reverse()
const SESSION_A = 'session-input-a'
const HINT = '↑↓ select · Tab/Enter complete · Esc close'
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '900x700', width: 900, height: 700 },
  { name: '400x600', width: 400, height: 600 },
  { name: '900x360', width: 900, height: 360 },
]
const APPEARANCES = ['light', 'dark']
/** The bounded window for this lane's ABSENCE claims (nothing to await). */
const ABSENCE_WINDOW_MS = 600

const eventPath = h => join(h.root, 'events.jsonl')
const wirePath = h => join(h.root, 'sdk-wire.jsonl')
const records = h => existsSync(eventPath(h))
  ? readFileSync(eventPath(h), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const wireRecords = h => existsSync(wirePath(h))
  ? readFileSync(wirePath(h), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const kindCount = (h, kind) => records(h).filter(entry => entry.kind === kind).length
const lastKind = (h, kind) => records(h).filter(entry => entry.kind === kind).at(-1)
/** The two REAL file authorities this run materialized, as the subject
 *  recorded them before it booted the composition. */
const clientCwdOf = h => records(h).find(entry => entry.kind === 'subject.ready')?.clientCwd
const hostWorkspaceOf = h => records(h).find(entry => entry.kind === 'subject.ready')?.hostWorkspace

/**
 * Fold the SDK's own wire recorder into the current node table. The client tree
 * carries no wire ids and no custom `data-role`, so this is the ONLY authority
 * for the exact `ui.editor` `text`/`cursor` props and for the row
 * `data-highlight` the presenter committed.
 */
const wireFold = h => {
  const nodes = new Map()
  const visit = node => {
    if (node === undefined || node === null || typeof node !== 'object') return
    if (typeof node.id === 'string' && typeof node.k === 'string') nodes.set(node.id, { k: node.k, p: node.p ?? {} })
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
      // A `del` removes the node AND ITS WHOLE SUBTREE (measured: the popup is
      // withdrawn by deleting the menu node alone). Without the cascade the
      // table would keep every candidate row of every past revision, and
      // "which rows does the CURRENT frame own" would stop being a fact.
      if (op[0] === 'del' && typeof op[1] === 'string') {
        for (const id of [...nodes.keys()]) {
          if (id === op[1] || id.startsWith(`${op[1]}.`)) nodes.delete(id)
        }
      }
      // The pinned SDK `Op` shape is `['set', id, patch]`; a null patch value
      // removes the prop.
      if (op[0] === 'set' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? { k: '', p: {} }
        const next = { ...previous.p }
        for (const [key, value] of Object.entries(op[2] ?? {})) {
          if (value === null) delete next[key]
          else next[key] = value
        }
        nodes.set(op[1], { k: previous.k, p: next })
      }
      if (op[0] === 'text' && typeof op[1] === 'string') {
        const previous = nodes.get(op[1]) ?? { k: 'text', p: {} }
        const before = typeof previous.p.text === 'string' ? previous.p.text : ''
        nodes.set(op[1], {
          k: previous.k,
          p: { ...previous.p, text: op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '') },
        })
      }
    }
  }
  return nodes
}
const isComposerEditor = id => id === 'dock.quiet-composer.composer' || id === 'dock.composer'
/** The product roles the mounted painter commits onto the wire
 *  (`src/tui/tsp/quiet-composer-view.ts` QUIET_COMPOSER_ROLES). Selecting a
 *  candidate row by its ROLE is the authority: a row's own key ends in the
 *  Provider value, which for an I-D row carries dots (`src/deep.ts`), so no
 *  id-shaped pattern can name it. The row's name/description are CHILD nodes
 *  with their own roles, so this never matches those. */
const COMPLETION_MENU_ROLE = 'dsh.composer.completion-menu'
const COMPLETION_ITEM_ROLE = 'dsh.composer.completion-item'
const wireEditor = h => {
  const entry = [...wireFold(h).entries()].filter(([id, node]) => node.k === 'editor' && isComposerEditor(id)).at(-1)
  const props = entry?.[1]?.p
  if (props === undefined || typeof props.text !== 'string') return undefined
  return { id: entry[0], text: props.text, cursor: typeof props.cursor === 'number' ? props.cursor : 0, attrs: props }
}
/** The candidate rows of the CURRENT frame, addressed THROUGH the popup's own
 *  container node: the fold (subtree-aware `del`) keeps at most one
 *  `dsh.composer.completion-menu` node live, its revision is the seat's list
 *  revision, and a row is one of ITS OWN children. Nothing is selected by a
 *  dotted-id pattern and nothing is taken from a cumulative "any row ever
 *  added" set, so a stale frame's row can never satisfy or pollute an
 *  assertion (the scheme is recorded in `lane-ledger.json`). */
const wireMenus = h => [...wireFold(h).entries()]
  .filter(([, node]) => node.p?.role === COMPLETION_MENU_ROLE)
const currentWireMenu = h => wireMenus(h).sort(([left], [right]) => (Number(right.split('-').at(-1)) || 0)
  - (Number(left.split('-').at(-1)) || 0)).at(0)
const wireCompletionRows = h => {
  const menu = currentWireMenu(h)
  if (menu === undefined) return []
  const prefix = `${menu[0]}.`
  return [...wireFold(h).entries()]
    .filter(([id, node]) => id.startsWith(prefix) && node.k === 'el' && node.p?.role === COMPLETION_ITEM_ROLE)
    .map(([id, node]) => ({
      id,
      menu: menu[0],
      revision: Number(menu[0].split('-').at(-1)) || 0,
      highlighted: String(node.p?.attrs?.['data-highlight'] ?? '') === 'true',
      title: String(node.p?.title ?? ''),
    }))
}
const wireMenuCount = h => wireMenus(h).length
const wireEditorCount = h => [...wireFold(h).entries()]
  .filter(([id, node]) => node.k === 'editor' && isComposerEditor(id)).length

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
const statusNodes = snap => visibleNodes(snap).filter(node => hasClass(node, 'sf-status'))
const sendNode = snap => visibleNodes(snap).find(node => node.tag === 'button'
  && ['↑', 'Send', 'Stop'].includes(String(node.text ?? '')))
const pickerNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-picker'))
const overlayNode = snap => visibleNodes(snap).find(node => hasClass(node, 'sf-overlay'))
/** The client tree carries no wire ids and no custom `data-role`, so a painted
 *  candidate row is the `sf-el` button whose `title` the presenter set on the
 *  SAME production wire (`<provider value> — <description>`). The wire row list
 *  (`el` nodes under a `completion-…` key) is the authority for WHICH buttons
 *  are candidates: the I-D rows carry `@…`, a local path or `/image`, so no
 *  title-prefix heuristic can name them, and a window/chrome button or the
 *  composer's own control never matches a wire row title. */
const wireTitles = h => new Set(wireCompletionRows(h).map(row => row.title).filter(title => title !== ''))
const completionRows = (h, snap) => {
  const titles = wireTitles(h)
  return visibleNodes(snap).filter(node => node.tag === 'button'
    && hasClass(node, 'sf-el') && titles.has(String(node.title ?? '')))
}
const completionHintNode = snap => visibleNodes(snap).find(node => String(node.text ?? '') === HINT)
const chainOf = (snap, node) => snap.chains.get(node) ?? []
const parentOf = (snap, node) => {
  const chain = chainOf(snap, node)
  return chain.length < 2 ? undefined : chain[chain.length - 2]
}
const menuNodeOf = (snap, rows) => rows.length === 0 ? undefined : parentOf(snap, rows[0])
const rowName = row => String(row.title ?? '').split(' — ')[0]
const rowPaint = (h, row) => String(h.descendantsText(row))

const containsBox = (outer, inner, slack = 0.5) => outer !== undefined && inner !== undefined
  && outer[2] > 0 && inner[2] > 0
  && inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack
  && inner[0] + inner[2] <= outer[0] + outer[2] + slack
  && inner[1] + inner[3] <= outer[1] + outer[3] + slack
const boxIntersects = (a, b) => a !== undefined && b !== undefined
  && a[2] > 0 && b[2] > 0
  && a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
  && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
const centreOf = box => ({ x: Math.round(box[0] + box[2] / 2), y: Math.round(box[1] + box[3] / 2) })

/** `ctl pick` — what the client REALLY has at a point. */
const pickAt = (h, point, label) => {
  try {
    const reply = h.ctl('pick', point.x, point.y)
    if (reply === undefined || reply.ok === false || typeof reply.path !== 'string') {
      h.measure(`pick ${label} NOT_VERIFIED`, JSON.stringify(reply))
      return undefined
    }
    return { ...reply, at: point, label }
  } catch (error) {
    h.measure(`pick ${label} NOT_VERIFIED`, `${String(error)} :: the control channel refused the read`)
    return undefined
  }
}

/** One candidate row's full dossier: the oracle numbers (kept, because the
 *  guide's rule is that they exist and are reported), the REAL clip chain, and
 *  the client's own hit test at the row centre.
 *
 *  A row counts as SHOWN when the part that must survive — the command NAME the
 *  user is about to accept — lies inside every real clip and the client's own
 *  hit test at the row centre returns the row's subtree. Whether the whole row
 *  box (its description included) fits inside the popup is reported separately
 *  as `boxOverflowsRealClips`, because that is exactly what the long-candidate
 *  line case has to record instead of asserting. */
const rowDossier = (h, snap, row, menuBox, pickIt) => {
  const box = rect(row)
  const chain = chainOf(snap, row).slice(0, -1)
  // The real clip chain: the popup's own scroller (the documented CSS clip) and
  // every ancestor that actually contains the popup. The ancestors that do NOT
  // contain it are the ones the popup intentionally overflows (the Composer
  // shell and the Dock region), and the oracle counts them — which is why
  // `oracleContainedXY` is false for every row while the PNG shows them painted.
  const realClips = chain.filter(node => menuBox === undefined || containsBox(rect(node), menuBox))
  const inside = target => realClips.every(node => containsBox(rect(node), target))
  // The leading NAME span of the row: the painter emits `›<value>` or
  // `<value>`, where the value is `/command`, `@mention`, `shots/photo.png` or
  // the inline action — the first non-space run of the row's own text.
  const nameSpan = (row.children ?? []).find(node => /^\s*›?\S/u.test(String(node.text ?? '')))
  const nameBox = nameSpan === undefined ? box : rect(nameSpan)
  // The SAME geometry oracle (`visibleSpan`/`containedXY` from
  // tern-pane-geometry.mjs), applied to the REAL clip chain instead of every
  // sized ancestor, reports how much of the leading command NAME survives. The
  // full-chain numbers are kept in `oracleSpanY`/`oracleContainedXY` above: the
  // guide's over-approximation is a fact, not something this lane hides.
  const nameNode = { rect: nameBox, children: [] }
  const realChains = new Map([[nameNode, [...realClips, nameNode]]])
  const nameVisibleSpanX = visibleSpan(realChains, nameNode, 'x')
  const nameVisibleSpanY = visibleSpan(realChains, nameNode, 'y')
  const nameContainedXY = containedXY(realChains, nameNode)
  const hit = pickIt === false || box[2] <= 0 || box[3] <= 0
    ? undefined
    : pickAt(h, centreOf(box), `row ${rowName(row)}`)
  const hitOwnSubtree = hit === undefined ? false : containsBox(box, hit.rect ?? [0, 0, 0, 0])
  // Does the row stay inside the popup's OWN frame? The production stylesheet
  // gives the menu `left:12/right:12` and the description `text-overflow:
  // ellipsis`, so a row whose box runs past the menu's right edge means the
  // client painted the text OUTSIDE its own popup frame. That is a claim, not a
  // footnote, so it is reported as its own field.
  const escapesMenuX = menuBox === undefined ? null
    : box[0] + box[2] > menuBox[0] + menuBox[2] + 0.5
  return {
    name: rowName(row),
    paint: rowPaint(h, row),
    highlighted: rowPaint(h, row).startsWith('›'),
    rect: box,
    nameRect: nameBox,
    oracleContainedXY: containedXY(snap.chains, row),
    oracleSpanY: visibleSpan(snap.chains, row, 'y'),
    realClipChain: realClips.map(node => `${node.tag}.${nodeClass(node)[0] ?? ''}`),
    nameVisibleSpanX,
    nameVisibleSpanY,
    nameContainedXY,
    boxInsideRealClips: inside(box),
    nameInsideRealClips: inside(nameBox),
    boxOverflowsRealClips: !inside(box),
    escapesMenuX,
    pickPath: hit?.path ?? null,
    pickRect: hit?.rect ?? null,
    hitOwnSubtree,
    shown: box[2] > 0 && box[3] > 0 && inside(nameBox) && nameContainedXY
      && nameVisibleSpanX > 4 && nameVisibleSpanY > 4 && hitOwnSubtree,
  }
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
const editorFacts = h => {
  const snap = h.snapshot()
  const editor = editorNode(snap)
  const caret = caretNode(snap)
  const wire = wireEditor(h)
  return {
    text: wire?.text ?? String(editorTextNode(snap)?.text ?? ''),
    cursor: wire?.cursor,
    wireId: wire?.id,
    wireAvailable: wire !== undefined,
    focused: editor !== undefined && hasClass(editor, 'focused'),
    editorRect: editor === undefined ? undefined : rect(editor),
    caretRect: caret === undefined ? undefined : rect(caret),
    caretX: caret === undefined ? undefined : rect(caret)[0],
    caretY: caret === undefined ? undefined : rect(caret)[1],
  }
}
const checkDraft = (h, label, expected) => {
  const actual = editorFacts(h)
  h.check(label, actual.text === expected, JSON.stringify({ expected, actual }))
  return actual
}
/** The real-key route first (closest to typing); the control `commit` text
 *  insert is the proven fallback, and which one delivered is a recorded fact. */
const inputChannel = { kind: 'UNSET' }
const typeText = async (h, text) => {
  const before = editorFacts(h)
  try {
    await h.key(text, 350)
    const after = editorFacts(h)
    if (after.text === before.text + text) {
      if (inputChannel.kind === 'UNSET') {
        inputChannel.kind = 'ctl key'
        h.measure('text input channel', `ctl key ${JSON.stringify(text)} inserted the text (CONTROL_INJECTED_INPUT, control-injected)`)
      }
      return after
    }
  } catch (error) {
    h.measure(`ctl key ${JSON.stringify(text)} refused`, String(error))
  }
  h.send('commit', JSON.stringify(text))
  await h.sleep(400)
  const after = editorFacts(h)
  if (inputChannel.kind === 'UNSET') {
    inputChannel.kind = 'ctl commit'
    h.measure('text input channel', `ctl key ${JSON.stringify(text)} did NOT insert; the control \`commit\` path did (CONTROL_INJECTED_INPUT, control-injected)`)
  }
  return after
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
/** Clear through the production composer port, type `text` for real, and wait
 *  until the anchored popup paints the rows this position answers with. */
const queryDraft = async (h, label, text, { pick = true } = {}) => {
  await sendCase(h, 'clear')
  const typed = await typeText(h, text)
  const painted = await waitUntil(h, `${label}: the candidate list painted`, () => completionRows(h, h.snapshot()).length > 0,
    { limit: 40, intervalMs: 150 })
  const snap = h.snapshot()
  const rows = completionRows(h, snap)
  return { typed, painted, snap, rows, menu: menuNodeOf(snap, rows) }
}
/** The I-C case helper: the first-line slash query is one specialisation. */
const querySlash = (h, label, options = {}) => queryDraft(h, label, '/', options)
/** The SDK's own outbound frame count: the witness for the single-frame rule.
 *  A successful accept commits the popup withdrawal AND the text change in the
 *  ONE frame the composer already fires, so a second frame here is a defect. */
const frameCount = h => wireRecords(h).filter(line => line.dir === 'out' && line.verb === 'f').length
/** Every production fact this lane counts, read back from the subject's record. */
const counters = h => {
  const all = records(h)
  const countOf = kind => all.filter(entry => entry.kind === kind).length
  return {
    keyArrived: countOf('key.arrived'),
    applyKey: countOf('composer.applyKey'),
    applyCompletionEdit: countOf('composer.applyCompletionEdit'),
    replaceFragment: countOf('composer.replaceInlineAttachmentFragment'),
    insertIntoEditor: countOf('composer.insertIntoEditor'),
    stagerCalls: countOf('stager.call'),
    hostReferences: countOf('host.references'),
    clientListDirectory: countOf('client.listDirectory'),
    clientFind: countOf('client.find'),
    storeImageAdd: countOf('store.image.add'),
    storeFileAdd: countOf('store.file.add'),
    handlerSubmit: countOf('handler.submit'),
    handlerCancel: countOf('handler.cancel'),
    writerPrompt: countOf('writer.prompt'),
    notices: countOf('display.notify'),
    frames: frameCount(h),
  }
}
const counterDelta = (before, after, ...keys) => Object.fromEntries(
  keys.map(key => [key, after[key] - before[key]]))
/** A case's OWN new records of one kind: everything the subject wrote after the
 *  count this case took BEFORE its gesture. An earlier case's store entry or
 *  notice can never satisfy (or pollute) a later case's claim. */
const newOf = (h, kind, beforeCount) => records(h).filter(entry => entry.kind === kind).slice(beforeCount)
/** The live list's own highlighted row (exactly one while a popup is open). */
const highlightedTitle = h => {
  const lit = wireCompletionRows(h).filter(row => row.highlighted)
  return lit.length === 1 ? lit[0].title : undefined
}
/** Walk the OPEN list until the highlighted row satisfies `want` (bounded: the
 *  painted window is at most the seat's row ceiling, so a walk that has not
 *  landed inside that bound is a failure the caller reports, not a wait). */
const walkTo = async (h, label, want, limit = 8) => {
  const steps = []
  for (let walked = 0; walked < limit; walked += 1) {
    const title = highlightedTitle(h)
    if (want(title)) return { title, steps }
    steps.push(title)
    await h.key('ArrowDown', 350)
  }
  h.log(`WAIT-FAIL walk to ${label} landed on ${JSON.stringify(highlightedTitle(h))}`)
  return { title: highlightedTitle(h), steps, failed: true }
}
const writeLedger = (h, name, value) => {
  const path = join(h.root, name)
  writeFileSync(path, `${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}\n`)
  h.measure(`artifact ${name}`, path)
  return path
}
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
const layoutOf = (h, captureId, out) => readJson(join(out, 'shots', 'serve', `${captureId}.layout.json`))
const finish = (h, extra = {}) => {
  const status = h.finish(extra)
  if (status !== 0) process.exitCode = status
}

export default async function (h) {
  const out = h.root
  const subject = join(h.repo, 'scripts', 'tern-pane-input-completion-subject.mts')
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

  await h.resize(1280, 800)
  writeFileSync(join(out, 'case'), '')
  h.check('the production Direct/TSP subject launches in the real Tern pane',
    await h.launch(subject, { ready: 'dsh-pi-tui' }))
  if (!await requiredWait(h, 'the official Direct fixture, the production renderer, the real catalog commit and the recall seed are ready', () =>
    records(h).some(entry => entry.kind === 'fixture.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'renderer.ready' && entry.rendererObserved === true)
    && records(h).some(entry => entry.kind === 'catalog.install' && entry.count > 0)
    && records(h).some(entry => entry.kind === 'seam.resetInputHistory'
      && JSON.stringify(entry.entries) === JSON.stringify(RECALL)
      && (entry.owner === SESSION_A || entry.owner === undefined))
    && h.classNodes(h.snapshot(), 'sf-region').length > 0,
    { limit: 240 })) {
    finish(h, { tern: ternVersion, sdk: { pin: sdkPin, integrity } })
    return
  }
  const subjectReady = records(h).find(entry => entry.kind === 'subject.ready')
  const productionInstall = records(h).find(entry => entry.kind === 'catalog.install'
    && entry.count > 0 && entry.callSites.some(line => /src[/\\]commands\.(ts|mjs)/u.test(line)))
  const seamReset = records(h).find(entry => entry.kind === 'seam.resetInputHistory'
    && JSON.stringify(entry.entries) === JSON.stringify(RECALL)
    && (entry.owner === SESSION_A || entry.owner === undefined))
  const catalog = productionInstall?.names ?? []
  h.measure('recall boot seed', JSON.stringify({
    owner: seamReset?.owner ?? null,
    policy: 'the subject seeds the production JSONL store; the flow accepts either the sessionless boot seed or the Session A hydration reseed, both through display.resetInputHistory',
  }))
  h.measure('subject capabilities', JSON.stringify(subjectReady?.caps))
  h.check('the shipped SDK capabilities cover the TSP editor, pickers, el and styles',
    ['editor', 'picker', 'overlay', 'input', 'el'].every(kind => subjectReady?.caps?.kinds?.includes(kind))
    && ['styles', 'flow', 'dock'].every(feature => subjectReady?.caps?.features?.includes(feature)),
    JSON.stringify(subjectReady?.caps))
  h.check('three newest-first history rows were committed through the production display seam',
    seamReset?.entries?.length === 3 && JSON.stringify(seamReset.entries) === JSON.stringify(RECALL)
    && seamReset?.newestFirst === true, JSON.stringify(seamReset))
  h.check('the slash catalog arrived through the mount install port from the real command layer',
    productionInstall !== undefined && catalog.length > 0, JSON.stringify(productionInstall))
  writeLedger(h, 'environment.json', {
    ternVersion, sdkPin, integrity, caps: subjectReady?.caps, seamReset, productionInstall,
    catalogCount: catalog.length, catalog,
  })
  h.capture('00-empty-composer-1280x800-light', 'the production Direct composer before any query')

  // ── 1. The natural `/` query paints the list and changes NOTHING else ─────
  const submitsAtStart = kindCount(h, 'handler.submit')
  const promptsAtStart = kindCount(h, 'writer.prompt')
  const writesAtStart = kindCount(h, 'composer.applyCompletionEdit')
  checkDraft(h, 'the composer starts empty', '')
  const natural = await querySlash(h, 'natural / query')
  h.check('the natural `/` query reached the composer as a real draft change',
    natural.typed.text === '/' && natural.typed.cursor === 1 && natural.painted,
    JSON.stringify({ typed: natural.typed, painted: natural.painted }))
  const naturalRows = completionRows(h, natural.snap)
  const naturalNames = naturalRows.map(row => rowName(row))
  const naturalWireRows = wireCompletionRows(h)
  const highlightedNodes = naturalRows.filter(row => rowPaint(h, row).startsWith('›'))
  h.check('the popup paints at most six candidate rows plus one hint row',
    naturalRows.length > 0 && naturalRows.length <= 6 && completionHintNode(natural.snap) !== undefined,
    JSON.stringify({ rows: naturalRows.length, hint: completionHintNode(natural.snap) === undefined ? null : rect(completionHintNode(natural.snap)) }))
  h.check('the painted rows are the installed catalog, in provider order, with no second list',
    naturalNames.every(name => catalog.includes(name.slice(1))) && naturalNames.length === naturalWireRows.length,
    JSON.stringify({ painted: naturalNames, catalog: catalog.slice(0, 8), wireRows: naturalWireRows.length }))
  h.check('the default highlight is the FIRST row and exactly one row carries it',
    highlightedNodes.length === 1 && naturalWireRows.filter(row => row.highlighted).length === 1
    && rowPaint(h, highlightedNodes[0]) === rowPaint(h, naturalRows[0]),
    JSON.stringify({ painted: naturalRows.map(row => rowPaint(h, row)).map(text => text.slice(0, 24)), wireHighlight: naturalWireRows.filter(row => row.highlighted).length }))
  const afterPaint = editorFacts(h)
  h.check('painting the list leaves the editor `text`/`cursor` props exactly what the user typed',
    afterPaint.text === '/' && afterPaint.cursor === 1, JSON.stringify({ typed: natural.typed, afterPaint }))
  h.check('painting the list wrote nothing and submitted nothing',
    kindCount(h, 'composer.applyCompletionEdit') === writesAtStart
    && kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ writes: kindCount(h, 'composer.applyCompletionEdit'), submits: kindCount(h, 'handler.submit') }))
  h.check('the popup never adds a second composer input',
    wireEditorCount(h) === 1, JSON.stringify({ editors: wireEditorCount(h) }))
  h.measure('the popup overflow vs the oracle', JSON.stringify({
    menuRect: natural.menu === undefined ? undefined : rect(natural.menu),
    dockRect: dockNode(natural.snap) === undefined ? undefined : rect(dockNode(natural.snap)),
    row0Oracle: { containedXY: containedXY(natural.snap.chains, naturalRows[0]), spanY: visibleSpan(natural.snap.chains, naturalRows[0], 'y') },
    note: 'the list is an absolutely positioned child of the Composer shell that overflows the Dock region upward by design; the oracle treats every sized ancestor as a clip, so these numbers are the documented over-approximation, and ctl pick + the PNG are the client authority',
  }))
  safeLayersMeasure(h)
  h.capture('01-slash-popup-1280x800-light', 'the natural `/` query, default highlight on the first row')
  writeLedger(h, 'natural-query.json', {
    catalogCount: catalog.length, painted: naturalNames,
    paint: naturalRows.map(row => rowPaint(h, row)), wireRows: naturalWireRows,
    hintRect: completionHintNode(natural.snap) === undefined ? undefined : rect(completionHintNode(natural.snap)),
    menuRect: natural.menu === undefined ? undefined : rect(natural.menu),
    before: natural.typed, afterPaint,
  })

  // ── 2. ↑/↓ and Tab/Shift+Tab walk the list; the draft never moves ─────────
  const walk = []
  for (const step of ['ArrowDown', 'ArrowUp', 'ArrowUp', 'Tab', 'Shift+Tab']) {
    const keysBefore = kindCount(h, 'composer.applyKey')
    const arrivalsBefore = kindCount(h, 'key.arrived')
    const draft = editorFacts(h)
    await h.key(step, 450)
    const after = editorFacts(h)
    const snap = h.snapshot()
    const rows = completionRows(h, snap)
    const lit = rows.filter(row => rowPaint(h, row).startsWith('›'))
    const index = lit.length === 0 ? -1 : rows.indexOf(lit[0])
    walk.push({ step, highlightIndex: index, painted: rows.length, totalCatalog: catalog.length })
    h.check(`${step} walks the open list, never edits the draft and never reaches the composer reducer`,
      lit.length === 1 && index >= 0 && rows.length === naturalRows.length
      && after.text === '/' && after.cursor === 1
      && kindCount(h, 'composer.applyKey') === keysBefore
      && kindCount(h, 'key.arrived') === arrivalsBefore + 1,
      JSON.stringify({ step, index, rows: rows.length, draft, after, applyKeys: kindCount(h, 'composer.applyKey') }))
  }
  h.check('walking wraps past the ends of the list (↑ from the first row reaches the last)',
    walk.some(entry => entry.highlightIndex === naturalRows.length - 1) && walk.some(entry => entry.highlightIndex === 0),
    JSON.stringify(walk))
  h.check('no walk gesture wrote the draft or submitted anything',
    kindCount(h, 'composer.applyCompletionEdit') === writesAtStart
    && kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ writes: kindCount(h, 'composer.applyCompletionEdit'), submits: kindCount(h, 'handler.submit') }))
  h.capture('02-slash-walk-1280x800-light', 'the highlight walked by real ArrowDown/ArrowUp/Tab/Shift+Tab')
  writeLedger(h, 'arrow-walk.json', { painted: naturalNames, totalCatalog: catalog.length, walk })

  // ── 3. A plain Enter completes the name and is NOT a submission ───────────
  await querySlash(h, 'enter case reopen')
  const enterTarget = rowName(completionRows(h, h.snapshot())[0])
  const enterKeys = kindCount(h, 'composer.applyKey')
  await h.key('Enter', 600)
  const completed = editorFacts(h)
  const writeRecord = lastKind(h, 'composer.applyCompletionEdit')
  const afterEnterRows = completionRows(h, h.snapshot())
  h.check('a plain Enter writes ONLY the command name into the composer',
    completed.text === `${enterTarget} ` && completed.cursor === completed.text.length,
    JSON.stringify({ expected: `${enterTarget} `, completed }))
  h.check('the accept is the composer ONE conditional completion write, and it was accepted',
    writeRecord?.accepted === true && writeRecord?.next?.text === `${enterTarget} `
    && kindCount(h, 'composer.applyCompletionEdit') === writesAtStart + 1, JSON.stringify(writeRecord))
  h.check('the accepted frame carries no stale candidate list',
    afterEnterRows.length === 0, JSON.stringify({ rows: afterEnterRows.map(row => rowName(row)) }))
  h.check('a plain Enter on a highlighted candidate is never a submission',
    kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ submits: kindCount(h, 'handler.submit'), prompts: kindCount(h, 'writer.prompt'), writeRecord }))
  h.check('the Enter the list consumed never re-entered the composer reducer',
    kindCount(h, 'composer.applyKey') === enterKeys, JSON.stringify({ enterKeys, now: kindCount(h, 'composer.applyKey') }))
  h.capture('03-slash-enter-completed-1280x800-light', `the composer holds ${JSON.stringify(completed.text)} after the list-consuming Enter`)
  // ── 4. A control-injected click completes the row it names, once ─────────
  const clicked = await querySlash(h, 'click case')
  const clickTarget = clicked.rows[1] ?? clicked.rows[0]
  const clickKeys = kindCount(h, 'composer.applyKey')
  const writesBeforeClick = kindCount(h, 'composer.applyCompletionEdit')
  const eventsBefore = kindCount(h, 'client.event')
  const clickedName = rowName(clickTarget)
  const point = centreOf(rect(clickTarget))
  await h.clickAt(point.x, point.y, 900)
  const clickDraft = editorFacts(h)
  const clickWrite = lastKind(h, 'composer.applyCompletionEdit')
  const clientEvents = records(h).filter(entry => entry.kind === 'client.event')
  h.measure('the client events around a control-injected click', JSON.stringify({
    before: eventsBefore, after: kindCount(h, 'client.event'), events: clientEvents.slice(-4),
    note: 'MEASURED against the pinned SDK: Session dispatches a node\'s own handler inside the CLIENT (surface.dispatch -> onClick) and does NOT forward a handled action to the program input loop, so the click\'s positive control is the mount\'s ONE conditional completion write below, not an event the loop never sees',
  }))
  h.check('a control-injected click on a visible candidate row completes THAT row and submits nothing',
    clickDraft.text === `${clickedName} ` && clickDraft.cursor === clickDraft.text.length
    && clickWrite?.accepted === true && clickWrite?.next?.text === `${clickedName} `
    && kindCount(h, 'composer.applyCompletionEdit') === writesBeforeClick + 1
    && kindCount(h, 'handler.submit') === submitsAtStart && kindCount(h, 'writer.prompt') === promptsAtStart
    && kindCount(h, 'composer.applyKey') === clickKeys,
    JSON.stringify({ point, clickedName, clickDraft, clickWrite, submits: kindCount(h, 'handler.submit') }))
  h.capture('04-slash-row-click-1280x800-light', `the row at ${JSON.stringify(point)} completed by a control-injected click`)
  writeLedger(h, 'row-click.json', { point, clickedName, clickDraft, clickWrite })
  // The click moved the client's focus to the row's button; the lane continues
  // with keys, so the composer seat must be back in focus — proven, not assumed.
  const editorPoint = centreOf(rect(editorNode(h.snapshot())))
  await h.clickAt(editorPoint.x, editorPoint.y, 700)
  h.check('a control-injected click back into the editor restores the composer focus the keys need',
    editorFacts(h).focused, JSON.stringify({ editorPoint, after: editorFacts(h) }))

  // ── 5. Escape closes ONLY the list; the next Escape reaches cancel ───────
  const reopened = await querySlash(h, 'escape case')
  h.check('the list is open for the Escape case', reopened.rows.length > 0 && reopened.typed.text === '/',
    JSON.stringify({ typed: reopened.typed, rows: reopened.rows.length }))
  const cancelsBefore = kindCount(h, 'handler.cancel')
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  const escapedDraft = editorFacts(h)
  h.check('Escape with the list open closes the list and leaves the draft untouched',
    completionRows(h, h.snapshot()).length === 0 && escapedDraft.text === '/' && escapedDraft.cursor === 1,
    JSON.stringify({ escapedDraft }))
  h.check('Escape with the list open records NO cancel',
    kindCount(h, 'handler.cancel') === cancelsBefore,
    JSON.stringify({ before: cancelsBefore, after: kindCount(h, 'handler.cancel') }))
  await h.key('Escape', 500)
  await h.sleep(300)
  h.check('Escape with the list closed still reaches the existing cancel owner exactly once',
    kindCount(h, 'handler.cancel') === cancelsBefore + 1,
    JSON.stringify({ before: cancelsBefore, after: kindCount(h, 'handler.cancel') }))
  const afterCancels = editorFacts(h)
  h.check('the cancel-route Escape did not edit the draft', afterCancels.text === '/', JSON.stringify(afterCancels))
  h.capture('05-escape-closes-list-1280x800-light', 'the list closed by Escape, the draft untouched')
  writeLedger(h, 'escape-cancel.json', { cancelsBefore, cancelsAfter: kindCount(h, 'handler.cancel'), escapedDraft, afterCancels })

  // ── 6. With the list closed, ↑ is still the I-B history recall ───────────
  const seed = await sendCase(h, 'recall-seed')
  const seededReset = lastKind(h, 'seam.resetInputHistory')
  h.check('the recall rows were re-seeded through the production display seam',
    seed?.seeded === true && JSON.stringify(seededReset?.entries) === JSON.stringify(RECALL)
    && seededReset?.owner === SESSION_A, JSON.stringify({ seed, seededReset }))
  const recallQuery = await querySlash(h, 'recall case')
  h.check('the recall case starts with the list open', recallQuery.rows.length > 0, JSON.stringify(recallQuery.typed))
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  h.check('the recall case continues with the list CLOSED', completionRows(h, h.snapshot()).length === 0, '')
  await h.key('ArrowUp', 450)
  const lineHome = editorFacts(h)
  h.check('with the list closed the first ↑ is still the I-B line-home move, not a recall',
    lineHome.text === '/' && lineHome.cursor === 0 && completionRows(h, h.snapshot()).length === 0, JSON.stringify(lineHome))
  await h.key('ArrowUp', 450)
  const recalled = editorFacts(h)
  h.check('with the list closed the next ↑ performs the I-B history recall',
    recalled.text === RECALL[0] && completionRows(h, h.snapshot()).length === 0, JSON.stringify({ expected: RECALL[0], recalled }))
  await h.key('ArrowDown', 450)
  const restoredDraft = editorFacts(h)
  h.check('↓ leaving the recall restores the exact draft the browse replaced',
    restoredDraft.text === '/', JSON.stringify(restoredDraft))
  h.capture('06-slash-closed-arrow-recall-1280x800-light', 'the I-B recall still owns ↑ once the candidate list is closed')
  writeLedger(h, 'recall-after-close.json', { seed, seededReset, lineHome, recalled, restoredDraft })

  // ── 7. A catalog re-install withdraws a removed command ──────────────────
  const beforeWithdraw = await querySlash(h, 'withdraw case')
  const beforeNames = beforeWithdraw.rows.map(row => rowName(row))
  h.check('the withdrawal case starts from a multi-row real catalog', beforeNames.length >= 2, JSON.stringify(beforeNames))
  const reduce = await sendCase(h, 'catalog-reduce')
  const withdrawn = reduce?.withdrawn ?? ''
  await h.sleep(ABSENCE_WINDOW_MS)
  const withdrawnRows = completionRows(h, h.snapshot())
  h.check('a catalog re-commit withdraws the current list at once',
    reduce?.committed === true && withdrawnRows.length === 0, JSON.stringify({ reduce, rows: withdrawnRows.length }))
  h.check('the re-commit names the command it withdrew and that command was the row the popup showed',
    withdrawn !== '' && beforeNames[0] === `/${withdrawn}`, JSON.stringify({ reduce, beforeNames, withdrawn }))
  const afterWithdraw = await querySlash(h, 'withdraw case requery')
  const afterNames = afterWithdraw.rows.map(row => rowName(row))
  h.check('the next query shows only the new source: the withdrawn command is gone',
    withdrawn !== '' && afterNames.length > 0 && !afterNames.includes(`/${withdrawn}`) && afterNames[0] === beforeNames[1],
    JSON.stringify({ beforeNames, afterNames, withdrawn }))
  const withdrawalDraft = editorFacts(h)
  h.check('the withdrawal and the re-query never wrote the draft and never submitted',
    withdrawalDraft.text === '/' && kindCount(h, 'handler.submit') === submitsAtStart, JSON.stringify(withdrawalDraft))
  const restore = await sendCase(h, 'catalog-restore')
  await h.sleep(300)
  h.check('the production catalog is re-committed through the same mount port, byte-identical names',
    restore?.committed === true && JSON.stringify(restore.names) === JSON.stringify(catalog), JSON.stringify(restore))
  h.capture('07-catalog-withdrawal-1280x800-light', `after the re-commit that withdrew ${JSON.stringify(withdrawn)}`)
  writeLedger(h, 'catalog-withdrawal.json', { beforeNames, reduce, afterNames, restore })

  // ── 8. A higher composer control takes the keys; the list is gone ────────
  const opened = await querySlash(h, 'higher seat')
  // Captured AFTER the query: the `/` keystroke itself is one composer reducer
  // call, and the claim below is that the MENU'S keys add no further one.
  const seatBefore = editorFacts(h)
  const seatApplyKeys = kindCount(h, 'composer.applyKey')
  h.check('the slash list is open before the higher control takes the keys',
    opened.rows.length > 0, JSON.stringify(opened.typed))
  // The Permission trigger is measured first: an absent roster is a composition
  // fact, and this lane must not claim a control it cannot really open.
  const permissionTrigger = h.snapshot().nodes.find(node => node.tag === 'button'
    && String(node.title ?? '').startsWith('Permission'))
  h.measure('the Permission trigger in this composition', JSON.stringify({
    present: permissionTrigger !== undefined, title: permissionTrigger?.title ?? null,
    roster: records(h).filter(entry => entry.kind === 'handler.permissionOptions').at(-1)?.roster ?? 'handler absent',
    verdict: permissionTrigger !== undefined && !String(permissionTrigger.title ?? '').includes('not selectable')
      ? 'interactive' : 'NOT interactive in this composition: the higher control used below is the production Model/Effort quick menu',
  }))
  const seatOpen = await sendCase(h, 'seat-open')
  const menuOpened = await waitUntil(h, 'the production quick menu owns the keys', () => {
    const snap = h.snapshot()
    return pickerNode(snap) !== undefined || overlayNode(snap) !== undefined
      || h.texts(snap).some(text => String(text).includes('All models & details') || String(text).includes('Scripted Model'))
  }, { limit: 40, intervalMs: 150 })
  const menuSnap = h.snapshot()
  h.check('the production quick menu became visible and the slash list is gone',
    menuOpened && seatOpen?.opened === true && completionRows(h, menuSnap).length === 0 && completionHintNode(menuSnap) === undefined,
    JSON.stringify({ seatOpen, completionRows: completionRows(h, menuSnap).length, hint: completionHintNode(menuSnap) === undefined ? null : rect(completionHintNode(menuSnap)) }))
  for (const step of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter']) {
    await h.key(step, 450)
    const after = editorFacts(h)
    h.check(`${step} while the quick menu owns the keys reaches neither the composer nor a submit, and no list comes back`,
      after.text === seatBefore.text && after.cursor === seatBefore.cursor
      && kindCount(h, 'composer.applyKey') === seatApplyKeys
      && kindCount(h, 'handler.submit') === submitsAtStart && completionRows(h, h.snapshot()).length === 0,
      JSON.stringify({ step, seatBefore, after, applyKeys: kindCount(h, 'composer.applyKey') }))
  }
  h.capture('08-higher-seat-1280x800-light', 'the quick menu owns the keys; the slash list is gone')
  await h.key('Escape', 500)
  await sendCase(h, 'seat-close')
  const afterSeat = editorFacts(h)
  h.check('the composer draft and caret survive the higher control exactly',
    afterSeat.text === seatBefore.text && afterSeat.cursor === seatBefore.cursor, JSON.stringify({ seatBefore, afterSeat }))
  const reacquired = await querySlash(h, 'seat released requery')
  h.check('after the higher control closes, the slash seat is admitted again',
    reacquired.rows.length > 0, JSON.stringify({ rows: reacquired.rows.length }))
  writeLedger(h, 'higher-seat.json', { seatBefore, seatOpen, afterSeat, rowsAfterRelease: reacquired.rows.length })

  // ── 9. The exact product sequence on a SAFE scripted catalog ─────────────
  // A plain Enter on the highlighted candidate writes ONLY the command name;
  // the NEXT Enter is the real submit. Both are real control-injected keys; the
  // business submit count is read back from the subject's OWN events.jsonl.
  // The catalog is scripted to a command the Direct runner does not execute, so
  // the submit has no command side effect that could move the later cases.
  const single = await sendCase(h, 'catalog-single')
  h.check('the scripted single-command catalog committed through the mount install port',
    single?.committed === true && JSON.stringify(single.names) === JSON.stringify(['evidence-probe']), JSON.stringify(single))
  // The single-candidate Tab branch first: it also writes ONLY the name and
  // never submits. It is re-queried below for the exact plain-Enter sequence.
  const tabQuery = await querySlash(h, 'single candidate tab')
  h.check('the single-candidate Tab case starts from exactly one highlighted row',
    tabQuery.rows.length === 1 && rowPaint(h, tabQuery.rows[0]).startsWith('›'),
    JSON.stringify(tabQuery.rows.map(row => rowName(row))))
  const tabWrites = kindCount(h, 'composer.applyCompletionEdit')
  const tabSubmitAtStart = kindCount(h, 'handler.submit')
  await h.key('Tab', 600)
  const tabbed = editorFacts(h)
  h.check('with one candidate a Tab writes ONLY the command name and submits nothing',
    tabbed.text === '/evidence-probe ' && tabbed.cursor === tabbed.text.length
    && kindCount(h, 'composer.applyCompletionEdit') === tabWrites + 1
    && kindCount(h, 'handler.submit') === tabSubmitAtStart && kindCount(h, 'writer.prompt') === promptsAtStart,
    JSON.stringify({ tabbed, writes: kindCount(h, 'composer.applyCompletionEdit') }))
  writeLedger(h, 'single-candidate-tab.json', {
    tabbed, tabSubmitAtStart, submitsAfter: kindCount(h, 'handler.submit'),
  })
  const singleQuery = await querySlash(h, 'plain enter candidate')
  h.check('a single-candidate query paints exactly one row with the default highlight',
    singleQuery.rows.length === 1 && rowName(singleQuery.rows[0]) === '/evidence-probe'
    && rowPaint(h, singleQuery.rows[0]).startsWith('›'),
    JSON.stringify({ painted: singleQuery.rows.map(row => rowName(row)) }))
  const plainWrites = kindCount(h, 'composer.applyCompletionEdit')
  const plainSubmitAtStart = kindCount(h, 'handler.submit')
  const plainPromptsAtStart = kindCount(h, 'writer.prompt')
  await h.key('Enter', 600)
  const plainCompleted = editorFacts(h)
  const plainWrite = lastKind(h, 'composer.applyCompletionEdit')
  h.check('a plain Enter changes ONLY the composer text/caret (the completed name), and the recorded business submit count stays 0',
    plainCompleted.text === '/evidence-probe ' && plainCompleted.cursor === plainCompleted.text.length
    && plainWrite?.accepted === true && kindCount(h, 'composer.applyCompletionEdit') === plainWrites + 1
    && kindCount(h, 'handler.submit') === plainSubmitAtStart && kindCount(h, 'writer.prompt') === plainPromptsAtStart,
    JSON.stringify({ plainCompleted, plainWrite, submits: kindCount(h, 'handler.submit') }))
  await h.key('Enter', 1500)
  const handedOver = await requiredWait(h, 'the NEXT Enter hands the draft to the application submit owner exactly once', () =>
    kindCount(h, 'handler.submit') === plainSubmitAtStart + 1, { limit: 60 })
  const submitRecord = lastKind(h, 'handler.submit')
  h.check('the NEXT Enter submits exactly once',
    handedOver && submitRecord?.text === '/evidence-probe ' && String(submitRecord?.request) === 'enter'
    && kindCount(h, 'handler.submit') === plainSubmitAtStart + 1,
    JSON.stringify({ submitRecord, plainSubmitAtStart, submits: kindCount(h, 'handler.submit') }))
  h.measure('what the application did with the submitted line', JSON.stringify({
    writerPromptDelta: kindCount(h, 'writer.prompt') - plainPromptsAtStart,
    lastPrompt: records(h).filter(entry => entry.kind === 'writer.prompt').at(-1)?.message?.content ?? null,
  }))
  h.capture('09-next-enter-submits-1280x800-light', 'the real submit that follows the plain completing Enter')
  writeLedger(h, 'plain-enter-next-enter-submits.json', {
    single, plainCompleted, plainWrite, submitRecord,
    submitsBefore: plainSubmitAtStart, submitsAfter: kindCount(h, 'handler.submit'),
    promptsBefore: plainPromptsAtStart, promptsAfter: kindCount(h, 'writer.prompt'),
  })

  // ── 10. A long candidate line: what the client REALLY does (measure) ─────
  const restore1 = await sendCase(h, 'catalog-restore')
  h.check('the production catalog is restored before the long-line case',
    restore1?.committed === true, JSON.stringify(restore1))
  const longCase = await sendCase(h, 'catalog-long')
  const longQuery = await querySlash(h, 'long candidate')
  const longMenuBox = longQuery.menu === undefined ? undefined : rect(longQuery.menu)
  const longRows = longQuery.rows.map(row => rowDossier(h, longQuery.snap, row, longMenuBox, true))
  h.measure('long candidate line', JSON.stringify({
    names: longCase?.names ?? null, longName: longCase?.longName ?? null,
    menuRect: longMenuBox, editorRect: rect(editorNode(longQuery.snap)),
    rows: longRows.map(row => ({ name: row.name, rect: row.rect, paintLength: row.paint.length, shown: row.shown, pickPath: row.pickPath })),
    verdict: 'soft-wrapped visual rows are NOT implemented by this milestone (the contract is hard-newline logical lines); this records how the client painted one long row',
  }))
  h.capture('10-long-candidate-line-1280x800-light', 'one scripted very long candidate row')
  writeLedger(h, 'long-candidate-line.json', {
    longCase, menuRect: longMenuBox, rows: longRows,
    softWrap: 'NOT_IMPLEMENTED_THIS_MILESTONE: recorded, not asserted',
  })
  await sendCase(h, 'catalog-restore')
  h.measure('the bare (no el + no styles) ≤3 plain ui.text fallback',
    'NOT_VERIFIED: this client negotiates both `el` and `styles`, so the mount always takes the Quiet Composer branch and the fallback is unreachable on a real pane. The fallback is owned by test/tui/tern-tsp-input-completion.test.ts (SDK mount).')

  // ── 12. I-D J1: the Host `@` mention — real Host rows, accept once, no read ─
  // The rows are answered by the production Direct Host file port over the
  // persisted Session's own workspace (`workRoot/src/**`), recorded one-to-one
  // by the subject. The Client directory holds `src/client-decoy.ts`, which the
  // Host workspace does NOT, so a Client fallback would be visible in the rows.
  const atBefore = counters(h)
  const atQuery = await queryDraft(h, 'host @ mention', '请看 @src/')
  const atWireRows = wireCompletionRows(h)
  const atTitles = atQuery.rows.map(row => rowName(row))
  const hostCall = records(h).filter(entry => entry.kind === 'host.references').at(-1)
  h.check('the `请看 @src/` draft painted the popup with the Host rows and the hint',
    atQuery.typed.text === '请看 @src/' && atQuery.typed.cursor === '请看 @src/'.length && atQuery.painted
    && atQuery.rows.length >= 2 && completionHintNode(atQuery.snap) !== undefined,
    JSON.stringify({ typed: atQuery.typed, rows: atTitles }))
  h.check('the painted `@` rows are the official mention values of the real Host workspace files',
    atTitles.length > 0 && atTitles.every(title => title.startsWith('@src/'))
    && atTitles.includes('@src/deep.ts') && atTitles.includes('@src/deeper/'),
    JSON.stringify({ atTitles, host: hostCall }))
  h.check('the Host port answered this Session scope and the Client filesystem answered nothing',
    counterDelta(atBefore, counters(h), 'hostReferences').hostReferences >= 1
    && hostCall?.scope?.kind === 'session' && hostCall?.scope?.sessionId === SESSION_A
    && hostCall?.query === 'src/' && hostCall?.result === 'ok'
    && counterDelta(atBefore, counters(h), 'clientListDirectory', 'clientFind').clientListDirectory === 0
    && counterDelta(atBefore, counters(h), 'clientListDirectory', 'clientFind').clientFind === 0
    && !atTitles.some(title => title.includes('client-decoy')),
    JSON.stringify({ hostCall, delta: counterDelta(atBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind'), atTitles }))
  // The addressing scheme proves itself: a withdrawn list's whole subtree is
  // gone from the fold, so exactly ONE popup container is live at a time and no
  // older frame's row can be mistaken for the current one.
  h.check('the wire fold carries exactly one live popup container (rows are addressed through it)',
    wireMenuCount(h) === 1 && atWireRows.length === atQuery.rows.length,
    JSON.stringify({ menus: wireMenuCount(h), wireRows: atWireRows.length, painted: atQuery.rows.length }))
  h.check('painting the `@` list leaves the exact typed draft and writes nothing',
    editorFacts(h).text === '请看 @src/' && editorFacts(h).cursor === '请看 @src/'.length
    && counterDelta(atBefore, counters(h), 'applyCompletionEdit', 'handlerSubmit', 'writerPrompt', 'stagerCalls', 'storeImageAdd', 'storeFileAdd').applyCompletionEdit === 0,
    JSON.stringify({ draft: editorFacts(h), delta: counterDelta(atBefore, counters(h), 'applyCompletionEdit', 'handlerSubmit', 'stagerCalls', 'storeImageAdd') }))
  h.capture('11-host-at-popup-1280x800-light', 'the Host `@src/` candidates in the same anchored popup')
  // ↑/↓ walk the Host list without touching the draft.
  const atWalk = []
  for (const step of ['ArrowDown', 'ArrowUp']) {
    const stepBefore = counters(h)
    await h.key(step, 450)
    const draft = editorFacts(h)
    const live = wireCompletionRows(h)
    const lit = live.filter(row => row.highlighted)
    atWalk.push({ step, highlight: lit.map(row => row.title), index: live.findIndex(row => row.highlighted), text: draft.text })
    h.check(`${step} on the Host \`@\` list moves the highlight and reaches neither the composer reducer nor a write`,
      lit.length === 1 && draft.text === '请看 @src/' && draft.cursor === '请看 @src/'.length
      && counterDelta(stepBefore, counters(h), 'applyKey').applyKey === 0
      && counterDelta(stepBefore, counters(h), 'keyArrived').keyArrived === 1
      && counterDelta(stepBefore, counters(h), 'applyCompletionEdit', 'handlerSubmit', 'stagerCalls').applyCompletionEdit === 0,
      JSON.stringify({ step, lit, draft, delta: counterDelta(stepBefore, counters(h), 'applyKey', 'keyArrived', 'applyCompletionEdit') }))
  }
  // Enter accepts the highlighted Host row ONCE, writes only the literal
  // mention, and — the single-frame rule — paints exactly ONE frame.
  const acceptBefore = counters(h)
  const atHighlighted = wireCompletionRows(h).find(row => row.highlighted)?.title ?? ''
  await h.key('Enter', 700)
  const atClosed = await waitUntil(h, 'the `@` accept retires the list', () => completionRows(h, h.snapshot()).length === 0,
    { limit: 40, intervalMs: 150 })
  const atDraft = editorFacts(h)
  const afterAccept = counters(h)
  const atWrite = lastKind(h, 'composer.applyCompletionEdit')
  h.check('Enter accepts the highlighted Host row exactly once into the literal mention',
    atClosed && atWrite?.accepted === true && atDraft.text === `请看 ${atHighlighted}`
    && atDraft.cursor === `请看 ${atHighlighted}`.length
    && counterDelta(acceptBefore, afterAccept, 'applyCompletionEdit').applyCompletionEdit === 1,
    JSON.stringify({ atHighlighted, atDraft, atWrite, delta: counterDelta(acceptBefore, afterAccept, 'applyCompletionEdit') }))
  h.check('the successful accept paints ONE frame: no second frame follows an accept (single-frame rule)',
    afterAccept.frames - acceptBefore.frames === 1,
    JSON.stringify({ framesBefore: acceptBefore.frames, framesAfter: afterAccept.frames, delta: afterAccept.frames - acceptBefore.frames }))
  await h.sleep(ABSENCE_WINDOW_MS)
  h.check('no late frame follows the accepted `@` row',
    frameCount(h) === afterAccept.frames,
    JSON.stringify({ atAccept: afterAccept.frames, now: frameCount(h) }))
  h.check('the Host `@` accept read no file, staged nothing and submitted nothing',
    counterDelta(atBefore, counters(h), 'stagerCalls', 'storeImageAdd', 'storeFileAdd', 'handlerSubmit', 'writerPrompt', 'replaceFragment').stagerCalls === 0
    && counterDelta(atBefore, counters(h), 'replaceFragment').replaceFragment === 0
    && !atDraft.text.includes('[image') && !atDraft.text.includes('[file'),
    JSON.stringify({ delta: counterDelta(atBefore, counters(h), 'stagerCalls', 'storeImageAdd', 'storeFileAdd', 'handlerSubmit', 'writerPrompt'), atDraft }))
  h.capture('12-host-at-accepted-1280x800-light', `the composer holds ${JSON.stringify(atDraft.text)} after the Host accept`)
  // A LATER Enter is the only submit, and it carries the literal reference.
  const atSubmitBefore = counters(h)
  await h.key('Enter', 1200)
  const atSubmitted = await requiredWait(h, 'the LATER Enter submits the literal `@` text exactly once', () =>
    counterDelta(atSubmitBefore, counters(h), 'handlerSubmit').handlerSubmit === 1, { limit: 60 })
  const atSubmitRecord = lastKind(h, 'handler.submit')
  const atPromptRecord = lastKind(h, 'writer.prompt')
  const atPromptBlocks = atPromptRecord?.message?.content ?? null
  h.check('the LATER Enter submits exactly once and the wire carries the literal mention',
    atSubmitted && atSubmitRecord?.text === `请看 ${atHighlighted}` && String(atSubmitRecord?.request) === 'enter'
    && counterDelta(atSubmitBefore, counters(h), 'handlerSubmit').handlerSubmit === 1,
    JSON.stringify({ atSubmitRecord, atHighlighted, atDraft }))
  h.check('the settled Direct prompt is the literal text with NO attachment part',
    counterDelta(atSubmitBefore, counters(h), 'writerPrompt').writerPrompt === 1
    && Array.isArray(atPromptBlocks) && atPromptBlocks.some(block => block.type === 'text'
      && String(block.text ?? '').includes(atHighlighted))
    && !atPromptBlocks.some(block => block.type === 'image' || block.type === 'file')
    && counterDelta(atSubmitBefore, counters(h), 'stagerCalls', 'storeImageAdd', 'storeFileAdd').stagerCalls === 0,
    JSON.stringify({ atPromptRecord, blocks: atPromptBlocks, delta: counterDelta(atSubmitBefore, counters(h), 'writerPrompt', 'stagerCalls', 'storeImageAdd') }))
  await waitUntil(h, 'the submitted draft is cleared', () => editorFacts(h).text === '', { limit: 60, intervalMs: 200 })
  writeLedger(h, 'id-host-mention.json', {
    atTitles, hostCall, atWalk, atHighlighted, atDraft, atWrite,
    atSubmitRecord, atPromptBlocks,
    frames: { before: acceptBefore.frames, afterAccept: afterAccept.frames, now: frameCount(h) },
    counters: counterDelta(atBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'applyCompletionEdit', 'stagerCalls', 'storeImageAdd', 'storeFileAdd', 'handlerSubmit', 'writerPrompt'),
  })

  // ── 13. I-D: an accepted Host `@` DIRECTORY continues inside the same seat ──
  const dirBefore = counters(h)
  const dirQuery = await queryDraft(h, 'host @ directory', '请看 @src/de')
  const dirTitles = dirQuery.rows.map(row => rowName(row))
  const dirWire = wireCompletionRows(h)
  const dirRow = dirWire.find(row => row.title.endsWith('/'))
  h.check('`@src/de` offers both the file and the directory as official mentions',
    dirQuery.painted && dirRow !== undefined && dirTitles.includes('@src/deep.ts'),
    JSON.stringify({ dirTitles, dirWire }))
  const dirPoint = centreOf(rect(dirQuery.rows.find(row => rowName(row) === dirRow?.title)))
  await h.clickAt(dirPoint.x, dirPoint.y, 900)
  const dirDraft = editorFacts(h)
  h.check('a control-injected click on the Host directory row writes only that mention and stages nothing',
    dirDraft.text === `请看 ${dirRow?.title}` && dirDraft.cursor === dirDraft.text.length
    && counterDelta(dirBefore, counters(h), 'applyCompletionEdit').applyCompletionEdit === 1
    && counterDelta(dirBefore, counters(h), 'stagerCalls', 'storeImageAdd', 'handlerSubmit').stagerCalls === 0,
    JSON.stringify({ dirPoint, dirRow, dirDraft, delta: counterDelta(dirBefore, counters(h), 'applyCompletionEdit', 'stagerCalls', 'storeImageAdd', 'handlerSubmit') }))
  // The click moved the client's focus to the row's button; the seat re-derives
  // on the next real keystroke, so the composer seat must be back in focus —
  // proven, not assumed — before typing continues.
  const dirEditorPoint = centreOf(rect(editorNode(h.snapshot())))
  await h.clickAt(dirEditorPoint.x, dirEditorPoint.y, 700)
  h.check('a control-injected click back into the editor restores the composer focus the keys need',
    editorFacts(h).focused, JSON.stringify({ dirEditorPoint, after: editorFacts(h) }))
  const continued = await typeText(h, 'i')
  const continuedRows = await waitUntil(h, 'the directory continuation lists the Host children', () =>
    completionRows(h, h.snapshot()).length > 0, { limit: 40, intervalMs: 150 })
  const childTitles = completionRows(h, h.snapshot()).map(row => rowName(row))
  h.check('typing on inside the accepted directory scope continues the SAME seat with its children',
    continued.text === `请看 @src/deeper/i` && continuedRows && childTitles.includes('@src/deeper/inner.ts'),
    JSON.stringify({ continued, childTitles }))
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  writeLedger(h, 'id-host-directory.json', {
    dirTitles, dirRow, dirPoint, dirDraft, continued, childTitles,
    counters: counterDelta(dirBefore, counters(h), 'hostReferences', 'clientListDirectory', 'applyCompletionEdit', 'stagerCalls', 'handlerSubmit'),
  })

  // ── 14. I-D: an authoritative empty Host answer paints NOTHING ────────────
  const emptyBefore = counters(h)
  // POSITIVE CONTROL inside the same case: the Host seat really answers, so a
  // later empty popup is the Host's own empty answer and never a dead lane.
  const atControl = await queryDraft(h, 'empty-case positive control', '请看 @src/')
  await sendCase(h, 'clear')
  const emptyTyped = await typeText(h, '@zznotpresent')
  await h.sleep(ABSENCE_WINDOW_MS)
  const emptySnap = h.snapshot()
  const emptyHost = records(h).filter(entry => entry.kind === 'host.references').at(-1)
  h.check('an authoritative empty Host answer paints no rows and leaves the draft as typed',
    emptyTyped.text === '@zznotpresent' && completionRows(h, emptySnap).length === 0
    && completionHintNode(emptySnap) === undefined && editorFacts(h).text === '@zznotpresent',
    JSON.stringify({ emptyTyped, rows: completionRows(h, emptySnap).map(row => rowName(row)) }))
  h.check('the empty answer is the Host authority, not a Client rescan: 0 Client discovery, 0 write, 0 stage',
    counterDelta(emptyBefore, counters(h), 'hostReferences').hostReferences >= 1
    && emptyHost?.result === 'ok' && (emptyHost?.count ?? -1) === 0
    && counterDelta(emptyBefore, counters(h), 'clientListDirectory', 'clientFind').clientListDirectory === 0
    && counterDelta(emptyBefore, counters(h), 'applyCompletionEdit', 'stagerCalls', 'storeImageAdd', 'storeFileAdd', 'handlerSubmit').applyCompletionEdit === 0,
    JSON.stringify({ emptyHost, delta: counterDelta(emptyBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'applyCompletionEdit', 'stagerCalls') }))
  h.check('the empty-Host case carries its own positive control: the same seat painted rows moments before',
    atControl.painted && atControl.rows.length > 0, JSON.stringify({ control: atControl.rows.map(row => rowName(row)) }))
  h.capture('13-host-empty-paints-nothing-1280x800-light', 'the Host answered ok:[] and the popup stayed closed')
  writeLedger(h, 'id-host-empty.json', { emptyTyped, emptyHost, delta: counterDelta(emptyBefore, counters(h), 'hostReferences', 'clientListDirectory', 'applyCompletionEdit', 'stagerCalls') })

  // ── 15. I-D J3: the FIRST-LINE `/image` argument completes; the NEXT Enter runs it
  const leadBefore = counters(h)
  const leadQuery = await queryDraft(h, 'leading /image argument', '/image sho')
  const leadTitles = leadQuery.rows.map(row => rowName(row))
  h.check('the first-line `/image sho` argument offers the Client-local paths',
    leadQuery.painted && leadTitles.length > 0 && leadTitles.every(title => title.startsWith('shots/')),
    JSON.stringify({ leadTitles, draft: leadQuery.typed }))
  h.check('the leading `/image` argument is Client-local: the Host port was asked nothing',
    counterDelta(leadBefore, counters(h), 'hostReferences').hostReferences === 0
    && counterDelta(leadBefore, counters(h), 'clientListDirectory', 'clientFind').clientFind
      + counterDelta(leadBefore, counters(h), 'clientListDirectory', 'clientFind').clientListDirectory >= 1,
    JSON.stringify({ delta: counterDelta(leadBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind') }))
  // Walk onto a FILE row (a directory row would only continue the argument).
  const leadWalk = await walkTo(h, 'the leading `/image` FILE row', title => title === 'shots/photo.png')
  const leadTarget = leadWalk.title
  const leadAcceptBefore = counters(h)
  await h.key('Enter', 700)
  const leadClosed = await waitUntil(h, 'the leading-argument accept retires the list', () =>
    completionRows(h, h.snapshot()).length === 0, { limit: 40, intervalMs: 150 })
  const leadDraft = editorFacts(h)
  const leadFrames = counters(h).frames - leadAcceptBefore.frames
  h.check('Enter completes ONLY the argument: the command token stays and the path lands',
    !leadWalk.failed && leadClosed && leadDraft.text === `/image shots/photo.png` && leadDraft.cursor === leadDraft.text.length
    && counterDelta(leadAcceptBefore, counters(h), 'applyCompletionEdit').applyCompletionEdit === 1,
    JSON.stringify({ leadTarget, leadDraft, leadWalk }))
  h.check('that accept paints exactly ONE frame and ran no command and staged nothing',
    leadFrames === 1
    && counterDelta(leadAcceptBefore, counters(h), 'handlerSubmit', 'writerPrompt', 'stagerCalls', 'storeImageAdd').handlerSubmit === 0,
    JSON.stringify({ leadFrames, delta: counterDelta(leadAcceptBefore, counters(h), 'handlerSubmit', 'writerPrompt', 'stagerCalls', 'storeImageAdd') }))
  h.capture('14-leading-image-argument-1280x800-light', `the completed first-line argument ${JSON.stringify(leadDraft.text)}`)
  // The NEXT Enter is the real registered `/image` command, not a prompt.
  const runBefore = counters(h)
  await h.key('Enter', 1500)
  const commandRan = await requiredWait(h, 'the NEXT Enter runs the real registered /image handler', () =>
    counterDelta(runBefore, counters(h), 'storeImageAdd').storeImageAdd === 1, { limit: 80 })
  const leadSubmit = lastKind(h, 'handler.submit')
  const leadInsert = lastKind(h, 'composer.insertIntoEditor')
  // THIS case's own store entry and notice, sliced from the subject's record at
  // the count this case took before its Enter: an earlier case's staged image
  // can neither satisfy this claim nor pollute it.
  const leadAdds = newOf(h, 'store.image.add', runBefore.storeImageAdd)
  const leadNotices = newOf(h, 'display.notify', runBefore.notices)
  const leadStore = leadAdds.at(-1)
  const leadPlaceholder = String(leadStore?.placeholder ?? '')
  const leadNotice = leadNotices.at(-1)
  h.check('the NEXT Enter handed the line to the application exactly once and the handler ran',
    commandRan && leadSubmit?.text === '/image shots/photo.png'
    && counterDelta(runBefore, counters(h), 'handlerSubmit').handlerSubmit === 1
    && counterDelta(runBefore, counters(h), 'insertIntoEditor').insertIntoEditor === 1
    && String(leadInsert?.fragment ?? '').includes('[image #')
    && counterDelta(runBefore, counters(h), 'writerPrompt').writerPrompt === 0,
    JSON.stringify({ leadSubmit, leadInsert, delta: counterDelta(runBefore, counters(h), 'handlerSubmit', 'insertIntoEditor', 'writerPrompt', 'storeImageAdd') }))
  h.check('the real /image handler staged exactly ONE image in this case, read the real file and announced it',
    leadAdds.length === 1 && leadPlaceholder.startsWith('[image #') && leadPlaceholder.endsWith('(1×1)]')
    && leadStore?.name === 'photo.png' && leadStore?.mediaType === 'image/png' && leadStore?.byteLength === 70
    && String(leadStore?.source?.path ?? '').endsWith('/shots/photo.png') === true
    && String(leadInsert?.fragment ?? '').includes(leadPlaceholder)
    && leadNotices.length === 1 && leadNotice?.text === `attached ${leadPlaceholder} — Enter to send`
    && h.texts(h.snapshot()).some(text => String(text).includes(`attached ${leadPlaceholder} — Enter to send`)),
    JSON.stringify({ leadAdds, leadNotices, leadInsert }))
  h.capture('15-leading-image-handler-1280x800-light', 'the real /image handler inserted the staged placeholder')
  writeLedger(h, 'id-leading-image.json', {
    leadTitles, leadWalk, leadTarget, leadDraft, leadFrames, leadSubmit, leadInsert, leadStore, leadNotice,
    counters: counterDelta(leadBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'handlerSubmit', 'insertIntoEditor', 'storeImageAdd', 'writerPrompt'),
  })
  await sendCase(h, 'clear')

  // ── 16. I-D J4: the body inline action → directory → FILE → placeholder ───
  const bodyStart = counters(h)
  const actionQuery = await queryDraft(h, 'inline action', '看一下 /im')
  const actionTitles = actionQuery.rows.map(row => rowName(row))
  h.check('`看一下 /im` offers the fixed inline attachment action row',
    actionQuery.painted && actionTitles.includes('/image'),
    JSON.stringify({ actionTitles, draft: actionQuery.typed }))
  h.check('selecting the action read no file: no Host call, no Client discovery, no stage',
    counterDelta(bodyStart, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'stagerCalls', 'storeImageAdd').hostReferences === 0
    && counterDelta(bodyStart, counters(h), 'stagerCalls', 'storeImageAdd').stagerCalls === 0,
    JSON.stringify({ delta: counterDelta(bodyStart, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'stagerCalls', 'storeImageAdd') }))
  h.capture('16-inline-action-1280x800-light', 'the inline `/image` action row in the same popup')
  const actionAcceptBefore = counters(h)
  await h.key('Enter', 900)
  const pathRowsPainted = await waitUntil(h, 'the action accept opens the path seat at once', () =>
    completionRows(h, h.snapshot()).length > 0, { limit: 40, intervalMs: 150 })
  const pathTitles = completionRows(h, h.snapshot()).map(row => rowName(row))
  const afterAction = editorFacts(h)
  h.check('accepting the action writes `/image ` and immediately lists the real Client cwd',
    pathRowsPainted && afterAction.text === '看一下 /image ' && afterAction.cursor === '看一下 /image '.length
    && counterDelta(actionAcceptBefore, counters(h), 'applyCompletionEdit').applyCompletionEdit === 1
    && pathTitles.length > 0 && pathTitles.every(title => !title.startsWith('@src/'))
    && pathTitles.includes('shots/') && pathTitles.includes('notes.txt'),
    JSON.stringify({ afterAction, pathTitles, delta: counterDelta(actionAcceptBefore, counters(h), 'applyCompletionEdit') }))
  h.check('the inline path rows come from the Client cwd only: the Host port answered nothing here',
    counterDelta(actionAcceptBefore, counters(h), 'hostReferences').hostReferences === 0
    && counterDelta(actionAcceptBefore, counters(h), 'clientListDirectory', 'clientFind').clientListDirectory >= 1
    && records(h).filter(entry => entry.kind === 'client.listDirectory').at(-1)?.baseDir === clientCwdOf(h)
    && counterDelta(actionAcceptBefore, counters(h), 'stagerCalls', 'storeImageAdd').stagerCalls === 0,
    JSON.stringify({ lastClientRead: records(h).filter(entry => entry.kind === 'client.listDirectory').at(-1), pathTitles }))
  h.capture('17-inline-path-listing-1280x800-light', 'the real Client cwd rows behind the accepted action')
  // DIRECTORY continuation.
  const dirWalk = await walkTo(h, 'the inline DIRECTORY row', title => title === 'shots/')
  const dirTarget = dirWalk.title
  const dirAcceptBefore = counters(h)
  await h.key('Enter', 900)
  const continuedListing = await waitUntil(h, 'the directory accept continues the same seat', () =>
    completionRows(h, h.snapshot()).some(row => rowName(row).startsWith('shots/')), { limit: 40, intervalMs: 150 })
  const afterDir = editorFacts(h)
  const childPaths = completionRows(h, h.snapshot()).map(row => rowName(row))
  h.check('a DIRECTORY row continues the path seat in place and stages nothing',
    !dirWalk.failed && continuedListing && afterDir.text === '看一下 /image shots/' && afterDir.cursor === afterDir.text.length
    && childPaths.includes('shots/photo.png')
    && counterDelta(dirAcceptBefore, counters(h), 'stagerCalls', 'storeImageAdd', 'replaceFragment', 'handlerSubmit').stagerCalls === 0,
    JSON.stringify({ dirTarget, afterDir, childPaths, delta: counterDelta(dirAcceptBefore, counters(h), 'stagerCalls', 'storeImageAdd', 'replaceFragment', 'handlerSubmit') }))
  writeLedger(h, 'id-inline-directory.json', { actionTitles, pathTitles, dirWalk, dirTarget, afterDir, childPaths })
  // FILE acceptance: the real intake runs and the placeholder replaces IN PLACE.
  const fileWalk = await walkTo(h, 'the inline FILE row', title => title === 'shots/photo.png')
  const fileTarget = fileWalk.title
  const fileAcceptBefore = counters(h)
  const fragmentCountBefore = fileAcceptBefore.replaceFragment
  await h.key('Enter', 900)
  // The placeholder is the PRODUCTION store's own canonical token, read back
  // from the recorded `store.image.add` — never a value this lane invents.
  const staged = await requiredWait(h, 'the real intake staged the accepted file and replaced the fragment in place', () =>
    records(h).some(entry => entry.kind === 'composer.replaceInlineAttachmentFragment'
      && entry.committed === true && records(h).filter(r => r.kind === 'composer.replaceInlineAttachmentFragment').length > fragmentCountBefore),
    { limit: 80 })
  const stagedDraft = editorFacts(h)
  // THIS case's own stake, fragment commit, store entry and notice — sliced at
  // the counts taken before the FILE accept.
  const stakes = newOf(h, 'stager.call', fileAcceptBefore.stagerCalls)
  const fragments = newOf(h, 'composer.replaceInlineAttachmentFragment', fileAcceptBefore.replaceFragment)
  const bodyAdds = newOf(h, 'store.image.add', fileAcceptBefore.storeImageAdd)
  const bodyNotices = newOf(h, 'display.notify', fileAcceptBefore.notices)
  const stake = stakes.at(-1)
  const fragment = fragments.at(-1)
  const placeholder = String(fragment?.placeholder ?? '')
  const imageStore = bodyAdds.at(-1)
  const intakeNotice = bodyNotices.at(-1)
  const noticeVisible = h.texts(h.snapshot()).some(text => String(text).includes(`attached ${placeholder} — Enter to send`))
  h.check('the accepted FILE row first wrote its own path and then handed exactly one stake to the production stager',
    !fileWalk.failed && fileTarget === 'shots/photo.png' && stakes.length === 1
    && stake?.command === 'image' && stake?.path === 'shots/photo.png'
    && counterDelta(fileAcceptBefore, counters(h), 'applyCompletionEdit').applyCompletionEdit === 1
    && counterDelta(fileAcceptBefore, counters(h), 'handlerSubmit', 'writerPrompt').handlerSubmit === 0,
    JSON.stringify({ fileTarget, stake, delta: counterDelta(fileAcceptBefore, counters(h), 'stagerCalls', 'applyCompletionEdit', 'handlerSubmit', 'writerPrompt') }))
  h.check('the placeholder replaced the fragment IN PLACE with the surrounding prose intact',
    staged && fragments.length === 1 && fragment?.committed === true
    && placeholder.startsWith('[image #') && placeholder.endsWith('(1×1)]')
    && stagedDraft.text === `看一下 ${placeholder} ` && stagedDraft.cursor === `看一下 ${placeholder}`.length
    && counterDelta(fileAcceptBefore, counters(h), 'replaceFragment').replaceFragment === 1
    && !stagedDraft.text.includes('/image') && !stagedDraft.text.includes('photo.png'),
    JSON.stringify({ staged, fragment, placeholder, stagedDraft }))
  h.check('the real Client-local read staged exactly one image and announced it',
    bodyAdds.length === 1 && bodyNotices.length === 1
    && imageStore?.name === 'photo.png' && imageStore?.mediaType === 'image/png'
    && String(imageStore?.source?.path ?? '').endsWith('/shots/photo.png') === true
    && imageStore?.placeholder === placeholder
    && intakeNotice?.text === `attached ${placeholder} — Enter to send` && noticeVisible
    && counterDelta(fileAcceptBefore, counters(h), 'storeFileAdd').storeFileAdd === 0,
    JSON.stringify({ bodyAdds, bodyNotices, imageStore, intakeNotice, noticeVisible,
      storeFileAddDelta: counterDelta(fileAcceptBefore, counters(h), 'storeFileAdd').storeFileAdd }))
  h.capture('18-inline-placeholder-in-place-1280x800-light', `the body reads ${JSON.stringify(stagedDraft.text)}`)
  // The separate Enter that finally submits the body PLUS the staged attachment.
  const bodySubmitBefore = counters(h)
  await h.key('Enter', 1500)
  const bodyHanded = await requiredWait(h, 'the separate Enter submits the body plus the staged attachment', () =>
    counterDelta(bodySubmitBefore, counters(h), 'writerPrompt').writerPrompt === 1, { limit: 80 })
  const bodyPrompt = lastKind(h, 'writer.prompt')
  const bodyBlocks = bodyPrompt?.message?.content ?? null
  h.check('that submit is exactly one, and only that one',
    bodyHanded && lastKind(h, 'handler.submit')?.text === `看一下 ${placeholder} `
    && counterDelta(bodySubmitBefore, counters(h), 'handlerSubmit').handlerSubmit === 1,
    JSON.stringify({ submit: lastKind(h, 'handler.submit'), delta: counterDelta(bodySubmitBefore, counters(h), 'handlerSubmit', 'writerPrompt') }))
  h.check('the settled Direct prompt really carries the staged image beside the body text',
    Array.isArray(bodyBlocks) && bodyBlocks.some(block => block.type === 'text' && String(block.text).includes('看一下'))
    && bodyBlocks.some(block => block.type === 'image')
    && !String(JSON.stringify(bodyBlocks.filter(block => block.type === 'text'))).includes('/image shots/')
    && !String(JSON.stringify(bodyBlocks.filter(block => block.type === 'text'))).includes('photo.png'),
    JSON.stringify({ bodyBlocks: bodyBlocks?.map(block => ({ type: block.type, text: block.text, attachment: block.attachment })) }))
  await waitUntil(h, 'the submitted draft is cleared', () => editorFacts(h).text === '', { limit: 60, intervalMs: 200 })
  writeLedger(h, 'id-inline-attachment-chain.json', {
    actionTitles, pathTitles, dirWalk, dirTarget, childPaths, fileWalk, fileTarget, stake, fragment, imageStore, intakeNotice,
    stagedDraft, bodyPrompt: { text: lastKind(h, 'handler.submit')?.text, blocks: bodyBlocks },
    counters: counterDelta(bodyStart, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'applyCompletionEdit', 'stagerCalls', 'replaceFragment', 'storeImageAdd', 'handlerSubmit', 'writerPrompt'),
  })

  // ── 17. I-D: `/image @foo` is a Client-local argument, never a Host mention ─
  const crossBefore = counters(h)
  const crossQuery = await queryDraft(h, '/image @foo cross-source', '/image @foo')
  const crossTitles = crossQuery.rows.map(row => rowName(row))
  const crossReads = records(h).filter(entry => entry.kind === 'client.listDirectory' || entry.kind === 'client.find').slice(-4)
  h.check('`/image @foo` is answered from the Client filesystem and never asks the Host port',
    counterDelta(crossBefore, counters(h), 'hostReferences').hostReferences === 0
    && counterDelta(crossBefore, counters(h), 'clientListDirectory', 'clientFind').clientListDirectory
      + counterDelta(crossBefore, counters(h), 'clientListDirectory', 'clientFind').clientFind >= 1,
    JSON.stringify({ crossTitles, delta: counterDelta(crossBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind') }))
  h.check('the `@` row of a `/image` argument is the real Client file, not a Host mention',
    crossTitles.includes('@foo') && crossTitles.every(title => !title.startsWith('@src/')),
    JSON.stringify({ crossTitles }))
  h.capture('19-image-at-foo-local-only-1280x800-light', 'the `/image @foo` argument answered from the Client side')
  writeLedger(h, 'id-cross-source.json', { crossTitles, crossReads, delta: counterDelta(crossBefore, counters(h), 'hostReferences', 'clientListDirectory', 'clientFind', 'stagerCalls') })

  // ── 18. I-D negatives: Escape, a stale row click and a higher-owner seat ───
  const escBefore = counters(h)
  const escQuery = await queryDraft(h, 'escape on the @ seat', '请看 @src/')
  h.check('the Escape case starts with the Host list open', escQuery.rows.length > 0, JSON.stringify({ rows: escQuery.rows.map(row => rowName(row)) }))
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  const escDraft = editorFacts(h)
  h.check('Escape on the `@` seat closes the list, leaves the draft and records NO cancel',
    completionRows(h, h.snapshot()).length === 0 && escDraft.text === '请看 @src/' && escDraft.cursor === '请看 @src/'.length
    && counterDelta(escBefore, counters(h), 'handlerCancel').handlerCancel === 0
    && counterDelta(escBefore, counters(h), 'applyCompletionEdit', 'stagerCalls', 'handlerSubmit').applyCompletionEdit === 0,
    JSON.stringify({ escDraft, delta: counterDelta(escBefore, counters(h), 'handlerCancel', 'applyCompletionEdit', 'stagerCalls', 'handlerSubmit') }))
  await h.key('Escape', 500)
  await h.sleep(300)
  h.check('the next Escape still reaches the existing cancel owner exactly once',
    counterDelta(escBefore, counters(h), 'handlerCancel').handlerCancel === 1,
    JSON.stringify({ delta: counterDelta(escBefore, counters(h), 'handlerCancel') }))
  // A click on a row the CURRENT frame no longer owns mutates nothing.
  const staleQuery = await queryDraft(h, 'stale click', '请看 @src/')
  const stalePoint = centreOf(rect(staleQuery.rows[0]))
  // POSITIVE CONTROL inside the same case: this very point on a LIVE frame does
  // accept the row it names, so the retired-frame claim below is not a click
  // that could never have worked anywhere.
  const liveClickBefore = counters(h)
  const liveClickName = rowName(staleQuery.rows[0])
  await h.clickAt(stalePoint.x, stalePoint.y, 900)
  const liveClickDraft = editorFacts(h)
  h.check('the same point on the LIVE frame accepts that row (positive control for the retired-frame claim)',
    liveClickDraft.text === `请看 ${liveClickName}`
    && counterDelta(liveClickBefore, counters(h), 'applyCompletionEdit').applyCompletionEdit === 1,
    JSON.stringify({ liveClickName, liveClickDraft, delta: counterDelta(liveClickBefore, counters(h), 'applyCompletionEdit') }))
  await sendCase(h, 'clear')
  const staleRequery = await queryDraft(h, 'stale click reopen', '请看 @src/')
  const stalePointClosed = centreOf(rect(staleRequery.rows[0]))
  await h.key('Escape', 500)
  await h.sleep(ABSENCE_WINDOW_MS)
  const staleBefore = counters(h)
  h.check('the stale-click case starts from a CLOSED list', completionRows(h, h.snapshot()).length === 0, JSON.stringify(staleQuery.rows.map(row => rowName(row))))
  await h.clickAt(stalePointClosed.x, stalePointClosed.y, 900)
  const staleAfter = counters(h)
  h.check('a control-injected click at a retired candidate row accepts nothing, reads nothing and submits nothing',
    counterDelta(staleBefore, staleAfter, 'applyCompletionEdit', 'stagerCalls', 'storeImageAdd', 'storeFileAdd', 'handlerSubmit', 'handlerCancel').applyCompletionEdit === 0
    && completionRows(h, h.snapshot()).length === 0 && editorFacts(h).text === '请看 @src/',
    JSON.stringify({ stalePoint, draft: editorFacts(h), delta: counterDelta(staleBefore, staleAfter, 'applyCompletionEdit', 'stagerCalls', 'handlerSubmit', 'replaceFragment') }))
  h.measure('frames a retired-row click cost the client (a focus repaint is not a completion write)',
    JSON.stringify({ framesBefore: staleBefore.frames, framesAfter: staleAfter.frames }))
  writeLedger(h, 'id-escape-stale-click.json', {
    escDraft, stalePoint, liveClickName, liveClickDraft, stalePointClosed, staleBefore, staleAfter,
  })
  // A higher-owner seat takes the keys while the Host list is open.
  const idSeatBefore = counters(h)
  const atSeatQuery = await queryDraft(h, 'higher seat on the @ list', '请看 @src/')
  const seatDraft = editorFacts(h)
  h.check('the Host list is open before the higher control takes the keys',
    atSeatQuery.rows.length > 0, JSON.stringify({ rows: atSeatQuery.rows.map(row => rowName(row)) }))
  const atSeatOpen = await sendCase(h, 'seat-open')
  const atMenuOpened = await waitUntil(h, 'the production quick menu owns the keys over the Host list', () => {
    const snap = h.snapshot()
    return pickerNode(snap) !== undefined || overlayNode(snap) !== undefined
      || h.texts(snap).some(text => String(text).includes('All models & details') || String(text).includes('Scripted Model'))
  }, { limit: 40, intervalMs: 150 })
  const atMenuSnap = h.snapshot()
  h.check('the higher-owner quick menu retires the Host `@` list completely',
    atMenuOpened && atSeatOpen?.opened === true && completionRows(h, atMenuSnap).length === 0
    && completionHintNode(atMenuSnap) === undefined,
    JSON.stringify({ atSeatOpen, rows: completionRows(h, atMenuSnap).length }))
  for (const step of ['ArrowDown', 'Tab', 'Enter']) {
    const stepBefore = counters(h)
    await h.key(step, 450)
    const after = editorFacts(h)
    h.check(`${step} while the quick menu owns the keys reaches neither the Host list nor a submit`,
      after.text === seatDraft.text && after.cursor === seatDraft.cursor
      && counterDelta(stepBefore, counters(h), 'applyCompletionEdit', 'handlerSubmit', 'stagerCalls').applyCompletionEdit === 0
      && completionRows(h, h.snapshot()).length === 0,
      JSON.stringify({ step, after, delta: counterDelta(stepBefore, counters(h), 'applyCompletionEdit', 'handlerSubmit', 'stagerCalls') }))
  }
  h.capture('20-higher-seat-host-list-1280x800-light', 'the quick menu owns the keys; the Host list is gone')
  await h.key('Escape', 500)
  await sendCase(h, 'seat-close')
  const atReacquired = await queryDraft(h, 'the @ seat after the higher control', '请看 @src/')
  h.check('after the higher control closes, the Host `@` seat is admitted again',
    atReacquired.rows.length > 0, JSON.stringify({ rows: atReacquired.rows.map(row => rowName(row)) }))
  await h.key('Escape', 500)
  writeLedger(h, 'id-higher-seat.json', {
    seatDraft, atSeatOpen, atMenuOpened,
    delta: counterDelta(idSeatBefore, counters(h), 'applyCompletionEdit', 'handlerSubmit', 'stagerCalls', 'hostReferences'),
  })
  const laneCounters = counters(h)
  writeLedger(h, 'id-counters.json', {
    clientCwd: clientCwdOf(h),
    sinceIdLane: counterDelta(atBefore, laneCounters, 'hostReferences', 'clientListDirectory', 'clientFind',
      'applyCompletionEdit', 'replaceFragment', 'insertIntoEditor', 'stagerCalls', 'storeImageAdd', 'storeFileAdd',
      'handlerSubmit', 'handlerCancel', 'writerPrompt'),
    totals: laneCounters,
  })

  // ── 19. Eight real appearance/geometry cells with the list OPEN ───────────
  const cells = []
  for (const viewport of VIEWPORTS) {
    await h.resize(viewport.width, viewport.height)
    for (const appearance of APPEARANCES) {
      await h.send('appearance', appearance)
      await h.sleep(300)
      const queried = await querySlash(h, `cell ${viewport.name} ${appearance}`, { pick: false })
      const clip = clipReport(h)
      const id = h.capture(`cell-${viewport.name}-${appearance}`, `input completion UX ${viewport.name} ${appearance}`)
      const snap = h.snapshot()
      const rows = completionRows(h, snap)
      const menu = menuNodeOf(snap, rows)
      const menuBox = menu === undefined ? undefined : rect(menu)
      const rowDossiers = rows.map(row => rowDossier(h, snap, row, menuBox, true))
      const shownRows = rowDossiers.filter(row => row.shown)
      const litIndex = rowDossiers.findIndex(row => row.highlighted)
      const editor = editorNode(snap)
      const caret = caretNode(snap)
      const send = sendNode(snap)
      const statuses = statusNodes(snap)
      const dock = dockNode(snap)
      const main = mainNode(snap)
      const state = h.ctl('state')
      const stats = h.ctl('stats')
      const layout = layoutOf(h, id, out)
      const editorHit = pickAt(h, centreOf(rect(editor)), `editor @${viewport.name}/${appearance}`)
      const sendHit = send === undefined ? undefined : pickAt(h, centreOf(rect(send)), `send @${viewport.name}/${appearance}`)
      const cell = {
        viewport: viewport.name,
        requested: [viewport.width, viewport.height],
        actualViewport: stats.viewport?.slice(0, 2),
        appearance,
        resolvedTheme: state.theme,
        layoutTheme: layout?.theme,
        clip,
        main: { rect: main === undefined ? undefined : rect(main) },
        dock: { rect: dock === undefined ? undefined : rect(dock) },
        menu: { rect: menuBox, oracleSpanY: menu === undefined ? 0 : visibleSpan(snap.chains, menu, 'y') },
        rowsPainted: rows.length,
        rowsVisible: shownRows.length,
        rows: rowDossiers,
        highlightedIndex: litIndex,
        highlighted: rowDossiers[litIndex] ?? null,
        hint: completionHintNode(snap) === undefined ? null : {
          rect: rect(completionHintNode(snap)),
          insideMenu: containsBox(menuBox, rect(completionHintNode(snap))),
        },
        caret: {
          rect: caret === undefined ? undefined : rect(caret),
          insideEditor: caret === undefined || editor === undefined ? false : containsBox(rect(editor), rect(caret)),
          focused: editor !== undefined && hasClass(editor, 'focused'),
        },
        editor: {
          rect: rect(editor),
          focused: editor !== undefined && hasClass(editor, 'focused'),
          hitOwnSubtree: editorHit === undefined ? false : containsBox(rect(editor), editorHit.rect ?? [0, 0, 0, 0]),
          hitInMenu: editorHit === undefined ? false : containsBox(menuBox, editorHit.rect ?? [0, 0, 0, 0]),
        },
        send: {
          rect: send === undefined ? undefined : rect(send),
          hitOwnSubtree: sendHit === undefined ? false : containsBox(rect(send), sendHit.rect ?? [0, 0, 0, 0]),
          coveredByMenu: send === undefined ? null : boxIntersects(menuBox, rect(send)),
        },
        footer: {
          count: statuses.length,
          rects: statuses.map(node => rect(node)),
          coveredByMenu: statuses.map(node => boxIntersects(menuBox, rect(node))),
        },
        png: join(out, 'shots', 'serve', `${id}.png`),
        nodeTree: join(out, `${id}.tree.json`),
        layout: join(out, 'shots', 'serve', `${id}.layout.json`),
      }
      // The caret's OPERABILITY is proven by a real key at this size, after the
      // capture: the list retires, the composer reducer sees the key and the
      // UTF-16 caret moves to the line start.
      const keysBefore = kindCount(h, 'composer.applyKey')
      await h.key('ArrowLeft', 450)
      const moved = editorFacts(h)
      cell.caretOperable = moved.cursor === 0 && kindCount(h, 'composer.applyKey') === keysBefore + 1
      h.check(`${viewport.name} ${appearance}: the client resolved ${appearance}, took the viewport, and keeps the list, the caret, the Composer, Send and the Footer visible, operable and uncovered`,
        cell.resolvedTheme === appearance && cell.layoutTheme === appearance
        && cell.actualViewport?.[0] === viewport.width && cell.actualViewport?.[1] === viewport.height
        && queried.painted && rows.length > 0 && shownRows.length > 0
        && litIndex === 0 && rowDossiers[0]?.shown === true
        && cell.editor.focused && cell.editor.hitOwnSubtree && cell.editor.hitInMenu === false
        && cell.caret.rect !== undefined && cell.caret.insideEditor && cell.caretOperable
        && cell.send.rect !== undefined && cell.send.hitOwnSubtree && cell.send.coveredByMenu === false
        && cell.footer.count > 0 && cell.footer.coveredByMenu.every(covered => covered === false)
        && cell.dock.rect !== undefined && cell.main.rect !== undefined,
        JSON.stringify({
          theme: [cell.resolvedTheme, cell.layoutTheme], viewport: cell.actualViewport,
          rowsPainted: cell.rowsPainted, rowsVisible: cell.rowsVisible,
          highlighted: cell.highlighted, caret: cell.caret, caretOperable: cell.caretOperable,
          editor: cell.editor, send: cell.send, footer: cell.footer, menu: cell.menu,
        }))
      // Six rows is the Owner-ratified ceiling and the client reports no pane
      // height, so at the shortest matrix cell the popup box is shorter than its
      // own window and a painted row falls below it. The Owner accepted that
      // clipping; the testing guide forbids turning a path the client does not
      // render into a pass, so the clipped rows are recorded as a MEASUREMENT
      // below, while what must still be true stays a hard assertion: the row the
      // popup offers first — the one the user is about to accept — is visible.
      const clipped = rowDossiers.filter(row => row.shown !== true)
      h.check(`${viewport.name} ${appearance}: the candidate the popup offers first (the default highlight) is VISIBLE in the popup (geometry oracle: nameContainedXY + visibleSpan + ctl pick)`,
        rowDossiers.length > 0 && rowDossiers[0].shown === true,
        JSON.stringify({
          first: rowDossiers[0] && {
            name: rowDossiers[0].name, shown: rowDossiers[0].shown,
            nameContainedXY: rowDossiers[0].nameContainedXY,
            nameVisibleSpanY: rowDossiers[0].nameVisibleSpanY,
            oracleSpanY: rowDossiers[0].oracleSpanY, hitOwnSubtree: rowDossiers[0].hitOwnSubtree,
          },
          clipped: clipped.map(row => row.name),
        }))
      if (clipped.length > 0) {
        h.measure(`${viewport.name} ${appearance}: KNOWN LIMITATION the Owner accepted — ${clipped.length}/${rowDossiers.length} painted rows fall below the popup box (six-row ceiling, no pane-height capability)`,
          JSON.stringify({
            menuRect: cell.menu, rowsPainted: cell.rowsPainted, rowsVisible: cell.rowsVisible,
            clipped: clipped.map(row => ({ name: row.name, rect: row.rect, oracleSpanY: row.oracleSpanY })),
          }))
      }
      h.check(`${viewport.name} ${appearance}: the client keeps every candidate ROW inside the popup's own frame (no text painted outside the anchored list)`,
        rowDossiers.length > 0 && rowDossiers.every(row => row.escapesMenuX === false),
        JSON.stringify(rowDossiers.map(row => ({ name: row.name, rect: row.rect, escapesMenuX: row.escapesMenuX }))))
      h.measure(`${viewport.name} ${appearance}: MAIN/DOCK/menu sizes, visible rows ${cell.rowsVisible}/${cell.rowsPainted}`,
        JSON.stringify({ main: cell.main.rect, dock: cell.dock.rect, menu: cell.menu, rows: cell.rows.map(row => ({ name: row.name, rect: row.rect, shown: row.shown })) }))
      // The SAME eight cells are re-measured for an I-D position: the Host `@`
      // list in the same anchored popup. The I-C numbers above are not silently
      // upgraded — the new source gets its own capture, dossier and caret probe.
      const atCell = await queryDraft(h, `cell ${viewport.name} ${appearance} @`, '请看 @src/')
      const atSnap = h.snapshot()
      const atRows = completionRows(h, atSnap)
      const atMenu = menuNodeOf(atSnap, atRows)
      const atMenuBox = atMenu === undefined ? undefined : rect(atMenu)
      const atDossiers = atRows.map(row => rowDossier(h, atSnap, row, atMenuBox, true))
      const atEditor = editorNode(atSnap)
      const atCaret = caretNode(atSnap)
      const atCaptureId = h.capture(`cell-${viewport.name}-${appearance}-host-at`, `Host @ candidates ${viewport.name} ${appearance}`)
      const atKeysBefore = kindCount(h, 'composer.applyKey')
      await h.key('ArrowLeft', 450)
      const atMoved = editorFacts(h)
      cell.hostAt = {
        capture: atCaptureId,
        png: join(out, 'shots', 'serve', `${atCaptureId}.png`),
        nodeTree: join(out, `${atCaptureId}.tree.json`),
        layout: join(out, 'shots', 'serve', `${atCaptureId}.layout.json`),
        painted: atCell.painted,
        rowsPainted: atRows.length,
        rowsVisible: atDossiers.filter(row => row.shown).length,
        rows: atDossiers,
        menu: atMenuBox,
        clipped: atDossiers.filter(row => row.shown !== true).map(row => row.name),
        caret: { rect: atCaret === undefined ? undefined : rect(atCaret), insideEditor: atCaret === undefined || atEditor === undefined ? false : containsBox(rect(atEditor), rect(atCaret)) },
        caretOperable: atMoved.cursor === '请看 @src/'.length - 1
          && kindCount(h, 'composer.applyKey') === atKeysBefore + 1,
        draftAfterLeft: atMoved.text,
      }
      h.check(`${viewport.name} ${appearance}: the Host \`@\` list paints official mention values in the anchored popup and the first candidate is VISIBLE`,
        atCell.painted && atRows.length > 0 && atDossiers.every(row => row.name.startsWith('@src/'))
        && atDossiers[0].shown === true && atDossiers.every(row => row.escapesMenuX === false)
        && completionHintNode(atSnap) !== undefined
        && editorFacts(h).text === '请看 @src/',
        JSON.stringify({
          rows: atDossiers.map(row => ({ name: row.name, shown: row.shown, escapesMenuX: row.escapesMenuX })),
          menu: atMenuBox, draft: editorFacts(h),
        }))
      h.check(`${viewport.name} ${appearance}: the caret stays inside the Composer and operable at this size with the Host list open`,
        cell.hostAt.caret.rect !== undefined && cell.hostAt.caret.insideEditor
        && atMoved.cursor === '请看 @src/'.length - 1
        && kindCount(h, 'composer.applyKey') === atKeysBefore + 1,
        JSON.stringify({ caret: cell.hostAt.caret, atMoved, applyKeys: kindCount(h, 'composer.applyKey') }))
      h.measure(`${viewport.name} ${appearance}: Host \`@\` cell sizes — visible ${cell.hostAt.rowsVisible}/${cell.hostAt.rowsPainted}, clipped ${JSON.stringify(cell.hostAt.clipped)}`,
        JSON.stringify({ menu: atMenuBox, rows: cell.hostAt.rows.map(row => ({ name: row.name, rect: row.rect, shown: row.shown })) }))
      cells.push(cell)
    }
  }
  await h.send('appearance', 'light')
  await h.resize(1280, 800)
  writeLedger(h, 'geometry-cells.json', cells)

  // ── 20. Source→sink ledger and the honest lane boundaries ────────────────
  const keyCommands = readFileSync(join(out, 'run.log'), 'utf8').split('\n')
    .filter(line => line.startsWith('SEND ok ["key"') || line.startsWith('SEND ok ["commit"') || line.startsWith('SEND ok ["click"'))
  writeLedger(h, 'key-events.jsonl', keyCommands.join('\n'))
  const laneTotals = counters(h)
  const laneLedger = {
    ternVersion,
    sdk: { pin: sdkPin, integrity, installedCapabilities: subjectReady?.caps },
    catalog: { count: catalog.length, names: catalog, provenanceCallSites: productionInstall?.callSites ?? null },
    TIER: 'REAL_TERN_HEADLESS',
    inputTier: 'CONTROL_INJECTED_INPUT',
    inputChannel: inputChannel.kind,
    CLIENT_INTERACTIVE: 'HEADLESS real Tern pane CONTROL_INJECTED_INPUT lane; production Direct composition; node tree/layout/PNG/wire/events read back',
    GUI_PHYSICAL_OS: 'NOT_VERIFIED (no GUI window and no physical OS input in this lane; see the GUI twin)',
    inputMode: 'CONTROL_INJECTED_INPUT (tern ctl key|commit|click); ctl key is control-injected, never an OS keystroke',
    fileSources: {
      hostWorkspace: hostWorkspaceOf(h),
      hostFiles: subjectReady?.hostFiles ?? null,
      clientCwd: clientCwdOf(h),
      clientFiles: subjectReady?.clientFiles ?? null,
      clientCwdLever: subjectReady?.clientCwdLever ?? null,
      productionStagerInstalled: kindCount(h, 'stager.installed') === 1,
      rendererPorts: lastKind(h, 'renderer.observed') ?? null,
    },
    rowAddressing: 'candidate rows are addressed through the CURRENT popup container node (wire role dsh.composer.completion-menu) and its own children (role dsh.composer.completion-item); the SDK frame fold removes a del node with its whole subtree, so no cumulative id pattern (a row key keeps dots: `…_src_deep.ts`) and no stale frame participates',
    visibilityMethod: 'the popup intentionally overflows its Dock ancestor; the oracle numbers are reported, the REAL clip chain is the popup scroller plus the ancestors that contain it, and ctl pick + the PNG decide what the client shows; ctl layers reported no layers on this build (measured)',
    softWrap: 'KNOWN_DIFFERENCE: the contract is hard-newline logical lines; a long candidate line is RECORDED, not asserted',
    bareFallback: 'NOT_VERIFIED: this client negotiates el+styles, so the ≤3 plain ui.text branch is unreachable on a real pane',
    NOT_VERIFIED: [
      'OS physical keyboard / OS IME / OS screen-reader bridge',
      'a pane without el+styles (the ≤3 plain ui.text fallback)',
      'soft-wrapped visual rows',
      'the full Host /sessions Resume transition (the seat-priority case uses the production quick-menu port with a scripted roster)',
      'the BARE fuzzy `@` positive: this fixture mounts the documented empty ctx.fileReferences workspace-index stand-in, so only the explicit `@src/` Host scope is proven end to end here (owned by test/app/pi-tui-file-reference-host.test.ts)',
      'a Session switch A→B→A or a late file read under the real client: the control channel cannot order a keystroke against the intake await, so those fences are owned by the headless Direct suite, not claimed here',
      'the generic-file `/attach` intake on a real pane (the inline chain above proves the image route)',
    ],
    counts: {
      keysArrived: laneTotals.keyArrived,
      composerApplyKey: laneTotals.applyKey,
      completionWrites: laneTotals.applyCompletionEdit,
      fragmentCommits: laneTotals.replaceFragment,
      insertIntoEditor: laneTotals.insertIntoEditor,
      catalogCommits: kindCount(h, 'catalog.install'),
      handlerSubmit: laneTotals.handlerSubmit,
      handlerCancel: laneTotals.handlerCancel,
      writerPrompt: laneTotals.writerPrompt,
      stagerCalls: laneTotals.stagerCalls,
      hostReferenceQueries: laneTotals.hostReferences,
      clientDiscoveryQueries: laneTotals.clientListDirectory + laneTotals.clientFind,
      storeImageAdds: laneTotals.storeImageAdd,
      storeFileAdds: laneTotals.storeFileAdd,
      outboundFrames: laneTotals.frames,
      controlInputs: keyCommands.length,
    },
    assertions: join(out, 'assertions.json'),
  }
  writeLedger(h, 'lane-ledger.json', laneLedger)
  h.measure('CONTROL_INJECTED_INPUT vs physical OS input', laneLedger.inputMode)
  h.measure('REAL_TERN_HEADLESS verdict', laneLedger.CLIENT_INTERACTIVE)
  h.measure('visibility method', laneLedger.visibilityMethod)
  h.measure('soft-wrap known difference', laneLedger.softWrap)
  h.measure('the two file sources this lane materialized', JSON.stringify(laneLedger.fileSources))
  await h.key('F10', 800)
  const shutDown = await waitUntil(h, 'the subject recorded its own F10 shutdown', () =>
    records(h).some(entry => entry.kind === 'fixture.settled' || entry.kind === 'process.exit'), { limit: 40, intervalMs: 250 })
  h.check('the subject shut itself down on F10 and recorded it', shutDown,
    JSON.stringify({ exit: records(h).filter(entry => entry.kind === 'process.exit' || entry.kind === 'fixture.settled').at(-1) }))
  finish(h, {
    tern: ternVersion,
    sdk: { pin: sdkPin, integrity, caps: subjectReady?.caps },
    catalog: { count: catalog.length, names: catalog },
    cells,
    inputChannel: laneLedger.inputChannel,
    TIER: 'REAL_TERN_HEADLESS',
    INPUT_TIER: 'CONTROL_INJECTED_INPUT',
    CLIENT_INTERACTIVE: 'HEADLESS_CONTROL_INJECTED_INPUT',
    GUI_PHYSICAL_OS: 'NOT_VERIFIED',
    softWrap: 'KNOWN_DIFFERENCE_HARD_LOGICAL_LINES_ONLY',
    bareFallback: 'NOT_VERIFIED_EL_AND_STYLES_NEGOTIATED',
    visibilityMethod: laneLedger.visibilityMethod,
    fileSources: laneLedger.fileSources,
    idCounts: laneLedger.counts,
    idNotVerified: laneLedger.NOT_VERIFIED,
  })
}

/** `ctl layers` is the guide's authority for the real clip; record what this
 *  build actually reports instead of assuming it answers. */
function safeLayersMeasure (h) {
  try {
    const layers = h.ctl('layers')
    h.measure('ctl layers', JSON.stringify({ keys: Object.keys(layers), count: layers?.count, reported: (layers?.layers ?? []).length }).slice(0, 400))
  } catch (error) {
    h.measure('ctl layers NOT_VERIFIED', String(error))
  }
}
/** The per-cell clip report: the layers read plus the geometry-derived chain. */
function clipReport (h) {
  try {
    const layers = h.ctl('layers')
    return { layersAvailable: true, count: layers?.count ?? 0, reported: (layers?.layers ?? []).length }
  } catch (error) {
    return { layersAvailable: false, reason: String(error) }
  }
}
