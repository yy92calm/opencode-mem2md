import cron from 'node-cron';
import {
  listAllUsers,
  listRawByDate,
  countRawByDate,
  listWorkspaceCountsByDate,
  upsertDailySummary,
  listRecentSummaries,
  listLatestSummaries,
  upsertProfile,
  getProfile,
  getProfileMeta,
  updateProfileMeta,
  getMaxHardId,
  countHardSince,
  countHard,
  pruneSummarizedRawOlderThan,
  getDistillState,
  setDistillState,
  maxRawIdByDate,
  insertHard,
  insertWorkspaceMemory,
  upsertFocus,
  pruneFocusOlderThan,
  deprecateStaleAutoMemories,
  enforceHardMemoryCap,
  listHard,
  setHardStatus,
  updateHardContent,
  listLongSessions,
  hasSkillDraftForSession,
  listRawBySession,
  insertSkillDraft,
} from '../db/repo.js';
import { generateDailySummary, generateProfile, extractAtoms, consolidateMemories, extractSkill } from '../llm/prompts.js';
import { getConfig } from '../config/index.js';
import type { RawConversation } from '../types/index.js';

function log(level: string, msg: string, extra?: object) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, level, scope: 'cron', msg, ...(extra || {}) }));
}

// Per-user in-flight guards: prevent concurrent regenerations of the same kind.
// profileInFlight coalesces profile refreshes (weekly + delta).
// dailyInFlight coalesces same-day daily summaries (cron + manual trigger).
const profileInFlight = new Set<string>();
const dailyInFlight = new Set<string>();

// Governance thresholds for the global hard-memory store. Memory that is never
// recalled and ages out is deprecated (not deleted), keeping the active set
// small enough to stay useful in the per-turn injection budget.
const HARD_MEMORY_CAP = 150;
const STALE_AUTO_DAYS = 30;
/** Minimum body length for an auto-distilled atom; shorter ones are noise. */
const MIN_ATOM_CONTENT = 80;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalize a YYYY-MM-DD date string. Throws on malformed input
 * so callers (route handlers) can surface it as a 400 to the client.
 */
