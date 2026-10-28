/**
 * The Host services every Remote-serving composition requires before any
 * additive Host row may mount.
 *
 * This is the shared contract between the M3 in-process runtime and the
 * M4-A0 Host-only process entry: both must prove the same production Host
 * prerequisite set is present before reporting readiness. Keeping the list in
 * one transport-neutral module prevents the two callers from drifting.
 *
 * @module app/remote/host-prerequisites
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Host services the ordinary Host Context must already expose before any
 * Remote Host row mounts. The check fails fast with the missing service named
 * instead of parking the runtime.
 */
export const REMOTE_HOST_PREREQUISITE_SERVICES = [
  'credentials',
  // The rc.2 user-questions service: `@deepseek-ai/dsh-base` already mounts
  // `id: user-questions -> @deepseek-ai/dsh-user-questions`, and this bundle
  // layers ON TOP of that base without disabling it, so the composition must
  // REUSE the existing service (its TypertRemoteService binding publishes the
  // `userQuestions` namespace and registers the `userQuestions` Session
  // projection every Client reads). Mounting a second one would double-register
  // the namespace and duplicate the projection unit.
  'userQuestions',
  'typert',
  'typertGateway',
  'agents',
  'agentDefaultModel',
  'attachments',
  'commands',
  // The OFFICIAL `@`-file reference provider (the TUI composition mounts the
  // `file-reference-local` row): the private `piTuiFileReferences` bare route
  // delegates to it, so a Host without it could not serve a bare Session `@`
  // query at all. Required rather than silently degraded.
  'fileReferences',
  'fs',
  // 0.2.1-rc.2's SessionController nests the official skill catalog, whose inject
  // requires the real `workingDirectory` owner: without it the `skills/list`
  // Remote never registers (the failure surfaces as a bare HTTP 404). The
  // official dsh-base layer mounts this row, so a Host missing it is a
  // composition error, not a degradable state.
  'workingDirectory',
  'llm',
  'sessions',
  'sessionProjections',
  'sessionQuery',
  'workspaceRegistry',
  'jobController',
  // The official Host file service the delivered-files preview reads through.
  // The bundle mounts it exactly once (its `cordis.patch.yml` row); a Host
  // without it cannot serve the preview at all, so this is a composition error
  // rather than a degradable state.
  'workspaceFiles',
] as const

/**
 * Fail fast when the ordinary Host lacks one of the required base services.
 * Reads via the reflect store so the diagnostic can name the missing key
 * without depending on any one service's shape.
 */
export function assertRemoteHostPrerequisites(hostContext: Context): void {
  for (const service of REMOTE_HOST_PREREQUISITE_SERVICES) {
    if (hostContext.reflect.get(service) === undefined) {
      throw new Error(`remote host runtime: the Host Context is missing the required "${service}" service`)
    }
  }
}
