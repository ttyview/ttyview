# ttyview / Mobile CC — project status board

> **Shared status file across agents.** Edit this file when you start /
> finish work on a feature. The web hub at
> `https://eyalev-thinkpad.taild2ae6a.ts.net:7681/ttyview-links.html`
> fetches and renders this in-line, auto-refresh every 30 s. Keep it
> chronological-newest-first under each heading.
>
> **Format conventions**
> - One block per work item under "Active work". Heading `### YYYY-MM-DD HH:MM — <agent> — <one-line summary>`.
> - Use **Status:** `in-progress` / `blocked` / `done` so the hub can color-tag.
> - When you finish, MOVE the block to "Recently shipped" and shrink it to one line.
> - Be specific. "Investigating X" beats "looking at things".

## Active work

_(no active work — agents add entries here when they start)_

## Recently shipped

- 2026-05-11 — voice dictation plugin (Web Speech API) for ttyview + Mobile CC — `06afbde`
- 2026-05-11 — VS Code Dark+ palette (matches tmux-web; readable URLs in CC output) — `6872553`
- 2026-05-11 — cell-grid: tap CC prompt row → focus Message input (toggle in Display, default on) — `3f46d3b`
- 2026-05-11 — pane picker: render `%4` → `p4` in meta column — `f8806ae`
- 2026-05-11 — pane picker: auto-hide meta column when every session has 1 pane in w0 — `122ee4d`
- 2026-05-11 — pinned-tabs: drop `flex-basis:100%` (was inflating heights when above-input) — `be90c7d`
- 2026-05-11 — pinned-tabs: stale `pin.id` no longer cross-wires the active highlight; siblings scroll independently in stacked slot — `18449d2`
- 2026-05-11 — pinned-tabs: flip parent slot to column when tabs needs its own row — `acee73d`
- 2026-05-11 — pinned-tabs: fixed 1/N column width across all rows in fit mode — `d3decba`
- 2026-05-10 — pinned-tabs: fit mode (equal-width tabs + middle-ellipsis truncation) — `094ff1e`
- 2026-05-10 — settings → Plugins: Obsidian-style toggles + enabled-first sort — `3b4a37f`

## Known issues / open questions

_(agents add here)_

## Backlog ideas

- Server-side STT (Groq / Whisper) as a follow-up to the Web Speech mic — would handle Hebrew + noisy environments better.
- Image-paste end-to-end test (drag file → upload → tmux pane sees the path).
- A "Settings → About this app" pane that shows the active daemon's `--app-name`, port, and config dir at a glance.

## How agents communicate via this file

1. **Starting work?** Add a block under "Active work" with `Status: in-progress`.
2. **Finished?** Replace your block in "Active work" with a one-line entry under "Recently shipped" (with the commit SHA).
3. **Blocked?** Keep the block in "Active work", change status to `blocked`, and add a short reason.

Keep diffs small. The web hub re-renders on a 30 s timer so updates land quickly without reloading.
