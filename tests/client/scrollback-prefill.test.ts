// Unit test for the two-phase scrollback load's OVERLAP MATH
// (core's loadDeepScrollback). The fast paint loads the last ~200 lines;
// the background pass then fetches the full configured depth and must
// emit ONLY the rows OLDER than the fast tail — computed from
// scrollback_push_count so a live scroll-off BETWEEN the two fetches
// can't duplicate rows. This logic is pure data wrangling (no layout),
// so happy-dom is enough; the scroll-anchoring half lives in the e2e
// suite (tests/e2e/scrolling.spec.ts) because it needs real layout.
import { describe, it, expect } from 'vitest';
import { loadClient } from './_load-client.ts';

const PANES = [{ id: '%1', session: 's1', window: '0', rows: 3, cols: 4 }];

// A scrollback row tagged with its lifetime "global index" so the test
// can assert exactly which rows were chosen. `_gid` rides along on the
// row object untouched (the client only reads `.cells`).
function row(gid: number) {
  return { _gid: gid, cells: [{ ch: 'x' }], wrapped: false };
}

// Build a /grid response. `gids` are the rows the daemon currently
// retains (oldest-first); `pushCount` is scrollback_push_count (total
// lines ever scrolled off — the cursor the overlap math uses).
function grid(gids: number[], pushCount: number) {
  return {
    size: [3, 4],
    primary: [{ cells: [{ ch: 'p' }], wrapped: false }],
    alt: [],
    scrollback: gids.map(row),
    scrollback_push_count: pushCount,
  };
}

// Drive loadGrid('%1') with query-aware fast/deep responses and return
// the rows the client emitted on 'scrollback-prefill'.
async function prefillGids(fast: any, deep: any): Promise<number[]> {
  const c = await loadClient({
    '/panes': PANES,
    // Boot grid (want defaults to 200 → no deep fetch at boot).
    '/panes/%1/grid': grid([], 0),
  });
  await new Promise((r) => setTimeout(r, 50));

  // Want more than the 200-line fast tail so the deep pass runs.
  c.window.localStorage.setItem('ttv-scrollback-rows', '2000');

  // Query-aware fetch: small max_scrollback → fast, large → deep.
  c.window.fetch = async (url: string) => {
    let body: any = PANES;
    if (url.includes('/grid')) {
      const m = url.match(/max_scrollback=(\d+)/);
      const n = m ? Number(m[1]) : 0;
      body = n > 200 ? deep : fast;
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };

  const prefills: any[] = [];
  c.window.ttyview.on('scrollback-prefill', (e: any) => prefills.push(e));

  await c.window.loadGrid('%1');
  // loadDeepScrollback is fire-and-forget; wait for the deep fetch +
  // emit (or settle if there's nothing older to prepend).
  for (let i = 0; i < 50 && prefills.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return prefills.length ? prefills[0].rows.map((r: any) => r._gid) : [];
}

describe('two-phase scrollback prefill — overlap math', () => {
  it('prepends only rows older than the fast tail (no live gap)', async () => {
    // Fast tail shows global 95..99 (push_count 100). Deep retains
    // 90..99 (push_count 100). Older-than-tail = 90..94.
    const fast = grid([95, 96, 97, 98, 99], 100);
    const deep = grid([90, 91, 92, 93, 94, 95, 96, 97, 98, 99], 100);
    expect(await prefillGids(fast, deep)).toEqual([90, 91, 92, 93, 94]);
  });

  it('excludes rows that scrolled off live during the fetch gap', async () => {
    // Between the fast and deep fetches, 3 new lines scrolled off:
    // fast push_count 100 (tail 95..99); deep push_count 103, retains
    // 93..102. Rows 100..102 already arrived via scrollback-append;
    // 95..99 are the fast tail. Only 93,94 are older-and-unseen.
    const fast = grid([95, 96, 97, 98, 99], 100);
    const deep = grid([93, 94, 95, 96, 97, 98, 99, 100, 101, 102], 103);
    expect(await prefillGids(fast, deep)).toEqual([93, 94]);
  });

  it('emits nothing when the fast tail already covers all history', async () => {
    // Only 4 lines ever scrolled off; the fast tail holds them all.
    // Deep returns the same set → nothing older to prepend.
    const fast = grid([0, 1, 2, 3], 4);
    const deep = grid([0, 1, 2, 3], 4);
    expect(await prefillGids(fast, deep)).toEqual([]);
  });
});
