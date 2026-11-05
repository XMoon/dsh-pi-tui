/**
 * One REAL installed-Host negative control: a disabled Host Runtime owner row
 * must refuse Ready and must not publish a Host identity.
 *
 * The installed candidate artifact itself is deliberately left in place; this
 * case proves the ROW-level fail-closed audit, not module absence (the full
 * lane keeps its own artifact-absence control). The case runs in its own work
 * root and creates/removes only its own overlay patch.
 *
 * @module split-process/host-runtime-disabled
 */

import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The fixed audit error a Host without the Host Runtime owner row must report. */
const HOST_RUNTIME_OWNER_AUDIT = /expected exactly one active piTuiHostRuntime owner row, found 0/u

/**
 * Disable the one built-in Host Runtime row after the Host-only overlay, then
 * boot the REAL installed Host entry from `base.env`.
 *
 * `failpoint` is the lane's own `SPLIT_PROCESS_SMOKE_FAIL_AFTER` control: the
 * case calls it exactly once, AFTER the Host spawned and BEFORE it waits for a
 * record, so the shared selected/full failure path can prove its cleanup.
 */
export async function runHostRuntimeDisabled({ EntryProcess, entries, base, workDir, dshHome, profilePackage, failpoint }) {
  const patchPath = join(workDir, 'host-runtime-disabled.patch.yml')
  writeFileSync(patchPath, '- id: split-host-pi-tui-runtime\n  disabled: true\n')
  const runRoot = join(dshHome, 'run', 'dsh-pi-tui')
  const hasPublishedIdentity = () => existsSync(runRoot)
    && readdirSync(runRoot, { recursive: true }).some(name => String(name).endsWith('instance.json'))
  try {
    // The ROW is what this control disables: the installed module artifact must
    // still be there, otherwise the claim would silently become artifact absence.
    assert(existsSync(join(profilePackage, 'dist', 'host-runtime.mjs')),
      'the Host Runtime artifact must stay installed when only its row is disabled')
    const host = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: patchPath },
    })
    failpoint('bootstrap.host-runtime-disabled.after-spawn')
    const failure = await host.waitFor(record => record.m4a0 === 'failure', 'T26 Host Runtime row disabled', 120_000)
    const exit = await host.waitForExit(60_000)
    assert(exit.code === 1, `T26 Host Runtime row disabled exit was ${JSON.stringify(exit)}`)
    assert(!host.records.some(record => record.m4a0 === 'ready'), 'T26 Host Runtime row disabled emitted ready')
    assert(HOST_RUNTIME_OWNER_AUDIT.test(String(failure.error)),
      `T26 Host Runtime row disabled: unexpected error ${String(failure.error)}`)
    assert(!hasPublishedIdentity(), 'T26 Host Runtime row disabled published a Host identity')
    return {
      exitCode: exit.code,
      readyEmitted: false,
      identityPublished: false,
      error: String(failure.error),
    }
  } finally {
    rmSync(patchPath, { force: true })
  }
}
