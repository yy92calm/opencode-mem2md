import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import cron from 'node-cron';
import type { ServerConfig } from '../types/index.js';

const DEFAULT_CONFIG_PATH = process.env.CONFIG_PATH || './config.yaml';

function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`Missing required env var: ${name}`);
    }
    return v;
  });
}

function deepExpand(obj: any): any {
  if (typeof obj === 'string') return expandEnv(obj);
  if (Array.isArray(obj)) return obj.map(deepExpand);
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = deepExpand(v);
    return result;
  }
  return obj;
}

/**
 * Validate llm.extra_body: an optional mapping of provider-specific request
 * fields. Fields the client owns are rejected so a typo in config cannot
 * silently break the request shape.
 */
function parseExtraBody(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('Config: llm.extra_body must be a mapping of field name to value');
  }
  const RESERVED = ['model', 'messages', 'stream'];
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (RESERVED.includes(k)) throw new Error(`Config: llm.extra_body may not override "${k}"`);
    out[k] = val;
  }
  return out;
}

/**
 * Normalize the configured memory language. Accepts common aliases and falls
 * back to the default (Simplified Chinese) when unset or malformed.
 */
function normalizeLanguage(v: unknown): string {
  const DEFAULT = 'zh-CN';
  if (v === undefined || v === null || v === '') return DEFAULT;
  if (typeof v !== 'string') throw new Error('Config: memory_language must be a string (e.g. "zh-CN")');
  const code = v.trim();

  // Friendly aliases first, then strict BCP-47 validation.
  const aliases: Record<string, string> = {
    zh: 'zh-CN', 'zh-hans': 'zh-CN', 'zh-cn': 'zh-CN', cn: 'zh-CN', chinese: 'zh-CN',
    'zh-hant': 'zh-TW', 'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW',
    en: 'en', 'en-us': 'en', 'en-gb': 'en', english: 'en',
    ja: 'ja', jp: 'ja', japanese: 'ja',
    ko: 'ko', kr: 'ko', korean: 'ko',
  };
  const alias = aliases[code.toLowerCase()];
  if (alias) return alias;

  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) {
    throw new Error(`Config: invalid memory_language "${code}" (use a BCP-47 code like "zh-CN" or "en")`);
  }
  return code;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): ServerConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Copy config.example.yaml to config.yaml first.`);
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  const expanded = deepExpand(parsed);

  // Validate required fields
  if (!expanded.llm?.api_key) throw new Error('Config: llm.api_key is required');
  if (!expanded.llm?.model) throw new Error('Config: llm.model is required');
  if (!Array.isArray(expanded.users) || expanded.users.length === 0) {
    throw new Error('Config: at least one user binding is required');
  }
  for (const u of expanded.users) {
    if (!u?.user_id || typeof u.user_id !== 'string') {
      throw new Error('Config: each user binding requires a non-empty user_id');
    }
    if (!u?.api_key || typeof u.api_key !== 'string') {
      throw new Error(`Config: user "${u?.user_id ?? '?'}" requires a non-empty api_key`);
    }
  }
  // Duplicate user_id / api_key detection
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const u of expanded.users) {
    if (seenIds.has(u.user_id)) throw new Error(`Config: duplicate user_id "${u.user_id}"`);
    if (seenKeys.has(u.api_key)) throw new Error(`Config: duplicate api_key for user "${u.user_id}"`);
    seenIds.add(u.user_id);
    seenKeys.add(u.api_key);
  }

  const port = expanded.port ?? 3777;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Config: port must be an integer in [1,65535], got ${port}`);
  }

  const dailyExpr = expanded.cron?.daily_summary ?? '0 3 * * *';
  const weeklyExpr = expanded.cron?.weekly_profile ?? '0 3 * * 0';
  if (!cron.validate(dailyExpr)) {
    throw new Error(`Config: invalid cron expression for daily_summary: "${dailyExpr}"`);
  }
  if (!cron.validate(weeklyExpr)) {
    throw new Error(`Config: invalid cron expression for weekly_profile: "${weeklyExpr}"`);
  }

  // Timezone for daily-summary date math + SQLite localtime() bucketing.
  // Defaults to the host's system tz. Validate IANA names so a typo fails fast
  // instead of silently bucketing everything under UTC.
  const tz = expanded.tz ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  try {
    // Resolving a tz throws on invalid names; cheap validation.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new Error(`Config: invalid tz "${tz}" (use an IANA name e.g. "Asia/Shanghai")`);
  }

  return {
    port,
    db_path: expanded.db_path ?? './data/memory.db',
    tz,
    // Language for generated memory content. Defaults to Simplified Chinese;
    // anything BCP-47-ish is accepted and rendered verbatim in the prompt.
    memory_language: normalizeLanguage(expanded.memory_language),
    llm: {
      provider: expanded.llm.provider ?? 'openai-compatible',
      base_url: expanded.llm.base_url ?? 'https://api.openai.com/v1',
      api_key: expanded.llm.api_key,
      model: expanded.llm.model,
      timeout_ms: expanded.llm.timeout_ms ?? 60000,
      max_retries: expanded.llm.max_retries ?? 3,
      extra_body: parseExtraBody(expanded.llm.extra_body),
    },
    users: expanded.users,
    cron: {
      daily_summary: dailyExpr,
      weekly_profile: weeklyExpr,
      hard_memory_threshold: expanded.cron?.hard_memory_threshold ?? 10,
      auto_distill: expanded.cron?.auto_distill ?? true,
      skill_min_raw_count: expanded.cron?.skill_min_raw_count ?? 30,
    },
  };
}

// Singleton for runtime use
let _config: ServerConfig | null = null;

export function getConfig(): ServerConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
