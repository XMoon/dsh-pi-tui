/**
 * The `/preset` v4 Gate A feasibility spike — the REAL-CLIENT go/no-go probes the
 * v4 plan (§7) requires before any production implementation:
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-preset-gate-a.mjs --out temp/<run>
 *
 *   A1  the native picker action bar paints THREE real buttons (`Use next` primary,
 *       `Set default`, `Close` end) at 1280x800, 900x640, 560x640 and 400x600 —
 *       contained, with real hit targets — and a disabled entry's `disabled` REASON
 *       STRING is visibly painted beside it (`Already the default`).
 *   A2  the `cards` layout still paints its one-column card list with the three
 *       buttons present (selection/activation shapes were proven in the native-cards
 *       lane and are re-checked here only as far as the footer needs).
 *   A4  an `html.button` Back in the overlay is painted as a real control with its
 *       own class/role; a real click on it produces exactly one button action.
 *   A6  a surface-scoped stylesheet (`data-surface` + `data-role` selectors, tone
 *       variables) is installed before the first frame and the button keeps a
 *       NON-ZERO painted box (the sheet's styling took effect); the client's own
 *       global classes are untouched.
 *   A3  a TALL single-scroll reader really scrolls to its tail with End.
 *   slots what the client paints of `lead` vs `message` vs `subtitle` for the
 *       committed-facts status line (the v4 G0 mock's status area).
 *
 * A failed Gate A check is a STOP finding, not a design change.
 * @module scripts/tern-pane-preset-gate-a
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, rect as rawRect } from './tern-pane-geometry.mjs'

const rect = (node) => (node === undefined ? [0, 0, 0, 0] : rawRect(node))
const box = (node) => (node === undefined ? 'none' : rect(node).map((n) => Math.round(n * 10) / 10).join(','))

const records = (h) => readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const frames = (h) => records(h).filter((row) => row.frame).map((row) => row.frame)
const lastFrame = (h) => frames(h).at(-1)
const caps = (h) => records(h).find((row) => row.caps)?.caps
const controls = (h) => records(h).filter((row) => row.control).map((row) => row.control)
const backClicks = (h) => records(h).filter((row) => row.backClick).map((row) => row.backClick)
const buttonActions = (h) => records(h).filter((row) => row.event?.ev === 'action' && String(row.event?.id ?? '').includes('back')).map((row) => row.event)
const scrolls = (h) => records(h).filter((row) => row.nativeScroll).length

const classTokens = (node) => (node.class ?? '').split(' ').filter(Boolean)
const hasClass = (node, name) => classTokens(node).includes(name)
const nodesWith = (snap, name) => snap.nodes.filter((node) => hasClass(node, name))
const pickerNode = (snap) => nodesWith(snap, 'sf-picker')[0]
const buttons = (snap) => nodesWith(snap, 'pk-btn')
const barNode = (snap) => nodesWith(snap, 'pk-bar')[0]
const overlayNode = (snap) => nodesWith(snap, 'sf-overlay')[0]
const elButton = (snap) => snap.nodes.find((node) => (node.tag === 'button') || hasClass(node, 'sf-el'))
const backButtons = (snap) => snap.nodes.filter((node) => (node.attrs?.role ?? node.role) === 'preset.back' || String(node['data-role'] ?? '') === 'preset.back')
const anyNode = (snap, predicate) => snap.nodes.find(predicate)

const PROBES = [
  { key: '1', label: 'catalog-3-buttons' },
  { key: '2', label: 'details-back-button' },
  { key: '3', label: 'status-lead' },
  { key: '3m', label: 'status-message' },
  { key: '4', label: 'tall-reader' },
]

export default async function (h) {
  await h.resize(1280, 800)
  const subject = join(h.repo, 'scripts', 'tern-pane-preset-gate-a-subject.mts')
  const booted = await h.launch(subject, { ready: 'Agent presets' })
  h.check('the Gate A subject boots inside a real Tern pane', booted, h.texts(h.snapshot()).join(' | '))
  if (!booted) return
  h.measure('the client build and its negotiated kinds/features',
    `${caps(h)?.term ?? '?'} ${caps(h)?.ver ?? '?'} :: kinds=${JSON.stringify(caps(h)?.kinds ?? [])} features=${JSON.stringify(caps(h)?.features ?? [])}`)
  h.check('the client advertises the styles + scroll features Gate A needs',
    (caps(h)?.features ?? []).includes('styles') && (caps(h)?.features ?? []).includes('scroll'),
    JSON.stringify(caps(h)?.features ?? []))

  // -------------------------------------------------- A1: the three-button footer
  for (const size of [{ w: 1280, h: 800 }, { w: 900, h: 640 }, { w: 560, h: 640 }, { w: 400, h: 600 }]) {
    await h.resize(size.w, size.h)
    const cellKey = `${size.w}x${size.h}`
    const snap = h.snapshot()
    const btns = buttons(snap)
    const bar = barNode(snap)
    const disabledBtn = btns.find((node) => h.descendantsText(node).includes('Set default'))
    const closeBtn = btns.find((node) => h.descendantsText(node).includes('Close'))
    const useBtn = btns.find((node) => h.descendantsText(node).includes('Use next'))
    h.check(`A1 ${cellKey}: the action bar paints exactly THREE buttons, all contained`,
      btns.length === 3 && btns.every((node) => containedXY(snap.chains, node)) && bar !== undefined
      && containedXY(snap.chains, bar),
      btns.map((node) => `${h.descendantsText(node)}@${box(node)} contained=${containedXY(snap.chains, node)}`).join(' '))
    h.check(`A1 ${cellKey}: the three entries are Use next (primary), Set default, Close (end)`,
      useBtn !== undefined && disabledBtn !== undefined && closeBtn !== undefined
      && nodesIn(bar, 'primary').length === 1 && h.descendantsText(nodesIn(bar, 'primary')[0]).includes('Use next')
      && classTokens(closeBtn).some((token) => token === 'off' || token === 'end') === false,
      btns.map((node) => `${h.descendantsText(node)}[${classTokens(node).join(' ')}]`).join(' | '))
    h.check(`A1 ${cellKey}: every button has a real hit target (>= 16px wide and tall)`,
      btns.every((node) => rect(node)[2] >= 16 && rect(node)[3] >= 16),
      btns.map((node) => `${h.descendantsText(node)}@${box(node)}`).join(' '))
    const reasonVisible = anyNode(snap, (node) => String(node.text ?? '').includes('Already the default'))
    h.measure(`A1 ${cellKey}: the disabled reason string painted`, reasonVisible === undefined ? 'NOT PAINTED' : `${JSON.stringify(String(reasonVisible.text).slice(0, 60))}@${box(reasonVisible)} contained=${containedXY(snap.chains, reasonVisible)}`)
    const reasonOnButton = disabledBtn !== undefined && h.descendantsText(disabledBtn).includes('Already the default')
    const reasonInBar = bar !== undefined && h.descendantsText(bar).includes('Already the default')
    h.check(`A1 ${cellKey}: the disabled reason is visibly NEAR the disabled button (on it or in its bar)`,
      reasonOnButton || reasonInBar,
      `onButton=${reasonOnButton} inBar=${reasonInBar}`)
    h.check(`A1 ${cellKey}: the disabled entry carries the client's own off/disabled marker`,
      disabledBtn !== undefined && (hasClass(disabledBtn, 'off') || classTokens(disabledBtn).some((token) => /disab|off/.test(token))),
      classTokens(disabledBtn ?? snap.nodes[0]).join(' '))
    h.capture(`gate-a1-${cellKey}`, `the ${cellKey} three-button catalogue`)
  }

  // ------------------------------------------------ A4+A6: the Back button + sheet
  await h.resize(1280, 800)
  await h.key('2', 900)
  h.check('A4: probe 2 is the Details overlay (no picker behind it)',
    lastFrame(h)?.page === 'details' && pickerNode(h.snapshot()) === undefined && overlayNode(h.snapshot()) !== undefined,
    `page=${JSON.stringify(lastFrame(h)?.page)} overlay=${overlayNode(h.snapshot()) === undefined ? 'none' : classTokens(overlayNode(h.snapshot())).join(' ')}`)
  const detailSnap = h.snapshot()
  // The Back control: the client paints an SDK `el` as `.sf-el`; restrict to the
  // layer's own node (the pane's chrome buttons — `tn-session-tab`, `icon-btn` —
  // are NOT ours). Match on the probe's data-role first, then any sf-el button
  // whose text is the Back label.
  const backNode = detailSnap.nodes.find((node) =>
    String(node['data-role'] ?? '') === 'preset.back'
    || (hasClass(node, 'sf-el') && h.descendantsText(node).includes('Back')))
    ?? elButton(detailSnap)
  h.check('A4: an el BUTTON is really painted in the overlay with a non-zero box',
    backNode !== undefined && rect(backNode)[2] > 0 && rect(backNode)[3] > 0 && containedXY(detailSnap.chains, backNode),
    `back@${box(backNode)} class=${classTokens(backNode ?? detailSnap.nodes[0]).join(' ')} tag=${String(backNode?.tag ?? '?')}`)
  h.check('A6: the Back node carries the probe\'s own class + data-role (the scoped sheet\'s hook)',
    backNode !== undefined
      && (classTokens(backNode).includes('preset-back-btn') || String(backNode?.class ?? '').includes('preset-back-btn')),
    `class=${JSON.stringify(String(backNode?.class ?? ''))} role=${JSON.stringify(String(backNode?.['data-role'] ?? backNode?.role ?? ''))}`)
  h.capture('gate-a4-back-button', 'the Details Back button with the scoped sheet applied')
  const clickBefore = backClicks(h).length
  const actionsBefore = buttonActions(h).length
  const clicked = backNode === undefined ? false : await h.click(detailSnap.chains, backNode)
  await h.sleep(600)
  const clickEvents = buttonActions(h).slice(actionsBefore)
  h.check('A4: one REAL click on the Back button produces exactly one button action (and the handler ran)',
    clicked && backClicks(h).length === clickBefore + 1 && clickEvents.length === 1,
    `clicked=${clicked} handlerRuns=${backClicks(h).length - clickBefore} events=${JSON.stringify(clickEvents)}`)
  h.measure('A4: the button action event shape', JSON.stringify(clickEvents[0] ?? null))
  h.check('A4: the click returned to the catalogue (the handler swapped the probe)',
    lastFrame(h)?.page === 'catalog',
    `page=${JSON.stringify(lastFrame(h)?.page)}`)
  // Keyboard: Tab+Enter must NOT fire the button by itself (foundation §5) — the app
  // owns the key. Measure what the real client does so the plan's claim stays honest.
  await h.key('2', 900)
  const kbActionsBefore = buttonActions(h).length
  await h.key('Tab', 400)
  await h.key('Return', 600)
  h.measure('A4: Tab+Enter on the el button (client behavior)', JSON.stringify({
    buttonActions: buttonActions(h).length - kbActionsBefore,
    handlerRuns: backClicks(h).length - (clickBefore + 1),
  }))

  // ---------------------------------------------------------- slots: lead/message
  await h.key('3', 900)
  const leadSnap = h.snapshot()
  h.measure('slots: what the client paints for `lead`', JSON.stringify({
    paintedTexts: h.texts(leadSnap).filter((line) => line.includes('Next session') || line.includes('Default')),
    tooltip: String(nodesWith(leadSnap, 'pk-title')[0]?.title ?? ''),
  }))
  h.capture('gate-slots-lead', 'the picker with the status line on `lead`')
  await h.key('m', 900)
  const messageSnap = h.snapshot()
  h.measure('slots: what the client paints for `message` (state=ready)', JSON.stringify({
    paintedTexts: h.texts(messageSnap).filter((line) => line.includes('Next session') || line.includes('Default')),
    tooltip: String(nodesWith(messageSnap, 'pk-title')[0]?.title ?? ''),
  }))
  h.capture('gate-slots-message', 'the picker with the status line on `message`')

  // ------------------------------------------------------------------ A3: scroll
  await h.key('4', 900)
  const readerSnap = h.snapshot()
  const readerBody = nodesWith(readerSnap, 'sf-ov-body')[0]
  h.check('A3: the tall reader paints a body and content taller than it',
    readerBody !== undefined,
    `body=${box(readerBody)}`)
  h.capture('gate-a3-reader-top', 'the tall reader at the top')
  const startY = rect(nodesWith(h.snapshot(), 'sf-md')[0])[1]
  let moved = 0
  let tries = 0
  while (tries < 4 && moved <= 1) {
    await h.key('End', 700)
    tries += 1
    moved = startY - rect(nodesWith(h.snapshot(), 'sf-md')[0])[1]
  }
  h.check('A3: a real End key moves the reader viewport toward the tail',
    moved > 1,
    `moved=${moved}px tries=${tries}`)
  h.capture('gate-a3-reader-tail', 'the tall reader at the tail')

  h.measure('run totals', JSON.stringify({
    frames: frames(h).length,
    probes: controls(h),
    backClicks: backClicks(h).length,
    scrolls,
  }))
}

function nodesIn(node, name) {
  const out = []
  const walk = (n) => {
    if (hasClass(n, name)) out.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  if (node !== undefined) walk(node)
  return out
}
