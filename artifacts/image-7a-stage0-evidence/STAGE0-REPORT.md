# Image-7A PR1 — Stage-0 consumer-only gates (E3, real Kitty)

Environment: Kitty 0.41.1, WSL2/WSLg, `DISPLAY=:0`, Node v24.21.0,
pnpm 12.11.2, worktree `feat/image-7a-pr1-unified-kitty-core` at
`92a36f719552573a6afe193bededbf5467057fc1` (the branch rebased onto
`main` `496e2722`), working tree clean at run time. One real Kitty window per
case, raw bytes captured with `kitty script`, screenshots with `maim` on the
case's own window id. Harness: `temp/image-7a-stage0/` (adapter drives the
REAL `TuiMainScreen`/`TuiAltScreen` + REAL `KittyTerminalFacade` +
REAL `KittyGraphicsCore`; only the root component and the control channel are
test-only).

**Snapshot pinning:** `temp/image-7a-stage0/runner-env.json` records that SHA,
the clean `git status`, the display and the exact case list; every case
directory carries its own `command.json`, `stage-events.jsonl`, `raw-outer.bin`
and `protocol.json`. Suite: 14/14 cases.

## Verdict

`GO_UNIFIED_CONSUMER` — the public `Component` + `Terminal` surface is
sufficient; no fork change is needed for any gate.

| Gate | Verdict | Evidence |
|---|---|---|
| S0-1 valid native line / real Main hide-re-show | **PASS** | `cases/S0-1-main`, `cases/S0-1-main-mid` |
| S0-2 same-Alt-buffer foreign two-way isolation | **PASS** | `cases/S0-2-foreign-first`, `cases/S0-2-core-first`, `cases/S0-2-2j-control` |
| S0-3 automatic lifecycle / invalidation generation | **PASS** (Main preserve policy adjudicated by the Owner, see below) | `cases/S0-3-alt`, `cases/S0-3-main` |
| S0-4 independent clear comparison | **PASS** (with a measured 3J rule) | `cases/S0-4-none`, `S0-4-2j`, `S0-4-3j`, `S0-4-2j3j` |
| S0-5 producer→writer→terminal permission trace | **PASS** | `cases/S0-5-permission` |
| S0-6 consumer sufficiency | **PASS** | no fork seam required |
| Product-shaped consumers through the REAL factory | **PASS** | `cases/S0-6-product` |
| Main + leased Alt share one Core; Alt exit never touches Main | **PASS** | `cases/S0-7-mixed` |

## S0-1 — Main screen

- First paint: one `a=t,f=100,i=<id>,q=2` transmit, then
  `a=p,i=<id>,p=1,c=21,r=10,C=1,q=2;` placement; the anchor sits on the first
  of the 10 reserved rows and the image is visible (`01-initial.png`).
- `hide`: the writer's own `d=I` for the managed id is translated into
  `a=d,d=i,i=<id>,q=2`; the pixels are gone in that frame (`03-hidden.png`),
  there is no resize/clear and no residual.
- `show`: `a=p` again with **no** transmit; the image is back immediately
  (`04-shown.png`), so re-show never waits for a resize.
- A resize produces `d=i` (scoped) + `2J`/`3J` + a fresh `a=t` **before** the
  new `a=p` — the re-transmission follows the invalidating clear and precedes
  the placement (`protocol.json` timeline).
- Multi-chunk fixture (9 chunks, 35 532 base64 chars): first chunk
  `a=t,f=100,i=...,q=2,m=1`, continuations `m=...,q=2`, final `m=0`; **all**
  chunks carry `q=2` and every payload piece is a multiple of 4 except the
  last. No `Gi=0;OK` pollution appears in the captured stream.
- `retire`: the Core's own queued `d=I` precedes the frame, and the writer's
  late delete for the already-retired id is dropped (no second hard delete).

## S0-2 — Alt screen, same buffer

- A (core-owned, red) and B (foreign, `a=T` blue) are non-overlapping and both
  visible (`01-both-visible.png`).
- Foreign-first: `B`'s own `a=d,d=I,i=855567,q=2` reaches the terminal
  byte-identically and only B disappears; A keeps every pixel
  (`03-after-foreign-retire.png`). No `2J`/resize between the two states.
- Core-first (fresh case): the Core's `a=d,d=I,i=<core id>` removes only A;
  B keeps every pixel (`02-after-core-retire.png`), and B's id never appears in
  the delete.
- Control: a bare `CSI 2J` in the same buffer wipes the whole frame (text and
  both images, `02-after-2j.png`). That is recorded as the clear's own side
  effect, NEVER as ID-isolation evidence.
- No `d=A` or `d=a` ever reached the terminal in any case.

## S0-3 — lifecycle

- `Alt.stop()`: the screen's own `d=A` release arrives at the facade while the
  physical terminal still accepts writes; the wire shows one scoped
  `d=I` per own image **before** `terminal.stop()` (identified by the
  `ESC[?2004l` marker). A double stop, and a forced third stop on the same
  screen, add no duplicate deletes.
