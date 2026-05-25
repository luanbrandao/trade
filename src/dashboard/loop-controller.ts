import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { LoopStatus, LogLine } from './types';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PID_FILE = path.join(PROJECT_ROOT, 'data', 'loop.pid');
const DEFAULT_ARGS = [require.resolve('ts-node/dist/bin'), 'src/cli.ts', 'dryrun'];
const RING_MAX = 500;

export interface LoopControllerOpts {
  command?: string;
  args?: string[];
  pidFile?: string;
}

export class LoopController extends EventEmitter {
  private command: string;
  private args: string[];
  private pidFile: string;
  private child: ChildProcess | null = null;
  private startedAt: number | null = null;
  private adoptedPid: number | null = null;
  private ring: LogLine[] = [];

  constructor(opts: LoopControllerOpts = {}) {
    super();
    this.command = opts.command ?? process.execPath;
    this.args = opts.args ?? DEFAULT_ARGS;
    this.pidFile = opts.pidFile ?? DEFAULT_PID_FILE;
    this.recoverFromPidFile();
  }

  isRunning(): boolean {
    if (this.child && this.child.exitCode === null && !this.child.killed) return true;
    if (this.adoptedPid != null) {
      try {
        process.kill(this.adoptedPid, 0);
        return true;
      } catch {
        this.adoptedPid = null;
        this.clearPidFile();
        return false;
      }
    }
    return false;
  }

  status(): LoopStatus {
    const running = this.isRunning();
    const pid = this.child?.pid ?? this.adoptedPid ?? null;
    const startedAt = running ? this.startedAt : null;
    return {
      running,
      pid: running ? pid : null,
      startedAt,
      uptimeSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
      lastTickAt: null, // filled in by StatsReader
      adopted: running && this.child === null && this.adoptedPid != null,
    };
  }

  start(): { ok: boolean; pid?: number; reason?: string } {
    if (this.isRunning()) return { ok: false, reason: 'already running' };
    try {
      const child = spawn(this.command, this.args, {
        cwd: PROJECT_ROOT,
        // TRADE_MODE forced to dryrun (defense in depth).
        // TS_NODE_TRANSPILE_ONLY skips per-spawn type-checking — without it
        // ts-node takes 20s+ to boot before the loop emits its first log.
        env: { ...process.env, TRADE_MODE: 'dryrun', TS_NODE_TRANSPILE_ONLY: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      this.child = child;
      this.adoptedPid = null;
      this.startedAt = Date.now();
      this.ensureDataDir();
      fs.writeFileSync(this.pidFile, String(child.pid));

      child.stdout?.on('data', (c: Buffer) => this.push('stdout', c.toString()));
      child.stderr?.on('data', (c: Buffer) => this.push('stderr', c.toString()));
      child.on('exit', (code, sig) => {
        this.clearPidFile();
        this.child = null;
        this.startedAt = null;
        this.emit('loop', { running: false, reason: `exited code=${code ?? '?'} sig=${sig ?? '-'}` });
      });

      this.emit('loop', { running: true, reason: 'spawned' });
      return { ok: true, pid: child.pid };
    } catch (err: any) {
      return { ok: false, reason: err.message };
    }
  }

  async stop(): Promise<{ ok: boolean }> {
    const pid = this.child?.pid ?? this.adoptedPid;
    if (!this.isRunning() || pid == null) {
      this.clearPidFile();
      return { ok: true };
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const exited = await this.waitForDead(pid, 5000);
    if (!exited) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await this.waitForDead(pid, 2000);
    }
    this.child = null;
    this.adoptedPid = null;
    this.startedAt = null;
    this.clearPidFile();
    return { ok: true };
  }

  logs(n = 200): LogLine[] {
    return this.ring.slice(-Math.min(n, RING_MAX));
  }

  private push(stream: 'stdout' | 'stderr', chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const entry: LogLine = { ts: Date.now(), stream, line };
      this.ring.push(entry);
      if (this.ring.length > RING_MAX) this.ring.shift();
      this.emit('log', entry);
    }
  }

  private recoverFromPidFile(): void {
    if (!fs.existsSync(this.pidFile)) return;
    const raw = fs.readFileSync(this.pidFile, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid)) {
      this.clearPidFile();
      return;
    }
    try {
      process.kill(pid, 0);
      this.adoptedPid = pid;
      this.startedAt = fs.statSync(this.pidFile).mtimeMs;
    } catch {
      this.clearPidFile();
    }
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.pidFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private clearPidFile(): void {
    try {
      if (fs.existsSync(this.pidFile)) fs.unlinkSync(this.pidFile);
    } catch {
      /* ignore */
    }
  }

  private waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = setInterval(() => {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (!alive) {
          clearInterval(tick);
          resolve(true);
        } else if (Date.now() - start >= timeoutMs) {
          clearInterval(tick);
          resolve(false);
        }
      }, 100);
    });
  }
}
