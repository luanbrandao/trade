import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config/config';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD')),
    confidence REAL NOT NULL,
    reason TEXT,
    stop_loss_pct REAL,
    take_profit_pct REAL,
    time_horizon_minutes INTEGER,
    price_at_decision REAL,
    llm_model TEXT,
    llm_input_tokens INTEGER,
    llm_output_tokens INTEGER,
    llm_cost_usd REAL,
    executed INTEGER NOT NULL DEFAULT 0,
    skip_reason TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('dryrun', 'live', 'backtest'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol)`,

  `CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER REFERENCES decisions(id),
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    qty REAL NOT NULL,
    avg_price REAL NOT NULL,
    quote_qty REAL NOT NULL,
    binance_order_id TEXT NOT NULL,
    oco_order_list_id TEXT,
    tp_price REAL,
    sl_price REAL,
    status TEXT NOT NULL CHECK (status IN ('OPEN','TP_FILLED','SL_FILLED','CANCELED','ERROR')),
    closed_ts INTEGER,
    closed_price REAL,
    pnl_quote REAL,
    pnl_pct REAL,
    mode TEXT NOT NULL CHECK (mode IN ('dryrun', 'live', 'backtest'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades(symbol, status)`,
  `CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts)`,

  `CREATE TABLE IF NOT EXISTS cooldowns (
    symbol TEXT PRIMARY KEY,
    last_trade_ts INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS postmortems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL REFERENCES trades(id),
    closed_ts INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('TP_HIT','SL_HIT','TIMEOUT','MANUAL','REGIME_MISMATCH')),
    pnl_quote REAL NOT NULL,
    pnl_pct REAL NOT NULL,
    holding_minutes INTEGER NOT NULL,
    mae_pct REAL,
    mfe_pct REAL,
    classification TEXT NOT NULL CHECK (classification IN ('TRUE_POSITIVE','FALSE_POSITIVE','TIMEOUT_WIN','TIMEOUT_LOSS')),
    notes TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_postmortems_trade ON postmortems(trade_id)`,
];

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  // Read DB_PATH from env at call time, not from the import-time config
  // snapshot — specs set process.env.DB_PATH after module imports have run.
  const dbPath = process.env.DB_PATH || config.storage.dbPath;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }

  addColumnIfMissing(db, 'trades', 'strategy_name', "TEXT NOT NULL DEFAULT 'unknown'");
  addColumnIfMissing(db, 'decisions', 'strategy_name', "TEXT NOT NULL DEFAULT 'unknown'");

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
