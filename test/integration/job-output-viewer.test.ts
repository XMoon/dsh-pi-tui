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

test('the fullscreen viewer bar runs Stop and Close through same-cell clicks with the LIVE capability', async () => {
  const { vt, app } = startApp(process.cwd())
  try {
    app.setFullscreen(true)
    await vt.waitForRender()
    const stopped: string[] = []
    let closed = 0
    let canStop = true
    app.openOutputViewer({
      title: 'bash · job-4',
      initial: 'running',
      refresh: () => 'running',
      onStop: () => { stopped.push('stop') },
      canStop: () => canStop,
      closeHint: 'back',
      onClose: () => { closed += 1 },
      intervalMs: 10,
    })
    await vt.waitForRender()
    const rows = (): string[] => vt.getViewport().map(strip)
    const barRow = (): number => rows().findIndex(line => line.includes('Back [Esc]'))
    const cellOf = (label: string): { row: number; col: number } => {
      const row = barRow()
      assert.ok(row >= 0, `the viewer bar is painted:\n${rows().join('\n')}`)
      const col = rows()[row]!.indexOf(label)
      assert.ok(col >= 0, `the ${label} affordance is painted:\n${rows().join('\n')}`)
      return { row, col }
    }
    const press = (label: string): { row: number; col: number } => {
      const cell = cellOf(label)
      vt.sendInput(`\x1b[<0;${cell.col + 1};${cell.row + 1}M`)
      return cell
    }
    const release = (cell: { row: number; col: number }): void => {
      vt.sendInput(`\x1b[<0;${cell.col + 1};${cell.row + 1}m`)
    }

    assert.match(rows().join('\n'), /Stop \[S\] · Back \[Esc\]/, 'the fullscreen bar is the clickable affordance row')

    // A Stop capability that is REVOKED between press and release refuses the
    // action: the release re-proves the live capability, never a cached bool.
    const revoked = press('Stop')
    canStop = false
    await new Promise(resolve => setTimeout(resolve, 40))
    await vt.waitForRender()
    release(revoked)
    await vt.waitForRender()
    assert.equal(stopped.length, 0, 'a revoke between press and release must refuse the Stop')
    assert.match(rows().join('\n'), /Back \[Esc\]/, 'the settled viewer still offers its close')
    assert.ok(!rows().join('\n').includes('Stop ['), 'the disabled Stop segment disappeared')

    // A same-cell Stop click runs the ORIGINAL tasks.stop sink exactly once.
    canStop = true
    await new Promise(resolve => setTimeout(resolve, 40))
    await vt.waitForRender()
    const stop = press('Stop')
    release(stop)
    await vt.waitForRender()
    assert.deepEqual(stopped, ['stop'], 'the fullscreen click ran the existing stop intent once')

    // The close verb runs the ONE requestClose/finalize path exactly once.
    const close = press('Back')
    release(close)
    await vt.waitForRender()
    assert.equal(closed, 1, 'the click closed the viewer through the single close path')

    // The Regular/Main surface keeps the historical keyboard-only hint and no
    // application mouse route.
    app.setFullscreen(false)
    await vt.waitForRender()
    let regularClosed = 0
    app.openOutputViewer({
      title: 'bash · job-5',
      initial: 'running',
      refresh: () => 'running',
      onStop: () => { stopped.push('regular-stop') },
      canStop: () => true,
      closeHint: 'back',
      onClose: () => { regularClosed += 1 },
      intervalMs: 10,
    })
    await vt.waitForRender()
    const regularRows = rows()
    const legacyRow = regularRows.findIndex(line => line.includes('S stop · Esc back'))
    assert.ok(legacyRow >= 0, `the Regular surface keeps its historical hint:\n${regularRows.join('\n')}`)
    const legacyCol = regularRows[legacyRow]!.indexOf('S stop')
    vt.sendInput(`\x1b[<0;${legacyCol + 1};${legacyRow + 1}M`)
    vt.sendInput(`\x1b[<0;${legacyCol + 1};${legacyRow + 1}m`)
    await vt.waitForRender()
    assert.equal(regularClosed, 0, 'a Regular/Main viewer never gains an application mouse route')
    assert.ok(!stopped.includes('regular-stop'), 'the Regular surface never runs Stop through a click')
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
