/**
 * PR4-B2-A: real-Tern `/copy` qualification flow.
 *
 *   node scripts/tern-pane-drive.mjs scripts/tern-pane-b2a-copy.mjs
 *
 * Runs the production Direct/TSP composition inside a real headless Tern pane
 * and drives `/copy` through the REAL Composer keys. What it proves:
 *
 *  1. the OSC 52 leg (when stdout is a tty) actually reached the Tern tty, and
 *     the frame parser / ACK / input loop survived it (a LATER command still
 *     produces its business result, and the close flow still settles);
 *  2. the tmux helper leg's observable target (`tmux show-buffer`) holds the
 *     copied text when the subject runs inside tmux — a real clipboard-store
 *     readback, NOT an "a helper was spawned" claim.
 *
 * OS-level clipboard verification is a SEPARATE dimension this environment
 * cannot observe (no display, no clipboard helper). The flow measures it as
 * such and never upgrades emission to "the OS clipboard changed".
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ASSISTANT_TEXT = 'COPY-ME-REAL-TERN'
const eventPath = (h) => join(h.root, 'events.jsonl')
const records = (h) => {
  const path = eventPath(h)
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
}
const waitUntil = async (h, label, predicate, { limit = 200, intervalMs = 250 } = {}) => {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  h.log(`WAIT-FAIL ${label}`)
  return false
}
const requiredWait = async (h, label, predicate) => {
  const ok = await waitUntil(h, label, predicate)
  h.check(label, ok, ok ? '' : JSON.stringify(h.texts(h.snapshot())))
  return ok
}
const keyText = async (h, text) => {
  for (const character of text) await h.key(character, 120)
}
const submitCommand = async (h, command) => {
  await keyText(h, command)
  await h.key('Return', 800)
}
const finish = (h) => {
  const status = h.finish()
  if (status !== 0) process.exitCode = status
}

export default async function (h) {
  await h.resize(1000, 700)
  const subject = join(h.repo, 'scripts', 'tern-pane-b2a-copy-subject.mts')
  h.check('the production Direct/TSP copy subject launches in the real Tern pane', await h.launch(subject))

  if (!await requiredWait(h, 'fixture ready with a live production TSP surface', () =>
    records(h).some((entry) => entry.kind === 'fixture.ready')
    && h.classNodes(h.snapshot(), 'sf-region').length > 0)) {
    finish(h)
    return
  }
  const ready = records(h).find((entry) => entry.kind === 'fixture.ready')
  h.measure('the subject stdio facts', JSON.stringify(ready))
  h.check('the real Tern client shows the production TSP surface (PiTui fallback is not accepted)',
    h.classNodes(h.snapshot(), 'sf-region').length > 0)

  // 1. Produce a real assistant message through the ordinary prompt path.
  //    The driver's key vocabulary has no name for the SPACE key, so every
  //    input is a single token — the gesture, not the text, is what matters.
  await keyText(h, 'seedprompt')
  await h.key('Return', 800)
  if (!await requiredWait(h, 'the real assistant message renders in the Tern transcript', () =>
    JSON.stringify(h.texts(h.snapshot())).includes(ASSISTANT_TEXT), { limit: 240 })) {
    finish(h)
    return
  }

  // 2. `/copy` through the real composer.
  await submitCommand(h, '/copy')
  const noticed = await requiredWait(h, 'the /copy business result renders in the real client', () =>
    h.texts(h.snapshot()).some((text) => String(text).includes('copied last assistant message')), { limit: 240 })
  if (!noticed) {
    finish(h)
    return
  }
  h.capture('b2a-copy-after-copy', 'the real client after /copy')

  const osc52 = records(h).filter((entry) => entry.kind === 'stdout.osc52')
  const expectedBase64 = Buffer.from(ASSISTANT_TEXT, 'utf8').toString('base64')
  const emitted = osc52.some((entry) => String(entry.chunk).includes(expectedBase64))
  if (ready?.stdoutIsTTY === true) {
    h.check('the OSC 52 leg emitted the authoritative assistant text on the Tern tty', emitted,
      JSON.stringify(osc52))
  } else {
    h.check('a non-tty stdout emits no OSC 52 sequence (the leg is tty-gated)', osc52.length === 0,
      JSON.stringify({ osc52, stdoutIsTTY: ready?.stdoutIsTTY }))
  }

  // 3. The tmux helper leg's observable target: read the tmux buffer back when
  //    the subject actually runs inside tmux (the Tern-launched subject inherits
  //    the serve process environment, which does not carry TMUX here).
  const tmuxBuffer = ready?.tmux === true
    ? spawnSync('tmux', ['show-buffer'], { encoding: 'utf8' })
    : undefined
  if (ready?.tmux === true) {
    h.check('the tmux helper leg stored the assistant text in the real tmux buffer',
      tmuxBuffer?.status === 0 && String(tmuxBuffer.stdout).includes(ASSISTANT_TEXT),
      JSON.stringify({ status: tmuxBuffer?.status, stdout: String(tmuxBuffer?.stdout ?? '').slice(0, 200), stderr: String(tmuxBuffer?.stderr ?? '') }))
  } else {
    h.measure('tmux helper leg', 'NOT_REACHED (the Tern-launched subject inherits no TMUX)')
  }

  // 4. The frame parser / ACK / input loop survived the OSC 52 bytes: a NEW
  //    real input after the emission reaches the same business handler and
  //    emits the clipboard sequence a SECOND time. (The driver's key vocabulary
  //    has no SPACE name, so an argued line cannot be typed here.)
  const beforeSecond = records(h).filter((entry) => entry.kind === 'stdout.osc52').length
  await submitCommand(h, '/copy')
  if (!await requiredWait(h, 'a post-copy input still reaches the clipboard policy', () =>
    records(h).filter((entry) => entry.kind === 'stdout.osc52').length === beforeSecond + 1, { limit: 240 })) {
    finish(h)
    return
  }
  h.check('the input loop and frame ACK survive the raw OSC 52 bytes',
    records(h).filter((entry) => entry.kind === 'stdout.osc52').length === 2,
    JSON.stringify({ emissions: records(h).filter((entry) => entry.kind === 'stdout.osc52').length }))
  h.capture('b2a-copy-after-later-command', 'a later command still works after the OSC 52 emission')

  // 5. The close flow still settles.
  await submitCommand(h, '/exit')
  const settled = await requiredWait(h, 'the production subject completes its teardown', () =>
    records(h).some((entry) => entry.kind === 'fixture.settled'), { limit: 240 })
  const exited = await requiredWait(h, 'the subject process exits 0 after the copy', () =>
    records(h).some((entry) => entry.kind === 'process.exit' && entry.code === 0), { limit: 120 })
  h.check('the renderer close flow survives the raw OSC 52 bytes', settled && exited)

  h.measure('B2-A copy source→decision→sink trace', JSON.stringify(records(h).filter((entry) =>
    ['fixture.ready', 'stdout.osc52', 'app.exit', 'fixture.settled', 'process.exit'].includes(entry.kind))))
  h.measure('OS-level clipboard verification', 'NOT_VERIFIED (no display / no clipboard helper in this environment)')
  finish(h)
}
