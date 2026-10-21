# opencode-mem-worker

Centralized memory backend for [opencode-mem-plugin](../). HTTP service backed by SQLite, with cron-driven profile generation.

## What it does

1. Receives two kinds of data from the plugin:
   - **Raw conversation data** — every message and tool call (high volume)
   - **Hard memories** — explicit "记住X / remember X" entries (high value)
2. Stores everything in SQLite with FTS5 for hard-memory search
3. Runs scheduled LLM jobs to produce:
   - **Daily summaries** of raw conversations (every night)
   - **Atom memories** — auto-distilled atomic facts/decisions/constraints from the same day's raws (L1 layer, `source='auto'`, traceable via `source_date` + `session_id`)
   - **User profiles** synthesizing daily summaries (weekly + on-demand); hard memories are injected into the system prompt separately by the plugin
   - **Monthly consolidation** — LLM merges duplicates and deprecates stale memories (soft state, nothing deleted)
   - **Skill drafts** — weekly distillation of long successful sessions into SKILL.md drafts awaiting human approval
4. Serves the latest profile back to the plugin for context injection

## Architecture

```
Plugin (per device)        Worker (single instance)
─────────────────          ───────────────────────
POST /api/raw       ────►  raw_conversations
POST /api/memory    ────►  hard_memories
GET  /api/profile   ◄────  user_profiles
                              ▲
                              │ cron
                              │
                          daily_summaries ──► profile (weekly)
                                          ──► profile (on threshold)
```

## Quick start

```bash
# 1. Install
cd server
npm install

# 2. Configure
cp config.example.yaml config.yaml
# Edit config.yaml: set users, choose LLM model

# 3. Set secrets via env
export LLM_API_KEY=sk-...
export USER_VINCENT_KEY=$(openssl rand -hex 32)

# 4. Dev
npm run dev

# 5. Production via Docker
npm run build
docker compose up -d
```

## API

All `/api/*` endpoints require `Authorization: Bearer <api_key>`. The api_key resolves to a `user_id` via the `users` block in config.yaml.

| Method | Path                        | Purpose                              |
|--------|----------------------------|--------------------------------------|
| GET    | `/health`                   | Liveness check (no auth)             |
| GET    | `/api/whoami`               | Returns the resolved user_id         |
| POST   | `/api/raw`                  | Upload one or many raw conversations |
| GET    | `/api/raw/count?date=...`   | Count today/given date raw rows      |
| POST   | `/api/memory`               | Insert a hard memory (same-title auto atoms are auto-deprecated) |
| GET    | `/api/memory?limit=N&include_deprecated=1` | List recent active hard memories    |
| GET    | `/api/memory/search?q=...&char_budget=8000&min_results=3` | Budgeted two-tier search: hard memories first, daily-summary fallback when under-filled; bumps `usage_count` of served items. Trigram FTS5 + LIKE fallback makes CJK queries work (≥3-char terms via MATCH, shorter terms via LIKE). |
| PATCH  | `/api/memory/:id`           | Soft status transition `{status: active│deprecated}` |
| DELETE | `/api/memory/:id`           | Delete one hard memory               |
| POST   | `/api/memory/touch`         | `{ids, workspace_ids}` — count memories actually injected (recall accounting) |
| GET    | `/api/memory/stats`         | Per-user store health: counts by source/status, profile freshness, pending skill drafts, most-recalled memories |
| GET    | `/api/profile`              | Get current user profile (Markdown)  |
| POST   | `/api/profile/regenerate`   | Manual trigger for current user (`scope: daily│weekly`, optional `date`) |
| GET    | `/api/workspace/list`       | All workspaces with memory/raw counts + last activity |
| POST   | `/api/workspace/memory`     | Insert a workspace-scoped memory     |
| GET    | `/api/workspace/memory?workspace=...&limit=N` | List one workspace's active memories |
| GET    | `/api/workspace/search?workspace=...&q=...` | FTS within one workspace |
| GET    | `/api/workspace/focus?workspace=...&days=7` | Recent-focus topics (workspace + global) |
| POST   | `/api/workspace/focus`      | Add/refresh a focus topic `{topic, workspace?, detail?}` |
| GET    | `/api/workspace/context?workspace=...&days=7` | One round-trip for injection: profile + workspace memories + hard memories + focus |
| GET    | `/ui`                       | Built-in read-only viewer (key from `?key=` or localStorage) |
| GET    | `/api/skills/drafts?status=draft│approved` | List auto-distilled skill drafts |
| POST   | `/api/skills/drafts/:id/approve` | Approve a draft (returns it for plugin install) |

### Content language

LLM-generated content (daily summaries, atom memories, workspace memories,
focus topics, profile, skill drafts) follows `memory_language` in
`config.yaml`:

