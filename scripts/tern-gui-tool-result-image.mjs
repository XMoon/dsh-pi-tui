/**
 * The real-GUI lane for the tool-result image: the PRODUCTION image projection,
 * by a REAL Tern GUI window on a REAL display.
 *
 * It answers the questions the headless lane cannot: the image is painted in
 * a REAL native window with the real font stack, the client's own theme still
 * paints it, the image is in the client's ACCESSIBILITY tree, and a REAL
 * pointer opens the client's own image viewer - with its own close path. The
 * image's box and its clipping ancestors are measured, so "the image is on
 * screen" is a measurement and not a claim.
 *
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-tool-result-image.mjs
 *
 * The client's viewer affordances (the zoom control, the info button) are
 * MEASURED, never relied upon: the projection does not depend on them.
 * @module scripts/tern-gui-tool-result-image
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, rect } from './tern-pane-geometry.mjs'

/** The client's image-viewer dialog, read from the accessibility tree. */
function viewerOf(a11y) {
  let found
  const walk = (node) => {
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
  // The window must be a real native window on a real display.
  const system = h.ctl('system')
  h.check('the GUI window is a real native window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))

  // A REAL WINDOW HAS A MINIMUM SIZE: the client clamps a narrow request, so
  // the flow asks for a size the window can take and REPORTS the clamp.
  const size = await h.resize(1280, 800)
  h.check('the window took the requested content size', size.clamped === false,
    `requested=${JSON.stringify(size.requested)} actual=${JSON.stringify(size.viewport)}`)
  h.measure('the window size', JSON.stringify(size))

  const subject = join(h.repo, 'scripts', 'tern-gui-tool-result-image-subject.mts')
  const booted = await h.launch(subject, { ready: '[IMAGE] shot.png' })
  h.check('the production projection is painted inside a real Tern GUI pane', booted)
  if (!booted) {
    h.measure('the subject stderr', 'the subject did not paint')
    return
  }

  const snap = h.snapshot()
  h.check('the identity line is painted', h.has(snap, '[IMAGE] shot.png'),
    h.texts(snap).join(' | '))
  h.check('the text blocks around the image are painted',
    h.has(snap, 'Here is the screenshot.') && h.has(snap, 'This is the area to inspect.'),
    h.texts(snap).join(' | '))

  const image = snap.nodes.find((node) => node.tag === 'img')
  h.check('the client drew a native image element', image !== undefined,
    JSON.stringify(snap.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  if (image === undefined) return
  h.measure('the image box', JSON.stringify(rect(image)))
  h.measure('the image class', String(image.class ?? ''))
  h.check('the image is NOT clipped by any ancestor', containedXY(snap.chains, image),
    `box=${JSON.stringify(rect(image))}`)

  h.capture('prc-gui-image-light', 'the production tool-result image in a real Tern GUI window')

  // The client's OWN theme: the image must still paint.
  const state = h.ctl('state')
  const darkTheme = Array.isArray(state?.theme_dark) && state.theme_dark.length > 0 ? state.theme_dark[0] : 'titanium'
  h.ctl('theme', 'dark', darkTheme)
  h.measure('the dark theme', String(darkTheme))
  const dark = h.snapshot()
  const darkImage = dark.nodes.find((node) => node.tag === 'img')
  h.check('the image is still drawn in the client own dark theme', darkImage !== undefined,
    JSON.stringify(dark.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  h.check('the identity line is still readable in the client dark theme',
    h.has(dark, '[IMAGE] shot.png'),
    h.texts(dark).join(' | '))
  h.capture('prc-gui-image-dark', 'the same projection in the client own dark theme')

  // The ACCESSIBILITY tree: the image is a real node for a screen reader,
  // with a real box and the client's own actions. Its ACCESSIBLE NAME is
  // MEASURED, not asserted: on this client build the inline image node
  // carries no name (the client's own viewer names the image - see the
  // viewer check below). The lane therefore claims the TREE, not a name.
  const a11y = h.ctl('a11y')
  const inlineImages = elementsOf(a11y).filter((element) => element.role === 'Image')
  h.check('the client exposes the image to the accessibility tree', inlineImages.length > 0,
    JSON.stringify(inlineImages))
  h.check('the accessibility image node carries a real box', inlineImages.every((element) => {
    const bounds = element.bounds ?? []
    return Array.isArray(bounds) && bounds.length === 4 && bounds[2] > 0 && bounds[3] > 0
  }), JSON.stringify(inlineImages))
  h.measure('the accessibility image nodes', JSON.stringify(inlineImages))
  h.measure('the inline image accessible name (this client build)',
    JSON.stringify(inlineImages.map((element) => element.name ?? null)))

  // A REAL pointer on the image: the client's own image viewer. `image` came
  // from `snap`, so its chains must come from `snap` too: the oracle indexes by
  // node identity, and chains from another snapshot do not contain this node.
  const hovered = await h.hover(snap.chains, image)
  h.measure('the pointer over the image', JSON.stringify(hovered))
  const clicked = await h.click(snap.chains, image)
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
  const viewerImage = elementsOf(viewer).find((element) => element.role === 'Image')
  h.check('the viewer shows the image with the attachment name and its source size',
    viewerImage !== undefined && String(viewerImage.name).includes('shot.png')
    && String(viewerImage.name).includes('640 by 360'),
    JSON.stringify(viewerImage))
  h.capture('prc-gui-image-viewer', 'the client own image viewer after a real click')

  // The CLOSE path: the KEYBOARD first, asserted on its own. A viewer that
  // only closes because the flow clicked the Close button afterwards would
  // make this check pass for the wrong reason, so the Escape result is
  // asserted BEFORE any fallback click.
  await h.key('escape', 800)
  const afterEscape = viewerOf(h.ctl('a11y'))
  h.check('the Escape key closes the client own image viewer', afterEscape === undefined,
    JSON.stringify(afterEscape === undefined ? 'closed' : 'the viewer is still open'))
  if (afterEscape !== undefined) {
    const close = elementsOf(afterEscape).find((element) => element.role === 'Button' && element.name === 'Close')
    h.measure('the viewer close control', JSON.stringify(close))
    if (close?.bounds !== undefined) {
      const [x, y, w, height] = close.bounds
      await h.clickAt(x + w / 2, y + height / 2, 900)
    }
  }
  const afterClose = h.snapshot()
  h.check('the transcript is back after the viewer closed',
    afterClose.nodes.some((node) => node.tag === 'img'),
    JSON.stringify(afterClose.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  h.check('the image is still in the transcript, not only in the viewer',
    h.has(afterClose, '[IMAGE] shot.png'),
    h.texts(afterClose).join(' | '))
  h.capture('prc-gui-image-after-close', 'back in the transcript after the viewer closed')

  writeFileSync(join(h.root, 'a11y-after-close.json'), JSON.stringify(h.ctl('a11y'), null, 1))
  h.measure('the viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
}
