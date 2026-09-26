/** Spawn SchemaForge entry points from source with tsx (never writes into mcp-server/). */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E_ROOT, MCP_SRC } from './env.js';

const require = createRequire(path.join(E2E_ROOT, 'package.json'));
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;

export function spawnSource(relativeEntry: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', TSX_LOADER, path.join(MCP_SRC, relativeEntry), ...args],
    { cwd: E2E_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
}

export interface ExitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run to completion (or kill after timeoutMs) and capture output. */
export function runToExit(
  relativeEntry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<ExitResult> {
  return new Promise((resolve) => {
    const child = spawnSource(relativeEntry, args, env);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

export function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}
