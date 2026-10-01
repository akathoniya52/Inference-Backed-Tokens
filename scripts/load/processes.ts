// Child processes for the load test: the mock upstream and the api run from source under tsx,
// each in its own process group so a stop kills tsx and the node process it spawns.
import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const STOP_GRACE_MS = 5_000;
const POLL_MS = 250;

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

export interface Child {
  name: string;
  /** Resolves once the process group is gone; safe to call more than once. */
  stop: () => Promise<void>;
  /** Exit description once the process has exited, else null. */
  exited: () => string | null;
}

const running = new Set<ChildProcess>();

function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal);
  } catch (_err) {
    // ESRCH: the group is already gone.
  }
}

// Last resort when the parent exits without running the async cleanup (uncaught error).
process.once('exit', () => {
  for (const proc of running) killGroup(proc, 'SIGKILL');
});

function forward(name: string, stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  const lines = createInterface({ input: stream });
  lines.on('line', (line) => {
    process.stderr.write(`[${name}] ${line}\n`);
  });
}

/** Runs `tsx --conditions=development <entry>` in `cwd` with exactly `env`. */
export function startTsx(
  name: string,
  cwd: string,
  entry: string,
  env: Record<string, string>,
): Child {
  const proc = spawn(process.execPath, [TSX_CLI, '--conditions=development', entry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  running.add(proc);
  forward(name, proc.stdout);
  forward(name, proc.stderr);

  let exitInfo: string | null = null;
  const exitedPromise = new Promise<void>((resolve) => {
    proc.once('exit', (code, signal) => {
      exitInfo = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      running.delete(proc);
      resolve();
    });
    proc.once('error', (err) => {
      exitInfo = `spawn error: ${err.message}`;
      running.delete(proc);
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (exitInfo === null) {
      killGroup(proc, 'SIGTERM');
      const timedOut = await Promise.race([
        exitedPromise.then(() => false),
        sleep(STOP_GRACE_MS).then(() => true),
      ]);
      if (timedOut) killGroup(proc, 'SIGKILL');
      await exitedPromise;
    }
    // tsx may exit before the node grandchild; sweep the group either way.
    killGroup(proc, 'SIGKILL');
  };

  return { name, stop, exited: () => exitInfo };
}

/** Polls `url` until it answers 200; fails fast if `child` dies first. */
export async function waitForOk(url: string, child: Child, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    const exited = child.exited();
    if (exited !== null) throw new Error(`${child.name} exited (${exited}) before ${url} was up`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel();
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${child.name}: ${url} not ready after ${timeoutMs} ms (${last})`);
}
