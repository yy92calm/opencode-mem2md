#!/usr/bin/env node
/**
 * Backfill daily summaries (and L1 atom distill) for a date range.
 *
 * Needed whenever the LLM pipeline was down for a while: raws keep being
 * captured, but the 03:00 job produced nothing, so those days have to be
 * re-run before the 90-day retention window reaches them.
 *
 * Usage (run from the server/ directory, after `npm run build`):
 *   node scripts/backfill.mjs --from 2026-06-22 --to 2026-09-11
 *   node scripts/backfill.mjs --from 2026-06-22 --to 2026-09-11 --dry
 *   node scripts/backfill.mjs --from 2026-09-01 --to 2026-09-11 --user vincent
 *
 * Exit code: 0 when every non-empty day produced a summary, 1 otherwise.
 */
import { getConfig } from '../dist/config/index.js';
import { initDb } from '../dist/db/schema.js';
import { initLLM, getLLM } from '../dist/llm/client.js';
import { listAllUsers, countRawByDate } from '../dist/db/repo.js';
import { runDailySummaryForUser } from '../dist/cron/jobs.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function usage() {
  console.log(`backfill daily summaries + atom distill over a date range

  --from YYYY-MM-DD   first day (required)
  --to   YYYY-MM-DD   last day, inclusive (required)
  --user ID           limit to one user (default: every configured user)
  --delay MS          pause between days (default: 500)
  --dry               list what would run, no LLM calls
  -h, --help          this text`);
}

function parseArgs(argv) {
  const out = { from: null, to: null, user: null, dry: false, delayMs: 500, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--delay') out.delayMs = Number(argv[++i]);
    else if (a === '--dry') out.dry = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function dateRange(from, to) {
  const days = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message || e));
  usage();
  process.exit(2);
}

if (args.help) {
  usage();
  process.exit(0);
}
if (!args.from || !args.to || !DATE_RE.test(args.from) || !DATE_RE.test(args.to)) {
  console.error('--from and --to are required and must be YYYY-MM-DD');
  usage();
  process.exit(2);
}

const cfg = getConfig();
initDb(cfg.db_path);
initLLM(cfg.llm);

const users = args.user ? [args.user] : listAllUsers();
const days = dateRange(args.from, args.to);

console.log(JSON.stringify({
  scope: 'backfill',
  from: args.from,
  to: args.to,
  days: days.length,
  users,
  dry: args.dry,
  model: cfg.llm.model,
  auto_distill: cfg.cron.auto_distill,
}));

if (!args.dry) {
  const ping = await getLLM().ping();
  if (!ping.ok) {
    console.error(JSON.stringify({
      scope: 'backfill',
      level: 'fatal',
      msg: 'LLM ping failed; aborting instead of burning a call per day',
      error: ping.error,
    }));
    process.exit(1);
  }
  console.log(JSON.stringify({ scope: 'backfill', msg: 'llm ping ok', ms: ping.ms }));
}

let ok = 0;
let skipped = 0;
let failed = 0;

for (const date of days) {
  for (const user of users) {
    const raws = countRawByDate(user, date);
    if (raws === 0) {
      skipped++;
      console.log(JSON.stringify({ date, user, raws: 0, result: 'skip-empty' }));
      continue;
    }
    if (args.dry) {
      console.log(JSON.stringify({ date, user, raws, result: 'would-run' }));
      continue;
    }
    try {
      const produced = await runDailySummaryForUser(user, date);
      if (produced) ok++;
      else failed++;
      console.log(JSON.stringify({ date, user, raws, result: produced ? 'summary-ok' : 'summary-failed' }));
    } catch (e) {
      failed++;
      console.log(JSON.stringify({ date, user, raws, result: 'error', error: String(e).slice(0, 300) }));
    }
    if (args.delayMs > 0) await new Promise(r => setTimeout(r, args.delayMs));
  }
}

console.log(JSON.stringify({ scope: 'backfill', done: true, ok, skipped, failed }));
process.exit(failed > 0 ? 1 : 0);
