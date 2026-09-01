#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/release-notes — extract the bilingual release
 * notes for a version straight from the changelogs, never from commit
 * messages or AI summarization. Doubles as the release-metadata gate:
 *
 *   - the tag must be `v<stable-version>` or `next-v<prerelease-version>`,
 *   - package.json `version` must equal the parsed tag version,
 *   - CHANGELOG.md must contain a `## [<version>]` section,
 *   - CHANGELOG.en.md must contain the same section,
 *   - the two section headings (version + date) must match exactly.
 *
 * The notes file is written as `## 中文` / `## English` sections so the
 * GitHub Release body carries the human-written changelog verbatim.
 * @module release-notes
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { parseReleaseTag } from './release-context.mjs'

const [, , input, output = 'release-notes.md'] = process.argv

if (input === undefined) {
  throw new Error('Usage: node scripts/release-notes.mjs <tag-or-version> [output]')
}

// CI passes the original tag after release-context has validated it; local
// invocations may pass either supported tag form (or a bare version). Re-use
// the same parser without making the `next-` prefix part of package SemVer.
const release = input.startsWith('v') || input.startsWith('next-')
  ? parseReleaseTag(input)
  : parseReleaseTag(input.includes('-') ? `next-v${input}` : `v${input}`)
const { channel, version } = release

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

if (pkg.version !== version) {
  throw new Error(
    `Release ${input} does not match package.json version ${pkg.version}`,
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

// The 0.4 migration changes the runtime pairing. Keep the copy-paste commands
// in both the changelog and the generated GitHub Release body; a release page
// that only says "upgrade" is not actionable enough to prevent a mixed install.
// The stable cutover has a different install channel and DSH baseline from the
// alpha train, so do not make a future stable release retain prerelease-only
// guidance by accident.
function containsExactGuidance(content, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![0-9A-Za-z.+-])`, 'u').test(content)
}

if (version.startsWith('0.4.')) {
  const requiredGuidance = channel === 'next'
    ? [
        '@deepseek-ai/dsh@0.1.2-alpha.3',
        '@xmoon76/dsh-pi-tui@next',
        '@xmoon76/dsh-pi-tui@0.3',
      ]
    : [
        '@deepseek-ai/dsh@0.1.2',
        '@xmoon76/dsh-pi-tui@latest',
        '@xmoon76/dsh-pi-tui@0.3',
      ]
  for (const command of requiredGuidance) {
    if (!containsExactGuidance(zh.content, command) || !containsExactGuidance(en.content, command)) {
      throw new Error(`Version ${version} must document ${command} in both changelogs`)
    }
  }
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
