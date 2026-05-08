// Wire protocol contract test.
//
// This is the regression test for the kind/t bug we hit on 2026-05-08:
// the client was sending {kind:'input', ...} but the server expects
// {t:'input', ...}. This test asserts the client emits the SHAPE the
// fixture documents.
//
// The same fixture is referenced by Rust integration tests, so any
// drift between client + server breaks one side's tests before ship.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/ws-messages.json'), 'utf-8'),
);

const PANES_FIXTURE = [
  { id: '%6', session: 'claude7', window: '0', rows: 28, cols: 60 },
];
const GRID_FIXTURE = {
  size: [28, 60],
  primary: Array.from({ length: 28 }, () => ({
    cells: Array.from({ length: 60 }, () => ({ ch: ' ' })),
    wrapped: false,
  })),
  alt: [],
  scrollback: [],
};

describe('client → server wire protocol', () => {
  it('subscribe message uses t:"sub"', async () => {
    const c = await loadClient({
      '/panes': PANES_FIXTURE,
      '/panes/%6/grid': GRID_FIXTURE,
    });
    await new Promise(r => setTimeout(r, 100)); // let bootstrap settle

    const subFrames = c.wsSent.filter(f => f.t === 'sub');
    expect(subFrames.length).toBeGreaterThan(0);
    const sub = subFrames[0];

    const fixture = FIXTURE.client_to_server.subscribe;
    expect(sub.t).toBe(fixture.t_value);
    for (const field of fixture.required_fields) {
      expect(sub).toHaveProperty(field);
    }
    // Critical: NOT the wrong field name
    expect(sub).not.toHaveProperty('kind');
  });

  it('input message uses t:"input" with keys field', async () => {
    const c = await loadClient({
      '/panes': PANES_FIXTURE,
      '/panes/%6/grid': GRID_FIXTURE,
    });
    await new Promise(r => setTimeout(r, 100));

    // Drive the input UI
    const input = c.document.getElementById('input-text') as any;
    const sendBtn = c.document.getElementById('send-btn') as any;
    input.value = 'hi';
    sendBtn.click();
    await new Promise(r => setTimeout(r, 50));

    const inputFrames = c.wsSent.filter(f => f.t === 'input');
    expect(inputFrames.length).toBe(1);
    const sent = inputFrames[0];

    const fixture = FIXTURE.client_to_server.input;
    expect(sent.t).toBe(fixture.t_value);
    expect(sent).not.toHaveProperty('kind');
    for (const field of fixture.required_fields) {
      expect(sent).toHaveProperty(field);
    }
    // Body content: "hi" with appended CR (so the message submits)
    expect(sent.keys).toBe('hi\r');
    expect(sent.p).toBe('%6');
  });

  it('newlines in input convert to CR (Ink/bash readline read CR as Enter)', async () => {
    const c = await loadClient({
      '/panes': PANES_FIXTURE,
      '/panes/%6/grid': GRID_FIXTURE,
    });
    await new Promise(r => setTimeout(r, 100));

    const input = c.document.getElementById('input-text') as any;
    const sendBtn = c.document.getElementById('send-btn') as any;
    input.value = 'line1\nline2';
    sendBtn.click();
    await new Promise(r => setTimeout(r, 50));

    const inputFrames = c.wsSent.filter(f => f.t === 'input');
    expect(inputFrames[0].keys).toBe('line1\rline2\r');
    expect(inputFrames[0].keys).not.toContain('\n');
  });

  it('switching panes sends unsub for old + sub for new', async () => {
    const c = await loadClient({
      '/panes': [
        { id: '%6', session: 'claude7', window: '0', rows: 28, cols: 60 },
        { id: '%2', session: 'assistant1', window: '0', rows: 28, cols: 60 },
      ],
      '/panes/%6/grid': GRID_FIXTURE,
      '/panes/%2/grid': GRID_FIXTURE,
    });
    await new Promise(r => setTimeout(r, 100));
    c.wsSent.length = 0; // reset

    const sel = c.document.getElementById('pane-select') as any;
    sel.value = '%2';
    sel.dispatchEvent(new c.window.Event('change'));
    await new Promise(r => setTimeout(r, 100));

    // Should see unsub for %6 then sub for %2 (in that order)
    const tags = c.wsSent.map(f => `${f.t}:${f.p}`);
    expect(tags).toContain('unsub:%6');
    expect(tags).toContain('sub:%2');
    expect(tags.indexOf('unsub:%6')).toBeLessThan(tags.indexOf('sub:%2'));
  });
});

describe('server → client schema (fixture documentation)', () => {
  // These don't exercise the client; they assert the fixture file
  // itself is well-formed. If a future change accidentally removes a
  // required_field entry, this fails.
  it('every server-to-client schema declares t_value matching example', () => {
    for (const [name, schema] of Object.entries<any>(FIXTURE.server_to_client)) {
      expect(schema._example.t, `${name} example.t mismatch`).toBe(schema.t_value);
      for (const field of schema.required_fields) {
        expect(schema._example, `${name} missing required field ${field}`).toHaveProperty(field);
      }
    }
  });
  it('every client-to-server schema declares t_value matching example', () => {
    for (const [name, schema] of Object.entries<any>(FIXTURE.client_to_server)) {
      expect(schema._example.t, `${name} example.t mismatch`).toBe(schema.t_value);
    }
  });
});
