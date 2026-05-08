// Spawn a fresh tmux server + a fresh ttyview-daemon for an e2e
// run. Uses an isolated tmux socket and a dedicated port so it
// doesn't collide with the user's local tmux/dev daemon.
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../..');
export const DAEMON_BIN = resolve(REPO_ROOT, 'target/release/ttyview-daemon');
export const TEST_PORT = 7686;
export const TEST_SOCKET = 'ttyview-test';
export const TEST_SESSION = 'ttyview-e2e';

export interface E2eEnv {
  daemonPid: number;
  cleanup: () => Promise<void>;
  tmuxCmd: (args: string[]) => { stdout: string; stderr: string; code: number | null };
  tmuxCapturePane: (paneId: string) => string;
  /** Pane id of the test tmux session (e.g. "%0"). */
  paneId: string;
}

function tmux(args: string[]) {
  const r = spawnSync('tmux', ['-L', TEST_SOCKET, ...args], { encoding: 'utf-8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

export async function startE2e(): Promise<E2eEnv> {
  // Tear down any leftover state from a previous run
  tmux(['kill-server']);
  // 1) Fresh tmux session running a placeholder shell — we'll
  //    interact with this session in tests via send-keys.
  const newSess = tmux([
    'new-session', '-d', '-s', TEST_SESSION,
    '-x', '80', '-y', '24',
    'bash', '--noprofile', '--norc',
  ]);
  if (newSess.code !== 0) throw new Error('tmux new-session: ' + newSess.stderr);

  // Get the pane id
  const pid = tmux(['display-message', '-p', '-t', TEST_SESSION, '#{pane_id}']);
  const paneId = pid.stdout.trim();

  // 2) Spawn the daemon (no TLS — http for tests)
  const daemon = spawn(DAEMON_BIN, [
    '--bind', '127.0.0.1:' + TEST_PORT,
    '--socket', TEST_SOCKET,
  ], { stdio: 'pipe' });
  daemon.stderr.on('data', (b) => { /* swallow unless debugging */ });

  // 3) Wait for the daemon to be ready (HTTP 307 redirect on /)
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + TEST_PORT + '/', { redirect: 'manual' });
      if (r.status === 307 || r.status === 200) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  return {
    daemonPid: daemon.pid!,
    paneId,
    tmuxCmd: tmux,
    tmuxCapturePane: (id) => tmux(['capture-pane', '-p', '-t', id]).stdout,
    cleanup: async () => {
      try { daemon.kill('SIGTERM'); } catch {}
      // Wait for daemon to exit
      for (let i = 0; i < 30; i++) {
        try { process.kill(daemon.pid!, 0); } catch { break; }
        await new Promise(r => setTimeout(r, 100));
      }
      tmux(['kill-server']);
    },
  };
}
