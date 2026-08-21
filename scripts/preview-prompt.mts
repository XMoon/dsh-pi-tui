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
    text: '启动后报 ENOTFOUND，日志在 src/app.ts 第 42 行附近。我怀疑是环境变量没配对，帮我查一下配置加载顺序，顺便看下 .env.example 和文档里写的是不是一致。',
  },
  {
    kind: 'assistant',
    turn: 0,
    text: '我来排查。**配置加载顺序**：\n\n1. `.env` 文件\n2. 环境变量覆盖\n3. 默认值兜底\n\n`ENOTFOUND` 通常意味着 DNS 解析失败——先确认你连的是内网 registry 还是公网。',
  },
  { kind: 'thinking', turn: 0, text: 'ENOTFOUND 一般是域名解析问题，先看配置来源再给结论。', running: false },
  { kind: 'system', turn: 0, label: 'AGENTS.md', text: '本仓库配置约定见 docs/config.md，env 键统一走 preset。', summary: 'context rules' },
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
