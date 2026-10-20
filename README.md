# opencode-mem

**[中文文档](./README_CN.md)**

> Persistent memory for [OpenCode](https://opencode.ai) via a centralized Worker. The plugin targets the **OpenCode V2 plugin API** (`@opencode/plugin`, verified against OpenCode 2.0.32) to capture conversations, provide memory tools, and inject profiles.

This monorepo has two parts:

| Path        | What it is                                              |
|-------------|---------------------------------------------------------|
| [`server/`](./server)  | **Worker** — Hono + SQLite + cron + LLM. Run once, anywhere. |
| [`src/`](./src)        | **Plugin** — OpenCode hooks and memory tools, running in every OpenCode instance. |

## How it works

```
┌─────────────────────────┐         ┌─────────────────────────────────┐
│  OpenCode (each device) │  HTTPS  │   Worker (single instance)      │
│  ─────────────────────  │  ─────► │   ────────────────────────────  │
│  • tool.execute.after   │  raw    │   raw_conversations   (90 days) │
│  • user messages        │  ─────► │   hard_memories       (forever) │
│  • "记住X" → Skill      │  memory │             │                   │
│                         │         │             ▼ cron               │
│  • inject system prompt │  ◄───── │   daily_summaries (LLM)         │
│                         │ profile │   user_profiles   (LLM)         │
└─────────────────────────┘         └─────────────────────────────────┘
```

**Two data tracks, served by one HTTP API:**

1. **Raw conversations** — every tool call + user message, batched and flushed by the plugin. Cheap, lossy, pruned after 90 days.
2. **Hard memories** — explicit "记住 X / remember X" entries created via the `mem-remember` skill. Stored forever, FTS5-searchable.

**Four memory layers, injected per turn:**

| Layer | Store | Scope | Source |
|---|---|---|---|
| **Workspace memory** | `workspace_memories` | one directory/project | auto-distilled (`scope=workspace`) + `mem_capture scope=workspace` |
| **Hard memory** | `hard_memories` | all workspaces | user-asserted "记住 X" + auto-distilled global atoms |
| **User profile** | `user_profiles` | global | weekly LLM synthesis of daily summaries |
| **Recent focus** | `recent_focus` | rolling 7-day window | daily-summary topics, weight ×N when recurring |

Each layer has its own char budget (`workspace_char_budget`, `hard_char_budget`,
`profile_char_budget`, `focus_char_budget`), so one large layer cannot starve the
others. Anything omitted from injection stays reachable via `mem_search`.

**Three scheduled jobs run inside the Worker:**

| When                   | What                                                      |
|------------------------|-----------------------------------------------------------|
| Every day at 03:00     | LLM distills yesterday's raw conversations → daily summary + atom memories (global or workspace-scoped) + recent-focus topics; stale focus pruned after 14 days |
| Every Sunday at 03:00  | LLM builds profile from last 7 daily summaries; long successful sessions → skill drafts (need approval) |
| When user adds ≥10 new hard memories | LLM refreshes profile immediately                |
| Monthly (1st, 04:00)   | Raw prune (>90 days) + LLM consolidation (merge duplicates, deprecate stale memories) |

The Worker is the only source of truth. The plugin uses a small JSONL offline cache only when the Worker is unreachable.

## Quick start

### 1. Run the Worker

```bash
cd server
cp config.example.yaml config.yaml         # edit users + LLM model
export LLM_API_KEY=sk-...                  # your OpenAI/OpenRouter/etc key
export USER_VINCENT_KEY=$(openssl rand -hex 32)
npm install
npm run dev                                # or `docker compose up -d`
```

See [`server/README.md`](./server/README.md) for full deployment + API docs.

**Built-in viewer:** open `http://<host>:3777/ui` (or `/ui?key=<api_key>` to skip the prompt). The page is read-only and shows every memory layer — stats, workspace memories, hard memories, profile, and recent focus — with a workspace picker and search. The key is stored in your browser's localStorage; the page itself contains no data.

### 2. Install the plugin

```bash
npm install
npm run build:all
npm run install:opencode                   # copies plugin bundle + skills to ~/.config/opencode/
```

### 3. Configure the plugin

Either set env vars:

```bash
export MEM_SERVER_URL=http://localhost:3777
export MEM_API_KEY=<the same key from step 1>
```

Or write `~/.config/opencode/mem/config.json`:

```json
{
  "server_url": "http://localhost:3777",
  "api_key": "<the same key>"
}
```

Restart OpenCode. The plugin installs its memory tools and system-prompt hooks.

## Bad-network behavior

Designed to fail gracefully when the Worker is unreachable:

| Scenario | Behavior |
|---|---|
| Worker down → raw upload | Batch falls through to `offline.jsonl` cache |
| Worker down → hard memory write | Cached locally, returns a warning, no crash |
| Worker down → profile fetch | Falls back to last-known profile in `profile.cache.md` |
| Worker recovers mid-session | Background watchdog replays cache automatically |
| Process killed (SIGTERM/SIGINT) | In-memory buffer is flushed to offline cache before exit |
| Cache grows unboundedly | Rotated to `.jsonl.bak` at 10 MB (overwrites prior `.bak`) |
| Cache contains invalid entries | 4xx (server-rejected) entries dropped as dead letters; 5xx/network errors retry |
| High latency on chat startup | Profile fetch capped at 2 s; falls back to local cache |

All thresholds are tunable in the plugin config:

| Key                          | Default | Purpose |
|------------------------------|---------|---------|
| `raw_buffer_size`             | 20      | Auto-flush when buffer hits N items |
| `raw_flush_interval_ms`       | 10 000  | Periodic flush even if the buffer isn't full |
| `watchdog_interval_ms`        | 300 000 | Replay offline cache + recheck health |
| `write_timeout_ms`           | 15 000  | POST request timeout |
| `read_timeout_ms`            | 10 000  | GET request timeout |
| `profile_fetch_timeout_ms`   | 2 000   | Profile fetch timeout on chat startup |
| `profile_cache_ttl_ms`       | 60 000  | In-memory profile cache TTL (0 disables) |
| `memories_cache_ttl_ms`      | 30 000  | In-memory hard-memory cache TTL (0 disables) |
| `inject_char_budget`         | 6 000   | Legacy total; split 25/27/33/10 across profile/workspace/hard/focus |
| `profile_char_budget`        | 1 500   | Max chars for the profile layer |
| `workspace_char_budget`      | 1 600   | Max chars for the workspace-memory layer |
| `hard_char_budget`           | 2 000   | Max chars for the global hard-memory layer |
| `focus_char_budget`          | 600     | Max chars for the recent-focus layer |
| `focus_days`                 | 7       | Recent-focus lookback window |
| `offline_cache_path`         | `~/.config/opencode/mem/offline.jsonl` | JSONL append-log |
| `offline_cache_max_bytes`    | `10485760` | Rotation threshold (10 MB) |
| `profile_cache_path`         | `~/.config/opencode/mem/profile.cache.md` | Last-known profile |

## Where to deploy the Worker

The Worker is just an HTTP service. Put it wherever fits your trust boundary:

- **Localhost** — single-user, no network exposure, `127.0.0.1:3777`
- **Home server / NAS** — multi-device personal use over LAN/VPN
- **Cloud VM** — multi-device anywhere; **must** put TLS + restrict CORS

The plugin only sees `server_url`. Same binary, same config schema, different network position.

## What the plugin provides

Six tools backed by Worker HTTP calls:

| Tool | Purpose |
|---|---|
| `mem_capture` | Insert a hard memory (`scope=global\|workspace`) |
| `mem_search` | Search global + workspace memories |
| `mem_focus` | Show recent focus topics (rolling window) |
| `mem_list` | List recent hard memories |
| `mem_profile` | Fetch the latest user profile |
| `mem_health` | Check Worker connectivity and drain offline cache |
| `mem_skill_sync` | Approve/install Worker-distilled skill drafts |

The skills in [`skills/`](./skills/) wrap these plugin tools. The plugin is written against the OpenCode V2 plugin API: `Plugin.define` + `ctx.tool.transform/hook`, `ctx.session.hook("prompt"/"context")`, and `ctx.event.subscribe`. OpenCode V2 auto-loads plugins from `~/.config/opencode/plugins/`, so no `plugins` config entry is needed after `npm run install:opencode`. Requires OpenCode 2.0.x; V1 (1.x) is no longer supported by this version of the plugin.

## License

MIT
