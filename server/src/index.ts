import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { getConfig } from './config/index.js';
import { initDb, closeDb } from './db/schema.js';
import { getHealthMetrics, getServiceSnapshot } from './db/repo.js';
import { initLLM, getLLM } from './llm/client.js';
import { startCron, stopCron } from './cron/jobs.js';
import { authMiddleware } from './middleware/auth.js';
import { rawRoutes } from './routes/raw.js';
import { memoryRoutes } from './routes/memory.js';
import { profileRoutes } from './routes/profile.js';
import { skillRoutes } from './routes/skills.js';
import { workspaceRoutes } from './routes/workspace.js';
import { UI_HTML } from './routes/ui.js';

function log(level: string, msg: string, extra?: object) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, scope: 'boot', msg, ...(extra || {}) }));
}

/**
 * Warn if the configured tz doesn't match the process's actual system tz.
 *
 * Daily summaries bucket raw timestamps by calendar day. The JS side
 * (yesterdayDate) honors config.tz, but SQLite's localtime() follows the
 * process's C-library TZ (the host/container tz, not the IANA name). If those
 * disagree, a day's worth of raws can land in the wrong summary bucket.
 *
 * Set the process tz to match config.tz (e.g. `TZ=Asia/Shanghai` env, or the
 * `tz:` field in docker-compose) to silence this.
 */
function checkTimezoneAlignment(configTz: string): void {
  const processTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (processTz !== configTz) {
    log('warn', `timezone mismatch: config.tz=${configTz} but process tz=${processTz}. ` +
      `Set the process/host TZ to match config.tz, or daily summaries may bucket the wrong day.`);
  }
}

/** Whole days between a YYYY-MM-DD date and today, both resolved in config tz. */
function daysSince(dateStr: string, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = Date.parse(`${fmt.format(new Date())}T00:00:00Z`);
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(today) || Number.isNaN(then)) return 0;
  return Math.round((today - then) / 86400000);
}

/**
 * Cheap LLM round-trip at boot. Capture and search work without the LLM, so a
 * failure here must not stop the server — but an expired subscription or dead
 * credential has to be loud at startup instead of surfacing days later as
 * silently missing summaries.
 */
async function validateLLMAtBoot(): Promise<void> {
  const cfg = getConfig();
  const res = await getLLM().ping();
  if (res.ok) {
    log('info', 'llm reachable', { model: cfg.llm.model, ms: res.ms });
    return;
  }
  log('error', 'llm unreachable at boot: summaries, profile, atom distill and skill drafts will not run', {
    model: cfg.llm.model,
    base_url: cfg.llm.base_url,
    ms: res.ms,
    error: res.error,
  });
}

function bootstrap() {
  const cfg = getConfig();
  initDb(cfg.db_path);
  initLLM(cfg.llm);
  checkTimezoneAlignment(cfg.tz);
  void validateLLMAtBoot();

  const app = new Hono<{ Variables: { user_id: string } }>();

  // CORS only on /api/*, restricted (override with explicit origin allowlist in prod)
  app.use('/api/*', cors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }));

  // `status` stays 'ok' whenever the HTTP layer is serving, so clients keep
  // uploading raws even while the LLM pipeline is down. `pipeline_status` is the
  // separate signal for "is the intelligence layer actually producing output".
  app.get('/health', (c) => {
    const m = getHealthMetrics();
    const state = getServiceSnapshot();
    const llmOkAt = state.llm_ok_at?.value ?? null;
    const llmErrorAt = state.llm_error_at?.value ?? null;
    const llmError = state.llm_error?.value ?? null;
    const llmDown = !!llmErrorAt && (!llmOkAt || llmErrorAt > llmOkAt);
    const lagDays = m.last_summary_date ? daysSince(m.last_summary_date, cfg.tz) : null;
    // Today's raws are only summarized after the 03:00 job, so 1-2 unsummarized
    // days is normal; beyond that the pipeline is behind.
    const degraded = llmDown || m.unsummarized_days > 2 || (lagDays !== null && lagDays > 2);
    return c.json({
      status: 'ok',
      time: new Date().toISOString(),
      users: cfg.users.length,
      pipeline_status: degraded ? 'degraded' : 'ok',
      pipeline: {
        last_summary_date: m.last_summary_date,
        last_summary_at: m.last_summary_at,
        last_profile_at: m.last_profile_at,
        lag_days: lagDays,
        unsummarized_days: m.unsummarized_days,
        llm_ok_at: llmOkAt,
        llm_error_at: llmErrorAt,
        llm_error: llmError ? llmError.slice(0, 300) : null,
      },
    });
  });

  // All /api/* routes require bearer auth
  app.use('/api/*', authMiddleware);

  // Read-only viewer. The page is static; it authenticates its own /api calls
  // with the key from ?key= (or localStorage).
  app.get('/ui', (c) => c.html(UI_HTML));
  app.get('/', (c) => c.redirect('/ui'));
  app.get('/favicon.ico', (c) => c.body(null, 204));

  app.route('/api/raw', rawRoutes);
  app.route('/api/memory', memoryRoutes);
  app.route('/api/profile', profileRoutes);
  app.route('/api/skills', skillRoutes);
  app.route('/api/workspace', workspaceRoutes);

  app.get('/api/whoami', (c) => c.json({ user_id: c.get('user_id') }));

  startCron();

  log('info', 'opencode-mem-worker ready', {
    port: cfg.port,
    db: cfg.db_path,
    llm_model: cfg.llm.model,
    users: cfg.users.length,
  });

  const server = serve({ fetch: app.fetch, port: cfg.port });
  installGracefulShutdown(server);
}

let shuttingDown = false;
function installGracefulShutdown(server: ReturnType<typeof serve>): void {
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `shutdown received (${sig})`);

    // 1. Stop cron so no new LLM jobs start.
    stopCron();

    // 2. Stop accepting new connections.
    server.close(() => {
      // 3. Checkpoint WAL + close DB.
      closeDb();
      log('info', 'shutdown complete');
      process.exit(0);
    });

    // Force-exit if close() hangs (e.g. long-lived connections).
    setTimeout(() => {
      log('warn', 'shutdown timeout, forcing exit');
      closeDb();
      process.exit(1);
    }, 10000).unref();
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => shutdown(sig));
  }
}

try {
  bootstrap();
} catch (e) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'fatal',
    scope: 'boot',
    error: String(e),
  }));
  process.exit(1);
}
