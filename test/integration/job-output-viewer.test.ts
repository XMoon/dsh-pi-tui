/**
 * Selected-Job viewer tests (P1-B1): the viewer shell repaints the LATEST
 * detached snapshot supplied by the observation port (its refresh timer never
 * reads Host output), and closing it runs the single close path exactly once.
 * @module @xmoon76/dsh-pi-tui/job-output-viewer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { startApp } from '../support/app-harness.ts'
import { waitForFrame } from '../support/frame-wait.ts'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
const view = (vt: { getViewport(): string[] }): string => strip(vt.getViewport().join('\n'))

test('the viewer repaints the latest local observation snapshot, never a Host read', async () => {
  const { vt, app } = startApp(process.cwd())
  try {
    let snapshot = 'running — waiting for the retained-output stream'
    const close = app.openOutputViewer({
      title: 'bash · job-1',
      initial: snapshot,
      refresh: () => snapshot,
      intervalMs: 10,
    })
    await vt.waitForRender()
    assert.match(view(vt), /waiting for the retained-output stream/)

    snapshot = 'completed\n\nbest-effort retained output preview (not a complete transcript):\n\nhello from the job'
    // The refresh timer is the PRODUCTION trigger, never the test's success
    // condition: wait for the refreshed facts to be PAINTED. Each round is a
    // real rendered frame, so the wait is bounded by painted evidence instead of
    // a guess about how many ticks fit in 40ms.
    await waitForFrame(
      () => view(vt),
      frame => frame.includes('completed') && frame.includes('hello from the job'),
      () => vt.waitForRender(),
      'the refreshed viewer body never painted',
    )
    const painted = view(vt)
    assert.match(painted, /completed/)
    assert.match(painted, /hello from the job/)
    close()
    await vt.waitForRender()
  } finally {
    app.dispose()
  }
})

test('Esc closes the viewer through the single close path', async () => {
  const { vt, app } = startApp(process.cwd())
  try {
    let closed = 0
    app.openOutputViewer({
      title: 'bash · job-2',
      initial: 'running',
      refresh: () => 'running',
      closeHint: 'back',
      intervalMs: 10,
      onClose: () => { closed += 1 },
    })
    await vt.waitForRender()
    vt.sendInput('\x1b')
    await vt.waitForRender()
    assert.equal(closed, 1)
  } finally {
    app.dispose()
  }
})

test('hostile viewer title/body are projected at the TTY and keep whitelisted log SGR', async () => {
  const { vt, app } = startApp(process.cwd())
  try {
    const hostile = 'job '
      + '\u001b]52;c;YXR0YWNr\u0007'
      + '\u001b[?1049h'
      + '\u001b[2J'
      + '\u001b[38;2;999;1;1m'
      + '\u001b[38;5;196mred\u001b[0m'
      + '\r10%\r100%\n'
    const close = app.openOutputViewer({
      title: 'bash \u001b]0;PWNED\u0007· job-9',
      initial: hostile,
      refresh: () => hostile,
      intervalMs: 10,
    })
    await vt.waitForRender()
    const view = strip(vt.getViewport().join('\n'))
    const stream = vt.writes.join('')
    assert.ok(!stream.includes('YXR0YWNr'), 'no OSC 52 payload reaches the terminal stream')
    assert.ok(!stream.includes('PWNED'), 'no title OSC payload reaches the terminal stream')
    assert.ok(!stream.includes('\u001b[38;2;999;1;1m'), 'the malformed SGR is never forwarded')
    assert.ok(stream.includes('\u001b[38;5;196m'), 'the whitelisted SGR survives the viewer body')
    assert.ok(view.includes('10%') && view.includes('100%'), `CR frames read as records:\n${view}`)
    close()
    await vt.waitForRender()
  } finally {
    app.dispose()
  }
})
