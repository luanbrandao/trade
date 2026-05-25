import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { LoopController } from './loop-controller';

function tmpPid(): string {
  return path.join(os.tmpdir(), `loop-test-${process.pid}-${Math.random().toString(36).slice(2)}.pid`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
});

describe('LoopController', () => {
  it('start() spawns a child and writes the PID file', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['5'], pidFile });
    cleanups.push(() => { try { ctrl.stop(); } catch {} });

    const r = ctrl.start();
    expect(r.ok).toBe(true);
    expect(typeof r.pid).toBe('number');
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(ctrl.isRunning()).toBe(true);
  });

  it('start() while running returns already-running', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['5'], pidFile });
    cleanups.push(() => { try { ctrl.stop(); } catch {} });
    ctrl.start();
    const r = ctrl.start();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already running');
  });

  it('stop() kills the child and removes the PID file', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
    ctrl.start();
    await ctrl.stop();
    expect(ctrl.isRunning()).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('adopts a live PID from the PID file on construction', async () => {
    const pidFile = tmpPid();
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(pidFile, String(child.pid));
    cleanups.push(() => { try { child.kill('SIGKILL'); } catch {} });

    const ctrl = new LoopController({ command: '/bin/sleep', args: ['30'], pidFile });
    const status = ctrl.status();
    expect(status.running).toBe(true);
    expect(status.adopted).toBe(true);
    expect(status.pid).toBe(child.pid);
  });

  it('cleans a stale PID file on construction', async () => {
    const pidFile = tmpPid();
    fs.writeFileSync(pidFile, '999999'); // assume not a live PID
    const ctrl = new LoopController({ command: '/bin/sleep', args: ['1'], pidFile });
    expect(ctrl.isRunning()).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('captures child stdout into the ring buffer', async () => {
    const pidFile = tmpPid();
    const ctrl = new LoopController({
      command: '/bin/sh',
      args: ['-c', 'echo hello-from-child; sleep 5'],
      pidFile,
    });
    cleanups.push(() => { try { ctrl.stop(); } catch {} });
    ctrl.start();
    await sleep(300);
    const logs = ctrl.logs(50);
    expect(logs.some((l) => l.line.includes('hello-from-child'))).toBe(true);
  });
});
