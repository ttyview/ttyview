# Agent activity logs

> **One `##` section per agent.** Agent ID = your tmux session name
> (e.g. `claude5`, `claude1`, `assistant1`). Append entries
> chronologically-newest-first inside your section, dated headings
> `### YYYY-MM-DD HH:MM — <one-line summary>`. Bullet-style notes
> beneath.
>
> The web hub (Logs tab) parses this file and surfaces each agent in
> a dropdown so you can scan one agent's full history without noise
> from the others. Auto-refresh every 30 s.
>
> Compare with `STATUS.md` — that's the **shared board** for the
> current state of the project. This file is **per-agent history**:
> what each agent has done over time. Keep both up to date.

## claude5

### 2026-05-11 18:50 — Project hub with tabs + per-agent logs

- Added tabs to `ttyview-links.html` (Overview / Apps / Source &amp; Paths / Logs).
- Wired the Logs tab to render `AGENTS.md` with a per-agent dropdown.
- CLAUDE.md updated in both ttyview and tmux-web to document the workflow.

### 2026-05-11 18:30 — Project hub w/ shared status board

- New static page `tmux-web/public/ttyview-links.html`, served at `/ttyview-links.html`.
- Bottom-bar ☰ menu entry "ttyview hub" (🔗) added via `appRegistry`.
- Inline-rendered `STATUS.md`, auto-refresh 30 s, `Status:` pills.
- Commits: tmux-web `e1be95d`, ttyview `6f27757`.

### 2026-05-11 17:30 — Voice dictation plugin (Web Speech API)

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
- Long-press still selects text. `preventDefault` on pointerup + click is load-bearing — otherwise synthetic mousedown re-blurs the textarea.
- Toggle in Settings → Display (default on), body class `ttv-tap-prompt-focus`.
- Commit `3f46d3b`.

### 2026-05-11 14:30 — Pane picker `%4` → `p4` + auto-hide meta

- Pane picker renders `p4 · w0 · 60×28` instead of `%4 · …`. Underlying `p.id` unchanged.
- Auto-hide the whole meta column when every visible session is a single pane in w0 — identical noise on every row otherwise. Toggle in Settings → Pane Picker to force verbose view.
- Commits `122ee4d`, `f8806ae`.

### 2026-05-11 10:20–14:00 — Pinned-tabs fit mode + follow-on fixes

- Fit mode: each row holds exactly `maxPerRow` tabs, columns line up across rows.
- Middle-ellipsis truncation for long session names (binary-search width fit).
- `flex-basis:100%` was inflating heights when tabs lived in above-input — removed.
- Stale `pin.id` no longer cross-wires the active highlight (session-match check).
- Sibling rows (quickkeys vs tabs) scroll independently in stacked slot.
- Commits `094ff1e`, `d3decba`, `acee73d`, `18449d2`, `be90c7d`.

### 2026-05-10 evening — Obsidian-style Plugins tab

- Settings → Plugins: per-plugin rows with toggle switches + enabled-first sort.
- Replaces the previous per-kind sections.
- Commit `3b4a37f`.

## claude1

_(no entries yet — claude1 agent: add yours here)_

## assistant1

_(no entries yet — assistant1 agent: add yours here)_
