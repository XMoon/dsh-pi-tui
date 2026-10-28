/**
 * The `/preset` real-pane acceptance lane — the v4 TWO-PAGE revision: the catalogue
 * (ONE `ui.picker` with `layout:'cards'`, Built-in/Custom groups and the Owner-shaped
 * THREE-button footer) and the Details page (ONE `lg` overlay: the complete identity,
 * the inline official Mode guide of a SHIPPED preset and the native Back row).
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-preset-native-ux.mjs --out temp/<run>
 *
 * What only the real client can prove, and this lane proves:
 *  - the footer paints the Owner ruling ("a", 2026-10-14) EXACTLY: `Close` alone on
 *    the left, `Set default` beside `Use next` on the right (non-primary packs left,
 *    primary packs right), at EVERY pane size, all contained with real hit targets;
 *    a disabled `Set default` keeps the client's `off` greying and its reason tooltip;
 *  - a REAL click on a not-highlighted card emits exactly one `select` and writes
 *    nothing; a REAL click on the HIGHLIGHTED card emits one `activate` and opens
 *    THAT card's Details; `Enter` opens the highlighted one too and never writes;
 *  - the Details page REPLACES the picker with a `lg` overlay carrying the complete
 *    identity (`details-*` keys), the failure reason, and a SHIPPED preset's pinned
 *    official English guide INLINE as native Markdown — no third page, no `Read mode
 *    guide` jump, and NOTHING writable on the page;
 *  - the Back NAVIGATION row is painted, a REAL click on it returns to the
 *    catalogue (the handler's own intent), and `Esc` is the same `back` intent
 *    from any reading position;
 *  - the committed facts are the cards' own native badges (the ready-phase picker
 *    paints NO status row — Owner ruling "a"), and the Details page states the
 *    complete `Scope:`/relationship facts;
 *  - ONE identity per READING (panel serial + epoch) for the Details page and its
 *    body, so every `scroll` op names the body the CURRENT frame built;
 *  - an admitted write states itself, offers ONLY its dismissal, and a forged footer
 *    action with any other frame token is refused; exactly ONE apply + ONE
 *    setDefault + ONE retry across the whole run.
 *
 * Every containment claim goes through the visibility oracle (`containedXY` /
 * `visibleSpan`); an empty node list FAILS instead of passing vacuously. Artifacts
 * stay in the run directory the driver creates; nothing is deleted.
 * @module scripts/tern-pane-preset-native-ux
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { containedXY, rect as rawRect, visibleSpan } from './tern-pane-geometry.mjs'

/** The oracle's `rect` made TOTAL for a node the client does not paint. */
const rect = (node) => (node === undefined ? [0, 0, 0, 0] : rawRect(node))
const box = (node) => (node === undefined ? 'none' : rect(node).map((n) => Math.round(n * 10) / 10).join(','))

/* ------------------------------------------------------------ the record */

const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((row) => row.frame).map((row) => row.frame)
const lastFrame = (h) => frames(h).at(-1)
const caps = (h) => records(h).find((row) => row.caps)?.caps
const rowEvents = (h) => records(h).filter((row) => row.event && (row.event.ev === 'select' || row.event.ev === 'activate')).map((row) => row.event)
const applies = (h) => records(h).filter((row) => row.apply).map((row) => row.apply.id)
const defaults = (h) => records(h).filter((row) => row.setDefault).map((row) => row.setDefault.id)
const retries = (h) => records(h).filter((row) => row.retry)
const resizes = (h) => records(h).filter((row) => row.resize).map((row) => row.resize)
const scrolls = (h) => records(h).filter((row) => row.nativeScroll).map((row) => row.nativeScroll)
const controls = (h) => records(h).filter((row) => row.control).map((row) => row.control)

/** The SHA-256 of the five modules this run rendered, so the evidence names the exact
 *  contract revision it was taken against. */
const sourceHash = (h) => [
  'preset-picker-view.ts',
  'preset-picker-state.ts',
  'preset-picker-intents.ts',
  'preset-picker.ts',
  'preset-guide-content.ts',
].map((name) => `${name}:${createHash('sha256').update(readFileSync(join(h.repo, 'src', 'tui', 'tsp', name))).digest('hex').slice(0, 12)}`)
  .join(' ')

/* ------------------------------------------------------------- the tree */

