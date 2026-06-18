# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] — 2026-06-18

### Added

- **SVG rail icons (`ttyview-tabs`)** — the utility rail's mode buttons
  use inline SVG (a 2×2 grid for *all sessions*, a clock for *recent*)
  instead of emoji glyphs, so they render identically across devices
  and follow the theme. Colored via `currentColor`, or
  `--ttv-rail-accent` when an embedder sets one; inactive icons dim,
  the lit (active-mode) button goes full-opacity with an accent border.

### Fixed

- **Tab area no longer changes height between modes (`ttyview-tabs`).**
  The always-on recent row renders in pinned mode only, but the prior
  constant-height fix capped only the scrolling content — so the recent
  row's height sat outside the cap and made pinned mode ~38 px taller
  than *all* / *recent*. Switching modes shifted the whole tab stack and
  bumped the terminal above. The whole tab column is now pinned to one
  mode-independent height (the recent row's height is reserved in the
  modes where it's absent; content flexes + scrolls to fill).

## [0.1.4] — 2026-06-12

### Added

- **`header-left` layout slot** — plugins can mount an inline widget
  at the header's left edge (e.g. a brand glyph), instead of being
  limited to the right-side widget area or a full top-bar row.
- **`'semantic'` plugin event + `tv.refreshPanes()`** — plugins can
  subscribe to semantic events (e.g. Claude Code permission prompts)
  for *all* panes via a `kinds:['semantic']` WS subscription, and ask
  the client to refresh its pane list. Groundwork for per-tab status
  indicators and, later, Web Push.
- **Tab status dots (`ttyview-tabs`)** — per-session activity dots on
  pinned tabs: amber pulsing = permission prompt waiting (semantic
  events), blue pulsing = recent output, orange = finished since last
  viewed. Toggleable in the tabs settings. Plus project groups, a
  utility rail, and group reordering in the tabs plugin.
- **Fit-resize** — on narrow viewports the client can auto-narrow a
  wide tmux window (via WS `{t:"resize"}`) so the grid reflows to a
  readable font (11 px floor) instead of being squeezed or clipped.
- **`ttyview-stt-groq` community plugin** — voice input with
  selectable engines: built-in Web Speech (default, zero-config) or
  Groq Whisper + LLM transcript cleanup, browser-direct with a
  bring-your-own API key (Settings → Voice Input). Superset of
  `ttyview-stt`; bundle one or the other, not both.

### Fixed

- **Read-only WS connections can no longer resize tmux windows** —
  `{t:"resize"}` is rejected in read-only mode, matching the existing
  input restrictions.

## [0.1.3] — 2026-06-12

### Fixed

- **tmux ≤ 3.3 compatibility — pane ids were unusable on stock
  Debian 12 / Ubuntu 22.04** (the bug that made released mobile-cc
  builds dead on arrival on fresh machines). tmux ≤ 3.3 replaces tab
  characters in `-F` format output with `_` (fixed upstream in tmux
  3.4); every tab-delimited format string we parsed therefore
  collapsed into a single underscore-joined field, producing composite
  pane ids like `%0_work_0` that tmux then rejected on `send-keys`
  ("can't find pane"). All seven `-F` call sites now use
  version-proof separators (space / `|`, free-text fields last,
  `splitn`), pane ids are validated against `%<digits>` at the parse
  boundary, and client-supplied pane targets are normalized
  (`tmux_pane_target`) before every tmux shell-out — so clients
  holding stale composite ids from affected daemons keep working.
- **CC chat view polls non-CC panes gently.** The "not a CC pane"
  empty state no longer refetches every 2 s forever (now 10 s,
  rendered once) — less battery drain and console noise on phones.
- **Pane picker never renders a blank, nameless row** — panes without
  a known session label fall back to their pane id.
- **favicon 404 silenced** with an empty `data:` icon link.

### Added

- Post-v0.1.2 feature wave (see `git log v0.1.2..v0.1.3` for the full
  list): `ttyview-stt` (Web Speech dictation), `ttyview-logs`
  (on-device client log viewer + `ttyviewLog()` API),
  `ttyview-reload`, `ttyview-live-sync` + `ttyview-ui` CLI
  (agent-driven UI control), tabs pinned/all mode toggle + per-pin
  row assignment, input-row slots + clear-×, image-paste data-URL
  thumbnails, `RunOptions.extra_static` embedder-assets hook (PWA
  enabler), multi-session keepalive probes (tmux 3.4 control-mode
  crash mitigation), background-resume resync for mobile clients.

### Changed

- **`--demo` mode polish.** Seeds 5 synthetic panes (`mobile-cc`,
  `ttyview-platform`, `tmux-web`, `blog-post-draft`,
  `feature-experiments`) instead of one. Curated plugin set
  auto-installed at startup bumped from 2 → 11 (all UI-completing
  plugins + all three themes). Five bundled canned CC transcript
  JSONLs routed by pane id so each pinned tab shows a different
  conversation. On first visit the page pre-seeds pinned tabs +
  active theme (Terminal Green) + active view (CC chat). The
  Discover tab is hidden from Settings in demo (everything is
  pre-installed). Writes (install / uninstall / sendInput /
  uploads / sessions) stay 403 / silent-ack — demo is strictly
  read-only.

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

[Unreleased]: https://github.com/ttyview/ttyview/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/ttyview/ttyview/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ttyview/ttyview/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ttyview/ttyview/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ttyview/ttyview/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ttyview/ttyview/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ttyview/ttyview/releases/tag/v0.1.0
