/**
 * Shared Delivered-files fixtures (Delivered files PR1).
 *
 * The mounted PiTui product ALWAYS receives the bootstrap-injected read
 * capability, so a headless surface fixture that exercises the delivered tail's
 * disclosure/navigation contract must model that presence. These fixtures own no
 * application projection, so the stub returns no catalog and validates nothing.
 * @module @xmoon76/dsh-pi-tui/support/delivered-files
 */

import type { DeliveredFilesCapability, DeliveredFilesSnapshot } from '../../src/domain/deliverables/catalog.ts'

/** The capability stub: present (so the tail keeps its capped disclosure and
 *  `/deliverables` entry) but with no catalog behind it. */
export const deliveredFilesCapabilityStub: DeliveredFilesCapability = {
  snapshot: () => undefined,
  isCurrent: () => false,
}

/** One snapshot-backed capability over a fixed catalog, for fixtures that need
 *  the real reading path (currentness answers `true` until replaced). */
export function deliveredFilesCapabilityFor(
  snapshot: DeliveredFilesSnapshot,
): DeliveredFilesCapability & { readonly current: () => boolean; invalidate(): void } {
  let current = true
  return {
    snapshot: () => (current ? snapshot : undefined),
    isCurrent: (candidate) => current && candidate === snapshot,
    current: () => current,
    invalidate: () => { current = false },
  }
}