const classTokens = (node) => (node.class ?? '').split(' ').filter(Boolean)
const hasClass = (node, name) => classTokens(node).includes(name)
const nodesWith = (snap, name) => snap.nodes.filter((node) => hasClass(node, name))
const pickerNode = (snap) => nodesWith(snap, 'sf-picker')[0]
const sheetNode = (snap) => nodesWith(snap, 'pk-sheet')[0]
const scrollNode = (snap) => nodesWith(snap, 'pk-scroll')[0]
const barNode = (snap) => nodesWith(snap, 'pk-bar')[0]
const overlayNode = (snap) => nodesWith(snap, 'sf-overlay')[0]
const overlayBody = (snap) => nodesWith(snap, 'sf-ov-body')[0]
const markdownNode = (snap) => nodesWith(snap, 'sf-md')[0]
const buttons = (snap) => nodesWith(snap, 'pk-btn')
const cardRows = (snap) => nodesWith(snap, 'pk-row').filter((node) => !hasClass(node, 'grp'))
const groupRows = (snap) => nodesWith(snap, 'pk-row').filter((node) => hasClass(node, 'grp') && !hasClass(node, 'pk-sticky'))
const stickyHead = (snap) => nodesWith(snap, 'pk-row').find((node) => hasClass(node, 'grp') && hasClass(node, 'pk-sticky'))
const operationRows = (snap) => nodesWith(snap, 'sf-row')
const textExactly = (snap, text) => snap.nodes.find((node) => String(node.text ?? '') === text)
const textStarting = (snap, prefix) => snap.nodes.find((node) => String(node.text ?? '').startsWith(prefix))
const nodesIn = (node, name) => {
  const out = []
  const walk = (n) => {
    if (hasClass(n, name)) out.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  if (node !== undefined) walk(node)
  return out
}
const badgesOf = (h, node) => nodesIn(node, 'pk-badge').map((badge) => String(badge.text ?? ''))
const scopeTokens = (snap) => [...new Set(snap.nodes.flatMap(classTokens).filter((token) => /scope/i.test(token)))]
/** The client's own `title` ATTRIBUTE of the picker's header element: the native tooltip the
 *  picker `subtitle` prop really becomes (MEASURED: `pk-title` carries `title="<title> · <subtitle>"`). */
const titleTooltip = (snap) => String(nodesWith(snap, 'pk-title')[0]?.title ?? '')

const actionOf = (frame, base) => (frame?.actions ?? []).find((action) => String(action.id).split('#')[0] === base)
const actionIds = (frame) => (frame?.actions ?? []).map((action) => String(action.id).split('#')[0]).join(',')
const actionLabels = (frame) => (frame?.actions ?? []).map((action) => String(action.label ?? '')).join(' | ')
const itemOf = (frame, id) => (frame?.items ?? []).find((item) => item.id === id)
const textOf = (frame, key) => (frame?.texts ?? []).find((entry) => entry.key === key)?.text
const groupHeads = (frame) => (frame?.order ?? []).filter((entry) => entry !== null && typeof entry === 'object')
/** The pinned official Mode guide of `standard`, as `preset-guide-content.ts` carries it
 *  (source: deepseek-ai/deepseek-harness@d7432673 `packages/client/ui-agent-preset/src/
 *  client/guide-locales.ts`). A FRAGMENT LIST, so a truncated or reordered guide fails
 *  here instead of passing on a prefix. */
const STANDARD_GUIDE = [
  '## Mode details',
  'Choose Standard mode when starting a new task. Describe what you want to accomplish, point to the relevant files, and explain how to check the result.',
  '### How it works',
  'The agent calls tools directly to read and edit files, search, and run terminal commands. It includes Skills, planning, goals, subagents, workflows, and context compaction.',
  '### When to choose it',
  'Start here for everyday coding, file work, and research.',
  '## How to use',
  '### Fix a bug',
  '> Find out why submitting the search form twice makes the results disappear. Fix it and run the relevant tests. Explain the cause and what changed.',
  'Expected output: a code change, the relevant test results, and an explanation of the cause.',
  '### Organize project notes',
  '> Read the Markdown notes in this project. Summarize the agreed decisions and open questions, with links to the source files.',
  'Expected output: a summary with references that you can check against the original notes.',
]

/* ------------------------------------------------------- shared navigation */

/** Walk Esc back to the catalogue — never past it (Esc on the catalogue dismisses the
 *  panel) — and RE-OPEN the panel with the subject's own control when a settled write
 *  dismissed it, so a lost panel fails the next claim instead of cascading. */
const catalogue = async (h) => {
  for (let step = 0; step < 8; step += 1) {
    const page = lastFrame(h)?.page
    if (page === 'catalog') return true
    if (page === 'details') {
      await h.key('Escape', 800)
      continue
    }
    await h.key('r', 900)
    await h.waitFor('Agent presets')
  }
  return lastFrame(h)?.page === 'catalog'
}

/** Highlight one card with real arrow keys only, walking in ONE direction derived from the
 *  roster order (the app owns list navigation and the walk wraps). */
function browseTo(h, id) {
  const items = (lastFrame(h)?.items ?? []).map((item) => String(item.id))
  const from = items.indexOf(String(lastFrame(h)?.selected))
  const to = items.indexOf(String(id))
  if (from < 0 || to < 0) return Promise.resolve(false)
  const forwardBy = (to - from + items.length) % items.length
  const backwardBy = (from - to + items.length) % items.length
  const forward = forwardBy <= backwardBy
  const steps = forward ? forwardBy : backwardBy
  const key = forward ? 'Down' : 'Up'
  return (async () => {
    for (let step = 0; step < steps; step += 1) await h.key(key, 130)
    if (lastFrame(h)?.selected !== id) h.log(`BROWSE-FAIL wanted=${id} got=${lastFrame(h)?.selected} steps=${steps}`)
    return lastFrame(h)?.selected === id
  })()
}

/** Enter the highlighted card's Details page from the keyboard. */
const openDetails = async (h) => {
  await h.key('Return', 900)
  return lastFrame(h)?.page === 'details'
}

/** The card whose own label starts with `label` (an exact-enough match: `Custom preset 1`
 *  must not resolve to `Custom preset 10`). */
const cardLabeled = (h, snap, label) => cardRows(snap).find((node) => h.descendantsText(node).startsWith(label))

/**
 * Open the app's highlighted card's Details page by a REAL pointer ACTIVATION of that
 * card. A click only ever ACTIVATES the card the CLIENT already has highlighted, and
 * the client reflects the app's `selected` prop a moment after the frame is committed,
 * so the step waits until the client's own tree agrees before it clicks.
 */
const activateDetails = async (h) => {
  const label = String(itemOf(lastFrame(h), String(lastFrame(h)?.selected))?.label ?? '')
  for (let tries = 0; tries < 5; tries += 1) {
    const snap = h.snapshot()
    const row = cardLabeled(h, snap, label)
    if (row !== undefined && hasClass(row, 'sel') && containedXY(snap.chains, row)) {
      const before = rowEvents(h).length
      await h.click(snap.chains, row)
      const events = rowEvents(h).slice(before)
      h.log(`ACTIVATE label=${JSON.stringify(label)} rect=${box(row)} events=${JSON.stringify(events)}`)
      return lastFrame(h)?.page === 'details' && events.some((event) => event.ev === 'activate')
    }
    await h.sleep(300)
  }
  h.log(`ACTIVATE-ABORT label=${JSON.stringify(label)}`)
  return false
}

/** Press one key up to `tries` times until the CLIENT's own box for a node moves by more
 *  than a pixel (the documented credit stall can drop a scroll key). */
const scrollUntilMoved = async (h, yOf, key, tries = 4) => {
  const start = yOf()
  let moved = 0
  let used = 0
  while (used < tries && moved <= 1) {
    await h.key(key, 600)
    used += 1
    moved = start - yOf()
  }
  return { moved, tries: used, start }
}

/* ---------------------------------------------------- the painted footer order */

/**
 * The Owner ruling ("a") is a VISUAL claim about the PAINTED buttons: `Close` alone
 * left, `Set default` beside `Use next` right, by the client's own pack rule. This
 * reads the real client tree — sorted by x, never the wire array order.
 */
const paintedFooter = (h, snap) => buttons(snap)
  .map((node) => ({ node, text: h.descendantsText(node).replace(' [Enter]', '') }))
  .sort((a, b) => rect(a.node)[0] - rect(b.node)[0])

/* ------------------------------------------------------------------- matrix */

/**
 * One pane size. It asserts the presenter's claim against the client's OWN classes,
 * the ONE-COLUMN card list, the groups, the Owner-shaped footer, and the Details
 * page's identity/reading body are contained.
 */
const matrixCell = async (h, size) => {
  await catalogue(h)
  await h.resize(size.w, size.h)
  const snap = h.snapshot()
  const frame = lastFrame(h)
  const cellKey = `${size.w}x${size.h}`
  const resize = resizes(h).at(-1)
  const panePx = resize?.cols * (resize?.cell?.w ?? 0)
  const sheet = sheetNode(snap)
  const list = scrollNode(snap)
  const cards = cardRows(snap)
  const groups = groupRows(snap)
  const cardX = [...new Set(cards.map((node) => Math.round(rect(node)[0])))]
  const cardW = [...new Set(cards.map((node) => Math.round(rect(node)[2])))]
  const cardY = cards.map((node) => rect(node)[1])
  const rowHeights = [...new Set(cards.map((node) => Math.round(rect(node)[3])))]
  const wide = size.w >= 900
  const painted = paintedFooter(h, snap)

  h.check(`${cellKey}: the presenter claims the cards layout, the md sheet and no preview region`,
    frame?.page === 'catalog' && frame?.layout === 'cards' && frame?.size === 'md' && frame?.preview === 'none',
    JSON.stringify({ page: frame?.page, layout: frame?.layout, size: frame?.size, preview: frame?.preview, panePx }))
  h.check(`${cellKey}: the client paints lay-cards on the md sheet and no pv-below`,
    hasClass(pickerNode(snap), 'lay-cards') && hasClass(pickerNode(snap), 'sz-md') && hasClass(pickerNode(snap), 'pv-none'),
    classTokens(pickerNode(snap)).join(' '))
  h.check(`${cellKey}: the md sheet is the client's own modal dialog, contained in the pane`,
    sheet !== undefined && containedXY(snap.chains, sheet) && rect(sheet)[2] > 0 && rect(sheet)[2] <= size.w
    && (!wide || Math.abs(rect(sheet)[2] - 680) <= 20),
    `sheet@${box(sheet)} pane=${cellKey}`)
  h.check(`${cellKey}: the catalogue paints no preview region, no fact column and no scope column`,
    nodesWith(snap, 'pk-pv').length === 0 && nodesWith(snap, 'pk-fact').length === 0 && scopeTokens(snap).length === 0
    && !(frame?.propKeys ?? []).includes('scopes') && !(frame?.propKeys ?? []).includes('columns'),
    `pk-pv=${nodesWith(snap, 'pk-pv').length} pk-fact=${nodesWith(snap, 'pk-fact').length} scopes=${scopeTokens(snap).join(',')}`)
  h.check(`${cellKey}: the list paints ONE column of equal-width cards, no two sharing a row`,
    cards.length > 0 && cardX.length === 1 && cardW.length === 1 && cardW[0] > 0 && new Set(cardY).size === cardY.length
    && Math.abs(cardW[0] - (rect(list)[2] - 20)) < 2,
    `cards=${cards.length} x=${cardX.join(',')} w=${cardW.join(',')} list=${box(list)}`)
  h.check(`${cellKey}: the card rows share ONE height${wide ? ' and it is the client\'s fixed 54px card row' : ''}`,
    rowHeights.length === 1 && (!wide || Math.abs(rowHeights[0] - 54) <= 1),
    `heights=${rowHeights.join(',')}`)
  h.check(`${cellKey}: both group heads are painted in flow and the first is on screen`,
    groups.length === 2 && groupHeads(frame).length === 2 && groups[0] !== undefined && containedXY(snap.chains, groups[0])
    && h.descendantsText(groups[0]).includes('Built-in') && (frame?.items ?? []).length > 0,
    `${groups.map((node) => `${h.descendantsText(node)}@${box(node)} contained=${containedXY(snap.chains, node)}`).join(' | ')}`)

  // ---- THE OWNER-SHAPED FOOTER (ruling "a"): the decisive painted-order claim.
  h.check(`${cellKey}: the footer is EXACTLY the three native buttons in the Owner shape — Close left, Set default beside Use next right`,
    buttons(snap).length === 3 && actionIds(frame) === 'close,set-default,use'
    && painted.map((entry) => entry.text).join('|') === 'Close|Set default|Use next'
    && painted[0].node !== undefined && rect(painted[0].node)[0] < rect(painted[1].node)[0] + 8
    && rect(painted[2].node)[0] - (rect(painted[1].node)[0] + rect(painted[1].node)[2]) < 24
    && buttons(snap).every((node) => containedXY(snap.chains, node)),
    `painted=${painted.map((entry) => `${entry.text}@${box(entry.node)}`).join(' ')} :: ${actionIds(frame)} :: ${actionLabels(frame)}`)
  h.check(`${cellKey}: both writes carry the client's primary weight; Close stays plain`,
    hasClass(painted[0].node, 'pk-btn') && !hasClass(painted[0].node, 'primary')
    && hasClass(painted[1].node, 'primary') && hasClass(painted[2].node, 'primary'),
    painted.map((entry) => `${entry.text}[${classTokens(entry.node).join(' ')}]`).join(' '))
  h.check(`${cellKey}: every button has a real hit target (>= 16px wide and tall) and the writes stay inside the sheet`,
    buttons(snap).every((node) => rect(node)[2] >= 16 && rect(node)[3] >= 16)
    && nodesIn(barNode(snap), 'primary').length === 2
    && nodesIn(barNode(snap), 'primary').every((node) => containedXY(snap.chains, node) && rect(node)[2] > 8),
    buttons(snap).map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' '))

  h.measure(`${cellKey}: the list box, the painted cards and the cards the fold clips`,
    JSON.stringify({
      list: rect(list), painted: cards.length, clipped: cards.filter((node) => !containedXY(snap.chains, node)).length,
      sheet: rect(sheet), panePx, rowHeights,
      footer: painted.map((entry) => ({ text: entry.text, rect: rect(entry.node) })),
      groupVisibleSpan: groups.map((node) => visibleSpan(snap.chains, node, 'y')),
    }))
  h.capture(`catalog-${cellKey}`, `the ${cellKey} cards catalogue with the Owner-shaped footer`)

  // The Details page REPLACES the picker at this size as well; its frozen first
  // screen carries the Back navigation row and the identity block without scrolling.
  const opened = await openDetails(h)
  const details = h.snapshot()
  const body = overlayBody(details)
  const backNode = details.nodes.find((node) => hasClass(node, 'sf-act') && h.descendantsText(node).includes('Back to presets'))
  h.check(`${cellKey}: the Details page is a lg overlay whose body and Back navigation row are on screen`,
    opened && overlayNode(details) !== undefined && hasClass(overlayNode(details), 'sz-lg')
    && body !== undefined && containedXY(details.chains, body)
    && backNode !== undefined && containedXY(details.chains, backNode) && rect(backNode)[3] > 8,
    `opened=${opened} overlay=${overlayNode(details) === undefined ? 'none' : classTokens(overlayNode(details)).join(' ')} body=${box(body)} back=${box(backNode)}`)
  // Owner A4 amendment: the way back is the #301-proven native NAVIGATION row —
  // its label states the destination and the Esc twin, it is a real pointer
  // target, and NO el node and NO stylesheet exist anywhere on this layer.
  const backLabelText = (lastFrame(h)?.texts ?? [])
    .filter((entry) => String(entry.key).startsWith('preset-details-back-label'))
    .map((entry) => entry.text).join('')
  h.check(`${cellKey}: the Back row states the destination and its Esc twin (navigation, not a write)`,
    backLabelText.includes('← Back to presets') && backLabelText.includes('Esc'),
    `label=${JSON.stringify(backLabelText)}`)
  h.check(`${cellKey}: the Details first screen states the identity (Name/ID/Type/Scope) without scrolling`,
    textOf(lastFrame(h), 'details-name') !== undefined && textOf(lastFrame(h), 'details-id') !== undefined
    && textOf(lastFrame(h), 'details-type') !== undefined && textOf(lastFrame(h), 'details-scope') !== undefined
    && String(textOf(lastFrame(h), 'details-scope')).includes('Default: future new sessions'),
    JSON.stringify({ name: textOf(lastFrame(h), 'details-name'), id: textOf(lastFrame(h), 'details-id'), scope: textOf(lastFrame(h), 'details-scope') }))
  h.check(`${cellKey}: a reading page carries no picker and no footer (its ONE row is the Back navigation)`,
    pickerNode(h.snapshot()) === undefined && (lastFrame(h)?.actions ?? undefined) === undefined
    && operationRows(h.snapshot()).length === 1 && (lastFrame(h)?.back?.clickable === true),
    `sf-picker=${nodesWith(h.snapshot(), 'sf-picker').length} actions=${JSON.stringify(lastFrame(h)?.actions)} back=${JSON.stringify(lastFrame(h)?.back)}`)
  h.capture(`details-${cellKey}`, `the ${cellKey} Details page`)
  await catalogue(h)
  return { metrics: { panePx, sheetWidth: rect(sheet)[2], sheetHeight: rect(sheet)[3], cards: cards.length, cardWidth: cardW[0], rowHeight: rowHeights[0] } }
}

