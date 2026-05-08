# Contributing to ttyview

> Note: external contributions are paused while the platform shape stabilizes (v0.0.x). This document describes the plugin contract for plugin authors targeting the current API. Issues + bug reports are welcome.

## Plugin contract

A ttyview plugin is a single JavaScript file. When it loads, it calls `window.ttyview.contributes.<kind>(def)` to register one or more contributions, then optionally subscribes to platform events. Plugins do not have a manifest in v1 — the registration calls themselves are the manifest.

### The API surface

`window.ttyview` exposes:

```ts
interface TtyviewAPI {
  apiVersion: 1;

  // Pane state + actions
  listPanes(): Pane[];
  getActivePane(): Pane | null;
  selectPane(paneId: string): Promise<void>;
  sendInput(paneId: string | null, keys: string): void;  // null = active pane

  // Events
  on(event: string, handler: (data: any) => void): () => void;  // returns unsubscriber

  // Contributions
  contributes: {
    terminalView(def):   () => void;  // unregister
    theme(def):          () => void;
    headerWidget(def):   () => void;
    inputAccessory(def): () => void;
    settingsTab(def):    () => void;
    command(def):        () => void;
  };

  // Per-plugin storage (localStorage scoped by plugin id)
  storage(pluginId: string): { get, set, remove };
}
```

### Events emitted by the platform

| Event                       | Payload                          | When                                      |
| --------------------------- | -------------------------------- | ----------------------------------------- |
| `pane-changed`              | `{from, to}`                     | active pane switched                      |
| `panes-updated`             | `Pane[]`                         | pane list refetched                       |
| `grid-loaded`               | `{paneId, screen}`               | full grid arrived                         |
| `cell-diff`                 | `{p, cells: [{r,c,ch,fg,bg,...}]}` | per-cell update over WS                  |
| `scrollback-append`         | `{p, rows}`                      | rows promoted from primary to scrollback  |
| `pane-clearing`             | `{from, to}`                     | active pane is about to switch            |
| `terminal-view-activated`   | `{id}`                           | a terminalView became active              |
| `theme-activated`           | `{id}`                           | a theme became active                     |
| `<kind>-registered`         | `def`                            | any contribution registered               |
| `<kind>-unregistered`       | `def`                            | any contribution removed                  |

## Contribution kinds

### `terminalView`

Replaces the entire terminal-rendering area. The platform calls your `render(host, ctx)` and you own everything inside `host`.

```js
window.ttyview.contributes.terminalView({
  id: 'my-view',
  name: 'My View',
  description: 'optional, shown in Settings',
  render(host, ctx) {
    // host is an empty <div>; populate it.
    // Subscribe to grid-loaded / cell-diff / scrollback-append / pane-clearing.
    const off = ctx.api.on('grid-loaded', d => { /* render screen */ });
    return () => { off(); host.innerHTML = ''; };  // unmount
  },
});
```

Two terminal views ship by default: `cell-grid` (full per-cell DOM with fg/bg colors) and `ttyview-text` (plain text rows; lighter DOM, no colors). Either can be replaced.

### `theme`

A theme overrides any of these CSS variables on `:root`:

```
--ttv-bg          base background
--ttv-fg          base foreground
--ttv-bg-elev     elevated surfaces (header, settings tabs)
--ttv-bg-elev2    panel backgrounds (settings panel, picker)
--ttv-border      hairlines and dividers
--ttv-accent      primary accent (links, active tab, status connected)
--ttv-muted       secondary text (placeholders, meta lines)
```

```js
window.ttyview.contributes.theme({
  id: 'my-theme',
  name: 'My Theme',
  vars: {
    '--ttv-bg':     '#001b26',
    '--ttv-fg':     '#cad8d8',
    '--ttv-accent': '#5dabe3',
    // others fall back to platform defaults
  },
});
```

Activate from Settings → Plugins → Themes. Active theme persists across reloads.

