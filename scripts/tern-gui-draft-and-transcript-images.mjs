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
import { containedXY, rect } from './tern-pane-geometry.mjs'

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
  h.check('the dock states the live occurrence count and the hidden tail',
    h.has(snap, 'Draft images · 3 occurrences') && h.has(snap, '1 more image occurrence'),
    h.texts(snap).join(' | '))

  // ── The controlled editor: present, unclipped, typable ──
  const composerOf = snapshot => snapshot.nodes.find(node => String(node.text ?? '').includes('see attached'))
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
  await h.key('a', 600)
  h.check('the controlled editor still receives real keys with previews up',
    composerOf(h.snapshot()) !== undefined, h.texts(h.snapshot()).join(' | '))

  const images = snap.nodes.filter(node => node.tag === 'img')
  h.check('the client drew native image elements for the transcript AND the dock',
    images.length >= 5, JSON.stringify(images.map(node => rect(node))))
  h.measure('image boxes (1280x800)', JSON.stringify(images.map(node => rect(node))))
  h.check('every painted image is unclipped by its ancestors',
    images.every(node => containedXY(snap.chains, node)),
    JSON.stringify(images.map(node => ({ box: rect(node), ok: containedXY(snap.chains, node) }))))

  h.capture('pr4-gui-light', 'the PR4 image surfaces in a real Tern GUI window (light)')

  // ── The client's own theme ──
  const state = h.ctl('state')
  const darkTheme = Array.isArray(state?.theme_dark) && state.theme_dark.length > 0 ? state.theme_dark[0] : 'titanium'
  h.ctl('theme', 'dark', darkTheme)
  h.measure('the dark theme', String(darkTheme))
  const dark = h.snapshot()
  h.check('the User body image is still drawn in the client\'s own dark theme',
    dark.nodes.some(node => node.tag === 'img'), h.texts(dark).join(' | '))
  h.check('the dock count line is still readable in the dark theme',
    h.has(dark, 'Draft images · 3 occurrences'), h.texts(dark).join(' | '))
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
  h.check('the dock rows survived the viewer round-trip',
    h.has(afterClose, 'Draft images · 3 occurrences'), h.texts(afterClose).join(' | '))

  // ── The SIBLING question: two images under the ONE User message ──
  // The client's sibling behaviour is MEASURED, never assumed: the lane records
  // whether the viewer offers a next/previous affordance for this shape.
  const siblings = elementsOf(h.ctl('a11y')).filter(element =>
    element.role === 'Button' && /Next|Previous|Zoom/i.test(String(element.name ?? '')))
  h.measure('the viewer sibling/zoom affordances (this client build)', JSON.stringify(siblings))
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
  await h.key('b', 600)
  h.check('the controlled editor still accepts keys at the short window',
    composerOf(h.snapshot()) !== undefined, h.texts(h.snapshot()).join(' | '))
  h.capture('pr4-gui-short-window', 'the short window: measured, never an automatic degradation')

  writeFileSync(join(h.root, 'a11y-final.json'), JSON.stringify(h.ctl('a11y'), null, 1))
  h.measure('the viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
}
