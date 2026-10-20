#!/usr/bin/env node
/**
 * Worker smoke test for layered memory: workspace memories, recent focus,
 * merged retrieval, and the context bundle. Uses a temp DB — never touches
 * production data.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'mem-worker-smoke-'));
const dbPath = join(dir, 'test.db');

const schema = await import('../dist/db/schema.js');
const repo = await import('../dist/db/repo.js');

schema.initDb(dbPath);

const user = 'tester';
const wsA = '/Users/tester/projects/alpha';
const wsB = '/Users/tester/projects/beta';
const now = new Date().toISOString();
const today = now.slice(0, 10);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// --- raw rows with workspace attribution ---
repo.insertRawBatch([
  { user_id: user, session_id: 'ses_a1', workspace: wsA, role: 'user', content: 'alpha uses pnpm', timestamp: now },
  { user_id: user, session_id: 'ses_a1', workspace: wsA, role: 'tool', content: '', tool_name: 'bash', tool_input: 'pnpm build', tool_output: 'ok', timestamp: now },
  { user_id: user, session_id: 'ses_b1', workspace: wsB, role: 'user', content: 'beta uses npm', timestamp: now },
]);
check('raw rows with workspace', repo.listWorkspaceCountsByDate(user, today).length === 2);

// --- workspace memories: same title in two workspaces must not collide ---
const aId = repo.insertWorkspaceMemory({
  user_id: user, workspace: wsA, type: 'config', title: 'Package manager',
  content: 'This repo uses pnpm, not npm.', facts: ['pnpm build:all'], concepts: ['tooling'],
  source: 'manual', session_id: 'ses_a1', timestamp: now,
});
const bId = repo.insertWorkspaceMemory({
  user_id: user, workspace: wsB, type: 'config', title: 'Package manager',
  content: 'This repo uses npm workspaces.', facts: [], concepts: [],
  source: 'manual', session_id: 'ses_b1', timestamp: now,
});
check('same title isolated per workspace', aId !== bId);
check('workspace A count', repo.countWorkspaceMemories(user, wsA) === 1);
check('workspace B count', repo.countWorkspaceMemories(user, wsB) === 1);

// re-asserting refreshes instead of duplicating
const aId2 = repo.insertWorkspaceMemory({
  user_id: user, workspace: wsA, type: 'config', title: 'package manager',
  content: 'Updated: pnpm only.', facts: [], concepts: [], source: 'manual', timestamp: now,
});
check('re-assert refreshes row', aId2 === aId && repo.countWorkspaceMemories(user, wsA) === 1);

// --- CJK search inside a workspace ---
repo.insertWorkspaceMemory({
  user_id: user, workspace: wsA, type: 'decision', title: '数据库选型',
  content: '项目使用 SQLite 作为主存储，不引入外部数据库。', facts: [], concepts: ['db'],
  source: 'manual', timestamp: now,
});
const cjk = repo.searchWorkspaceMemories(user, wsA, '数据库', 10);
check('CJK workspace search', cjk.length === 1 && cjk[0].title.includes('数据库'), `${cjk.length} hits`);
const crossWs = repo.searchWorkspaceMemories(user, wsB, '数据库', 10);
check('workspace search is isolated', crossWs.length === 0);

// --- global hard memory ---
repo.insertHard({
  user_id: user, type: 'preference', title: 'Prefers TypeScript strict',
  content: 'Always enable strict mode.', facts: [], concepts: [], source: 'manual',
  priority: 'high', timestamp: now,
});

// --- recent focus ---
repo.upsertFocus({ user_id: user, workspace: wsA, topic: 'memory layering', date: today });
repo.upsertFocus({ user_id: user, workspace: wsA, topic: 'memory layering', date: today });
repo.upsertFocus({ user_id: user, workspace: null, topic: 'open-source release', date: today });
const focus = repo.listFocus(user, wsA, 7, 10);
check('focus includes workspace + global', focus.length === 2, focus.map(f => f.topic).join(','));
check('focus weight increments', focus.find(f => f.topic === 'memory layering')?.weight === 2);

// --- context bundle: all four layers in one call ---
repo.upsertProfile({
  user_id: user, content: '## Identity & Context\nTest profile', version: 1,
  generated_at: now, source_raw_count: 3, source_memory_count: 1,
});
const bundle = repo.getContextBundle(user, wsA, { focus_days: 7 });
check('bundle profile', bundle.profile?.includes('Test profile'));
check('bundle workspace memories', bundle.workspace_memories.length === 2, `${bundle.workspace_memories.length}`);
check('bundle hard memories', bundle.hard_memories.length === 1);
check('bundle focus', bundle.focus.length === 2);
check('bundle excludes other workspace', bundle.workspace_memories.every(m => m.workspace === wsA));

// --- stats surface the new layers ---
const stats = repo.getStats(user);
check('stats workspaces', stats.workspaces === 2, String(stats.workspaces));
check('stats workspace memories', stats.workspace_memories === 3, String(stats.workspace_memories));
check('stats focus topics', stats.focus_topics === 2, String(stats.focus_topics));

// --- focus pruning ---
repo.upsertFocus({ user_id: user, workspace: wsA, topic: 'stale topic', date: '2020-01-01' });
const pruned = repo.pruneFocusOlderThan(14);
check('stale focus pruned', pruned === 1, String(pruned));

schema.closeDb();
rmSync(dir, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);