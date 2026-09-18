#!/usr/bin/env node
/**
 * D2.4 same-Host fork parity smoke.
 *
 * The D2.3 lifecycle smoke owns the shared Host/Client fixture and now also
 * drives the D2.4 Direct-vs-Host comparison: a real official Host with one
 * `ctx.workspaceRegistry`, two INDEPENDENT source Sessions (one for the
 * official `ClientSessions.fork` path, one for `DirectSessionLifecycle`), and
 * assertions that both adapters agree on the completed-turn boundary, child
 * lineage/metadata, inherited model selection and workspace membership, plus
 * the open-tail and not-found refusals. This entry point keeps the D2.4 package
 * command explicit without duplicating that fixture.
 */

await import('./dsh-remote-d2.3-parity-smoke.mjs')