- A screen stop does NOT end its components (external-review fix): a
  registration whose placement never landed survives the stop, so the wire has
  no delete for it and the same component transmits normally on re-entry.
  Registrations end with their component's retire, the screen's own release or
  the final dispose.
- Re-entry after a real stop allocates a NEW image id and a new placement id
  (`p=1` → `p=3`; different 32-bit ids), so a retired generation can never be
  adopted by a new occurrence.
- Main policy (Owner-adjudicated 2026-10-27, after an independent review
  finding): the fork's main screen only repositions the cursor on stop, it never
  clears the screen, so **no Main stop sends `d=I` in either `preserveScreen`
  mode**. Painted pixels are terminal-retained; the Core drops its own payload
  copy and keeps the id (never re-used, never deleted by the Core). Only an
  upload that never reached a placement is released at stop. The alternate
  screen releases the ids IT placed, and only those.
- An occurrence that goes away after being painted (component `dispose()`: a
  transcript trim/rebuild) is also terminal-retained — `cases/S0-1-main`
  `08-retired` shows the placement removed (`d=i`) with no `d=I`.
- **Budget (Owner amendment 2026-10-27):** there is no cumulative image-id
  quota. The Core bounds only its own ACTIVE working set (pending uploads and
  the re-transmittable payload cache: 64 MiB base64 / 256 MiB estimated decoded
  footprint). A painted occurrence leaves the active set, keeps no payload, and
  stays terminal-retained; a fixed 256-id memory window keeps a late legacy
  delete recognisable as a placement removal. 100 sequential painted
  thumbnails are covered by `test/tui/kitty-graphics-owner.test.ts` and the real
  main-screen case in `test/integration/kitty-native-screen.test.ts`.

## S0-4 — clears (measured, not inferred)

Four fresh initial states, each: paint → clear → **raw placement without
transmission** (bypasses the facade) → screenshot → raw transmit+place →
screenshot.

| clear | visible after clear | place-only after clear | re-transmit+place |
|---|---|---|---|
| none | image + text | image returns | — |
| `2J` only | screen empty | nothing | image returns |
| `3J` only | **screen empty** | nothing | image returns |
| `2J`+`3J` | screen empty | nothing | image returns |

So on Kitty 0.41.1 a bare `CSI 3J` invalidates the uploaded data exactly like
`2J` (it also leaves the visible screen empty). The production rule is the
measured one: `2J` and `3J` both invalidate residency; the next placement
re-transmits first. The production-path re-render after each variant shows
`none` → placement only, and `2J`/`3J`/`2J+3J` → `a=t` then `a=p`.

## S0-5 — permission trace

- Foreign per-id delete: byte-identical pass-through.
- A non-command APC (`ESC_Gi=123;...`) passes through unchanged.
- OSC 8 / OSC 52 / SGR payload injected through the facade is present
  byte-identically in the outer stream.
- No global delete is emitted anywhere in the session.
- First-party `d=A`/`d=a`/`d=I` producers in the tree: the fork's
  `TuiMainScreen` (`deleteKittyImage` on changed/removed image lines and on a
  clear), the fork's `TuiAltScreen` (`deleteAllKittyImages()` at stop,
  `deleteAllKittyPlacements()` on redraw/image change, `deleteKittyImage` on
  offscreen budget eviction). All of them reach the terminal only through the
  facade, so the Core is the one decision authority for its own ids.

## S0-7 — Main + leased Alt on ONE Core

`S0-7-mixed`: the real main screen paints image A, then a real `TuiAltScreen`
is mounted on the SAME facade/Core and paints image B, then it is stopped and
the main screen repaints.

- Alt entry: `?1049h` + `2J` only — **no `d=I` for A** (the previous
  implementation released every record on the alt's global `d=A`; that
  cross-screen release was an independent review P1).
- Alt stop: exactly one `d=I` for **B**; A's id never appears in any delete.
- Back on main: A is still visible (`03-back-on-main.png`) and was never
  re-transmitted; the only new transmission is B's, because the alt screen's
  own `preserveScreen:false` replay paints it into the main buffer (pre-existing
  fork behavior, and per-buffer residency correctly re-sends it there).

## S0-6 — product-shaped consumers

`S0-6-product` runs the REAL factory (`createNativeKittyGraphics`, admission
included) and the REAL `ImageThumbnail` (transcript) + `ImageViewerPanel`
(leased Viewer) on a real main screen: one `a=t` + one `a=p` per image, hide
removes both placements in-frame, show re-places with no re-upload, the raw
once-per-session id churn is the same one the legacy path already pays when the
terminal reports its real cell size.

## Not covered here (recorded, not claimed)

- Draft composer preview and SVG thumbnail/viewer are covered by the E2
  integration/unit suites and the real-screen integration test; they were not
  separately driven inside a Kitty window in this Stage-0 pass.
- A full `dsh` session with real Host attachments (end-to-end L6) is NOT run;
  see the PR body.
