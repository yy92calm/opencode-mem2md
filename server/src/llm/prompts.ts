import { getLLM } from './client.js';
import type { RawConversation, DailySummary, HardMemory } from '../types/index.js';

const DAILY_SUMMARY_SYSTEM = `You analyze a developer's coding session conversations and produce a concise daily summary.

Output a JSON object with this exact shape:
{
  "topics": ["short topic 1", "short topic 2", ...],          // 3-7 items, what the user worked on
  "decisions": ["decision 1", ...],                            // any explicit choices made (libraries, patterns, etc)
  "problems": ["problem 1", ...],                              // errors, blockers, things being debugged
  "preferences_observed": ["e.g. prefers TypeScript strict mode"],   // implicit style/tool preferences hinted by behavior
  "narrative": "2-4 sentence prose summary"
}

Be specific. Skip filler like "user asked questions". Focus on signals useful for future sessions.`;

const PROFILE_SYSTEM = `You generate or update a developer's persistent profile, used to give future AI assistants context about who they're helping.

Input: recent daily summaries (distilled from observed conversations).

The profile captures what is OBSERVED about the user from their behavior. Explicit, user-asserted facts are tracked separately and injected into the system prompt independently — therefore this profile must NOT duplicate them. Focus on patterns, stack, and working style inferred from the daily summaries.

Output: a Markdown profile under 60 lines, with these sections:

## Identity & Context
(2-3 lines: what kind of work they do, primary environment)

## Stack & Tools
(bullet list of confirmed tech from daily summaries: languages, frameworks, build tools, editors)

## Preferences
(coding style, communication patterns OBSERVED from daily summaries — NOT explicit user commands)

## Active Projects
(what they're currently building / debugging — keep current, drop stale)

## Recent Patterns
(2-3 bullets: themes from the last week)

If daily summaries are empty or insufficient, leave sections as "(pending more data)".
Do NOT invent facts.`;

export interface DailySummaryResult {
  date: string;
  raw_count: number;
  content: string;       // JSON string with structured fields
  narrative: string;
}

const ATOM_TYPES = ['preference', 'config', 'decision', 'error', 'discovery', 'fact', 'constraint', 'pattern'] as const;

const EXTRACT_ATOMS_SYSTEM = `You extract durable, reusable knowledge from a developer's coding-session conversations.

Output a JSON object: { "atoms": [ ... ] }. Each atom is one standalone memory:
{
  "type": one of ${JSON.stringify(ATOM_TYPES)},
  "title": "short descriptive title",
  "content": "1-3 sentences, self-contained (no 'the user said' framing)",
  "facts": ["key fact 1", "..."],
  "concepts": ["tag1", "tag2"],
  "scope": "global" | "workspace",
  "session": "the 8-char session prefix from the --- session ... --- marker this atom came from, or null"
}

Rules:
- Only extract information that would help a FUTURE session: stable preferences, confirmed decisions, hard constraints, project facts, recurring patterns, verified fixes.
- Skip transient chatter, questions, and anything only true for that moment.
- "constraint" = must/must-not rules (e.g. "don't refactor module X"); "pattern" = recurring working habits.
- scope="workspace" when the fact only holds for the specific project/repo/directory worked on (its scripts, ports, file layout, deployment target, local conventions). scope="global" for things true across all projects (personal preferences, machine setup, general decisions).
- At most 10 atoms. Return { "atoms": [] } when nothing durable exists.
- NEVER duplicate items listed under "Already known" — no rephrasings of them either.
- Do NOT invent facts not present in the conversations.`;

function formatRawForLLM(raws: RawConversation[]): string {
  const lines: string[] = [];
  let lastSession = '';
  for (const r of raws) {
    if (r.session_id !== lastSession) {
      lines.push(`\n--- session ${r.session_id.slice(0, 8)} ---`);
      lastSession = r.session_id;
    }
    if (r.role === 'tool' && r.tool_name) {
      const input = (r.tool_input || '').slice(0, 200);
      const output = (r.tool_output || '').slice(0, 300);
      lines.push(`[tool:${r.tool_name}] in=${input} out=${output}`);
    } else {
      const content = r.content.slice(0, 800);
      lines.push(`[${r.role}] ${content}`);
    }
  }
  return lines.join('\n');
}

