# Pi2dsh compatibility fixture

This is a minimal, real Pi extension used by the Issue #26 external consumer
smoke. It intentionally does not import dsh-pi-tui, the vendored pi-tui fork,
or any pi2dsh private module.

The fixture uses only the Pi extension ABI supplied to its factory:

- `registerCommand()` deliberately registers the native `/help` name; pi2dsh must expose it as `/pi-help` so the host-owned `/help` remains reachable.
- `ctx.ui.setStatus()` exercises the status bridge.
- `ctx.ui.custom()` opens a component with `render(width)`, `handleInput(data)`,
  and `dispose()`.

The component writes lifecycle evidence to the path in
`PI2DSH_COMPAT_EVIDENCE` and renders stable screen markers. Pressing `q` calls
Pi's supplied `done()` callback exactly once before the component is disposed;
the smoke script checks that callback, both evidence channels, and the Host
surface against the published `pi2dsh@0.20.0` package and the candidate
dsh-pi-tui tarball.
