# Agent activity logs

> **One `##` section per agent.** Agent ID = your **tmux session name**
> (run `tmux display-message -p '#S'` to find yours — NOT the cwd
> directory like `claude5`). Append entries chronologically-newest-first
> inside your section, dated headings `### YYYY-MM-DD HH:MM — <summary>`
> with bullet notes beneath.
>
> The web hub's Logs tab parses this file and surfaces each agent in
> a dropdown (plus an "All agents (combined)" option that merges
> chronologically across all sections). Auto-refresh every 30 s.
>
> Compare with `STATUS.md` — that's the **shared board** for the
> current state of the project. This file is **per-agent history**:
> what each agent has done over time. Keep both up to date.

## tmux-web5

### 2026-05-11 19:35 — Agent names fixed to use tmux session names

- Was logging under `claude5` (cwd directory name); corrected to
  `tmux-web5` (actual `tmux display-message -p '#S'` output).
- Added stub headings for every currently-running tmux session
  (`tmux-web4`, `ttyview1`, `ttyview2`, `ttyview3`, `assistant1`).
- CLAUDE.md in both ttyview and tmux-web updated with the
  resolution rule.

### 2026-05-11 18:50 — Combined-logs view across agents

- Logs tab dropdown now has "All agents (combined)" at the top.
- Sorted by the leading `YYYY-MM-DD HH:MM` of each `###` entry
  (descending); each heading carries an `[agent]` prefix tag.
- Commit `d0abc11` (tmux-web) + `24759c0` (ttyview).

### 2026-05-11 18:30 — Hub: tabbed layout + per-agent log tab

- Page split into Overview / Apps / Source &amp; paths / Agent logs.
- Logs tab renders AGENTS.md w/ per-agent dropdown.
- CLAUDE.md updated in both ttyview and tmux-web.
- Commits: tmux-web `2713824`, ttyview `29da725`.

### 2026-05-11 17:30 — Project hub w/ shared status board

- New static page `tmux-web/public/ttyview-links.html` at `/ttyview-links.html`.
- Bottom-bar ☰ menu entry "ttyview hub" (🔗) added via `appRegistry`.
- Inline-rendered `STATUS.md`, auto-refresh 30 s, `Status:` pills.
- Commits: tmux-web `e1be95d`, ttyview `6f27757`.

### 2026-05-11 16:55 — Voice dictation plugin (Web Speech API)

- New `ttyview-voice-dictation` plugin in `community-plugins/`.
- 🎤 toggle in keys row; continuous mode; "say enter" submits.
- Settings tab with language picker + say-enter toggle.
- Installed on both ttyview (`:7785`) and Mobile CC (`:7800`).
- Commit `06afbde`.

### 2026-05-11 16:50 — VS Code Dark+ palette in cell-grid

- Swapped xterm-classic 16-color palette for VS Code Dark+ (matches tmux-web).
- Blue `#0000ee` → `#2472c8`; CC's URL output is now readable on the dark bg.
- Commit `6872553`.

### 2026-05-11 16:10 — Tap CC prompt to focus input

- Cell-grid: short tap (≤350 ms, ≤10 px) on the cursor row (±1) focuses `#input-text`.
- Long-press still selects text. `preventDefault` on pointerup + click is load-bearing.
- Toggle in Settings → Display (default on), body class `ttv-tap-prompt-focus`.
- Commit `3f46d3b`.

### 2026-05-11 14:30 — Pane picker `%4` → `p4` + auto-hide meta

- Pane picker renders `p4 · w0 · 60×28` instead of `%4 · …`.
- Auto-hide the whole meta column when every visible session is a single pane in w0.
- Commits `122ee4d`, `f8806ae`.

### 2026-05-11 10:20–14:00 — Pinned-tabs fit mode + follow-on fixes

