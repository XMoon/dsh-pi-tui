/**
 * A scripted `tmux` executable for the strict-admission tests.
 *
 * The production probe runs `execFileSync('tmux', fixedArgv, …)` and decides
 * from the RAW stdout of each query. This fixture puts a real executable first
 * on PATH, so the tests still exercise the real subprocess boundary (argv,
 * encoding, timeout, output ceiling) and can only control what the server
 * would have printed — never an already-computed admission decision.
 * @module @xmoon76/dsh-pi-tui/test/support/fake-tmux-cli
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { TestContext } from 'node:test'
import { join } from 'node:path'
import { testLifecycle } from './temp-lifecycle.ts'

export type FakeTmuxCommand = 'show-options' | 'display-message' | 'list-clients'

export interface FakeTmuxReply {
  readonly text: string
  /** When set, the command exits non-zero after printing the text. */
  readonly exitCode?: number
  /** A real wall-clock delay the production timeout must abort. */
  readonly delayMs?: number
}

export interface FakeTmuxCli {
  /** The environment to hand to the production probe/factory. */
  readonly env: NodeJS.ProcessEnv
  /** Replace one command's raw stdout (and optional failure mode). */
  setReply(command: FakeTmuxCommand, reply: FakeTmuxReply): void
  /** Read every argv line the fake executable was invoked with. */
  calls(): string[]
  dispose(): void
}

const SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
out="$TMUX_FAKE_ROOT/$1"
if [ -f "$out.delay" ]; then
  # exec so the timeout kills this process directly; a shell parent would
  # leave an orphan sleep in the test runner's process group.
  exec sleep "$(cat "$out.delay")"
fi
if [ -f "$out.exit" ]; then
  exit "$(cat "$out.exit")"
fi
if [ -f "$out" ]; then
  cat "$out"
fi
`

/**
 * Create an isolated fake tmux server environment whose default reply is the
 * ONE admitted topology. The caller can mutate any reply to model a real server
 * state change between probes.
 */
export function createFakeTmuxCli(t: TestContext): FakeTmuxCli {
  const root = testLifecycle(t).tempDir('image-7ba-tmux-')
  const binDir = join(root, 'bin')
  mkdirSync(binDir)
  const executable = join(binDir, 'tmux')
  writeFileSync(executable, SCRIPT)
  chmodSync(executable, 0o755)
  const logPath = join(root, 'calls.log')
  writeFileSync(logPath, '')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    TMUX: '/tmp/fake-tmux,1234,0',
    TMUX_PANE: '%7',
    TERM: 'tmux-256color',
    PI_TUI_TMUX_KITTY_IMAGES: '1',
    TMUX_FAKE_ROOT: root,
    TMUX_FAKE_LOG: logPath,
  }
  delete env.ZELLIJ
  delete env.STY
  delete env.TERM_PROGRAM
  delete env.PI_IMAGE_PROTOCOL
  delete env.KITTY_WINDOW_ID
  delete env.PI_TUI_TMUX_KITTY_PLACEHOLDERS

  const cli: FakeTmuxCli = {
    env,
    setReply(command, reply) {
      const base = join(root, command)
      writeFileSync(base, reply.text)
      const exitPath = `${base}.exit`
      const delayPath = `${base}.delay`
      if (reply.exitCode === undefined) {
        if (existsSync(exitPath)) rmSync(exitPath)
      } else {
        writeFileSync(exitPath, `${reply.exitCode}\n`)
      }
      if (reply.delayMs === undefined) {
        if (existsSync(delayPath)) rmSync(delayPath)
      } else {
        writeFileSync(delayPath, `${reply.delayMs / 1000}\n`)
      }
    },
    calls() {
      const text = readFileSync(logPath, 'utf8')
      return text === '' ? [] : text.split('\n').filter((line) => line !== '')
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }

  cli.setReply('show-options', { text: 'all\n' })
  cli.setReply('display-message', { text: 'work\n' })
  cli.setReply('list-clients', {
    text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n',
  })
  return cli
}
