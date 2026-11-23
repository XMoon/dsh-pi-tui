# Local ACP v1 Host front-door contract

This document owns the local ACP v1 listener transport, bounded protocol
admission, and ACP session-view behavior. It does not define a second Host,
Agent, Session or Writer: their authority remains in
[host-client.md](./host-client.md). Profile supervision belongs to
[host-daemon.md](./host-daemon.md).

## Trusted-profile ACP stdio bridge

The public `dsh --profile pi-tui acp stdio` command is the external-client
transport for the SAME Host-owned ACP front door. It is not a second Host,
Client, Agent, Session, Writer or ACP server. It uses the existing
`tuiDaemonStartup` launcher row and the same one-shot cold-ready lifecycle as
the daemon and Web management commands; its parent performs one read-only
authenticated Host observation and then spawns ONE internal Node process,
`dist/acp-stdio.mjs`, with inherited stdin/stdout/stderr.

- **Target authority.** The parent asks the existing authenticated snapshot /
  ACP status owner (`readSnapshot`, `observeAcpFacts`) whether THIS Profile has
  a ready Host with an enabled listener, then passes only that public logical
  Unix-socket path in the private child environment. It never auto-starts a
  Host, enables the listener, reads `daemon status` text, trusts `instance.json`
  alone or derives an endpoint from the Client cwd.
- **Pure byte relay.** The child imports Node builtins only and never imports
  the ACP SDK, Cordis, a Host service or Session code. It connects to the
  existing public UDS and pipes `stdin`/`stdout` bytes both ways; it performs
  no JSON-RPC method special-casing, second decode/encode, retry or Session
  cache. Linux uses the documented `/proc/self/fd/<scopeDirFd>/acp.sock`
  short alias when the logical scope path exceeds `sun_path`; macOS uses the
  Parent-provided short public path.
- **Lifecycle and errors.** The parent owns the one child and its `appExit`
  result. A missing/unready Host, disabled listener or unobservable status
  exits before the child is spawned with a fixed stderr code; adapter connect,
  socket and stdout errors stay confined to that child. Clean stdin EOF keeps
  the Host read direction open until the Host stream drains and ends. The
  Adapter never releases a Host Session/Agent/TUI; `session/close` remains a
  View detach owned by the existing listener contract.
- **Trusted Profile boundary.** The bridge does not sandbox or filter stdout
  written by arbitrary profile plugins during Profile Boot. The default
  trusted Profile bundle must remain protocol-clean; a user-added plugin that
  writes to stdout can contaminate the stream. There is no stdout wrapper,
  console interception, line filter or retry that would hide that configuration
  responsibility.

The public listener remains opt-in and default-OFF; the bridge is an explicit
external-client path to an already running Host, not the Host's startup
preference or an automatic Host service.

## Host-owned local ACP v1 front door (Unix socket)

Alongside the authenticated loopback carrier, the one Host process can open ONE
bounded ACP v1 front door over a pathname Unix domain socket on the ONE
platform-specific physical endpoint of its canonical profile scope. It is a
Host-owned ingress owned by the same Host entry that already holds the kernel
Host seat and the Ready commit; it is never a package export, a second Host, a
second Agent/Session owner, a TCP/HTTP endpoint, or an ACP byte stream on the
Host's stdout (the control records remain the only stdout format). The listener
is **OPT-IN and default-OFF**: a new Split Host binds no socket unless the
profile's independent `autoStart` preference enables it (see below).