### `headerWidget`

A span inside the top header row. Each registered widget gets its own slot.

```js
window.ttyview.contributes.headerWidget({
  id: 'my-widget',
  name: 'My Widget',
  render(slot) {
    const span = document.createElement('span');
    span.textContent = 'hello';
    slot.appendChild(span);
    return () => span.remove();   // unmount
  },
});
```

### `inputAccessory`

Buttons rendered horizontally above the chat input. The container is hidden until at least one accessory mounts; it scrolls horizontally on overflow. Designed for mobile soft-keyboard hotkeys (Esc/Tab/Ctrl-C are not on the soft keyboard).

```js
window.ttyview.contributes.inputAccessory({
  id: 'my-keys',
  name: 'My Keys',
  render(slot) {
    const btn = document.createElement('button');
    btn.textContent = 'Esc';
    btn.addEventListener('click', () => window.ttyview.sendInput(null, '\x1b'));
    // Prevent stealing focus from the textarea, keeps the soft keyboard up:
    btn.addEventListener('mousedown', e => e.preventDefault());
    slot.appendChild(btn);
    return () => btn.remove();
  },
});
```

### `settingsTab`

Adds a tab to the Settings overlay. Your `render(container)` is called every time the tab becomes active.

```js
window.ttyview.contributes.settingsTab({
  id: 'my-tab',
  title: 'My Tab',
  render(container) {
    container.textContent = 'My settings UI here.';
  },
});
```

### `command`

Currently registers commands but no UI invokes them yet. Reserved for the upcoming command palette.

## Registry

The Discover tab lists plugins from a registry. By default the daemon serves a small bundled catalog; pass `--registry-url <URL>` to point at any HTTPS-served `registry.json`:

```json
{
  "schema": 1,
  "plugins": [
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "description": "what it does",
      "version": "1.0.0",
      "author": "you",
      "kind": "headerWidget",
      "source": "https://raw.githubusercontent.com/you/repo/main/my-plugin.js"
    }
  ]
}
```

`source` can be either a relative filename (resolved against the bundled directory) or an absolute http(s) URL (fetched + proxied through the daemon to avoid client-side CORS).

## Lifecycle rules

- **Idempotent registration.** Plugins may be loaded multiple times across an installer run + a page reload. Use a unique `id` so re-registering replaces cleanly.
- **Always return an unmount fn.** Whatever your `render()` did to the DOM, undo it. The platform calls unmount when the user uninstalls or the contribution is reactivated.
- **Crash isolation.** The platform catches exceptions thrown from `render()` / `unmount()` per-plugin so a buggy plugin can't blank the whole UI. Don't rely on this for normal logic — log + recover yourself.
- **No globals.** Wrap your plugin in an IIFE so module-scope vars don't leak.
- **Storage:** use `window.ttyview.storage('your-plugin-id')` to persist preferences. Each plugin's storage is namespaced under `ttv-plugin:<id>:`.

## Local development

To iterate on a plugin without rebuilding the daemon:

1. Drop your `<id>.js` into `~/.config/ttyview/plugins/`.
2. Add an entry to `~/.config/ttyview/plugins/installed.json` (use `curl -X POST /plugins/install -d '{"id":"..."}'` or hand-edit the file).
3. Reload the page. The boot loader fetches + evals your source.

Bundle plugins (shipped with the daemon binary) live at `crates/ttyview-core/community-plugins/`. Modify `registry.json` and the `.js` source files; `cargo build --release` re-bakes them via `rust-embed`.

## Tests

- `tests/client/` — vitest, 35 cases against `crates/ttyview-core/ui/index.html` loaded into happy-dom. Covers wire protocol, rendering, pane switch, plugin API, plugin install/uninstall, colors.
- `tests/e2e/` — Playwright end-to-end harness (work in progress).

Run client tests:

```bash
cd tests/client && npm install && npx vitest run
```
