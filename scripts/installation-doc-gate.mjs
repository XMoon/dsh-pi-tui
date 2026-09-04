#!/usr/bin/env node
/**
 * Guard the user-facing installation guidance in both root READMEs and the
 * active compatibility instructions.
 *
 * The published TUI is installed into a DSH profile, never with a global npm
 * install. Stable and preview channels must remain visible in that order in
 * both language variants.
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
    requirements: '### 环境要求',
    pairing: '### DSH 与 TUI 版本对应（重要）',
    profile: '### Profile management',
    features: '## 功能',
    keys: '## 常用按键',
    source: '## 从源码运行',
    integration: '## DeepSeek Harness 集成',
    extension: '## Extension API',
    development: '## 开发',
    compatibility: '## DSH 兼容性与验证',
    sourceMode: '### Source Mode（仅验证）',
    ci: '### CI 验证策略',
    layout: '## 项目结构',
    docs: '## 文档',
    changelog: '## Changelog',
    license: '## License',
  },
  {
    name: 'README.en.md',
    install: '## Install into a DSH profile',
    stable: '### Stable / latest',
    preview: '### Preview / next',
    requirements: '### Requirements',
    pairing: '### DSH/TUI version pairing (important)',
    profile: '### Profile management',
    features: '## Features',
    keys: '## Common keys',
    source: '## Running from source',
    integration: '## DeepSeek Harness integration',
    extension: '## Extension API',
    development: '## Development',
    compatibility: '## DSH compatibility and validation',
    sourceMode: '### Source Mode (validation only)',
    ci: '### CI validation policy',
    layout: '## Repository layout',
    docs: '## Documentation',
    changelog: '## Changelog',
    license: '## License',
  },
]
const ACTIVE_FILES = [
  'docs/dsh-compatibility.md',
  'src/startup.ts',
  'scripts/dsh-runtime-boundary-smoke.mjs',
  'test/startup.test.ts',
  'test/dsh-runtime-boundary.test.mjs',
]
const SECTION_KEYS = [
  'install', 'stable', 'preview', 'requirements', 'pairing', 'profile',
  'features', 'keys', 'source', 'integration', 'extension', 'development',
  'compatibility', 'sourceMode', 'ci', 'layout', 'docs', 'changelog', 'license',
]
const STABLE_COMMAND = 'dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@latest'
const PREVIEW_COMMAND = 'dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next'
const required = [
  '@xmoon76/dsh-pi-tui@latest',
  '@xmoon76/dsh-pi-tui@next',
  'dsh plugin --profile',
]
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
  const positions = new Map(SECTION_KEYS.map((key) => [key, text.indexOf(definition[key])]))
  const stableSection = section(text, definition.stable, definition.preview)
  const previewSection = section(text, definition.preview, definition.requirements)

  check(!text.includes(forbiddenGlobalTuiInstall), `${definition.name}: forbidden global TUI install command`)
  for (const value of required) check(text.includes(value), `${definition.name}: missing ${JSON.stringify(value)}`)
  check(!text.includes('### npm'), `${definition.name}: legacy "### npm" heading remains`)
  check(occurrence(text, STABLE_COMMAND) === 1, `${definition.name}: stable profile command must occur exactly once`)
  check(occurrence(text, PREVIEW_COMMAND) === 1, `${definition.name}: preview profile command must occur exactly once`)

  for (const key of SECTION_KEYS) {
    check(occurrence(text, definition[key]) === 1, `${definition.name}: ${key} heading must occur exactly once`)
  }
  check(text.indexOf('![dsh-pi-tui]') < positions.get('install'), `${definition.name}: installation guidance must follow the screenshot`)
  check(positions.get('install') < positions.get('stable'), `${definition.name}: stable channel must be inside the installation section`)
  check(positions.get('stable') < positions.get('preview'), `${definition.name}: stable channel must precede preview channel`)
  check(positions.get('preview') < positions.get('requirements'), `${definition.name}: requirements must follow the adjacent preview channel`)
  check(positions.get('requirements') < positions.get('pairing'), `${definition.name}: pairing must follow requirements`)
  check(positions.get('pairing') < positions.get('profile'), `${definition.name}: profile management must follow pairing`)
  check(stableSection.includes(STABLE_COMMAND), `${definition.name}: stable profile command must be in Stable / latest`)
  check(previewSection.includes(PREVIEW_COMMAND), `${definition.name}: preview profile command must be in Preview / next`)
  check(positions.get('development') < positions.get('compatibility'), `${definition.name}: Source/CI details must be below development guidance`)

  const ordered = [
    'install', 'stable', 'preview', 'requirements', 'pairing', 'profile',
    'features', 'keys', 'source', 'integration', 'extension', 'development',
    'compatibility', 'sourceMode', 'ci', 'layout', 'docs', 'changelog', 'license',
  ]
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    check(positions.get(previous) >= 0 && positions.get(current) > positions.get(previous),
      `${definition.name}: section order is invalid (${previous} -> ${current})`)
  }
}

for (const relativePath of ACTIVE_FILES) {
  const path = join(ROOT, relativePath)
  const text = readFileSync(path, 'utf8')
  check(!text.includes(forbiddenGlobalTuiInstall), `${relativePath}: forbidden global TUI install command`)
}

for (const definition of README_FILES) {
  console.log(`ok  ${definition.name}`)
}
for (const relativePath of ACTIVE_FILES) {
  console.log(`ok  ${relativePath}`)
}
if (failures.length > 0) {
  console.error(`\ninstallation-doc-gate FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('installation-doc-gate passed')
