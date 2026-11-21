import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'
import { TuiTest } from '@microsoft/tui-test'

/**
 * Bottom-up engine probe: prove the native terminal backend can start a real
 * PTY, paint a frame, deliver a real Enter, and report a clean exit before any
 * Split business scenario relies on it.
 *
 * This is deliberately independent of the packaged candidate and the S0
 * fixture; it validates only the terminal engine on this OS.
 */
const engineRoot = join(process.cwd(), 'temp', 's0-terminal-engine')
mkdirSync(join(engineRoot, 'trace'), { recursive: true })
mkdirSync(join(engineRoot, 'artifacts'), { recursive: true })

test('the xtermjs engine paints a real PTY frame, accepts Enter, and reports a clean exit', async () => {
  const terminal = TuiTest.ephemeral('split-terminal-engine', {
    backend: 'xtermjs',
    trace: { mode: 'on-failure', directory: join(engineRoot, 'trace') },
    artifacts: { dir: join(engineRoot, 'artifacts'), onFailure: 'text' },
  })
  try {
    const program = [
      "process.stdout.write('S0_ENGINE_READY\\n')",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => { if (chunk.includes('s0-engine-ping')) { process.stdout.write('S0_ENGINE_PONG\\n'); process.exit(0) } })",
    ].join(';')
    await terminal.run(process.execPath, ['-e', program], {
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
      waitReady: false,
    })
    await terminal.getByText('S0_ENGINE_READY').expect()
    await terminal.type('s0-engine-ping')
    await terminal.press('Enter')
    await terminal.getByText('S0_ENGINE_PONG').expect()
    await terminal.waitExit()
    // For a `run()` session the native state carries the child's exit status;
    // getExitCode() only tracks shell-command execution.
    expect((await terminal.state()).exited).toBe(0)
  } finally {
    await terminal.closeQuiet()
  }
})

test('a missing terminal locator rejects with a diagnosable expectation error', async () => {
  const terminal = TuiTest.ephemeral('split-terminal-engine-negative', {
    backend: 'xtermjs',
    trace: { mode: 'on-failure', directory: join(engineRoot, 'trace') },
    artifacts: { dir: join(engineRoot, 'artifacts'), onFailure: 'text' },
  })
  try {
    await terminal.run(process.execPath, ['-e', [
      "process.stdout.write('S0_ENGINE_NEGATIVE_READY\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')], {
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
      waitReady: false,
    })
    await terminal.getByText('S0_ENGINE_NEGATIVE_READY').expect()
    await assert.rejects(
      terminal.getByText('S0_NEVER_PAINTED').wait({ timeout: 500 }),
      error => {
        assert.match(String(error), /S0_NEVER_PAINTED/u)
        return true
      },
    )
  } finally {
    await terminal.closeQuiet()
  }
})
