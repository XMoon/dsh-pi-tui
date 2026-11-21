# Local ACP v1 Host front-door contract

This document owns the local ACP v1 listener transport, bounded protocol
admission, and ACP session-view behavior. It does not define a second Host,
Agent, Session or Writer: their authority remains in
[host-client.md](./host-client.md). Profile supervision belongs to
[host-daemon.md](./host-daemon.md).

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
  listener answers the ACP v1 `initialize` (protocol version 1, `agentInfo.name`
  `dsh-pi-tui`, `agentInfo.version` the installed `@xmoon76/dsh-pi-tui` bundle
  version — never the DSH engine version). When the Host installs the shared
  Session View it advertises `sessionCapabilities: { resume: {}, close: {} }`
  and never `loadSession`, `session/list`, config options or MCP capability.
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
  - One ACP connection may borrow **at most one** Host Session (one View), and
    one Host Session carries **at most one** ACP View at a time, while any
    number of human Split TUI Clients may still reference the same Session.
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
    `max_tokens`). Only the committed output of that claimed turn is projected as
    standard `session/update` notifications, in durable order, and the answer is
    sent after the turn's `turn/end` and the ordered notification drain. A turn
    that also claims another user's message (e.g. a TUI steer) is a MIXED turn:
    no further output is projected and the request fails closed with
    `LOCAL_ACP_PROMPT_MIXED_TURN`, never a fabricated success. The bounded
    per-connection output cap and the one-View-per-Session rule are unchanged.
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
    - A completed turn needs at least ONE visible assistant output: non-empty
      committed text or a committed assistant image, so an image-only turn
      succeeds. A turn with no visible output keeps the stable
      `LOCAL_ACP_PROMPT_NO_ASSISTANT_TEXT` failure.
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
  - `session/close` detaches ONLY this connection's View/reservation: it never
    disposes, flushes or resumes the Agent/Session, so a TUI referencing the
    same Session keeps working and a later connection may resume again. With an
    open prompt flight it first performs the scoped cancellation below and
    settles before detaching; a repeated close on the same connection is
    idempotent.
  - A physical socket end/error/destroy, runtime Off or Host shutdown retires
    the network connection immediately and drives the scoped-cancellation
    contract below. Pending admission retains the request identity, claim and
    fact observer so a late insertion is still cancelled exactly. The claim is
    released only after proven Host settlement, or after classified admission
    on the exact Host identity proves there was no inserted message. The
    Session, Agent and writer keep their Host authority; a pending
    create/resume whose connection closed never publishes an attached View.
  - `session/list`, `session/set_config_option`, MCP prompts and ACP
    file/artifact transfer are NOT provided by this View and fail closed with
    their stable `LOCAL_ACP_*` code.
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
  - **One prompt flight per View.** `session/prompt` is admitted only on an
    attached View that already holds the exact Session claim: the ONE flight, its
    committed-output projection/drain and its StopReason settlement are owned by
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
