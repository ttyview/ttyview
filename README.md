# ttyview

> Web terminal viewer for tmux sessions. Mobile-first observability for Claude Code and other TUI agents.

Run a daemon on your machine; it attaches read-only to your tmux sessions and exposes a structured cell-grid + live cell-diff stream over HTTP/WebSocket. Open the daemon's URL in any browser (phone, tablet, desktop) — see your live tmux session rendered.

```
[Browser]  ←HTTPS/WSS→  [ttyview-daemon]  ←tmux -C→  [your tmux + Claude Code]
```

## Status

**v0.0.1 — working, but minimal.** The daemon attaches to your tmux sessions and serves a basic HTML/JS client that renders any pane live. The wpin7-style mobile UX features (frozen-past scrollback, JSONL correlation with timestamps, density modes, autofit) are not in this release — coming in v0.0.2+.

What works in v0.0.1:
- Daemon attaches to all tmux sessions on your local server
- HTTP API: `/panes`, `/panes/:id/grid`, `/panes/:id/text`, `/panes/:id/scrollback`
- WebSocket: live `cell-diff`, `grid-reset`, `scrollback-append` events
- Bundled HTML/JS client: pane picker, live cell-grid rendering, WS subscription
- Mobile viewport baseline (touch scrolling, dark theme)

What's not in v0.0.1 yet:
- Frozen scrollback (cells are mutated in-place; CC's render-leak protection isn't here yet)
- Claude Code JSONL correlation (no per-message timestamps, no tool-call expand)
- Density modes (filtering by user/assistant/tool/chrome)
- Mobile paint optimizations (paint containment, content-visibility)
- Send-input back to tmux
- TLS — bind to localhost and put behind Tailscale or a reverse proxy

## Try it (v0.0.1)

Requires: Rust toolchain, `tmux`, a tmux session running on the same machine.

```bash
git clone https://github.com/ttyview/ttyview
cd ttyview
cargo build --release
./target/release/ttyview-daemon --bind 127.0.0.1:7681
# Open http://127.0.0.1:7681 in your browser.
```

To access from your phone, expose the port via Tailscale (`tailscale serve`) or any HTTPS reverse proxy.

CLI options:

```
ttyview-daemon [OPTIONS]

  --bind <ADDR>        Address to bind. Default: 127.0.0.1:7681
  --socket <NAME>      Tmux socket (-L). Default: server's default.
  --rows <N>           Default pane rows. Default: 50
  --cols <N>           Default pane cols. Default: 80
```

## Layout

```
ttyview/
├── Cargo.toml                          # workspace root
├── crates/
│   ├── ttyview-core/                   # library: vte parser, Screen, broadcaster, HTTP/WS
│   │   ├── src/
│   │   │   ├── grid/                   # Cell, Line, Cursor, Screen
│   │   │   ├── parser/                 # vte::Perform → Screen mutations
│   │   │   ├── source/                 # tmux -C control mode connector
│   │   │   ├── state/                  # pane registry + broadcast channels
│   │   │   ├── api/                    # HTTP + WebSocket handlers
│   │   │   ├── detectors/              # claude code / shell heuristics
│   │   │   └── cli/                    # daemon entry-point
│   │   └── ui/index.html               # bundled browser client (single file)
│   └── ttyview-daemon/                 # thin binary wrapping ttyview-core
├── client/                             # @ttyview/client npm package (stub for now)
├── docs/
└── protocol/                           # wire protocol schemas (TBD)
```

## Acknowledgements

`crates/ttyview-core` is extracted from [eyalev/panel](https://github.com/eyalev/panel), an earlier private experiment by the same author. The wpin7-style browser client patterns derive from [eyalev/tmux-web](https://github.com/eyalev/tmux-web).

## License

MIT.
