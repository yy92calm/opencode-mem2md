import { getDb } from './schema.js';
import type { RawConversation, HardMemory, WorkspaceMemory, RecentFocus, DailySummary, UserProfile, SkillDraft } from '../types/index.js';

// ===== Raw conversations =====

export function insertRaw(r: Omit<RawConversation, 'id'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO raw_conversations (user_id, session_id, workspace, role, content, tool_name, tool_input, tool_output, timestamp)
    VALUES (@user_id, @session_id, @workspace, @role, @content, @tool_name, @tool_input, @tool_output, @timestamp)
  `);
  const r2 = {
    ...r,
    workspace: r.workspace ?? null,
    tool_name: r.tool_name ?? null,
    tool_input: r.tool_input ?? null,
    tool_output: r.tool_output ?? null,
  };
  const result = stmt.run(r2);
  return Number(result.lastInsertRowid);
}

export function insertRawBatch(items: Omit<RawConversation, 'id'>[]): number {
  if (items.length === 0) return 0;
  const stmt = getDb().prepare(`
    INSERT INTO raw_conversations (user_id, session_id, workspace, role, content, tool_name, tool_input, tool_output, timestamp)
    VALUES (@user_id, @session_id, @workspace, @role, @content, @tool_name, @tool_input, @tool_output, @timestamp)
  `);
  const tx = getDb().transaction((rows: any[]) => {
    for (const r of rows) {
      stmt.run({
        ...r,
        workspace: r.workspace ?? null,
        tool_name: r.tool_name ?? null,
        tool_input: r.tool_input ?? null,
        tool_output: r.tool_output ?? null,
      });
    }
  });
  tx(items);
  return items.length;
}

export function listRawByDate(user_id: string, date: string): RawConversation[] {
  // Match by the configured timezone, not UTC. raw_conversations.timestamp is
  // stored as an ISO (UTC) string; localtime() shifts it to the server's tz so
  // the calendar day the user actually experienced is the one summarized.
  return getDb()
    .prepare(`SELECT * FROM raw_conversations WHERE user_id = ? AND date(datetime(timestamp, 'localtime')) = ? ORDER BY timestamp ASC`)
    .all(user_id, date) as RawConversation[];
}

export function countRawByDate(user_id: string, date: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as c FROM raw_conversations WHERE user_id = ? AND date(datetime(timestamp, 'localtime')) = ?`)
    .get(user_id, date) as { c: number };
  return row.c;
}

/** Raw counts per workspace for one day, most active first. */
export function listWorkspaceCountsByDate(user_id: string, date: string): { workspace: string; count: number }[] {
  return getDb()
    .prepare(`
      SELECT COALESCE(workspace, '') AS workspace, COUNT(*) AS count
      FROM raw_conversations
      WHERE user_id = ? AND date(datetime(timestamp, 'localtime')) = ?
      GROUP BY COALESCE(workspace, '')
      ORDER BY count DESC
    `)
    .all(user_id, date) as { workspace: string; count: number }[];
}

/** Distinct workspaces a user has worked in recently (for focus/summary scoping). */
export function listRecentWorkspaces(user_id: string, days = 7): string[] {
  const rows = getDb()
    .prepare(`
      SELECT workspace FROM raw_conversations
      WHERE user_id = ? AND workspace IS NOT NULL AND workspace != ''
        AND timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY workspace ORDER BY MAX(timestamp) DESC
    `)
    .all(user_id, days) as { workspace: string }[];
  return rows.map(r => r.workspace);
}

/**
 * Drop raw conversations older than `days`, but only for calendar days that
 * already have a daily summary. Unsummarized days are retained so a stalled
 * LLM pipeline can never cause permanent loss of the source material.
 *
 * Dates are bucketed with localtime() to match listRawByDate/countRawByDate,
 * so the retention window and the summary window agree on what a "day" is.
 */
export function pruneSummarizedRawOlderThan(days: number): { deleted: number; retained_days: number } {
  const db = getDb();
  const result = db
    .prepare(`
      DELETE FROM raw_conversations
      WHERE date(datetime(timestamp, 'localtime')) < date('now', 'localtime', '-' || ? || ' days')
        AND EXISTS (
          SELECT 1 FROM daily_summaries s
          WHERE s.user_id = raw_conversations.user_id
            AND s.date = date(datetime(raw_conversations.timestamp, 'localtime'))
        )
    `)
    .run(days);
  const retained = db
    .prepare(`
      SELECT COUNT(DISTINCT date(datetime(timestamp, 'localtime'))) AS d
      FROM raw_conversations
      WHERE date(datetime(timestamp, 'localtime')) < date('now', 'localtime', '-' || ? || ' days')
    `)
    .get(days) as { d: number };
  return { deleted: Number(result.changes), retained_days: retained.d };
}

