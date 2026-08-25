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

  const content = lines
    .slice(start + 1, end)
    .join('\n')
    .trim()

  if (!content) {
    throw new Error(`Version ${version} is empty in ${file}`)
  }

  return {
    heading,
    content,
  }
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
