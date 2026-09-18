#!/usr/bin/env node
/**
 * D2.4 entry point for the same-Host fork parity smoke.
 *
 * The D2.3 lifecycle smoke owns the shared Host/Client fixture and now also
 * exercises the official ClientSessions.fork path, so this entry point keeps
 * the D2.4 package command explicit without duplicating that fixture.
 */

await import('./dsh-remote-d2.3-parity-smoke.mjs')
