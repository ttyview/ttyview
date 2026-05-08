// Phase 3: plugin install/uninstall + headerWidget contribution.
// Verifies: register/unregister mounts/unmounts in #header-widgets,
// installed plugins are eval'd at boot, install POSTs and triggers
// live-load, uninstall DELETEs and tears down contributions.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's', window: '0', rows: 1, cols: 4 }];
const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

const FETCHES_NO_PLUGINS: Record<string, any> = {
  '/panes': PANES,
  '/panes/%1/grid': GRID,
  '/plugins/installed': { schema: 1, plugins: [] },
};

describe('headerWidget contribution point', () => {
  it('registering a headerWidget mounts it; unregistering tears it down', async () => {
    const c = await loadClient(FETCHES_NO_PLUGINS);
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    let unmountCalled = false;

    const unreg = tv.contributes.headerWidget({
      id: 'test-widget',
      name: 'Test',
      render(slot: HTMLElement) {
        const span = c.document.createElement('span');
        span.id = 'test-widget-marker';
        span.textContent = 'HELLO';
        slot.appendChild(span);
        return () => { unmountCalled = true; };
      },
    });

    const marker = c.document.getElementById('test-widget-marker');
    expect(marker).toBeTruthy();
    expect(marker!.textContent).toBe('HELLO');

    // Slot should sit inside #header-widgets, with data-plugin-id matching.
    const $hw = c.document.getElementById('header-widgets')!;
    const slot = $hw.querySelector('[data-plugin-id="test-widget"]');
    expect(slot).toBeTruthy();

    unreg();
    expect(unmountCalled).toBe(true);
    expect(c.document.getElementById('test-widget-marker')).toBeNull();
    expect($hw.querySelector('[data-plugin-id="test-widget"]')).toBeNull();
  });

  it('a buggy widget render does not blank the header', async () => {
    const c = await loadClient(FETCHES_NO_PLUGINS);
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    // Register a sane widget first
    tv.contributes.headerWidget({
      id: 'sane', name: 'Sane',
      render(slot: HTMLElement) {
        const s = c.document.createElement('span');
        s.id = 'sane-marker';
        slot.appendChild(s);
      },
    });
    // Then a broken one
    tv.contributes.headerWidget({
      id: 'broken', name: 'Broken',
      render() { throw new Error('oops'); },
    });
    // The sane widget is still rendered
    expect(c.document.getElementById('sane-marker')).toBeTruthy();
    // The slot for the broken plugin still exists (we don't roll back
    // mount on error — the slot is just empty). Verify nothing crashed.
    const $hw = c.document.getElementById('header-widgets')!;
    expect($hw.querySelector('[data-plugin-id="sane"]')).toBeTruthy();
    expect($hw.querySelector('[data-plugin-id="broken"]')).toBeTruthy();
  });
});

describe('plugin install / uninstall', () => {
  it('boot loads installed plugins and evals their source', async () => {
    const SOURCE = `
      window.ttyview.contributes.headerWidget({
        id: 'remote-widget', name: 'Remote',
        render: function(slot) {
          var s = document.createElement('span');
          s.id = 'remote-widget-marker';
          s.textContent = 'REMOTE';
          slot.appendChild(s);
        },
      });
    `;
    const c = await loadClient({
      '/panes': PANES,
      '/panes/%1/grid': GRID,
      '/plugins/installed': { schema: 1, plugins: [
        { id: 'remote-widget', name: 'Remote', description: '', version: '1', kind: 'headerWidget', source: 'remote-widget.js', installed_at: 1 },
      ]},
      '/plugins/installed/remote-widget/source': SOURCE,
    });
    // Wait long enough for the boot loader to fetch + eval the plugin
    // AND for the headerWidget mount to flush.
    await new Promise(r => setTimeout(r, 250));
    expect(c.document.getElementById('remote-widget-marker')).toBeTruthy();
  });

  it('installPlugin posts /plugins/install and live-loads the plugin', async () => {
    const SOURCE = `
      window.ttyview.contributes.headerWidget({
        id: 'newp', name: 'New',
        render: function(slot) {
          var s = document.createElement('span');
          s.id = 'newp-marker';
          slot.appendChild(s);
        },
      });
    `;
    const c = await loadClient(FETCHES_NO_PLUGINS);
    await new Promise(r => setTimeout(r, 100));
    // Pre-stub the install endpoint + the source endpoint that
    // installPlugin will fetch as a follow-up.
    c.setFetchResponse('/plugins/install', {
      ok: true,
      plugin: { id: 'newp', name: 'New', description: '', version: '1', kind: 'headerWidget', source: 'newp.js', installed_at: 1 },
      error: null,
    });
    c.setFetchResponse('/plugins/installed/newp/source', SOURCE);

    await (c.window as any).installPlugin('newp');
    await new Promise(r => setTimeout(r, 50));
    expect(c.document.getElementById('newp-marker')).toBeTruthy();
  });

  it('uninstallPlugin DELETEs and removes the plugin from registries', async () => {
    const c = await loadClient(FETCHES_NO_PLUGINS);
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    tv.contributes.headerWidget({
      id: 'doomed', name: 'Doomed',
      render(slot: HTMLElement) {
        const s = c.document.createElement('span');
        s.id = 'doomed-marker';
        slot.appendChild(s);
      },
    });
    expect(c.document.getElementById('doomed-marker')).toBeTruthy();
    expect(tv._internal.registries.headerWidget.has('doomed')).toBe(true);

    c.setFetchResponse('/plugins/uninstall/doomed', { ok: true, error: null });

    await (c.window as any).uninstallPlugin('doomed');
    await new Promise(r => setTimeout(r, 50));
    expect(tv._internal.registries.headerWidget.has('doomed')).toBe(false);
    expect(c.document.getElementById('doomed-marker')).toBeNull();
  });
});
