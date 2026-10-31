/**
 * TSP-7 PR-D real-client evidence flow: the configured native footer.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-footer-config.mjs
 *   TERN_TSP7_PRD_CASE=<case> node scripts/tern-pane-drive.mjs scripts/tern-pane-footer-config.mjs
 *
 * One CASE per run (`TERN_TSP7_PRD_CASE`, default `default`), the same
 * dual-lane shape as the PR-C composer flow (headless + GUI). The subject is
 * the production renderer driven through the shipped `bindNativeFooterConfig`;
 * the assertions read the client's REAL node tree and the merged dock notices.
 *
 * Cases: default | compact | custom-builtin | custom-text |
 *        custom-unavailable | command-fallback | narrow | short
 *
 * `narrow` runs the compact case at 260px (the priority-drop witness);
 * `short` records the known-limited short heights (never claimed PASS).
 * @module scripts/tern-pane-footer-config
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, visibleBox } from './tern-pane-geometry.mjs'

/** The painted status groups (`sf sf-status`), in DOM order. */
function statusGroups(snap) {
  return snap.nodes.filter((node) => node.class === 'sf sf-status')
}

function sideNode(group, side) {
  const row = (group?.children ?? []).find((child) => String(child.class ?? '').includes('sf-st-row'))
  return (row?.children ?? []).find((child) => child.class === `sf-st-${side}`)
}

function sideText(h, group, side) {
  const node = sideNode(group, side)
  return node === undefined ? '' : h.descendantsText(node)
}

/** The dock's plain text rows (the notice witness). */
function dockTexts(h, snap) {
  return snap.nodes
    .filter((node) => String(node.class ?? '').includes('sf-text'))
    .map((node) => h.descendantsText(node))
}

