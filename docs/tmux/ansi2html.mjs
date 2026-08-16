#!/usr/bin/env node
/**
 * Convert a `tmux capture-pane -e` capture (ANSI SGR) into a standalone HTML
 * page that preserves the TUI's colors, for eyeballing themes outside a
 * terminal. Usage: node ansi2html.mjs <input.ansi> <output.html> [title]
 * The conversion is exported so the color mappings are unit-testable
 * (`node --test ansi2html.test.mjs`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Standard 16-color ANSI palette (the common xterm values). */
const ANSI16 = [
  '#000000', '#CD0000', '#00CD00', '#CDCD00', '#0000EE', '#CD00CD', '#00CDCD', '#E5E5E5',
  '#7F7F7F', '#FF0000', '#00FF00', '#FFFF00', '#5C5CFF', '#FF00FF', '#00FFFF', '#FFFFFF',
]

/**
 * The xterm 256-color palette as CSS rgb: 0-15 are the ANSI 16, 16-231 the
 * 6x6x6 color cube (levels 0,95,135,175,215,255), 232-255 the grey ramp.
 */
export function ansi256ToRgb(index) {
  if (index >= 0 && index < 16) return ANSI16[index]
  if (index >= 16 && index <= 231) {
    const n = index - 16
    const level = (v) => [0, 95, 135, 175, 215, 255][v]
    const r = level(Math.floor(n / 36))
    const g = level(Math.floor((n % 36) / 6))
    const b = level(n % 6)
    return `rgb(${r},${g},${b})`
  }
  if (index >= 232 && index <= 255) {
    const grey = 8 + (index - 232) * 10
    return `rgb(${grey},${grey},${grey})`
  }
  return 'inherit'
}

/**
 * One SGR 16-color slot to a CSS color. Explicit ranges so bright BACKGROUND
 * codes (100-107) cannot fall into the bright-foreground branch (90-97):
 * 30-37 fg, 90-97 bright fg, 40-47 bg, 100-107 bright bg.
 */
function ansi16Color(code) {
  if (code >= 90 && code <= 97) return ANSI16[code - 90 + 8] // bright fg
  if (code >= 100 && code <= 107) return ANSI16[code - 100 + 8] // bright bg
  return ANSI16[code % 10] // 30-37 fg / 40-47 bg
}

/** Strip non-SGR control sequences (cursor moves, clears, OSC) but KEEP SGR
 * color sequences (they end in `m`; the class excludes M/m explicitly). */
function stripNonSgr(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, '')
}

/** Current SGR style state. */
export function freshStyle() {
  return { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, strike: false }
}

/** Apply one SGR parameter list to the style state (mutates the state). */
export function applySgr(state, codes) {
  let i = 0
  while (i < codes.length) {
    const code = codes[i]
    if (code === 0) {
      Object.assign(state, freshStyle())
    } else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4) state.underline = true
    else if (code === 9) state.strike = true
    else if (code === 22) {
      // 22 clears BOTH bold and dim/faint.
      state.bold = false
      state.dim = false
    } else if (code === 23) state.italic = false
    else if (code === 24) state.underline = false
    else if (code === 29) state.strike = false
    else if (code === 39) state.fg = ''
    else if (code === 49) state.bg = ''
    else if (code === 38 && codes[i + 1] === 2) {
      state.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`
      i += 4
    } else if (code === 48 && codes[i + 1] === 2) {
      state.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`
      i += 4
    } else if (code === 38 && codes[i + 1] === 5) {
      state.fg = ansi256ToRgb(codes[i + 2])
      i += 2
    } else if (code === 48 && codes[i + 1] === 5) {
      state.bg = ansi256ToRgb(codes[i + 2])
      i += 2
    } else if (code >= 30 && code <= 37) state.fg = ansi16Color(code)
    else if (code >= 90 && code <= 97) state.fg = ansi16Color(code)
    else if (code >= 40 && code <= 47) state.bg = ansi16Color(code)
    else if (code >= 100 && code <= 107) state.bg = ansi16Color(code)
    i += 1
  }
}

/** Render the current style as one CSS style attribute value ('' when plain). */
export function styleCss(state) {
  const styles = []
  if (state.fg) styles.push(`color:${state.fg}`)
  if (state.bg) styles.push(`background-color:${state.bg}`)
  if (state.bold) styles.push('font-weight:bold')
  if (state.dim) styles.push('opacity:0.62')
  if (state.italic) styles.push('font-style:italic')
  const decorations = []
  if (state.underline) decorations.push('underline')
  if (state.strike) decorations.push('line-through')
  if (decorations.length > 0) styles.push(`text-decoration:${decorations.join(' ')}`)
  return styles.join(';')
}

const sgr = /^\x1b\[([0-9;]*)m/
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Convert one ANSI capture into body HTML (exported for tests). */
export function convertAnsiToHtml(raw) {
  const cleaned = stripNonSgr(raw)
  const state = freshStyle()
  let html = ''
  let open = false
  let pos = 0
  while (pos < cleaned.length) {
    const match = cleaned.slice(pos).match(sgr)
    if (match) {
      const codes = match[1] === '' ? [0] : match[1].split(';').map(Number)
      applySgr(state, codes)
      if (open) {
        html += '</span>'
        open = false
      }
      const css = styleCss(state)
      if (css !== '') {
        html += `<span style="${css}">`
        open = true
      }
      pos += match[0].length
      continue
    }
    const ch = cleaned[pos]
    if (ch === '\n') {
      if (open) {
        html += '</span>'
        open = false
      }
      html += '\n'
    } else {
      html += esc(ch)
    }
    pos += 1
  }
  if (open) html += '</span>'
  return html
}

// CLI entry — only when run directly (the module is imported by the tests).
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [, , input, output, title = 'dsh-pi-tui capture'] = process.argv
  if (input && output) {
    const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  body { background:#181818; color:#ccc; font-family:ui-monospace,Menlo,Consolas,monospace; margin:0; padding:16px; }
  h1 { font-size:14px; color:#888; font-weight:normal; margin:0 0 12px; }
  pre { background:#000; color:#E0E0E0; padding:12px; border-radius:6px; font-size:13px; line-height:1.35;
        white-space:pre; overflow:auto; width:max-content; min-width:min(90vw,1100px); }
</style></head><body>
<h1>${title}</h1>
<pre>${convertAnsiToHtml(readFileSync(input, 'utf8'))}</pre>
</body></html>`
    writeFileSync(output, page)
    console.log(`wrote ${output}`)
  } else {
    console.error('usage: ansi2html.mjs <input.ansi> <output.html> [title]')
    process.exit(1)
  }
}
