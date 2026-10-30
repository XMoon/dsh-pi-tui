/**
 * TSP-7 PR-B real-client evidence flow.
 *
 * It mounts the PRODUCTION statusline projection (`scripts/tsp7-statusline-subject.mts`
 * imports the shipped `nativeStatuslineRows`) in a real Tern pane and records what the
 * CLIENT laid out — node boxes, clipping ancestors, the viewport and a PNG — for the
 * sizes and fact sets the plan's B-19/B-20/B-23 ask about.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tsp7-prb-statusline-pane.mjs
 *
 * Cases:
 *   prb       400×600 and a 260×600 split: the run seg + the rich attention badge
 *             + the full statistics row; the ATTENTION and CONTEXT must survive the
 *             narrow width (the plan's §1.2 rule).
 *   prb-attn  attention + context only: the absent statistics paint nothing.
 *   prb-idle  no run phase, no badge: no empty `idle` word and no `[]` badge.
 *   160/120   the KNOWN-LIMITED heights (G-H): recorded, never claimed as PASS.
 *
 * The flow records facts; it does not decide visual acceptance.
 * @module scripts/tsp7-prb-statusline-pane
 */
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { containedXY, visibleBox } from './tern-pane-geometry.mjs'

/**
 * Select the subject's fixture case. The driver's `launch.sh` does not forward
 * the driver process's environment to the subject, so the case travels through
 * the run directory's `case` file (the subject reads it first).
 */
function useCase(h, name) {
  writeFileSync(join(h.root, 'case'), `${name}\n`)
  return `tsp7 ${name}`
}

/** The REAL client paints each `ui.status` as one `sf sf-status` group. */
function statusGroups(snap) {
  return snap.nodes.filter((node) => node.class === 'sf sf-status')
}

