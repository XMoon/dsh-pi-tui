/**
 * ClientActions (A5b-5, plan §A5b-5): the ONE owner of the client-local
 * platform policy the TuiApp events and the command surface consume.
 *
 * Locality: these are CLIENT-local capabilities by contract (plan A5b-5 /
 * docs/client-server-coupling.md) — the terminal clipboard, the OSC 52
 * sink and the external editor all belong to the user's own terminal, not
 * to the Host session. They therefore get NO invented Host semantic port;
 * they stay here and reach the rest of the application as one narrow owner
 * object.
 *
 * Ownership:
 *
 * - the clipboard command runner (`createClipboardRunner()`), the paste
 *   environment (`clipboardEnv`) and the copy executor/policy
 *   (`runCopyCommand` / `copyEnv`);
 * - the two copy-intent entry points that share that ONE policy
 *   (`copySelection` for the fullscreen drag selection and `/copy`,
 *   `readClipboardText` for the fullscreen right-click paste);
 * - the paste-media image probe (`readClipboardImage`);
 * - the external-editor action (`openExternalEditor`).
 *
 * The module imports no Host session/agent package and performs no Host
 * lookup. `@module @xmoon76/dsh-pi-tui/app/surface/client-actions`
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOsc52Sequence, copyToClipboard, type CopyEnvironment, type CopyExecutor } from '../../clipboard.ts'
import {
  commandOnPath,
  createClipboardRunner,
  readClipboardImage,
  readClipboardText,
  type ClipboardEnvironment,
  type ClipboardReadResult,
  type RunCommand,
} from '../../image/clipboard.ts'
import { parseShellWords } from '../../shell-words.ts'

/** The client-local platform policy as the rest of the application consumes it. */
export interface ClientActions {
  /** The bounded execFile runner shared by the paste probe and the copy path. */
  readonly runClipboardCommand: RunCommand
  /** The platform-aware paste environment (PATH-aware helper detection). */
  readonly clipboardEnv: ClipboardEnvironment
  /** The copy policy's executor (the text payload piped to the child stdin). */
  readonly runCopyCommand: CopyExecutor
  /** The copy policy's platform facts (the OSC 52 sink + helper detection). */
  readonly copyEnv: CopyEnvironment
  /** The fullscreen drag-selection / `/copy` intent (one shared policy). */
  copySelection(text: string): Promise<boolean>
  /** The fullscreen right-click clipboard text read. */
  readClipboardText(): Promise<string | undefined>
  /** One Ctrl+V clipboard image probe (text falls back to an editor insert). */
  readClipboardImage(): Promise<ClipboardReadResult>
  /** Open the external editor with the current draft and return the new text. */
  openExternalEditor(draft: string): Promise<string>
}

/** Create the client-local platform owner (no Host dependency). */
export function createClientActions(): ClientActions {
  /** The clipboard bridge (plan M3): a bounded execFile runner with a generous
   *  buffer (clipboard payloads can be multi-MB); `input` is piped to the
   *  child's stdin (issue #7 — the copy helpers read their payload from stdin). */
  const runClipboardCommand = createClipboardRunner()
  const clipboardEnv: ClipboardEnvironment = {
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    // PATH-aware helper detection — a bare existsSync only checks the CWD and
    // would declare installed wl-paste/xclip "missing" (review finding).
    exists: (command) => commandOnPath(command, process.env.PATH, process.platform),
  }
  /** Issue #7: the copy policy's executor — the same bounded execFile runner as
   *  the paste probe, with the text payload piped to stdin. */
  const runCopyCommand: CopyExecutor = (command, args, input) =>
    runClipboardCommand(command, args, { timeoutMs: 2000, input }).then(result => ({ code: result.code }))
  /** Issue #7: the copy policy's platform facts — the paste probe's environment
   *  plus the OSC 52 best-effort sink (a TTY-gated write; inside tmux the
   *  sequence rides a DCS passthrough so the terminal behind tmux receives it —
   *  kimi-code convention). */
  const copyEnv: CopyEnvironment = {
    platform: clipboardEnv.platform,
    env: clipboardEnv.env,
    exists: clipboardEnv.exists,
    isTTY: () => process.stdout.isTTY === true,
    writeOsc52: (text) => process.stdout.write(buildOsc52Sequence(text, (process.env.TMUX ?? '').length > 0)),
  }

  /**
   * The external editor action (plan M3): $VISUAL/$EDITOR may carry arguments
   * (`code --wait`, `vim -f`), parsed with a real shell-word parser, never a
   * plain split. The TUI stops before the call and restarts after it resolves.
   */
  const openExternalEditor = async (draft: string): Promise<string> => {
    const words = parseShellWords(process.env.VISUAL ?? process.env.EDITOR ?? 'vi')
    const [editor, ...editorArgs] = words
    if (editor === undefined) throw new Error('empty editor command')
    const file = join(tmpdir(), `dsh-pi-tui-${process.pid}-${randomUUID()}.md`)
    writeFileSync(file, draft, { mode: 0o600 })
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [...editorArgs, file], { stdio: 'inherit' })
        // A settled latch: `error` and `close` can both fire; the first outcome
        // wins, exactly like the local-shell cards.
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (error !== undefined) reject(error)
          else resolve()
        }
        child.on('error', (error) => finish(error))
        child.on('close', (code, childSignal) => {
          // Only a successful editor run may produce the draft: a non-zero exit
          // or a signal kill means the file is whatever the editor left behind,
          // not a deliberate edit.
          if (code === 0) {
            finish()
          } else if (childSignal !== null) {
            finish(new Error(`${editor} was killed by signal ${childSignal}`))
          } else {
            finish(new Error(`${editor} exited with code ${code}`))
          }
        })
      })
      // Read ONLY after the editor finished successfully (close, code 0).
      return readFileSync(file, 'utf8')
    } finally {
      // Cleanup runs on EVERY path, including a failed read.
      rmSync(file, { force: true })
    }
  }

  return {
    runClipboardCommand,
    clipboardEnv,
    runCopyCommand,
    copyEnv,
    copySelection: (text) => copyToClipboard(text, runCopyCommand, copyEnv),
    readClipboardText: () => readClipboardText(runClipboardCommand, clipboardEnv),
    readClipboardImage: () => readClipboardImage(runClipboardCommand, clipboardEnv),
    openExternalEditor,
  }
}
