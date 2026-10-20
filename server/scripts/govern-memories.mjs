#!/usr/bin/env node
/**
 * One-off memory governance for an existing store.
 *
 *   node scripts/govern-memories.mjs [--dry-run] [--user <id>]
 *
 * Steps per user:
 *   1. report the active store
 *   2. retire auto-distilled memories never recalled and older than 60 days
 *   3. enforce the 150-entry active cap (lowest value first)
 *   4. regenerate the profile from the latest summaries (needs LLM)
 *
 * Deprecation is soft: rows stay in the DB and can be reactivated with
 * PATCH /api/memory/:id { status: "active" }.
 */
import { loadConfig } from '../dist/config/index.js';
import { initDb, closeDb } from '../dist/db/schema.js';
import { initLLM } from '../dist/llm/client.js';
import * as repo from '../dist/db/repo.js';
import { generateProfile } from '../dist/llm/prompts.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const userArg = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;

const STALE_DAYS = 60;
const CAP = 150;

const cfg = loadConfig();
initDb(cfg.db_path);
initLLM(cfg.llm);

const users = userArg ? [userArg] : repo.listAllUsers();
console.log(`users: ${users.join(', ')}${dryRun ? ' (dry run)' : ''}`);

const report = (user) => {
  const s = repo.getStats(user);
  const p = repo.getProfile(user);
  return {
    active: s.hard_active,
    manual: s.hard_manual,
    auto: s.hard_auto,
    deprecated: s.hard_deprecated,
    never_used: repo
      .listHard(user, 1000)
      .filter((m) => (m.usage_count ?? 0) === 0).length,
    profile_version: p?.version ?? null,
    profile_source_raws: p?.source_raw_count ?? null,
    profile_len: p?.content?.length ?? 0,
    profile_pending: p ? p.content.includes('(pending more data)') : null,
  };
};

for (const user of users) {
  console.log(`\n=== ${user} ===`);
  console.log('before:', JSON.stringify(report(user)));

  if (dryRun) {
    const stale = repo.listHard(user, 1000).filter(
      (m) =>
        m.source === 'auto' &&
        (m.usage_count ?? 0) === 0 &&
        m.priority !== 'high' &&
        m.timestamp < new Date(Date.now() - STALE_DAYS * 86400_000).toISOString(),
    );
    console.log(`would retire ${stale.length} stale auto memories; cap is ${CAP}`);
    continue;
  }

  const retired = repo.deprecateStaleAutoMemories(user, STALE_DAYS);
  const evicted = repo.enforceHardMemoryCap(user, CAP);
  console.log(`retired stale auto: ${retired}, evicted over cap: ${evicted}`);

  // Profile: same window logic as the cron job.
  let summaries = repo.listRecentSummaries(user, 7);
  if (summaries.length < 3) {
    const latest = repo.listLatestSummaries(user, 10);
    if (latest.length > summaries.length) summaries = latest;
  }
  if (summaries.length === 0) {
    console.log('profile: skipped (no summaries)');
  } else {
    try {
      const content = await generateProfile(user, summaries);
      repo.upsertProfile({
        user_id: user,
        content,
        version: 1,
        generated_at: new Date().toISOString(),
        source_raw_count: summaries.reduce((a, s) => a + s.raw_count, 0),
        source_memory_count: repo.countHard(user),
      });
      console.log(`profile: regenerated from ${summaries.length} summaries (${content.length} chars)`);
    } catch (e) {
      console.log(`profile: FAILED — ${String(e).slice(0, 200)}`);
    }
  }
  console.log('after: ', JSON.stringify(report(user)));
}

closeDb();