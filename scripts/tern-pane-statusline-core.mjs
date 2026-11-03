/**
 * TSP-7 PR-A real-client evidence flow.
 *
 * It mounts the PRODUCTION statusline projection (`scripts/tern-pane-statusline-subject.mts`
 * imports the shipped `nativeStatuslineRows`) in a real Tern pane and records what
 * the CLIENT laid out — node boxes, clipping ancestors, the viewport and a PNG —
 * for the sizes the plan's A-21…A-23 ask about.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-statusline-core.mjs
 *
 * Cases:
 *   full       wide 400×600 + a narrow split 260×600 (right alignment, priority drop)
 *   notokens   a Remote-style snapshot without a token projection
 *   nocwd      `cwdUnavailable` — the stated word, no invented path
 *   empty      no fact at all — NEITHER row may be mounted
 *   160/120    the KNOWN-LIMITED heights (A-23): recorded, never claimed as PASS
 *
 * The flow records facts; it does not decide visual acceptance.
 * @module scripts/tern-pane-statusline-core
 */
import { join } from 'node:path'
// The repository's OWN geometry oracle: `containedXY` walks the CLIPPING ANCESTOR
// chain, so a row whose bottom falls past its region edge is reported unreadable
// even though the tree still carries it (a bare viewport compare cannot see that).
import { containedXY, fullyVisible, visibleBox } from './tern-pane-geometry.mjs'

/**
 * The REAL client paints each `ui.status` as one `sf sf-status` group, whose
 * `sf-st-l` / `sf-st-r` children are the left and right sides. The SDK node keys
 * are not exposed as DOM ids, so the tree is addressed the way the client
 * actually represents it.
 */
function statusGroups(snap) {
  return snap.nodes.filter((node) => node.class === 'sf sf-status')
}

/** Every visible text inside one node of the REAL tree. */
function innerText(h, node) {
  return node === undefined ? '' : h.descendantsText(node)
}

/**
 * The `sf-st-l` / `sf-st-r` node of one status group. The client nests it under
 * ONE `sf-st-row`, so the group's own children are the row, not the sides.
 */
function sideNode(group, side) {
  const row = (group?.children ?? []).find((child) => String(child.class ?? '').includes('sf-st-row'))
  return (row?.children ?? []).find((child) => child.class === `sf-st-${side}`)
}

/** The text of one side of one status group. */
function sideText(h, group, side) {
  return innerText(h, sideNode(group, side))
}

/** The visible segment TEXTS of a side (the icon glyphs excluded). */
function segmentTexts(h, group, side) {
  const node = sideNode(group, side)
  if (node === undefined) return []
  return (node.children ?? [])
    .filter((child) => String(child.class ?? '').includes('sf-seg'))
    .map((seg) => (seg.children ?? [])
      .filter((part) => String(part.class ?? '').includes('sf-seg-t'))
      .map((part) => part.text ?? '')
      .join(''))
    .filter((text) => text !== '')
}

/**
 * Whether a node is fully readable, i.e. its whole rect survives every CLIPPING
 * ANCESTOR (the client's overflow edges), via the repository's geometry oracle.
 * The tree reports what the presenter asked for; this reports what the client
 * actually shows.
 */
function fullyInside(h, snap, node) {
  if (node === undefined) return false
  return containedXY(snap.chains, node)
}