// ===== Hard memories =====

export type HardMemoryInsert = Omit<HardMemory, 'id' | 'status' | 'usage_count' | 'last_used_at' | 'source_date'> & {
  status?: 'active' | 'deprecated';
  source_date?: string | null;
};

export function insertHard(m: HardMemoryInsert): number {
  // Dedup guard: a user-asserted (manual) memory supersedes auto-distilled
  // atoms with the same title — deprecate them instead of deleting, so the
  // history stays auditable.
  if (m.source === 'manual') {
    getDb()
      .prepare(`
        UPDATE hard_memories SET status = 'deprecated'
        WHERE user_id = ? AND source = 'auto' AND status = 'active'
          AND lower(trim(title)) = lower(trim(?))
      `)
      .run(m.user_id, m.title);
  }

  const stmt = getDb().prepare(`
    INSERT INTO hard_memories (user_id, type, title, content, facts, concepts, source, priority, status, session_id, source_date, timestamp)
    VALUES (@user_id, @type, @title, @content, @facts, @concepts, @source, @priority, @status, @session_id, @source_date, @timestamp)
  `);
  const result = stmt.run({
    ...m,
    facts: JSON.stringify(m.facts),
    concepts: JSON.stringify(m.concepts),
    status: m.status ?? 'active',
    source_date: m.source_date ?? null,
    session_id: m.session_id ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function listHard(user_id: string, limit = 100, includeDeprecated = false): HardMemory[] {
  const statusFilter = includeDeprecated ? '' : `AND status = 'active'`;
  const rows = getDb()
    .prepare(`SELECT * FROM hard_memories WHERE user_id = ? ${statusFilter} ORDER BY timestamp DESC LIMIT ?`)
    .all(user_id, limit) as any[];
  return rows.map(deserializeHard);
}

export function searchHard(user_id: string, query: string, limit = 50, includeDeprecated = false): HardMemory[] {
  if (!query.trim()) return listHard(user_id, limit, includeDeprecated);
  const { longTerms, shortTerms } = splitQueryTerms(query);
  const statusFilter = includeDeprecated ? '' : `AND h.status = 'active'`;

  // Sub-3-char terms (e.g. 2-char Chinese words) can't form trigrams, so
  // they're enforced as LIKE substring filters instead of MATCH clauses.
  const like = likeConditions(shortTerms, ['h.title', 'h.content', 'h.facts', 'h.concepts']);

  let rows: any[];
  if (longTerms.length > 0) {
    // trigram tokenizer: each quoted term is a substring; space-separated
    // phrases AND together (every term must occur, not necessarily adjacent).
    const match = longTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
    rows = getDb()
      .prepare(`
        SELECT h.* FROM hard_memories_fts fts
        JOIN hard_memories h ON h.id = fts.rowid
        WHERE hard_memories_fts MATCH ? AND h.user_id = ? ${statusFilter} ${like.sql}
        ORDER BY rank LIMIT ?
      `)
      .all(match, user_id, ...like.params, limit) as any[];
  } else {
    // Only short terms: pure LIKE scan (still user-scoped + bounded).
    rows = getDb()
      .prepare(`
        SELECT h.* FROM hard_memories h
        WHERE h.user_id = ? ${statusFilter} ${like.sql}
        ORDER BY h.timestamp DESC LIMIT ?
      `)
      .all(user_id, ...like.params, limit) as any[];
  }
  return rows.map(deserializeHard);
}

/** Second retrieval tier: match daily summaries when hard memories under-fill. */
export function searchSummaries(user_id: string, query: string, limit = 10): DailySummary[] {
  if (!query.trim()) return [];
  const { longTerms, shortTerms } = splitQueryTerms(query);
  const like = likeConditions(shortTerms, ['s.content']);

  let rows: DailySummary[];
  if (longTerms.length > 0) {
    const match = longTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
    rows = getDb()
      .prepare(`
        SELECT s.* FROM daily_summaries_fts fts
        JOIN daily_summaries s ON s.id = fts.rowid
        WHERE daily_summaries_fts MATCH ? AND s.user_id = ? ${like.sql}
        ORDER BY rank LIMIT ?
      `)
      .all(match, user_id, ...like.params, limit) as DailySummary[];
  } else {
    rows = getDb()
      .prepare(`
        SELECT s.* FROM daily_summaries s
        WHERE s.user_id = ? ${like.sql}
        ORDER BY s.date DESC LIMIT ?
      `)
      .all(user_id, ...like.params, limit) as DailySummary[];
  }
  return rows;
}

/**
 * Split a user query into MATCH-able terms (≥3 codepoints, trigram-capable)
 * and short terms that need LIKE fallback. Codepoint length matters: a 2-char
 * Chinese word is one UTF-16 "length" unit per char, so [...t] keeps CJK and
 * ASCII semantics aligned.
 */
function splitQueryTerms(query: string): { longTerms: string[]; shortTerms: string[] } {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const longTerms: string[] = [];
  const shortTerms: string[] = [];
  for (const t of terms) {
    ([...t].length >= 3 ? longTerms : shortTerms).push(t);
  }
  return { longTerms, shortTerms };
}

/** Build escaped `AND (col LIKE ? OR ...)` clauses, one per short term. */
function likeConditions(terms: string[], cols: string[]): { sql: string; params: string[] } {
  if (terms.length === 0) return { sql: '', params: [] };
  const params: string[] = [];
  const clauses = terms.map(t => {
    const escaped = t.replace(/[\\%_]/g, m => `\\${m}`);
    // One pattern per column placeholder — LIKE is repeated across cols.
    for (let i = 0; i < cols.length; i++) params.push(`%${escaped}%`);
    return `(${cols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  return { sql: `AND ${clauses.join(' AND ')}`, params };
}

/** Bump usage counters for memories that were served in a search result. */
export function touchHardUsage(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb()
    .prepare(`UPDATE hard_memories SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id IN (${placeholders})`)
    .run(...ids);
}

export function setHardStatus(user_id: string, id: number, status: 'active' | 'deprecated'): boolean {
  const result = getDb()
    .prepare(`UPDATE hard_memories SET status = ? WHERE user_id = ? AND id = ?`)
    .run(status, user_id, id);
  return result.changes > 0;
}

export function getHard(user_id: string, id: number): HardMemory | null {
  const row = getDb()
    .prepare(`SELECT * FROM hard_memories WHERE user_id = ? AND id = ?`)
    .get(user_id, id) as any;
  return row ? deserializeHard(row) : null;
}

/** Overwrite content of a memory (used by monthly consolidation merges). */
export function updateHardContent(id: number, patch: { title?: string; content?: string; facts?: string[]; concepts?: string[] }): void {
  getDb()
    .prepare(`
      UPDATE hard_memories SET
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        facts = COALESCE(?, facts),
        concepts = COALESCE(?, concepts)
      WHERE id = ?
    `)
    .run(
      patch.title ?? null,
      patch.content ?? null,
      patch.facts ? JSON.stringify(patch.facts) : null,
      patch.concepts ? JSON.stringify(patch.concepts) : null,
      id,
    );
}

export function deleteHard(user_id: string, id: number): boolean {
  const result = getDb()
    .prepare(`DELETE FROM hard_memories WHERE user_id = ? AND id = ?`)
    .run(user_id, id);
  return result.changes > 0;
}

export function countHardSince(user_id: string, sinceId: number): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as c FROM hard_memories WHERE user_id = ? AND id > ?`)
    .get(user_id, sinceId) as { c: number };
  return row.c;
}

/** Total hard memory count for a user. Cheaper than listHard when rows aren't needed. */
export function countHard(user_id: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as c FROM hard_memories WHERE user_id = ?`)
    .get(user_id) as { c: number };
  return row.c;
}

export function getMaxHardId(user_id: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(id), 0) as m FROM hard_memories WHERE user_id = ?`)
    .get(user_id) as { m: number };
  return row.m;
}

function deserializeHard(row: any): HardMemory {
  return {
    ...row,
    facts: JSON.parse(row.facts || '[]'),
    concepts: JSON.parse(row.concepts || '[]'),
  };
}

// ===== Workspace memories =====

export type WorkspaceMemoryInsert = Omit<WorkspaceMemory, 'id' | 'status' | 'usage_count' | 'last_used_at' | 'source_date'> & {
  status?: 'active' | 'deprecated';
  source_date?: string | null;
};

/**
 * Insert a workspace memory. Re-asserting the same title in the same workspace
 * refreshes the existing row (content/facts/timestamp) instead of duplicating;
 * a manual write also promotes the row to manual priority.
 */
export function insertWorkspaceMemory(m: WorkspaceMemoryInsert): number {
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM workspace_memories WHERE user_id = ? AND workspace = ? AND lower(trim(title)) = lower(trim(?))`)
    .get(m.user_id, m.workspace, m.title) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE workspace_memories SET
        type = @type, content = @content, facts = @facts, concepts = @concepts,
        source = @source, status = 'active', session_id = @session_id,
        source_date = COALESCE(@source_date, source_date), timestamp = @timestamp
      WHERE id = @id
    `).run({
      ...m,
      id: existing.id,
      facts: JSON.stringify(m.facts),
      concepts: JSON.stringify(m.concepts),
      source_date: m.source_date ?? null,
      session_id: m.session_id ?? null,
    });
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO workspace_memories
      (user_id, workspace, type, title, content, facts, concepts, source, status, session_id, source_date, timestamp)
    VALUES
      (@user_id, @workspace, @type, @title, @content, @facts, @concepts, @source, @status, @session_id, @source_date, @timestamp)
  `).run({
    ...m,
    facts: JSON.stringify(m.facts),
    concepts: JSON.stringify(m.concepts),
    status: m.status ?? 'active',
    source_date: m.source_date ?? null,
    session_id: m.session_id ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function listWorkspaceMemories(user_id: string, workspace: string, limit = 50): WorkspaceMemory[] {
  const rows = getDb()
    .prepare(`
      SELECT * FROM workspace_memories
      WHERE user_id = ? AND workspace = ? AND status = 'active'
      ORDER BY timestamp DESC LIMIT ?
    `)
    .all(user_id, workspace, limit) as any[];
  return rows.map(deserializeWorkspaceMemory);
}

/** Search within a workspace; empty query lists recent memories. */
export function searchWorkspaceMemories(user_id: string, workspace: string, query: string, limit = 50): WorkspaceMemory[] {
  if (!query.trim()) return listWorkspaceMemories(user_id, workspace, limit);
  const { longTerms, shortTerms } = splitQueryTerms(query);
  const like = likeConditions(shortTerms, ['w.title', 'w.content', 'w.facts', 'w.concepts']);

  let rows: any[];
  if (longTerms.length > 0) {
    const match = longTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
    rows = getDb()
      .prepare(`
        SELECT w.* FROM workspace_memories_fts fts
        JOIN workspace_memories w ON w.id = fts.rowid
        WHERE workspace_memories_fts MATCH ? AND w.user_id = ? AND w.workspace = ?
          AND w.status = 'active' ${like.sql}
        ORDER BY rank LIMIT ?
      `)
      .all(match, user_id, workspace, ...like.params, limit) as any[];
  } else {
    rows = getDb()
      .prepare(`
        SELECT w.* FROM workspace_memories w
        WHERE w.user_id = ? AND w.workspace = ? AND w.status = 'active' ${like.sql}
        ORDER BY w.timestamp DESC LIMIT ?
      `)
      .all(user_id, workspace, ...like.params, limit) as any[];
  }
  return rows.map(deserializeWorkspaceMemory);
}

export function touchWorkspaceUsage(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb()
    .prepare(`UPDATE workspace_memories SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id IN (${placeholders})`)
    .run(...ids);
}

export function countWorkspaceMemories(user_id: string, workspace: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM workspace_memories WHERE user_id = ? AND workspace = ? AND status = 'active'`)
    .get(user_id, workspace) as { c: number };
  return row.c;
}

export interface WorkspaceSummary {
  workspace: string;
  memories: number;
  raws: number;
  last_seen: string;
}

/** Every workspace the user has touched, most recent first (for the UI). */
export function listUserWorkspaces(user_id: string): WorkspaceSummary[] {
  return getDb()
    .prepare(`
      WITH ws AS (
        SELECT workspace FROM raw_conversations
        WHERE user_id = @u AND workspace IS NOT NULL AND workspace != ''
        UNION
        SELECT workspace FROM workspace_memories
        WHERE user_id = @u
      )
      SELECT
        ws.workspace AS workspace,
        (SELECT COUNT(*) FROM workspace_memories m
          WHERE m.user_id = @u AND m.workspace = ws.workspace AND m.status = 'active') AS memories,
        (SELECT COUNT(*) FROM raw_conversations r
          WHERE r.user_id = @u AND r.workspace = ws.workspace) AS raws,
        COALESCE(
          (SELECT MAX(r.timestamp) FROM raw_conversations r WHERE r.user_id = @u AND r.workspace = ws.workspace),
          (SELECT MAX(m.timestamp) FROM workspace_memories m WHERE m.user_id = @u AND m.workspace = ws.workspace),
          ''
        ) AS last_seen
      FROM ws
      ORDER BY last_seen DESC
    `)
    .all({ u: user_id }) as WorkspaceSummary[];
}

function deserializeWorkspaceMemory(row: any): WorkspaceMemory {
  return {
    ...row,
    facts: JSON.parse(row.facts || '[]'),
    concepts: JSON.parse(row.concepts || '[]'),
  };
}

// ===== Recent focus =====

/**
 * Upsert a focus topic for a user+workspace. Repeated sightings bump the
 * weight (bounded) and refresh last_seen; the daily decay job removes stale
 * topics, so this table stays a rolling "what am I working on" view.
 */
export function upsertFocus(input: {
  user_id: string;
  workspace: string | null;
  topic: string;
  detail?: string;
  date: string;
}): void {
  const topic = input.topic.trim();
  if (!topic) return;
  getDb()
    .prepare(`
      INSERT INTO recent_focus (user_id, workspace, topic, detail, weight, last_seen)
      VALUES (@user_id, @workspace, @topic, @detail, 1, @last_seen)
      ON CONFLICT(user_id, workspace, topic) DO UPDATE SET
        detail = CASE WHEN excluded.detail != '' THEN excluded.detail ELSE recent_focus.detail END,
        weight = MIN(recent_focus.weight + 1, 10),
        last_seen = MAX(recent_focus.last_seen, excluded.last_seen)
    `)
    .run({
      user_id: input.user_id,
      workspace: input.workspace ?? null,
      topic,
      detail: (input.detail ?? '').slice(0, 500),
      last_seen: input.date,
    });
}

/**
 * Focus topics ranked by recency then weight.
 * `workspace` = undefined → all workspaces; null → only global (unscoped) topics;
 * a string → that workspace plus global topics (global topics apply everywhere).
 */
export function listFocus(
  user_id: string,
  workspace?: string | null,
  days = 7,
  limit = 8,
): RecentFocus[] {
  const params: any[] = [user_id, days];
  let wsFilter = '';
  if (workspace === null) {
    wsFilter = `AND workspace IS NULL`;
  } else if (typeof workspace === 'string' && workspace !== '') {
    wsFilter = `AND (workspace = ? OR workspace IS NULL)`;
    params.push(workspace);
  }
  params.push(limit);
  return getDb()
    .prepare(`
      SELECT * FROM recent_focus
      WHERE user_id = ? AND last_seen >= date('now', 'localtime', '-' || ? || ' days') ${wsFilter}
      ORDER BY last_seen DESC, weight DESC
      LIMIT ?
    `)
    .all(...params) as RecentFocus[];
}

/** Drop focus topics that have not been seen within `days`. */
export function pruneFocusOlderThan(days = 14): number {
  const result = getDb()
    .prepare(`DELETE FROM recent_focus WHERE last_seen < date('now', 'localtime', '-' || ? || ' days')`)
    .run(days);
  return Number(result.changes);
}

// ===== Context bundle (layered injection) =====

export interface ContextBundle {
  workspace: string | null;
  profile: string | null;
  workspace_memories: WorkspaceMemory[];
  hard_memories: HardMemory[];
  focus: RecentFocus[];
}

/**
 * One round-trip for the plugin's per-turn injection: profile + workspace
 * memories + global hard memories + recent focus. The plugin still applies
 * its own per-layer char budgets, so ranking (not truncation) lives here.
 */
export function getContextBundle(user_id: string, workspace: string | null, opts?: {
  hard_limit?: number;
  workspace_limit?: number;
  focus_days?: number;
  focus_limit?: number;
}): ContextBundle {
  const hardLimit = Math.min(Math.max(opts?.hard_limit ?? 50, 1), 200);
  const wsLimit = Math.min(Math.max(opts?.workspace_limit ?? 30, 1), 200);
  const focusDays = Math.min(Math.max(opts?.focus_days ?? 7, 1), 90);
  const focusLimit = Math.min(Math.max(opts?.focus_limit ?? 8, 1), 50);

  return {
    workspace,
    profile: getProfile(user_id)?.content ?? null,
    workspace_memories: workspace ? listWorkspaceMemories(user_id, workspace, wsLimit) : [],
    hard_memories: listHard(user_id, hardLimit),
    focus: listFocus(user_id, workspace, focusDays, focusLimit),
  };
}

// ===== Daily summaries =====

export function upsertDailySummary(s: Omit<DailySummary, 'id'>): void {
  getDb()
    .prepare(`
      INSERT INTO daily_summaries (user_id, date, content, raw_count, generated_at)
      VALUES (@user_id, @date, @content, @raw_count, @generated_at)
      ON CONFLICT(user_id, date) DO UPDATE SET
        content = excluded.content,
        raw_count = excluded.raw_count,
        generated_at = excluded.generated_at
    `)
    .run(s);
}

export function listRecentSummaries(user_id: string, days: number): DailySummary[] {
  return getDb()
    .prepare(`
      SELECT * FROM daily_summaries
      WHERE user_id = ? AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `)
    .all(user_id, days) as DailySummary[];
}

/** Most recent summaries regardless of age — fallback when the 7-day window is sparse. */
export function listLatestSummaries(user_id: string, limit = 10): DailySummary[] {
  return getDb()
    .prepare(`SELECT * FROM daily_summaries WHERE user_id = ? ORDER BY date DESC LIMIT ?`)
    .all(user_id, limit) as DailySummary[];
}

// ===== Memory governance (keep the active store focused) =====

/**
 * Deprecate auto-distilled memories that were never recalled and have aged
 * past `days`. Manual (user-asserted) memories are never touched. Soft delete
 * only — rows stay auditable and can be reactivated.
 */
export function deprecateStaleAutoMemories(user_id: string, days = 60): number {
  const result = getDb()
    .prepare(`
      UPDATE hard_memories SET status = 'deprecated'
      WHERE user_id = ? AND status = 'active' AND source = 'auto'
        AND usage_count = 0 AND priority != 'high'
        AND timestamp < datetime('now', '-' || ? || ' days')
    `)
    .run(user_id, days);
  return Number(result.changes);
}

/**
 * Cap the number of active hard memories. When over the cap, the lowest-value
 * rows are deprecated first. Score = recall count (dominant) -> manual source
 * -> priority -> recency. Manual high-priority memories rank highest and are
 * effectively never evicted.
 */
export function enforceHardMemoryCap(user_id: string, cap = 150): number {
  const total = countHardActive(user_id);
  if (total <= cap) return 0;

  const excess = total - cap;
  const rows = getDb()
    .prepare(`
      SELECT id FROM hard_memories
      WHERE user_id = ? AND status = 'active'
      ORDER BY
        usage_count ASC,
        CASE source WHEN 'manual' THEN 1 ELSE 0 END ASC,
        CASE priority WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END ASC,
        timestamp ASC
      LIMIT ?
    `)
    .all(user_id, excess) as { id: number }[];

  if (rows.length === 0) return 0;
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const result = getDb()
    .prepare(`UPDATE hard_memories SET status = 'deprecated' WHERE id IN (${placeholders})`)
    .run(...ids);
  return Number(result.changes);
}

function countHardActive(user_id: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) c FROM hard_memories WHERE user_id = ? AND status = 'active'`)
    .get(user_id) as { c: number };
  return row.c;
}

// ===== User profiles =====

export function upsertProfile(p: UserProfile): void {
  getDb()
    .prepare(`
      INSERT INTO user_profiles (user_id, content, version, generated_at, source_raw_count, source_memory_count)
      VALUES (@user_id, @content, @version, @generated_at, @source_raw_count, @source_memory_count)
      ON CONFLICT(user_id) DO UPDATE SET
        content = excluded.content,
        version = user_profiles.version + 1,
        generated_at = excluded.generated_at,
        source_raw_count = excluded.source_raw_count,
        source_memory_count = excluded.source_memory_count
    `)
    .run(p);
}

export function getProfile(user_id: string): UserProfile | null {
  const row = getDb()
    .prepare(`SELECT * FROM user_profiles WHERE user_id = ?`)
    .get(user_id) as UserProfile | undefined;
  return row ?? null;
}

// ===== Profile meta (delta tracking) =====

export function getProfileMeta(user_id: string): { last_hard_memory_id: number } {
  const row = getDb()
    .prepare(`SELECT last_hard_memory_id FROM profile_meta WHERE user_id = ?`)
    .get(user_id) as any;
  return row ?? { last_hard_memory_id: 0 };
}

export function updateProfileMeta(user_id: string, last_hard_memory_id: number): void {
  getDb()
    .prepare(`
      INSERT INTO profile_meta (user_id, last_hard_memory_id)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        last_hard_memory_id = excluded.last_hard_memory_id
    `)
    .run(user_id, last_hard_memory_id);
}

export function listAllUsers(): string[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT user_id FROM (
      SELECT user_id FROM raw_conversations
      UNION SELECT user_id FROM hard_memories
    )
  `).all() as { user_id: string }[];
  return rows.map(r => r.user_id);
}

