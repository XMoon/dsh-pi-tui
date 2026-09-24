/**
 * Selected-Job viewer tests (P1-B1): the viewer shell repaints the LATEST
 * detached snapshot supplied by the observation port (its refresh timer never
 * reads Host output), and closing it runs the single close path exactly once.
 * @module @xmoon76/dsh-pi-tui/job-output-viewer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { startApp } from './support/app-harness.ts'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')

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
    assert.match(strip(vt.getViewport().join('\n')), /waiting for the retained-output stream/)

    snapshot = 'completed\n\nbest-effort retained output preview (not a complete transcript):\n\nhello from the job'
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    await vt.waitForRender()
    const painted = strip(vt.getViewport().join('\n'))
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