- **One profile-scoped endpoint, two OS-specific physical paths.** The endpoint is
  deterministic from the canonical profile `scopeId` and the current OS UID; no
  environment variable, `$TMPDIR`, DSH home, user home or current directory may
  move it. Linux keeps the logical `<scope.dir>/acp.sock`; macOS needs a short
  Darwin pathname because `sockaddr_un.sun_path` is 104 bytes and there is no
  `/proc`, so the same profile scope publishes
  `/private/tmp/dpt-<decimal-uid>-<scope40>/acp.sock` (the first 160 bits of the
  canonical scope SHA-256). These are the same profile-scoped contract at two
  physical locations. An external advanced peer derives the local address from
  the official profile scope and UID and is still not authorized by a computed
  string: only a real `connect` + ACP `initialize` against the live Host counts.
  The strict `piTuiAcpAccess` status vocabulary remains `{state}` /
  `{state:'unavailable',reason}` and never carries a path or token, and there is
  no Remote field or TUI page for the endpoint. The ONE headless discovery
  surface is `daemon status` (see [Daemon management commands](./host-daemon.md#daemon-management-commands)): a proven
  `enabled` listener appends `acp=enabled` plus `acp-socket=<absolute public
  logical path>` — the already-public same-UID UDS contract endpoint only, never
  a Cookie, Host URL or private bind name — while `disabled` and every
  unprovable state print no path. A user directory long enough to hit
  `sun_path` does not change the printed logical endpoint: clients keep using
  the existing `/proc/self/fd/<scopeDirFd>/acp.sock` short alias, and the output
  path is never used to rebind or migrate the socket.

- **One read-only status observation for the management CLI.** The SAME Host
  publication registers ONE Owner-only authenticated
  `GET /api/pi-tui.acp-status` under the official Connection owner, with the
  same admission and publication lifetime as the identity echo and the
  workspace-object observation. It answers `{schema:1, instanceId, status}` from
  exactly ONE `controller.getStatus()` call with `application/json` and
  `cache-control: no-store`, and never mutates, caches or reflects a
  path/token. The `daemon status` reader accepts only HTTP 200, those exact
  media/cache headers, a bounded body (≤1024 bytes), `schema=1`, the SAME
  authenticated `instanceId` and the existing strict status DTO; everything
  else becomes the CLI's `unavailable`. It is not an ACP service, creates no
  controller and returns no path itself; the CLI derives the public endpoint
  from the authenticated profile scope.

- **One owner, one scope, two independent control facts.** A single
  Host-entry-owned runtime controller is the ONLY socket owner per Host profile.
  It is not a business Fiber, so a profile settings recomposition cannot dispose
  a live socket. Its live state is the authority the private `piTuiAcpAccess`
  Host service forwards (`getStatus` / `setEnabled`), and every call reads the
  CURRENT `net.Server` plus its own socket inode. Two facts never merge: the
  RUNTIME listener state (this controller) and the PROFILE `autoStart` preference
  (`pi-tui-acp-preferences.autoStart`, a durable next-launch value persisted
  through the ordinary revision-checked Settings user patch). Saving the
  preference never enables or disables a running Host, and toggling the runtime
  never rewrites the preference. Different canonical Host profiles keep their own
  scope and socket; the path is never derived from the Client cwd, `$PWD` or a
  guessed profile hash.
- **Unix socket only, private new files.** A scope directory THIS product
  creates is 0700; an existing user-chosen scope mode is neither rewritten nor
  used as an admission gate. The socket inode is owned by the current UID and
  forced to 0600 before Ready. There is no TCP/HTTP `/acp` port and no ACP JSON
  on the Host stdout.
  - **Linux.** The logical contract path stays `<scope.dir>/acp.sock`; the
    server is bound through a private `/proc/self/fd/<dirfd>/acp.sock` name so a
    long `DSH_HOME`/scope pathname still works, and the exact inode is published
    onto the logical path with a no-replace hard link. The inode stays in the
    scope, and the scope hash and `instance.json` schema are unchanged.
  - **macOS.** The trusted parent is `/private/tmp` (an OS-owned root uid with
    the sticky bit; never `$TMPDIR`, `DSH_HOME` or the user home). The one
    deterministic root `dpt-<decimal-uid>-<scope40>` is created 0700 by the
    current UID and REUSED across ACP Off/On and Host crashes; an existing
    symlink, non-directory, foreign-owned root or an existing directory that is
    not 0700 is refused and never written through or silently repaired. The server binds an owner-only private name under that root,
    forces it 0600, then publishes the same inode onto the public `acp.sock`
    with a kernel no-replace hard link and drops the private name. Both names
    must fit `sun_path[104]` including the trailing NUL; a pathname that cannot
    is `LOCAL_ACP_SOCKET_PATH_UNSUPPORTED` and no fallback root is searched.
    Node's server close can therefore only unlink the already-absent private
    name.
  - Retirement and crash recovery keep the existing exact-inode rule on BOTH
    platforms: only the saved `(dev,ino,uid)` socket inode of this listener is
    ever unlinked, so a foreign replacement at the public name survives.
- **Opt-in; bind before Ready only when enabled.** A new Split Host starts with
  the listener DISABLED and still publishes a normal Ready. When the profile's
  `pi-tui-acp-preferences.autoStart` is true the entry reads it after profile
  settlement and binds the socket BEFORE the `publishLocalHost` /
  `writeLocalRecord` Ready commit, so a published registry never points at a
  not-yet-listening socket. An `autoStart` bind failure (socket in use, unsafe
  inode, resource exhaustion) is ONE bounded, redacted `acp-autostart-unavailable`
  diagnostic that carries a fixed failure category plus the small state
  vocabulary — never an exception message, socket path or token — and the Host
  still publishes Ready with the listener in whatever state the controller
  truthfully reports. A corrupted `pi-tui-acp-preferences` section is a
  startup failure, never read as Off. At runtime, `setEnabled(false)` stops
  accepting, disconnects every already-connected ACP peer and removes only this
  process's owned socket inode; it never disposes a shared Agent, Session, Web,
  Gateway or Connection owner, and the TUI/Session/Agent/Web frontend/Host PID
  are untouched. `setEnabled(true)` re-binds the same socket through the SAME
  safety checks. A stop admitted while the listener is binding never emits Ready;
  the one official shutdown quiesces and closes the controller before it runs.
  A SIGKILL leaves a stale inode for the next seat winner's safe reclaim.
- **ACP v1 handshake and a connection-scoped shared Session View.** The
  listener supports ACP v1 only. It answers every valid integer
  `initialize.protocolVersion` — including a client that requests a higher
  version — with `protocolVersion: 1`; the client decides whether v1 is
  acceptable or disconnects. A second `initialize` on the same connection is
  rejected. A request to any registered Session handler before the handshake
  completes is JSON-RPC `-32600 Invalid Request`, refused by the pinned ACP SDK's
  own connection-initialization gate BEFORE this product's handler runs, so that
  pre-handshake path carries no `LOCAL_ACP_*` diagnostic data and has no Host
  side effect; after the handshake, unsupported Session operations keep their
  existing `LOCAL_ACP_SESSION_NOT_READY` business classification.
  The response names `agentInfo.name` `dsh-pi-tui` and `agentInfo.version` the
  installed `@xmoon76/dsh-pi-tui` bundle version — never the DSH engine version.
  `authMethods` stays empty. When the Host installs the shared Session View it
  advertises `sessionCapabilities: { resume: {}, close: {} }`, and it adds
  `loadSession: true` plus `sessionCapabilities.list: {}` ONLY when the official
  Session Controller authorization, Session Query canonical-history/title and
  Session-projection read seams are all bound (see
  [Official session facts on the stable v1 wire](#official-session-facts-on-the-stable-v1-wire)).
  It never advertises `delete`, `fork`, `additionalDirectories`, `systemPrompt` or
  `options`, and it does not expose client `fs`/`terminal` capabilities or issue
  those reverse requests. MCP capability is explicit:
  `mcpCapabilities: { http: false, sse: false }`; standard stdio MCP servers are
  `session/new`/`session/resume` inputs, not an HTTP/SSE capability. It does NOT
  advertise the optional `sessionCapabilities.options` capability: the standard
  config-option response/notification fields below are ordinary ACP v1 fields
  and do not require that negotiation.
  Inline image PROMPT capability is advertised only on that connection when the
  Host's boot-frozen Attachment Store and exact configured default model route
  explicitly declare image support; unknown services, route metadata or
  attachment media support are negative. The capability is frozen for the
  connection at `initialize`. Every image prompt is checked again against the
  exact attached Agent's current model route and is refused before Host dispatch
  unless that route explicitly declares image support. That capability governs
  CLIENT-to-Agent prompt images only: committed assistant/tool OUTPUT images come
  from the durable Session content and are never filtered by it. The View is a
  BORROW of the Host's own Agent and Session, never a second owner:
  - One physical ACP connection may borrow **up to eight** Host Sessions (one
    View per Session), and one Host Session carries **at most one** ACP View at
    a time across all connections, while any number of human Split TUI Clients
    may still reference the same Session. The eight-slot bound is this
    product's connection-local capacity policy, not an ACP v1 limit; a ninth
    `session/new|resume` is refused before any Host Session is created.
  - `session/new` treats the request `cwd` as a proposal only: the Host
    Workspace Controller validates/realpaths it into a `workspaceId`, the Host
    Session Controller creates ONE Session in that Workspace, and the official
    `resolveAgent` borrows the live Agent. The client cwd never becomes a Host
    directory authority, and one request performs exactly one creation (never
    auto-retried).
  - `session/resume` borrows the live Agent through the single official
    `resolveAgent` (live-first, one cold resume, concurrent-resume dedup). The
    request `cwd` never changes the Session cwd/model/workspace; a difference is
    only recorded as a fixed non-sensitive note. A second ACP connection for a
    Session already held is refused, and the TUI is never subject to that limit.
  - **Prompt content admission.** The attached View accepts standard ACP `text`,
    `resource_link`, and capability-negotiated `image` blocks in their original
    order. Adjacent text and resource links become ordered text content using the
    standard `[resource_link name=<JSON string> uri=<JSON string>]` literal;
    a resource URI is descriptive text, not authorization, and is never fetched
    or dereferenced by the Host. Embedded `resource`, `audio`, private file/upload
    blocks and unknown content fail closed. A prompt may contain non-whitespace
    text, an image, or both. A negotiated image must use a supported raster MIME;
    wire bytes, canonical Base64, actual media, count/size/pixel limits and durable
    references are validated by the official Host Session Controller and its
    Attachment Store, which are the sole image admission and persistence owners.
    The ACP adapter never writes a second attachment copy and durable Session
    messages contain image references, never Base64. Image capability is not
    inferred from a client declaration, an arbitrary available model or the TUI
    selection display.
  - `session/prompt` mints ONE stable `requestId`, submits exactly ONE official
    `SessionController.prompt` in queue mode, and correlates the real Host facts
    — `source.rpcId` at `agent/inbox/inserted`, the claimed turn of that exact
    message id (`agent/inbox/claimed`), the committed `data.turn` events and
    `turn/end` — before answering a real ACP StopReason (`end_turn` /
    `max_tokens`). The claimed turn's output reaches the client as standard
    `session/update` notifications in one ordered chain per flight, and the
    answer is sent after the turn's `turn/end` and the ordered notification
    drain. A turn that also claims another user's message (e.g. a TUI steer) is a
    MIXED turn: no further output is projected and the request fails closed with
    `LOCAL_ACP_PROMPT_MIXED_TURN`, never a fabricated success. The bounded
    per-connection output cap and the one-View-per-Session rule are unchanged.
    - **Human inbox sources.** A claim makes the owned turn MIXED only when the
      claimed message carries an official HUMAN source discriminant —
      `user` (an ordinary prompt) or `user-question-reply` (a late answer to a
      continued question, whichever owner submitted it). Every other source
      (`skill-invocation`, `time-context`, and every other Host/plugin context
      injection) is context, never a second person, and a `role: 'user'` field or
      the message text never substitutes for the discriminant.
    - **Provisional assistant stream.** The official process-local
      `agent/assistant-stream` frames of the EXACT attached Agent are the only
      provisional output source, and only for the flight's own already-claimed
      turn: `start.turn` must equal that turn, and every later `chunk`/`end`
      resolves through the attempt id the flight opened. `text-delta` becomes
      `agent_message_chunk` and `reasoning-delta` becomes `agent_thought_chunk`
      under ONE stable opaque ACP message id per attempt, handed to the same
      bounded ordered tail as committed output — so the first delta reaches the
      client BEFORE its durable `assistant/message` append, and a slow transport
      fails the one request instead of growing a second buffer. The official
      revision and per-attempt dense chunk index are validated strictly; a gap,
      an unrecognized chunk kind or a mismatched `block-end` assembly stops that
      attempt's deltas for good. `tool-call-delta` never fabricates a tool start:
      the durable `tool/call` event stays the only authority.
    - **Durable reconciliation by exact `seq`.** A committed `assistant/message`
      whose attempt was still streaming is appended to the tail as a
      reconciliation slot that waits for that attempt's official `end`. Only an
      `end` with `outcome.kind === 'committed'`, `eventType === 'assistant/message'`
      and the EXACT durable `seq` of that append may join; the committed
      text/thought blocks must then equal what was already delivered, block for
      block. A joined message adds only the durable blocks that were never
      streamed (images), under the same ACP message id, and never re-sends text.
      An attempt that delivered nothing falls back to the ordinary committed
      projection. Everything else — a mismatch, a missing `end` at `turn/end`, a
      replaced attempt, a retry, a provider that rewrites a block it already
      streamed, or provisional bytes that no durable append can be proven to
      match — fails closed with `LOCAL_ACP_PROMPT_STREAM_DIVERGENCE`. An `end` of
      `assistant/attempt` or an abandoned attempt closes the attempt and is never
      a turn terminal: the request still settles on the real `turn/end`.
    - **Unretractable provisional bytes poison the flight.** ACP v1 output is
      append-only, so bytes already shown cannot be withdrawn. The first attempt
      of the flight that DELIVERED text/thought and can never be joined to a
      durable message — an official retry (`assistant/attempt`), an abandoned
      attempt, a replacement, or a lost `end` at the real terminal — therefore
      ends this flight as `LOCAL_ACP_PROMPT_STREAM_DIVERGENCE`, even when a later
      attempt would have completed successfully and even when that later attempt
      streams nothing. No further attempt of a poisoned flight is streamed, and a
      poisoned flight can never answer `end_turn`/`max_tokens`; the durable
      message that a later attempt would have delivered is never reported. A
      genuinely failed, cancelled or interrupted turn keeps its own real
      classification instead of being rewritten as a divergence.
    - **Budget accounting at the join.** The pending-update budget charges the
      updates a task will actually hand to the transport, reserved before any
      await. A reconciliation whose blocks were all streamed reserves nothing —
      it only owns a tail position — while a message whose blocks were never
      streamed reserves every block (and a joined message reserves its durable
      images) before the first Store read.
    - **Wire order and identity of a joined message.** One attempt's streamed
      text/thought chunks and the residual durable blocks added at the join
      share ONE stable opaque ACP message id (the durable message id is used only
      for a message that was never streamed). Because ACP output is append-only,
      a durable block that could not be streamed — an image between two text
      blocks — is appended AFTER the text chunks that were already delivered, so
      the wire order of such a mixed message can differ from its committed block
      order. The committed order itself stays the durable log's and is never
      rewritten by this projection.
    - **Append-only limitation.** ACP v1 `agent_message_chunk` cannot be
      retracted. Provisional bytes already handed to the client stay delivered
      even when the attempt later fails or is retried; the View guarantees
      ownership isolation, that uncommitted output is never reported as
      committed, an accurate terminal classification, and no double delivery for
      one successful attempt. Rolling back displayed provisional bytes is outside
      the v1 protocol and is NOT claimed.
    - **Committed assistant/tool content.** An `assistant/message` keeps block
      order: non-empty text becomes `agent_message_chunk` text, reasoning becomes
      `agent_thought_chunk`, and an image becomes a standard `image` content
      block. An assistant `tool-call` block is never projected — the dedicated
      durable `tool/call` event is the only start update (with the committed
      `callId`/name and the parsed arguments, or the raw string when the model
      arguments are malformed). ONE committed `tool/result` becomes exactly ONE
      `tool_call_update` whose ordered `content` keeps every non-empty text and
      image and whose status is the official `isError ? failed : completed`;
      structured tool text such as a JSON payload sample is forwarded as its
      committed bytes, and the Host parses no domain JSON.
    - **Verified images only.** Every committed image is re-read through the SAME
      official Host `AttachmentStore.readImage(ref, signal)`. The wire `data` is
      exactly the verified stored bytes in canonical Base64 and `mimeType` is the
      verified stored media type; a stored `ref` is never trusted on its own. A
      missing Store, an absent object or a corrupt raster fails the flight with
      `LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED`: the event is never partially
      sent and no placeholder image is fabricated. A committed block type with no
      standard ACP projection (e.g. `file`/`tool-addition`) still fails
      `LOCAL_ACP_PROMPT_UNSUPPORTED_CONTENT` instead of being silently dropped.
    - **One async ordered tail per flight.** The synchronous committed-event
      callback appends the event's already shape-validated conversion to the
      flight's single output tail and reserves its bounded update count; the
      image reads and the notification sends run INSIDE that tail. A later
      committed event can never overtake an earlier one, one event's whole
      content is converted before its first chunk is sent, and the StopReason is
      answered only after `turn/end` AND the ordered drain. The tail never
      rejects unobserved: a real content/transport failure fails the one request
      (with `LOCAL_ACP_PROMPT_OUTPUT_FAILED` for delivery), and a closed flight
      drops only output it has not yet handed to the transport. The flight's own
      AbortSignal stops only ITS output IO on close/disconnect/Off/disposal/MIXED
      or a committed cancellation (queued removal or addressed running turn) — it
      never cancels or disposes the Host Agent. A committed cancellation therefore
      cannot be delayed by an in-flight Store read: the read is abandoned and the
      request still settles on the real Host terminal. A MIXED turn stops
      projecting from the moment the foreign claim is proven: an in-flight Store
      read is abandoned, notifications already handed to the transport stay
      delivered, a queued-but-unsent update is dropped, and the request fails
      closed with `LOCAL_ACP_PROMPT_MIXED_TURN`.
    - A completed turn needs NO visible assistant output: a tool-only (or a
      legitimately silent) `completed` turn answers `end_turn`, and any committed
      text/thought/image it did produce is still projected. A `max-tokens` turn
      answers `max_tokens`. Only a genuinely unsuccessful Host terminal answers a
      failure: `blocked`/`error`/`interrupted`/`aborted` keep
      `LOCAL_ACP_PROMPT_TURN_FAILED` (or the proven `cancelled`), and the Host
      `TurnEndReason` vocabulary this phase cannot prove (`refusal`,
      `max_turn_requests`) is never fabricated.
  - **Bounded input.** Text-only and unnegotiated connections retain the legacy
    1 MiB frame and 2 MiB unconsumed-input limits. An image-enabled connection
    derives its larger per-frame and unconsumed bounds from that Host's official
    boot-frozen `attachments.imageLimits` (Base64 expansion, preserved text/wire
    allowance, bounded per-image metadata and the JSON-RPC envelope). This
    transport budget is not an alternate image policy: business image byte,
    count, MIME and dimension limits remain the official Attachment Store's.
    Each socket has independent accounting and a breach closes only that
    connection; the reader assembles each fragmented NDJSON line with one
    concatenation rather than repeatedly copying the pending image frame.
  - **Bounded output.** Each connection bounds its own buffered output. Frames
    up to the legacy 256 KiB single-frame cap keep the original
    accept-then-resolve behavior under the same 256 KiB unwritten-backlog bound.
    When the Host mounts the official Attachment Store, the connection derives
    ONCE at establish time a larger single-frame budget from that Host's
    boot-frozen `attachments.imageLimits`. Each committed image is bounded by the
    Store's per-object admission ceiling (`maxImageBytes`) and is Base64-encoded
    ON ITS OWN, so the batch term sums the per-image encoded ceilings
    (`maxImagesPerMessage * (4 * ceil(maxImageBytes / 3))`) instead of taking one
    ceiling of a summed byte count; one 64 KiB metadata allowance per image, the
    JSON-RPC envelope and a preserved 1 MiB text allowance are added on top. The
    prompt-batch limit `maxMessageImageBytes` is NOT part of this derivation: it
    governs prompt admission, not a stored output image. That derivation is a
    TRANSPORT resource bound — never an image acceptance policy, never a reason
    to drop, shrink, re-encode or re-describe a committed image, and never
    derived from `initialize.promptCapabilities.image`. A frame above the legacy
    cap is written in 64 KiB chunks under the same unwritten-backlog bound,
    waiting at most 30 seconds per kernel drain.
    - **Accepted upstream limitation.** The official localization may store a
      normalized image whose bytes exceed both `maxImageBytes` and the
      normalization byte target (when every quality-ladder output misses the
      target the smallest output is kept), and the exposed
      `AttachmentStore.imageLimits` carries no stored-byte upper bound. The
      allowance therefore cannot guarantee that EVERY legal stored image is
      deliverable, and the Host does not claim it: a frame above the connection
      allowance fails closed as `LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE` BEFORE any byte
      of that frame is written. That failure never truncates, re-compresses,
      re-describes the image as Markdown/URL, invents a business image limit,
      adds a second Attachment Store, or affects the Host, an Agent, a Session,
      the TUI or another ACP connection. A true all-content guarantee requires an
      upstream DSH stored-byte contract, which this phase does not invent.
    - A reader that never drains is closed as `LOCAL_ACP_OUTPUT_BACKPRESSURE`; a
      socket close/error ends that drain wait immediately and keeps its real
      errno as the diagnostic. Every one of these affects ONLY that connection
      and never the Host, an Agent, a Session or a sibling connection.
  - **Session-only model configuration (ACP v1 subset).** An attached View
    exposes exactly two standard select options: `model` (`category:'model'`,
    value `JSON.stringify([providerId, modelId])`) and, only when the exact
    attached model declares non-empty official reasoning metadata,
    `thought_level` (`category:'thought_level'`, value
    `JSON.stringify(['default'])` or `JSON.stringify(['effort', effortId])`).
    Candidates come from the live Host `sessionController.modelCatalog()`
    provider groups and the current value comes from the exact attached
    Agent's `model.current()`, never from a client value, the catalog default
    or a TUI projection. A current route or explicit effort that the live
    catalog no longer advertises is presented as a non-submittable
    `Current (unavailable)` placeholder so the selector still shows the truth.
    `session/new` and `session/resume` may include the complete optional
    `configOptions` after the View attached; a genuine model-catalog
    unavailability omits only that optional display and keeps the committed
    Session/View success, logging one fixed
    `LOCAL_ACP_MODEL_CATALOG_UNAVAILABLE` code. A stale, closed or foreign View
    identity during that read is a lifecycle failure and propagates instead of
    falsely confirming an attachment. `session/set_config_option`
    is admitted only on the exact current View claim with no unsettled prompt
    flight, and only when the exact Agent's true idle phase can be taken through
    the official `runMaintenance`; all catalog and LLM-capability reads happen
    before that maintenance window. The write is ONLY the official Session
    `model/selection` through `AgentModel.select`; it never saves or changes the
    profile default, and the TUI's own `/model` / `Save as Default` behavior is
    untouched. A committed `model/selection` from any client produces one full
    `config_option_update` on the current View's connection only; a closed,
    detached or replaced View receives none. There is no general `mode`/`config`
    namespace and no client-supplied setup options.
  - **Agent-scoped stdio MCP declarations.** `session/new` and `session/resume`
    accept the standard ACP v1 `mcpServers` list only for the stdio transport;
    `initialize` keeps `mcpCapabilities.http=false` and `sse=false`, and every
    HTTP/SSE/ACP-transport declaration is rejected before any Host create or
    child start. The trust boundary is the same-UID, explicitly enabled local
    Host ACP Unix socket: the declaration is the local user's instruction to
    start that command for this Session, never a Client-selected Host role.
    The Host validates the complete list synchronously before any Workspace,
    Session or process action: at most 4 servers per Session; non-empty
    `name` normalized with the official ACP rule and duplicate normalized
    names rejected; absolute `command` without NUL; string `args` without NUL;
    ordered `{name,value}` environment entries with no empty/`=`/NUL name, no
    NUL value and no duplicate name (the environment map never participates
    in object-prototype lookup). `session/new` runs the child with the exact
    Session's registered `header.cwd`; `session/resume` always keeps the old
    Session cwd and treats a request cwd difference as a diagnostic only.
    The MCP client is mounted on the EXACT borrowed Agent's official Cordis
    context during its true idle maintenance phase, so it is Agent-local: the
    same Agent's human TUI can call the tools, another Agent cannot see them,
    and this never writes Profile Settings or registers with the Host-global
    MCP manager. Each activation is ordered and bounded: one explicit startup
    budget covers transport startup plus initial tool sync, and a
    request/connection abort disposes the pending Fiber rather than leaving a
    stale future. The Host waits for the first connection and tool discovery,
    then reads the official Agent/global tool definitions; any new tool name
    equal to an existing global or Agent tool, or to an earlier server in this
    request, fails the whole admission closed and disposes every created Fiber
    in reverse order INSIDE the same maintenance window, before the Agent can
    wake queued TUI work. A partially failed
    request never leaves a published tool or an owned child behind; an
    unconfirmed cleanup keeps the exact claim fenced. If `session/new` already
    created its Host Session before the MCP start fails, the error carries that
    authoritative `sessionId`; the Host never creates a second Session or
    claims the first one does not exist. A busy Agent refuses the mount with a
    stable `LOCAL_ACP_MCP_AGENT_BUSY` result without interrupting TUI work.
  - **MCP lease ownership and terminal facts.** The View claim is the single
    owner of its Agent-scoped MCP lease; there is no second registry or
    manager. `session/close`, a physical socket end/error, runtime Off and
    Agent disposal all commit the same retirement intent. While a TUI Tool or
    Turn that can execute those tools is still live, `{}` means only that the
    ACP View detached: the Session, Agent and MCP child remain alive and the
    claim stays fenced until the exact Host terminal facts settle. Retirement
    then waits for whole-Agent quiescence, regains the true idle maintenance
    phase, disposes only its exact Fibers in reverse order and requires the
    official `closeConfirmed` closure and tool-name absence before releasing
    the claim. `close {}` never claims that a child process was killed at that
    instant; an unconfirmed terminal keeps the fence and refuses a second View
    on that Session instead of failing open.
  - `session/close` detaches ONLY this connection's exact View/reservation: it
    never disposes, flushes or resumes the Agent/Session, so a TUI referencing
    the same Session keeps working and a later connection may resume again.
    An unknown, inactive or foreign Session close is the standard empty `{}`
    with no Host side effect. With an open prompt flight, an owned close first
    performs the scoped cancellation below and settles before detaching; a
    repeated close on the same owned View is idempotent. A close that cannot
    prove its owned unsettled obligation's terminal remains fail-closed and is
    never reported as a successful detach.
  - A physical socket end/error/destroy, runtime Off or Host shutdown retires
    the network connection immediately and drives the scoped-cancellation
    contract below for EVERY View slot on that socket, never only a last-used
    Session. Pending admission retains the request identity, claim and fact
    observer so a late insertion is still cancelled exactly. A claim is
    released only after proven Host settlement, or after classified admission
    on the exact Host identity proves there was no inserted message. The
    Session, Agent and writer keep their Host authority; a pending
    create/resume whose connection closed never publishes an attached View.
  - `session/list`, MCP prompts and ACP file/artifact transfer are NOT provided
    by this View and fail closed with their stable `LOCAL_ACP_*` code.
  - **Scoped cancellation (PO-3B).** `session/cancel` addresses ONLY this
    connection's own unsettled prompt flight, decided from authoritative Host
    facts — never an Agent-global cancel, a status/timing guess or an
    AbortSignal:
    - an idle View (or a Session this connection does not hold) is a no-op with
      no Host side effect while another owner's turn keeps running;
    - a QUEUED own message is cancelled by the official synchronous exact
      `inbox.remove(messageId)` on the still-exact Agent/Session (the durable
      `agent/inbox/spliced {outcome:'canceled'}` is the proof), and the request
      answers `cancelled` only after the admission path is classified;
    - a RUNNING own turn is cancelled only when the official current-turn
      fence still points at that exact turn in the same Host callback stack
      (`agent.cancel({kind:'user'}, {keepInbox:true})`); the request answers
      `cancelled` only after that turn's real
      `turn/end {reason:{kind:'aborted',reason:{kind:'user'}}}` plus the
      ordered notification drain. A turn that already reached its real terminal
      keeps its real result (`end_turn`/`max_tokens`/the true failure);
    - a MIXED turn (the ACP message and another user's message claimed into
      the same turn) is NEVER Agent-cancelled: the request keeps its
      `LOCAL_ACP_PROMPT_MIXED_TURN` failure. A turn already open when the ACP
      flight begins retains its original approval owner when the ACP message
      is later steered into it; claiming that message does not transfer the
      whole turn to ACP;
    - a cancellation that cannot prove either fact fails closed with
      `LOCAL_ACP_PROMPT_CANCEL_UNCONFIRMED` instead of fabricating `cancelled`.
    `session/close` with an open flight performs the SAME scoped cancellation
    and detaches only after the proven settlement; the prompt's own outcome is
    NOT the close proof — a mixed/failed turn that reached its durable
    `turn/end` (or whose exact Agent was disposed) lets the close detach
    truthfully while the prompt keeps its real error, and a close that could
    not prove a settlement reports that failure and is re-evaluated on the
    then-current facts by a later close (never a fabricated success, never a
    swallowed failure). An UNPROVEN cancellation — a stale exact identity that
    may hide a pending message or a running turn — is never converted into a
    successful detach by later closes, physical disconnect or subscription
    retirement: the reservation keeps ONE transient unclaimed-Host-obligation
    record (the exact request id, the official inserted message id once known,
    and the admission classification) and survives until a real terminal fact
    settles it — an exact queued removal, an exact Host state checkpoint after
    a discard, the message being claimed into a turn whose own terminal then
    ends the fence, or the exact Agent's disposal. `agent/inbox/discarded`
    alone is not terminal: official queue edits and steering can remove and
    reinsert the same id within one synchronous mutation. The notice schedules
    one microtask past that mutation stack, then reads the exact live
    Agent/Session and both official Inbox lists and checks the message's
    official claimed-turn facts. Pending retains the responsibility; claimed
    retains the turn fence; only absent with no claim and still-exact identities
    proves removal. A stale identity leaves the responsibility unconfirmed.
    This checks lifecycle state, not the provenance of a queue action. A real
    external removal also settles an active queued prompt as `cancelled` after
    admission classification and output drain; edit/steer must not settle it.
    While that record is open, a new prompt is refused with
    `LOCAL_ACP_PROMPT_IN_FLIGHT`. A physical disconnect drives the same scoped
    cancellation for the durable message fact. If admission is still pending,
    its request identity and responsibility survive for late insertion. A
    classified admission with no inserted message on the exact Host identity
    can fail closed and release; loss of the transport alone cannot prove that
    condition.
  - **Approval ownership (PO-3B).** The official Agent-scoped
    `approval/request` waterfall has exactly ONE classification seat ahead of
    the TUI forwarding listener. The classifier matches the exact Agent and
    official open turn against the live flight or its transient retired-turn
    fence, retaining the responder that owned an already-open turn when the
    exact ACP message entered it. A turn originating from ACP is answered ONLY
    through a standard reverse `session/request_permission` on that View's own
    ACP connection with the fixed `allow-once`/`reject-once` one-shot options,
    and NEVER delegated to the TUI channel. When the ACP message joins a
    validated TUI-origin turn, the prompt is mixed but its approvals still go
    only to the original TUI responder. Foreign message claim order alone
    proves mixed input, not the original approval owner. This origin survives
    an early Flight failure in the existing obligation/retired-turn fence. An
    ACP-origin mixed turn or
    unknown origin remains fail-closed. Other unprovable, stale, cancelled,
    disconnected, unknown-option or malformed outcomes fail closed as
    `unavailable` (never an automatic allow or an ACP-owned fallback to the
    TUI). The Host `approval.policy`
    (e.g. `never`) and sandbox policy stay ahead of the waterfall and are
    never bypassed. The official `approval/asked`/`approval/decided` audit
    pair stays the single decision record; this View adds no second audit
    writer.
  - **Question ownership and the standard Form.** The official Agent-scoped
    `user-questions/request` waterfall has exactly ONE classification seat ahead
    of the TUI forwarding listener, registered for the SAME reason and with the
    SAME exact-identity rule as the approval seat. It decides from facts only:
    the request's exact Agent, the official current-turn fence, and the live
    flight or retained retired turn that already owns that turn. A proven
    foreign (TUI or autonomous) turn calls `next()` exactly once and keeps its
    existing seat; a proven ACP-owned turn is answered HERE and never delegated.
    An agentless programmatic ask is not a Session question and is never
    intercepted. A question this View cannot attribute, or an ACP-owned question
    on a connection that did not negotiate the standard capability, fails closed
    with `LOCAL_ACP_QUESTION_UNAVAILABLE` — never a TUI answer, never a
    `session/request_permission`, and never a fabricated empty answer.
    - **Capability and channel.** A connection negotiates the standard client
      capability `clientCapabilities.elicitation.form` at `initialize`; only such
      a connection ever receives `elicitation/create`, and the channel is ONE
      connection-scoped closure built from the SAME SDK client as
      `session/new`/`session/resume` (exactly like the config-options notifier).
      It stays usable after that request settles while the connection lives, and
      a torn-down connection refuses instead of opening a second socket or
      touching a Host Session.
    - **Form shape.** Only the standard `mode: 'form'` request is produced:
      `message`, `sessionId`, the optional official `toolCallId` and an
      `object` schema whose keys are generated ASCII names (`q0`, `q1`, …), with
      `required: []` so DSH's skip semantics stay expressible. A question with
      options becomes `string` + `oneOf` (single) or `array` + `items.anyOf`
      (multi); a question without options becomes a free-text `string`; a
      question with options also gets ONE optional `qN__other` free-text
      companion. Options are never reordered or renamed, and the original DSH
      question id is restored from that request's own bindings — a wire key is
      never an official id and no client-specific `_meta` is sent.
    - **Answer conversion.** An `accept` builds the official batch with exactly
      one item per official question, in ask order: a valid label is
      `{selected:[label]}`, a multi selection is the duplicate-free label list, a
      free-text value or the `__other` companion is `{custom:text}`, and an
      omitted/empty value is `{selected:[]}` (the documented skip). A
      single-select custom value replaces the selection; a multi-select custom
      value accompanies it. An unknown key, a wrong primitive type, a label
      outside the options, a duplicate multi value or an unknown action is
      `LOCAL_ACP_QUESTION_BAD_ANSWER`, never a silent skip. `decline` and
      `cancel` are `LOCAL_ACP_QUESTION_DECLINED`, never an empty answer and never
      a permission decision. The Form carries no approval semantics: the official
      `ctx.userQuestions.ask()` still validates the business answer, and
      `intent.kind` presentation never grants execution.
    - **Timed questions and continued answers.** This View never attaches a DSH
      `TimedQuestionWait`, so DSH's own `askTimed` deadline remains the only
      clock and no absent Client countdown can extend it. When that deadline
      aborts the foreground wait, the original waterfall settles immediately as
      pending while the still-open Form becomes the claim's continued
      obligation for THAT official `callId`; any OTHER abort (turn cancellation,
      Agent disposal, close/EOF/Off) revokes the Form. The official projection
      allows several continued calls at once, so the View keeps one obligation
      per call and a second timeout never replaces the first: every answer is
      watched, validated and applied under the exact call/form it came from, and
      no answer can ever become another call's answer. A late accepted answer is
      held until the official `userQuestions` projection proves the call is
      `continued` and is then submitted exactly once through the official
      `userQuestions.answer(exactAgent, callId, batch)`. Every write is gated by
      the same View-ownership fence (exact claim still in this registry, same
      connection attached, not detached) re-read after each await and again
      inside the Host seam immediately before the synchronous official call, so
      a Form that outlives its View can never inject a reply into the shared
      Session. When another owner settles a continued call first, that call's
      Form is aborted AND the exact obligation (Form handle included) is
      reclaimed, so a long-lived View never accumulates dead obligations.
      That call's own result
      keeps its meaning: `true` is a reply queued into the inbox (not "the model
      used it"), `false` means the call is no longer answerable, and
      `REPLY_QUEUED`/`BAD_ANSWER`/`CALLER_NOT_LIVE` keep their official code and
      are never retried or converted into success. Nothing writes a durable
      answer, a second question database or an Agent steer.
    - **Resume and release.** `session/resume` re-reads the official continued
      projection for the exact Session and offers each still-answerable call as
      ONE Form at a time, in official ask order, deduped only by this
      connection's own offered set. A call another owner settles first stops its
      Form instead of leaving it open. Close, physical socket end, runtime Off,
      Agent disposal and claim retirement go through ONE release hook that aborts
      every reverse Form of that claim; the Host's durable question projection is
      never modified, so another surface can still answer a continued question,
      and a client disconnecting never cancels the Agent, Session or Turn.
  - **One prompt flight per View.** `session/prompt` is admitted only on an
    attached View that already holds the exact Session claim: the ONE flight, its
    committed/provisional output chain and its StopReason settlement are owned by
    the contract above. `session/close` and physical-dispatch release semantics
    are owned by the scoped-cancellation contract below.
- **Bounded per Host and per connection.** The Host start-time
  `DSH_PI_TUI_ACP_MAX_CONNECTIONS` integer (default 4, valid 1..16, an invalid
  value is a startup failure) caps live connections; an over-limit connection
  gets one bounded error and is closed. Each connection bounds its single
  NDJSON frame, its unconsumed input, its outstanding requests and its buffered
  output in bytes (not JS character length); a breach closes only that
  connection and never the Host or a sibling connection. A capacity or
  backpressure fault never affects the official Host/TUI.
- **Safe stale reclaim.** After the abstract Host seat is held, an existing
  socket inode is reclaimed only when a short connect probe proves it refused
  (`ECONNREFUSED`) and its `(dev,ino,uid)` is unchanged; a live listener is
  `LOCAL_ACP_SOCKET_IN_USE`, and a symlink, regular file or foreign-owner entry
  is `LOCAL_ACP_UNSAFE_SOCKET` and never removed. The same bounded
  probe + identity recheck applies to the Linux private fd-shortened bind name
  and to the macOS public and private names; a SIGKILL leaves those inodes for
  the next seat winner's safe reclaim. Cleanup unlinks only this process's own
  saved inode.

## Official session facts on the stable v1 wire

The pinned `@agentclientprotocol/sdk@2.9.1` package root is the stable v1
schema (`protocolVersion: 1`); `/experimental/v2` is a different protocol and is
never imported. On top of that wire this Host projects OFFICIAL DSH facts. The
authorities are the existing Host services and nothing else:

- Session existence, visibility and access: the official
  `sessionController.list` result, which the Controller itself filters through
  its `remoteAccess.allows({kind:'session', id})` authorization. The ACP layer
  never re-implements an ACL and never reads raw persistence.
- Titles: the official `sessionQuery.readTitleSnapshots` fold of EXACTLY the
  authorized ids above.
- History: the official `sessionQuery.readSession`, which returns the complete
  replay-validated canonical event log. No raw session file, bounded surface
  window, ZIP export or cold synthesized interrupted-turn closer is ever used.
- Current plan: the durable whole-list `todo/write` event and the official
  `todos` projection of the exact attached Session.
- Current context occupancy: the official `contextPressure` projection
  (`projectedTokens ?? pressureTokens` paired with the newest known route
  `contextWindow`). The cumulative lifetime token buckets are never presented as
  occupancy, and no cost is invented.
- Compaction: the durable `compaction/start|summary|end` lifecycle keyed by its
  own `compactionId`.
- Subagent children: the durable child `Session.header` (`origin:'subagent'`
  AND the exact `parentSession`) cross-checked with the official
  `subagent/start|end` run identity. An ordinary fork's `parentSession` never
  counts.
- Agent messages: the durable `user/message` whose official
  `source.kind:'agent-message'` carries the real `senderSessionId`. The runtime's
  `subagent-settled` account is never presented as child-authored words.
- Notices: this Host has NO official user-notice producer, so no `notice` is
  ever sent even when the client advertises the capability
  (`UNADVERTISED_BY_DESIGN`); nothing is synthesized from logs or UI activity.

These read-only facts never become a second Session, Agent or Writer authority.
A read-only projection is produced ONLY for the exact attached Session of the
connection that owns it, and the client capabilities that gate the supplemental
frames are frozen for the whole connection at `initialize` — a later attach can
never widen them.

### `session/list`

`session/list` answers from the authorized roster and NEVER creates a View,
resumes an Agent or touches a Session writer. A connection that was not
initialized is refused before the handler runs.

- Visibility: only ROOT Sessions (`header.origin !== 'subagent'`) with a
  standard absolute cwd are rows. A row that cannot prove an absolute cwd is
  omitted rather than represented by a fabricated entry.
- Filtering: an omitted or null `cwd` lists every authorized root; a supplied
  `cwd` must be a standard absolute path with no NUL and selects exactly the
  rows of that directory.
- Ordering: `(updatedAt DESC, sessionId UTF8 ASC)` — never locale-dependent.
- Pagination: a fixed page of **50** rows. `nextCursor` is the canonical
  Base64URL encoding of the compact JSON array
  `[updatedAt, sessionId, cwdOrEmpty]`, bound to the request's own cwd filter,
  at most 768 characters, and accepted only when it re-encodes to the exact
  supplied bytes. A malformed, non-canonical, filter-mismatched or oversized
  cursor is JSON-RPC `-32602`. Pagination continues on the CURRENT roster
  snapshot: it is a keyset continuation, never a transaction and never a second
  cursor store.
- `updatedAt` is ISO 8601 from the official activity milliseconds; `title` comes
  only from the official durable fold, and an unprovable title is simply absent.

### `session/load` versus `session/resume`

`session/load` reuses the SAME official attach as `session/resume` (one cold
`resolveAgent` resume at most, the same one-View-per-Session rule, the same
workspace/MCP policy). The ONLY difference is history: `load` replays the
complete canonical log, `resume` replays NOTHING.

The replay is fenced and ordered:

1. The claim is reserved and the official Agent/Session identity is verified
   exactly as for resume.
2. At the attach critical point — BEFORE the View can emit anything — the
   replay barrier opens and live durable events of that Session are buffered
   under a bounded window.
3. The complete canonical history is read, validated and converted BEFORE any
   notification is sent: `seq` must be strictly increasing, and a committed
   block with no standard ACP v1 projection fails the whole load closed.
4. The history is handed to the claim's single ordered output tail; every image
   is re-read and verified by the official Attachment Store inside that tail.
5. Buffered live events are joined by their official `seq`: the window is
   sorted ascending, a repeated seq is projected exactly once, `seq <= cut` is a
   duplicate of the snapshot and is dropped, and `seq > cut` follows the history.
6. The barrier closes atomically with that join, and the `session/load`
   response is sent ONLY after the ordered tail fully drained. A notification
   failure is a request error, never a swallowed success.

Failure and lifecycle rules: a new prompt on a still-replaying View is
`LOCAL_ACP_VIEW_BUSY`; an unrepresentable block is
`LOCAL_ACP_LOAD_UNSUPPORTED_CONTENT`; a broken seq order is
`LOCAL_ACP_LOAD_INVALID_HISTORY`; an unreadable committed image is
`LOCAL_ACP_LOAD_ATTACHMENT_READ_FAILED`; an over-budget live window is
`LOCAL_ACP_LOAD_BACKPRESSURE`. Every one of them releases ONLY that View — the
Host Session, Agent, Writer and TUI are untouched — and no partial history is
ever reported as a complete load. Close, physical disconnect, runtime Off and
Agent disposal invalidate the replay generation first, so a late read never
sends a closed View's history. A View loaded this way keeps its exact seq fence
and never becomes a second history authority.

### Read-only projections

Every projection below is a transient, per-claim, bounded and cancellable
ordered tail — the same bounded transport the prompt output uses. It is
independent of any prompt flight: a TUI/Goal turn's plan, title, occupancy,
compaction and agent messages are projected too, while its assistant output
never becomes an answer to an ACP `session/prompt`.

- **Plan.** The durable `todo/write` whole-list replacement (and, on `resume`,
  the current official `todos` projection once) becomes the stable legacy
  `sessionUpdate: 'plan'` for a client without `clientCapabilities.plan`, and
  the negotiated `plan_update` (one stable `planId` per Session) for a client
  that declared it. An empty list is a formal clear, `null`/absent sends
  nothing, and `plan_removed` is never sent because DSH has no official plan
  removal. DSH records no priority, so every entry carries the fixed
  presentation default `medium`; that is a display adaptation, never a claimed
  DSH priority.
- **Session info.** A durable `session/title` becomes a field-level
  `session_info_update` carrying that event's own durable time; an unchanged
  title is not re-sent and a local `Date.now()` activity is never fabricated.
- **Usage.** After a committed `assistant/message` that carries the provider's
  own usage, the current official context pressure and route capacity become
  `usage_update {used,size}`. Missing or invalid values produce NO update —
  never a fabricated 0, never 100%, never the lifetime billed sum and never a
  cost.
- **Compaction.** Only a client that declared `session.compaction` receives
  `compaction_update`: `start` → `in_progress`, `summary` → complete summary
  content replacement, `end` → `completed`, or `failed` with the official error.
  Each durable `compactionId` contributes at most one start, one summary and one
  end, in that order: a duplicated or out-of-order callback is dropped instead
  of re-projecting a lifecycle this View already delivered. No
  `compaction_summary_chunk` is produced (the Host has no streaming summary
  producer) and a cancelled compaction has no official state to report.
- **Subagent child.** Only a client that declared `subagents` receives a
  `subagent_update` on the child's immediate parent Session, and only after the
  child header proves `origin:'subagent'` plus the exact durable creator. The
  official `runId` joins the lifecycle: the `end` edge announces the SAME
  verified child as its `start`, and an `end` whose start this View never
  announced sends nothing (a lone idle snapshot is not an observed
  association). The first announcement precedes any child traffic; child
  `capabilities` are always omitted (no child mutation is offered).
- **Agent message.** Only a client that declared `subagents` receives a
  `session_message` for a durable `agent-message` user message — in the live
  stream AND when that same durable message is replayed by `session/load` — with
  the real `senderSessionId`, the exact recipient Session and the message's own
  content. Other `user/message` source kinds are Host context, a continued
  question reply or the runtime's settlement account, and none of them becomes
  user or agent content.