/** The two painted status groups, in DOM order (row 1 then row 2). */
function twoRows(h, snap) {
  const groups = statusGroups(snap)
  return {
    groups,
    rowOne: groups[0],
    rowTwo: groups[1],
    rowOneText: groups[0] === undefined ? '' : `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`,
    rowTwoText: groups[1] === undefined ? '' : `${sideText(h, groups[1], 'l')} ${sideText(h, groups[1], 'r')}`,
  }
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-statusline-subject.mts')

  // ── The wide case: both rows, right-aligned items, readable text ──────────
  await h.resize(400, 600)
  process.env.TERN_TSP7_CASE = 'full'
  // The production dock has no synthetic banner, so readiness IS the product's
  // own first status row appearing in the client tree.
  const booted = await h.launch(subject, { ready: 'statusline full' })
  h.check('the core subject boots inside a real Tern pane', booted)

  let snap = h.snapshot()
  // The transcript region must exist and live in `main`; the status rows must be
  // inside the DOCK region, never inside main (that separation is the product
  // contract: statistics never migrate the transcript into the footer).
  const regionPaths = snap.nodes.map((node) => String(node.class ?? ''))
  h.check('the transcript region and the dock region are both mounted',
    regionPaths.some((cls) => cls.includes('sf-main')) && regionPaths.some((cls) => cls.includes('sf-dock')),
    regionPaths.filter((cls) => cls.includes('sf-')).slice(0, 8).join(' | '))

  let rows = twoRows(h, snap)
  h.check('the real client paints exactly two native status groups', rows.groups.length === 2,
    `groups=${rows.groups.length}`)
  h.check('row 1 carries the permission and cwd segments',
    rows.rowOneText.includes('ww') && rows.rowOneText.includes('status-line'), rows.rowOneText)
  // PR-B layout reality: row 1 now carries run-state(105)+attention(110) too,
  // so at 400px the LOWEST-priority git seg(30) already yields — the SAME
  // native priority rule this lane exists to witness. Record which left segs
  // survived instead of asserting the PR-A-era layout.
  h.measure('row1-left-at-400px', JSON.stringify(segmentTexts(h, rows.rowOne, 'l')))

  h.check('row 1 puts the plan segment on the RIGHT side',
    segmentTexts(h, rows.rowOne, 'r').includes('plan'), JSON.stringify(segmentTexts(h, rows.rowOne, 'r')))
  h.check('row 2 carries the token pair and the context percent',
    rows.rowTwoText.includes('114M') && rows.rowTwoText.includes('ctx 25%'), rows.rowTwoText)
  h.check('row 2 puts the context segment on the RIGHT side',
    segmentTexts(h, rows.rowTwo, 'r').some((text) => text.startsWith('ctx')),
    JSON.stringify(segmentTexts(h, rows.rowTwo, 'r')))
  // The composer must be laid out ABOVE the first status row — a text-presence
  // check cannot prove that, so the client's own boxes are compared.
  const dockEditor = snap.nodes.find((node) => String(node.class ?? '').includes('sf-editor'))
  const rowOneBox = rows.rowOne?.rect
  h.check('the controlled composer is laid out ABOVE the first status row',
    dockEditor !== undefined && Array.isArray(dockEditor.rect) && Array.isArray(rowOneBox)
      && dockEditor.rect[1] + dockEditor.rect[3] <= rowOneBox[1],
    `editor=${JSON.stringify(dockEditor?.rect)} row1=${JSON.stringify(rowOneBox)}`)

  // Both rows must be fully readable THROUGH their clipping ancestors, not merely
  // present in the tree.
  h.check('both rows are fully readable at 400x600 (every clipping ancestor)',
    fullyInside(h, snap, rows.rowOne) && fullyInside(h, snap, rows.rowTwo),
    `row1=${JSON.stringify(rows.rowOne === undefined ? null : visibleBox(snap.chains, rows.rowOne))} `
    + `row2=${JSON.stringify(rows.rowTwo === undefined ? null : visibleBox(snap.chains, rows.rowTwo))}`)

  // Snapshot the WIDE left-side segments: the narrow run's drop is asserted
  // against exactly this state.
  const wideLeft = segmentTexts(h, rows.rowOne, 'l')

  // The RIGHT side must be visually to the right of the left side, measured.
  const leftBox = sideNode(rows.rowOne, 'l')?.rect
  const rightBox = sideNode(rows.rowOne, 'r')?.rect
  h.check('the right side is laid out to the right of the left side',
    Array.isArray(leftBox) && Array.isArray(rightBox) && rightBox[0] > leftBox[0] + leftBox[2],
    `left=${JSON.stringify(leftBox)} right=${JSON.stringify(rightBox)}`)

  // The REAL layout: the two rows must be inside the viewport and not clipped.
  const layout = h.ctl('stats')
  h.measure('viewport-wide', JSON.stringify(layout.viewport ?? null))
  h.capture('core-full-400x600', 'the statusline core at 400×600 with every fact present')

  // ── The split case: a narrower pane, right side still on the right ───────
  await h.resize(260, 600)
  await h.sleep(400)
  snap = h.snapshot()
  rows = twoRows(h, snap)
  h.check('the narrow split still paints both rows', rows.groups.length === 2,
    `groups=${rows.groups.length}`)
  h.measure('row1-narrow-left', JSON.stringify(segmentTexts(h, rows.rowOne, 'l')))
  h.measure('row1-narrow-right', JSON.stringify(segmentTexts(h, rows.rowOne, 'r')))
  h.measure('row2-narrow-left', JSON.stringify(segmentTexts(h, rows.rowTwo, 'l')))
  h.measure('row2-narrow-right', JSON.stringify(segmentTexts(h, rows.rowTwo, 'r')))
  // PRIORITY DROP is the client's own decision, and the one rule this lane
  // witnesses: the LOW priority items yield before the higher ones. Under the
  // PR-B row-1 item set, the git seg (prio 30) already yields at 400px (see
  // `row1-left-at-400px`), so the narrow witness is that the permission(95) +
  // cwd(50) pair survives while both rows still fit.
  const narrowLeft = segmentTexts(h, rows.rowOne, 'l')
  h.check('at 260px the higher-priority permission and cwd segments survive',
    narrowLeft.some((text) => text.includes('ww')) && narrowLeft.some((text) => text.includes('status-line')),
    JSON.stringify(narrowLeft))
  h.measure('row1-left-wide-vs-narrow', JSON.stringify({ wideLeft, narrowLeft }))
  h.check('at 260px both rows still fit their clipping ancestors',
    fullyInside(h, snap, rows.rowOne) && fullyInside(h, snap, rows.rowTwo),
    `row1=${fullyInside(h, snap, rows.rowOne)} row2=${fullyInside(h, snap, rows.rowTwo)}`)
  h.capture('core-full-260x600', 'the same snapshot in a narrow split pane')

  // ── A-23: the known-limited heights, recorded and NOT claimed as PASS ────
  // A-23: record the REAL clipping. These measurements are EVIDENCE, never a
  // PASS claim: the plan states that height-adaptive collapse is G-H, which
  // PR-A does not implement.
  await h.resize(400, 160)
  await h.sleep(400)
  const snap160 = h.snapshot()
  rows = twoRows(h, snap160)
  h.measure('160px-rows-mounted', String(rows.groups.length))
  h.measure('160px-row1-readable', String(fullyInside(h, snap160, rows.rowOne)))
  h.measure('160px-row2-readable', String(fullyInside(h, snap160, rows.rowTwo)))
  h.capture('core-full-160px', 'known-limited height: record the real clipping')

  await h.resize(400, 120)
  await h.sleep(400)
  const snap120 = h.snapshot()
  rows = twoRows(h, snap120)
  h.measure('120px-rows-mounted', String(rows.groups.length))
  h.measure('120px-row1-readable', String(fullyInside(h, snap120, rows.rowOne)))
  h.measure('120px-row2-readable', String(fullyInside(h, snap120, rows.rowTwo)))
  h.capture('core-full-120px', 'known-limited height: record the real clipping')

  // ── Appearance: the same two rows in dark and light ─────────────────────
  await h.resize(400, 600)
  await h.sleep(300)
  h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark')
  h.capture('core-dark', 'the two native rows in the dark appearance')
  h.send('appearance', 'light')
  h.check('the client resolved the light appearance', h.ctl('state').theme === 'light')
  h.capture('core-light', 'the two native rows in the light appearance')

  // The driver's `key` takes a key NAME; F10 is what the subject watches for.
  await h.key('F10', 700)
}
