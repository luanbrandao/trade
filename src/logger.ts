import { config } from './config/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[config.logging.level];
}

function formatCtx(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === null) continue;
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${str}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${formatCtx(ctx)}`;
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx),
};
