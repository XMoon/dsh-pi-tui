import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { expect, test } from 'vitest'
import { TuiTest as Terminal } from '@microsoft/tui-test'

import { createTestTempDir } from '../support/temp-lifecycle.ts'

/**
 * Bottom-up engine probe: prove the native terminal backend can start a real
 * PTY, paint a frame, deliver a real Enter, and report a clean exit before any
 * Split business scenario relies on it.
 *
 * This is deliberately independent of the packaged candidate and the split
 * fixture; it validates only the terminal engine on this OS.
 */
function requireSplitVitestTmpBase(): string {
  const raw = process.env.SPLIT_VITEST_TMP_BASE
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) {
    throw new Error('SPLIT_VITEST_TMP_BASE must be an absolute path')
  }
  const real = realpathSync(raw)
  const stats = statSync(real)
  if (!stats.isDirectory()) throw new Error(`SPLIT_VITEST_TMP_BASE is not a directory: ${real}`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`SPLIT_VITEST_TMP_BASE is not owned by this user: ${real}`)
  }
  if ((stats.mode & 0o777) !== 0o700) throw new Error(`SPLIT_VITEST_TMP_BASE must have mode 0700: ${real}`)
  return real
}

function prepareEngineRoot(): string {
  const root = createTestTempDir('split-terminal-engine-', requireSplitVitestTmpBase())
  try {
    mkdirSync(join(root, 'trace'), { recursive: true })
    mkdirSync(join(root, 'artifacts'), { recursive: true })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  return root
}

async function runEngineTest(
  terminalName: string,
  body: (terminal: Terminal, engineRoot: string) => Promise<void>,
): Promise<void> {
  const engineRoot = prepareEngineRoot()
  let terminal: Terminal
  try {
    terminal = Terminal.ephemeral(terminalName, {
      backend: 'xtermjs',
      trace: { mode: 'on-failure', directory: join(engineRoot, 'trace') },
      artifacts: { dir: join(engineRoot, 'artifacts'), onFailure: 'text' },
    })
  } catch (error) {
    rmSync(engineRoot, { recursive: true, force: true })
    throw error
  }

  let failure: unknown
  try {
    await body(terminal, engineRoot)
  } catch (error) {
    failure = error
  }

  let closeFailure: unknown
  try {
    await terminal.closeQuiet()
  } catch (error) {
    closeFailure = error
  }

  if (failure !== undefined || closeFailure !== undefined) {
    process.stderr.write(`[split-terminal-engine] retained failure diagnostics: ${engineRoot}\n`)
    if (failure !== undefined && closeFailure !== undefined) {
      throw new AggregateError([failure, closeFailure], 'split terminal engine test and terminal close both failed')
    }
    throw failure ?? closeFailure
  }

  if (process.env.DSH_TEST_KEEP_TMP === '1') {
    process.stderr.write(`[split-terminal-engine] keeping ${engineRoot} (DSH_TEST_KEEP_TMP=1)\n`)
  } else {
    rmSync(engineRoot, { recursive: true, force: true })
  }
}

test('the xtermjs engine paints a real PTY frame, accepts Enter, and reports a clean exit', async () => {
  await runEngineTest('split-terminal-engine', async terminal => {
    const program = [
      "process.stdout.write('SPLIT_ENGINE_READY\\n')",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => { if (chunk.includes('split-engine-ping')) { process.stdout.write('SPLIT_ENGINE_PONG\\n'); process.exit(0) } })",
    ].join(';')
    await terminal.run(process.execPath, ['-e', program], {
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
      waitReady: false,
    })
    await terminal.getByText('SPLIT_ENGINE_READY').expect()
    await terminal.type('split-engine-ping')
    await terminal.press('Enter')
    await terminal.getByText('SPLIT_ENGINE_PONG').expect()
    await terminal.waitExit()
    // For a `run()` session the native state carries the child's exit status;
    // getExitCode() only tracks shell-command execution.
    expect((await terminal.state()).exited).toBe(0)
  })
})

test('a missing terminal locator rejects with a diagnosable expectation error', async () => {
  await runEngineTest('split-terminal-engine-negative', async terminal => {
    await terminal.run(process.execPath, ['-e', [
      "process.stdout.write('SPLIT_ENGINE_NEGATIVE_READY\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')], {
      cwd: process.cwd(),
      cols: 100,
      rows: 30,
      waitReady: false,
    })
    await terminal.getByText('SPLIT_ENGINE_NEGATIVE_READY').expect()
    await assert.rejects(
      terminal.getByText('SPLIT_NEVER_PAINTED').wait({ timeout: 500 }),
      error => {
        assert.match(String(error), /SPLIT_NEVER_PAINTED/u)
        return true
      },
    )
  })
})
