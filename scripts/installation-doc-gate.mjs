#!/usr/bin/env node
/**
 * Guard the durable installation invariants in both root READMEs and the
 * active compatibility instructions.
 *
 * This gate intentionally does not prescribe the README information
 * architecture. It only protects the installation commands, their channel
 * order, and their placement before the feature documentation.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const README_FILES = [
  {
    name: 'README.md',
    install: '## 安装到 DSH Profile',
    stable: '### Stable / latest',
    preview: '### Next / Source Mode（仅验证）',
    features: '## 功能',
  },
  {
    name: 'README.en.md',
    install: '## Install into a DSH profile',
    stable: '### Stable / latest',
    preview: '### Next / Source Mode (validation only)',
    features: '## Features',
  },
]
const ACTIVE_FILES = [
  'docs/dsh-compatibility.md',
  'src/startup.ts',
  'scripts/dsh-runtime-boundary-smoke.mjs',
  'test/startup.test.ts',
  'test/dsh-runtime-boundary.test.mjs',
]
const STABLE_COMMAND = 'dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@latest'
const PREVIEW_COMMAND = 'pnpm compat:dsh:source -- --dsh-dir "$HOME/project/deepseek-harness"'
// Keep the exact forbidden command out of this source so the active-file scan
// cannot accidentally flag the guard itself.
const forbiddenGlobalTuiInstall = ['npm install -g', '@xmoon76/dsh-pi-tui'].join(' ')
const failures = []

function occurrence(text, marker) {
  return text.split(marker).length - 1
}

function markdownSubsection(text, startHeading) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === startHeading)
  if (start === -1) return ''

  const level = startHeading.match(/^#+/u)?.[0].length
  if (level === undefined) return ''

  const end = lines.findIndex((line, index) => {
    if (index <= start) return false
    const heading = line.match(/^(#{1,6})\s+/u)
    return heading !== null && heading[1].length <= level
  })
  return lines.slice(start, end === -1 ? lines.length : end).join('\n')
}

function check(condition, message) {
  if (!condition) failures.push(message)
}

for (const definition of README_FILES) {
  const path = join(ROOT, definition.name)
  const text = readFileSync(path, 'utf8')
  const installAt = text.indexOf(definition.install)
  const stableAt = text.indexOf(definition.stable)
  const previewAt = text.indexOf(definition.preview)
  const featuresAt = text.indexOf(definition.features)
  const stableSection = markdownSubsection(text, definition.stable)
  const previewSection = markdownSubsection(text, definition.preview)

  check(!text.includes(forbiddenGlobalTuiInstall), `${definition.name}: forbidden global TUI install command`)
  check(occurrence(text, definition.install) === 1, `${definition.name}: installation heading must occur exactly once`)
  check(occurrence(text, definition.stable) === 1, `${definition.name}: Stable / latest heading must occur exactly once`)
  check(occurrence(text, definition.preview) === 1, `${definition.name}: Next / Source Mode heading must occur exactly once`)
  check(occurrence(text, STABLE_COMMAND) === 1, `${definition.name}: stable profile command must occur exactly once`)
  check(occurrence(text, PREVIEW_COMMAND) === 1, `${definition.name}: Source Mode command must occur exactly once`)
  check(text.indexOf('![dsh-pi-tui]') >= 0 && text.indexOf('![dsh-pi-tui]') < installAt,
    `${definition.name}: installation guidance must follow the screenshot`)
  check(installAt >= 0 && installAt < stableAt, `${definition.name}: Stable / latest must be in the installation section`)
  check(stableAt >= 0 && stableAt < previewAt, `${definition.name}: stable channel must precede Source Mode channel`)
  check(previewAt >= 0 && previewAt < featuresAt, `${definition.name}: installation guidance must precede features`)
  check(stableSection.includes(STABLE_COMMAND), `${definition.name}: stable profile command must be in Stable / latest`)
  check(previewSection.includes(PREVIEW_COMMAND), `${definition.name}: Source Mode command must be in Next / Source Mode`)
}

for (const relativePath of ACTIVE_FILES) {
  const path = join(ROOT, relativePath)
  const text = readFileSync(path, 'utf8')
  check(!text.includes(forbiddenGlobalTuiInstall), `${relativePath}: forbidden global TUI install command`)
}

for (const definition of README_FILES) console.log(`ok  ${definition.name}`)
for (const relativePath of ACTIVE_FILES) console.log(`ok  ${relativePath}`)
if (failures.length > 0) {
  console.error(`\ninstallation-doc-gate FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('installation-doc-gate passed')
