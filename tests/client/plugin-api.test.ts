// Plugin API contract: window.ttyview must expose a stable surface
// for plugins to use. This test fixes the API shape so future
// changes are deliberate (and bump apiVersion if they break).
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's1', window: '0', rows: 1, cols: 4 }];
const GRID = {
  size: [1, 4],
  primary: [{ cells: [{ ch: 'a' }, { ch: ' ' }, { ch: ' ' }, { ch: ' ' }], wrapped: false }],
  alt: [], scrollback: [],
};

describe('window.ttyview plugin API', () => {
  it('exposes apiVersion + the contract surface', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': GRID });
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    expect(tv).toBeTruthy();
    expect(tv.apiVersion).toBe(1);
    expect(typeof tv.listPanes).toBe('function');
    expect(typeof tv.getActivePane).toBe('function');
    expect(typeof tv.selectPane).toBe('function');
    expect(typeof tv.sendInput).toBe('function');
    expect(typeof tv.on).toBe('function');
    expect(tv.contributes).toBeTruthy();
    expect(typeof tv.contributes.terminalView).toBe('function');
    expect(typeof tv.contributes.settingsTab).toBe('function');
    expect(typeof tv.contributes.command).toBe('function');
    expect(typeof tv.contributes.theme).toBe('function');
    expect(typeof tv.storage).toBe('function');
  });

  it('listPanes / getActivePane return current state', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': GRID });
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    expect(tv.listPanes().length).toBe(1);
    expect(tv.listPanes()[0].id).toBe('%1');
    expect(tv.getActivePane()?.id).toBe('%1');
  });

  it('on() subscribes to events; pane-changed fires on selectPane', async () => {
    const c = await loadClient({
      '/panes': [
        { id: '%1', session: 's1', window: '0', rows: 1, cols: 4 },
        { id: '%2', session: 's2', window: '0', rows: 1, cols: 4 },
      ],
      '/panes/%1/grid': GRID,
      '/panes/%2/grid': GRID,
    });
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    const events: any[] = [];
    tv.on('pane-changed', (d: any) => events.push(d));
    await tv.selectPane('%2');
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ from: '%1', to: '%2' });
  });

  it('contributes.terminalView returns an unregister function', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': GRID });
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    const before = tv._internal.registries.terminalView.size;
    const unreg = tv.contributes.terminalView({
      id: 'test-view', name: 'Test View', render() {},
    });
    expect(tv._internal.registries.terminalView.size).toBe(before + 1);
    unreg();
    expect(tv._internal.registries.terminalView.size).toBe(before);
  });

  it('cell-grid is registered as a built-in terminal view', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': GRID });
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    const cg = tv._internal.registries.terminalView.get('cell-grid');
    expect(cg).toBeTruthy();
    expect(cg.name).toBe('Cell Grid');
    expect(tv._internal.getActiveTerminalViewId()).toBe('cell-grid');
  });

  it('storage(pluginId) is scoped per plugin', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': GRID });
    await new Promise(r => setTimeout(r, 100));
    const tv = (c.window as any).ttyview;
    const a = tv.storage('plugin-a');
    const b = tv.storage('plugin-b');
    a.set('key', { value: 1 });
    b.set('key', { value: 2 });
    expect(a.get('key')).toEqual({ value: 1 });
    expect(b.get('key')).toEqual({ value: 2 });
    a.remove('key');
    expect(a.get('key')).toBeNull();
    expect(b.get('key')).toEqual({ value: 2 });
  });

  it('settings overlay exists and opens via #settings-btn', async () => {
    const c = await loadClient({ '/panes': PANES, '/panes/%1/grid': GRID });
    await new Promise(r => setTimeout(r, 100));
    const overlay = c.document.getElementById('settings-overlay')!;
    expect(overlay.className).not.toContain('open');
    const btn = c.document.getElementById('settings-btn') as any;
    btn.click();
    expect(overlay.className).toContain('open');
    // Master/detail layout: master list shows Options + Plugin options
    // sections with Plugins / Discover / Layout / About as items.
    const masterItems = overlay.querySelectorAll('#settings-master .ms-item');
    // First span is the label, second is the chevron — read the label.
    const masterTitles = Array.from(masterItems).map((n: any) => n.querySelector('span').textContent);
    expect(masterTitles).toContain('Plugins');
    expect(masterTitles).toContain('About');
    // Drill into Plugins → cards with the registered terminal views appear.
    const pluginsRow = Array.from(masterItems).find((n: any) => n.querySelector('span').textContent === 'Plugins') as any;
    pluginsRow.click();
    const cards = overlay.querySelectorAll('.plugin-card .name');
    const names = Array.from(cards).map((n: any) => n.textContent);
    expect(names).toContain('Cell Grid');
  });
});
