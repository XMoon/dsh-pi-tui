# Native Client public entry

`@xmoon76/dsh-pi-tui/native-client` is the typed, headless ESM entry for a
same-user local process that attaches to an already-running PiTUI daemon Host.
It is supported on Node 24, Linux and macOS with the exact qualified DSH
`0.2.2-rc.5` runtime and the existing `local/2` Host/Client contract. It does not
change the package-wide DSH floor or the Windows/TUI/ACP support matrix.

The entry imports inertly. It does not start a TUI, PTY, Web frontend, ACP
listener or Host, and it does not expose a Context, Store, Remote, Cookie,
registry path or filesystem credential.

## Attach and identity

```ts
import { attachNativeClient, NATIVE_CLIENT_API_VERSION } from '@xmoon76/dsh-pi-tui/native-client'

const client = await attachNativeClient({
  dshAnchor: '/absolute/path/to/node_modules/@deepseek-ai/dsh/package.json',
  profile: 'pi-tui',
  expectedScopeId: persistedScopeId,
  expectedInstanceId: persistedInstanceId,
  signal,
  onQuestion: async request => ({ answers: [{ id: request.questions[0].id, selected: ['Proceed'] }] }),
  onApproval: async () => 'allowed-once',
})
```

`NATIVE_CLIENT_API_VERSION` is `1`; it is independent of the Host wire version.
The DSH anchor must be the real installed `@deepseek-ai/dsh/package.json` for
the qualified runtime. The package root is derived from the installed Native
entry, not accepted from the caller. A missing Host, wrong scope/instance,
unsupported platform/runtime or pre-aborted signal fails before authentication.
One Node realm may have one pending or established Native Client; a second
attach fails with `NATIVE_CLIENT_REALM_BUSY`.

The returned identity contains the scope, instance, Host PID, real kernel birth
discriminator, protocol and DSH/PiTUI build facts. `status()` and
`subscribeStatus()` expose only connection/generation and identity facts; they
never return the Host home, origin, token, registry or credentials.

## Owned Session handles

```ts
const opened = await client.openSession(sessionId)
if (opened.kind !== 'ok') throw new Error('Session open failed')
const session = opened.value
const current = session.snapshot()
const page = await session.history({ maxMessages: 20 })
let unsubscribe = () => {}
unsubscribe = session.subscribe(change => {
  if (change.kind === 'ok' && change.value.reconcileRequired) unsubscribe()
})
const accepted = await session.prompt({
  content: [
    { type: 'text', text: 'Inspect this image' },
    { type: 'image', mediaType: 'image/png', bytes: pngBytes },
  ],
  mode: 'queue',
  signal,
})
if (accepted.kind !== 'accepted') throw new Error(accepted.message)
await session.close()
await client.close()
```

Every `openSession` call owns an independent retained reference. Closing one
handle never closes another handle for the same Session and never cancels or
stops the Host. `close()` is idempotent and returns the same settlement; a
failed Client-owned cleanup keeps the realm reservation occupied rather than
allowing a second composition over a partially disposed resolver.

The public operations are:

- `status`, `subscribeStatus`, `close`
- `listSessions`, `readSession`, `createWorkspace`, `createSession`,
  `openSession`
- `NativeSession.snapshot`, `history`, `subscribe`
- `prompt`, `cancel`, `updateQueue`, `rename`
- `configuration`, `selectModel`, `selectPreset`, `selectPermissionPreset`,
  `selectPlanMode`
- `commands`, `command`, `readFile`, `readAttachment`
- `observeJobs`, `observeSubagents`

`prompt` accepts ordered text, image and file bytes. Staging uses the official
Host upload/receipt path inside the same authorized request; there is no public
generic upload-receipt maker. Attachment reads accept only references from the
current Host Session's native content.

## Results and currentness

Business calls return `NativeResult<T>`:

- `ok` for a verified read or successful actual return;
- `accepted` for an official request acceptance, with the official request id;
- `committed` for a confirmed mutation commit;
- `not-dispatched` only when the call provably never left the Client;
- `rejected` for an authoritative refusal;
- `unknown` when dispatch or readback cannot prove the outcome; prompt unknowns
  retain the known request id;
- `unsupported`, `unavailable`, `stale` or `closed` for the exact real state.

A successful prompt acceptance is not a Turn terminal. Durable history and live
events carry the authoritative message/turn/seq join. Old generations, foreign
bindings and late answers are dropped; a missing history/live cut requires
reconciliation rather than a fabricated event. Calls never auto-retry.

Question requests use the official `question/detail/header/options/multiSelect/
intent` fields and answers use `selected` plus optional `custom`. Approval
callbacks return one of `allowed-once`, `rejected`, `cancelled` or `unavailable`.
Pending requests retain the native `callId`; close/abort/generation rollover
revokes late delivery.

## Official semantics and limits

- DSH owns API Peer issuance and socket claim/release. An unclaimed lightweight
  Peer issued before a lost `/connect` response may remain until Host shutdown.
  The Native entry does not compensate with an extra WebSocket, retry an unknown
  authentication exchange, maintain a Peer registry or claim global quiescence.
- Official `loadProfileDirectory` / runtime resolution may perform
  installation-owned profile normalization. Native attach does not initialize
  a profile, install dependencies, edit user configuration, credentials, plugin
  selection or Sessions, and does not alter the TUI's profile-loading path.
- `selectModel` uses official rc.5 Session selection. Its best-effort default
  model save is an accepted intrinsic side effect; API success means the Session
  selection was accepted, not that the global default save succeeded. PiTUI does
  not add a no-save option, restore the old default or perform unrelated global
  writes.
- Job and subagent APIs are read-only observations. They do not expose arbitrary
  job/child control, global subagent-settings writes or a new administration API.
