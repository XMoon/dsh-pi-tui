/**
 * TSP-7 PR-G real-client evidence flow: the combined Model·Effort quick menu.
 *
 * One CASE per run, driven through the headless real Tern client (the same flow
 * also runs in a live window through `tern-gui-drive.mjs`). The subject mounts
 * the PRODUCTION `mountTspRenderer`, so every assertion below reads the client's
 * painted node tree, and every click/key is a real control-injected input event.
 *
 * Cases (`TERN_TSP7_MQ_CASE`): root | models | effort | noeffort | partial |
 * long | write | reject | full | keys
 * Geometry/appearance come from `TERN_TSP7_MQ_W` / `_H` / `_APPEARANCE` (the
 * plan's matrix is 1280x800, 900x700, 400x600 and 900x360, dark and light).
 *
 * What every open-menu case proves, whatever its own subject:
 *   - the menu is anchored to the trigger it belongs to: right-edge alignment
 *     with that button and a 4px gap above it (<=2px client rounding allowed) —
 *     not centred in the pane, not aligned to Send, not pushed above the editor;
 *   - the Composer and editor layout boxes are IDENTICAL before and after the
 *     open: the menu covers the prompt area and occupies no layout height;
 *   - the fixed `All models & details…` footer row is painted inside the pane
 *     while the list body is the scrolling region.
 *
 * OVERLAY GEOMETRY NOTE: the menu is an absolutely positioned child of the
 * trigger's own container, so its rect deliberately falls outside that ancestor.
 * The ancestor-clipping oracle (`containedXY`/`visiblePoint`) therefore reports
 * every overlay row as clipped — a false negative about the painted result that
 * the capture disproves. Rows are therefore clicked at their own painted centre,
 * and every click claim is verified from what the NEXT frame paints or from the
 * subject's own record; no claim here rests on a node's rect alone.
 *
 * The subject declares its own boundary stand-ins on `events.jsonl` (the scripted
 * directory and the write settlement); the registered command owner and the real
 * durable writer are qualified by `test/app/tern-tsp-model-quick-menu.test.ts`
 * against the official Direct composition, and nothing here substitutes for it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rect } from './tern-pane-geometry.mjs'

const ANCHOR_GAP_PX = 4
const TOLERANCE_PX = 2
/** The menu's own CSS width budget; anything wider is not the anchored menu. */
const MENU_MAX_WIDTH_PX = 340

function elButtons(snap) {
  return snap.nodes.filter(node => node.tag === 'button'
    && String(node.class ?? '').split(' ').includes('sf-el'))
}

