/**
 * Visual preview of the editor `❯` prompt + the transcript user-role
 * styling — run inside a real TTY (tmux):
 *
 *   env -u NO_COLOR node --import tsx/esm scripts/preview-prompt.mts
 *
 * Shows a transcript mixing user / assistant / thinking / system rows and
 * alternates the editor between an EMPTY draft (the `❯ ` prompt with the
 * cursor block) and a multi-line draft (the prompt leads the first line,
 * continuation lines indent under it, exactly like the transcript rows).
 * `PREVIEW_HOLD_MS` controls how long it stays up (default 30s); Ctrl+C
 * also exits.
 * @module @xmoon76/dsh-pi-tui/preview-prompt
 */

import { ProcessTerminal } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'

const holdMs = Number(process.env.PREVIEW_HOLD_MS ?? 30000)

const terminal = new ProcessTerminal()
const app = new TuiApp(terminal, {
  onSubmit: () => {},
  onExit: () => {
    app.stop()
    process.exit(0)
  },
})
app.start()

// Transcript contrast: the user row is a brand-blue bubble (whole-row
// background + blue ❯), everything else (assistant / thinking / system)
// keeps its own distinct style.
app.setTranscript([
  {
    kind: 'user',
    turn: 0,
    // Long enough to wrap: the continuation must indent under the ❯.
    text: 'The startup fails with ENOTFOUND near line 42 of src/app.ts — I suspect an environment variable is missing, so please check the config load order and compare it against the .env.example keys and the docs.',
  },
  {
    kind: 'assistant',
    turn: 0,
    text: 'Let me check. **Config load order**:\n\n1. `.env` file\n2. Environment overrides\n3. Default fallbacks\n\n`ENOTFOUND` usually means DNS resolution failed — confirm whether you reach an internal registry or the public one.',
  },
  { kind: 'thinking', turn: 0, text: 'ENOTFOUND is a DNS issue; verify the config source before concluding.', running: false },
  { kind: 'system', turn: 0, label: 'AGENTS.md', text: 'Repo config conventions live in docs/config.md; env keys come from the preset.', summary: 'context rules' },
])

// Alternate the draft so both the empty prompt and the multi-line prompt
// (continuation indent) are visible without touching the keyboard.
let draftVisible = false
const flip = setInterval(() => {
  draftVisible = !draftVisible
  app.setDraft(draftVisible ? 'git status\npnpm test -- --filter @xmoon76/pi-tui' : '')
}, 6000)

setTimeout(() => {
  clearInterval(flip)
  app.stop()
  process.exit(0)
}, holdMs)