/* ------------------------------------------------------------------- flow */

export default async function (h) {
  // ------------------------------------------------- claim 1: boot at 1280x800
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-preset-native-ux-subject.mts')
  const booted = await h.launch(subject, { ready: 'Agent presets' })
  h.check('the native preset picker boots inside a real Tern pane', booted, h.texts(h.snapshot()).join(' | '))
  if (!booted) return
  h.measure('the client build and the modules under test',
    `${caps(h)?.term ?? '?'} ${caps(h)?.ver ?? '?'} :: ${JSON.stringify(caps(h)?.kinds ?? [])} :: ${JSON.stringify(caps(h)?.features ?? [])} :: ${sourceHash(h)}`)
  h.check('the client advertises the kinds and the scroll feature the preset layer requires',
    ['picker', 'row', 'overlay', 'text', 'md'].every((kind) => (caps(h)?.kinds ?? []).includes(kind))
    && (caps(h)?.features ?? []).includes('scroll'),
    JSON.stringify({ kinds: caps(h)?.kinds, features: caps(h)?.features }))

  let snap = h.snapshot()
  let frame = lastFrame(h)
  h.check('boot: the catalogue is the cards layout, the md sheet, no preview and the honest title',
    frame?.page === 'catalog' && frame?.layout === 'cards' && frame?.size === 'md' && frame?.preview === 'none'
    && frame?.title === 'Agent presets',
    JSON.stringify({ page: frame?.page, layout: frame?.layout, size: frame?.size, preview: frame?.preview, title: frame?.title }))
  h.check('boot: the catalogue declares the two groups with the true counts and every real row',
    groupHeads(frame).length === 2
    && groupHeads(frame)[0].label === 'Built-in' && groupHeads(frame)[0].count === 4
    && groupHeads(frame)[1].label === 'Custom' && groupHeads(frame)[1].count === 13
    && frame?.total === 17,
    JSON.stringify(groupHeads(frame)))
  h.check('boot: a shipped card keeps the fixed English copy, the classification and its summary',
    itemOf(frame, 'preset:standard')?.label === 'Standard mode'
    && String(itemOf(frame, 'preset:standard')?.detail).startsWith('Built-in · ')
    && String(itemOf(frame, 'preset:standard')?.detail).includes('Full coding agent'),
    JSON.stringify(itemOf(frame, 'preset:standard')))
  h.check('boot: the shipped and Custom badges are the real state, never the browse highlight',
    JSON.stringify(badgesOf(h, cardLabeled(h, snap, 'PTC mode'))) === JSON.stringify(['Default'])
    && JSON.stringify(badgesOf(h, cardLabeled(h, snap, 'Creator mode'))) === JSON.stringify(['Next session'])
    && badgesOf(h, cardLabeled(h, snap, 'Custom preset 1')).length === 0,
    cardRows(snap).slice(0, 8).map((node) => `${h.descendantsText(node).slice(0, 16)}${JSON.stringify(badgesOf(h, node))}`).join(' | '))
  // The broken declaration is the LAST card: walk the list down to it with real keys.
  const walkedToBroken = await browseTo(h, 'preset:broken-preset')
  // One snapshot supplies BOTH the node and the chains the oracle reads.
  const brokenSnap = h.snapshot()
  const brokenCard = cardLabeled(h, brokenSnap, 'Broken preset')
  h.check('boot: a broken card states `Failed to load` in words and keeps its reason readable',
    walkedToBroken && itemOf(frame, 'preset:broken-preset')?.dot === 'error'
    && String(itemOf(frame, 'preset:broken-preset')?.detail).includes('missing-tools')
    && brokenCard !== undefined && containedXY(brokenSnap.chains, brokenCard)
    && h.descendantsText(brokenCard).includes('Failed to load')
    && h.descendantsText(brokenCard).includes('missing-tools')
    // The walk made it the browse target, so the native `Draft` marker rides the same card.
    && badgesOf(h, brokenCard).includes('Draft'),
    `walked=${walkedToBroken} card=${brokenCard === undefined ? 'none' : h.descendantsText(brokenCard).slice(0, 60)} :: ${JSON.stringify(itemOf(frame, 'preset:broken-preset'))}`)
  h.check('boot: the highlighted card is the run-local pending preset (a sessionless subject has no Current)',
    frame?.selected === 'preset:cordis' && JSON.stringify(frame?.current) === '[]',
    `selected=${JSON.stringify(frame?.selected)} current=${JSON.stringify(frame?.current)}`)
  h.check('boot: the footer is exactly the THREE Owner entries in the Owner array order, Use carries its frame token',
    actionIds(frame) === 'close,set-default,use' && actionOf(frame, 'close')?.id === 'close'
    && /^set-default#\d+$/.test(String(actionOf(frame, 'set-default')?.id))
    && /^use#\d+$/.test(String(actionOf(frame, 'use')?.id))
    && actionLabels(frame) === 'Close | Set default | Use next',
    `${actionIds(frame)} :: ${actionLabels(frame)}`)
  // Owner ruling "a": the ready-phase picker paints NO status row; the tooltip and the
  // badges are the catalogue's only committed-fact statements.
  h.check('the catalogue paints no status ROW: the committed facts are the cards\' native badges (Owner ruling a)',
    !h.texts(snap).some((line) => line.includes('Next session:') || line.includes('New-session default:'))
    && String(titleTooltip(snap)).includes('Tab actions')
    && badgesOf(h, cardLabeled(h, snap, 'Creator mode')).includes('Next session')
    && badgesOf(h, cardLabeled(h, snap, 'PTC mode')).includes('Default'),
    `tooltip=${JSON.stringify(titleTooltip(snap))} visible=${h.texts(snap).filter((line) => line.includes('session'))}`)
  h.measure('the native tooltip the catalogue header really carries', JSON.stringify(titleTooltip(snap)))
  h.capture('catalog-1280x800', 'the wide cards catalogue: groups, badges, Owner-shaped footer')
  // Walk back to a HEALTHY shipped preset so the list returns to its top (the client
  // virtualizes the scrolled list) and every later reading describes an ENABLED page.
  h.check('the walk back to the top re-selects a healthy shipped preset',
    await browseTo(h, 'preset:ptc'), `selected=${JSON.stringify(lastFrame(h)?.selected)}`)

  // ------------------------------------------------------------------ B. matrix
  const metrics = []
  for (const size of [{ w: 400, h: 600 }, { w: 560, h: 640 }, { w: 900, h: 640 }, { w: 1280, h: 800 }]) {
    const cell = await matrixCell(h, size)
    metrics.push({ size: `${size.w}x${size.h}`, ...cell.metrics })
  }
  h.check('no pane leaves the cards layout: the catalogue declares no breakpoint anywhere',
    metrics.every((entry) => entry.sheetWidth > 0 && entry.sheetWidth <= entry.panePx && entry.cards > 0),
    JSON.stringify(metrics))
  h.measure('every pane\'s md sheet box, card count and card width', JSON.stringify(metrics))

  // -------------------------------------------- C. select vs activate vs Enter
  await catalogue(h)
  await h.resize(1280, 800)
  await browseTo(h, 'preset:standard')
  const firstFrame = lastFrame(h)
  const targetSnap = h.snapshot()
  const target = cardLabeled(h, targetSnap, 'Custom preset 3')
  const targetItem = itemOf(firstFrame, 'preset:custom-3')
  const selectsBefore = rowEvents(h).length
  const clicked = target === undefined ? false : await h.click(targetSnap.chains, target)
  const selectEvents = rowEvents(h).slice(selectsBefore)
  snap = h.snapshot()
  h.check('one REAL click on a card the user had NOT highlighted (selected was `standard`) emits exactly one `select` and writes nothing',
    clicked && selectEvents.length === 1 && selectEvents[0].ev === 'select'
    && String(selectEvents[0].item) === String(targetItem?.id) && lastFrame(h)?.selected === 'preset:custom-3'
    && lastFrame(h)?.page === 'catalog' && applies(h).length === 0,
    `clicked=${clicked} events=${JSON.stringify(selectEvents)} selected=${JSON.stringify(lastFrame(h)?.selected)}`)
  h.check('the click only moved the browse highlight: the catalogue and its own picker node are still there',
    pickerNode(snap) !== undefined && nodesWith(snap, 'sf-overlay').length === 0,
    `picker=${box(pickerNode(snap))} overlay=${nodesWith(snap, 'sf-overlay').length}`)

  const activatesBefore = rowEvents(h).length
  const activated = await activateDetails(h)
  const activateEvents = rowEvents(h).slice(activatesBefore)
  h.check('a second REAL click on the now-highlighted card emits exactly one `activate` and opens THAT card',
    activated && activateEvents.length === 1 && activateEvents[0].ev === 'activate'
    && String(activateEvents[0].item) === 'preset:custom-3' && lastFrame(h)?.head === 'Custom preset 3'
    && applies(h).length === 0,
    `events=${JSON.stringify(activateEvents)} head=${JSON.stringify(lastFrame(h)?.head)}`)
  await catalogue(h)
  const entered = await openDetails(h)
  h.check('Enter on the catalogue opens the highlighted card\'s Details page and never writes',
    entered && applies(h).length === 0 && lastFrame(h)?.head === 'Custom preset 3',
    `entered=${entered} applies=${applies(h).length} head=${JSON.stringify(lastFrame(h)?.head)}`)

  // ------------------------------------- D. the Details page: Back, guide, readonly
  await catalogue(h)
  await browseTo(h, 'preset:standard')
  await openDetails(h)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('the Details page REPLACES the picker with a lg overlay headed by the preset it describes',
    frame?.page === 'details' && overlayNode(snap) !== undefined && hasClass(overlayNode(snap), 'sz-lg')
    && frame?.head === 'Standard mode' && pickerNode(snap) === undefined,
    `page=${JSON.stringify(frame?.page)} head=${JSON.stringify(frame?.head)} overlay=${overlayNode(snap) === undefined ? 'none' : classTokens(overlayNode(snap)).join(' ')}`)
  h.check('the identity block carries the COMPLETE Name/ID/Type/Scope (the relationship block is asserted on the default row)',
    textOf(frame, 'details-name') === 'Standard mode' && textOf(frame, 'details-id') === 'standard'
    && textOf(frame, 'details-type') === 'Built-in'
    && String(textOf(frame, 'details-scope')) === 'Use: next session only · Default: future new sessions',
    JSON.stringify(frame?.texts))
  h.check('the page is READ-ONLY: no footer actions, ONE Back navigation row, ONE md body',
    (frame?.actions ?? undefined) === undefined && operationRows(snap).length === 1
    && frame?.back?.clickable === true
    && markdownNode(snap) !== undefined,
    JSON.stringify({ actions: frame?.actions, back: frame?.back, rows: operationRows(snap).length, md: markdownNode(snap) !== undefined }))
  h.check('the official guide is INLINE on the same page: the pinned copy, complete, in order',
    (frame?.markdown?.text ?? '').startsWith(STANDARD_GUIDE[0])
    && (frame?.markdown?.text ?? '').endsWith(STANDARD_GUIDE.at(-1))
    && STANDARD_GUIDE.every((fragment) => (frame?.markdown?.text ?? '').includes(fragment)),
    `length=${frame?.markdown?.length} missing=${JSON.stringify(STANDARD_GUIDE.filter((f) => !(frame?.markdown?.text ?? '').includes(f)))}`)
  h.check('the client renders the Markdown as real headings and paragraphs, not raw markers',
    textExactly(snap, 'Mode details') !== undefined && textExactly(snap, 'How to use') !== undefined
    && textExactly(snap, 'How it works') !== undefined && textExactly(snap, 'Fix a bug') !== undefined
    && !h.texts(snap).some((line) => line.includes('## ')),
    h.texts(snap).slice(0, 16).join(' | '))
  h.capture('details-guide-top-1280x800', 'the Details page: identity, description and the inline guide (Back pre-click)')

  // The Back NAVIGATION row: one REAL click, back to the catalogue (the row's own
  // onClick runs the SAME `back` intent the keyboard sends).
  const backNode = snap.nodes.find((node) => hasClass(node, 'sf-act') && h.descendantsText(node).includes('Back to presets'))
  const backClicked = backNode === undefined ? false : await h.click(snap.chains, backNode)
  await h.sleep(600)
  h.check('one REAL click on the Back row runs the SAME back intent and returns to the catalogue',
    backClicked && lastFrame(h)?.page === 'catalog' && lastFrame(h)?.selected === 'preset:standard',
    `clicked=${backClicked} page=${JSON.stringify(lastFrame(h)?.page)}`)
  // (The pre-click Details capture `details-guide-top-1280x800` is the Back
  // row's evidence shot; the post-click page is the catalogue.)

  // ------------------------------------------------- E. the catalogue writes
  await browseTo(h, 'preset:standard')
  // The PRIMARY POINTER path first: one REAL click on the painted `Use next`
  // button (the Owner mock's main action), with the write-count assertion.
  const appliesBefore = applies(h).length
  const useClicked = await sendUse(h)
  await h.sleep(1500)
  h.check('one REAL click on the painted `Use next` button admits exactly one write with the RIGHT preset (the PRIMARY pointer path)',
    useClicked && applies(h).length === appliesBefore + 1 && applies(h).at(-1) === 'standard',
    `clicked=${useClicked} applies=${JSON.stringify(applies(h))}`)
  const pendingFrame = frames(h).find((entry) => entry.message === 'Applying preset…')
  h.check('an admitted write states itself and offers ONLY its dismissal',
    pendingFrame !== undefined && actionIds(pendingFrame) === 'close'
    && actionOf(pendingFrame, 'close')?.label === 'Close',
    JSON.stringify({ ids: actionIds(pendingFrame), message: pendingFrame?.message }))
  await h.sleep(1500)
  h.check('the refusal restores the catalogue with its target and its reason in words',
    lastFrame(h)?.page === 'catalog' && lastFrame(h)?.selected === 'preset:standard'
    && lastFrame(h)?.message === 'preset "standard" does not resolve',
    `page=${JSON.stringify(lastFrame(h)?.page)} message=${JSON.stringify(lastFrame(h)?.message)} selected=${JSON.stringify(lastFrame(h)?.selected)}`)
  // The PRIMARY KEYBOARD path second: Tab into the footer, Enter on the focused
  // entry — the SAME admission the click took.
  const appliesBeforeKeys = applies(h).length
  await h.key('Tab', 500)
  h.check('Tab moves the catalogue focus onto the Use write and shows the `Verb [Enter]` cue there',
    actionOf(lastFrame(h), 'use')?.label === 'Use next [Enter]'
    && actionOf(lastFrame(h), 'close')?.label === 'Close',
    JSON.stringify(lastFrame(h)?.actions))
  await h.key('Return', 900)
  h.check('Enter on the focused Use button admits exactly one write with the RIGHT preset (the PRIMARY keyboard path)',
    applies(h).length === appliesBeforeKeys + 1 && applies(h).at(-1) === 'standard',
    `applies=${JSON.stringify(applies(h))}`)
  // Wait out this second in-flight write (the subject settles it after ~1.2s):
  // the next section clicks the painted `Set default` button, which only exists
  // once the refusal restored the three-button footer.
  await h.sleep(1500)
  h.check('the second refusal restores the three-button footer with its reason',
    lastFrame(h)?.page === 'catalog' && actionIds(lastFrame(h)) === 'close,set-default,use'
    && String(lastFrame(h)?.message ?? '').includes('does not resolve'),
    `page=${JSON.stringify(lastFrame(h)?.page)} ids=${actionIds(lastFrame(h))} message=${JSON.stringify(lastFrame(h)?.message)}`)

  // The Set default write through the SAME footer, then the disabled shape.
  const defaultsBeforeClick = defaults(h).length
  await sendSetDefault(h)
  await h.sleep(1500)
  h.check('one REAL Set default click reaches the config writer exactly once',
    defaults(h).length === defaultsBeforeClick + 1 && defaults(h).at(-1) === 'standard',
    `defaults=${JSON.stringify(defaults(h))}`)
  // A SAVED default write DISMISSES the panel (the next read is authoritative), so
  // this section re-opens it before walking to the recorded default row.
  await catalogue(h)
  await browseTo(h, 'preset:ptc')   // the recorded new-session default
  frame = lastFrame(h)
  h.check('the default-preset\'s Set default is DISABLED with its reason on the tooltip (Owner ruling a)',
    actionOf(frame, 'set-default')?.disabled === 'Already the default',
    JSON.stringify(actionOf(frame, 'set-default')))
  const footerSnap = h.snapshot()
  const disabledBtn = paintedFooter(h, footerSnap).find((entry) => entry.text === 'Set default')?.node
  h.check('the disabled button keeps the client\'s off marker and the reason attribute, and is still painted',
    disabledBtn !== undefined && hasClass(disabledBtn, 'off') && String(disabledBtn.title) === 'Already the default'
    && containedXY(footerSnap.chains, disabledBtn),
    `cls=${classTokens(disabledBtn ?? snap.nodes[0]).join(' ')} title=${JSON.stringify(String(disabledBtn?.title ?? ''))}`)
  await h.key('g', 500)   // and the forged raw action at that footer id
  await h.sleep(600)
  h.check('a forged footer action at the DISABLED entry writes nothing',
    controls(h).includes('forged-disabled-footer') && defaults(h).length === defaultsBeforeClick + 1,
    `controls=${JSON.stringify(controls(h))} defaults=${defaults(h).length}/${defaultsBeforeClick + 1}`)

  // ---------------------------------------- F. the guide's tail scroll + long values
  await catalogue(h)
  await browseTo(h, 'preset:standard')
  const guideOpened = await openDetails(h)
  if (!guideOpened) h.log('GUIDE-OPEN-FAIL page=' + String(lastFrame(h)?.page))
  await h.resize(400, 600)
  const narrowBody = overlayBody(h.snapshot())
  const narrowMd = markdownNode(h.snapshot())
  h.check(`at the 400x600 minimum the inline guide is TALLER than its viewport, so it must scroll`,
    guideOpened && narrowBody !== undefined && narrowMd !== undefined && rect(narrowMd)[3] > rect(narrowBody)[3],
    `opened=${guideOpened} page=${JSON.stringify(lastFrame(h)?.page)} md=${box(narrowMd)} body=${box(narrowBody)}`)
  const guided = await scrollUntilMoved(h, () => rect(markdownNode(h.snapshot()))[1], 'End')
  h.check('a real End key (retried across the documented stall) moves the CLIENT viewport to the tail',
    scrolls(h).some((op) => op.to === 'end') && guided.moved > 1,
    `moved=${guided.moved} tries=${guided.tries} scrolls=${JSON.stringify(scrolls(h).slice(-2))}`)
  h.measure('the Guide scroll stall observed (End)', JSON.stringify(guided))
  h.capture('guide-tail-400x600', 'the inline guide at the tail in the minimum pane')
  const tailSnap = h.snapshot()
  const guideTail = textStarting(tailSnap, 'Expected output: a summary with references')
  h.check('the tail of the guide is really on screen after the scroll',
    guideTail !== undefined && containedXY(tailSnap.chains, guideTail),
    `tail=${guideTail === undefined ? 'none' : `${String(guideTail.text).slice(0, 40)}@${box(guideTail)}`}`)

  // A Custom declaration that reuses a shipped id must NOT borrow the official guide.
  await catalogue(h)
  await h.resize(1280, 800)
  await h.key('3', 900)
  await h.waitFor('My minimal')
  await openDetails(h)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('a Custom declaration reusing a shipped id stays Custom with NO guide section',
    frame?.page === 'details' && textOf(frame, 'details-id') === 'minimal'
    && textOf(frame, 'details-type') === 'Custom' && textOf(frame, 'details-name') === 'My minimal'
    && markdownNode(snap) === undefined
    && h.texts(snap).every((line) => !line.includes('Mode details')),
    JSON.stringify({ id: textOf(frame, 'details-id'), type: textOf(frame, 'details-type'), md: markdownNode(snap) !== undefined }))

  // ------------------------- F2. the LONG-VALUE fixture (plan P07): the 180-glyph
  // unbroken id, the CRLF/CJK/emoji description and the long failure reason must be
  // COMPLETE on the wire AND visibly wrapped/clipped by the real client.
  await catalogue(h)
  await h.key('2', 900)
  await h.waitFor('A long custom preset')
  const longItem = (lastFrame(h)?.items ?? []).find((item) => String(item.id).startsWith('preset:no-space-'))
  const longId = String(longItem?.id ?? '').slice('preset:'.length)
  const longBrowsed = await browseTo(h, String(longItem?.id))
  const longOpened = longBrowsed && await openDetails(h)
  frame = lastFrame(h)
  snap = h.snapshot()
  const idNode = textStarting(snap, 'no-space-')
  const brokenNode = textStarting(snap, 'plugin "missing-tools" is not installed:')
  const descriptionNode = textStarting(snap, 'Long description')
  const lineControl = textExactly(snap, 'Custom')
  const lineHeight = rect(lineControl)[3]
  h.check('the long-value fixture opens its Details page and renders the 180-glyph id, CJK/emoji description and failure reason COMPLETE',
    longOpened && textOf(frame, 'details-id') === longId && String(textOf(frame, 'details-id')).length > 180
    && String(textOf(frame, 'details-description')).includes('中文描述')
    && String(textOf(frame, 'details-description')).includes('paragraph 11')
    && String(textOf(frame, 'details-broken')).endsWith('tail-of-the-reason'),
    JSON.stringify({
      opened: longOpened, idLength: String(textOf(frame, 'details-id')).length,
      descriptionLength: String(textOf(frame, 'details-description')).length,
      brokenLength: String(textOf(frame, 'details-broken')).length,
    }))
  h.check('the client really WRAPS those values into many painted lines (P07: CJK/emoji/unbroken id)',
    idNode !== undefined && brokenNode !== undefined && descriptionNode !== undefined && lineHeight > 0
    && rect(idNode)[3] >= 2 * lineHeight && rect(descriptionNode)[3] >= 4 * lineHeight
    && rect(brokenNode)[3] >= 2 * lineHeight,
    `line=${lineHeight} id=${box(idNode)} description=${box(descriptionNode)} broken=${box(brokenNode)}`)
  h.measure('the long-value line counts (client-painted)', JSON.stringify({
    lineHeight,
    idLines: rect(idNode)[3] / lineHeight,
    descriptionLines: rect(descriptionNode)[3] / lineHeight,
    brokenLines: rect(brokenNode)[3] / lineHeight,
    idVisibleSpanX: idNode === undefined ? 0 : visibleSpan(snap.chains, idNode, 'x'),
  }))
  // The long page really scrolls to its tail. The client paints the whole
  // description as ONE wrapped node (its height IS the painted line count), so the
  // to-tail proof is geometric: after End, that node's BOTTOM edge sits at/above
  // the body's bottom edge (the document end is in view). A negative control
  // first: at the top, the description's bottom is far below the body's bottom.
  await h.resize(400, 600)
  const descAt = (snap) => {
    const node = textStarting(snap, 'Long description')
    const body = overlayBody(snap)
    if (node === undefined || body === undefined) return undefined
    return { nodeBottom: rect(node)[1] + rect(node)[3], bodyBottom: rect(body)[1] + rect(body)[3] }
  }
  const before = descAt(h.snapshot())
  h.check('the negative control: at the top the description\'s bottom is far below the viewport bottom',
    before !== undefined && before.nodeBottom - before.bodyBottom > 200,
    JSON.stringify(before))
  const longScrolled = await scrollUntilMoved(h, () => {
    const now = descAt(h.snapshot())
    return now === undefined ? 0 : now.nodeBottom - now.bodyBottom
  }, 'End')
  const after = descAt(h.snapshot())
  h.check('a real End key brings the document tail into the body (the description\'s bottom meets the viewport bottom, P07)',
    longScrolled.moved > 1 && after !== undefined && after.nodeBottom - after.bodyBottom <= 8,
    `moved=${longScrolled.moved} tries=${longScrolled.tries} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  // MEASURED (review round 5 / Owner ruling): the Back row lives at the TOP of the
  // ONE body scroller, so at the tail it has scrolled out of the viewport; the
  // ALWAYS-available fixed way back at ANY scroll position is `Esc`. Capture the
  // Details tail FIRST (with the row's real geometry as the visibility evidence),
  // then prove Esc-at-tail returns to the catalogue keeping the target.
  const snapAtTail = h.snapshot()
  const backAtTail = snapAtTail.nodes.find((node) => hasClass(node, 'sf-act') && h.descendantsText(node).includes('Back to presets'))
  const bodyAtTail = overlayBody(snapAtTail)
  const backVisibleAtTail = backAtTail !== undefined
    && containedXY(snapAtTail.chains, backAtTail) && rect(backAtTail)[3] > 0
  h.measure('the Back row at the tail (geometric visibility — expected out of view; Esc is the fixed path)',
    JSON.stringify({
      back: box(backAtTail),
      backContained: backAtTail === undefined ? null : containedXY(snapAtTail.chains, backAtTail),
      body: box(bodyAtTail),
    }))
  h.capture('details-long-values-400x600', 'the long Details page at the tail (Back row scrolled out; Esc is the fixed path)')
  const appliesBeforeEsc = applies(h).length
  await h.key('Escape', 900)
  h.check('Esc at the TAIL returns to the catalogue (the fixed keyboard way back works at any scroll position)',
    lastFrame(h)?.page === 'catalog' && applies(h).length === appliesBeforeEsc,
    `page=${JSON.stringify(lastFrame(h)?.page)} backVisibleAtTail=${backVisibleAtTail}`)
  h.capture('catalog-after-esc-at-tail-400x600', 'the catalogue after Esc at the tail (the fixed keyboard way back)')
  await catalogue(h)
  await h.resize(1280, 800)

  // ------------------------------- G. ONE identity per reading, real scroll target
  await catalogue(h)
  await browseTo(h, 'preset:standard')
  const gOpened = await openDetails(h)
  const detailsBodyA = lastFrame(h)?.readingBodyKey
  const scrollsBefore = scrolls(h).length
  await h.key('Down', 600)
  const scrollA = scrolls(h).at(-1)
  h.check('a reading key scrolls the body node the CURRENT frame really built',
    gOpened && scrolls(h).length > scrollsBefore && scrollA !== undefined && detailsBodyA !== undefined
    && String(scrollA.id).endsWith(String(detailsBodyA)) && /preset-reading-body-\d+-\d+$/.test(String(detailsBodyA)),
    `opened=${gOpened} body=${JSON.stringify(detailsBodyA)} op=${JSON.stringify(scrollA)}`)
  await catalogue(h)
  await openDetails(h)
  const detailsBodyB = lastFrame(h)?.readingBodyKey
  const scrollsMid = scrolls(h).length
  await h.key('Down', 600)
  const scrollB = scrolls(h).at(-1)
  h.check('a NEW reading takes a NEW body identity, and its own keys address THAT body',
    detailsBodyB !== undefined && detailsBodyB !== detailsBodyA
    && scrolls(h).length > scrollsMid && scrollB !== undefined && String(scrollB.id).endsWith(String(detailsBodyB)),
    `a=${JSON.stringify(detailsBodyA)} b=${JSON.stringify(detailsBodyB)} op=${JSON.stringify(scrollB)}`)
  const beforeResize = lastFrame(h)
  await h.resize(1000, 640)
  await h.sleep(300)
  const afterResize = lastFrame(h)
  h.check('a real resize re-lays the SAME reading: its body identity, its page and its target survive',
    beforeResize?.page === 'details' && afterResize?.page === 'details'
    && afterResize?.readingBodyKey === detailsBodyB && afterResize?.head === beforeResize?.head,
    `before=${JSON.stringify(beforeResize?.head)} after=${JSON.stringify(afterResize?.head)} body=${JSON.stringify(afterResize?.readingBodyKey)}`)
  await h.resize(1280, 800)
  await catalogue(h)

  // ------------------------------------------------- H. the reading/phase edges
  await h.key('e', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  const appliesBeforeRetry = applies(h).length
  h.check('a FULLY failed read paints its message and keeps Retry + Close (Retry rightmost primary)',
    actionIds(frame) === 'close,retry' && actionOf(frame, 'retry')?.primary === true
    && h.texts(snap).some((line) => line.startsWith('agent presets are unavailable')),
    `${actionIds(frame)} :: ${JSON.stringify(h.texts(snap).slice(0, 6))}`)
  await h.key('Tab', 600)
  const retriesBefore = retries(h).length
  await h.key('Return', 800)
  h.check('the focused Retry re-reads through the ONE read owner and never touches the writer',
    retries(h).length === retriesBefore + 1 && applies(h).length === appliesBeforeRetry,
    `retries=${retries(h).length}/${retriesBefore} applies=${applies(h).length}/${appliesBeforeRetry}`)
  await h.key('r', 900)
  await h.waitFor('Agent presets')
  await h.key('l', 900)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('a running re-read admits the search box, states the read and offers only the dismissal',
    actionIds(frame) === 'close' && actionOf(frame, 'use') === undefined
    && String(frame?.subtitle) === 'Loading agent presets…',
    `${actionIds(frame)} :: subtitle=${JSON.stringify(frame?.subtitle)} items=${(frame?.items ?? []).length}`)
  h.measure('the stale cards a re-read leaves on screen (its own roster is not yet replaced)',
    JSON.stringify({ items: (frame?.items ?? []).length, painted: cardRows(snap).length }))

  // A search that matches nothing leaves no group head and no write the user could run.
  await h.key('r', 900)
  await h.waitFor('Agent presets')
  await h.key('z', 300)
  await h.key('z', 700)
  snap = h.snapshot()
  frame = lastFrame(h)
  h.check('a search with no matches leaves an empty list, no group head and both writes disabled',
    (frame?.items ?? []).length === 0 && JSON.stringify(frame?.order) === '[]' && cardRows(snap).length === 0
    && actionOf(frame, 'use')?.disabled === 'No preset selected' && actionOf(frame, 'set-default')?.disabled === 'No preset selected',
    `items=${(frame?.items ?? []).length} order=${JSON.stringify(frame?.order)} useDisabled=${JSON.stringify(actionOf(frame, 'use')?.disabled)}`)
  h.measure('the empty-list copy the client paints for a no-match search (the wire carries `empty`)',
    JSON.stringify({ wireEmpty: 'No agent presets configured.', painted: textStarting(snap, 'No agent presets configured.') === undefined ? null : String(textStarting(snap, 'No agent presets configured.').text) }))
  await h.key('Escape', 700)
  h.check('the first Esc clears the no-match filter and leaves the panel open',
    lastFrame(h)?.query === '' && lastFrame(h)?.page === 'catalog',
    `query=${JSON.stringify(lastFrame(h)?.query)}`)
  await h.key('Escape', 700)
  h.check('and the next Esc closes it (no sheet is painted any more)',
    pickerNode(h.snapshot()) === undefined && sheetNode(h.snapshot()) === undefined,
    `pickers=${nodesWith(h.snapshot(), 'sf-picker').length}`)

  // ---------------------------------------- the sessionless/live subject contrast
  await h.key('1', 900)
  await h.key('r', 900)
  await h.waitFor('Agent presets')
  const sessionlessFrame = lastFrame(h)
  await h.key('s', 900)
  await h.waitFor('Agent presets')
  const liveFrame = lastFrame(h)
  h.check('a LIVE subject states its own Current, and never invents a Next session',
    JSON.stringify(liveFrame?.current) === JSON.stringify(['preset:minimal'])
    && badgesOf(h, cardLabeled(h, h.snapshot(), 'Minimal mode')).includes('Current')
    && !badgesOf(h, cardLabeled(h, h.snapshot(), 'Minimal mode')).includes('Next session'),
    `current=${JSON.stringify(liveFrame?.current)} badge=${JSON.stringify(badgesOf(h, cardLabeled(h, h.snapshot(), 'Minimal mode')))}`)
  h.check('a SESSIONLESS subject drops the Current and states the run-local next-session choice',
    JSON.stringify(sessionlessFrame?.current) === '[]'
    // The VISIBLE statement of the same fact is that card's own native badge.
    && JSON.stringify(itemOf(sessionlessFrame, 'preset:cordis')?.badges) === JSON.stringify([{ text: 'Next session' }]),
    `current=${JSON.stringify(sessionlessFrame?.current)} badges=${JSON.stringify(itemOf(sessionlessFrame, 'preset:cordis')?.badges)}`)

  // ------------------------------------------- I. the stale footer-token control
  const appliesFinal = applies(h).length
  const defaultsFinal = defaults(h).length
  await h.key('u', 700)
  h.check('a forged footer action with any OTHER frame token never writes',
    controls(h).includes('forged-footer') && applies(h).length === appliesFinal && defaults(h).length === defaultsFinal,
    `applies=${applies(h).length}/${appliesFinal} defaults=${defaults(h).length}/${defaultsFinal} controls=${JSON.stringify(controls(h))}`)
  // BOTH primary paths ran once each (pointer click + keyboard Enter), both on the
  // same healthy preset; the default write ran once.
  h.check('across the whole run the two Use paths wrote once each and the default wrote once',
    JSON.stringify(applies(h)) === JSON.stringify(['standard', 'standard'])
    && JSON.stringify(defaults(h)) === JSON.stringify(['standard']) && retries(h).length === 1,
    `applies=${JSON.stringify(applies(h))} defaults=${JSON.stringify(defaults(h))} retries=${retries(h).length}`)
  h.measure('the run totals', JSON.stringify({
    frames: frames(h).length, applies: applies(h), defaults: defaults(h), retries: retries(h).length,
    rowEvents: rowEvents(h).length, scrolls: scrolls(h).length,
  }))
}

/* ------------------------------------------------------------ flow helpers */

/** One REAL pointer click on the painted `Use next` footer button. */
async function sendUse(h) {
  const snap = h.snapshot()
  const btn = paintedFooter(h, snap).find((entry) => entry.text === 'Use next')?.node
  if (btn === undefined) return false
  return h.click(snap.chains, btn)
}

/** One REAL pointer click on the painted `Set default` footer button. */
async function sendSetDefault(h) {
  const snap = h.snapshot()
  const btn = paintedFooter(h, snap).find((entry) => entry.text === 'Set default')?.node
  if (btn === undefined) return false
  return h.click(snap.chains, btn)
}
