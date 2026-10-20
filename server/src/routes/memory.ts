import { Hono } from 'hono';
import {
  insertHard,
  insertWorkspaceMemory,
  listHard,
  searchHard,
  searchWorkspaceMemories,
  searchSummaries,
  deleteHard,
  setHardStatus,
  touchHardUsage,
  touchWorkspaceUsage,
  getStats,
} from '../db/repo.js';
import { getDb } from '../db/schema.js';
import { maybeTriggerProfileRefresh } from '../cron/jobs.js';
import { hardMemorySchema, memoryStatusSchema, safeParse } from '../validation.js';

export const memoryRoutes = new Hono<{ Variables: { user_id: string } }>();

/**
 * GET /api/memory/stats
 * Per-user store health: counts by source/status, profile freshness,
 * pending skill drafts, and the most frequently recalled memories.
 */
memoryRoutes.get('/stats', (c) => {
  const user_id = c.get('user_id');
  return c.json(getStats(user_id));
});

/**
 * POST /api/memory
 * Body: HardMemory (without user_id, server overrides).
 * Plugin uses this when user says "记住X" / "remember X".
 */
memoryRoutes.post('/', async (c) => {
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => null);

  const parsed = safeParse(hardMemorySchema, body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const m = parsed.data;

  // Workspace-scoped writes go to workspace_memories; the global hard-memory
  // store stays user-level so user-asserted facts still apply everywhere.
  if (m.scope === 'workspace') {
    if (!m.workspace) return c.json({ error: 'workspace is required when scope=workspace' }, 400);
    const id = insertWorkspaceMemory({
      user_id,
      workspace: m.workspace,
      type: m.type,
      title: m.title,
      content: m.content,
      facts: m.facts,
      concepts: m.concepts,
      source: m.source,
      session_id: m.session_id ?? null,
      timestamp: m.timestamp,
    });
    return c.json({ id, scope: 'workspace', workspace: m.workspace });
  }

  const id = insertHard({
    user_id,
    type: m.type,
    title: m.title,
    content: m.content,
    facts: m.facts,
    concepts: m.concepts,
    source: m.source,
    priority: m.priority,
    session_id: m.session_id ?? null,
    timestamp: m.timestamp,
  });

  // Fire-and-forget delta-triggered profile refresh.
  maybeTriggerProfileRefresh(user_id).catch(() => {});

  return c.json({ id });
});

/**
 * GET /api/memory?limit=100&include_deprecated=0
 * Defaults to active memories only (deprecated stay auditable via the flag).
 */
memoryRoutes.get('/', (c) => {
  const user_id = c.get('user_id');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100') || 100, 1), 500);
  const includeDeprecated = c.req.query('include_deprecated') === '1';
  return c.json({ items: listHard(user_id, limit, includeDeprecated) });
});

/**
 * GET /api/memory/search?q=...&limit=50&char_budget=8000&min_results=3&scope=all|global|workspace&workspace=...
 *
 * Budgeted two-tier retrieval (mirrors layered-memory designs):
 *  1. hard memories by FTS rank, cut when the char budget is exhausted;
 *  2. if fewer than min_results matched, fall back to daily summaries with
 *     the remaining budget (returned as pseudo-memories, source='summary').
 * Usage counters of served hard memories are bumped async.
 *
 * `scope=workspace` searches only the given workspace; `all` (default) merges
 * workspace + global results.
 */
