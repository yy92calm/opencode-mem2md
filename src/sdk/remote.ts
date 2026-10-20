import {
  appendFileSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { dirname } from 'path';
import type { RawConversation, HardMemory, RecentFocus, ContextBundle, MemPluginConfig, SkillDraft } from '../types/index.js';

/**
 * Worker HTTP client with:
 *  - in-memory batching of raw conversations (flushed by size or interval)
 *  - offline cache (JSONL append-log) when Worker is unreachable
 *  - automatic replay of offline cache when Worker comes back online
 *  - local profile cache so chat startup works when Worker is unreachable
 *  - background health/replay watchdog
 *  - shutdown hook to flush pending raws on SIGTERM/SIGINT
 *
 * No local Markdown / SQLite — Worker is the only source of truth.
 */

type LogFn = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/**
 * A "poison" entry is one the server rejects as permanently invalid (HTTP 4xx).
 * Such entries would never succeed on retry, so we drop them to avoid blocking
 * the rest of the offline cache. 5xx and network errors are retried.
 */
function isPoison(e: unknown): boolean {
  return /\b4\d{2}\b/.test(String(e));
}

export class WorkerClient {
  private rawBuffer: RawConversation[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private healthy = true;
  private lastHealthCheck = 0;
  private shuttingDown = false;
  private signalHandlers: { sig: NodeJS.Signals; fn: () => void }[] = [];

  // In-memory caches to avoid hitting the Worker on every chat turn.
  private profileCache: { value: string; at: number } | null = null;
  private memoriesCache: { value: HardMemory[]; at: number } | null = null;
  private contextCache: { value: ContextBundle; at: number; workspace: string | null } | null = null;

  constructor(
    private cfg: Required<MemPluginConfig>,
    private log: LogFn,
    options: { background?: boolean } = {},
  ) {
    if (options.background !== false) {
      this.startFlushTimer();
      this.startWatchdog();
      this.installShutdownHooks();
      this.replayOfflineCache().catch(e => this.log('warn', 'offline replay failed', { error: String(e) }));
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushRaw().catch(() => {});
    }, this.cfg.raw_flush_interval_ms);
    // Don't keep node alive just for this
    this.flushTimer.unref?.();
  }

  /**
   * Periodic watchdog: re-check health and replay offline cache.
   * Catches the case where network recovers mid-session
   * (no session.idle event would trigger replay otherwise).
   */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      this.replayOfflineCache().catch(() => {});
    }, this.cfg.watchdog_interval_ms);
    this.watchdogTimer.unref?.();
  }

  private installShutdownHooks(): void {
    const sigs: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    for (const sig of sigs) {
      const fn = () => {
        // Best-effort sync flush to offline cache so we never lose buffered raws.
        this.flushBufferToOfflineSync('shutdown');
      };
      this.signalHandlers.push({ sig, fn });
      try {
        process.on(sig, fn);
      } catch {
        /* ignore */
      }
    }
  }

  private flushBufferToOfflineSync(reason: string): void {
    if (this.rawBuffer.length === 0) return;
    const batch = this.rawBuffer.splice(0);
    try {
      this.appendOfflineCache(batch.map(r => ({ kind: 'raw', payload: r })));
      this.log('info', 'flushed buffer to offline cache', { count: batch.length, reason });
    } catch (e) {
      this.log('error', 'sync offline flush failed', { error: String(e) });
    }
  }

  /** Queue a raw conversation entry. Flushes when buffer hits threshold. */
  enqueueRaw(r: RawConversation): void {
    this.rawBuffer.push(r);
    if (this.rawBuffer.length >= this.cfg.raw_buffer_size) {
      this.flushRaw().catch(() => {});
    }
  }

  /** Force-flush raw buffer (call on session.idle). */
  async flushRaw(): Promise<void> {
    if (this.flushing || this.rawBuffer.length === 0) return;
    this.flushing = true;
    const batch = this.rawBuffer.splice(0);

    try {
      await this.post('/api/raw', { items: batch });
      this.healthy = true;
    } catch (e) {
      this.log('warn', 'raw flush failed, caching offline', { count: batch.length, error: String(e) });
      this.appendOfflineCache(batch.map(r => ({ kind: 'raw', payload: r })));
      this.healthy = false;
    } finally {
      this.flushing = false;
    }
  }

  /** Send a hard memory immediately (no batching — these are rare and high-value). */
  async sendHardMemory(
    m: HardMemory,
    opts: { scope?: 'global' | 'workspace'; workspace?: string | null } = {},
  ): Promise<{ id: number } | null> {
    const payload = {
      ...m,
      scope: opts.scope ?? 'global',
      workspace: opts.workspace ?? null,
    };
    try {
      const result = await this.post<{ id: number }>('/api/memory', payload);
      this.healthy = true;
      // New memory changes the list — invalidate the memories/context cache.
      this.memoriesCache = null;
      this.contextCache = null;
      return result;
    } catch (e) {
      this.log('warn', 'hard memory send failed, caching offline', { title: m.title, error: String(e) });
      this.appendOfflineCache([{ kind: 'memory', payload }]);
      this.healthy = false;
      return null;
    }
  }

  /**
   * One round-trip for per-turn injection: profile + workspace memories +
   * global hard memories + recent focus. Cached for memories_cache_ttl_ms
   * (keyed by workspace so a directory switch never serves stale context).
   */
  async getContextBundle(workspace: string | null, days = 7): Promise<ContextBundle | null> {
    const ttl = this.cfg.memories_cache_ttl_ms;
    if (ttl > 0 && this.contextCache && this.contextCache.workspace === workspace && Date.now() - this.contextCache.at < ttl) {
      return this.contextCache.value;
    }
    try {
      const qs = new URLSearchParams();
      if (workspace) qs.set('workspace', workspace);
      qs.set('days', String(days));
      const bundle = await this.get<ContextBundle>(`/api/workspace/context?${qs.toString()}`, this.cfg.profile_fetch_timeout_ms);
      if (bundle) {
        this.contextCache = { value: bundle, at: Date.now(), workspace };
        // Keep the legacy profile cache warm for offline fallback.
        if (bundle.profile) {
          this.writeProfileCache(bundle.profile);
          this.profileCache = { value: bundle.profile, at: Date.now() };
        }
        return bundle;
      }
    } catch (e) {
      this.log('debug', 'context bundle fetch failed', { error: String(e) });
    }
    return null;
  }

  /** Local fallback when the Worker is unreachable: profile only. */
  getCachedProfile(): string | null {
    return this.readProfileCache();
  }

  async getProfile(): Promise<string | null> {
    // In-memory cache first (avoids per-turn network round-trip).
    const ttl = this.cfg.profile_cache_ttl_ms;
    if (ttl > 0 && this.profileCache && Date.now() - this.profileCache.at < ttl) {
      return this.profileCache.value;
    }

    // Try network with a short timeout (won't block chat startup for long).
    try {
      const result = await this.get<{ content?: string; profile?: string | null }>(
        '/api/profile',
        this.cfg.profile_fetch_timeout_ms,
      );
      if (result) {
        const content = (result as any).content ?? null;
        if (content) {
          this.writeProfileCache(content);
          this.profileCache = { value: content, at: Date.now() };
          return content;
        }
      }
    } catch (e) {
      this.log('debug', 'profile fetch failed, falling back to local cache', { error: String(e) });
    }
    // Fallback to local cached profile (last known good).
    return this.readProfileCache();
  }

  private writeProfileCache(content: string): void {
    try {
      mkdirSync(dirname(this.cfg.profile_cache_path), { recursive: true });
      writeFileSync(this.cfg.profile_cache_path, content, 'utf-8');
    } catch (e) {
      this.log('warn', 'profile cache write failed', { error: String(e) });
    }
  }

  private readProfileCache(): string | null {
    try {
      if (!existsSync(this.cfg.profile_cache_path)) return null;
      return readFileSync(this.cfg.profile_cache_path, 'utf-8') || null;
    } catch {
      return null;
    }
  }

  async searchMemories(
    query: string,
    limit = 50,
    opts: { scope?: 'all' | 'global' | 'workspace'; workspace?: string | null } = {},
  ): Promise<HardMemory[]> {
    const qs = new URLSearchParams({ q: query, limit: String(limit) });
    if (opts.scope && opts.scope !== 'all') qs.set('scope', opts.scope);
    if (opts.workspace) qs.set('workspace', opts.workspace);
    const result = await this.get<{ items: HardMemory[] }>(`/api/memory/search?${qs.toString()}`);
    return result?.items ?? [];
  }

  /** Recent focus topics for a workspace (null → all workspaces). */
  async listFocus(workspace: string | null, days = 7, limit = 8): Promise<RecentFocus[]> {
    const qs = new URLSearchParams({ days: String(days), limit: String(limit) });
    if (workspace) qs.set('workspace', workspace);
    const result = await this.get<{ items: RecentFocus[] }>(`/api/workspace/focus?${qs.toString()}`);
    return result?.items ?? [];
  }

  /** Workspace-scoped memories for one directory. */
  async listWorkspaceMemories(workspace: string, limit = 50): Promise<HardMemory[]> {
    const qs = new URLSearchParams({ workspace, limit: String(limit) });
    const result = await this.get<{ items: HardMemory[] }>(`/api/workspace/memory?${qs.toString()}`);
    return result?.items ?? [];
  }

  async listMemories(limit = 100): Promise<HardMemory[]> {
    const ttl = this.cfg.memories_cache_ttl_ms;
    if (ttl > 0 && this.memoriesCache && Date.now() - this.memoriesCache.at < ttl) {
      return this.memoriesCache.value;
    }
    try {
      const result = await this.get<{ items: HardMemory[] }>(`/api/memory?limit=${limit}`);
      const items = result?.items ?? [];
      this.memoriesCache = { value: items, at: Date.now() };
      return items;
    } catch (e) {
      if (this.memoriesCache) {
        this.log('warn', 'memory list request failed, using cached results', { error: String(e) });
        return this.memoriesCache.value;
      }
      throw e;
    }
  }

  async checkHealth(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && now - this.lastHealthCheck < 60000) return this.healthy;
    this.lastHealthCheck = now;
    try {
      const r = await fetch(`${this.cfg.server_url}/health`, { signal: AbortSignal.timeout(5000) });
      this.healthy = r.ok;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  async listSkillDrafts(status?: 'draft' | 'approved'): Promise<SkillDraft[]> {
    const qs = status ? `?status=${status}` : '';
    const result = await this.get<{ items: SkillDraft[] }>(`/api/skills/drafts${qs}`);
    return result?.items ?? [];
  }

  /** Explicit human approval — throws on 404/already-approved. */
  async approveSkillDraft(id: number): Promise<SkillDraft | null> {
    try {
      return await this.post<SkillDraft>(`/api/skills/drafts/${id}/approve`, {});
    } catch (e) {
      this.log('warn', 'skill draft approve failed', { id, error: String(e) });
      return null;
    }
  }

  /** Drain offline cache by retrying every entry. Called on init + periodic. */
  async replayOfflineCache(): Promise<number> {
    const path = this.cfg.offline_cache_path;
    if (!existsSync(path)) return 0;

    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 0) return 0;

    const healthy = await this.checkHealth(true);
    if (!healthy) return 0;

    // Parse entries, keep original line so failures can be re-written verbatim.
    const entries: { kind: string; payload: any; line: string }[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.kind === 'raw' || entry.kind === 'memory') {
          entries.push({ kind: entry.kind, payload: entry.payload, line });
        }
      } catch {
        // drop unparseable lines
      }
    }

    const failed: string[] = [];
    let replayed = 0;
    let dropped = 0;

    // Raw entries: try as one batch first. On failure, fall back to one-by-one
    // so a single poison entry (server 4xx) doesn't block the rest forever.
    const rawEntries = entries.filter(e => e.kind === 'raw');
    if (rawEntries.length > 0) {
      try {
        await this.post('/api/raw', { items: rawEntries.map(e => e.payload) });
        replayed += rawEntries.length;
      } catch (e) {
        this.log('warn', 'offline raw batch failed, retrying one-by-one', {
          count: rawEntries.length, error: String(e),
        });
        for (const entry of rawEntries) {
          try {
            await this.post('/api/raw', { items: [entry.payload] });
            replayed += 1;
          } catch (e2) {
            if (isPoison(e2)) {
              dropped += 1;
              this.log('warn', 'offline raw item dropped (server rejected)', { error: String(e2) });
            } else {
              failed.push(entry.line);
              this.healthy = false;
            }
          }
        }
      }
    }

    // Memories go up one-by-one so a single bad entry doesn't block the rest.
    for (const entry of entries.filter(e => e.kind === 'memory')) {
      try {
        await this.post('/api/memory', entry.payload);
        replayed += 1;
      } catch (e) {
        if (isPoison(e)) {
          dropped += 1;
          this.log('warn', 'offline memory dropped (server rejected)', {
            title: entry.payload?.title, error: String(e),
          });
        } else {
          failed.push(entry.line);
          this.healthy = false;
        }
      }
    }

    // Rewrite cache with only the entries that didn't make it.
    if (failed.length > 0) {
      writeFileSync(path, failed.join('\n') + '\n');
      this.log('warn', 'offline replay partial failure', { replayed, remaining: failed.length, dropped });
    } else {
      writeFileSync(path, '');
      this.log('info', 'offline replay ok', { replayed, dropped });
    }
    return replayed;
  }

  private appendOfflineCache(entries: { kind: string; payload: any }[]): void {
    const path = this.cfg.offline_cache_path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      this.rotateOfflineCacheIfNeeded(path);
      const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(path, lines);
    } catch (e) {
      this.log('error', 'offline cache write failed', { error: String(e) });
    }
  }

  /**
   * If cache exceeds max size, rotate it to .bak (overwriting any prior .bak).
   * Keeps at most one archive — if user is offline long enough to fill 2x cap,
   * the oldest data drops on the floor (acceptable tradeoff vs unbounded growth).
   */
  private rotateOfflineCacheIfNeeded(path: string): void {
    try {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size < this.cfg.offline_cache_max_bytes) return;
      const bak = `${path}.bak`;
      if (existsSync(bak)) {
        try { unlinkSync(bak); } catch { /* ignore */ }
      }
      renameSync(path, bak);
      this.log('warn', 'offline cache rotated (size cap hit)', { bytes: size, archive: bak });
    } catch (e) {
      this.log('warn', 'offline cache rotation failed', { error: String(e) });
    }
  }

  private async post<T = unknown>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const resp = await fetch(`${this.cfg.server_url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.cfg.api_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? this.cfg.write_timeout_ms),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json() as Promise<T>;
  }

  private async get<T = unknown>(path: string, timeoutMs?: number): Promise<T> {
    const resp = await fetch(`${this.cfg.server_url}${path}`, {
      headers: { 'Authorization': `Bearer ${this.cfg.api_key}` },
      signal: AbortSignal.timeout(timeoutMs ?? this.cfg.read_timeout_ms),
    });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text().catch(() => '')}`);
    return resp.json() as Promise<T>;
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.flushTimer = null;
    this.watchdogTimer = null;
    // Final sync flush so explicit shutdown also persists the buffer.
    this.flushBufferToOfflineSync('explicit-shutdown');
    for (const { sig, fn } of this.signalHandlers) {
      try { process.off(sig, fn); } catch { /* ignore */ }
    }
    this.signalHandlers = [];
  }
}