export async function generateDailySummary(
  user_id: string,
  date: string,
  raws: RawConversation[],
): Promise<DailySummaryResult | null> {
  if (raws.length === 0) return null;

  // Cap context to avoid blowing up token limits (~50k chars ≈ 12k tokens)
  const formatted = formatRawForLLM(raws).slice(0, 50000);

  const messages = [
    { role: 'system' as const, content: DAILY_SUMMARY_SYSTEM },
    {
      role: 'user' as const,
      content: `Date: ${date}\nUser: ${user_id}\n\nConversations:\n${formatted}\n\nReturn JSON only.`,
    },
  ];

  // Prefer structured JSON output. Some OpenAI-compatible endpoints (Ollama,
  // certain Volc/Together deployments) reject the response_format field itself.
  // Only in that specific case retry once without it and parse free-form output;
  // every other error propagates so the caller can log and record it.
  let response: string;
  try {
    response = await getLLM().chat(messages, {
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
  } catch (e) {
    if (!isResponseFormatRejection(e)) throw e;
    response = await getLLM().chat(messages, { temperature: 0.2 });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(response);
  } catch {
    return { date, raw_count: raws.length, content: response, narrative: response.slice(0, 500) };
  }

  return {
    date,
    raw_count: raws.length,
    content: JSON.stringify(parsed, null, 2),
    narrative: parsed.narrative ?? '',
  };
}

/**
 * Chat expecting a JSON response. Some OpenAI-compatible endpoints reject
 * response_format with a 4xx; on that, retry once without it.
 */
/**
 * True only when the provider rejected the request *because of* the
 * response_format field. Deliberately narrow: a blanket "any 4xx" check made
 * the client retry credential/subscription/model errors (400 InvalidSubscription,
 * 401, 404) without response_format too, doubling pointless calls per failure.
 */
const FORMAT_REJECTION_RE =
  /response_format|json_object|json_schema|unsupported (parameter|field|value|argument)|unknown parameter|invalid_parameter/i;

function isResponseFormatRejection(e: unknown): boolean {
  return FORMAT_REJECTION_RE.test(e instanceof Error ? e.message : String(e));
}

async function chatJson(messages: { role: 'system' | 'user'; content: string }[], temperature: number): Promise<string> {
  try {
    return await getLLM().chat(messages, { temperature, response_format: { type: 'json_object' } });
  } catch (e) {
    if (!isResponseFormatRejection(e)) throw e;
    return await getLLM().chat(messages, { temperature });
  }
}

export interface AtomExtract {
  type: typeof ATOM_TYPES[number];
  title: string;
  content: string;
  facts: string[];
  concepts: string[];
  /** workspace = only true for that project; global = true everywhere */
  scope: 'global' | 'workspace';
  /** 8-char session prefix for provenance mapping; null if unknown */
  session: string | null;
}

/**
 * L1 distill: raw conversations of one day -> atomic memories.
 * Returns [] on empty input or unparseable output (never throws into cron).
 * `existingTitles` (already-stored memory titles) is fed to the prompt so the
 * LLM avoids re-extracting known facts across days.
 */
export async function extractAtoms(
  user_id: string,
  date: string,
  raws: RawConversation[],
  existingTitles: string[] = [],
): Promise<AtomExtract[]> {
  if (raws.length === 0) return [];

  const formatted = formatRawForLLM(raws).slice(0, 50000);
  const knownBlock = existingTitles.length > 0
    ? `\nAlready known (do NOT duplicate):\n${existingTitles.slice(0, 50).map(t => `- ${t}`).join('\n')}\n`
    : '';
  const response = await chatJson([
    { role: 'system', content: EXTRACT_ATOMS_SYSTEM },
    { role: 'user', content: `Date: ${date}\nUser: ${user_id}\n${knownBlock}\nConversations:\n${formatted}\n\nReturn JSON only.` },
  ], 0.2);

  let parsed: any;
  try {
    parsed = JSON.parse(response);
  } catch {
    return [];
  }

  const list: any[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.atoms) ? parsed.atoms : []);
  const atoms: AtomExtract[] = [];
  for (const item of list.slice(0, 10)) {
    if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;
    const type = ATOM_TYPES.includes(item.type) ? item.type : 'fact';
    atoms.push({
      type,
      title: item.title.slice(0, 500),
      content: typeof item.content === 'string' ? item.content.slice(0, 2000) : '',
      facts: Array.isArray(item.facts) ? item.facts.filter((f: any) => typeof f === 'string').slice(0, 10) : [],
      concepts: Array.isArray(item.concepts) ? item.concepts.filter((c: any) => typeof c === 'string').slice(0, 10) : [],
      scope: item.scope === 'workspace' ? 'workspace' : 'global',
      session: typeof item.session === 'string' && item.session.length >= 8 ? item.session.slice(0, 8) : null,
    });
  }
  return atoms;
}

/**
 * Generate a user profile from daily summaries only.
 * Hard memories are intentionally excluded — they're injected into the
 * system prompt separately by the plugin, so including them here would
 * duplicate content and blur the observed/asserted distinction.
 */
export async function generateProfile(
  user_id: string,
  summaries: DailySummary[],
): Promise<string> {
  const summariesText = summaries
    .map(s => `### ${s.date} (${s.raw_count} msgs)\n${s.content}`)
    .join('\n\n');

  const userContent = `User: ${user_id}

=== Recent Daily Summaries ===
${summariesText || '(none)'}

Generate the profile now.`;

  const response = await getLLM().chat([
    { role: 'system', content: PROFILE_SYSTEM },
    { role: 'user', content: userContent },
  ], {
    temperature: 0.3,
  });

  // Trim to 60 lines hard cap
  return response.split('\n').slice(0, 60).join('\n').trim();
}

// ===== Monthly consolidation =====

const CONSOLIDATE_SYSTEM = `You maintain a developer's long-term memory store. Given a list of memory items (each with an id), output a JSON maintenance plan:
{
  "actions": [
    { "op": "merge", "keep_id": <id of the item that survives>, "deprecate_ids": [<ids absorbed into it>],
      "title": "merged title", "content": "merged content", "facts": [...], "concepts": [...] },
    { "op": "deprecate", "ids": [<ids that are stale, contradicted, or worthless>]
  ]
}

Rules:
- Merge only items that clearly duplicate or refine the same topic. Keep the richer wording.
- Deprecate items contradicted by newer ones, or noise with zero future value (e.g. stale "currently debugging X" from months ago).
- Only reference ids present in the input. Most runs should produce few or zero actions — prefer keeping items.
- Return { "actions": [] } if everything is fine.`;

export interface ConsolidationPlan {
  merge: { keep_id: number; deprecate_ids: number[]; title: string; content: string; facts: string[]; concepts: string[] }[];
  deprecate: number[];
}

/**
 * Ask the LLM for a dedup/staleness plan over a user's active memories.
 * Validates every referenced id against the input set; invalid plans yield
 * an empty result rather than corrupting data.
 */
export async function consolidateMemories(memories: HardMemory[]): Promise<ConsolidationPlan> {
  const empty: ConsolidationPlan = { merge: [], deprecate: [] };
  if (memories.length < 2) return empty;

  const listing = memories.map(m =>
    `[id=${m.id}] type=${m.type} source=${m.source} used=${m.usage_count}x date=${(m.timestamp || '').slice(0, 10)}\n` +
    `title: ${m.title}\ncontent: ${m.content.slice(0, 500)}`,
  ).join('\n\n');

  const response = await chatJson([
    { role: 'system', content: CONSOLIDATE_SYSTEM },
    { role: 'user', content: `Memories:\n\n${listing}\n\nReturn JSON only.` },
  ], 0.1);

  let parsed: any;
  try {
    parsed = JSON.parse(response);
  } catch {
    return empty;
  }

  const validIds = new Set(memories.map(m => m.id!));
  const isValidId = (v: any) => Number.isInteger(v) && validIds.has(v);
  const plan: ConsolidationPlan = { merge: [], deprecate: [] };

  for (const action of Array.isArray(parsed?.actions) ? parsed.actions : []) {
    if (action?.op === 'merge') {
      if (!isValidId(action.keep_id)) continue;
      const depIds = Array.isArray(action.deprecate_ids)
        ? action.deprecate_ids.filter((i: any) => isValidId(i) && i !== action.keep_id)
        : [];
      if (depIds.length === 0) continue;
      plan.merge.push({
        keep_id: action.keep_id,
        deprecate_ids: depIds,
        title: typeof action.title === 'string' ? action.title.slice(0, 500) : '',
        content: typeof action.content === 'string' ? action.content.slice(0, 2000) : '',
        facts: Array.isArray(action.facts) ? action.facts.filter((f: any) => typeof f === 'string') : [],
        concepts: Array.isArray(action.concepts) ? action.concepts.filter((c: any) => typeof c === 'string') : [],
      });
    } else if (action?.op === 'deprecate') {
      const ids = Array.isArray(action.ids) ? action.ids.filter(isValidId) : [];
      plan.deprecate.push(...ids);
    }
  }
  return plan;
}

// ===== Skill extraction =====

const EXTRACT_SKILL_SYSTEM = `You distill a successfully completed, complex coding session into a reusable SKILL.md draft.

Output a JSON object:
{
  "title": "kebab-case-skill-name",
  "content_md": "full SKILL.md markdown"
}

The content_md must follow this structure:
---
name: <kebab-case-name>
description: <one line: when to use this skill>
---

# <Title>
## When to use
## Steps
(numbered, concrete, from what actually worked in the session)
## Notes / Pitfalls

Rules:
- Only extract a skill if the session shows a COMPLETE, successful workflow worth repeating (troubleshooting flow, release process, migration, etc).
- Do not capture generic programming knowledge — only what was specific and proven in this session.
- Return { "title": "", "content_md": "" } if the session is not skill-worthy.`;

export interface SkillExtract {
  title: string;
  content_md: string;
}

/** Distill one long session into a SKILL.md draft; null when not skill-worthy. */
export async function extractSkill(user_id: string, session_id: string, raws: RawConversation[]): Promise<SkillExtract | null> {
  if (raws.length === 0) return null;

  const formatted = formatRawForLLM(raws).slice(0, 60000);
  const response = await chatJson([
    { role: 'system', content: EXTRACT_SKILL_SYSTEM },
    { role: 'user', content: `User: ${user_id}\nSession: ${session_id}\n\nTranscript:\n${formatted}\n\nReturn JSON only.` },
  ], 0.3);

  let parsed: any;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }

  const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  const content = typeof parsed?.content_md === 'string' ? parsed.content_md.trim() : '';
  if (!title || !content) return null;
  return { title: title.slice(0, 200), content_md: content };
}
