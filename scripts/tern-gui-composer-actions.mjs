/**
 * TSP-7 PR-C real-GUI-window evidence flow: the composer action row.
 *
 *   DISPLAY=:0 TERN_GUI_SEED_AUTH=1 node scripts/tern-gui-drive.mjs \
 *     scripts/tern-gui-composer-actions.mjs
 *
 * The GUI lane adds what headless cannot: the real OS window, the desktop
 * font stack and the live-window appearance switch. Its pointer/key input is
 * still CONTROL_INJECTED (tern ctl), never OS physical input — the evidence
 * tier is REAL_TERN_GUI + CONTROL_INJECTED_INPUT, not OS_INPUT_VERIFIED.
 *
 * One CASE per run (`TERN_TSP7_PRC_CASE`, default `idle`), mirroring the
 * headless flow's cases. A REAL WINDOW HAS A MINIMUM WIDTH (measured ~720px
 * on this build), so the 400/260px panes are HEADLESS-only questions: this
 * flow covers the wide window, the dark/light LIVE appearance switch and the
 * click results.
 * @module scripts/tern-gui-composer-actions
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, visibleBox, visiblePoint } from './tern-pane-geometry.mjs'

function subjectEvents(h) {
  return readFileSync(join(h.root, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

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

const label = (h, node) => node === undefined ? '' : String(node.text ?? '')

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
    if (distance < bestDistance) { bestDistance = distance; best = element }
  }
  return best
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-composer-actions-subject.mts')
  const testCase = process.env.TERN_TSP7_PRC_CASE ?? 'idle'
  // The window's launch does not forward the driver env: the case travels
  // through the run directory's `case` file (the subject reads it first).
  writeFileSync(join(h.root, 'case'), `${testCase}\n`)

  const system = h.ctl('system')
  h.check('the window is a real native window', (system.displays ?? []).length > 0,
    JSON.stringify(system.displays))

  await h.resize(1280, 800)
  const booted = await h.launch(subject, { ready: `composer-actions ${testCase}` })
  h.check(`the PR-C ${testCase} subject boots in the GUI window`, booted)
  if (!booted) return

  let snap = h.snapshot()
  let buttons = composerButtons(h, snap)
  const expected = testCase === 'busy'
    ? ['composer-effort', 'composer-model', 'composer-send', 'composer-stop']
    : ['composer-effort', 'composer-model', 'composer-send']
  h.check('the row mounts every expected button in the real window',
    [...buttons.keys()].sort().join(',') === expected.sort().join(','),
    JSON.stringify([...buttons.keys()]))

  const model = buttons.get('composer-model')
  const send = buttons.get('composer-send')
  const stop = buttons.get('composer-stop')
  const modelStyle = await styleOf(h, model)
  const sendStyle = await styleOf(h, send)
  h.measure('gui-model-style', JSON.stringify(modelStyle && {
    rect: modelStyle.rect, color: modelStyle.color, bg: modelStyle.backgroundColor,
    fw: modelStyle.fontWeight, font: modelStyle.fontFamily,
  }))
  h.measure('gui-send-style', JSON.stringify(sendStyle && {
    rect: sendStyle.rect, color: sendStyle.color, bg: sendStyle.backgroundColor,
    fw: sendStyle.fontWeight, opacity: sendStyle.opacity,
  }))
  h.check('the scoped sheet paints the button chrome in the real window (background)',
    String(modelStyle?.backgroundColor ?? '') !== '' && String(modelStyle?.backgroundColor ?? 'transparent') !== 'rgba(0, 0, 0, 0)',
    String(modelStyle?.backgroundColor ?? ''))
  const sendDisabled = Number(sendStyle?.opacity ?? 1) < 1
  h.check('the PRIMARY (Send) is distinguishable (bolder weight, or the disabled mute)',
    Number(sendStyle?.fontWeight ?? 0) > Number(modelStyle?.fontWeight ?? 0) || sendDisabled,
    `model=${modelStyle?.backgroundColor}/${modelStyle?.fontWeight} send=${sendStyle?.backgroundColor}/${sendStyle?.fontWeight}/${sendStyle?.opacity}`)

  if (testCase === 'idle') {
    h.check('Model carries the bounded value in the GUI window', label(h, model).includes('luna-fast'), label(h, model))
    h.check('Effort carries the configured effort', label(h, buttons.get('composer-effort')).includes('high'),
      label(h, buttons.get('composer-effort')))
  }
  if (testCase === 'busy') {
    h.check('Send is NOT replaced by Stop in the GUI window', buttons.has('composer-send'))
    h.check('Stop coexists with Send', stop !== undefined)
  }

  h.check('every button is fully inside its clipping ancestors at 1280x800',
    [...buttons.values()].every(node => containedXY(snap.chains, node)),
    [...buttons.values()].map(node => JSON.stringify(visibleBox(snap.chains, node))).join(' '))
  h.capture(`prc-gui-${testCase}-1280x800`, `PR-C GUI ${testCase}: the composer action row in the real window`)

  // ── Real clicks: the subject's own record is the positive control ────────
  if (testCase === 'busy' && send !== undefined && stop !== undefined) {
    await h.key('q', 200)
    await h.key('u', 100)
    await h.key('e', 100)
    await h.key('u', 100)
    await h.key('e', 100)
    await h.key('d', 500)
    const typedSnap = h.snapshot()
    const typedSend = composerButtons(h, typedSnap).get('composer-send')
    const before = subjectEvents(h).filter(e => e.submit).length
    const clicked = typedSend !== undefined && await h.click(typedSnap.chains, typedSend)
    h.check('the GUI Send click landed on the visible button', clicked === true)
    await h.sleep(900)
    const submits = subjectEvents(h).filter(e => e.submit)
    h.check('the GUI Send click submitted exactly once', submits.length === before + 1,
      JSON.stringify(submits))
    h.check('the submitted text is the typed draft', submits.at(-1)?.submit?.text === 'queued',
      JSON.stringify(submits.at(-1)))

    const stopSnap = h.snapshot()
    const typedStop = composerButtons(h, stopSnap).get('composer-stop')
    const cancelsBefore = subjectEvents(h).filter(e => e.cancel).length
    const stopClicked = typedStop !== undefined && await h.click(stopSnap.chains, typedStop)
    h.check('the GUI Stop click landed on the visible button', stopClicked === true)
    await h.sleep(900)
    const cancels = subjectEvents(h).filter(e => e.cancel)
    h.check('the GUI Stop click cancelled exactly once', cancels.length === cancelsBefore + 1,
      JSON.stringify(cancels))
  }

  if (testCase === 'negative') {
    const fresh = h.snapshot()
    const freshSend = composerButtons(h, fresh).get('composer-send')
    const clicked = freshSend !== undefined && await h.click(fresh.chains, freshSend)
    h.check('the empty-draft Send click landed (the client does not block it)', clicked === true)
    await h.sleep(900)
    h.check('the empty draft never submitted in the GUI window',
      subjectEvents(h).filter(e => e.submit).length === 0,
      JSON.stringify(subjectEvents(h).filter(e => e.submit)))
  }

  // ── The LIVE appearance switch (the GUI lane's own capability) ───────────
  h.send('plugins', 'run', 'appearance:dark')
  h.check('the live window resolved the dark appearance', h.ctl('state').theme === 'dark')
  h.capture(`prc-gui-${testCase}-dark`, `PR-C GUI ${testCase}: the row in the live dark appearance`)
  h.send('plugins', 'run', 'appearance:light')
  h.check('the live window resolved the light appearance', h.ctl('state').theme === 'light')
  h.capture(`prc-gui-${testCase}-light`, `PR-C GUI ${testCase}: the row in the live light appearance`)

  await h.key('F10', 700)
}
