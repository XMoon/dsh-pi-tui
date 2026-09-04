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
    preview: '### Preview / next',
    features: '## 功能',
  },
  {
    name: 'README.en.md',
    install: '## Install into a DSH profile',
    stable: '### Stable / latest',
    preview: '### Preview / next',
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
const PREVIEW_COMMAND = 'dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next'
// Keep the exact forbidden command out of this source so the active-file scan
// cannot accidentally flag the guard itself.
const forbiddenGlobalTuiInstall = ['npm install -g', '@xmoon76/dsh-pi-tui'].join(' ')
const failures = []

function occurrence(text, marker) {
  return text.split(marker).length - 1
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker, start + startMarker.length)
  return start >= 0 && end >= 0 ? text.slice(start, end) : ''
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
  const stableSection = section(text, definition.stable, definition.preview)
  const previewSection = section(text, definition.preview, definition.features)

  check(!text.includes(forbiddenGlobalTuiInstall), `${definition.name}: forbidden global TUI install command`)
  check(occurrence(text, definition.install) === 1, `${definition.name}: installation heading must occur exactly once`)
  check(occurrence(text, definition.stable) === 1, `${definition.name}: Stable / latest heading must occur exactly once`)
  check(occurrence(text, definition.preview) === 1, `${definition.name}: Preview / next heading must occur exactly once`)
  check(occurrence(text, STABLE_COMMAND) === 1, `${definition.name}: stable profile command must occur exactly once`)
  check(occurrence(text, PREVIEW_COMMAND) === 1, `${definition.name}: preview profile command must occur exactly once`)
  check(text.indexOf('![dsh-pi-tui]') >= 0 && text.indexOf('![dsh-pi-tui]') < installAt,
    `${definition.name}: installation guidance must follow the screenshot`)
  check(installAt >= 0 && installAt < stableAt, `${definition.name}: Stable / latest must be in the installation section`)
  check(stableAt >= 0 && stableAt < previewAt, `${definition.name}: stable channel must precede preview channel`)
  check(previewAt >= 0 && previewAt < featuresAt, `${definition.name}: installation guidance must precede features`)
  check(stableSection.includes(STABLE_COMMAND), `${definition.name}: stable profile command must be in Stable / latest`)
  check(previewSection.includes(PREVIEW_COMMAND), `${definition.name}: preview profile command must be in Preview / next`)
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
