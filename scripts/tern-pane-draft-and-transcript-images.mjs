/**
 * The real-pane lane for the PR4 image surfaces: the PRODUCTION image
 * projections (User/Assistant/Tool bodies + the dock's draft rows), painted by
 * a REAL Tern client.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-draft-and-transcript-images.mjs
 *
 * What this lane can prove (and what it cannot):
 *
 * - PROVES: the client really paints the native image nodes the shipped mappers
 *   emit, their identity lines, the ordered User/Assistant bodies, the dock's
 *   2/1/0 preview policy across real width bands, and that the controlled
 *   `dock.composer` editor stays present and contained at every tested size.
 * - DOES NOT PROVE: physical window focus, IME/font behaviour, the client's own
 *   image-viewer gestures, or ANY pane-height rule — the SDK publishes no pane
 *   rows, so a short-height claim needs the real GUI lane and must never be
 *   inferred from this run.
 *
 * Every visible check goes through the visibility oracle (ancestor clipping
 * plus a real PNG), never a node's own rect.
 * @module scripts/tern-pane-draft-and-transcript-images
 */
import { join } from 'node:path'
import { containedXY, rect } from './tern-pane-geometry.mjs'

/** Every `<img>` of the client's own tree. */
function imagesOf(snapshot) {
  return snapshot.nodes.filter(node => node.tag === 'img')
}

/** Whether the identity line of one attachment is painted. */
function paints(snapshot, text) {
  return snapshot.nodes.some(node => String(node.text ?? '').includes(text))
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-draft-and-transcript-images-subject.mts')

  // The WIDE band (>= 100 columns): both draft previews the policy allows.
  await h.resize(900, 640)
  const booted = await h.launch(subject, { ready: '[IMAGE] user-shot.png' })
  h.check('the subject boots inside a real Tern pane', booted)
  if (!booted) {
    h.measure('the subject stderr', 'the subject did not paint')
    return
  }

  const wide = h.snapshot()
  // ── The ordered transcript bodies ──
  h.check('the USER body identity line is painted', paints(wide, '[IMAGE] user-shot.png'),
    h.texts(wide).join(' | '))
  h.check('the ASSISTANT body identity line is painted', paints(wide, '[IMAGE] diagram.png'),
    h.texts(wide).join(' | '))
  h.check('the TOOL result identity line is painted', paints(wide, '[IMAGE] shot.png'),
    h.texts(wide).join(' | '))
  h.check('the text blocks around the USER image are painted',
    paints(wide, 'Please inspect these screenshots.') && paints(wide, 'The second one shows the failing area.'),
    h.texts(wide).join(' | '))

  // ── The dock's draft rows at the wide band ──
  h.check('the dock states the live occurrence count', paints(wide, 'Draft images · 3 occurrences'),
    h.texts(wide).join(' | '))
  const wideImages = imagesOf(wide)
  h.check('the client drew the transcript images AND the two wide-band draft previews',
    wideImages.length >= 5, JSON.stringify(wideImages.map(node => rect(node))))
  h.measure('image boxes (900x640)', JSON.stringify(wideImages.map(node => rect(node))))

  // ── The CONTROLLED EDITOR must stay present, contained and typable ──
  // The client's tree carries no wire id: the controlled editor is identified by
  // its own painted content (the subject's known draft text) and its kind.
  const composerOf = snapshot => snapshot.nodes.find(node =>
    String(node.text ?? '').includes('see attached'))
  const wideComposer = composerOf(wide)
  h.check('the controlled dock composer is painted at the wide band', wideComposer !== undefined,
    JSON.stringify({ hasComposer: wideComposer !== undefined }))
  if (wideComposer === undefined) return
  h.measure('dock composer box (900x640)', JSON.stringify(rect(wideComposer)))
  h.check('the dock composer is NOT clipped by any ancestor', containedXY(wide.chains, wideComposer),
    `box=${JSON.stringify(rect(wideComposer))}`)
  h.capture('pr4-images-900x640', 'the PR4 image projection in a real Tern pane (wide band)')

  // A REAL key into the editor: the client forwards it and the subject's own
  // loop is the only reader, which proves the seat is live (not a screenshot).
  await h.key('a', 600)
  h.check('the controlled editor still receives real keys with the previews up',
    composerOf(h.snapshot()) !== undefined,
    h.texts(h.snapshot()).join(' | '))

  // ── The MEDIUM band (72..99): exactly ONE draft preview ──
  await h.resize(700, 600)
  const medium = h.snapshot()
  const mediumImages = imagesOf(medium)
  h.check('the medium band still paints the three transcript images plus ONE draft preview',
    mediumImages.length >= 4, JSON.stringify(mediumImages.map(node => rect(node))))
  h.check('the medium-band count line is still painted', paints(medium, 'Draft images · 3 occurrences'),
    h.texts(medium).join(' | '))
  const mediumComposer = composerOf(medium)
  h.check('the dock composer survives the medium band', mediumComposer !== undefined)
  if (mediumComposer !== undefined) {
    h.check('the medium-band dock composer is NOT clipped', containedXY(medium.chains, mediumComposer),
      `box=${JSON.stringify(rect(mediumComposer))}`)
  }
  h.capture('pr4-images-700x600', 'the same projection at the medium band (one draft preview)')

  // ── The NARROW band (< 72): no draft preview, count + first identity only ──
  await h.resize(400, 600)
  const narrow = h.snapshot()
  h.check('the narrow deck degrades the draft rows to the count plus the FIRST identity',
    paints(narrow, 'Draft images · 3 occurrences') && paints(narrow, 'draft-1.png'),
    h.texts(narrow).join(' | '))
  const narrowComposer = composerOf(narrow)
  h.check('the dock composer survives the NARROW band (the editor is never dropped)',
    narrowComposer !== undefined)
  if (narrowComposer !== undefined) {
    h.check('the narrow-band dock composer is NOT clipped', containedXY(narrow.chains, narrowComposer),
      `box=${JSON.stringify(rect(narrowComposer))}`)
  }
  h.measure('image boxes (400x600)', JSON.stringify(imagesOf(narrow).map(node => rect(node))))
  h.capture('pr4-images-400x600', 'the narrow band: metadata-only draft degradation, editor preserved')

  h.measure('viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
}
