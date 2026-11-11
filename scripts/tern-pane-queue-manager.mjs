/**
 * PR-Q real-pane evidence: the production TSP Queue manager sheet.
 *
 * One run over the real Tern client (headless pane or GUI window): the Dock
 * header/Manage affordance, the native Browse picker, the Edit overlay with the
 * controlled editor, the Delete confirmation and the ONE semantic writer path.
 * Input is control-injected by the client's own control channel; the artifacts
 * (node trees, PNG, subject event ledger) stay in the run directory.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function records(h) {
  try {
    return readFileSync(join(h.root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** One node whose own text (or a single text child) is exactly `text`. */
function nodeWithText(h, snap, text) {
  return snap.nodes.find(node => String(node.text ?? '') === text)
    ?? snap.nodes.find(node => {
      const children = (node.children ?? []).filter(child => typeof child.text === 'string')
      return children.length === 1 && children[0].text === text
    })
}

export default async function (h) {
  const subject = join(h.repo, 'scripts', 'tern-pane-queue-manager-subject.mts')
  await h.resize(1280, 800)
  const booted = await h.launch(subject, { ready: 'queue-manager ready' })
  h.check('the queue-manager subject boots inside a real Tern pane', booted)
  if (!booted) return

  let snap = h.snapshot()
  h.check('the Dock paints the authoritative count', h.has(snap, 'Queue · 2'), JSON.stringify(records(h).slice(-1)))
  const manage = nodeWithText(h, snap, 'Manage [Alt+I]')
  h.check('the Dock paints the effective Manage label', manage !== undefined)
  h.check('a control-injected click on Manage opens the sheet',
    manage !== undefined && await h.click(snap.chains, manage))
  h.check('the native Browse sheet shows the queued count', await h.waitFor('2 queued', { timeoutMs: 5000 }))

  snap = h.snapshot()
  h.check('the Browse rows are the Host occurrences',
    h.has(snap, 'first queued') && h.has(snap, 'second queued'))
  const edit = nodeWithText(h, snap, 'Edit')
  h.check('the picker action bar offers Edit', edit !== undefined)
  h.check('a control-injected click on Edit opens the Edit overlay',
    edit !== undefined && await h.click(snap.chains, edit))
  h.check('the Edit page is visible', await h.waitFor('Edit queued message', { timeoutMs: 5000 }))

  await h.key('X', 500)
  h.check('a real key reaches the controlled editor draft',
    records(h).some(record => record.view?.draft === 'first queuedX'))
  await h.key('ControlOrMeta+s', 800)
  h.check('Ctrl+S commits exactly ONE official edit through the writer',
    records(h).filter(record => record.write === 'edit').length === 1
      && records(h).some(record => record.write === 'edit' && record.itemId === 'occ-1'))
  h.check('the sheet returns to Browse after the edit commits',
    await h.waitFor('2 queued', { timeoutMs: 5000 }))

  snap = h.snapshot()
  const remove = nodeWithText(h, snap, 'Delete')
  h.check('the picker action bar offers Delete', remove !== undefined)
  h.check('a control-injected click on Delete opens the confirmation',
    remove !== undefined && await h.click(snap.chains, remove))
  h.check('the confirmation states the consequence',
    await h.waitFor('This queued message cannot be restored after deletion.', { timeoutMs: 5000 }))
  snap = h.snapshot()
  const confirm = nodeWithText(h, snap, 'Confirm')
  h.check('the confirmation offers a native Confirm action', confirm !== undefined)
  h.check('a control-injected click on Confirm removes the occurrence',
    confirm !== undefined && await h.click(snap.chains, confirm)
      && await h.waitFor('2 queued', { timeoutMs: 5000 })
      && records(h).filter(record => record.write === 'remove').length === 1)

  await h.capture('queue-manager-1280x800', 'the native Queue sheet after one edit and one remove')
  await h.key('F10', 500)
}
