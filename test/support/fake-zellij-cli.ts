/**
 * A scripted `zellij` executable for the Zellij SIXEL version-gate tests.
 *
 * `zellijVersionEligible()` runs `execFileSync('zellij', ['--version'], …)`
 * with a 500 ms timeout and a 4096-byte ceiling. This fixture puts a real
 * executable first on PATH so the tests exercise that subprocess boundary and
 * can only control what the local program would print — never a pre-computed
 * "eligible" boolean.
 *
 * Evidence level: E2 adapter fixture (real executable, scripted stdout).
 * @module @xmoon76/dsh-pi-tui/test/support/fake-zellij-cli
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { TestContext } from 'node:test'
import { join } from 'node:path'
import { testLifecycle } from './temp-lifecycle.ts'

export interface FakeZellijCli {
  /** The environment to hand to the production version gate. */
  readonly env: NodeJS.ProcessEnv
  /** Every argv line the fake executable was invoked with. */
  calls(): string[]
  /** Replace what the program prints / how it behaves. */
  setReply(reply: { text: string; exitCode?: number; delayMs?: number }): void
  dispose(): void
}

const SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$ZELLIJ_FAKE_LOG"
if [ -f "$ZELLIJ_FAKE_ROOT/delay" ]; then
  exec sleep "$(cat "$ZELLIJ_FAKE_ROOT/delay")"
fi
if [ -f "$ZELLIJ_FAKE_ROOT/exit" ]; then
  exit "$(cat "$ZELLIJ_FAKE_ROOT/exit")"
fi
cat "$ZELLIJ_FAKE_ROOT/text"
`

/** Create an isolated fake `zellij` program; the default is a healthy 0.45.1. */
export function createFakeZellijCli(t: TestContext, versionText = 'zellij 0.45.1\n'): FakeZellijCli {
  const root = testLifecycle(t).tempDir('image-8-i8-5-zellij-')
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  const executable = join(binDir, 'zellij')
  writeFileSync(executable, SCRIPT)
  chmodSync(executable, 0o755)
  const logPath = join(root, 'calls.log')
  writeFileSync(logPath, '')

  const setReply = (reply: { text: string; exitCode?: number; delayMs?: number }): void => {
    writeFileSync(join(root, 'text'), reply.text)
    if (reply.exitCode === undefined) rmSync(join(root, 'exit'), { force: true })
    else writeFileSync(join(root, 'exit'), `${reply.exitCode}\n`)
    if (reply.delayMs === undefined) rmSync(join(root, 'delay'), { force: true })
    else writeFileSync(join(root, 'delay'), `${reply.delayMs / 1000}\n`)
  }
  setReply({ text: versionText })

  const cli: FakeZellijCli = {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      ZELLIJ_FAKE_ROOT: root,
      ZELLIJ_FAKE_LOG: logPath,
    },
    calls() {
      const text = readFileSync(logPath, 'utf8')
      return text === '' ? [] : text.split('\n').filter(line => line !== '')
    },
    setReply,
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  return cli
}