// ===== Distill state (auto-atom watermark) =====

export function getDistillState(user_id: string, date: string): number {
  const row = getDb()
    .prepare(`SELECT last_raw_id FROM distill_state WHERE user_id = ? AND date = ?`)
    .get(user_id, date) as { last_raw_id: number } | undefined;
  return row?.last_raw_id ?? 0;
}

export function setDistillState(user_id: string, date: string, last_raw_id: number): void {
  getDb()
    .prepare(`
      INSERT INTO distill_state (user_id, date, last_raw_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, date) DO UPDATE SET
        last_raw_id = excluded.last_raw_id,
        updated_at = excluded.updated_at
    `)
    .run(user_id, date, last_raw_id);
}

export function maxRawIdByDate(user_id: string, date: string): number {
  const row = getDb()
    .prepare(`
      SELECT COALESCE(MAX(id), 0) as m FROM raw_conversations
      WHERE user_id = ? AND date(datetime(timestamp, 'localtime')) = ?
    `)
    .get(user_id, date) as { m: number };
  return row.m;
}

// ===== Skill drafts =====

export function insertSkillDraft(d: Omit<SkillDraft, 'id' | 'status'>): number {
  const result = getDb()
    .prepare(`
      INSERT INTO skill_drafts (user_id, title, content_md, session_id)
      VALUES (@user_id, @title, @content_md, @session_id)
    `)
    .run({ ...d, session_id: d.session_id ?? null });
  return Number(result.lastInsertRowid);
}