/** The `sf-st-l` / `sf-st-r` node of one status group. */
function sideNode(group, side) {
  const row = (group?.children ?? []).find((child) => String(child.class ?? '').includes('sf-st-row'))
  // The client appends state classes (a right side that SHRINKS carries
  // `sf-st-r shrinks`), so the side is matched by PREFIX, never by equality.
  return (row?.children ?? []).find((child) => String(child.class ?? '').startsWith(`sf-st-${side}`))
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

/** Whether a node's whole rect survives every CLIPPING ANCESTOR. */
function fullyInside(h, snap, node) {
  if (node === undefined) return false
  return containedXY(snap.chains, node)
}

/** Every segment text of both rows (side-agnostic). */
function allSegments(h, snap) {
  return statusGroups(snap).flatMap(group => [...segmentTexts(h, group, 'l'), ...segmentTexts(h, group, 'r')])
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tsp7-statusline-subject.mts')
  // ONE case per run: the pane driver's `launch` starts the subject in the SAME
  // pane, so a second launch would race the first one's ready marker. The flow
  // therefore runs once per fixture (`TERN_TSP7_PRB_CASE`), exactly like the
  // PR-A flow runs once.
  const testCase = process.env.TERN_TSP7_PRB_CASE ?? 'prb'
  const ready = useCase(h, testCase)

  // ── The rich case at a normal width ─────────────────────────────────────
  await h.resize(400, 600)
  const booted = await h.launch(subject, { ready })
  h.check(`the PR-B ${testCase} subject boots inside a real Tern pane`, booted)

  let snap = h.snapshot()
  let groups = statusGroups(snap)
  h.check('the real client paints exactly two native status groups', groups.length === 2,
    `groups=${groups.length}`)

  const wide = allSegments(h, snap)
  h.measure('prb-wide-segments', JSON.stringify(wide))
  if (testCase === 'prb') {
    // Row 1: the run phase and the attention badge are the PR-B additions.
    h.check('row 1 paints the run phase (PR-B)', wide.some(text => text.includes('work')),
      JSON.stringify(wide))
    h.check('row 1 paints the attention badge with the failure, jobs, agents and Question',
      wide.some(text => text.includes('!1') && text.includes('2/4j') && text.includes('1/3a') && text.includes('?1')),
      JSON.stringify(wide))
    // The statistics are the client's OWN priority call: at 400px it may drop the
    // lowest-priority ones (TTFB=25, cache=35). Record what survived instead of
    // asserting a pixel threshold the plan never froze (§1.2).
    h.check('row 2 paints a rate statistic',
      wide.some(text => text.includes('R5') || text.includes('All')), JSON.stringify(wide))
    h.measure('row2-statistics-surviving-at-400px', JSON.stringify(wide.filter(text =>
      text.includes('TTFB') || text.includes('CH') || text.includes('R5') || text.includes('All'))))
  }
  if (testCase === 'prb-attn') {
    // The absent statistics: nothing is fabricated.
    h.check('no token/cache/latency/rate seg is fabricated when its fact is absent',
      !wide.some(text => text.includes('TTFB') || text.includes('R5') || text.includes('CH')),
      JSON.stringify(wide))
    h.check('the attention badge still paints', wide.some(text => text.includes('!1')), JSON.stringify(wide))
    // MEASURED CLIENT LIMIT: when a row has NO left-side segment and exactly one
    // right-side segment (this fixture's row 2), the shipped client paints no
    // `sf-status` group for that row. The projection is correct (asserted by the
    // unit tests); the LANE records the client's layout behaviour instead of
    // claiming a PASS the client does not show.
    h.measure('row2-right-only-groups', String(groups.length))
  }
  if (testCase === 'prb-idle') {
    // RFL-004: the fixture carries ZERO work/question counts, so the badge item
    // must OMIT ITSELF — asserted directly on the row-1 right side (a mere
    // "no `[]`" check cannot discriminate a badge that never rendered).
    h.check('an idle subject paints no idle word', !wide.some(text => text === 'idle'), JSON.stringify(wide))
    h.check('an idle subject paints NO attention badge (zero counts omit the item)',
      segmentTexts(h, groups[0], 'r').every(text => !text.includes('!') && !text.includes('?')),
      JSON.stringify(segmentTexts(h, groups[0], 'r')))
    h.check('the idle subject still paints its environment facts',
      wide.some(text => text.includes('ww')), JSON.stringify(wide))
    h.measure('idle-groups', String(groups.length))
  }
  // The context percent is asserted only where the row carries a LEFT segment
  // too (the client's own group condition — see `row2-right-only-groups`).
  if (groups.length === 2) {
    h.check('the context percent survives on the right',
      segmentTexts(h, groups[1], 'r').some(text => text.includes('25%')),
      JSON.stringify(segmentTexts(h, groups[1], 'r')))
  }

  h.check('both rows are fully readable at 400x600 (every clipping ancestor)',
    fullyInside(h, snap, groups[0]) && fullyInside(h, snap, groups[1]),
    `row1=${groups[0] === undefined ? 'null' : JSON.stringify(visibleBox(snap.chains, groups[0]))} `
    + `row2=${groups[1] === undefined ? 'null' : JSON.stringify(visibleBox(snap.chains, groups[1]))}`)
  // The composer must stay above the first status row (measured boxes).
  const dockEditor = snap.nodes.find((node) => String(node.class ?? '').includes('sf-editor'))
  const rowOneBox = groups[0]?.rect
  h.check('the controlled composer is laid out ABOVE the first status row',
    dockEditor !== undefined && Array.isArray(dockEditor.rect) && Array.isArray(rowOneBox)
      && dockEditor.rect[1] + dockEditor.rect[3] <= rowOneBox[1],
    `editor=${JSON.stringify(dockEditor?.rect)} row1=${JSON.stringify(rowOneBox)}`)
  h.capture(`prb-${testCase}-400x600`, `PR-B ${testCase}: the two-row statusline at 400x600`)

  const wideRowOne = [...segmentTexts(h, groups[0], 'l'), ...segmentTexts(h, groups[0], 'r')]

  // ── The narrow split: attention and context must survive ────────────────
  await h.resize(260, 600)
  await h.sleep(400)
  snap = h.snapshot()
  groups = statusGroups(snap)
  const narrow = allSegments(h, snap)
  h.measure('prb-narrow-segments', JSON.stringify(narrow))
  // A row may be entirely ABSENT when none of its segments is present (the
  // shipped client omits a status group whose sides carry nothing), and a
  // right-only row is subject to the client's own group condition — so the
  // row count is RECORDED, and the checks below apply to the rows that exist.
  h.measure('narrow-groups', String(groups.length))
  h.check('the narrow split still paints the rows it has facts for', groups.length >= 1, `groups=${groups.length}`)
  // THE product rule (§1.2): the ATTENTION and the CONTEXT are the last to go.
  if (testCase !== 'prb-idle') {
    h.check('the attention badge survives the narrow width',
      narrow.some(text => text.includes('!1')), JSON.stringify(narrow))
  }
  if (testCase === 'prb') {
    h.check('the context percent survives the narrow width',
      narrow.some(text => text.includes('25%')), JSON.stringify(narrow))
  }
  h.check('the narrow rows still fit their clipping ancestors',
    fullyInside(h, snap, groups[0]) && fullyInside(h, snap, groups[1]),
    `row1=${fullyInside(h, snap, groups[0])} row2=${fullyInside(h, snap, groups[1])}`)
  const narrowRowOne = [...segmentTexts(h, groups[0], 'l'), ...segmentTexts(h, groups[0], 'r')]
  h.measure('prb-row1-wide-vs-narrow', JSON.stringify({ wideRowOne, narrowRowOne }))
  h.capture(`prb-${testCase}-260x600`, `PR-B ${testCase}: the same snapshot in a narrow split pane`)

  // ── Appearance: the same rows in dark and light ─────────────────────────
  await h.resize(400, 600)
  await h.sleep(300)
  h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark')
  h.capture(`prb-${testCase}-dark`, `PR-B ${testCase}: the two native rows in the dark appearance`)
  h.send('appearance', 'light')
  h.check('the client resolved the light appearance', h.ctl('state').theme === 'light')
  h.capture(`prb-${testCase}-light`, `PR-B ${testCase}: the two native rows in the light appearance`)

  // ── G-H: the known-limited heights, recorded and NOT claimed as PASS ────
  await h.resize(400, 160)
  await h.sleep(400)
  const snap160 = h.snapshot()
  const groups160 = statusGroups(snap160)
  h.measure('160px-rows-mounted', String(groups160.length))
  h.measure('160px-row1-readable', String(fullyInside(h, snap160, groups160[0])))
  h.measure('160px-row2-readable', String(fullyInside(h, snap160, groups160[1])))
  h.capture(`prb-${testCase}-160px`, 'G-H known-limited height: record the real clipping')

  await h.resize(400, 120)
  await h.sleep(400)
  const snap120 = h.snapshot()
  const groups120 = statusGroups(snap120)
  h.measure('120px-rows-mounted', String(groups120.length))
  h.measure('120px-row1-readable', String(fullyInside(h, snap120, groups120[0])))
  h.measure('120px-row2-readable', String(fullyInside(h, snap120, groups120[1])))
  h.capture(`prb-${testCase}-120px`, 'G-H known-limited height: record the real clipping')

  await h.resize(400, 600)
  await h.sleep(300)
  await h.key('F10', 700)
}
