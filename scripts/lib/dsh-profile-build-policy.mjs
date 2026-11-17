#!/usr/bin/env node
/**
 * The build-script decision every ISOLATED qualification profile needs before
 * it can install this package.
 *
 * `koffi` is the ONE native runtime dependency (Darwin kernel identity through
 * libproc). It declares an `install` script, and pnpm 12 turns an UNDECIDED
 * dependency build script into a hard `ERR_PNPM_IGNORED_BUILDS` failure — the
 * same policy the repository root already decides explicitly with
 * `allowBuilds.koffi: false` in `pnpm-workspace.yaml`.
 *
 * DENIED is the correct decision: node-koffi ships prebuilt platform binaries
 * as optional dependencies (`@koromix/koffi-darwin-arm64`, ...), and the build
 * script only compiles/verifies them. A real user installing the plugin through
 * `dsh plugin add` still gets the DSH build-approval flow; an ISOLATED
 * qualification profile must not depend on interactive approval, so the harness
 * records the same explicit decision here.
 *
 * @module scripts/lib/dsh-profile-build-policy
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

/** The explicit build-script decisions recorded in an isolated profile. */
export const PROFILE_ALLOW_BUILDS = Object.freeze({ koffi: false })

/** The profile fields the DSH plugin manager itself writes on first use. */
const PROFILE_BASE = Object.freeze({
  packages: ['.'],
  nodeLinker: 'hoisted',
  autoInstallPeers: false,
})

/**
 * Record {@link PROFILE_ALLOW_BUILDS} in one profile's `pnpm-workspace.yaml`,
 * preserving every existing field and every decision that is already present
 * (an explicit approval or denial is never overridden).
 *
 * @param {string} dshHome - the isolated DSH home.
 * @param {string} profile - the profile directory name (e.g. `pi-tui`).
 */
export function seedProfileBuildPolicy(dshHome, profile) {
  const directory = join(dshHome, 'profiles', profile)
  const path = join(directory, 'pnpm-workspace.yaml')
  const document = existsSync(path) ? (parse(readFileSync(path, 'utf8')) ?? {}) : { ...PROFILE_BASE }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`profile pnpm-workspace.yaml is not a mapping: ${path}`)
  }
  const allowBuilds = document.allowBuilds !== null && typeof document.allowBuilds === 'object' && !Array.isArray(document.allowBuilds)
    ? document.allowBuilds
    : {}
  let changed = document.allowBuilds !== allowBuilds
  for (const [name, decision] of Object.entries(PROFILE_ALLOW_BUILDS)) {
    if (Object.hasOwn(allowBuilds, name)) continue
    allowBuilds[name] = decision
    changed = true
  }
  document.allowBuilds = allowBuilds
  if (!existsSync(path) || changed) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, stringify(document))
  }
}