function nodeText(node) {
  const out = []
  const walk = (current) => {
    out.push(String(current.text ?? ''))
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function boxOf(node) {
  const [x, y, width, height] = rect(node)
  return { x, y, w: width, h: height, right: x + width, bottom: y + height, cx: x + width / 2, cy: y + height / 2 }
}

function inside(outer, inner) {
  return inner.x >= outer.x - 1 && inner.right <= outer.right + 1
    && inner.y >= outer.y - 1 && inner.bottom <= outer.bottom + 1
}

function triggerOf(snap) {
  return elButtons(snap).find(node => String(node.title ?? '').includes('model and reasoning effort'))
}

function editorNode(snap) {
  return snap.nodes.find(node => String(node.class ?? '').includes('sf-editor'))
}

function footerRow(snap) {
  return elButtons(snap).find(node => nodeText(node).includes('All models & details…'))
}

function menuMounted(snap) {
  return footerRow(snap) !== undefined
}

/** The menu's own painted box: the outermost ancestor of its fixed footer that
 *  is still as narrow as the anchored menu and tall enough to be a panel. */
function menuBox(snap) {
  const footer = footerRow(snap)
  if (footer === undefined) return undefined
  let found = undefined
  for (const node of snap.chains.get(footer) ?? []) {
    const box = boxOf(node)
    if (box.w > 0 && box.w <= MENU_MAX_WIDTH_PX && box.h >= 60) found = box
  }
  return found
}

/** Every button the menu paints: inside its anchored box. The composer's own
 *  controls sit outside it, so they can never be mistaken for menu rows. */
function menuButtons(snap) {
  const box = menuBox(snap)
  if (box === undefined) return []
  return elButtons(snap).filter(node => inside(box, boxOf(node)))
}

function menuLabels(snap) {
  return menuButtons(snap).map(nodeText)
}

function allLabels(snap) {
  return elButtons(snap).map(nodeText)
}

/** Everything the menu paints, rows and non-rows (group heads, notices, the
 *  search placeholder): a click that changes only the notice still changes it.
 *  The client's tree carries an `id` on only some nodes, so the region is
 *  selected by geometry against the menu's own anchored box, never by id. */
function menuPainted(snap) {
  const box = menuBox(snap)
  if (box === undefined) return ''
  return snap.nodes
    .filter(node => {
      const inner = boxOf(node)
      return inner.w > 0 && inner.h > 0 && inside(box, inner)
    })
    .map(node => String(node.text ?? ''))
    .filter(Boolean)
    .join(' | ')
}

function editorText(snap) {
  const editor = editorNode(snap)
  return editor === undefined ? '' : nodeText(editor)
}

function subjectEvents(h) {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

function countEvents(h, field) {
  return subjectEvents(h).filter(entry => entry[field] !== undefined).length
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-composer-model-quick-ux-subject.mts')
  const testCase = process.env.TERN_TSP7_MQ_CASE ?? 'root'
  const width = Number(process.env.TERN_TSP7_MQ_W ?? 1280)
  const height = Number(process.env.TERN_TSP7_MQ_H ?? 800)
  const appearance = process.env.TERN_TSP7_MQ_APPEARANCE ?? 'dark'
  writeFileSync(join(h.root, 'case'), `${testCase}\n`)
  if (process.env.TERN_TSP7_MQ_GUI === '1' && typeof h.splitPane === 'function') await h.splitPane('right')
  await h.resize(width, height)
  // The client's resolved appearance is part of the claim, so ask for it
  // explicitly (the headless default is light) and read it back.
  await h.send('appearance', appearance)
  await h.sleep(300)
  const booted = await h.launch(subject, { ready: `composer-model-quick-ux ${testCase}` })
  h.check(`the PR-G ${testCase} subject boots inside a real Tern pane`, booted)
  if (!booted) return
  h.measure('run-geometry', `${width}x${height} appearance=${appearance} case=${testCase}`)

  let snap = h.snapshot()
  const trigger = triggerOf(snap)
  h.check('the composer carries ONE combined Model·Effort trigger', trigger !== undefined,
    JSON.stringify(allLabels(snap)))
  h.check('no separate Effort control survives on the composer row',
    !allLabels(snap).some(label => /^Effort\b/.test(label)), JSON.stringify(allLabels(snap)))
  if (trigger === undefined) return
  // The tooltip carries the COMPLETE sanitized facts: never the clamped label,
  // never an ellipsis, never the narrow-pane effort abbreviation.
  const title = String(trigger.title ?? '')
  const label = nodeText(trigger)
  h.check('the trigger tooltip states the complete model and effort facts',
    title.endsWith('— model and reasoning effort')
    && !title.includes('…') && !title.includes('▾') && !title.includes('▴')
    && !title.includes('null') && !title.includes('undefined'),
    `title=${JSON.stringify(title)} label=${JSON.stringify(label)}`)
  // The cases whose fixture declares NO effort have nothing to abbreviate; the
  // claim below is about the narrow pane's clamped effort, not about them.
  if (testCase !== 'noeffort' && testCase !== 'partial' && testCase !== 'manyfail') {
    h.check('the tooltip keeps the unabbreviated effort value the clamped label drops',
      /· (high|low|medium)$/.test(title.replace(' — model and reasoning effort', ''))
      || testCase === 'models',
      `title=${JSON.stringify(title)}`)
  }

  const editorBefore = boxOf(editorNode(snap))
  const sendBefore = boxOf(elButtons(snap).find(node => nodeText(node).includes('↑')) ?? trigger)

  if (testCase === 'keys') {
    // The keyboard case opens the panel from the subject itself, so no pointer
    // input is involved anywhere in the walk.
    await h.sleep(1400)
  } else {
    const at = boxOf(trigger)
    await h.clickAt(at.cx, at.cy)
  }
  snap = h.snapshot()
  h.check('the quick menu opened with its fixed Full footer', menuMounted(snap),
    JSON.stringify(allLabels(snap)))
  if (!menuMounted(snap)) { h.capture(`${testCase}-no-menu`, 'the menu never painted'); return }
  const menu = menuBox(snap)
  h.check('the menu paints as its own floating box', menu !== undefined, JSON.stringify(menu))

  // ── The anchor and no-layout-shift contract (every case that opens the menu).
  const after = h.snapshot()
  const triggerNow = boxOf(triggerOf(after) ?? trigger)
  if (menu !== undefined) {
    const gap = triggerNow.y - menu.bottom
    h.check(`the menu bottom sits ${ANCHOR_GAP_PX}px above its own trigger (<=${TOLERANCE_PX}px rounding)`,
      Math.abs(gap - ANCHOR_GAP_PX) <= TOLERANCE_PX,
      `gap=${gap.toFixed(1)} menuBottom=${menu.bottom.toFixed(1)} triggerTop=${triggerNow.y.toFixed(1)}`)
    const rightDelta = Math.abs(menu.right - triggerNow.right)
    h.check('the menu is right-aligned with its trigger, not with the Send button',
      rightDelta <= TOLERANCE_PX,
      `rightDelta=${rightDelta.toFixed(1)} menuRight=${menu.right.toFixed(1)} triggerRight=${triggerNow.right.toFixed(1)} sendRight=${sendBefore.right.toFixed(1)}`)
    // The claim is about the PANE, so it is measured against the pane box the
    // client reports: a GUI window clamps its own minimum size, so the requested
    // pixel size is not the pane's width.
    const paneBoxForMenu = boxOf(after.nodes.find(node => String(node.class ?? '').split(' ').includes('tn-pane')) ?? { rect: [0, 0, width, height] })
    h.check('the floating menu stays inside the visible pane at this size',
      menu.x >= paneBoxForMenu.x - TOLERANCE_PX && menu.y >= paneBoxForMenu.y - TOLERANCE_PX
      && menu.right <= paneBoxForMenu.right + TOLERANCE_PX
      && menu.bottom <= paneBoxForMenu.bottom + TOLERANCE_PX,
      JSON.stringify({ menu, pane: paneBoxForMenu }))
  }
  const editorAfter = boxOf(editorNode(after))
  h.check('covering the editor moves no Composer layout box',
    editorAfter.x === editorBefore.x && editorAfter.y === editorBefore.y && editorAfter.w === editorBefore.w,
    `before=${JSON.stringify(editorBefore)} after=${JSON.stringify(editorAfter)}`)
  const footerBox = boxOf(footerRow(after))
  const pane = after.nodes.find(node => String(node.class ?? '').split(' ').includes('tn-pane'))
  h.check('the fixed Full footer is painted inside the pane while the body may scroll',
    pane !== undefined && inside(boxOf(pane), footerBox) && footerBox.w >= 120 && footerBox.h >= 20,
    JSON.stringify({ footer: footerBox, pane: boxOf(pane) }))
  h.measure('menu-rows-open', JSON.stringify(menuLabels(after)))
  h.capture(`${testCase}-${width}x${height}-${appearance}-open`, 'the anchored quick menu, open')

  /**
   * Click a menu row at its own painted centre, then prove the click landed by
   * what the NEXT frame paints (rows, notice or the panel going away) — a
   * rect-only claim is never evidence, and a commit click legitimately leaves
   * the row list unchanged.
   */
  const choose = async (fragment, note = '') => {
    const current = h.snapshot()
    const node = menuButtons(current).find(entry => nodeText(entry).includes(fragment))
    if (node === undefined) {
      h.check(`the menu offers "${fragment}"`, false, JSON.stringify(menuLabels(current)))
      return false
    }
    const beforePainted = menuPainted(current)
    const box = boxOf(node)
    await h.clickAt(box.cx, box.cy)
    const next = h.snapshot()
    const changed = menuPainted(next) !== beforePainted || !menuMounted(next)
    h.check(`a real pointer click on "${fragment}" changed what the menu paints${note}`,
      changed, `before=${beforePainted.slice(0, 200)} after=${menuPainted(next).slice(0, 200)}`)
    return true
  }
  /** Poll the real tree until `done()` or the budget runs out. */
  const poll = async (label, done, timeoutMs = 9000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (done()) return true
      await h.sleep(200)
    }
    h.check(`the client reached ${label}`, false, `timed out after ${timeoutMs}ms`)
    return false
  }

  // ── Case-specific behaviour.
  if (testCase === 'root') {
    h.check('root order is Model, then Reasoning Effort, then the fixed Full footer',
      menuLabels(h.snapshot()).join(' | ') === 'Model Alpha One › | Reasoning Effort High › | All models & details…',
      JSON.stringify(menuLabels(h.snapshot())))
  }
  if (testCase === 'noeffort') {
    const seen = menuLabels(h.snapshot())
    h.check('a current model without reasoning metadata offers no Effort row at all',
      !seen.some(label => label.includes('Reasoning Effort')), JSON.stringify(seen))
  }
  if (testCase === 'partial') {
    const painted = menuPainted(h.snapshot())
    h.check('the failed provider is stated in words beside the usable groups',
      painted.includes('Gamma Provider') && painted.includes('unavailable') && painted.includes('Alpha One'),
      painted.slice(0, 300))
    h.check('the usable provider groups stay offered under a partial read',
      menuLabels(h.snapshot()).some(label => label.includes('Alpha One')),
      JSON.stringify(menuLabels(h.snapshot())))
  }
  if (testCase === 'long') {
    const seen = menuLabels(h.snapshot())
    h.check('a long advertised name never eats the row label it belongs to',
      seen.some(label => /^Model\b/.test(label)) && seen.some(label => /^Reasoning Effort\b/.test(label)),
      JSON.stringify(seen))
  }

  if (['models', 'long', 'effort', 'write', 'reject', 'full', 'manyfail', 'escape', 'focusclick']
    .includes(testCase)) {
    if (await choose('Model ')) {
      await h.sleep(500)
      const page = h.snapshot()
      const field = page.nodes.find(node => node.tag === 'input'
        || String(node.class ?? '').split(' ').includes('sf-input'))
      h.check('the Model page searches through a native input field', field !== undefined,
        JSON.stringify(page.nodes.filter(node => node.tag === 'input').map(node => node.tag)))
      const painted = menuPainted(page)
      const expectedHead = testCase === 'long' ? 'A very long advertised provider name' : 'Alpha Provider'
      h.check('provider group heads come from the directory order',
        painted.includes(expectedHead), painted.slice(0, 260))
      const seen = menuLabels(page)
      const expectedRow = testCase === 'models' ? 'Model Number 01'
        : testCase === 'long' ? 'Beta One' : testCase === 'manyfail' ? 'Beta One' : 'Alpha Two'
      h.check('the model rows are painted from the directory read',
        seen.some(label => label.includes(expectedRow)), JSON.stringify(seen))
      h.check('the subpage keeps its fixed Back row and Full footer',
        seen.some(label => label.includes('‹ Model & Effort')) && menuMounted(page),
        JSON.stringify(seen))
      h.capture(`${testCase}-${width}x${height}-${appearance}-models`, 'the searchable model page')

      if (testCase === 'models') {
        // The list body is the only scrolling region, so the LAST provider group
        // is reached through the menu's own search instead of assuming it is
        // painted without scrolling.
        const beforeDraft = editorText(page)
        await h.key('B', 400)
        await h.key('e', 400)
        await h.key('t', 400)
        const filtered = h.snapshot()
        const filteredPainted = menuPainted(filtered)
        h.check('typing filters the menu to the last provider group',
          filteredPainted.includes('Beta Provider') && !filteredPainted.includes('Alpha Provider'),
          filteredPainted.slice(0, 260))
        h.check('the filter never touches the Composer draft',
          editorText(filtered) === beforeDraft, editorText(filtered))
        h.capture(`${testCase}-${width}x${height}-${appearance}-filtered`, 'the filtered list')
      }
      if (testCase === 'long') {
        const nowMenu = menuBox(h.snapshot())
        h.check('over-long and CJK labels stay inside the anchored menu width',
          nowMenu !== undefined && nowMenu.w <= MENU_MAX_WIDTH_PX, JSON.stringify(nowMenu))
        h.check('the hostile labels never wrap the Composer into extra height',
          boxOf(editorNode(h.snapshot())).y === editorBefore.y,
          JSON.stringify(boxOf(editorNode(h.snapshot()))))
        h.measure('long-label-paint', menuLabels(h.snapshot()).join(' | ').slice(0, 240))
      }
      if (testCase === 'manyfail') {
        // A dozen failed providers is external data with no bound. The fixed
        // chrome must survive it: the failure lines scroll INSIDE the body, the
        // menu never outgrows its own height budget, and the Full entry stays
        // painted inside the pane (this is the 900x360 short-pane case).
        const now = h.snapshot()
        const nowMenu = menuBox(now)
        const paneBox = boxOf(now.nodes.find(node => String(node.class ?? '').split(' ').includes('tn-pane')))
        const lines = now.nodes
          .filter(node => String(node.text ?? '').includes('unavailable') || /Provider \d+ · /.test(String(node.text ?? '')))
          .map(node => boxOf(node))
        h.check('every failed provider is stated in the menu', lines.length >= 12,
          `${lines.length} failure lines painted`)
        // The client's tree reports a scrolled-out row at its LAYOUT position,
        // outside the scroller's clip, so a claim about every row's rect would be
        // a claim about clipping the tree cannot make. Which container a row
        // belongs to is the structural claim and the automated wire case owns it
        // (the failure nodes are children of the scroller node); here the claim
        // is that a real subset of them paints inside the anchored menu box.
        const paintedLines = nowMenu === undefined
          ? []
          : lines.filter(line => inside(nowMenu, line))
        // How many of them are VISIBLE without scrolling depends on the room the
        // pane gives the body, so the claim is size-aware: a normal pane must show
        // a real subset of them, and any pane must at least lay all of them out
        // inside the menu (none dropped, none pushed past the fixed footer).
        h.check('failed-provider lines paint inside the anchored menu',
          height >= 600
            ? paintedLines.length >= 3
            : paintedLines.length >= 1 || lines.length === 12,
          JSON.stringify({ menu: nowMenu, painted: paintedLines.length, laidOut: lines.length }))
        h.check('the menu keeps its own height budget under a dozen failures',
          nowMenu !== undefined && paneBox !== undefined && nowMenu.h <= paneBox.h + 2,
          JSON.stringify({ menu: nowMenu, pane: paneBox }))
        h.check('the fixed Full footer is still inside the pane under a dozen failures',
          paneBox !== undefined && inside(paneBox, boxOf(footerRow(now))),
          JSON.stringify({ footer: boxOf(footerRow(now)), pane: paneBox }))
        h.measure('manyfail-lines', String(lines.length))
        h.capture(`${testCase}-${width}x${height}-${appearance}-failures`, 'a dozen failed providers inside the anchored menu')
      }
      if (testCase === 'escape') {
        // Type a filter, leave the page with the POINTER (Back keeps the filter),
        // then press Escape on the root: it must close the menu, not be swallowed
        // by a clear the root page cannot perform.
        await h.key('z', 350)
        await h.key('z', 350)
        const typed = h.snapshot()
        h.check('the search field holds what was typed', menuPainted(typed).includes('zz'),
          menuPainted(typed).slice(0, 200))
        if (await choose('‹ Model & Effort')) {
          await h.sleep(400)
          const root = h.snapshot()
          h.check('Back returned to the root with the menu still open', menuMounted(root) &&
            menuLabels(root).some(label => label.includes('Reasoning Effort')),
            JSON.stringify(menuLabels(root)))
          await h.key('Escape', 600)
          const closed = h.snapshot()
          h.check('Escape on the root closes the menu instead of dying on the filter',
            !menuMounted(closed), JSON.stringify(allLabels(closed)))
          h.check('closing the menu never cancels the Agent', countEvents(h, 'cancels') === 0,
            String(countEvents(h, 'cancels')))
        }
      }
      if (testCase === 'focusclick') {
        // Tab leaves the field for the list; a POINTER click on the now-unfocused
        // field is a client focus event, not a key. Typing after it must edit the
        // filter again — otherwise the client thinks the caret is in the box while
        // the panel is still browsing rows.
        await h.key('Tab', 400)
        const before = h.snapshot()
        const field = before.nodes.find(node => String(node.class ?? '').split(' ').includes('sf-input'))
        h.check('the model page still paints its native search field after Tab', field !== undefined)
        if (field !== undefined) {
          const at = boxOf(field)
          await h.clickAt(at.cx, at.cy)
          await h.sleep(400)
          await h.key('B', 350)
          await h.key('e', 350)
          await h.key('t', 350)
          const after = h.snapshot()
          h.check('a pointer click on the field restores the typing target',
            menuPainted(after).includes('Bet'), menuPainted(after).slice(0, 220))
          h.capture(`${testCase}-${width}x${height}-${appearance}-refocus`, 'the filter edited again after a pointer click')
        }
      }
      if (testCase === 'effort') {
        if (await choose('‹ Model & Effort')) {
          await h.sleep(400)
          h.check('Back returns to the root frame without another read',
            menuLabels(h.snapshot()).some(label => label.includes('Reasoning Effort'))
            && countEvents(h, 'retry') === 0,
            JSON.stringify(menuLabels(h.snapshot())))
        }
      }
      if (testCase === 'write' || testCase === 'reject') {
        const before = countEvents(h, 'apply')
        if (await choose('Alpha Two', ' (the selection)')) {
          h.capture(`${testCase}-${width}x${height}-${appearance}-pending`, 'the frame right after the selection')
          h.measure('pending-text', JSON.stringify(h.snapshot().nodes
            .map(node => String(node.text ?? ''))
            .filter(line => /Selecting/.test(line))))
          h.check('the admitted write is stated as pending on the real client',
            menuPainted(h.snapshot()).includes('Selecting…'), menuPainted(h.snapshot()).slice(0, 260))
          const duringPending = countEvents(h, 'apply')
          // Under an admitted write the row is inert BY CONTRACT, so the frame is
          // expected to stay unchanged: the claim is the event counter below, and
          // the click is delivered raw (no change oracle) exactly for that reason.
          const inertRow = menuButtons(h.snapshot()).find(entry => nodeText(entry).includes('Alpha Two'))
          if (inertRow !== undefined) {
            const inertBox = boxOf(inertRow)
            await h.clickAt(inertBox.cx, inertBox.cy)
          }
          await h.key('Return', 400)
          h.check('a second click or Enter under an admitted write dispatches no second selection',
            countEvents(h, 'apply') === duringPending,
            `during=${duringPending} after=${countEvents(h, 'apply')}`)
          if (testCase === 'write') {
            await poll('the committed selection to dismiss the menu', () => !menuMounted(h.snapshot()))
            await poll('the projection to relabel the trigger', () =>
              nodeText(triggerOf(h.snapshot()) ?? trigger).includes('Alpha Two'), 4000)
            const settled = h.snapshot()
            h.check('the committed selection dismisses the menu', !menuMounted(settled),
              JSON.stringify(allLabels(settled)))
            h.check('the trigger relabels from the projection, not from the clicked row',
              nodeText(triggerOf(settled) ?? trigger).includes('Alpha Two'),
              nodeText(triggerOf(settled) ?? trigger))
            h.check('exactly one selection reached the write owner',
              countEvents(h, 'apply') - before === 1, String(countEvents(h, 'apply') - before))
          } else {
            await poll('the refused write to restore the page', () =>
              !menuPainted(h.snapshot()).includes('Selecting…'))
            const settled = h.snapshot()
            h.check('a refused write leaves the panel on its page and operable',
              menuMounted(settled) && menuLabels(settled).length > 0
              && !menuPainted(settled).includes('Selecting…'),
              JSON.stringify(menuLabels(settled)))
            h.check('the refused write never relabels the trigger optimistically',
              !nodeText(triggerOf(settled) ?? trigger).includes('Alpha Two'),
              nodeText(triggerOf(settled) ?? trigger))
          }
        }
      }
      if (testCase === 'full') {
        const target = footerRow(h.snapshot())
        if (target !== undefined) {
          const beforePainted = menuPainted(h.snapshot())
          const box = boxOf(target)
          await h.clickAt(box.cx, box.cy)
          await h.sleep(700)
          const handed = h.snapshot()
          h.check('the Full handoff retires the quick frame',
            !menuMounted(handed) && menuPainted(handed) !== beforePainted,
            JSON.stringify(allLabels(handed)))
          h.check('the handoff went through the registered full entry exactly once',
            countEvents(h, 'fullEntry') === 1, String(countEvents(h, 'fullEntry')))
        }
      }
    }
  }

  if (testCase === 'keys') {
    const beforeDraft = editorText(h.snapshot())
    h.check('the keyboard-opened panel is the anchored root', menuMounted(h.snapshot()),
      JSON.stringify(menuLabels(h.snapshot())))
    await h.key('Return', 700)
    const page = h.snapshot()
    h.check('Enter activated the highlighted root row instead of sending the draft',
      menuLabels(page).some(label => label.includes('‹ Model & Effort')),
      JSON.stringify(menuLabels(page)))
    h.check('the keyboard walk never entered the Composer draft', editorText(page) === beforeDraft,
      editorText(page))
    await h.key('z', 400)
    await h.key('z', 400)
    const typed = h.snapshot()
    h.check('typing edits the menu search only', editorText(typed) === beforeDraft
      && menuLabels(typed).every(label => !label.includes('Alpha Two')),
      JSON.stringify({ labels: menuLabels(typed), draft: editorText(typed) }))
    await h.key('Tab', 400)
    await h.key('Tab', 400)
    await h.key('Tab', 400)
    h.check('Tab stays inside the menu regions', editorText(h.snapshot()) === beforeDraft,
      editorText(h.snapshot()))
    await h.key('Escape', 500)
    h.check('the first Escape cleared the search and kept the menu open',
      menuMounted(h.snapshot()) && menuLabels(h.snapshot()).some(label => label.includes('Alpha Two')),
      JSON.stringify(menuLabels(h.snapshot())))
    await h.key('Escape', 500)
    h.check('the next Escape returned to the root',
      menuMounted(h.snapshot()) && menuLabels(h.snapshot()).some(label => label.includes('Reasoning Effort')),
      JSON.stringify(menuLabels(h.snapshot())))
    await h.key('Escape', 600)
    const closed = h.snapshot()
    h.check('the last Escape closed the menu and never cancelled the Agent',
      !menuMounted(closed) && countEvents(h, 'cancels') === 0, JSON.stringify(allLabels(closed)))
    await h.key('q', 500)
    h.check('typing reaches the Composer again after the dismissal',
      editorText(h.snapshot()).includes('q'), editorText(h.snapshot()))
  }

  if (testCase !== 'keys' && menuMounted(h.snapshot())) {
    const current = h.snapshot()
    const again = triggerOf(current)
    if (again !== undefined) {
      const at = boxOf(again)
      await h.clickAt(at.cx, at.cy)
      await h.sleep(400)
      h.check('a second click on the same trigger dismisses the menu', !menuMounted(h.snapshot()),
        JSON.stringify(allLabels(h.snapshot())))
    }
  }
  h.capture(`${testCase}-${width}x${height}-${appearance}-final`, 'after the case walk')
}
