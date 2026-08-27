/**
 * The Client-LOCAL file source for `/image` argument completion (plan
 * §13.2): the `@` mention is a HOST filesystem semantic reference and
 * goes through HostFilePort — `/image` is a Client-local file attachment
 * and must NEVER touch the Host filesystem. Both share the engine
 * (query/ranking/presentation) but keep their own discovery seam; this
 * module is the Client-local one under future remote attach.
 * @module @xmoon76/dsh-pi-tui/file-completion/local-file-source
 */

import type { DiscoverySource } from './discovery.ts'
import { resolveFdPath } from './discovery.ts'

/** The `/image` completion source: the Client's OWN filesystem, fd on the
 * CLIENT PATH when present. */
export class LocalFileSource implements DiscoverySource {
  private readonly fdPathValue: string | null

  /** @param fdPath - the Client's fd/fdfind executable; `undefined` (the
   *   default) probes PATH, `null` FORCES the bounded fallback (no fd), a
   *   string pins one finder. */
  constructor(fdPath: string | null | undefined = undefined) {
    this.fdPathValue = fdPath === undefined ? resolveFdPath() : fdPath
  }

  get fdPath(): string | null {
    return this.fdPathValue
  }
}
