import { Hono } from 'hono';
import {
  insertWorkspaceMemory,
  listWorkspaceMemories,
  searchWorkspaceMemories,
  touchWorkspaceUsage,
  countWorkspaceMemories,
  listFocus,
  upsertFocus,
  getContextBundle,
} from '../db/repo.js';
import { workspaceMemorySchema, safeParse } from '../validation.js';

export const workspaceRoutes = new Hono<{ Variables: { user_id: string } }>();

const MAX_LIMIT = 200;
const parseLimit = (v: string | undefined, fallback: number) =>
  Math.min(Math.max(parseInt(v || String(fallback)) || fallback, 1), MAX_LIMIT);

const workspaceParam = (c: any): string | null => {
  const ws = c.req.query('workspace');
  return typeof ws === 'string' && ws.trim() ? ws.trim() : null;
};

/**
 * POST /api/workspace/memory
 * Body: { workspace, type, title, content, facts?, concepts?, source? }
 * Durable, workspace-scoped memory ("this repo uses pnpm").
 */
workspaceRoutes.post('/memory', async (c) => {
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => null);
  const parsed = safeParse(workspaceMemorySchema, body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const m = parsed.data;
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
  return c.json({ id, workspace: m.workspace });
});

/**
 * GET /api/workspace/memory?workspace=...&limit=50
 * Active memories for one workspace.
 */
workspaceRoutes.get('/memory', (c) => {
  const user_id = c.get('user_id');
  const workspace = workspaceParam(c);
  if (!workspace) return c.json({ error: 'workspace query parameter is required' }, 400);
  const limit = parseLimit(c.req.query('limit'), 50);
  return c.json({
    workspace,
    items: listWorkspaceMemories(user_id, workspace, limit),
    total: countWorkspaceMemories(user_id, workspace),
  });
});

/**
 * GET /api/workspace/search?workspace=...&q=...&limit=50
 * Full-text search scoped to one workspace.
 */
workspaceRoutes.get('/search', (c) => {
  const user_id = c.get('user_id');
  const workspace = workspaceParam(c);
  if (!workspace) return c.json({ error: 'workspace query parameter is required' }, 400);
  const q = c.req.query('q') || '';
  const limit = parseLimit(c.req.query('limit'), 50);
  const items = searchWorkspaceMemories(user_id, workspace, q, limit);
  const ids = items.map(m => m.id).filter((id): id is number => typeof id === 'number');
  if (ids.length > 0) Promise.resolve().then(() => touchWorkspaceUsage(ids)).catch(() => {});
  return c.json({ workspace, items });
});

/**
 * GET /api/workspace/focus?workspace=...&days=7&limit=8
 * Rolling "recently focused on" topics. Without `workspace`, returns topics
 * across all workspaces.
 */
workspaceRoutes.get('/focus', (c) => {
  const user_id = c.get('user_id');
  const workspace = workspaceParam(c);
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '7') || 7, 1), 90);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '8') || 8, 1), 50);
  return c.json({ workspace, days, items: listFocus(user_id, workspace, days, limit) });
});

/**
 * POST /api/workspace/focus
 * Body: { topic, workspace?, detail? } — manual "I'm focusing on X".
 */
workspaceRoutes.post('/focus', async (c) => {
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => null);
  const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
  if (!topic) return c.json({ error: 'topic is required' }, 400);
  const workspace = typeof body?.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null;
  const date = new Date().toISOString().slice(0, 10);
  upsertFocus({
    user_id,
    workspace,
    topic: topic.slice(0, 200),
    detail: typeof body?.detail === 'string' ? body.detail.slice(0, 500) : '',
    date,
  });
  return c.json({ topic, workspace, last_seen: date });
});

/**
 * GET /api/workspace/context?workspace=...&days=7
 * Single round-trip for the plugin's per-turn injection:
 *   { profile, workspace_memories, hard_memories, focus }
 * The plugin applies per-layer char budgets on top of this.
 */
workspaceRoutes.get('/context', (c) => {
  const user_id = c.get('user_id');
  const workspace = workspaceParam(c);
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '7') || 7, 1), 90);
  const bundle = getContextBundle(user_id, workspace, { focus_days: days });
  return c.json(bundle);
});