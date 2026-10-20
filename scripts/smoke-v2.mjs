#!/usr/bin/env node
/**
 * Smoke test: run the V2 plugin's setup() against a fake Context and verify
 * every registration path works (tools transform, tool/session hooks, event
 * subscription, cleanup). Worker is unreachable on purpose to exercise the
 * offline-cache path. Uses a temp cache dir — never touches real user data.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const cacheDir = mkdtempSync(join(tmpdir(), 'mem-smoke-'));
// Override ALL writable paths via a local config file so the smoke test never
// touches the real ~/.config/opencode/mem/ state.
const memDir = join(cacheDir, '.opencode', 'mem');
mkdirSync(memDir, { recursive: true });
writeFileSync(
  join(memDir, 'config.json'),
  JSON.stringify({
    server_url: 'http://127.0.0.1:59999', // nothing listens here → offline path
    api_key: 'smoke-key',
    offline_cache_path: join(memDir, 'offline.jsonl'),
    profile_cache_path: join(memDir, 'profile.cache.md'),
    watchdog_interval_ms: 60_000_000, // effectively off during test
    raw_flush_interval_ms: 60_000_000,
  }),
);

const registrations = { transform: [], toolHooks: [], sessionHooks: [] };
const idleEvents = [];
let idleResolve;
const idleGate = new Promise((r) => (idleResolve = r));

const ctx = {
  location: { directory: cacheDir, project: { id: 'p1', directory: cacheDir, canonical: cacheDir } },
  options: {},
  app: { name: 'opencode', version: '2.0.32', channel: 'stable' },
  tool: {
    transform: async (cb) => {
      const editor = { added: [], add(t) { this.added.push(t); } };
      cb(editor);
      registrations.transform.push(...editor.added);
      return { dispose: async () => {} };
    },
    hook: async (name, cb) => {
      registrations.toolHooks.push({ name, cb });
      return { dispose: async () => {} };
    },
  },
  session: {
    hook: async (name, cb) => {
      registrations.sessionHooks.push({ name, cb });
      return { dispose: async () => {} };
    },
  },
  event: {
    subscribe: async function* ({ signal } = {}) {
      yield { type: 'session.idle', sessionID: 'ses_smoke' };
      idleResolve();
      // Keep the stream open until aborted, like the real one.
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
    },
  },
};

const plugin = (await import('../dist/opencode-mem.bundle.js')).default;
console.log('plugin id:', plugin.id);

const cleanup = await plugin.setup(ctx);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
};

const toolNames = registrations.transform.map((t) => t.name);
check('tools registered', toolNames.length === 7, toolNames.join(','));

// JSON Schema shape
const capture = registrations.transform.find((t) => t.name === 'mem_capture');
check('mem_capture schema', capture?.input?.type === 'object' && Array.isArray(capture.input.required), JSON.stringify(capture?.input?.required));
check('mem_focus tool present', !!registrations.transform.find((t) => t.name === 'mem_focus'));

// tool execute returns { content }
const capResult = await capture.execute(
  { type: 'fact', title: 'smoke', content: 'smoke memory', facts: [], concepts: [] },
  { sessionID: 'ses_smoke', agent: 'build', messageID: 'msg_1', id: 'call_1', signal: new AbortController().signal, progress: async () => {} },
);
check('mem_capture offline result', capResult?.content?.startsWith('⚠ Cached offline'), String(capResult?.content).slice(0, 60));

// workspace-scoped capture goes to the offline cache with scope+workspace
const capWs = await capture.execute(
  { type: 'config', title: 'ws smoke', content: 'workspace fact', scope: 'workspace' },
  { sessionID: 'ses_smoke', agent: 'build', messageID: 'msg_1b', id: 'call_1b', signal: new AbortController().signal, progress: async () => {} },
);
check('workspace capture offline result', capWs?.content?.includes('workspace'), String(capWs?.content).slice(0, 80));

// prompt hook captures user text
const promptHook = registrations.sessionHooks.find((h) => h.name === 'prompt');
await promptHook.cb({ sessionID: 'ses_smoke', messageID: 'msg_2', prompt: { text: 'hello smoke test' }, delivery: 'steer' });
check('prompt hook ran', true);

// tool execute.after hook (completed with content)
const afterHook = registrations.toolHooks.find((h) => h.name === 'execute.after');
await afterHook.cb({
  tool: 'bash',
  sessionID: 'ses_smoke',
  agent: 'build',
  messageID: 'msg_3',
  id: 'call_2',
  input: { command: 'npm run build:all' },
  status: 'completed',
  result: { content: [{ type: 'text', text: 'x'.repeat(200) }] },
});
check('execute.after hook ran', true);

// context hook must not throw even with Worker down
const contextHook = registrations.sessionHooks.find((h) => h.name === 'context');
const systemParts = [];
await contextHook.cb({
  sessionID: 'ses_smoke',
  model: { providerID: 'x', id: 'm' },
  agent: 'build',
  system: systemParts,
  messages: [],
  options: {},
  tools: {},
});
check('context hook tolerated offline', true, `system parts pushed: ${systemParts.length}`);

// session.idle from the event stream flushes to offline cache
await idleGate;
await new Promise((r) => setTimeout(r, 300));
check('idle flush produced offline cache', existsSync(join(memDir, 'offline.jsonl')), '');

// cleanup must run without throwing
await cleanup();
check('cleanup ran', true);

// ===== Online path: four-layer context injection against a mock Worker =====
import { createServer } from 'http';
const mockBundle = {
  workspace: cacheDir,
  profile: '## Identity & Context\nSmoke test profile',
  workspace_memories: [
    { id: 1, workspace: cacheDir, type: 'config', title: 'WS uses pnpm', content: 'This repo uses pnpm workspaces', facts: [], concepts: [], source: 'manual', priority: 'high', timestamp: '2026-10-19T00:00:00Z' },
  ],
  hard_memories: [
    { id: 1, type: 'preference', title: 'Global pref', content: 'Prefers TypeScript strict mode', facts: [], concepts: [], source: 'manual', priority: 'high', timestamp: '2026-10-19T00:00:00Z' },
  ],
  focus: [{ topic: 'memory layering', workspace: cacheDir, detail: '', weight: 2, last_seen: '2026-10-19' }],
};
const mock = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/health')) return res.end(JSON.stringify({ status: 'ok' }));
  if (req.url?.startsWith('/api/workspace/context')) return res.end(JSON.stringify(mockBundle));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

const onlineDir = mkdtempSync(join(tmpdir(), 'mem-smoke-online-'));
const onlineMem = join(onlineDir, '.opencode', 'mem');
mkdirSync(onlineMem, { recursive: true });
writeFileSync(
  join(onlineMem, 'config.json'),
  JSON.stringify({
    server_url: `http://127.0.0.1:${mockPort}`,
    api_key: 'smoke-key',
    offline_cache_path: join(onlineMem, 'offline.jsonl'),
    profile_cache_path: join(onlineMem, 'profile.cache.md'),
    watchdog_interval_ms: 60_000_000,
    raw_flush_interval_ms: 60_000_000,
  }),
);

const onlineRegistrations = { sessionHooks: [] };
const onlineCtx = {
  ...ctx,
  location: { directory: onlineDir, project: { id: 'p2', directory: onlineDir, canonical: onlineDir } },
  session: {
    hook: async (name, cb) => {
      onlineRegistrations.sessionHooks.push({ name, cb });
      return { dispose: async () => {} };
    },
  },
};
const onlineCleanup = await plugin.setup(onlineCtx);
const onlineContext = onlineRegistrations.sessionHooks.find((h) => h.name === 'context');
const onlineParts = [];
await onlineContext.cb({
  sessionID: 'ses_online',
  model: { providerID: 'x', id: 'm' },
  agent: 'build',
  system: onlineParts,
  messages: [],
  options: {},
  tools: {},
});
const injected = onlineParts.map((p) => p.text).join('\n');
check('injects workspace memory layer', injected.includes('## Workspace Memory'));
check('injects hard memory layer', injected.includes('## Hard Memories'));
check('injects recent focus layer', injected.includes('## Recent Focus'));
check('injects profile layer', injected.includes('## User Profile'));
check('workspace fact present', injected.includes('WS uses pnpm'));
check('profile truncated/capped safely', injected.length < 20000, `${injected.length} chars`);
await onlineCleanup();
mock.close();
rmSync(onlineDir, { recursive: true, force: true });

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
rmSync(cacheDir, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
