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
check('tools registered', toolNames.length === 6, toolNames.join(','));

// JSON Schema shape
const capture = registrations.transform.find((t) => t.name === 'mem_capture');
check('mem_capture schema', capture?.input?.type === 'object' && Array.isArray(capture.input.required), JSON.stringify(capture?.input?.required));

// tool execute returns { content }
const capResult = await capture.execute(
  { type: 'fact', title: 'smoke', content: 'smoke memory', facts: [], concepts: [] },
  { sessionID: 'ses_smoke', agent: 'build', messageID: 'msg_1', id: 'call_1', signal: new AbortController().signal, progress: async () => {} },
);
check('mem_capture offline result', capResult?.content?.startsWith('⚠ Cached offline'), String(capResult?.content).slice(0, 60));

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

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (!r.ok) failed++;
}
rmSync(cacheDir, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
