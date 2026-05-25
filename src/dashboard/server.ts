import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/config';
import { log } from '../logger';
import { LoopController } from './loop-controller';
import { StatsReader } from './stats-reader';
import { LogLine, LoopEvent } from './types';

const STATIC_DIR = __dirname;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DASHBOARD_PID = path.join(PROJECT_ROOT, 'data', 'dashboard.pid');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function createServer(controller: LoopController, reader: StatsReader): http.Server {
  const prefix = config.dashboard.pathPrefix;
  const sseClients = new Set<http.ServerResponse>();

  controller.on('log', (entry: LogLine) => broadcast('log', entry));
  controller.on('loop', (evt: LoopEvent) => broadcast('loop', evt));

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function buildSnapshot() {
    return reader.snapshot(controller.status());
  }

  function json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function serveStatic(name: string, res: http.ServerResponse): void {
    const file = path.join(STATIC_DIR, name);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  }

  function handleStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':\n\n');
    sseClients.add(res);

    const sendSnapshot = () => {
      buildSnapshot()
        .then((snap) => res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`))
        .catch((err) => log.error('snapshot for SSE failed', { err: err.message }));
    };
    sendSnapshot();
    const snapTimer = setInterval(sendSnapshot, 15_000);
    const keepalive = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        /* closed */
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(snapTimer);
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = url.pathname;
      if (prefix && pathname.startsWith(prefix)) {
        pathname = pathname.slice(prefix.length) || '/';
      }

      if (req.method === 'GET' && pathname === '/') return serveStatic('index.html', res);
      if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/styles.css')) {
        return serveStatic(pathname.slice(1), res);
      }
      if (req.method === 'GET' && pathname === '/api/status') {
        return json(res, 200, await buildSnapshot());
      }
      if (req.method === 'POST' && pathname === '/api/start') {
        const r = controller.start();
        const code = r.ok ? 200 : r.reason === 'already running' ? 409 : 500;
        return json(res, code, r);
      }
      if (req.method === 'POST' && pathname === '/api/stop') {
        return json(res, 200, await controller.stop());
      }
      if (req.method === 'GET' && pathname === '/api/logs') {
        const n = parseInt(url.searchParams.get('n') ?? '200', 10) || 200;
        return json(res, 200, controller.logs(n));
      }
      if (req.method === 'GET' && pathname === '/api/stream') {
        return handleStream(req, res);
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err: any) {
      log.error('dashboard request failed', { err: err.message });
      try {
        json(res, 500, { ok: false, reason: err.message });
      } catch {
        /* headers already sent */
      }
    }
  });

  return server;
}

function singleInstanceGuard(): void {
  if (fs.existsSync(DASHBOARD_PID)) {
    const pid = parseInt(fs.readFileSync(DASHBOARD_PID, 'utf8').trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0);
        console.error(`Dashboard already running (pid ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        /* stale pid file — fall through and overwrite */
      }
    }
  }
  const dir = path.dirname(DASHBOARD_PID);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DASHBOARD_PID, String(process.pid));
}

if (require.main === module) {
  singleInstanceGuard();
  const controller = new LoopController();
  const reader = new StatsReader();
  if (config.dashboard.autostartLoop) controller.start();

  const server = createServer(controller, reader);
  server.listen(config.dashboard.port, config.dashboard.host, () => {
    log.info('Dashboard listening', {
      host: config.dashboard.host,
      port: config.dashboard.port,
      prefix: config.dashboard.pathPrefix || '(none)',
    });
  });

  const shutdown = () => {
    try {
      if (fs.existsSync(DASHBOARD_PID)) fs.unlinkSync(DASHBOARD_PID);
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
