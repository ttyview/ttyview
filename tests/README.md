# Tests

Three layers, each with a different speed/coverage tradeoff.

```
tests/
├── fixtures/
│   └── ws-messages.json     # WS protocol contract (referenced by client + server tests)
├── client/                  # Vitest + happy-dom — fast, mocked
│   ├── _load-client.ts
│   ├── wire-protocol.test.ts
│   └── rendering.test.ts
├── e2e/                     # Playwright + real daemon + real tmux — slow, end-to-end
│   ├── _helpers.ts
│   ├── send-input.spec.ts
│   └── scrolling.spec.ts
└── README.md
```

## Run locally

```bash
# Rust unit + integration (fast, no setup)
cargo test --workspace

# Client unit (~1.5s, no setup beyond node 22)
cd tests/client && npm install && npm test

# E2E (real daemon + real tmux, ~5s after first install)
cargo build --release
cd tests/e2e && npm install && npx playwright install chromium && npm test
```

## What each layer catches

### Rust unit tests (`cargo test`)
- `vte` parser correctness
- `Screen` state mutations + history rotation
- Cell-diff broadcaster behavior
- `tmux -C` control mode protocol parsing
- Inherited from upstream `panel`

### Client unit tests (`tests/client/`)
- **Wire protocol contract** — the test that catches the kind/t-class
  bugs. References `tests/fixtures/ws-messages.json` to validate the
  exact JSON shape of `sub`/`unsub`/`input` frames the client emits.
- **Grid rendering** — given a `/grid` response, does `buildGrid` produce
  the right DOM? Frozen scrollback in `#sb-host`, primary in
  `#primary-host`, etc.
- **Frozen-past invariant** — a cell-diff event addressed to (r,c) where
  r maps to a scrollback row must NOT mutate that row (it's only in the
  primary cell map).
- **Pane switch sub/unsub ordering** — switching panes sends `unsub` for
  the old pane, then `sub` for the new pane.

### E2E tests (`tests/e2e/`)
- **Real daemon spawned** with isolated tmux socket on a dedicated port
- **Real Playwright browser** drives the served UI
- **send-input.spec.ts** — typing in the textarea + clicking Send
  (and Enter-to-submit) actually delivers keys to the tmux pane
- **scrolling.spec.ts** — pumping output into the pane produces frozen
  scrollback rows; the host is scrollable when content exceeds viewport
- WS frame inspection via Playwright's `framesent` event — catches
  schema drift between client + server even on the e2e path

## Adding tests

For a new client behavior: add a test under `tests/client/`. Use
`loadClient({ '/panes': [...], '/panes/<id>/grid': {...} })` to set up
the fixture data, then drive the DOM and inspect `wsSent` /
`document.querySelector(...)`.

For a new wire protocol message: update `tests/fixtures/ws-messages.json`
FIRST (this is the contract). Then implement on the daemon and client
sides. Both should reference the fixture in their tests.

For an end-to-end flow: add a `*.spec.ts` under `tests/e2e/`. Use
`startE2e()` from `_helpers.ts` to spawn daemon + tmux; cleanup runs
automatically on `afterAll`.

## CI

GitHub Actions workflow at `.github/workflows/ci.yml`:

| Job | What | Runs on |
|---|---|---|
| `rust` | `cargo build --release && cargo test --workspace` | every push + PR |
| `client-unit` | `cd tests/client && npm test` | every push + PR |
| `e2e` | tmux install, download daemon artifact, Playwright | every push + PR (depends on `rust`) |

Total CI time ~3-5 minutes including build cache.
