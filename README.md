# ttyview

> Web terminal viewer for tmux sessions. Mobile-first observability for Claude Code and other TUI agents.

This repository is the monorepo for the ttyview project.

## Status

Pre-alpha. v0.0.0 packages reserve the names on crates.io and npm. Real
implementation is in progress.

## What it is (planned)

- Run a daemon on your machine
- It attaches (read-only) to your tmux sessions and parses TUI output into structured cell-grid state
- Open the daemon's URL on your phone or any browser; see your live tmux session with a mobile-first renderer
- Frozen scrollback (no Ink-style render leak), cell-level mutations, structured navigation, density filters for AI agent sessions

## Repos

- `ttyview-daemon` (this repo's `crates/ttyview-daemon`) — Rust daemon
- [ttyview-client](https://github.com/ttyview/ttyview-client) — TypeScript browser frontend

## License

MIT.
