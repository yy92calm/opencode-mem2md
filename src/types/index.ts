/**
 * Types shared by the plugin and matching the Worker API contract.
 * See server/README.md for the canonical API spec.
 */

export interface RawConversation {
  session_id: string;
  /** Absolute directory of the OpenCode session (workspace isolation). */
  workspace?: string | null;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
  tool_input?: string;
  tool_output?: string;
  timestamp: string;
}

export interface HardMemory {
  id?: number;
  /** Present only on workspace-scoped memories returned by merged search. */
  workspace?: string;
  type: 'preference' | 'config' | 'decision' | 'error' | 'discovery' | 'fact' | 'constraint' | 'pattern';
  title: string;
  content: string;
  facts: string[];
  concepts: string[];
  /** manual = user-asserted; auto = Worker-distilled from conversations */
  source?: 'manual' | 'auto-promoted' | 'auto' | 'summary';
  priority?: 'high' | 'medium' | 'low';
  status?: 'active' | 'deprecated';
  usage_count?: number;
  last_used_at?: string | null;
  source_date?: string | null;
  session_id?: string;
  timestamp: string;
}

/** Rolling topic the user is currently working on. */
export interface RecentFocus {
  id?: number;
  user_id?: string;
  workspace: string | null;
  topic: string;
  detail: string;
  weight: number;
  last_seen: string;
}

/** One round-trip payload for the four-layer system-prompt injection. */
export interface ContextBundle {
  workspace: string | null;
  profile: string | null;
  workspace_memories: HardMemory[];
  hard_memories: HardMemory[];
  focus: RecentFocus[];
}

export interface SkillDraft {
  id: number;
  title: string;
  content_md: string;
  session_id: string | null;
  status: 'draft' | 'approved';
  created_at?: string;
  approved_at?: string | null;
}

export interface MemPluginConfig {
  /** Worker base URL, e.g. http://localhost:3777 or https://mem.example.com */
  server_url: string;
  /** Per-user API key issued by Worker admin */
  api_key: string;
  /** Buffer size before raw flush (default 20) */
  raw_buffer_size?: number;
  /** Raw flush interval ms (default 10000) */
  raw_flush_interval_ms?: number;
  /** Watchdog: periodic health + replay (default 300000 = 5 min) */
  watchdog_interval_ms?: number;
  /** Per-request timeout for writes (default 15000) */
  write_timeout_ms?: number;
  /** Per-request timeout for reads (default 10000) */
  read_timeout_ms?: number;
  /** Tight timeout for profile fetch on chat startup (default 2000) */
  profile_fetch_timeout_ms?: number;
  /** Offline cache JSONL path (default ~/.config/opencode/mem/offline.jsonl) */
  offline_cache_path?: string;
  /** Offline cache size cap before rotation to .bak (default 10MB) */
  offline_cache_max_bytes?: number;
  /** Local cached profile path (default ~/.config/opencode/mem/profile.cache.md) */
  profile_cache_path?: string;
  /** In-memory profile cache TTL ms (default 60000 = 1 min). 0 disables. */
  profile_cache_ttl_ms?: number;
  /** In-memory hard-memories cache TTL ms (default 30000 = 30s). 0 disables. */
  memories_cache_ttl_ms?: number;
  /** Recent-focus lookback window in days (default 7). */
  focus_days?: number;
  /** Max chars for the injected profile section (default 1500). */
  profile_char_budget?: number;
  /** Max chars for the injected workspace-memory section (default 1600). */
  workspace_char_budget?: number;
  /** Max chars for the injected global hard-memory section (default 2000). */
  hard_char_budget?: number;
  /** Max chars for the injected recent-focus section (default 600). */
  focus_char_budget?: number;
  /**
   * Legacy total budget. When set it is split across the four layers using
   * the ratios above; per-layer values win when explicitly provided.
   */
  inject_char_budget?: number;
}
