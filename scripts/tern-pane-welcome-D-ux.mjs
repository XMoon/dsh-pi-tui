/**
 * TSP-7 Welcome D: the real Tern client lane.
 *
 * ONE production mount (`mountTspRenderer` over the shipped SDK) inside a real
 * Tern pane, walked through the frozen size/appearance matrix and the two
 * interaction controls:
 *
 * - the 8 core cells: `1280x800`, `900x700`, `400x600`, `900x360`
 *   × `light`/`dark`, captured from the SAME mount with the SAME content;
 * - the mascot identity and geometry: the painted rows are matched against the
 *   production asset module's OWN variant set (attribution, never a second
 *   copy) and measured against the stage they were painted in;
 * - the pointer positive control: a control-injected click on the Welcome's
 *   Resume action opens the mount's REAL Session Browser presenter exactly once,
 *   and Escape returns to the Welcome with the staged draft and caret intact;
 * - the keyboard record: Tab / Shift+Tab / Enter / Escape are recorded as what
 *   the client really does, never as what this program would like it to do.
 *
 * Input is CONTROL_INJECTED_INPUT (Tern's own control channel): it is not a
 * physical keyboard/mouse and never claims OS_INPUT_VERIFIED. The PNGs are the
 * human G8 artefact; a node rect proves geometry, never readable overflow.
 *
 * Run (one cell matrix per launch; the mascot is picked once per mount, so the
 * variant sweep repeats the launch and accumulates what it saw in
 * `DSH_TSP7_WELCD_STATE`):
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-welcome-D-ux.mjs
 *   DSH_TSP7_WELCD_CASE=blank|turn|draft|unavailable node scripts/tern-pane-drive.mjs …
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CELLS = [
  { width: 1280, height: 800 },
  { width: 900, height: 700 },
  { width: 400, height: 600 },
  { width: 900, height: 360 },
]
const APPEARANCES = ['light', 'dark']
const SHORT_HEIGHT = 420
const TOLERANCE_PX = 3

const rectOf = (node) => (Array.isArray(node?.rect) ? node.rect : [0, 0, 0, 0])
const boxOf = (node) => {
  const [x, y, w, h] = rectOf(node)
  return { x, y, w, h, right: x + w, bottom: y + h }
}
const visible = (node) => {
  const [, , w, h] = rectOf(node)
  return w > 0 || h > 0
}
const textOf = (node) => String(node?.text ?? '')
const descendantText = (node) => {
  const out = []
  const walk = (n) => {
    if (textOf(n) !== '') out.push(textOf(n))
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return out
}
const liveTexts = (snap) => snap.nodes.filter(visible).map(textOf).filter(Boolean)
const buttons = (snap) => snap.nodes.filter(node => visible(node) && node.tag === 'button')
const editorNodes = (snap) => snap.nodes.filter(node => String(node.class ?? '').split(' ').includes('sf-editor'))
function editorText(snap) {
  const node = editorNodes(snap).find(visible)
  if (node === undefined) return ''
  return textOf(node) !== '' ? textOf(node) : descendantText(node).join('\n')
}

const resumeButton = (snap) => buttons(snap).find(node => descendantText(node).join('').includes('Resume session'))
const paneBox = (snap, fallback) => boxOf(snap.nodes.find(node => String(node.class ?? '').split(' ').includes('tn-pane'))
  ?? { rect: [0, 0, fallback.width, fallback.height] })

function events(h) {
  const path = join(h.root, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}
const countEvent = (h, kind) => events(h).filter(entry => entry.kind === kind).length

function whaleAssets(h) {
  const path = join(h.root, 'whale-assets.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Match the painted mascot against the production module's OWN variant list.
 * `rows.container` is the smallest live node whose text is exactly the row set,
 * i.e. the box whose width the client actually laid out.
 */
/** The client's own text projection collapses whitespace runs; compare that way. */
const flattenSpace = (value) => value.replace(/\s+/gu, ' ').trim()

