import Database from 'better-sqlite3';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  if (db) return db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // WAL allows a single writer; without this a second writer (backfill script
  // running next to the live service) fails instantly with SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Lightweight idempotent migrations for pre-existing databases.
 * CREATE TABLE IF NOT EXISTS above handles fresh DBs; this fixes legacy ones.
 */
function migrate(database: Database.Database): void {
  // Drop legacy profile_meta.last_check_at column (written but never read).
  // Guarded by a column-existence check so it runs once and never errors on
  // databases that never had the column.
  const cols = database.prepare(`PRAGMA table_info(profile_meta)`).all() as { name: string }[];
  if (cols.some(c => c.name === 'last_check_at')) {
    try {
      database.exec(`ALTER TABLE profile_meta DROP COLUMN last_check_at`);
    } catch {
      /* SQLite < 3.35 has no DROP COLUMN; leave the column in place — it's harmless once unused. */
    }
  }

  // Asset-governance columns on hard_memories (status / usage tracking /
  // auto-distill provenance). Legacy DBs predate these; fresh DBs already
  // have them from SCHEMA above.
  const hardCols = database.prepare(`PRAGMA table_info(hard_memories)`).all() as { name: string }[];
  const hardColNames = new Set(hardCols.map(c => c.name));
  const addCol = (ddl: string) => {
    try { database.exec(ddl); } catch { /* column may already exist — ignore */ }
  };
  if (!hardColNames.has('status')) addCol(`ALTER TABLE hard_memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  if (!hardColNames.has('usage_count')) addCol(`ALTER TABLE hard_memories ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`);
  if (!hardColNames.has('last_used_at')) addCol(`ALTER TABLE hard_memories ADD COLUMN last_used_at TEXT`);
  if (!hardColNames.has('source_date')) addCol(`ALTER TABLE hard_memories ADD COLUMN source_date TEXT`);

  // Backfill daily_summaries_fts for legacy rows (trigger-synced from here on).
  const ftsCount = database.prepare(`SELECT COUNT(*) as c FROM daily_summaries_fts`).get() as { c: number };
  const sumCount = database.prepare(`SELECT COUNT(*) as c FROM daily_summaries`).get() as { c: number };
  if (ftsCount.c !== sumCount.c) {
    database.exec(`INSERT INTO daily_summaries_fts(daily_summaries_fts) VALUES ('rebuild')`);
  }

  // Tokenizer upgrade: legacy FTS tables used unicode61, which treats CJK
  // runs as single tokens — Chinese memories were effectively unsearchable.
  // Recreate with the trigram tokenizer (substring matching, CJK-friendly).
  // Triggers reference the table by name and survive the swap.
  upgradeFtsTokenizer(database, 'hard_memories_fts',
    `CREATE VIRTUAL TABLE hard_memories_fts USING fts5(
       title, content, facts, concepts,
       content='hard_memories', content_rowid='id', tokenize='trigram')`);
  upgradeFtsTokenizer(database, 'daily_summaries_fts',
    `CREATE VIRTUAL TABLE daily_summaries_fts USING fts5(
       content, content='daily_summaries', content_rowid='id', tokenize='trigram')`);
}

/** Drop + recreate an external-content FTS5 table with a new tokenizer, then rebuild. */
function upgradeFtsTokenizer(database: Database.Database, name: string, createSql: string): void {
  const meta = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql: string } | undefined;
  if (!meta || /trigram/i.test(meta.sql)) return;
  database.exec(`DROP TABLE ${name};`);
  database.exec(createSql);
  database.exec(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

/** Close the database connection. Checkpoints WAL and releases the file lock. */
export function closeDb(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}

const SCHEMA = `
-- Raw conversation data (high volume, low density)
CREATE TABLE IF NOT EXISTS raw_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  tool_input TEXT,
  tool_output TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_raw_user_ts ON raw_conversations(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_session ON raw_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_raw_user_date ON raw_conversations(user_id, date(timestamp));

-- Hard memories (user-triggered "remember X", high value)
CREATE TABLE IF NOT EXISTS hard_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '[]',
  concepts TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  priority TEXT NOT NULL DEFAULT 'high',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  source_date TEXT,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hard_user_ts ON hard_memories(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_hard_user_type ON hard_memories(user_id, type);

-- FTS5 for hard_memories full-text search.
-- trigram tokenizer: substring matching, so CJK queries work (unicode61
-- collapses Chinese runs into single tokens and misses mid-word matches).
CREATE VIRTUAL TABLE IF NOT EXISTS hard_memories_fts USING fts5(
  title, content, facts, concepts,
  content='hard_memories',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS hard_memories_ai AFTER INSERT ON hard_memories BEGIN
  INSERT INTO hard_memories_fts(rowid, title, content, facts, concepts)
  VALUES (new.id, new.title, new.content, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS hard_memories_ad AFTER DELETE ON hard_memories BEGIN
  INSERT INTO hard_memories_fts(hard_memories_fts, rowid, title, content, facts, concepts)
  VALUES ('delete', old.id, old.title, old.content, old.facts, old.concepts);
END;

CREATE TRIGGER IF NOT EXISTS hard_memories_au AFTER UPDATE ON hard_memories BEGIN
  INSERT INTO hard_memories_fts(hard_memories_fts, rowid, title, content, facts, concepts)
  VALUES ('delete', old.id, old.title, old.content, old.facts, old.concepts);
  INSERT INTO hard_memories_fts(rowid, title, content, facts, concepts)
  VALUES (new.id, new.title, new.content, new.facts, new.concepts);
END;

-- Daily summaries (LLM-distilled from raw conversations)
CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  raw_count INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_summary_user_date ON daily_summaries(user_id, date DESC);

-- FTS5 for daily summaries (second retrieval tier when hard memories under-fill)
CREATE VIRTUAL TABLE IF NOT EXISTS daily_summaries_fts USING fts5(
  content,
  content='daily_summaries',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS daily_summaries_ai AFTER INSERT ON daily_summaries BEGIN
  INSERT INTO daily_summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS daily_summaries_ad AFTER DELETE ON daily_summaries BEGIN
  INSERT INTO daily_summaries_fts(daily_summaries_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS daily_summaries_au AFTER UPDATE ON daily_summaries BEGIN
  INSERT INTO daily_summaries_fts(daily_summaries_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO daily_summaries_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Auto-distill watermark: how far each user+date has been refined into atoms.
-- Makes the distill pipeline idempotent across re-runs of the same day.
CREATE TABLE IF NOT EXISTS distill_state (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  last_raw_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- Skill drafts distilled from long successful sessions (await human approval)
CREATE TABLE IF NOT EXISTS skill_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_user_status ON skill_drafts(user_id, status);

-- User profiles (LLM-generated from daily summaries; hard memories injected separately by plugin)
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT NOT NULL,
  source_raw_count INTEGER NOT NULL DEFAULT 0,
  source_memory_count INTEGER NOT NULL DEFAULT 0
);

-- Track when each user last had their profile recomputed (for delta triggers)
CREATE TABLE IF NOT EXISTS profile_meta (
  user_id TEXT PRIMARY KEY,
  last_hard_memory_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
