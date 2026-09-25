#!/usr/bin/env node
/**
 * Generate the package-local mirror of the official shipped agent-preset
 * declarations from `@deepseek-ai/dsh-web-app`'s exported preset patch
 * assets.
 *
 * DSH 0.1.7's (through 0.1.7-rc.2) `dsh.bundle.patch` only resolves
 * bundle-package-relative paths (`join(packageDir, file)`), so a bundle
 * cannot reference the web package's exported assets directly — this
 * generated mirror is the 0.1.7 compatibility packaging workaround for
 * that upstream packaging gap. The official package stays the SOLE source
 * of truth:
 *
 *  - this script copies the exported asset bytes verbatim (no edits, no
 *    local semantic divergence);
 *  - test/dsh-preset-parity.test.mjs fails on any byte drift between the
 *    mirror and the installed official package;
 *  - the mirror must never be hand-edited (see generated/dsh-presets/README.md).
 *
 * Remove this workaround once DSH ships a shared preset bundle or supports
 * cross-package patch references.
 *
 * Usage:
 *   node scripts/generate-dsh-presets.mjs          # (re)generate the mirror
 *   node scripts/generate-dsh-presets.mjs --check  # parity only, no writes
 * @module generate-dsh-presets
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const MIRROR_DIR = join(PACKAGE_ROOT, 'generated', 'dsh-presets')
const OFFICIAL_PACKAGE = '@deepseek-ai/dsh-web-app'
const PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

const README = `# Generated DSH preset mirror

The \`*.patch.yml\` files in this directory are GENERATED from the preset
patch assets exported by \`${OFFICIAL_PACKAGE}\` (see
\`scripts/generate-dsh-presets.mjs\`).

**DO NOT EDIT.** dsh-pi-tui does not own the shipped preset definitions:
\`pnpm build\` regenerates the mirror from the official package, and
\`test/dsh-preset-parity.test.mjs\` fails the suite on any byte drift.

This mirror exists only because DSH 0.1.7's (through 0.1.7-rc.2)
\`dsh.bundle.patch\` resolves bundle-package-relative paths and cannot
reference another package's exported assets. It is a recorded upstream
packaging gap — remove it when DSH ships a shared preset bundle or
cross-package patch references.
`

function fail(message) {
  console.error(`GENERATE_DSH_PRESETS_FAILURE: ${message}`)
  process.exit(1)
}

/** Resolve one officially exported preset asset to an absolute file path. */
function officialAssetPath(name) {
  const specifier = `${OFFICIAL_PACKAGE}/presets/${name}.patch.yml`
  try {
    return fileURLToPath(import.meta.resolve(specifier))
  } catch (error) {
    fail(`cannot resolve ${specifier} — is ${OFFICIAL_PACKAGE} installed? (${error.message})`)
  }
}

const checkOnly = process.argv.includes('--check')
mkdirSync(MIRROR_DIR, { recursive: true })

for (const name of PRESETS) {
  const source = officialAssetPath(name)
  const target = join(MIRROR_DIR, `${name}.patch.yml`)
  if (checkOnly) {
    let official
    let mirror
    try {
      official = readFileSync(source)
    } catch (error) {
      fail(`cannot read the official asset ${source}: ${error.message}`)
    }
    try {
      mirror = readFileSync(target)
    } catch (error) {
      fail(`the generated mirror ${target} is missing — run pnpm gen:dsh-presets (${error.message})`)
    }
    if (!official.equals(mirror)) {
      fail(`generated mirror ${name}.patch.yml differs from the official ${OFFICIAL_PACKAGE} asset — regenerate (pnpm gen:dsh-presets) and never hand-edit the mirror`)
    }
  } else {
    copyFileSync(source, target)
  }
}

if (!checkOnly) {
  writeFileSync(join(MIRROR_DIR, 'README.md'), README, 'utf8')
  console.log(`generated/dsh-presets: mirrored ${PRESETS.length} preset patches from ${OFFICIAL_PACKAGE}`)
} else {
  console.log(`generated/dsh-presets: byte parity with ${OFFICIAL_PACKAGE} verified (${PRESETS.length} files)`)
}