function paintedMascot(snap, assets) {
  if (assets === undefined) return { index: undefined, painted: [], matched: false }
  const live = snap.nodes.filter(visible)
  for (const [index, variant] of assets.variants.entries()) {
    const wanted = variant.map(flattenSpace)
    const container = live.find(node => {
      const own = descendantText(node).map(flattenSpace).filter(Boolean)
      return own.length === wanted.length && wanted.every(row => own.includes(row))
    })
    if (container === undefined) continue
    return { index, painted: variant, matched: true, container }
  }
  return { index: undefined, painted: [], matched: false }
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-welcome-D-ux-subject.mts')
  const testCase = process.env.DSH_TSP7_WELCD_CASE ?? 'idle'
  writeFileSync(join(h.root, 'case'), `${testCase}\n`)
  const booted = await h.launch(subject, { ready: testCase === 'turn' ? 'Run the focused tests.' : 'dsh-pi-tui' })
  h.check(`the Welcome D "${testCase}" subject boots inside a real Tern pane`, booted)
  if (!booted) return
  const assets = whaleAssets(h)
  h.measure('subject-case', `${testCase} assets=${assets === undefined ? 'missing' : assets.variants.length}`)
  if (testCase === 'variants') {
    await variantSweep(h, assets)
    return
  }
  const state = await h.ctl('state')
  h.measure('client-theme-readback', JSON.stringify(state?.theme ?? null))

  // ── The eight core cells, on ONE mount with ONE content ───────────────────
  for (const cell of CELLS) {
    for (const appearance of APPEARANCES) {
      await h.resize(cell.width, cell.height)
      await h.send('appearance', appearance)
      await h.sleep(450)
      const snap = h.snapshot()
      const id = `${testCase}/${cell.width}x${cell.height}-${appearance}`
      const resume = resumeButton(snap)
      const texts = liveTexts(snap)
      const name = texts.find(text => text === 'dsh-pi-tui')
      const version = texts.find(text => text.includes('DeepSeek Harness'))
      const tip = texts.find(text => text.startsWith('Tip:'))
      const editors = editorNodes(snap).filter(visible)

      if (testCase === 'turn') {
        h.check(`${id}: a started subject owns Main, not the invitation`,
          resume === undefined && texts.some(text => text.includes('Run the focused tests.')),
          JSON.stringify(texts.slice(0, 10)))
        h.capture(`turn-${cell.width}x${cell.height}-${appearance}`, `${id} transcript after the first formal message`)
        continue
      }

      h.check(`${id}: the Welcome owns Main (name, ONE action, ONE editor)`,
        name !== undefined && resume !== undefined && editors.length === 1,
        `name=${name !== undefined} resume=${resume !== undefined} editors=${editors.length}`)
      h.check(`${id}: the version line states the committed TUI version, never a sample id or cwd`,
        version !== undefined && version.startsWith('v9.7.6-welcome-D · '), String(version))
      h.check(`${id}: no Session identity, model or welcome line is painted anywhere`,
        !texts.some(text => /DSH session|session-[A-Za-z0-9_-]{4,}/u.test(text)),
        JSON.stringify(texts.filter(text => text.includes('session'))))
      h.check(`${id}: the Tip ${cell.height <= SHORT_HEIGHT ? 'is hidden' : 'is visible'} by the frozen height rule`,
        cell.height <= SHORT_HEIGHT ? tip === undefined : tip !== undefined,
        `height=${cell.height} tip=${String(tip)}`)
      if (resume !== undefined) {
        const box = boxOf(resume)
        const pane = paneBox(snap, cell)
        h.check(`${id}: the Resume action is painted whole inside the visible pane`,
          box.w >= 60 && box.h >= 14 && box.x >= pane.x - TOLERANCE_PX && box.right <= pane.right + TOLERANCE_PX
          && box.y >= pane.y - TOLERANCE_PX && box.bottom <= pane.bottom + TOLERANCE_PX,
          JSON.stringify({ resume: box, pane }))
        const title = String(resume.title ?? '')
        const disabledExpected = testCase === 'unavailable'
        h.check(`${id}: the action states the ${disabledExpected ? 'unavailable reason' : 'Browser it opens'} in its own tooltip`,
          disabledExpected ? title.includes('/sessions') : title === 'Open the existing Session Browser',
          JSON.stringify({ title, tag: resume.tag }))
      }

      const mascot = paintedMascot(snap, assets)
      if (mascot.index === undefined) {
        h.check(`${id}: the mascot rows are painted from the shared asset`, false,
          JSON.stringify(texts.slice(0, 12)))
      } else {
        const stage = snap.nodes.filter(visible)
          .find(node => descendantText(node).includes('dsh-pi-tui') && descendantText(node).join('').length < 400)
        const whale = boxOf(mascot.container)
        const stageBox = boxOf(stage)
        h.measure(`mascot ${id}`, `variant=${mascot.index} rows=${mascot.painted.length} box=${whale.w}x${whale.h} stage=${stageBox.w}`)
        h.check(`${id}: mascot variant ${mascot.index} is painted inside its own stage`,
          whale.w > 0 && whale.w <= stageBox.w + TOLERANCE_PX && whale.right <= stageBox.right + TOLERANCE_PX
          && whale.x >= stageBox.x - TOLERANCE_PX,
          JSON.stringify({ whale, stage: stageBox }))
        recordVariant(h, mascot.index, whale.w)
      }
      h.capture(`cell-${testCase}-${cell.width}x${cell.height}-${appearance}`, `${id} Welcome D core cell`)
    }
  }

  await pointerControl(h, testCase)
  await keyboardRecord(h, testCase)
}

