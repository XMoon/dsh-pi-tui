/**
 * A scripted `tmux` executable for the strict-admission tests.
 *
 * The production probe runs `execFileSync('tmux', fixedArgv, …)` and decides
 * from the RAW stdout of each query. This fixture puts a real executable first
 * on PATH, so the tests still exercise the real subprocess boundary (argv,
 * encoding, timeout, output ceiling) and can only control what the server
 * would have printed — never an already-computed admission decision.
 *
 * Replies can be keyed by the first argv token (the historical API) or by the
 * EXACT argv. The Image-8 tmux SIXEL probe issues two `display-message` calls
 * with different formats and one `show-messages` call, so a command-only key
 * would let one reply masquerade as another. Exact replies live in small
 * files and are matched by a POSIX shell loop: the fake stays a lightweight
 * executable so the production 500 ms probe bounds remain meaningful.
 * @module @xmoon76/dsh-pi-tui/test/support/fake-tmux-cli
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { TestContext } from 'node:test'
import { join } from 'node:path'
import { testLifecycle } from './temp-lifecycle.ts'

export type FakeTmuxCommand = 'show-options' | 'display-message' | 'list-clients' | 'show-messages'

export interface FakeTmuxReply {
  readonly text: string
  /** When set, the command exits non-zero without printing the text. */
  readonly exitCode?: number
  /** A real wall-clock delay the production timeout must abort. */
  readonly delayMs?: number
}

export interface FakeTmuxCli {
  /** The environment to hand to the production probe/factory. */
  readonly env: NodeJS.ProcessEnv
  /** Replace one command's raw stdout (and optional failure mode). */
  setReply(command: FakeTmuxCommand, reply: FakeTmuxReply): void
  /** Replace the reply for one EXACT argv (takes precedence over `setReply`). */
  setArgvReply(args: readonly string[], reply: FakeTmuxReply): void
  /** Read every argv line the fake executable was invoked with. */
  calls(): string[]
  dispose(): void
}

const SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_FAKE_LOG"
if [ -d "$TMUX_FAKE_ROOT/argv" ]; then
  i=0
  while [ -f "$TMUX_FAKE_ROOT/argv/$i.match" ]; do
    if [ "$(head -n 1 "$TMUX_FAKE_ROOT/argv/$i.match")" = "$*" ]; then
      if [ -f "$TMUX_FAKE_ROOT/argv/$i.delay" ]; then
        exec sleep "$(cat "$TMUX_FAKE_ROOT/argv/$i.delay")"
      fi
      if [ -f "$TMUX_FAKE_ROOT/argv/$i.exit" ]; then
        exit "$(cat "$TMUX_FAKE_ROOT/argv/$i.exit")"
      fi
      cat "$TMUX_FAKE_ROOT/argv/$i.text"
      exit 0
    fi
    i=$((i + 1))
  done
fi
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
 * Create an isolated fake tmux server environment whose default reply is a
 * Kitty-only topology. Native-SIXEL tests opt in through `setArgvReply`.
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
  const argvDir = join(root, 'argv')
  mkdirSync(argvDir)

  const argvReplies = new Map<string, { index: number }>()
  let nextArgvIndex = 0

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

  const writeReplyFiles = (base: string, reply: FakeTmuxReply): void => {
    writeFileSync(`${base}.text`, reply.text)
    if (reply.exitCode === undefined) rmSync(`${base}.exit`, { force: true })
    else writeFileSync(`${base}.exit`, `${reply.exitCode}\n`)
    if (reply.delayMs === undefined) rmSync(`${base}.delay`, { force: true })
    else writeFileSync(`${base}.delay`, `${reply.delayMs / 1000}\n`)
  }

  const cli: FakeTmuxCli = {
    env,
    setReply(command, reply) {
      const base = join(root, command)
      writeFileSync(base, reply.text)
      if (reply.exitCode === undefined) rmSync(`${base}.exit`, { force: true })
      else writeFileSync(`${base}.exit`, `${reply.exitCode}\n`)
      if (reply.delayMs === undefined) rmSync(`${base}.delay`, { force: true })
      else writeFileSync(`${base}.delay`, `${reply.delayMs / 1000}\n`)
    },
    setArgvReply(args, reply) {
      const key = args.join(' ')
      let entry = argvReplies.get(key)
      if (entry === undefined) {
        entry = { index: nextArgvIndex++ }
        argvReplies.set(key, entry)
        writeFileSync(join(argvDir, `${entry.index}.match`), `${key}\n`)
      }
      writeReplyFiles(join(argvDir, String(entry.index)), reply)
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
  cli.setReply('show-messages', { text: 'no messages\n' })
  return cli
}