memoryRoutes.get('/search', (c) => {
  const user_id = c.get('user_id');
  const q = c.req.query('q') || '';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50') || 50, 1), 200);
  const charBudget = Math.min(Math.max(parseInt(c.req.query('char_budget') || '8000') || 8000, 500), 100000);
  const minResults = Math.min(Math.max(parseInt(c.req.query('min_results') || '3') || 3, 0), 50);
  const scope = c.req.query('scope') === 'workspace' ? 'workspace' : c.req.query('scope') === 'global' ? 'global' : 'all';
  const workspace = (c.req.query('workspace') || '').trim();

  if (scope === 'workspace' && !workspace) {
    return c.json({ error: 'workspace is required when scope=workspace' }, 400);
  }

  const hard = scope === 'workspace' ? [] : searchHard(user_id, q, limit);
  const wsHits = scope === 'global' || !workspace ? [] : searchWorkspaceMemories(user_id, workspace, q, limit);

  // Merge both layers by recency; workspace hits get a small rank bonus so
  // local context wins ties against global facts.
  const all = [...wsHits.map(m => ({ ...m, _ws: true })), ...hard.map(m => ({ ...m, _ws: false }))]
    .sort((a, b) => (a._ws === b._ws ? 0 : a._ws ? -1 : 1) || (b.timestamp || '').localeCompare(a.timestamp || ''));

  // First tier: fill up to the char budget in rank order.
  const items: any[] = [];
  let used = 0;
  let truncated = false;
  for (const m of all) {
    const size = (m.title?.length ?? 0) + (m.content?.length ?? 0);
    if (used + size > charBudget && items.length > 0) {
      truncated = true;
      break;
    }
    const { _ws, ...rest } = m as any;
    items.push(rest);
    used += size;
  }

  // Second tier: daily summaries absorb the remaining budget.
  if (q.trim() && items.length < minResults && used < charBudget) {
    for (const s of searchSummaries(user_id, q, 5)) {
      let text = s.content;
      try {
        const parsed = JSON.parse(s.content);
        text = [parsed.narrative, ...(parsed.decisions ?? []), ...(parsed.problems ?? [])]
          .filter(Boolean)
          .join('\n');
      } catch {
        /* content wasn't JSON — use raw */
      }
      if (used + text.length > charBudget) {
        truncated = true;
        break;
      }
      items.push({
        id: `summary:${s.id}`,
        user_id,
        type: 'fact',
        title: `Daily summary ${s.date}`,
        content: text,
        facts: [],
        concepts: [],
        source: 'summary',
        priority: 'low',
        status: 'active',
        timestamp: s.generated_at,
      });
      used += text.length;
    }
  }

  // Usage accounting for served memories (fire-and-forget). Workspace hits
  // must not bump hard_memories counters, so track them separately.
  const hardIds = items
    .filter(m => !m.workspace)
    .map(m => m.id)
    .filter((id): id is number => typeof id === 'number');
  const wsIds = items
    .filter(m => m.workspace)
    .map(m => m.id)
    .filter((id): id is number => typeof id === 'number');
  if (hardIds.length > 0) {
    Promise.resolve().then(() => touchHardUsage(hardIds)).catch(() => {});
  }
  if (wsIds.length > 0) {
    Promise.resolve().then(() => touchWorkspaceUsage(wsIds)).catch(() => {});
  }

  return c.json({ items, truncated });
});

/**
 * POST /api/memory/touch
 * Body: { ids?: number[], workspace_ids?: number[] }
 * The plugin reports memories it actually injected into the prompt, so recall
 * counters measure real use instead of every candidate that was fetched.
 */
memoryRoutes.post('/touch', async (c) => {
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);

  const clean = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0).slice(0, 200) : [];

  const ids = clean((body as any).ids);
  const workspaceIds = clean((body as any).workspace_ids);

  // Verify ownership before bumping counters.
  const hardIds = ids.length
    ? (getDb().prepare(`SELECT id FROM hard_memories WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(user_id, ...ids) as { id: number }[]).map(r => r.id)
    : [];
  const wsIds = workspaceIds.length
    ? (getDb().prepare(`SELECT id FROM workspace_memories WHERE user_id = ? AND id IN (${workspaceIds.map(() => '?').join(',')})`).all(user_id, ...workspaceIds) as { id: number }[]).map(r => r.id)
    : [];

  if (hardIds.length > 0) touchHardUsage(hardIds);
  if (wsIds.length > 0) touchWorkspaceUsage(wsIds);
  return c.json({ touched: hardIds.length + wsIds.length });
});

/**
 * PATCH /api/memory/:id
 * Body: { status: 'active' | 'deprecated' } — soft state transitions only;
 * physical removal stays behind DELETE.
 */
memoryRoutes.patch('/:id', async (c) => {
  const user_id = c.get('user_id');
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

  const body = await c.req.json().catch(() => null);
  const parsed = safeParse(memoryStatusSchema, body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const ok = setHardStatus(user_id, id, parsed.data.status);
  if (!ok) {
    c.status(404);
    return c.json({ error: 'Not found' });
  }
  return c.json({ id, status: parsed.data.status });
});

/**
 * DELETE /api/memory/:id
 */
memoryRoutes.delete('/:id', (c) => {
  const user_id = c.get('user_id');
  const id = parseInt(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
  const ok = deleteHard(user_id, id);
  if (!ok) {
    c.status(404);
    return c.json({ error: 'Not found' });
  }
  return c.json({ deleted: true });
});