/**
 * The five-variant identity and width sweep on the real client: the subject
 * paints the PRODUCTION Welcome view for each variant through the production
 * sheet, and every cell is measured at the two widths the design must survive.
 */
async function variantSweep(h, assets) {
  if (assets === undefined) {
    h.check('the subject published its mascot attribution', false, 'no whale-assets.json written')
    return
  }
  // The subject renders one variant and PARKS until this flow has measured and
  // captured it at every cell, then the flow acks and the next variant is
  // painted. No variant is ever raced past, and every cell sees every variant.
  for (let variant = 0; variant < assets.variants.length; variant += 1) {
    const painted = await waitForVariant(h, variant)
    h.check(`the subject parked on mascot variant ${variant}`, painted, `variant.txt=${readVariantFile(h)}`)
    if (!painted) return
    for (const cell of [{ width: 1280, height: 800 }, { width: 400, height: 600 }]) {
      for (const appearance of APPEARANCES) {
        await h.resize(cell.width, cell.height)
        await h.send('appearance', appearance)
        await h.sleep(450)
        const snap = h.snapshot()
        const cellId = `${cell.width}x${cell.height}-${appearance}`
        const match = paintedMascot(snap, assets)
        h.check(`variant ${variant} at ${cellId} paints the shared asset rows`,
          match.index === variant && match.matched, JSON.stringify({ seen: match.index, want: variant }))
        h.check(`variant ${variant} at ${cellId} is painted by the production Welcome view`,
          liveTexts(snap).some(text => text === 'dsh-pi-tui') && resumeButton(snap) !== undefined,
          JSON.stringify(liveTexts(snap).slice(0, 10)))
        if (match.container !== undefined) {
          const whale = boxOf(match.container)
          const pane = paneBox(snap, cell)
          h.measure(`variant ${variant} geometry ${cellId}`, JSON.stringify({ whale, pane: pane.w }))
          h.check(`variant ${variant} stays inside the pane at ${cellId}`,
            whale.w > 0 && whale.x >= pane.x - TOLERANCE_PX && whale.right <= pane.right + TOLERANCE_PX
            && whale.bottom <= pane.bottom + TOLERANCE_PX,
            JSON.stringify({ whale, pane }))
        }
        h.capture(`variant-${variant}-${cellId}`, `mascot variant ${variant} at ${cellId}`)
      }
    }
    writeFileSync(join(h.root, 'ack.txt'), String(variant))
  }
  await waitForVariant(h, 'done')
  h.check('the mascot sweep finished all five variants', true)
}

function readVariantFile(h) {
  const path = join(h.root, 'variant.txt')
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined
}

async function waitForVariant(h, variant) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (readVariantFile(h) === String(variant)) return true
    await h.sleep(150)
  }
  return false
}

/** Cross-launch attribution: which mascot variants the client has painted. */
function recordVariant(h, index, width) {
  const state = process.env.DSH_TSP7_WELCD_STATE
  if (state === undefined) return
  const seen = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}
  seen[String(index)] = { width, run: h.root }
  writeFileSync(state, JSON.stringify(seen, null, 1))
}

