import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MemPluginConfig } from './types/index.js';

const MEM_DIR = join(homedir(), '.config', 'opencode', 'mem');

export const DEFAULT_OFFLINE_CACHE = join(MEM_DIR, 'offline.jsonl');
export const DEFAULT_PROFILE_CACHE = join(MEM_DIR, 'profile.cache.md');

export function loadConfig(directory: string): MemPluginConfig | null {
  const candidates = [
    join(directory, '.opencode', 'mem', 'config.json'),
    join(directory, 'mem-config.json'),
    join(MEM_DIR, 'config.json'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf-8')) as MemPluginConfig;
      if (cfg.server_url && cfg.api_key) return cfg;
    } catch {
      continue;
    }
  }

  const envUrl = process.env.MEM_SERVER_URL;
  const envKey = process.env.MEM_API_KEY;
  if (envUrl && envKey) {
    return { server_url: envUrl, api_key: envKey };
  }
  return null;
}

export function fillDefaults(cfg: MemPluginConfig): Required<MemPluginConfig> {
  const total = cfg.inject_char_budget ?? 6000;
  // Split the legacy total budget across layers when per-layer values are absent:
  // profile 25%, workspace 27%, hard 33%, focus 10% (≈ 1500/1600/2000/600).
  return {
    server_url: cfg.server_url.replace(/\/$/, ''),
    api_key: cfg.api_key,
    raw_buffer_size: cfg.raw_buffer_size ?? 20,
    raw_flush_interval_ms: cfg.raw_flush_interval_ms ?? 10000,
    watchdog_interval_ms: cfg.watchdog_interval_ms ?? 5 * 60 * 1000,
    write_timeout_ms: cfg.write_timeout_ms ?? 15000,
    read_timeout_ms: cfg.read_timeout_ms ?? 10000,
    profile_fetch_timeout_ms: cfg.profile_fetch_timeout_ms ?? 2000,
    offline_cache_path: cfg.offline_cache_path ?? DEFAULT_OFFLINE_CACHE,
    offline_cache_max_bytes: cfg.offline_cache_max_bytes ?? 10 * 1024 * 1024,
    profile_cache_path: cfg.profile_cache_path ?? DEFAULT_PROFILE_CACHE,
    profile_cache_ttl_ms: cfg.profile_cache_ttl_ms ?? 60_000,
    memories_cache_ttl_ms: cfg.memories_cache_ttl_ms ?? 30_000,
    focus_days: cfg.focus_days ?? 7,
    inject_char_budget: total,
    profile_char_budget: cfg.profile_char_budget ?? Math.round(total * 0.25),
    workspace_char_budget: cfg.workspace_char_budget ?? Math.round(total * 0.27),
    hard_char_budget: cfg.hard_char_budget ?? Math.round(total * 0.33),
    focus_char_budget: cfg.focus_char_budget ?? Math.round(total * 0.1),
  };
}