- Fit mode: each row holds exactly `maxPerRow` tabs, columns line up across rows.
- Middle-ellipsis truncation for long session names.
- Stale `pin.id` no longer cross-wires the active highlight.
- Sibling rows (quickkeys vs tabs) scroll independently in stacked slot.
- Commits `094ff1e`, `d3decba`, `acee73d`, `18449d2`, `be90c7d`.

### 2026-05-10 evening — Obsidian-style Plugins tab

- Settings → Plugins: per-plugin rows with toggle switches + enabled-first sort.
- Commit `3b4a37f`.

## tmux-web4

_(no entries yet — claim this section when a `tmux-web4` agent does work)_

## assistant1

_(no entries yet — claim this section when an `assistant1` agent does work)_

## ttyview1

### 2026-05-11 17:00 — Image paste end-to-end + binary rename + Mobile CC demo-assets repo

- **Image-paste feature** wired daemon-side + client-side:
  - New `crates/ttyview-core/src/api/uploads.rs`: `POST /api/uploads`
    (multipart stage), `DELETE /api/uploads/:id` (cancel),
    `POST /api/uploads/send` (archive → `tmux load-buffer` +
    `paste-buffer` + `send-keys Enter` with capture-pane-fingerprint
    verify-retry up to 3×). 25 MB cap, `~/.cache/ttyview/uploads/`
    default with `--uploads-dir` override, 15-min janitor sweeps
    staging entries past 1 h. Read-only / demo modes 403.
  - New bundled plugin `ttyview-image-paste` (inputAccessory): 📷
    button + paste-event handler on `#input-text` +
    full-page drag-and-drop overlay. Client-side downscale
    (2048 px JPEG q=0.85). Intercepts Send via capture-phase
    listeners on `#send-btn` + Enter keydown — only when the per-
    pane queue has uploads ready; falls through otherwise.
  - Verified end-to-end against a real CC pane: paste → upload →
    Send → daemon paste-buffers `<text> [image: /abs/path]` into
    CC's TUI → CC's vision pipeline reads the file.
- **Binary rename** `ttyview-daemon` → `ttyview` in
  `crates/ttyview-daemon/Cargo.toml` `[[bin]]`. Crate dir + crate
  package name stayed `ttyview-daemon` to keep cargo paths stable.
  All build / CI / deploy / docs / sandbox `--daemon-bin` updated.
- **CLAUDE.md** updated to reflect the new endpoints + the full
  bundled-plugins list (incl. ttyview-image-paste, ttyview-tabs,
  ttyview-pane-picker, ttyview-display-toggles, ttyview-app-name).
- **Mobile CC config polish**:
  - Live manifest `~/.config/ttyview/apps/mobile-cc.json` and the
    ttyview-manager `mobile-cc` template both: dropped the
    decorative `active_view: ttyview-cc` field (cell-grid is the
    OOTB default — `ttyview-cc` stays installed as a switchable
    alternative). Manager template gained `ttyview-image-paste` in
    its plugin list.
- **Demo-assets repo** (separate): created private
  [eyalev/ttyview-mobile-cc-demos](https://github.com/eyalev/ttyview-mobile-cc-demos)
  with `assets/hero.gif` (real CC paste-flow loop, default theme,
  cell-grid view to match real Mobile CC), `assets/initial.png`
  (Pixel-7 framed static), `capture/{capture-screens,make-gif}.mjs`
  (Playwright + ffmpeg), `frames/phone-shell.html`, plus an Android-
  emulator proof-of-concept under `assets/real-device/`. README
  drafted to simulate the future public Mobile CC repo's README.
- **State**: everything in this repo's working tree is **uncommitted**
  (binary rename + image-paste + CLAUDE.md). Demo-assets repo is
  fully committed + pushed. The ttyview-manager template change is
  uncommitted in `ttyview-manager/server.ts`. **Waiting for the
  user's go-ahead before commit + push here.**

## ttyview2

_(no entries yet — claim this section when a `ttyview2` agent does work)_

## ttyview3

_(no entries yet — claim this section when a `ttyview3` agent does work)_