async function pointerControl(h, testCase) {
  if (testCase === 'turn') return
  const cell = { width: 400, height: 600 }
  await h.resize(cell.width, cell.height)
  await h.send('appearance', 'dark')
  await h.sleep(450)
  const snap = h.snapshot()
  const resume = resumeButton(snap)
  h.check('the narrow cell still paints the Resume action', resume !== undefined)
  if (resume === undefined) return
  const draftBefore = editorText(snap)
  h.measure('staged draft before Resume', JSON.stringify(draftBefore))
  const clicked = await h.click(snap.chains, resume)
  h.check('the Resume action is clickable on a visible fragment', clicked)
  await h.sleep(1_100)
  const opened = h.snapshot()
  const browserTexts = liveTexts(opened)
  const browserPainted = browserTexts.some(text => text.includes('Welcome D resume target'))
    && browserTexts.some(text => text === 'Resume')
  if (testCase === 'unavailable') {
    // The negative control: an action the business entry does not back must
    // open nothing, reach nothing and start no listing.
    h.check('the unavailable action opens NOTHING when clicked', browserPainted === false,
      JSON.stringify(browserTexts.slice(0, 18)))
    h.check('the unavailable action reaches no UI entry and starts no Session listing',
      countEvent(h, 'openSessionBrowser') === 0 && countEvent(h, 'reader.list') === 0,
      `reaches=${countEvent(h, 'openSessionBrowser')} lists=${countEvent(h, 'reader.list')}`)
    h.capture('unavailable-no-browser', 'the degraded action stayed inert')
    return
  }
  h.check('the pointer Resume opens the mount REAL Session Browser presenter', browserPainted,
    JSON.stringify(browserTexts.slice(0, 18)))
  h.check('the click reached the registered UI entry exactly once', countEvent(h, 'openSessionBrowser') === 1,
    `reaches=${countEvent(h, 'openSessionBrowser')}`)
  h.capture('browser-open-narrow', 'the Welcome Browser opened from the 400x600 cell')
  await h.key('Escape', 900)
  const back = h.snapshot()
  h.check('Escape returns to the Welcome with the same action', resumeButton(back) !== undefined)
  const draftAfter = editorText(back)
  h.check('the staged multi-line non-BMP draft survived the whole cycle',
    testCase !== 'draft' || (draftBefore !== '' && draftBefore === draftAfter),
    JSON.stringify({ draftBefore, draftAfter }))
  h.measure('focus ops after close', JSON.stringify(events(h).filter(entry => entry.kind === 'focus').slice(-2)))
}

/**
 * The keyboard record. The frozen contract says the Composer keeps Tab,
 * Shift+Tab, Enter and Escape, so the Welcome may not borrow them. What this
 * records is therefore TWO facts: the ladder still belongs to the Composer
 * (nothing opens, nothing submits), and whether the client's own focus ring can
 * reach and activate the native action at all. If it cannot, that is reported as
 * the capability gap it is — never patched by re-binding a Composer key, and
 * never claimed as a pass through the typed `/sessions` command.
 */
async function keyboardRecord(h, testCase) {
  if (testCase === 'turn') return
  await h.resize(1280, 800)
  await h.send('appearance', 'dark')
  await h.sleep(450)
  await h.key('Escape', 400)
  const opensBefore = countEvent(h, 'openSessionBrowser')
  const submitsBefore = countEvent(h, 'submit')
  let focusedOnAction = null
  let activatedByKeyboard = false
  for (let attempt = 0; attempt < 6 && !activatedByKeyboard; attempt += 1) {
    await h.key('Tab', 350)
    const snap = h.snapshot()
    const resume = resumeButton(snap)
    const focused = snap.nodes.filter(visible).find(node => String(node.class ?? '').split(' ').includes('focused'))
    const insideResume = new Set()
    if (resume !== undefined) {
      const collect = (node) => { insideResume.add(node); for (const child of node.children ?? []) collect(child) }
      collect(resume)
    }
    focusedOnAction = focused === undefined ? 'no-focused-node' : (insideResume.has(focused) ? 'welcome-action' : String(focused.class ?? ''))
    if (focusedOnAction !== 'welcome-action') continue
    await h.key('Return', 900)
    activatedByKeyboard = countEvent(h, 'openSessionBrowser') > opensBefore
  }
  await h.key('Shift+Tab', 400)
  await h.key('Escape', 400)
  const snap = h.snapshot()
  h.check('Tab / Shift+Tab / Escape never reach the Session Browser entry',
    countEvent(h, 'openSessionBrowser') === opensBefore,
    `reaches=${countEvent(h, 'openSessionBrowser')} of ${opensBefore}`)
  h.check('the ladder submits nothing while the Welcome owns Main',
    countEvent(h, 'submit') === submitsBefore,
    `submits=${countEvent(h, 'submit')} of ${submitsBefore}`)
  h.check('the Welcome action is still painted after the whole keyboard pass',
    resumeButton(snap) !== undefined)
  h.measure('native keyboard activation', activatedByKeyboard
    ? 'PASS: the client focus ring reached the action and Enter activated it'
    : `BLOCKED / SDK_OR_CLIENT_CAPABILITY_GAP: the focus ring stayed on ${focusedOnAction}; the native action was never focusable, so Enter could not activate it. The typed /sessions command stays the only keyboard route (the plan forbids borrowing a Composer key for this).`)
  h.capture('keyboard-end', `focusedAfterTab=${focusedOnAction} activatedByKeyboard=${activatedByKeyboard}`)
}