```yaml
memory_language: zh-CN   # default; also accepts zh-TW, en, ja, ko, ...
```

Only natural language is translated — code, identifiers, paths, commands and
product/API names stay verbatim. Changing it applies to newly generated
content; run `POST /api/profile/regenerate` (or re-run a day's summary) to
rewrite existing items.

### Raw upload payload

Single:
```json
{
  "session_id": "abc123",
  "role": "user",
  "content": "how do I configure X?",
  "timestamp": "2026-06-08T00:00:00Z"
}
```

Batch:
```json
{
  "items": [ {...}, {...} ]
}
```

Tool calls use `role: "tool"` with `tool_name`, `tool_input`, `tool_output`.

### Hard memory payload

```json
{
  "type": "preference",
  "title": "项目构建偏好：使用 Bun",
  "content": "用户指定使用 Bun 作为构建工具",
  "facts": ["构建工具：Bun"],
  "concepts": ["build", "bun"],
  "priority": "high",
  "timestamp": "2026-06-08T00:00:00Z"
}
```

## Cron schedule

Defaults (override in config.yaml `cron:` block):

| Job             | Schedule           | Behavior |
|-----------------|--------------------|----------|
| Daily summary   | `0 3 * * *`        | For each user with raw data yesterday → LLM produces structured daily summary. Idempotent. |
| Atom distill    | with daily summary | Same raws → LLM extracts ≤10 atomic memories (`source='auto'`), watermark-tracked in `distill_state` for idempotence. Disable via `cron.auto_distill: false`. Never triggers profile refresh. |
| Weekly profile  | `0 3 * * 0`        | For each user → LLM regenerates profile from last 7 days summaries. Hard memories are tracked for delta triggers but not fed into the profile (they're injected into the system prompt separately). |
| Skill extract   | `0 3 * * 0`        | Long sessions (≥ `cron.skill_min_raw_count` raw rows, ended on a tool call) from the past week → SKILL.md drafts. Drafts are inert until approved. |
| Raw prune       | `0 4 1 * *`        | Drop raw_conversations > 90 days old. Summaries kept forever. |
| Consolidation   | `0 4 1 * *`        | After prune: LLM merges duplicate memories and deprecates stale ones (soft, auditable). |
| Delta trigger   | on-write           | When user accumulates ≥10 new hard memories since last profile run, refresh profile immediately. |

## LLM cost estimate

Per user per week:
- 7 daily summaries × ~3k input tokens × $0.15/M (gpt-4o-mini) ≈ **$0.003**
- 7 atom distills × ~3k input tokens ≈ **$0.003**
- 1 weekly profile × ~5k input tokens ≈ **$0.001**
- 1-2 delta profile refreshes ≈ **$0.002**
- 0-3 skill extractions + 1 monthly consolidation ≈ **$0.002**

**Total: ~$0.011/user/week** with gpt-4o-mini.

## Data model

```
raw_conversations   (volume tier — pruned at 90 days)
  ├─ user_id, session_id, role, content, tool_*
  └─ indexed by (user_id, date(timestamp))

hard_memories       (value tier — kept forever)
  ├─ user_id, type, title, content, facts[], concepts[]
  ├─ source: manual | auto | auto-promoted
  ├─ governance: status(active|deprecated), usage_count, last_used_at
  ├─ provenance: source_date, session_id
  ├─ FTS5 virtual table for search (trigram tokenizer — CJK-safe, auto-upgraded from unicode61)
  └─ indexed by (user_id, timestamp)

daily_summaries     (LLM output — kept forever)
  ├─ unique(user_id, date)
  └─ FTS5 virtual table (second search tier)

distill_state       (atom-distill watermark)
  └─ pk: (user_id, date) → last_raw_id

skill_drafts        (LLM output — draft | approved)
  └─ indexed by (user_id, status)

user_profiles       (LLM output — single row per user, upserted)
  └─ pk: user_id

profile_meta        (delta tracking)
  └─ last_hard_memory_id per user
```

## Security & operations checklist

- ✅ Bearer auth on all `/api/*`
- ✅ User isolation: API key → user_id mapping, all queries scoped
- ✅ Per-user FTS5 query parameterized + quoted
- ✅ Request body validation (zod) on all write endpoints
- ✅ Config validation: cron expressions, port range, non-empty/duplicate credentials
- ✅ Graceful shutdown: SIGTERM/SIGINT stops cron, closes connections, checkpoints WAL before exit
- ⚠️ Set `CORS_ORIGIN` explicitly in production (default `*`)
- ⚠️ Don't expose port 3777 publicly without a reverse proxy + TLS
- ⚠️ Rotate `LLM_API_KEY` and user API keys periodically
