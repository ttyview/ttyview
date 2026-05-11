# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_(no unreleased changes yet)_

## [0.1.1] — 2026-05-11

First public release that includes the image-paste flow, the binary
rename, and a wave of plugin / UX work since `v0.1.0`. Mobile CC will
pin to this tag for its first public release.

### Added

- **Image paste end-to-end** — `POST /api/uploads` (multipart stage),
  `POST /api/uploads/send` (archive → tmux `load-buffer` + `paste-buffer`
  + verify-retry) and a bundled `ttyview-image-paste` plugin
  (inputAccessory with 📷 button, paste-event handler, full-page
  drag-and-drop overlay, client-side downscale). Lets you hand
  screenshots to Claude Code over SSH. (`c052dbe`)
- **WebSocket Origin check** with new `--allow-origin <ORIGIN>` daemon
  flag — defense-in-depth against cross-site WS hijack. (`c052dbe`)
- **Voice dictation plugin** (`ttyview-voice-dictation`) — 🎤 toggle
  in the keys row, continuous Web Speech API mode, "say enter"
  submits. Language + behaviour settings. (`06afbde`)
- **Pinned-tabs plugin** (`ttyview-tabs`) — tab row for switching
  between pinned panes, pin-all, multi-row layout, fit mode with
  equal-width columns + middle-ellipsis truncation. (`09d25f6`,
  `094ff1e`, `9fdaf70`)
- **Pane Picker plugin** (`ttyview-pane-picker`) — Recent + All
  sections, configurable recency, alphabetical / pane-id sort,
  auto-hide meta column when every session is a single pane in w0.
  (`7e3667d`, `122ee4d`, `f8806ae`)
- **App Name plugin** (`ttyview-app-name`) + `--app-name` daemon flag
  — surfaces the daemon instance name in the header. Useful for
  telling apart multiple ttyview tabs. (`f5d089a`)
- **Display Toggles plugin** (`ttyview-display-toggles`) — Settings
  tab with toggles for built-in chrome (font controls hidden by
  default; tap-to-focus-input on by default). (`6e1b51f`)
- **`--config-dir` flag** — fully isolated multi-daemon setup; each
  instance gets its own plugins / settings / state. (`636067b`)
- **Per-port default config dir + plugin enable/disable** —
  `~/.config/ttyview/<port>/` when no `--config-dir`. Plugins can
  be disabled without uninstalling. (`80d89d1`)
- **Layout system** — runtime widget movement between named slots
  (Top bar / Header right / Above grid / Below grid / Above input),
  with plugin-declared `preferredSlot` hints. (`1186ff0`, `0061c84`)
- **Settings: master/detail layout** (Obsidian-style), Obsidian-style
  Plugins tab with per-plugin toggle switches + enabled-first sort,
  per-plugin ⚙ Settings shortcut, persistent active-tab across
  reloads. (`1ce7875`, `3b4a37f`, `5ccac52`, `e5410a3`)
- **Cell-grid: tap CC prompt row** to focus the Message input
  (short-tap detection, long-press still selects text). Default-on,
  toggle in Settings → Display. (`3f46d3b`)
- **Pinned Tabs `pin-all` action** + multi-row layout settings.
  (`9fdaf70`)

### Changed

- **Binary renamed** `ttyview-daemon` → `ttyview`. Crate package name
  stayed `ttyview-daemon` to keep cargo paths stable. (`c052dbe`)
- **Cell-grid palette** swapped from xterm-classic to VS Code Dark+
  (matches tmux-web). Blue `#0000ee` → `#2472c8` so URLs in CC
  output are readable on the dark background. (`6872553`)
- **Pane id rendered as `p4`** instead of `%4` in the picker meta
  column. Underlying `p.id` is unchanged. (`f8806ae`)
- **Pane label**: drop pane id + size suffix; only disambiguate
  with `(n)` when multiple panes share a session. (`0b1d1f2`)
- **Pane Picker Recent section** now includes the currently-active
  pane. (`7e3667d`)

### Fixed

- **Pinned-tabs: `flex-basis:100%`** was inflating row heights when
  tabs lived in `above-input`. (`be90c7d`)
- **Pinned-tabs: stale `pin.id`** no longer cross-wires the active
  highlight to the wrong tab after a tmux server restart; sibling
  rows scroll independently in stacked slots. (`18449d2`)
- **Pinned-tabs: parent slot** flips to flex-direction column when
  the tabs widget needs its own row. (`acee73d`)
- **Pinned-tabs: 1/N column width** across all rows in fit mode.
  (`d3decba`)
- **Submit-Enter**: paste-then-delayed-Enter pattern so Claude
  Code's TUI receives Enter reliably. (`30657c9`)
- **Touch taps** in Quick Keys + Tabs — Android Chrome was eating
  the synthetic click; switched to `pointerup` with explicit
  `preventDefault` on `mousedown`. (`97817bb`)
- **WS reconnect**: input is no longer silently lost when the WS is
  reconnecting; added input diag. (`5e9a2d1`)
- **Deploy**: subdomain routing for Tier 2 + Tier 3 demos (the
  path-prefix layout `/spectator/` + `/sandbox/` broke because the
  daemon emits absolute redirects). (`e5bf7c1`)
- **Docker**: pinned the builder stage to `bookworm` so the glibc
  matches the runtime. (`58e59fd`)
- **e2e**: `#pane-select` is `display:none`, use Playwright's
  `toBeAttached`. (`6e53d9a`)

### Internal

- 3-tier public demo deployed on GCP `ttyview-demo` (Cloud Run +
  GCE VM). Tier 2/3 currently paused per the 2026-05-11 security
  review — see `STATUS.md` for the reactivation checklist.
  (`54304da`)
- Project hub: `STATUS.md` shared status board + `AGENT_LOG.md`
  per-agent activity log, rendered inline at
  `/ttyview-links.html` in tmux-web with auto-refresh and an
  "All agents (combined)" timeline view. (`6f27757`, `29da725`,
  `2713824`, `d0abc11`, `ec081a7`, `24759c0`)
- `chore(agent-coord)`: untrack `STATUS.md` + rename `AGENTS.md` →
  `AGENT_LOG.md`. (`bfa0cb7`)

## [0.1.0] — 2026-05-08

Initial public release. Daemon attaches to tmux sessions, serves a
structured-grid + WebSocket API, ships a plugin-based browser client
with bundled plugins (Clock, Pane Counter, Quick Keys, Plain Text
view, Claude Code chat view, Solarized Dark / Terminal Green / Nord
themes), sandbox broker (Tier 3 demo), Cloud Run image, GCE VM
deploy scripts.

[Unreleased]: https://github.com/ttyview/ttyview/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ttyview/ttyview/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ttyview/ttyview/releases/tag/v0.1.0
