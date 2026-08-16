#!/usr/bin/env node
/**
 * Convert a `tmux capture-pane -e` capture (ANSI SGR) into a standalone HTML
 * page that preserves the TUI's colors, for eyeballing themes outside a
 * terminal. Usage: node ansi2html.mjs <input.ansi> <output.html> [title]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [, , input, output, title = 'dsh-pi-tui capture'] = process.argv
if (!input || !output) {
  console.error('usage: ansi2html.mjs <input.ansi> <output.html> [title]')
  process.exit(1)
}

const raw = readFileSync(input, 'utf8')
// Strip non-SGR control sequences (cursor moves, clears, OSC) but KEEP SGR
// color sequences (they end in `m`; the class excludes M/m explicitly).
const cleaned = raw
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, '')

let fg = ''
let bg = ''
let bold = false
let dim = false
let italic = false
let underline = false
let strike = false

const applySgr = (codes) => {
  let i = 0
  const reset = () => {
    fg = ''; bg = ''; bold = false; dim = false; italic = false; underline = false; strike = false
  }
  while (i < codes.length) {
    const code = codes[i]
    if (code === 0) reset()
    else if (code === 1) bold = true
    else if (code === 2) dim = true
    else if (code === 3) italic = true
    else if (code === 4) underline = true
    else if (code === 9) strike = true
    else if (code === 22) bold = false
    else if (code === 23) italic = false
    else if (code === 24) underline = false
    else if (code === 29) strike = false
    else if (code === 39) fg = ''
    else if (code === 49) bg = ''
    else if (code === 38 && codes[i + 1] === 2) { fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4 }
    else if (code === 48 && codes[i + 1] === 2) { bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4 }
    else if (code === 38 && codes[i + 1] === 5) { fg = `ansi256(${codes[i + 2]})`; i += 2 }
    else if (code === 48 && codes[i + 1] === 5) { bg = `ansi256(${codes[i + 2]})`; i += 2 }
    else if (code >= 30 && code <= 37) fg = `ansi(${code})`
    else if (code >= 90 && code <= 97) fg = `ansi(${code})`
    else if (code >= 40 && code <= 47) bg = `ansi(${code})`
    else if (code >= 100 && code <= 107) bg = `ansi(${code})`
    i += 1
  }
}

const sgr = /^\x1b\[([0-9;]*)m/
let html = ''
let open = false
let pos = 0
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

while (pos < cleaned.length) {
  const match = cleaned.slice(pos).match(sgr)
  if (match) {
    const codes = match[1] === '' ? [0] : match[1].split(';').map(Number)
    applySgr(codes)
    if (open) { html += '</span>'; open = false }
    const styles = []
    if (fg) styles.push(`color:${fg}`)
    if (bg) styles.push(`background-color:${bg}`)
    if (bold) styles.push('font-weight:bold')
    if (dim) styles.push('opacity:0.62')
    if (italic) styles.push('font-style:italic')
    if (underline) styles.push('text-decoration:underline')
    if (strike) styles.push('text-decoration:line-through')
    if (styles.length > 0) {
      html += `<span style="${styles.join(';')}">`
      open = true
    }
    pos += match[0].length
    continue
  }
  const ch = cleaned[pos]
  if (ch === '\n') { if (open) { html += '</span>'; open = false } html += '\n' }
  else html += esc(ch)
  pos += 1
}
if (open) html += '</span>'

const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  body { background:#181818; color:#ccc; font-family:ui-monospace,Menlo,Consolas,monospace; margin:0; padding:16px; }
  h1 { font-size:14px; color:#888; font-weight:normal; margin:0 0 12px; }
  pre { background:#000; color:#E0E0E0; padding:12px; border-radius:6px; font-size:13px; line-height:1.35;
        white-space:pre; overflow:auto; width:max-content; min-width:min(90vw,1100px); }
  .wrap { display:flex; gap:24px; flex-wrap:wrap; }
  .shot { flex:1 1 640px; }
</style></head><body>
<h1>${title}</h1>
<pre>${html}</pre>
</body></html>`

writeFileSync(output, page)
console.log(`wrote ${output}`)
