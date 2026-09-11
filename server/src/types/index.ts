/**
 * Core types shared across the Worker
 */

export interface RawConversation {
  id?: number;
  user_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string | null;
  tool_input?: string | null;
  tool_output?: string | null;
  timestamp: string;
}

export interface HardMemory {
  id?: number;
  user_id: string;
  type: 'preference' | 'config' | 'decision' | 'error' | 'discovery' | 'fact' | 'constraint' | 'pattern';
  title: string;
  content: string;
  facts: string[];
  concepts: string[];
  /** manual = user "记住X"; auto = cron-distilled from raw conversations */
  source: 'manual' | 'auto-promoted' | 'auto';
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'deprecated';
  usage_count: number;
  last_used_at: string | null;
  /** Distill provenance: calendar day the source raws belonged to */
  source_date: string | null;
  session_id?: string | null;
  timestamp: string;
}

export interface DailySummary {
  id?: number;
  user_id: string;
  date: string;            // YYYY-MM-DD
  content: string;         // LLM-generated daily synthesis
  raw_count: number;
  generated_at: string;
}

export interface UserProfile {
  user_id: string;
  content: string;
  version: number;
  generated_at: string;
  source_raw_count: number;
  source_memory_count: number;
}

export interface SkillDraft {
  id?: number;
  user_id: string;
  title: string;
  content_md: string;
  session_id: string | null;
  status: 'draft' | 'approved';
  created_at?: string;
  approved_at?: string | null;
}

export interface LLMConfig {
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
  max_retries: number;
  /**
   * Provider-specific fields merged into every request body. Reasoning models
   * waste latency and output tokens on summarization/distillation; e.g. Qwen
   * accepts `{ enable_thinking: false }`, which measured ~5x fewer completion
   * tokens and ~30% lower latency on this workload.
   */
  extra_body?: Record<string, unknown>;
}

export interface UserBinding {
  user_id: string;
  api_key: string;
}

export interface CronConfig {
  daily_summary: string;
  weekly_profile: string;
  hard_memory_threshold: number;
  /** Auto-distill raw conversations into atom memories during daily summary */
  auto_distill: boolean;
  /** Min raw rows for a session to be considered for skill extraction */
  skill_min_raw_count: number;
}

export interface ServerConfig {
  port: number;
  db_path: string;
  /**
   * IANA timezone (e.g. "Asia/Shanghai", "UTC"). Used for daily-summary date
   * math and SQLite localtime() so raw timestamps are bucketed into the
   * calendar day the user actually experienced. Default: host tz.
   */
  tz: string;
  llm: LLMConfig;
  users: UserBinding[];
  cron: CronConfig;
}
