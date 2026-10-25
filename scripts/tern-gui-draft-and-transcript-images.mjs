/**
 * The real-GUI lane for the PR4 image surfaces: the PRODUCTION projections
 * (User/Assistant/Tool bodies + the dock's draft rows) in a REAL Tern GUI
 * window on a REAL display.
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-draft-and-transcript-images.mjs
 *
 * What this lane is FOR (and what it must never claim):
 *
 * - the client's OWN image viewer opened by a REAL pointer, closed by Escape,
 *   and the SIBLING navigation between two images of the SAME User body — a
 *   gesture the SDK does not describe, so it needs a physical window;
 * - the controlled `dock.composer` staying visible, unclipped and typable while
 *   previews sit above it;
 * - light/dark theme painting, and the real accessibility tree.
 *
 * NOT claimed here: any pane-HEIGHT rule (the SDK publishes no pane rows, so a
 * short-window result is a measurement of THIS window, never an automatic
 * degradation), OS-level IME behaviour, or a second client build.
 *
 * Every visibility claim goes through the oracle (ancestor clipping) and the
 * captures; a node that is present but clipped is a FAIL, not a pass.
 * @module scripts/tern-gui-draft-and-transcript-images
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, fullyVisible, rect, visibleBox } from './tern-pane-geometry.mjs'

/** The client's image-viewer dialog, read from the accessibility tree. */
function viewerOf(a11y) {
  let found
  const walk = node => {
    if (!node || found !== undefined) return
    if (node.role === 'Dialog') {
      found = node
      return
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(a11y)
  return found
}

/** Every element of one node's accessibility subtree, flattened. */
function elementsOf(node, out = []) {
  if (!node) return out
  out.push({ role: node.role, name: node.name, bounds: node.bounds })
  for (const child of node.children ?? []) elementsOf(child, out)
  return out
}

export default async function (h) {
  // Two modes over ONE flow file: the full window journey, and the amendment's
  // split-pane gate (`TERN_GUI_SPLIT=1`). The split must happen BEFORE the
  // subject launches in a pane, so it cannot share the window journey's launch.
  if (process.env.TERN_GUI_SPLIT === '1') {
    if (process.env.TERN_GUI_BUSY === '1') await splitPaneBusyGate(h)
    else await splitPaneGate(h)
    return
  }
  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  const size = await h.resize(1280, 800)
  h.check('the window took the requested content size', size.clamped === false,
    `requested=${JSON.stringify(size.requested)} actual=${JSON.stringify(size.viewport)}`)
  h.measure('the window size', JSON.stringify(size))

  const subject = join(h.repo, 'scripts', 'tern-gui-draft-and-transcript-images-subject.mts')
  const booted = await h.launch(subject, { ready: '[IMAGE] first-shot.png' })
  h.check('the production projection is painted inside a real Tern GUI pane', booted)
  if (!booted) {
    h.measure('the subject stderr', 'the subject did not paint')
    return
  }

  const snap = h.snapshot()
  // ── The transcript bodies and the dock rows ──
  h.check('the User body identity lines are painted',
    h.has(snap, '[IMAGE] first-shot.png') && h.has(snap, '[IMAGE] second-shot.png'),
    h.texts(snap).join(' | '))
  h.check('the Tool result identity line is painted', h.has(snap, '[IMAGE] shot.png'),
    h.texts(snap).join(' | '))
  h.check('the dock states the live draft count on the existing status line',
    h.has(snap, 'Draft 3 · '), h.texts(snap).join(' | '))
  h.check('each SHOWN chip carries its compact identity caption',
    h.has(snap, '#1 · 320×180') && h.has(snap, '#2 · 320×180'),
    h.texts(snap).join(' | '))
  h.check('a third occurrence beyond the cap is NOT drawn as a chip',
    !h.has(snap, '#3 · 320×180'), h.texts(snap).join(' | '))

  // ── The controlled editor: present, unclipped, typable ──
  // The client's tree carries no wire id: the controlled editor is found by the
  // stable prefix of its controlled text. A key assertion compares the WHOLE
  // text — a node that merely still exists proves nothing about typability.
  const composerOf = snapshot => snapshot.nodes.find(node => String(node.text ?? '').includes('see attached'))
  const composerTextOf = snapshot => {
    const node = composerOf(snapshot)
    return node === undefined ? undefined : String(node.text ?? '')
  }
  const composer = composerOf(snap)
  h.check('the controlled dock composer is painted with previews above it', composer !== undefined,
    JSON.stringify({ found: composer !== undefined }))
  if (composer !== undefined) {
    h.check('the dock composer is NOT clipped by any ancestor', containedXY(snap.chains, composer),
      `box=${JSON.stringify(rect(composer))}`)
    h.measure('dock composer box (1280x800)', JSON.stringify(rect(composer)))
  }

  // A REAL key into the editor: with the previews up, the seat must still take
  // input. The subject loops on the SDK session, so a delivered key proves the
  // seat is live rather than a painted still.
  const textBeforeKey = composerTextOf(h.snapshot())
  await h.key('a', 700)
  const textAfterKey = composerTextOf(h.snapshot())
  h.check('a REAL key with previews up changes the controlled editor text',
    textBeforeKey !== undefined && textAfterKey !== undefined && textAfterKey !== textBeforeKey,
    `before=${JSON.stringify(textBeforeKey)} after=${JSON.stringify(textAfterKey)}`)
  h.check('the applied key lands at the controlled cursor',
    typeof textAfterKey === 'string' && textAfterKey.startsWith('see attached a'),
    `after=${JSON.stringify(textAfterKey)}`)

  const images = snap.nodes.filter(node => node.tag === 'img')
  h.check('the client drew native image elements for the transcript AND the dock',
    images.length >= 5, JSON.stringify(images.map(node => rect(node))))
  h.measure('image boxes (1280x800)', JSON.stringify(images.map(node => rect(node))))
  // Scoped to the images the viewport actually shows: a long transcript scrolls
  // earlier images out of the window, and a scrolled-out image is correctly
  // clipped — asserting over ALL of them would demand the impossible.
  const windowHeight = (h.ctl('stats').viewport ?? [0, 0, 0, 0])[1]
  const onScreenImages = images.filter(node => {
    const box = rect(node)
    return box[1] >= 0 && box[1] + box[3] <= windowHeight
  })
  h.check('at least one painted image is on screen', onScreenImages.length > 0,
    JSON.stringify(images.map(node => rect(node))))
  h.check('every ON-SCREEN image is unclipped by its ancestors',
    onScreenImages.every(node => containedXY(snap.chains, node)),
    JSON.stringify(onScreenImages.map(node => ({ box: rect(node), ok: containedXY(snap.chains, node) }))))

  h.capture('pr4-gui-light', 'the PR4 image surfaces in a real Tern GUI window (light)')

  // ── The client's own theme ──
  const state = h.ctl('state')
  const darkTheme = Array.isArray(state?.theme_dark) && state.theme_dark.length > 0 ? state.theme_dark[0] : 'titanium'
  h.ctl('theme', 'dark', darkTheme)
  h.measure('the dark theme', String(darkTheme))
  const dark = h.snapshot()
  h.check('the User body image is still drawn in the client\'s own dark theme',
    dark.nodes.some(node => node.tag === 'img'), h.texts(dark).join(' | '))
  h.check('the dock count is still readable in the dark theme',
    h.has(dark, 'Draft 3 · '), h.texts(dark).join(' | '))
  h.check('the controlled composer is still painted in the dark theme',
    composerOf(dark) !== undefined, h.texts(dark).join(' | '))
  h.capture('pr4-gui-dark', 'the same surfaces in the client\'s own dark theme')

  // ── The accessibility tree ──
  const a11y = h.ctl('a11y')
  const inlineImages = elementsOf(a11y).filter(element => element.role === 'Image')
  h.check('the client exposes the transcript/dock images to the accessibility tree',
    inlineImages.length >= 5, JSON.stringify(inlineImages))
  h.check('every accessible image node carries a real box', inlineImages.every(element => {
    const bounds = element.bounds ?? []
    return Array.isArray(bounds) && bounds.length === 4 && bounds[2] > 0 && bounds[3] > 0
  }), JSON.stringify(inlineImages))
  h.measure('the accessibility image nodes', JSON.stringify(inlineImages))

  // ── The client's OWN image viewer, opened by a REAL pointer ──
  const warm = h.snapshot()
  const viewport = h.ctl('stats').viewport ?? [0, 0, 0, 0]
  const [, vh] = viewport
  // A click can only land on an image the client actually shows: the tree also
  // carries images scrolled ABOVE the viewport (a negative y), and a pointer at
  // such a coordinate is outside the window entirely.
  const onScreen = warm.nodes.filter(node => {
    if (node.tag !== 'img') return false
    const box = rect(node)
    return box[1] >= 0 && box[1] + box[3] <= vh && box[2] > 0 && box[3] > 0
  })
  h.check('at least one painted image is INSIDE the viewport to click', onScreen.length > 0,
    JSON.stringify(warm.nodes.filter(node => node.tag === 'img').map(node => rect(node))))
  if (onScreen.length === 0) return
  const firstImage = onScreen[0]
  const hovered = await h.hover(warm.chains, firstImage)
  h.measure('the pointer over the first image', JSON.stringify(hovered))
  const clicked = await h.click(warm.chains, firstImage)
  h.check('a REAL pointer click on the image is delivered', clicked === true, JSON.stringify({ clicked }))
  const viewer = viewerOf(h.ctl('a11y'))
  h.check('the client opens its OWN image viewer on that click', viewer !== undefined,
    'the accessibility tree must carry a Dialog')
  if (viewer === undefined) return
  h.measure('the viewer dialog', JSON.stringify({
    name: viewer.name,
    bounds: viewer.bounds,
    elements: elementsOf(viewer),
  }))
  const viewerImage = elementsOf(viewer).find(element => element.role === 'Image')
  h.check('the viewer shows the image with its attachment name and source size',
    viewerImage !== undefined && String(viewerImage.name).includes('320 by 180'),
    JSON.stringify(viewerImage))
  h.capture('pr4-gui-image-viewer', 'the client\'s own image viewer after a real click')

  // ── The SIBLING question, measured WHILE the viewer is open ──
  // Two images live under the ONE User message, so the sibling affordances only
  // exist inside the open viewer. Measuring after Escape would observe the
  // transcript, not the viewer, and prove nothing about sibling navigation.
  const viewerButtons = elementsOf(viewer).filter(element => element.role === 'Button')
  h.measure('the viewer buttons while it is open', JSON.stringify(viewerButtons))
  const siblingControl = viewerButtons.find(element => /next|previous|back|forward|\u2039|\u203a/i.test(String(element.name ?? '')))
  h.measure('the viewer sibling affordance (this client build)',
    JSON.stringify({ found: siblingControl !== undefined, control: siblingControl ?? null }))
  if (siblingControl?.bounds !== undefined) {
    const [sx, sy, sw, sh] = siblingControl.bounds
    const openedName = String(viewerImage?.name ?? '')
    await h.clickAt(sx + sw / 2, sy + sh / 2, 900)
    const afterSibling = viewerOf(h.ctl('a11y'))
    const siblingImage = elementsOf(afterSibling).find(element => element.role === 'Image')
    h.check('the sibling control moves the viewer to the OTHER image of the same message',
      siblingImage !== undefined && String(siblingImage.name) !== openedName,
      `opened=${JSON.stringify(openedName)} now=${JSON.stringify(String(siblingImage?.name ?? ''))}`)
    h.capture('pr4-gui-viewer-sibling', 'the client viewer after using its sibling affordance')
  } else {
    // Recorded, never claimed as a pass: this build exposes no sibling control.
    h.measure('the viewer sibling navigation is UNPROVEN on this client build',
      'no next/previous control in the open viewer accessibility tree')
  }

  // ── Escape is the client's own close path, asserted BEFORE any fallback ──
  await h.key('escape', 800)
  const afterEscape = viewerOf(h.ctl('a11y'))
  h.check('the Escape key closes the client\'s own image viewer', afterEscape === undefined,
    JSON.stringify(afterEscape === undefined ? 'closed' : 'the viewer is still open'))
  if (afterEscape !== undefined) {
    const close = elementsOf(afterEscape).find(element => element.role === 'Button' && element.name === 'Close')
    h.measure('the viewer close control', JSON.stringify(close))
    if (close?.bounds !== undefined) {
      const [x, y, w, height] = close.bounds
      await h.clickAt(x + w / 2, y + height / 2, 900)
    }
  }
  const afterClose = h.snapshot()
  h.check('the transcript is back after the viewer closed',
    afterClose.nodes.some(node => node.tag === 'img'), h.texts(afterClose).join(' | '))
  h.check('the dock count and chips survived the viewer round-trip',
    h.has(afterClose, 'Draft 3 · ') && h.has(afterClose, '#1 · 320×180'),
    h.texts(afterClose).join(' | '))

  h.capture('pr4-gui-after-close', 'back in the transcript after the viewer closed')

  // ── Light/dark are BOTH captured, and a SHORT window is measured, not claimed ──
  // The client's OWN light theme name: `theme light <name>` refuses an unknown
  // name, so the run reads the client's current value instead of assuming one.
  const lightName = typeof state?.theme_light === 'string' && state.theme_light !== ''
    ? state.theme_light
    : 'light'
  h.ctl('theme', 'light', lightName)
  h.measure('the light theme', String(lightName))
  const short = await h.resize(1280, 520)
  h.measure('the short window size (MEASUREMENT, never an automatic degradation)',
    JSON.stringify({ requested: short.requested, actual: short.viewport, clamped: short.clamped }))
  const shortSnap = h.snapshot()
  const shortViewport = h.ctl('stats').viewport ?? [0, 0, 0, 0]
  const [, shortH] = shortViewport
  const shortComposer = composerOf(shortSnap)
  h.check('the controlled editor is still painted at the short window', shortComposer !== undefined,
    h.texts(shortSnap).join(' | '))
  if (shortComposer !== undefined) {
    const box = rect(shortComposer)
    h.measure('dock composer box at the short window', JSON.stringify(box))
    // `containedXY` only answers the ANCESTOR-CLIPPING question. On a scrolling
    // document a node can be fully contained and still sit BELOW the visible
    // viewport, which is exactly the short-window risk this lane exists for.
    const insideViewport = box[1] >= 0 && box[1] + box[3] <= shortH
    h.check('the controlled editor is INSIDE the short window viewport (not merely unclipped)',
      insideViewport,
      `composer=${JSON.stringify(box)} viewportHeight=${shortH} contained=${containedXY(shortSnap.chains, shortComposer)}`)
  }
  const shortBefore = composerTextOf(h.snapshot())
  await h.key('b', 700)
  const shortAfter = composerTextOf(h.snapshot())
  h.check('a REAL key at the short window changes the controlled editor text',
    shortBefore !== undefined && shortAfter !== undefined && shortAfter !== shortBefore,
    `before=${JSON.stringify(shortBefore)} after=${JSON.stringify(shortAfter)}`)
  h.capture('pr4-gui-short-window', 'the short window: measured, never an automatic degradation')

  writeFileSync(join(h.root, 'a11y-final.json'), JSON.stringify(h.ctl('a11y'), null, 1))
  h.measure('the viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
}

/**
 * The pane an editor really lives in, plus the strict verdicts the acceptance
 * requires. `containedXY` alone is NOT a visibility proof: a node can sit inside
 * every recorded ancestor box and still be laid out below the pane's visible
 * edge (that is exactly how the first short-window draft was wrong). This
 * resolves the nearest `section.tn-pane` ancestor and reports:
 *
 * - `inPaneRect`: the editor's full top/bottom/left/right inside that pane's rect;
 * - `fullyVisible`: the editor's entire rect survives EVERY clipping ancestor;
 * - `ancestorContained`: the original `containedXY` answer, kept for continuity.
 */
function editorPaneVisibility(snapshot, composer) {
  const chain = snapshot.chains.get(composer) ?? []
  const pane = [...chain].reverse().find(node => /\btn-pane\b/.test(String(node.class ?? '')))
  const box = rect(composer)
  const paneRect = pane === undefined ? undefined : rect(pane)
  const inPaneRect = paneRect !== undefined
    && box[0] >= paneRect[0]
    && box[1] >= paneRect[1]
    && box[0] + box[2] <= paneRect[0] + paneRect[2]
    && box[1] + box[3] <= paneRect[1] + paneRect[3]
  return {
    paneRect,
    box,
    inPaneRect,
    fullyVisible: fullyVisible(snapshot.chains, composer),
    ancestorContained: containedXY(snapshot.chains, composer),
    visible: visibleBox(snapshot.chains, composer),
  }
}

/**
 * The THREE verdicts must all hold, together, for one editor: it is inside its
 * pane's own rect, its whole rect survives clipping, and (checked by the caller)
 * a real key edits it.
 */
function assertEditorVisibleInPane(h, label, snapshot, composer) {
  const v = editorPaneVisibility(snapshot, composer)
  h.measure(`${label} editor vs pane`, JSON.stringify(v))
  // Three INDEPENDENT verdicts, each able to fail on its own. Measured on the
  // real client, a partially clipped editor can still be "inside the pane rect"
  // (its top/bottom are within the pane box) while only a 7.6px sliver of its
  // 16px row survives — so the rect test alone never implies visibility.
  h.check(`${label}: the editor's WHOLE rect is inside its PANE rect`, v.inPaneRect,
    `editor=${JSON.stringify(v.box)} pane=${JSON.stringify(v.paneRect)}`)
  h.check(`${label}: the editor's whole rect survives every clipping ancestor`, v.fullyVisible,
    JSON.stringify(v.visible))
  h.check(`${label}: the editor is ancestor-contained (containedXY, kept)`, v.ancestorContained,
    `editor=${JSON.stringify(v.box)}`)
  return v
}

/**
 * The SPLIT-PANE gate (amendment §5 T4): a tall window divided into two short
 * panes. The window media query does NOT fire here, so this is the case the
 * per-node `max` ceiling has to carry — and the case a window-only CSS fix was
 * proven not to solve. It runs as a SEPARATE drive on purpose: the split has to
 * happen BEFORE the subject launches in the pane.
 */
async function splitPaneGate(h) {
  const { join } = await import('node:path')

  // A TALL window, so the `max-height: 640px` rule can never match. The height
  // is chosen so two panes land at the contract's 22 rows (the amendment's
  // exact split case), not merely "short".
  await h.resize(1280, 800)
  // The driver's OWN split: it asserts the pane count and that the focus did not
  // move, so the subject can never launch into the wrong pane.
  const after = await h.splitPane('down')
  h.measure('the split pane rows', JSON.stringify(after.map(block => ({ rows: block.rows, cols: block.cols }))))
  // The amendment's exact case is 2 × 22 rows: assert EXACTLY that, so the case
  // cannot pass on a nearby height.
  h.check('each split pane is EXACTLY the contract 22 rows (so the window rule cannot help)',
    after.every(block => block.rows === 22), JSON.stringify(after.map(block => block.rows)))

  // Launch the subject in the FOCUSED (lower) pane and measure it there.
  const subject = join(h.repo, 'scripts', 'tern-gui-draft-and-transcript-images-subject.mts')
  const booted = await h.launch(subject, { ready: '[IMAGE] first-shot.png' })
  h.check('the subject boots inside a SPLIT pane', booted)
  if (!booted) return

  const snap = h.snapshot()
  const viewport = h.ctl('stats').viewport ?? [0, 0, 0, 0]
  h.measure('THE WINDOW is taller than the CSS breakpoint (so the sheet cannot fire)',
    `windowHeight=${viewport[1]}`)
  h.check('the window really is taller than 640px', viewport[1] > 640, `height=${viewport[1]}`)

  // The preview chips must still be BOUNDED, and the editor must stay in-pane.
  // HARD assertions on the geometry, not a measure: two previews, side by side
  // (different x, near-identical y), each within the `12ch x 4lines` ceiling.
  const images = snap.nodes.filter(node => node.tag === 'img')
  const dockImages = images.filter(node => {
    const box = rect(node)
    // The preview chips are the small ones; transcript images keep their size.
    return box[2] > 0 && box[2] <= 12 * 8.2 && box[3] > 0 && box[3] <= 4 * 18
  })
  h.check('the split pane draws exactly TWO bounded preview chips', dockImages.length === 2,
    JSON.stringify(images.map(node => rect(node))))
  if (dockImages.length === 2) {
    const [a, b] = dockImages.map(node => rect(node))
    h.check('the two chips are side by side (different x, same row)', Math.abs(a[0] - b[0]) > 4 && Math.abs(a[1] - b[1]) <= 2,
      `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
    h.check('each chip is within the 12ch x 4lines ceiling', dockImages.every(node => {
      const box = rect(node)
      return box[2] <= 12 * 8.2 + 1 && box[3] <= 4 * 18 + 1
    }), JSON.stringify(dockImages.map(node => rect(node))))
    h.measure('the chip boxes', JSON.stringify([a, b]))
  }
  h.measure('image boxes inside the split pane', JSON.stringify(images.map(node => rect(node))))
  const composerOf = snapshot => snapshot.nodes.find(node => String(node.text ?? '').includes('see attached'))
  const composer = composerOf(snap)
  h.check('the controlled editor is painted inside the split pane', composer !== undefined)
  if (composer !== undefined) {
    h.measure('dock composer box inside the split pane', JSON.stringify(rect(composer)))
    assertEditorVisibleInPane(h, '22-row split', snap, composer)
  }
  h.check('the draft count is on the status line inside the split pane',
    h.has(snap, 'Draft 3 · '), h.texts(snap).join(' | '))
  const textBefore = composer === undefined ? undefined : String(composer.text ?? '')
  await h.key('c', 700)
  const composerAfter = composerOf(h.snapshot())
  const textAfter = composerAfter === undefined ? undefined : String(composerAfter.text ?? '')
  h.check('a REAL key inside the split pane changes the controlled editor text',
    textBefore !== undefined && textAfter !== undefined && textAfter !== textBefore,
    `before=${JSON.stringify(textBefore)} after=${JSON.stringify(textAfter)}`)
  h.capture('pr4-gui-split-pane', 'the amendment split-pane gate: bounded chips, editor in-pane and typable')
}

/**
 * The amendment's WORST short-pane case: the same 2 × 22-row split with queue
 * rows and notices above the band and a MULTI-LINE draft. It runs the subject
 * with `TERN_GUI_BUSY=1`, so the dock carries those rows for real.
 */
async function splitPaneBusyGate(h) {
  const { join } = await import('node:path')
  await h.resize(1280, 800)
  const after = await h.splitPane('down')
  // The SAME T4 premises as the plain split gate, asserted — not measured — so a
  // nearby height can never stand in for the contract's 2 x 22 case.
  h.check('each busy split pane is EXACTLY the contract 22 rows (so the window rule cannot help)',
    after.every(block => block.rows === 22), JSON.stringify(after.map(block => block.rows)))

  // The launcher does not forward arbitrary env, so the busy shape is selected by
  // a marker file inside the run directory (which the subject can read).
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(h.root, 'busy.marker'), '1')
  const subject = join(h.repo, 'scripts', 'tern-gui-draft-and-transcript-images-subject.mts')
  const booted = await h.launch(subject, { ready: 'queued (queue)' })
  h.check('the busy-subject boots inside a SPLIT pane', booted)
  if (!booted) return

  const snap = h.snapshot()
  const busyViewport = h.ctl('stats').viewport ?? [0, 0, 0, 0]
  h.check('the busy WINDOW is still taller than the CSS breakpoint (the sheet cannot fire)',
    busyViewport[1] > 640, `height=${busyViewport[1]}`)
  const busyText = h.texts(snap).join(' | ')
  h.check('the queue row is painted', busyText.includes('queued (queue)'), busyText)
  h.check('BOTH notices are painted',
    busyText.includes('a previous attempt failed') && busyText.includes('compacting (summarizing)'),
    busyText)
  h.check('the draft count is on the status line in the busy pane',
    h.has(snap, 'Draft 3 · '), busyText)
  h.check('the busy pane still draws the bounded preview chips', snap.nodes.filter(node => {
    if (node.tag !== 'img') return false
    const box = rect(node)
    return box[2] > 0 && box[2] <= 12 * 8.2 && box[3] > 0 && box[3] <= 4 * 18
  }).length === 2, JSON.stringify(snap.nodes.filter(node => node.tag === 'img').map(node => rect(node))))

  const composerOf = snapshot => snapshot.nodes.find(node => String(node.text ?? '').includes('see attached'))
  const composer = composerOf(snap)
  h.check('the MULTI-LINE editor is still painted in the busy split pane', composer !== undefined)
  if (composer !== undefined) {
    const box = rect(composer)
    h.measure('busy dock composer box', JSON.stringify(box))
    assertEditorVisibleInPane(h, 'busy 22-row split', snap, composer)
    // The editor must really BE multi-line. The client normalizes the controlled
    // text for its accessibility string, so the RENDERED HEIGHT is the honest
    // witness: a one-line editor is ~16px, the seeded 4-newline draft is taller.
    h.check('the busy editor renders MORE THAN ONE text row (a real multi-line editor)',
      box[3] > 3 * 16,
      `editorBox=${JSON.stringify(box)} — a single-line editor is about 16px`)
  }
  const before2 = composer === undefined ? undefined : String(composer.text ?? '')
  await h.key('d', 700)
  const afterComposer = composerOf(h.snapshot())
  const after2 = afterComposer === undefined ? undefined : String(afterComposer.text ?? '')
  h.check('a REAL key in the busy split pane changes the controlled editor text',
    before2 !== undefined && after2 !== undefined && after2 !== before2,
    `before=${JSON.stringify(before2)} after=${JSON.stringify(after2)}`)
  h.capture('pr4-gui-split-pane-busy', 'the worst short-pane case: notices, multi-line editor, bounded chips')
}
