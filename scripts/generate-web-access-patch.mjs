#!/usr/bin/env node
/**
 * Generate the bundle-layer declaration of the official Web roster.
 *
 * The rows are the SAME production table the private `piTuiWebAccess` Host
 * service toggles at runtime (`src/app/host/features/web-roster.ts`): the
 * generated patch is a packaging artifact, never a second authority. It is
 * generated instead of hand-written so the roster cannot drift between the
 * toggle and the Loader graph.
 *
 * The declaration lives in the BUNDLE (not in the Host-only command-line
 * overlay) because the official Settings/ConfigEditor only persists an entry
 * whose config is not overridden by a home patch or command-line overlay:
 * every Web row must be a profile-owned entry. Each row is inserted
 * `disabled: true`; only `PiTuiWebAccessHostService` flips it at runtime.
 *
 * Usage:
 *   node --import tsx/esm scripts/generate-web-access-patch.mjs          # regenerate
 *   node --import tsx/esm scripts/generate-web-access-patch.mjs --check  # parity only
 * @module generate-web-access-patch
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PI_TUI_WEB_ACCESS_ROWS } from '../src/app/host/features/web-roster.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const OUTPUT_PATH = join(PACKAGE_ROOT, 'generated', 'web-access', 'cordis.patch.yml')

const HEADER = `# GENERATED FILE — DO NOT EDIT.
#
# The official Browser Web roster, generated from the production table
# \`PI_TUI_WEB_ACCESS_ROWS\` (src/app/host/features/web-roster.ts) by
# \`scripts/generate-web-access-patch.mjs\`. The patch is declared in the BUNDLE
# so every row is a profile-owned Loader entry the official ConfigEditor may
# persist; the Host-only overlay only fixes the three non-user safety values.
# Every row starts disabled: only the private \`piTuiWebAccess\` Host service
# flips \`disabled\` at runtime, and a cold boot starts from this default unless
# \`pi-tui-web-preferences.autoStart\` enables the same rows before Ready.
`

function renderRow(row) {
  return [
    `    - id: ${row.id}`,
    `      name: '${row.name}'`,
    '      disabled: true',
    ...(row.inject === undefined ? [] : [`      inject: [${row.inject.join(', ')}]`]),
    ...(row.config === undefined
      ? []
      : ['      config:', ...Object.entries(row.config).map(([key, value]) => `        ${key}: ${String(value)}`)]),
    ...(row.yaml ?? []),
  ].join('\n')
}

/** The deterministic generated document (pure function of the roster). */
export function renderWebAccessPatch(rows = PI_TUI_WEB_ACCESS_ROWS) {
  return `${HEADER}- insert:\n${rows.map(renderRow).join('\n')}\n`
}

/** Regenerate, or compare the tracked artifact with the production roster. */
export function generateWebAccessPatch({ checkOnly = false } = {}) {
  const document = renderWebAccessPatch()
  if (checkOnly) {
    let current
    try {
      current = readFileSync(OUTPUT_PATH, 'utf8')
    } catch (error) {
      console.error(`GENERATE_WEB_ACCESS_PATCH_FAILURE: the generated patch is missing — run pnpm gen:web-access (${error.message})`)
      return 1
    }
    if (current !== document) {
      console.error('GENERATE_WEB_ACCESS_PATCH_FAILURE: generated/web-access/cordis.patch.yml drifted from the production roster — regenerate with pnpm gen:web-access and never hand-edit it')
      return 1
    }
    console.log(`generated/web-access: ${PI_TUI_WEB_ACCESS_ROWS.length} roster rows verified`)
    return 0
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, document, 'utf8')
  console.log(`generated/web-access: ${PI_TUI_WEB_ACCESS_ROWS.length} roster rows written`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = generateWebAccessPatch({ checkOnly: process.argv.includes('--check') })
}
