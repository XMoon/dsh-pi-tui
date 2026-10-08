/**
 * The ONE private Remote contribution of the `@xmoon76/dsh-pi-tui` package.
 *
 * The rc.2 Typert registries key a contribution by PACKAGE IDENTITY — the Host
 * registry by `package#face`, the Client registry by the package alone — and
 * admit exactly one per key. Every private invocation this package owns must
 * therefore live in this single list: a second `TypertContribution` for the
 * same package fails at mount with
 *
 * ```text
 * typert: package face "@xmoon76/dsh-pi-tui#host" is already registered
 * typert: Remote package "@xmoon76/dsh-pi-tui" is already registered
 * ```
 *
 * (measured on the installed `@deepseek-ai/dsh-typert-registry@0.2.0-rc.2`;
 * see the R0 evidence in the Remote terminal-progress PR).
 *
 * Each feature still owns its OWN contract module (one source of truth for its
 * namespace/method/codecs); this module only composes their descriptor lists,
 * so a drift between the descriptors the Host registers and the Client mounts
 * remains impossible by construction.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-remote-contribution
 */

import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { PI_TUI_FILE_REFERENCES_LIST } from './pi-tui-file-reference-contract.ts'
import { PI_TUI_TERMINAL_PROGRESS_WATCH } from './pi-tui-terminal-progress-contract.ts'

/** The npm package that owns every private Remote invocation here. A test
 *  guards that it equals each contract module's own package constant. */
export const PI_TUI_REMOTE_PACKAGE = '@xmoon76/dsh-pi-tui'

/** The explicit Host contribution registered once with `ctx.typert.register`. */
export const PI_TUI_HOST_CONTRIBUTION: TypertContribution = {
  package: PI_TUI_REMOTE_PACKAGE,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [PI_TUI_FILE_REFERENCES_LIST, PI_TUI_TERMINAL_PROGRESS_WATCH],
}

/** The explicit Client contribution mounted once with `ctx.remote.$mount`. */
export const PI_TUI_CLIENT_CONTRIBUTION: TypertRemoteContribution = {
  package: PI_TUI_REMOTE_PACKAGE,
  descriptors: [PI_TUI_FILE_REFERENCES_LIST, PI_TUI_TERMINAL_PROGRESS_WATCH],
}