/** The composer buttons still present (the PR-C regression witness). */
function composerButtons(snap) {
  const labels = snap.nodes
    .filter((node) => node.tag === 'button' && String(node.class ?? '').split(' ').includes('sf-el'))
    .map((node) => String(node.text ?? ''))
  return labels
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-footer-config-subject.mts')
  const requested = process.env.TERN_TSP7_PRD_CASE ?? 'default'
  const gui = typeof h.splitPane === 'function'
  // `narrow`/`short` reuse a configured subject shape; the CASE the subject
  // reads is the mapped one, the flow's own scenario drives the sizes.
  const subjectCase = requested === 'narrow' ? 'compact' : requested === 'short' ? 'custom-builtin' : requested

  if (gui) await h.splitPane('right')
  await h.resize(1280, 800)
  // The driver's launch.sh does not forward the driver env, so the case rides
  // the run directory's `case` file (the same one-case-per-run contract the
  // PR-B/PR-C flows use).
  writeFileSync(join(h.root, 'case'), `${subjectCase}\n`)
  const booted = await h.launch(subject, { ready: `footer-config ${subjectCase}` })
  h.check(`the PR-D ${subjectCase} subject boots inside a real Tern pane`, booted)
  if (!booted) return

  const paneWidth = () => {
    const snapNow = h.snapshot()
    const pane = snapNow.nodes.find(node =>
      String(node.class ?? '').split(' ').includes('tn-pane') &&
      String(node.class ?? '').split(' ').includes('on'))
    return Array.isArray(pane?.rect) ? pane.rect[2] : undefined
  }
  if (gui) h.measure('gui-wide-pane-width', String(paneWidth()))

  let snap = h.snapshot()
  let groups = statusGroups(snap)

  // Every case keeps the PR-C composer controls untouched.
  const buttons = composerButtons(snap)
  h.check('the PR-C composer controls remain mounted', buttons.includes('Send'),
    JSON.stringify(buttons))

  if (subjectCase === 'default') {
    h.check('default paints the frozen two-row PR-A/B shape', groups.length === 2, `groups=${groups.length}`)
    const rowOne = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.check('row 1 carries the environment facts', rowOne.includes('ww') && rowOne.includes('footer-config'), rowOne)
    h.check('row 2 carries the statistics', sideText(h, groups[1], 'l').includes('114M'), sideText(h, groups[1], 'l'))
    h.check('no Model segment was added to the default rows',
      !groups.some((group) => `${sideText(h, group, 'l')}${sideText(h, group, 'r')}`.includes('luna')),
      groups.map((group) => sideText(h, group, 'l') + '|' + sideText(h, group, 'r')).join(' ; '))
  }

  if (subjectCase === 'compact') {
    h.check('compact paints EXACTLY one native row', groups.length === 1, `groups=${groups.length}`)
    const row = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.check('the compact row carries run, attention and context',
      row.includes('work') && row.includes('72%'), row)
    h.check('no statistics row is fabricated', !row.includes('114M'), row)
    h.check('no Model is injected into the compact row', !row.includes('luna'), row)
  }

  if (subjectCase === 'custom-builtin') {
    h.check('custom-builtin paints the two configured layout rows', groups.length === 2, `groups=${groups.length}`)
    const rowOne = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.check('the user-placed Model renders', rowOne.includes('luna'), rowOne)
    h.check('the branch label format renders (the builtin emits its own prefix)',
      rowOne.includes('branch: prd-evidence'), rowOne)
    h.check('the context percent sits on the right', sideText(h, groups[0], 'r').includes('72%'), sideText(h, groups[0], 'r'))
    const rowTwo = sideText(h, groups[1], 'l')
    h.check('row 2 renders BOTH performance placements (duplicate id, no dedup)',
      rowTwo.includes('TTFB') && rowTwo.includes('All'), rowTwo)
  }

  if (subjectCase === 'custom-text') {
    h.check('custom-text paints one row', groups.length === 1, `groups=${groups.length}`)
    const row = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.check('the USER text item renders verbatim', row.includes('prod-cluster'), row)
    h.check('the builtin cwd renders beside it', row.includes('footer-config'), row)
  }

  if (subjectCase === 'custom-unavailable') {
    h.check('custom-unavailable paints its row', groups.length === 1, `groups=${groups.length}`)
    const row = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.check('the USER command item keeps its placement with the name marker',
      row.includes('Unavailable: clock'), row)
    h.check('the extension items mark unavailable', (row.match(/Unavailable: extension/g) ?? []).length === 2, row)
    // The unknown-id marker: priority 70 keeps it droppable by the client's
    // own narrow-pane rule (the plan's explicit choice), so it is ASSERTED on
    // the wide headless lane and MEASURED on the split GUI lane.
    if (gui) {
      h.measure('gui-unknown-id-marker', row.includes('Unavailable: item') ? 'visible' : 'dropped-by-client')
    } else {
      h.check('the unknown id marks unavailable', row.includes('Unavailable: item'), row)
    }
    h.check('the command string itself never painted', !row.includes('date') || row.includes('update') === false ? !/\bdate\b/.test(row) : false, row)
    h.check('the supported sibling still renders', sideText(h, groups[0], 'r').includes('72%'), sideText(h, groups[0], 'r'))
    const notices = dockTexts(h, snap)
    h.check('the merged unavailability notice appears exactly once',
      notices.filter((text) => text.includes('unavailable in TSP')).length === 1, JSON.stringify(notices))
    // The WARNING tone is a computed-style fact: the client paints the
    // unavailable segs' content in its warning amber (the same hue the
    // terminal's own warn icon uses), so the markers are visually
    // distinguishable — not merely present in the wire. The dump carries
    // every element's computed color; the witness is a warning-hued element
    // INSIDE a `.sf-seg` of the dock's status region.
    const dump = h.ctl('dump')
    // The client's warning hue family (measured: amber rgb(154,115,38) on the
    // light theme, a red rgb(170,85,85) for errors). The witness is ANY
    // warning-hued element inside one of the dock's `.sf-seg` nodes.
    const segColors = [...new Set((dump?.elements ?? [])
      .filter((el) => String(el?.path ?? '').includes('.sf-seg'))
      .map((el) => String(el?.color ?? '')))]
    const warnInSeg = segColors.filter((color) =>
      color !== '' && color !== 'rgb(59, 59, 59)' && color !== 'rgb(108, 108, 108)' && color !== 'rgb(101, 101, 101)' && color !== 'rgb(0, 0, 0)')
    h.measure('warning-colored-seg-elements', String(warnInSeg.length))
    h.check('the unavailable markers carry the client warning hue (visually distinguishable)',
      warnInSeg.length >= 1, `segColors=${JSON.stringify(segColors)}`)
  }

  if (subjectCase === 'command-fallback') {
    h.check('command-fallback paints the compact fallback row', groups.length === 1, `groups=${groups.length}`)
    const row = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.check('the fallback row shows the real native facts', row.includes('ww') && row.includes('72%'), row)
    h.check('no command output was fabricated', !row.includes('date'), row)
    const notices = dockTexts(h, snap)
    h.check('the command notice appears exactly once',
      notices.filter((text) => text.includes('cannot run command footer')).length === 1,
      JSON.stringify(notices))
  }

  // The rows must be readable through their clipping ancestors at 1280x800.
  h.check('every status row is fully inside its clipping ancestors at 1280x800',
    groups.every((group) => containedXY(snap.chains, group)),
    groups.map((group) => JSON.stringify(visibleBox(snap.chains, group))).join(' '))
  h.capture(`prd-${subjectCase}-1280x800`, `PR-D ${subjectCase}: the configured native footer at 1280x800`)

  // ── The medium pane (~400px / the GUI split width) ────────────────────────
  if (gui) {
    await h.resize(800, 600)
    h.measure('gui-medium-pane-width', String(paneWidth()))
  } else {
    await h.resize(400, 600)
  }
  await h.sleep(300)
  snap = h.snapshot()
  groups = statusGroups(snap)
  h.check('the medium pane keeps the rows mounted', groups.length >= 1, `groups=${groups.length}`)
  h.check('the composer controls remain reachable in the medium pane',
    composerButtons(snap).includes('Send'), JSON.stringify(composerButtons(snap)))
  h.capture(`prd-${subjectCase}-medium`, `PR-D ${subjectCase}: the medium pane`)

  // ── narrow: the 260px priority-drop witness (compact case) ────────────────
  if (requested === 'narrow') {
    if (gui) {
      await h.resize(720, 600)
      h.measure('gui-narrowest-pane-width', String(paneWidth()))
    } else {
      await h.resize(260, 600)
    }
    await h.sleep(400)
    snap = h.snapshot()
    groups = statusGroups(snap)
    h.check('the narrow pane still mounts the compact row', groups.length === 1, `groups=${groups.length}`)
    const row = `${sideText(h, groups[0], 'l')} ${sideText(h, groups[0], 'r')}`
    h.measure('narrow-compact-row', row)
    h.check('the right-side context/attention facts outrank the environment facts (survive the drop)',
      row.includes('72%'), row)
    h.capture('prd-narrow-260', 'PR-D narrow: the compact row at 260px')
  }

  // ── short: the known-limited heights, recorded NOT claimed PASS ───────────
  if (requested === 'short') {
    for (const height of [160, 120]) {
      if (!gui) await h.resize(400, height)
      await h.sleep(400)
      const shortSnap = h.snapshot()
      const shortGroups = statusGroups(shortSnap)
      h.measure(`${height}px-rows-mounted`, String(shortGroups.length))
      h.capture(`prd-short-${height}px`, `PR-D short (known limit): ${height}px`)
    }
  }

  // ── Dark and light ────────────────────────────────────────────────────────
  await h.sleep(200)
  if (gui) {
    h.send('plugins', 'run', 'appearance:dark')
  } else {
    h.send('appearance', 'dark')
  }
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark')
  h.capture(`prd-${subjectCase}-dark`, `PR-D ${subjectCase}: the dark appearance`)
  if (gui) {
    h.send('plugins', 'run', 'appearance:light')
  } else {
    h.send('appearance', 'light')
  }
  h.check('the client resolved the light appearance', h.ctl('state').theme === 'light')
  h.capture(`prd-${subjectCase}-light`, `PR-D ${subjectCase}: the light appearance`)

  await h.key('F10', 700)
}