export function listSkillDrafts(user_id: string, status?: 'draft' | 'approved'): SkillDraft[] {
  const filter = status ? `AND status = ?` : '';
  const rows = (status
    ? getDb().prepare(`SELECT * FROM skill_drafts WHERE user_id = ? ${filter} ORDER BY created_at DESC`).all(user_id, status)
    : getDb().prepare(`SELECT * FROM skill_drafts WHERE user_id = ? ORDER BY created_at DESC`).all(user_id)
  ) as SkillDraft[];
  return rows;
}

export function approveSkillDraft(user_id: string, id: number): SkillDraft | null {
  const result = getDb()
    .prepare(`UPDATE skill_drafts SET status = 'approved', approved_at = datetime('now') WHERE user_id = ? AND id = ? AND status = 'draft'`)
    .run(user_id, id);
  if (result.changes === 0) return null;
  return getDb().prepare(`SELECT * FROM skill_drafts WHERE id = ?`).get(id) as SkillDraft;
}

/** True if this session already produced a skill draft (skip re-extraction). */
export function hasSkillDraftForSession(user_id: string, session_id: string): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as c FROM skill_drafts WHERE user_id = ? AND session_id = ?`)
    .get(user_id, session_id) as { c: number };
  return row.c > 0;
}

/**
 * Sessions from the last `days` days with at least `minRaw` raw rows —
 * candidates for skill extraction.
 */
export function listLongSessions(user_id: string, days: number, minRaw: number): { session_id: string; count: number }[] {
  const rows = getDb()
    .prepare(`
      SELECT session_id, COUNT(*) as count FROM raw_conversations
      WHERE user_id = ?
        AND session_id != 'unknown'
        AND timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY session_id
      HAVING COUNT(*) >= ?
      ORDER BY count DESC
    `)
    .all(user_id, days, minRaw) as { session_id: string; count: number }[];
  return rows;
}

export function listRawBySession(user_id: string, session_id: string): RawConversation[] {
  return getDb()
    .prepare(`SELECT * FROM raw_conversations WHERE user_id = ? AND session_id = ? ORDER BY timestamp ASC`)
    .all(user_id, session_id) as RawConversation[];
}

// ===== Observability =====

export interface UserStats {
  raw_total: number;
  raw_last_7d: number;
  hard_active: number;
  hard_manual: number;
  hard_auto: number;
  hard_deprecated: number;
  summaries: number;
  profile_version: number | null;
  profile_generated_at: string | null;
  skill_drafts_pending: number;
  skill_drafts_approved: number;
  workspaces: number;
  workspace_memories: number;
  focus_topics: number;
  most_used_memories: { id: number; title: string; usage_count: number }[];
}

export function getStats(user_id: string): UserStats {
  const db = getDb();
  const one = (sql: string, ...params: any[]) => (db.prepare(sql).get(...params) as any);
  const profile = one(`SELECT version, generated_at FROM user_profiles WHERE user_id = ?`, user_id);
  return {
    raw_total: one(`SELECT COUNT(*) c FROM raw_conversations WHERE user_id = ?`, user_id).c,
    raw_last_7d: one(`SELECT COUNT(*) c FROM raw_conversations WHERE user_id = ? AND timestamp >= datetime('now', '-7 days')`, user_id).c,
    hard_active: one(`SELECT COUNT(*) c FROM hard_memories WHERE user_id = ? AND status = 'active'`, user_id).c,
    hard_manual: one(`SELECT COUNT(*) c FROM hard_memories WHERE user_id = ? AND status = 'active' AND source = 'manual'`, user_id).c,
    hard_auto: one(`SELECT COUNT(*) c FROM hard_memories WHERE user_id = ? AND status = 'active' AND source = 'auto'`, user_id).c,
    hard_deprecated: one(`SELECT COUNT(*) c FROM hard_memories WHERE user_id = ? AND status = 'deprecated'`, user_id).c,
    summaries: one(`SELECT COUNT(*) c FROM daily_summaries WHERE user_id = ?`, user_id).c,
    profile_version: profile?.version ?? null,
    profile_generated_at: profile?.generated_at ?? null,
    skill_drafts_pending: one(`SELECT COUNT(*) c FROM skill_drafts WHERE user_id = ? AND status = 'draft'`, user_id).c,
    skill_drafts_approved: one(`SELECT COUNT(*) c FROM skill_drafts WHERE user_id = ? AND status = 'approved'`, user_id).c,
    workspaces: one(`
      SELECT COUNT(*) c FROM (
        SELECT workspace FROM raw_conversations WHERE user_id = ? AND workspace IS NOT NULL AND workspace != ''
        UNION SELECT workspace FROM workspace_memories WHERE user_id = ?
      )
    `, user_id, user_id).c,
    workspace_memories: one(`SELECT COUNT(*) c FROM workspace_memories WHERE user_id = ? AND status = 'active'`, user_id).c,
    focus_topics: one(`SELECT COUNT(*) c FROM recent_focus WHERE user_id = ?`, user_id).c,
    most_used_memories: db.prepare(`
      SELECT id, title, usage_count FROM hard_memories
      WHERE user_id = ? AND status = 'active' AND usage_count > 0
      ORDER BY usage_count DESC LIMIT 5
    `).all(user_id) as UserStats['most_used_memories'],
  };
}

// ===== Service state (pipeline observability) =====

export function getServiceState(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM service_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setServiceState(key: string, value: string): void {
  getDb()
    .prepare(`
      INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    .run(key, value.slice(0, 2000), new Date().toISOString());
}

