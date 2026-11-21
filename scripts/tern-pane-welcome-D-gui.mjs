/**
 * TSP-7 Welcome D: the real Tern GUI window lane.
 *
 * The same production subject as the headless lane, launched into a REAL native
 * Tern GUI window on a real display (`DISPLAY=:0` here). The GUI runtime is a
 * different client build than the headless server, so this lane re-proves the
 * claims whose MEANING depends on the client: the eight cells still lay out,
 * the mascot still paints inside the stage, and a control-injected pointer click
 * on the Welcome action still reaches the production Session Browser exactly
 * once with the draft intact afterwards.
 *
 * Evidence tier: `REAL_TERN_GUI + CONTROL_INJECTED_INPUT`. It is NOT
 * `OS_INPUT_VERIFIED`: no physical keyboard/mouse and no OS screen reader is
 * exercised, and the real OS light/dark appearance and custom fonts are
 * `NOT_VERIFIED` unless the run environment says otherwise.
 *
 * Run:
 *   DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-pane-welcome-D-gui.mjs
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
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

const flattenSpace = (value) => value.replace(/\s+/gu, ' ').trim()

function paintedMascot(snap, assets) {
  if (assets === undefined) return { index: undefined, matched: false }
  const live = snap.nodes.filter(visible)
  for (const [index, variant] of assets.variants.entries()) {
    const wanted = variant.map(flattenSpace).filter(Boolean)
    const container = live.find(node => {
      const own = descendantText(node).map(flattenSpace).filter(Boolean)
      return own.length === wanted.length && wanted.every(row => own.includes(row))
    })
    if (container === undefined) continue
    return { index, matched: true, container, rows: variant.length }
  }
  return { index: undefined, matched: false }
}

export default async function (h) {
  const system = h.ctl('system')
  h.check('the lane runs in a real native GUI window on a real display',
    (system.displays ?? []).length > 0 && typeof system.title === 'string',
    JSON.stringify({ title: system.title, displays: system.displays }))
  // A real window clamps narrow sizes, so the clamp is REPORTED, not failed: the
  // narrow-cell claims below are measured against the viewport the client
  // really took, and a clamped cell says so.
  const requested = await h.resize(CELLS[0].width, CELLS[0].height)
  h.measure('window size', JSON.stringify(requested))

  const subject = join(h.repo, 'scripts', 'tern-pane-welcome-D-ux-subject.mts')
  const testCase = process.env.DSH_TSP7_WELCD_CASE ?? 'idle'
  writeFileSync(join(h.root, 'case'), `${testCase}\n`)
  // The GUI driver pastes the launch into the FOCUSED pane, so the subject runs
  // through a wrapper script — the documented GUI launch contract.
  const booted = await h.launch(subject, { ready: 'dsh-pi-tui' })
  h.check(`the production Welcome D "${testCase}" subject boots inside the real GUI window`, booted)
  if (!booted) {
    h.measure('subject stderr', existsSync(join(h.root, 'subject.err'))
      ? readFileSync(join(h.root, 'subject.err'), 'utf8').slice(0, 600) : 'no stderr file')
    return
  }
  const assets = whaleAssets(h)
  h.measure('client build', `${system.title ?? 'tern'} :: ${system.os ?? 'os unstated'}`)

  for (const cell of CELLS) {
    for (const appearance of APPEARANCES) {
      const size = await h.resize(cell.width, cell.height)
      await h.send('plugins run appearance:' + appearance)
      await h.sleep(700)
      const viewport = size.viewport ?? []
      const cellId = `${cell.width}x${cell.height}-${appearance}`
      // A clamped cell is measured as the size the client REALLY took.
      const effective = { width: viewport[0] ?? cell.width, height: viewport[1] ?? cell.height }
      h.measure(`cell ${cellId}`, JSON.stringify({ requested: size.requested, viewport, clamped: size.clamped }))
      const snap = h.snapshot()
      const texts = liveTexts(snap)
      const resume = resumeButton(snap)
      const name = texts.find(text => text === 'dsh-pi-tui')
      const version = texts.find(text => text.includes("DeepSeek Harness"))
      const tip = texts.find(text => text.startsWith('Tip:'))
      const editors = editorNodes(snap).filter(visible)
      if (testCase === 'turn') {
        h.check(`${cellId}: the started subject owns the main region`, resume === undefined, JSON.stringify(texts.slice(0, 8)))
        h.capture(`gui-turn-${cellId}`, `${cellId} transcript`)
        continue
      }
      h.check(`${cellId}: the Welcome owns the main region (name, ONE action, ONE editor)`,
        name !== undefined && resume !== undefined && editors.length === 1,
        `name=${name !== undefined} resume=${resume !== undefined} editors=${editors.length}`)
      h.check(`${cellId}: the version line states the committed TUI version`, String(version).startsWith('v9.7.6-welcome-D · '),
        String(version))
      h.check(`${cellId}: no Session id or retired welcome line is painted`,
        !texts.some(text => /DSH session|session-[A-Za-z0-9_-]{4,}/u.test(text)),
        JSON.stringify(texts.filter(text => text.includes('session'))))
      h.check(`${cellId}: the Tip ${effective.height <= SHORT_HEIGHT ? 'is hidden' : 'is visible'} by the frozen height rule`,
        effective.height <= SHORT_HEIGHT ? tip === undefined : tip !== undefined,
        `effectiveHeight=${effective.height} tip=${String(tip)}`)
      if (resume !== undefined) {
        const box = boxOf(resume)
        const pane = paneBox(snap, effective)
        h.check(`${cellId}: the action is painted whole inside the visible pane`,
          box.w >= 60 && box.h >= 14 && box.x >= pane.x - TOLERANCE_PX && box.right <= pane.right + TOLERANCE_PX
          && box.bottom <= pane.bottom + TOLERANCE_PX,
          JSON.stringify({ resume: box, pane }))
      }
      const mascot = paintedMascot(snap, assets)
      if (mascot.matched) {
        const whale = boxOf(mascot.container)
        h.check(`${cellId}: mascot variant ${mascot.index} paints inside its stage`,
          whale.w > 0 && whale.w <= (paneBox(snap, effective).w + TOLERANCE_PX),
          JSON.stringify({ whale, stageWidth: paneBox(snap, effective).w }))
        h.measure(`gui mascot ${cellId}`, `variant=${mascot.index} box=${whale.w}x${whale.h}`)
      } else {
        h.check(`${cellId}: the mascot is painted from the shared asset`, false, JSON.stringify(texts.slice(0, 10)))
      }
      h.capture(`gui-${cellId}`, `${cellId} Welcome D in the real GUI window`)
    }
  }

  // The pointer positive control on the real window.
  await h.resize(1280, 800)
  await h.send('plugins run appearance:dark')
  await h.sleep(700)
  const snap = h.snapshot()
  const resume = resumeButton(snap)
  h.check('the action is present for the pointer control', resume !== undefined)
  if (resume !== undefined) {
    const draftBefore = (() => {
      const node = editorNodes(snap).find(visible)
      return node === undefined ? '' : (textOf(node) !== '' ? textOf(node) : descendantText(node).join('\n'))
    })()
    const clicked = await h.click(snap.chains, resume)
    h.check('a control-injected click lands on the action visible fragment', clicked)
    await h.sleep(1_400)
    const opened = h.snapshot()
    const opensAfter = countEvent(h, 'openSessionBrowser')
    h.check('the real GUI click reaches the registered Session Browser entry exactly once',
      opensAfter === 1, `reaches=${opensAfter}`)
    h.check('the production Browser presenter is painted in the real window',
      liveTexts(opened).some(text => text.includes('Welcome D resume target')),
      JSON.stringify(liveTexts(opened).slice(0, 16)))
    h.capture('gui-browser-open', 'the Session Browser opened by a real GUI click')
    await h.key('Escape', 1_000)
    const back = h.snapshot()
    h.check('Escape returns to the Welcome action in the real window', resumeButton(back) !== undefined)
    const draftAfter = (() => {
      const node = editorNodes(back).find(visible)
      return node === undefined ? '' : (textOf(node) !== '' ? textOf(node) : descendantText(node).join('\n'))
    })()
    h.check('the editor text survived the GUI round trip', draftAfter === draftBefore,
      JSON.stringify({ draftBefore, draftAfter }))
    h.capture('gui-after-escape', 'back on the Welcome after Escape')
  }

  // The client's own accessibility tree is a DIFFERENT projection than the node
  // tree: it is what a screen reader would be handed here.
  const a11y = h.ctl('a11y')
  h.measure('a11y node count', JSON.stringify(Array.isArray(a11y?.nodes) ? a11y.nodes.length : a11y))
  h.check('the action exposes an accessible name to the client accessibility tree',
    JSON.stringify(a11y ?? {}).includes('Resume session'),
    'the client a11y projection, not an OS screen reader (that path stays NOT_VERIFIED)')

  // The unrun evidence, stated rather than implied.
  h.measure('NOT_VERIFIED physical input', 'no physical keyboard/mouse was used; input is CONTROL_INJECTED_INPUT')
  h.measure('NOT_VERIFIED OS screen reader', 'a11y above is the client tree, not an OS screen-reader bridge')
  h.measure('NOT_VERIFIED OS appearance/fonts', 'appearance is the client theme; the OS dark mode and custom fonts were not exercised')
}
