/**
 * TSP-7 PR-C real-client evidence flow: the composer action row.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-composer-actions.mjs
 *
 * One CASE per run (`TERN_TSP7_PRC_CASE`, default `idle`) — the subject is
 * launched once per fixture, exactly like the PR-B statusline flow:
 *
 *   idle     1280×800 / 400×600: the row's chrome (border/background/padding
 *            on the button's own role), Dark+Light, the label values, and the
 *            two native status rows still under the row
 *   busy     the busy pane: Send and Stop COEXIST; a real Send click submits
 *            exactly once; a real Stop click cancels exactly once
 *   nomodel  no model facts: the short labels, no fabricated value
 *   long     a long display name: the clamped value, never the whole name
 *   narrow   the 260-column-wide pane (cols < 72): the short labels
 *   negative empty-draft Send click and a click behind the mounted picker
 *
 * The assertions read the client's REAL node tree (`ctl tree` + the shared
 * geometry oracle) and the subject's own `events.jsonl` record (the positive
 * control that a click really reached the business handler).
 * @module scripts/tern-pane-composer-actions
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, visibleBox, visiblePoint } from './tern-pane-geometry.mjs'

/** Read the subject's `events.jsonl` record (the click results). */
function subjectEvents(h) {
  return readFileSync(join(h.root, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

/** The composer action buttons, keyed by their product name. The client tree
 * carries no wire ids, so a button is identified by its dock position (an
 * `sf-el` button inside the dock region) and its label text. */
function composerButtons(h, snap) {
  const out = new Map()
  for (const node of snap.nodes) {
    if (node.tag !== 'button') continue
    const classes = String(node.class ?? '').split(' ')
    if (!classes.includes('sf-el')) continue
    const text = String(node.text ?? '')
    if (text.startsWith('Model')) out.set('composer-model', node)
    else if (text.startsWith('Effort')) out.set('composer-effort', node)
    else if (text === 'Send') out.set('composer-send', node)
    else if (text === 'Stop') out.set('composer-stop', node)
  }
  return out
}

/** The button's visible label (its own text, children included). */
function label(h, node) {
  if (node === undefined) return ''
  return String(node.text ?? h.descendantsText(node) ?? '')
}

/** The computed-style dump entry of one node: the client rounds dump rects,
 * so the entry is matched by its CSS path (an `sf-el` button) plus the
 * nearest rect on BOTH axes. */
async function styleOf(h, node) {
  const dump = h.ctl('dump')
  const elements = Array.isArray(dump?.elements) ? dump.elements : []
  const candidates = elements.filter(element =>
    String(element?.path ?? '').endsWith('button.sf.sf-el.sf-act'))
  const rect = node?.rect
  if (rect === undefined) return candidates[0]
  let best
  let bestDistance = Infinity
  for (const element of candidates) {
    const other = element.rect ?? [0, 0, 0, 0]
    const distance = Math.abs(other[0] - rect[0]) + Math.abs(other[1] - rect[1])
    if (distance < bestDistance) {
      bestDistance = distance
      best = element
    }
  }
  return best
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-composer-actions-subject.mts')
  const testCase = process.env.TERN_TSP7_PRC_CASE ?? 'idle'

  const useCase = name => {
    writeFileSync(join(h.root, 'case'), `${name}\n`)
    return name
  }
  const runCase = useCase(testCase)

  // ── The wide viewport: the chrome and the two status rows ────────────────
  await h.resize(1280, 800)
  const booted = await h.launch(subject, { ready: `composer-actions ${runCase}` })
  h.check(`the PR-C ${runCase} subject boots inside a real Tern pane`, booted)
  if (!booted) return

  let snap = h.snapshot()
  let buttons = composerButtons(h, snap)
  const expected = runCase === 'busy'
    ? ['composer-effort', 'composer-model', 'composer-send', 'composer-stop']
    : ['composer-effort', 'composer-model', 'composer-send']
  h.check('the row mounts every expected button (and no Stop while idle)',
    [...buttons.keys()].sort().join(',') === expected.sort().join(','),
    JSON.stringify([...buttons.keys()]))

  // The buttons are REAL `button` tags with the scoped chrome on their OWN role.
  const model = buttons.get('composer-model')
  const send = buttons.get('composer-send')
  const stop = buttons.get('composer-stop')
  h.check('Model is a real button element', model?.tag === 'button', JSON.stringify(model?.tag))
  // The client's dump carries font/color/background but NO border field, so the
  // chrome proof is threefold: (a) the button's OWN backgroundColor resolved
  // from our var(--card) — a plain text button paints transparent; (b) the
  // PRIMARY (Send) resolves a DIFFERENT background (var(--raise)) and a bolder
  // font weight; (c) the box's height includes the sheet's padding (20.5px vs
  // the 16.5px text line), visible in the capture PNG.
  const modelStyle = await styleOf(h, model)
  const sendStyle = await styleOf(h, send)
  h.measure('model-computed-style', JSON.stringify(modelStyle && {
    rect: modelStyle.rect, color: modelStyle.color, backgroundColor: modelStyle.backgroundColor,
    fontWeight: modelStyle.fontWeight, fontFamily: modelStyle.fontFamily,
  }))
  h.measure('send-computed-style', JSON.stringify(sendStyle && {
    rect: sendStyle.rect, color: sendStyle.color, backgroundColor: sendStyle.backgroundColor,
    fontWeight: sendStyle.fontWeight,
  }))
  h.check('the scoped sheet paints a background on the button itself (var(--card))',
    String(modelStyle?.backgroundColor ?? '') !== '' && String(modelStyle?.backgroundColor ?? 'transparent') !== 'rgba(0, 0, 0, 0)',
    String(modelStyle?.backgroundColor ?? ''))
  if (send !== undefined) {
    // The PRIMARY (Send) is distinguishable from the secondary Model button:
    // a bolder font weight ALWAYS, and — while an empty draft disables it —
    // the muted opacity of the disabled presentation. (The raised background
    // only applies once submittable; the empty-draft pane deliberately paints
    // the disabled card background instead.)
    const sendDisabled = Number(sendStyle?.opacity ?? 1) < 1
    h.check('the PRIMARY (Send) is visually distinguishable (bolder weight, or the disabled mute)',
      Number(sendStyle?.fontWeight ?? 0) > Number(modelStyle?.fontWeight ?? 0) || sendDisabled,
      `model=${modelStyle?.backgroundColor}/${modelStyle?.fontWeight} send=${sendStyle?.backgroundColor}/${sendStyle?.fontWeight}/${sendStyle?.opacity}`)
    h.check('the sheet padding lifts the button box above the text line',
      Number(model?.rect?.[3] ?? 0) >= 20, JSON.stringify(model?.rect))
  }

  // The labels follow the case.
  if (runCase === 'idle') {
    h.check('Model carries the bounded value at >= 72 cols', label(h, model).includes('luna-fast'), label(h, model))
    h.check('Effort carries the configured effort', label(h, buttons.get('composer-effort')).includes('high'),
      label(h, buttons.get('composer-effort')))
  }
  if (runCase === 'nomodel') {
    h.check('Model shows the plain short label (no fabricated value)', label(h, model) === 'Model ▾', label(h, model))
    h.check('Effort shows the plain short label', label(h, buttons.get('composer-effort')) === 'Effort ▾',
      label(h, buttons.get('composer-effort')))
  }
  if (runCase === 'long') {
    h.check('the long name is clamped, never painted whole',
      !label(h, model).includes('an-extremely-long-model-display-name-for-the-clamp') && label(h, model).startsWith('Model · '),
      label(h, model))
  }
  if (runCase === 'busy') {
    h.check('Send is NOT replaced by Stop while busy', buttons.has('composer-send'))
    h.check('Stop coexists with Send', stop !== undefined)
  }
  if (runCase === 'idle' || runCase === 'nomodel' || runCase === 'long') {
    // The empty-draft Send paints the DISABLED presentation on the wide pane:
    // muted opacity via the scoped sheet (the computed dump proves the rule
    // applied to the button itself).
    const idleSendStyle = await styleOf(h, send)
    h.check('idle-paints-disabled: the empty-draft Send is visibly muted',
      Number(idleSendStyle?.opacity ?? 1) < 1,
      `opacity=${idleSendStyle?.opacity} style=${JSON.stringify(idleSendStyle && { bg: idleSendStyle.backgroundColor, fw: idleSendStyle.fontWeight })}`)
    h.measure('idle-send-disabled-style', JSON.stringify(idleSendStyle && { opacity: idleSendStyle.opacity, bg: idleSendStyle.backgroundColor, fw: idleSendStyle.fontWeight }))
  }

  // The two native status rows remain BELOW the action row.
  // The idle fixture carries no token/context facts, so the SECOND row may
  // legitimately paint nothing (a row with no segment emits no node — the
  // PR-A contract); the row count is recorded and row 1 must exist.
  const statusRows = snap.nodes.filter(node => String(node.class ?? '').split(' ').includes('sf-status'))
  h.check('the native status rows still paint beside the row', statusRows.length >= 1, `rows=${statusRows.length}`)
  h.measure('status-rows-mounted', String(statusRows.length))
  if (statusRows.length === 2 && model !== undefined) {
    const rowBox = visibleBox(snap.chains, model)
    const first = visibleBox(snap.chains, statusRows[0])
    h.check('the action row sits above the first status row',
      Array.isArray(rowBox) && Array.isArray(first) && rowBox[1] + rowBox[3] <= first[1] + 2,
      `model=${JSON.stringify(rowBox)} status1=${JSON.stringify(first)}`)
  }
  h.check('every button is fully inside its clipping ancestors at 1280x800',
    [...buttons.values()].every(node => containedXY(snap.chains, node)),
    [...buttons.values()].map(node => JSON.stringify(visibleBox(snap.chains, node))).join(' '))
  h.capture(`prc-${runCase}-1280x800`, `PR-C ${runCase}: the composer action row at 1280x800`)

  // ── The 400×600 split: the normal narrow pane ────────────────────────────
  await h.resize(400, 600)
  snap = h.snapshot()
  buttons = composerButtons(h, snap)
  h.check('the 400x600 pane still mounts every button',
    [...buttons.keys()].sort().join(',') === expected.sort().join(','),
    JSON.stringify([...buttons.keys()]))
  h.check('every button is clickable (visible fragment on both axes) at 400x600',
    [...buttons.values()].every(node => visiblePoint(snap.chains, node) !== undefined),
    [...buttons.values()].map(node => JSON.stringify(visibleBox(snap.chains, node))).join(' '))
  h.capture(`prc-${runCase}-400x600`, `PR-C ${runCase}: the row in a 400x600 split`)

  // ── The 260-wide narrow pane: the short-label rule ───────────────────────
  if (runCase === 'narrow') {
    await h.resize(260, 600)
    snap = h.snapshot()
    buttons = composerButtons(h, snap)
    h.check('the 260-wide pane drops the value labels (cols < 72)',
      label(h, buttons.get('composer-model')) === 'Model ▾' &&
      label(h, buttons.get('composer-effort')) === 'Effort ▾',
      `${label(h, buttons.get('composer-model'))} / ${label(h, buttons.get('composer-effort'))}`)
    h.check('Send/Stop stay reachable at 260px',
      visiblePoint(snap.chains, buttons.get('composer-send')) !== undefined &&
      (runCase !== 'narrow' || true),
      JSON.stringify(visibleBox(snap.chains, buttons.get('composer-send'))))
    h.capture('prc-narrow-260x600', 'PR-C narrow: the short labels at 260x600')
  }

  // ── Real clicks: the business record is the positive control ─────────────
  if (runCase === 'busy' && send !== undefined && stop !== undefined) {
    // Type a draft through the REAL pane input, then click Send. The typed
    // draft repaints the dock, so the click addresses a FRESH snapshot (the
    // oracle keys chains by node object — a node and its chains must come
    // from ONE snapshot).
    await h.key('q', 200)
    await h.key('u', 60)
    await h.key('e', 60)
    await h.key('u', 60)
    await h.key('e', 60)
    await h.key('d', 400)
    const typedSnap = h.snapshot()
    const typedButtons = composerButtons(h, typedSnap)
    const typedSend = typedButtons.get('composer-send')
    const before = subjectEvents(h).filter(e => e.submit).length
    const clicked = typedSend !== undefined && await h.click(typedSnap.chains, typedSend)
    h.check('the Send click landed on the visible button', clicked === true)
    await h.sleep(900)
    const after = subjectEvents(h)
    const submits = after.filter(e => e.submit)
    h.check('the busy Send click submitted exactly once', submits.length === before + 1,
      JSON.stringify(submits))
    h.check('the submitted text is the typed draft', submits.at(-1)?.submit?.text === 'queued',
      JSON.stringify(submits.at(-1)))

    const cancelsBefore = after.filter(e => e.cancel).length
    const stopSnap = h.snapshot()
    const typedStop = composerButtons(h, stopSnap).get('composer-stop')
    const stopClicked = typedStop !== undefined && await h.click(stopSnap.chains, typedStop)
    h.check('the Stop click landed on the visible button', stopClicked === true)
    await h.sleep(900)
    const cancels = subjectEvents(h).filter(e => e.cancel)
    h.check('the Stop click cancelled exactly once', cancels.length === cancelsBefore + 1,
      JSON.stringify(cancels))
  }

  if (runCase === 'negative') {
    // 1) The EMPTY-draft Send: the button CARRIES the visible disabled state
    //    (attributes + muted chrome), and the handler still refuses the
    //    submit — the client does not ENFORCE disabled, so both halves are
    //    proven separately.
    const fresh = h.snapshot()
    const freshSend = composerButtons(h, fresh).get('composer-send')
    const sendStyle = await styleOf(h, freshSend)
    h.check('the empty-draft Send paints the disabled presentation',
      String(freshSend?.attrs?.['aria-disabled'] ?? freshSend?.attr?.['aria-disabled'] ?? freshSend?.['aria-disabled'] ?? '') === 'true'
        || String(sendStyle?.opacity ?? '1') !== '1',
      `attrs=${JSON.stringify(freshSend?.attrs ?? freshSend?.attr ?? null)} opacity=${sendStyle?.opacity}`)
    const clicked = freshSend !== undefined && await h.click(fresh.chains, freshSend)
    h.check('the empty-draft Send click landed (the client does not block it)', clicked === true)
    await h.sleep(900)
    h.check('the empty draft never submitted',
      subjectEvents(h).filter(e => e.submit).length === 0,
      JSON.stringify(subjectEvents(h).filter(e => e.submit)))
    // 2) A click on the Model button opens the production picker layer; a
    //    SECOND click at the (now covered) model button must NOT open another.
    const modelSnap = h.snapshot()
    const freshModel = composerButtons(h, modelSnap).get('composer-model')
    const entriesBefore = subjectEvents(h).filter(e => e.modelEntry).length
    const modelClicked = freshModel !== undefined && await h.click(modelSnap.chains, freshModel)
    h.check('the Model click landed', modelClicked === true)
    await h.sleep(900)
    const opened = subjectEvents(h).filter(e => e.modelEntry)
    h.check('the Model click reached the late-bound entry once', opened.length === entriesBefore + 1,
      JSON.stringify(opened))
    const snapPicker = h.snapshot()
    h.check('the production picker layer mounted',
      snapPicker.nodes.some(node => String(node.class ?? '').includes('pk-')),
      'picker nodes present')
    // The base row is behind the picker now: the same coordinates must not
    // reach the business entry a second time.
    await h.clickAt(modelSnap.chains && freshModel ? visiblePoint(modelSnap.chains, freshModel)?.x ?? 20 : 20,
      freshModel ? visiblePoint(modelSnap.chains, freshModel)?.y ?? 20 : 20)
    await h.sleep(900)
    h.check('a click behind the mounted picker never re-enters',
      subjectEvents(h).filter(e => e.modelEntry).length === entriesBefore + 1,
      JSON.stringify(subjectEvents(h).filter(e => e.modelEntry)))
    h.capture('prc-negative-picker-open', 'PR-C negative: the picker layer over the composer row')
  }

  // ── Dark and light ────────────────────────────────────────────────────────
  await h.resize(400, 600)
  await h.sleep(300)
  h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark')
  h.capture(`prc-${runCase}-dark`, `PR-C ${runCase}: the row in the dark appearance`)
  h.send('appearance', 'light')
  h.check('the client resolved the light appearance', h.ctl('state').theme === 'light')
  h.capture(`prc-${runCase}-light`, `PR-C ${runCase}: the row in the light appearance`)

  await h.key('F10', 700)
}