function assertDate(date: string): void {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date (expected YYYY-MM-DD): "${date}"`);
}

/**
 * Yesterday's date in the configured timezone.
 *
 * NOTE on timezones: raw_conversations stores timestamps as ISO strings (UTC),
 * but SQLite queries like `date(timestamp)` and `date('now')` interpret those
 * strings in UTC. For users not on UTC, the plugin-side local day does not line
 * up with the server-side query day, so a daily summary can silently cover the
 * wrong calendar day.
 *
 * The Worker resolves this by loading raw timestamps into the configured tz via
 * `datetime(timestamp, 'localtime')` in repo queries, and by computing
 * "yesterday" here in the same tz. cron itself runs on the host wall clock, so
 * keep server host tz aligned with `tz` for correct 03:00-local scheduling.
 */
function yesterdayDate(): string {
  const tz = getConfig().tz;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = fmt.format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yo = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const do_ = String(dt.getUTCDate()).padStart(2, '0');
  return `${yo}-${mo}-${do_}`;
}

/**
 * Daily job: for each user, summarize yesterday's raw conversations.
 * Idempotent — re-running same day overwrites the summary.
 */
export async function runDailySummary(): Promise<void> {
  const date = yesterdayDate();
  const users = listAllUsers();
  log('info', `daily_summary start`, { date, users: users.length });

  for (const user_id of users) {
    try {
      await runDailySummaryForUser(user_id, date);
    } catch (e) {
      log('error', `summary failed`, { user_id, date, error: String(e) });
    }
  }

  // Focus is a rolling window: drop topics not seen in two weeks.
  try {
    const pruned = pruneFocusOlderThan(14);
    if (pruned > 0) log('info', `focus pruned`, { removed: pruned });
  } catch (e) {
    log('warn', `focus prune failed`, { error: String(e) });
  }

  // Retire auto memories nobody has recalled in a while. Manual memories and
  // high-priority items are never touched.
  for (const user_id of users) {
    try {
      const retired = deprecateStaleAutoMemories(user_id, STALE_AUTO_DAYS);
      const evicted = enforceHardMemoryCap(user_id, HARD_MEMORY_CAP);
      if (retired > 0 || evicted > 0) {
        log('info', `memory governance`, { user_id, retired_stale: retired, evicted_over_cap: evicted });
      }
    } catch (e) {
      log('warn', `memory governance failed`, { user_id, error: String(e) });
    }
  }
}

/**
 * Summarize a single user's raw conversations for a given date.
 * Coalesced via dailyInFlight: while one summary for (user_id, date) is
 * running, concurrent triggers (cron overlapping a manual click) are skipped
 * instead of spending another LLM call on the same day.
 */
export async function runDailySummaryForUser(user_id: string, date: string = yesterdayDate()): Promise<boolean> {
  assertDate(date);
  const key = `${user_id}|${date}`;
  if (dailyInFlight.has(key)) {
    log('debug', `daily summary skipped (already running)`, { user_id, date });
    return false;
  }
  dailyInFlight.add(key);
  try {
    const count = countRawByDate(user_id, date);
    if (count === 0) {
      log('debug', `skip empty`, { user_id, date });
      return false;
    }
    const raws = listRawByDate(user_id, date);
    // A failing summary must not abort the whole job: previously the throw
    // propagated past the distill block below, so one dead LLM endpoint took
    // out both pipelines and left no trace in distill_state.
    let result: Awaited<ReturnType<typeof generateDailySummary>> = null;
    try {
      result = await generateDailySummary(user_id, date, raws);
    } catch (e) {
      log('error', `daily summary failed`, { user_id, date, error: String(e) });
    }
    if (result) {
      upsertDailySummary({
        user_id,
        date,
        content: result.content,
        raw_count: result.raw_count,
        generated_at: new Date().toISOString(),
      });
      // Daily topics double as "recent focus" signals. Attribute them to the
      // workspace that dominated the day; a mixed day produces global topics.
      recordFocusFromSummary(user_id, date, result.content);
      log('info', `summary ok`, { user_id, date, raw_count: result.raw_count });
    }

    // L1 distill runs on the same day's raws even if the summary LLM call
    // failed — failures are isolated so one pipeline doesn't block the other.
    if (getConfig().cron.auto_distill) {
      try {
        await distillAtomsForUser(user_id, date, raws);
      } catch (e) {
        log('error', `atom distill failed`, { user_id, date, error: String(e) });
      }
    }

    // Keep the profile in step with new observations (3-day freshness gate).
    if (result) {
      try {
        await maybeRefreshProfileAfterSummary(user_id);
      } catch (e) {
        log('error', `profile refresh after summary failed`, { user_id, date, error: String(e) });
      }
    }

    return result !== null;
  } finally {
    dailyInFlight.delete(key);
  }
}

/**
 * L1 distill: extract atomic memories from a day's raw conversations.
 *
 * Idempotent via distill_state watermark: rows at or below last_raw_id were
 * already refined on a previous run and are skipped. Auto atoms are inserted
 * with source='auto' and NEVER trigger profile refresh (that path only fires
 * from user-asserted memories via the API route, avoiding self-triggering).
 */
async function distillAtomsForUser(user_id: string, date: string, raws: RawConversation[]): Promise<number> {
  const lastId = getDistillState(user_id, date);
  const fresh = raws.filter(r => (r.id ?? 0) > lastId);
  if (fresh.length === 0) return 0;

  // Existing active titles serve double duty: prompt context (steer the LLM
  // away from re-extracting) and a server-side duplicate gate (belt & braces).
  const existingTitles = listHard(user_id, 500).map(m => m.title);
  const known = new Set(existingTitles.map(t => t.trim().toLowerCase()));

  const atoms = await extractAtoms(user_id, date, fresh, existingTitles);
  const maxId = maxRawIdByDate(user_id, date);

  // Map the 8-char session prefixes the LLM reports back to full session ids.
  const prefixMap = new Map<string, string>();
  // session -> workspace, so workspace-scoped atoms land in the right bucket.
  const workspaceBySession = new Map<string, string>();
  for (const r of fresh) {
    const prefix = r.session_id.slice(0, 8);
    prefixMap.set(prefix, r.session_id);
    if (r.workspace) workspaceBySession.set(r.session_id, r.workspace);
  }

  let inserted = 0;
  let insertedWorkspace = 0;
  for (const atom of atoms) {
    const key = atom.title.trim().toLowerCase();
    if (known.has(key)) continue; // cross-day dup or intra-batch dup
    // Quality gate: a one-line atom without substance is not worth a slot in
    // the injected memory budget or a profile signal.
    if (atom.content.trim().length < MIN_ATOM_CONTENT) continue;
    known.add(key);

    const sessionId = atom.session ? prefixMap.get(atom.session) ?? null : null;
    const workspace = sessionId ? workspaceBySession.get(sessionId) ?? null : null;

    // Workspace-scoped atoms need a known workspace; without one they fall
    // back to the global store so the knowledge is never silently dropped.
    if (atom.scope === 'workspace' && workspace) {
      insertWorkspaceMemory({
        user_id,
        workspace,
        type: atom.type,
        title: atom.title,
        content: atom.content,
        facts: atom.facts,
        concepts: atom.concepts,
        source: 'auto',
        session_id: sessionId,
        source_date: date,
        timestamp: new Date().toISOString(),
      });
      insertedWorkspace++;
    } else {
      insertHard({
        user_id,
        type: atom.type,
        title: atom.title,
        content: atom.content,
        facts: atom.facts,
        concepts: atom.concepts,
        source: 'auto',
        priority: 'medium',
        session_id: sessionId,
        source_date: date,
        timestamp: new Date().toISOString(),
      });
      inserted++;
    }
  }

  // Advance the watermark even when zero atoms were extracted — those raws
  // have been considered; re-running must not pay for another LLM call.
  setDistillState(user_id, date, Math.max(maxId, lastId));

  // Keep the active store bounded. Runs after each distill so growth is
  // gradual and predictable instead of waiting for the monthly job.
  const evicted = enforceHardMemoryCap(user_id, HARD_MEMORY_CAP);
  if (evicted > 0) log('info', `hard memories capped`, { user_id, evicted, cap: HARD_MEMORY_CAP });

  if (inserted > 0 || insertedWorkspace > 0 || atoms.length > 0) {
    log('info', `atoms distilled`, {
      user_id, date, extracted: atoms.length, inserted_global: inserted,
      inserted_workspace: insertedWorkspace, raws: fresh.length,
    });
  }
  return inserted + insertedWorkspace;
}

/**
 * Turn a daily summary's `topics` into recent-focus entries.
 * Topics belong to the workspace that dominated the day (>60% of raws);
 * mixed days contribute global topics instead of mis-attributing them.
 */
function recordFocusFromSummary(user_id: string, date: string, summaryContent: string): void {
  let topics: string[] = [];
  try {
    const parsed = JSON.parse(summaryContent);
    if (Array.isArray(parsed?.topics)) {
      topics = parsed.topics.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 7);
    }
  } catch {
    return; // free-form summary — no structured topics to harvest
  }
  if (topics.length === 0) return;

  const counts = listWorkspaceCountsByDate(user_id, date).filter(c => c.workspace);
  const total = counts.reduce((a, c) => a + c.count, 0);
  const top = counts[0];
  const workspace = top && total > 0 && top.count / total >= 0.6 ? top.workspace : null;

  for (const topic of topics) {
    upsertFocus({
      user_id,
      workspace,
      topic: topic.slice(0, 200),
      detail: '',
      date,
    });
  }
}

/**
 * Weekly job: regenerate full profile from last 7 days summaries.
 * (Hard memories are tracked for delta triggers + counts, but not fed to
 * the LLM — they're injected into the system prompt separately by the plugin.)
 */
export async function runWeeklyProfile(): Promise<void> {
  const users = listAllUsers();
  log('info', `weekly_profile start`, { users: users.length });

  for (const user_id of users) {
    try {
      await regenerateProfileForUser(user_id, 'weekly');
    } catch (e) {
      log('error', `profile failed`, { user_id, error: String(e) });
    }
  }
}

/**
 * Triggered when hard memory delta crosses threshold for a user.
 * Called from API layer after hard memory insert.
 * Debounced via an in-flight guard: while one refresh is running for a user,
 * further triggers are skipped (next cron cycle catches any leftover delta).
 */
export async function maybeTriggerProfileRefresh(user_id: string): Promise<boolean> {
  const cfg = getConfig();
  const meta = getProfileMeta(user_id);
  const delta = countHardSince(user_id, meta.last_hard_memory_id);

  if (delta < cfg.cron.hard_memory_threshold) return false;

  const ran = await regenerateProfileForUser(user_id, 'delta');
  if (!ran) {
    log('debug', `delta trigger skipped (already running)`, { user_id, delta });
  }
  return ran;
}

/**
 * Regenerate a single user's profile. Returns false if a refresh is already
 * running for this user (coalescing), true if it ran.
 */
export async function regenerateProfileForUser(user_id: string, reason: string): Promise<boolean> {
  if (profileInFlight.has(user_id)) {
    log('debug', `profile skipped (already running)`, { user_id, reason });
    return false;
  }
  profileInFlight.add(user_id);
  try {
    await doRegenerateProfile(user_id, reason);
  } finally {
    profileInFlight.delete(user_id);
  }
  return true;
}

async function doRegenerateProfile(user_id: string, reason: string): Promise<void> {
  // Prefer the last 7 days, but fall back to the latest summaries when the
  // window is sparse. A user who works in bursts would otherwise get an empty
  // "(pending more data)" profile written over a perfectly good older one.
  let summaries = listRecentSummaries(user_id, 7);
  if (summaries.length < 3) {
    const latest = listLatestSummaries(user_id, 10);
    if (latest.length > summaries.length) summaries = latest;
  }
  // Hard memories are never fed to the profile LLM — they're injected into the
  // system prompt separately by the plugin. So we only need a count here.
  const hardCount = countHard(user_id);

  // Never overwrite a real profile with an empty one: no summaries means no
  // observed behaviour to synthesize from.
  if (summaries.length === 0) {
    log('debug', `profile skip (no summaries)`, { user_id, reason });
    return;
  }

  const content = await generateProfile(user_id, summaries);
  upsertProfile({
    user_id,
    content,
    version: 1, // upsert increments
    generated_at: new Date().toISOString(),
    source_raw_count: summaries.reduce((a, s) => a + s.raw_count, 0),
    source_memory_count: hardCount,
  });
  updateProfileMeta(user_id, getMaxHardId(user_id));
  log('info', `profile updated`, {
    user_id, reason, lines: content.split('\n').length, summaries: summaries.length,
  });
}

/**
 * Refresh the profile after a new daily summary lands, but only when the
 * current one is missing or older than a few days. Keeps the profile fresh
 * without paying for an extra LLM call every day.
 */
async function maybeRefreshProfileAfterSummary(user_id: string): Promise<void> {
  const profile = getProfile(user_id);
  const stale = !profile
    || Date.now() - new Date(profile.generated_at).getTime() > 3 * 24 * 60 * 60 * 1000;
  if (!stale) return;
  await regenerateProfileForUser(user_id, 'daily');
}

/**
 * Cleanup: drop raw conversations older than 90 days, but only for days that
 * were actually summarized (summaries and hard memories are kept forever).
 * A day whose summary never got generated keeps its raws so it stays
 * backfillable instead of being silently destroyed by the retention window.
 */
export async function runRawPrune(): Promise<void> {
  const { deleted, retained_days } = pruneSummarizedRawOlderThan(90);
  log('info', `prune raw`, { deleted, retained_unsummarized_days: retained_days });
}

/**
 * Monthly consolidation: LLM merges duplicates and deprecates stale memories.
 * Never deletes — merged-away and stale items are marked 'deprecated' so the
 * audit trail survives. Runs right after the monthly raw prune.
 */
export async function runMonthlyConsolidate(): Promise<void> {
  const users = listAllUsers();
  log('info', `monthly_consolidate start`, { users: users.length });

  for (const user_id of users) {
    try {
      // Cap input so pathological stores can't blow the context window.
      const memories = listHard(user_id, 300);
      if (memories.length < 5) continue;

      const plan = await consolidateMemories(memories);
      let merged = 0;
      let deprecated = 0;

      for (const m of plan.merge) {
        if (m.title) {
          updateHardContent(m.keep_id, {
            title: m.title,
            content: m.content || undefined,
            facts: m.facts.length ? m.facts : undefined,
            concepts: m.concepts.length ? m.concepts : undefined,
          });
        }
        for (const id of m.deprecate_ids) {
          if (setHardStatus(user_id, id, 'deprecated')) deprecated++;
        }
        merged++;
      }
      for (const id of plan.deprecate) {
        if (setHardStatus(user_id, id, 'deprecated')) deprecated++;
      }

      if (merged > 0 || deprecated > 0) {
        log('info', `consolidated`, { user_id, merged, deprecated });
      }
    } catch (e) {
      log('error', `consolidate failed`, { user_id, error: String(e) });
    }
  }
}

/**
 * Weekly skill extraction: long sessions from the past week that ended in
 * real work are distilled into SKILL.md drafts. Drafts wait for explicit
 * human approval (POST /api/skills/drafts/:id/approve) — nothing is
 * auto-installed. Sessions already distilled are skipped.
 */
export async function runWeeklySkillExtract(): Promise<void> {
  const cfg = getConfig();
  const users = listAllUsers();
  log('info', `weekly_skill_extract start`, { users: users.length });

  for (const user_id of users) {
    try {
      const sessions = listLongSessions(user_id, 7, cfg.cron.skill_min_raw_count);
      for (const s of sessions.slice(0, 3)) {
        if (hasSkillDraftForSession(user_id, s.session_id)) continue;
        const raws = listRawBySession(user_id, s.session_id);
        // Only sessions that ended on a tool execution look "completed";
        // a trailing user message usually means unfinished work.
        const last = raws[raws.length - 1];
        if (!last || last.role !== 'tool') continue;

        const skill = await extractSkill(user_id, s.session_id, raws);
        if (skill) {
          const id = insertSkillDraft({
            user_id,
            title: skill.title,
            content_md: skill.content_md,
            session_id: s.session_id,
          });
          log('info', `skill draft created`, { user_id, id, title: skill.title, session: s.session_id.slice(0, 8) });
        }
      }
    } catch (e) {
      log('error', `skill extract failed`, { user_id, error: String(e) });
    }
  }
}

let started = false;
const scheduledTasks: cron.ScheduledTask[] = [];

export function startCron(): void {
  if (started) return;
  started = true;

  const cfg = getConfig();
  log('info', `scheduling`, { daily: cfg.cron.daily_summary, weekly: cfg.cron.weekly_profile });

  scheduledTasks.push(
    cron.schedule(cfg.cron.daily_summary, () => {
      runDailySummary().catch(e => log('error', 'daily uncaught', { error: String(e) }));
    }),
  );

  scheduledTasks.push(
    cron.schedule(cfg.cron.weekly_profile, () => {
      runWeeklyProfile().catch(e => log('error', 'weekly uncaught', { error: String(e) }));
    }),
  );

  // prune + consolidate monthly
  scheduledTasks.push(
    cron.schedule('0 4 1 * *', () => {
      runRawPrune()
        .then(() => runMonthlyConsolidate())
        .catch(e => log('error', 'prune/consolidate uncaught', { error: String(e) }));
    }),
  );

  // skill extraction rides the weekly profile schedule
  scheduledTasks.push(
    cron.schedule(cfg.cron.weekly_profile, () => {
      runWeeklySkillExtract().catch(e => log('error', 'skill extract uncaught', { error: String(e) }));
    }),
  );
}

export function stopCron(): void {
  for (const t of scheduledTasks) {
    try { t.stop(); } catch { /* ignore */ }
  }
  scheduledTasks.length = 0;
  started = false;
  log('info', `cron stopped`);
}
