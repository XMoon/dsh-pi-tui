/**
 * TSP-7 PR-E real-client evidence flow: the production Quiet Composer.
 *
 * One CASE per run on either the headless driver or the real GUI driver. The
 * subject mounts the production `mountTspRenderer`; every assertion reads the
 * client's painted node tree. Pointer/key input is control-injected, never
 * OS physical input.
 *
 * Cases: idle-empty | idle-draft | busy-empty | busy-draft | long-cjk |
 *        permission-open | permission-select | permission-stale | custom-footer
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function statusGroups(snap) {
  return snap.nodes.filter((node) => node.class === 'sf sf-status')
}

function buttons(snap) {
  return snap.nodes.filter((node) => node.tag === 'button'
    && String(node.class ?? '').split(' ').includes('sf-el'))
}

function textOf(h, node) {
  return node === undefined ? '' : h.descendantsText(node)
}

function text(nodes) {
  return nodes.map((node) => String(node.text ?? '')).filter(Boolean).join('')
}

function records(h) {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-quiet-composer-production-subject.mts')
  const subjectCase = process.env.TERN_TSP7_PRE_CASE ?? 'idle-empty'
  const gui = typeof h.splitPane === 'function'
  if (gui) await h.splitPane('right')
  await h.resize(1280, 800)
  writeFileSync(join(h.root, 'case'), `${subjectCase}\n`)
  const booted = await h.launch(subject, { ready: `quiet-composer-production ${subjectCase}` })
  h.check(`the PR-E ${subjectCase} subject boots inside a real Tern pane`, booted)
  if (!booted) return

  let snap = h.snapshot()
  const pane = snap.nodes.find(node =>
    String(node.class ?? '').split(' ').includes('tn-pane') &&
    String(node.class ?? '').split(' ').includes('on'))
  h.measure('pane-width', String(Array.isArray(pane?.rect) ? pane.rect[2] : undefined))

  const shell = snap.nodes.filter(node => String(node.class ?? '') === 'sf sf-col gap-none'
    && (node.children ?? []).some(child => String(child.class ?? '').includes('sf-editor')))
  const footer = snap.nodes.filter(node => String(node.class ?? '') === 'sf sf-col gap-none'
    && (node.children ?? []).some(child => String(child.class ?? '').includes('sf-status')))
  const allButtons = buttons(snap)
  const buttonTexts = allButtons.map(node => String(node.text ?? ''))
  const buttonTitles = allButtons.map(node => String(node.title ?? ''))
  const groups = statusGroups(snap)
  const groupText = groups.map(group => textOf(h, group)).join(' | ')
  h.check('the production Quiet Composer mounts exactly ONE shell', shell.length === 1, `shell=${shell.length}`)
  h.check('the shell owns the controlled editor and the control row',
    shell[0] !== undefined && (shell[0].children ?? []).some(child => String(child.class ?? '') === 'sf sf-row gap-sm al-center'),
    JSON.stringify((shell[0]?.children ?? []).map(child => child.class)))
  h.check('the shell owns Permission/Model/Effort/Send controls',
    buttonTitles.some(value => value.startsWith('Permission:')) && buttonTitles.some(value => value.startsWith('Model '))
    && buttonTitles.some(value => value.startsWith('Reasoning effort ')) && buttonTexts.includes('↑'), JSON.stringify(buttonTexts))
  h.check('the footer is a transparent group, not a row inside the shell',
    footer.length === 1 || groups.length === 0, `footer=${footer.length} groups=${groups.length}`)

  const permissionTrigger = snap.nodes.find(node => node.tag === 'button'
    && String(node.title ?? '').startsWith('Permission:'))

  if (subjectCase === 'idle-empty' || subjectCase === 'idle-draft') {
    h.check('idle keeps the Send control visible', buttonTexts.some(value => value.includes('↑')), JSON.stringify(buttonTexts))
    h.check('idle paints no Stop control', !buttonTexts.includes('Stop'), JSON.stringify(buttonTexts))
    if (subjectCase === 'idle-empty') {
      const send = allButtons.find(node => String(node.text ?? '').includes('↑'))
      h.check('idle empty paints Send disabled', String(send?.title ?? '') === 'Type a message to send', String(send?.title ?? ''))
    }
    h.check('the footer follows the PR-F default visibility (permission hidden, cwd visible)',
      !groupText.includes('ww') && groupText.includes('quiet-composer'), groupText)
  }

  if (subjectCase === 'busy-empty' || subjectCase === 'busy-draft') {
    h.check('busy keeps Stop beside Send', buttonTexts.includes('Stop') && buttonTexts.some(value => value.includes('↑')), JSON.stringify(buttonTexts))
    if (subjectCase === 'busy-empty') {
      const send = allButtons.find(node => String(node.text ?? '').includes('↑'))
      h.check('busy empty still paints Send disabled', String(send?.title ?? '') === 'Type a message to send', String(send?.title ?? ''))
    }
  }

  if (subjectCase === 'long-cjk') {
    const model = allButtons.find(node => String(node.title ?? '').startsWith('Model '))
    const modelText = String(model?.text ?? '')
    h.check('the long model label is clipped with an ellipsis, never painted whole',
      modelText.includes('…') && !modelText.includes('provider/very-long-deepseek-model-variant-with-reasoning'), modelText)
    h.check('the long model keeps its full tooltip', String(model?.title ?? '').includes('provider/very-long-deepseek-model-variant-with-reasoning'), String(model?.title ?? ''))
    const send = allButtons.find(node => String(node.text ?? '').includes('↑'))
    h.check('the CJK draft keeps the Send control reachable', send !== undefined)
  }

  if (subjectCase === 'permission-open' || subjectCase === 'permission-select' || subjectCase === 'permission-stale') {
    h.check('the permission trigger has the committed label', textOf(h, permissionTrigger).includes('Workspace Write'), textOf(h, permissionTrigger))
    await h.click(snap.chains, permissionTrigger)
    await h.sleep(300)
    snap = h.snapshot()
    const options = snap.nodes.filter(node => node.tag === 'button'
      && ['Read Only', 'Workspace Write', 'Full Access'].includes(String(node.title ?? '')))
    h.check('the menu paints the three standard permission options in order',
      options.map(node => textOf(h, node)).join('|') === 'Read Only|Workspace Write ✓|Full Access',
      options.map(node => textOf(h, node)).join('|'))
    if (subjectCase === 'permission-open') {
      h.capture('permission-menu-initial', 'PR-E permission menu opened: current ✓ before keyboard navigation')
      await h.key('down', 300)
      h.capture('permission-menu-highlight', 'PR-E permission menu after Down: keyboard highlight moved without a write')
      h.check('keyboard highlight navigation dispatches no write',
        records(h).filter(record => record.permissionSelect).length === 0,
        JSON.stringify(records(h).filter(record => record.permissionSelect)))
    }
    if (subjectCase === 'permission-select') {
      const full = options.find(node => textOf(h, node).startsWith('Full Access'))
      h.check('the Full Access option is present', full !== undefined)
      // The absolute menu intentionally overflows its stack: use the
      // option's own visible rect centre (the demo's measured workaround).
      await h.clickAt(full.rect[0] + full.rect[2] / 2, full.rect[1] + full.rect[3] / 2)
      await h.sleep(400)
      h.check('one permission select was dispatched', records(h).filter(record => record.permissionSelect === 'danger-full-access').length === 1,
        JSON.stringify(records(h).filter(record => record.permissionSelect)))
      const after = h.snapshot()
      const triggerAfter = after.nodes.find(node => node.tag === 'button'
        && String(node.title ?? '').startsWith('Permission:'))
      h.check('the trigger repaints from the pushed projection', textOf(h, triggerAfter).includes('Full Access'), textOf(h, triggerAfter))
    }
    if (subjectCase === 'permission-stale') {
      const oldFull = options.find(node => textOf(h, node).startsWith('Full Access'))
      h.check('the stale case captures an option before hydration', oldFull !== undefined)
      await h.sleep(3400) // the subject's declared hydration timer revokes the menu
      snap = h.snapshot()
      h.check('the session hydration closes the outgoing menu',
        snap.nodes.filter(node => node.tag === 'button'
          && ['Read Only', 'Workspace Write', 'Full Access'].includes(String(node.title ?? ''))).length === 0)
      // Click the retired option's own rect centre: the new frame has no such
      // target, so the old expansion cannot dispatch.
      await h.clickAt(oldFull.rect[0] + oldFull.rect[2] / 2, oldFull.rect[1] + oldFull.rect[3] / 2)
      await h.sleep(300)
      h.check('the stale option click never dispatches a write',
        records(h).filter(record => record.permissionSelect === 'danger-full-access').length === 0,
        JSON.stringify(records(h).filter(record => record.permissionSelect)))
    }
  }

  if (subjectCase === 'custom-footer') {
    h.check('custom footer paints one status group', groups.length === 1, `groups=${groups.length}`)
    h.check('the default-On permission/model/reasoning placements are hidden in the custom footer',
      !groupText.includes('ww') && !groupText.includes('luna') && !groupText.includes('@high'), groupText)
    h.check('the other custom placements remain', groupText.includes('quiet-composer') && groupText.includes('pre-evidence') && groupText.includes('72%'), groupText)
  }

  h.capture(`${subjectCase}-wide`, `PR-E ${subjectCase} at 1280x800`)
  if (['idle-draft', 'busy-draft', 'permission-open'].includes(subjectCase)) {
    for (const theme of ['light', 'dark']) {
      if (gui) h.send('plugins', 'run', `appearance:${theme}`)
      else h.send('appearance', theme)
      await h.sleep(400)
      h.check(`the client resolved the ${theme} appearance`, h.ctl('state').theme === theme, String(h.ctl('state').theme))
      h.capture(`${subjectCase}-wide-${theme}`, `PR-E ${subjectCase} at 1280x800 ${theme}`)
    }
  }
  if (!gui) {
    await h.resize(400, 600)
    await h.sleep(250)
    h.capture(`${subjectCase}-narrow`, `PR-E ${subjectCase} at 400x600`)
    if (subjectCase === 'idle-draft') {
      await h.resize(800, 260)
      await h.sleep(250)
      h.capture(`${subjectCase}-short`, 'PR-E idle-draft at 800x260 (short-height drag limitation)')
    }
  } else {
    await h.resize(800, 600)
    await h.sleep(250)
    h.capture(`${subjectCase}-split`, `PR-E ${subjectCase} at 800x600 split`)
  }
}
