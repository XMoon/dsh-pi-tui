/**
 * T18 entry admission: the role string alone is NOT Host-entry admission.
 *
 * Three REAL installed-profile controls, each starting the actual Host entry
 * from the isolated profile this case ran in:
 *   - a regular CLI that merely inherits `DSH_PI_TUI_ROLE=host` while the
 *     profile cannot mount the requested TUI surface must still fail loudly,
 *     and the Direct `--help` positive must stay green;
 *   - re-enabling the Host-only TUI row after the overlay must make the Host
 *     startup red (no ready, exit 1);
 *   - disabling the Host-only Connection owner row after the overlay must make
 *     the Host audit red as well.
 *
 * The profile patch and the two overlay patches this case writes belong to this
 * case alone: the profile manifest is restored in `finally` before the Direct
 * `--help` positive runs, and the overlay patches live inside this run's work
 * root. `ENTRY_ADMISSION_MUTATIONS` is exported because the whole-lane
 * `SPLIT_PROCESS_SMOKE_MUTATION` control reuses exactly these two faults.
 *
 * @module split-process/entry-admission
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { runDsh } from '../../lib/dsh-smoke-harness.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * The installed-profile mutations this case owns, keyed by the
 * `SPLIT_PROCESS_SMOKE_MUTATION` value that selects them whole-lane.
 */
export const ENTRY_ADMISSION_MUTATIONS = Object.freeze({
  'tui-enabled': Object.freeze({
    file: 'mutation-tui-enabled.patch.yml',
    body: '- id: tui-app\n  disabled: false\n',
  }),
  'connection-disabled': Object.freeze({
    file: 'mutation-connection-disabled.patch.yml',
    body: '- id: split-host-connection\n  disabled: true\n',
  }),
})

/**
 * Prove the three admission negatives on the REAL install, then leave the
 * profile and every overlay exactly as this case found them.
 */
export async function runEntryAdmission(context) {
  const { installation, EntryProcess, entries, base, workDir, trace, failpoint } = context
  const { dshInvocation: dsh, env, profileDir, manifest } = installation
  const tuiMutationPatch = join(workDir, ENTRY_ADMISSION_MUTATIONS['tui-enabled'].file)
  const connectionMutationPatch = join(workDir, ENTRY_ADMISSION_MUTATIONS['connection-disabled'].file)

  // T18 package shape: the installed candidate must keep its internal entries
  // and the one runtime dependency the Client reexec/transport actually uses.
  assert(manifest.dependencies?.ws === '8.21.3', 'T18 ws runtime dependency missing')
  assert(!Object.keys(manifest.exports ?? {}).includes('./local-host'), 'T18 public Host entry appeared')
  assert(!Object.keys(manifest.exports ?? {}).includes('./local-client'), 'T18 public Client entry appeared')

  // T18 negative control: the role string alone is not Host-entry admission.
  // A regular CLI that merely inherits DSH_PI_TUI_ROLE=host must still fail
  // loudly when its profile cannot mount the requested TUI surface. The
  // profile patch is temporary and is restored BEFORE the Host-only positive
  // test, so the overlay is the only tui-app-disable source there.
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  const previousProfilePatch = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : undefined
  try {
    writeFileSync(profilePatchPath, '- id: tui-app\n  disabled: true\n')
    const roleOnlyEnv = { ...env, DSH_PI_TUI_ROLE: 'host' }
    delete roleOnlyEnv.DSH_PI_TUI_HOST_ENTRY
    const roleOnly = runDsh(dsh, ['--profile', 'pi-tui'], profileDir, roleOnlyEnv, 120_000)
    const roleOnlyOutput = `${roleOnly.stdout ?? ''}\n${roleOnly.stderr ?? ''}`
    assert(roleOnly.status !== 0, 'an inherited DSH_PI_TUI_ROLE=host must not turn a missing TUI into success')
    assert(roleOnlyOutput.includes('required TUI surface did not mount'), 'inherited role hid the missing-surface verdict')
  } finally {
    if (previousProfilePatch === undefined) rmSync(profilePatchPath, { force: true })
    else writeFileSync(profilePatchPath, previousProfilePatch)
  }
  const help = runDsh(dsh, ['--profile', 'pi-tui', '--help'], profileDir, env, 120_000)
  assert(help.status === 0, `Direct --help failed: ${help.stderr}`)
  // Both T18 runtime checks above passed; only now is the combined PASS fact safe.
  trace('t18', { packageShape: 'internal entries only', directHelp: 'pass', roleOnlyNegative: 'pass' })

  // The running-state mutations below use real Host processes, not a unit fake.
  // (1) Re-enabling the Host-only TUI row after the overlay must make the
  // Host startup red; no ready record is allowed.
  writeFileSync(tuiMutationPatch, ENTRY_ADMISSION_MUTATIONS['tui-enabled'].body)
  const tuiMutation = new EntryProcess('host', entries.host, {
    ...base,
    env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch },
  })
  // The lane's own fail-after control: this case's single Hook fires while the
  // mutated Host is alive, so the shared failure path must still kill it.
  failpoint('bootstrap.entry-admission.after-spawn')
  const tuiMutationFailure = await tuiMutation.waitFor(record => record.m4a0 === 'failure', 'T01 mutation: TUI row re-enabled', 120_000)
  assert(/forbidden TUI\/Client-UI rows are not disabled: tui-app|TUI/u.test(String(tuiMutationFailure.error)), `T01 mutation: unexpected TUI failure ${String(tuiMutationFailure.error)}`)
  const tuiMutationExit = await tuiMutation.waitForExit(60_000)
  assert(tuiMutationExit.code === 1, `T01 mutation: TUI row re-enabled exit ${JSON.stringify(tuiMutationExit)}`)
  assert(!tuiMutation.records.some(record => record.m4a0 === 'ready'), 'T01 mutation: TUI row re-enabled emitted ready')
  trace('mutation-tui-enabled', { exit: tuiMutationExit.code, readyEmitted: false, error: String(tuiMutationFailure.error).slice(0, 160) })

  // (2) Disabling the Host-only Connection owner row after the overlay must
  // make the Host audit/startup red; T01/T02 could never turn green.
  writeFileSync(connectionMutationPatch, ENTRY_ADMISSION_MUTATIONS['connection-disabled'].body)
  const connectionMutation = new EntryProcess('host', entries.host, {
    ...base,
    env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch },
  })
  const connectionMutationFailure = await connectionMutation.waitFor(record => record.m4a0 === 'failure', 'T01 mutation: Connection row disabled', 120_000)
  assert(/connection owner row, found 0/u.test(String(connectionMutationFailure.error)), `T01 mutation: unexpected Connection failure ${String(connectionMutationFailure.error)}`)
  const connectionMutationExit = await connectionMutation.waitForExit(60_000)
  assert(connectionMutationExit.code === 1, `T01 mutation: Connection row disabled exit ${JSON.stringify(connectionMutationExit)}`)
  assert(!connectionMutation.records.some(record => record.m4a0 === 'ready'), 'T01 mutation: Connection row disabled emitted ready')
  trace('mutation-connection-disabled', { exit: connectionMutationExit.code, readyEmitted: false, error: String(connectionMutationFailure.error).slice(0, 160) })
}
