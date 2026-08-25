#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/release-notes — extract the bilingual release
 * notes for a version straight from the changelogs, never from commit
 * messages or AI summarization. Doubles as the release-metadata gate:
 *
 *   - the tag must be a `v`-prefixed version,
 *   - package.json `version` must equal the tag version,
 *   - CHANGELOG.md must contain a `## [<version>]` section,
 *   - CHANGELOG.en.md must contain the same section,
 *   - the two section headings (version + date) must match exactly.
 *
 * The notes file is written as `## 中文` / `## English` sections so the
 * GitHub Release body carries the human-written changelog verbatim.
 * @module release-notes
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [, , tag, output = 'release-notes.md'] = process.argv

if (!tag?.startsWith('v')) {
  throw new Error('Usage: node scripts/release-notes.mjs v<version> [output]')
}

const version = tag.slice(1)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

if (pkg.version !== version) {
  throw new Error(
    `Tag ${tag} does not match package.json version ${pkg.version}`,
  )
}

function extractSection(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)

  const prefix = `## [${version}]`

  const start = lines.findIndex(
    (line) => line === prefix || line.startsWith(`${prefix} - `),
  )

  if (start === -1) {
    throw new Error(`Version ${version} not found in ${file}`)
  }

  const heading = lines[start]

  let end = lines.length

  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      end = i
      break
    }
  }

  const content = compactListContinuations(
    lines
      .slice(start + 1, end)
      .join('\n')
      .trim(),
  )

  if (!content) {
    throw new Error(`Version ${version} is empty in ${file}`)
  }

  return {
    heading,
    content,
  }
}

/**
 * Fold a list item's wrapped continuation lines into single lines.
 *
 * The changelogs write each bullet as a wrapped paragraph (a `- ` line
 * followed by 2-space-indented continuation lines). GitHub's file viewer
 * folds those soft breaks, but its Release-body renderer turns them into
 * hard `<br>` breaks, so an extracted release body shows arbitrary line
 * breaks mid-sentence. Folding the continuations makes the Release body
 * render as one paragraph per bullet, matching the changelog file view.
 * Blank lines, headings, code fences and their contents are left alone.
 */
function compactListContinuations(content) {
  const lines = content.split('\n')
  const out = []
  let inCodeFence = false

  for (const line of lines) {
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence
      out.push(line)
      continue
    }
    if (inCodeFence) {
      out.push(line)
      continue
    }
    if (/^ {2}\S/.test(line) && /^\s*[-*]\s+\S/.test(out[out.length - 1] ?? '')) {
      out[out.length - 1] = `${out[out.length - 1].trimEnd()} ${line.trimStart()}`
      continue
    }
    out.push(line)
  }

  return out.join('\n')
}

const zh = extractSection('CHANGELOG.md')
const en = extractSection('CHANGELOG.en.md')

if (zh.heading !== en.heading) {
  throw new Error(
    `Changelog headings do not match:\n` +
      `  CHANGELOG.md:    ${zh.heading}\n` +
      `  CHANGELOG.en.md: ${en.heading}`,
  )
}

const notes = [
  `## 中文`,
  ``,
  zh.content,
  ``,
  `---`,
  ``,
  `## English`,
  ``,
  en.content,
  ``,
].join('\n')

writeFileSync(output, notes)

console.log(`Release notes: ${version}`)
console.log(`  zh: ${zh.heading}`)
console.log(`  en: ${en.heading}`)
console.log(`  output: ${output}`)