export function getServiceSnapshot(): Record<string, { value: string; updated_at: string }> {
  const rows = getDb()
    .prepare(`SELECT key, value, updated_at FROM service_state`)
    .all() as { key: string; value: string; updated_at: string }[];
  const out: Record<string, { value: string; updated_at: string }> = {};
  for (const r of rows) out[r.key] = { value: r.value, updated_at: r.updated_at };
  return out;
}

export interface HealthMetrics {
  last_summary_date: string | null;
  last_summary_at: string | null;
  last_profile_at: string | null;
  unsummarized_days: number;
}

/**
 * Pipeline progress markers for /health. A stalled LLM shows up here as a
 * growing unsummarized_days and an aging last_summary_date even while the HTTP
 * layer keeps returning 200.
 */
export function getHealthMetrics(): HealthMetrics {
  const db = getDb();
  const s = db
    .prepare(`SELECT date, generated_at FROM daily_summaries ORDER BY date DESC, generated_at DESC LIMIT 1`)
    .get() as { date: string; generated_at: string } | undefined;
  const p = db
    .prepare(`SELECT generated_at FROM user_profiles ORDER BY generated_at DESC LIMIT 1`)
    .get() as { generated_at: string } | undefined;
  const u = db
    .prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT DISTINCT r.user_id, date(datetime(r.timestamp, 'localtime')) AS d
        FROM raw_conversations r
        WHERE NOT EXISTS (
          SELECT 1 FROM daily_summaries s
          WHERE s.user_id = r.user_id AND s.date = date(datetime(r.timestamp, 'localtime'))
        )
      )
    `)
    .get() as { c: number };
  return {
    last_summary_date: s?.date ?? null,
    last_summary_at: s?.generated_at ?? null,
    last_profile_at: p?.generated_at ?? null,
    unsummarized_days: u.c,
  };
}
