/**
 * The PR-C real-pane flow: the PRODUCTION tool-result image projection, painted
 * by a REAL Tern client.
 *
 * It proves the acceptance that headless cannot: that the client really draws
 * the native image node the shipped mapper emits, next to the identity line,
 * at more than one viewport — and it records the client's own layout box for
 * the image, so the "Tern owns the sizing" boundary is a MEASUREMENT, never a
 * promise.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-pr-c-image.mjs
 *
 * The client-side ZOOM / click / keyboard / scroll-back behaviour is NOT
 * exercised here: it needs a physical GUI, and this flow claims nothing about
 * it.
 * @module scripts/tern-pane-pr-c-image
 */
import { join } from 'node:path'

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-pr-c-image-subject.mts')

  await h.resize(900, 640)
  const booted = await h.launch(subject)
  h.check('the subject boots inside a real Tern pane', booted)
  // The real content IS the readiness signal: the production identity line
  // only appears once the real client has painted the real projection.
  const painted = await h.waitFor('[IMAGE] shot.png')
  h.check('the production projection is painted by the real client', painted,
    h.texts(h.snapshot()).join(' | '))

  const wide = h.snapshot()
  h.check('the production identity line is painted',
    h.has(wide, '[IMAGE] shot.png'),
    h.texts(wide).join(' | '))
  h.check('the text blocks around the image are painted',
    h.has(wide, 'Here is the screenshot.') && h.has(wide, 'This is the area to inspect.'),
    h.texts(wide).join(' | '))

  const image = wide.nodes.find((node) => node.tag === 'img')
  h.check('the client drew a native image node', image !== undefined,
    JSON.stringify(wide.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  if (image !== undefined) {
    h.measure('image-box-900x640', JSON.stringify(image.rect))
    h.measure('image-class', String(image.class ?? ''))
  }
  h.capture('prc-image-900x640', 'the production tool-result image in a real Tern pane')

  await h.resize(400, 600)
  const narrow = h.snapshot()
  const narrowImage = narrow.nodes.find((node) => node.tag === 'img')
  h.check('the image is still drawn in the narrow viewport', narrowImage !== undefined,
    JSON.stringify(narrow.nodes.filter((node) => node.tag === 'img').map((node) => node.rect)))
  if (narrowImage !== undefined) {
    h.measure('image-box-400x600', JSON.stringify(narrowImage.rect))
  }
  h.check('the identity line is still readable in the narrow viewport',
    h.has(narrow, '[IMAGE] shot.png'),
    h.texts(narrow).join(' | '))
  h.capture('prc-image-400x600', 'the same projection in a narrow viewport')

  h.measure('viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
}
