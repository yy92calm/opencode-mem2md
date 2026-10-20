/**
 * opencode-mem plugin — OpenCode V2 plugin API (verified against 2.0.32).
 *
 * V1 → V2 mapping used here:
 *   `tool.execute.after`                 → ctx.tool.hook("execute.after")
 *   user prompt capture (message.updated)→ ctx.session.hook("prompt")
 *   `experimental.chat.system.transform` → ctx.session.hook("context"), push SystemPart
 *   `tool` map (zod + tool())            → ctx.tool.transform(editor.add(...)), JSON Schema
 *   `event` session.idle                 → ctx.event.subscribe()
 *   `dispose`                            → cleanup function returned by setup()
 */
import { Plugin } from '@opencode/plugin';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WorkerClient } from './sdk/remote.js';
import { fillDefaults, loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { isTrivial, safeStringify, toolContentToString } from './utils/observer.js';
import type { HardMemory } from './types/index.js';

const SERVICE = 'opencode-mem';

/** Format a workspace path for display: last two segments, home collapsed. */
function shortWorkspace(workspace: string): string {
  const home = homedir();
  const rel = workspace.startsWith(home) ? `~${workspace.slice(home.length)}` : workspace;
  const parts = rel.split('/').filter(Boolean);
  return parts.length <= 2 ? rel : `…/${parts.slice(-2).join('/')}`;
}

/** Cut a section to a char budget on a line boundary. */
function clampSection(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf('\n');
  const body = lastNewline > budget * 0.6 ? cut.slice(0, lastNewline) : cut;
  return `${body}\n(truncated)`;
}

interface MemoryLike {
  id?: number;
  type: string;
  title: string;
  content: string;
  source?: string;
  priority?: string;
  timestamp?: string;
  workspace?: string;
  usage_count?: number;
}

/**
 * Rank memories for injection: manual > auto-promoted > auto, then priority,
 * then recency. Workspace hits are already local, so they skip the source rank.
 */
function rankMemories<T extends MemoryLike>(memories: T[]): T[] {
  const sourceRank: Record<string, number> = { manual: 0, 'auto-promoted': 1, auto: 2 };
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  // Recall count dominates: memories that actually get used should outrank
  // equally-worded entries that were never touched.
  return [...memories].sort(
    (a, b) =>
      (sourceRank[a.source ?? 'manual'] ?? 0) - (sourceRank[b.source ?? 'manual'] ?? 0) ||
      (b.usage_count ?? 0) - (a.usage_count ?? 0) ||
      (priorityRank[a.priority ?? 'high'] ?? 0) - (priorityRank[b.priority ?? 'high'] ?? 0) ||
      (b.timestamp || '').localeCompare(a.timestamp || ''),
  );
}

/** Build a budgeted bullet list, reporting how many items were omitted and which fit. */
function memorySection<T extends MemoryLike>(
  memories: T[],
  budget: number,
): { text: string; omitted: number; injected: T[] } {
  const lines: string[] = [];
  const injected: T[] = [];
  let used = 0;
  let omitted = 0;
  for (const memory of memories) {
    const line = `- [${memory.type}] ${memory.title}: ${memory.content.slice(0, 300)}`;
    if (used + line.length > budget) {
      omitted++;
      continue;
    }
    lines.push(line);
    injected.push(memory);
    used += line.length;
  }
  return { text: lines.join('\n'), omitted, injected };
}

export default Plugin.define({
  id: 'opencode-mem',

  async setup(ctx) {
    const rawCfg = loadConfig(ctx.location.directory);
    if (!rawCfg) {
      logger.warn(
        SERVICE,
        'No memory config found. Skipping. Set MEM_SERVER_URL + MEM_API_KEY env, or create .opencode/mem/config.json',
      );
      return;
    }

    const cfg = fillDefaults(rawCfg);
    // OpenCode binds a plugin instance to a directory; that is the workspace
    // identity used to isolate project-scoped memories.
    const workspace = ctx.location.directory;
    const worker = new WorkerClient(cfg, (level, msg, extra) => {
      switch (level) {
        case 'debug':
          logger.debug(SERVICE, msg, extra);
          break;
        case 'info':
          logger.info(SERVICE, msg, extra);
          break;
        case 'warn':
          logger.warn(SERVICE, msg, extra);
          break;
        case 'error':
          logger.error(SERVICE, msg, extra);
          break;
        case 'fatal':
          logger.fatal(SERVICE, msg, extra);
          break;
        default:
          logger.info(SERVICE, msg, extra);
      }
    });

    const healthy = await worker.checkHealth(true);
    logger.info(SERVICE, 'MemPlugin initialized', {
      server: cfg.server_url,
      healthy,
      offline_cache: cfg.offline_cache_path,
    });

    // --- Memory tools (V2: synchronous transform + JSON Schema + {content} result) ---
    await ctx.tool.transform((editor) => {
      // "remember X" — called by the mem-remember skill.
      editor.add({
        name: 'mem_capture',
        description: 'Persist a hard memory (user explicitly asked to remember something)',
        input: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['preference', 'config', 'decision', 'error', 'discovery', 'fact', 'constraint', 'pattern'],
              description: 'Memory type',
            },
            title: { type: 'string', description: 'Short title summarizing the memory' },
            content: { type: 'string', description: 'Full description' },
            facts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Key facts (2-5 bullet points)',
            },
            concepts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Related concept tags',
            },
            priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Defaults to high' },
            scope: {
              type: 'string',
              enum: ['global', 'workspace'],
              description: 'global = applies everywhere (default); workspace = only this directory/project',
            },
          },
          required: ['type', 'title', 'content'],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as {
            type: HardMemory['type'];
            title: string;
            content: string;
            facts?: string[];
            concepts?: string[];
            priority?: 'high' | 'medium' | 'low';
            scope?: 'global' | 'workspace';
          };
          const memory: HardMemory = {
            type: args.type,
            title: args.title,
            content: args.content,
            facts: args.facts ?? [],
            concepts: args.concepts ?? [],
            source: 'manual',
            priority: args.priority ?? 'high',
            session_id: context.sessionID,
            timestamp: new Date().toISOString(),
          };
          const scope = args.scope ?? 'global';
          const scopeLabel = scope === 'workspace' ? ` (workspace: ${shortWorkspace(workspace)})` : '';
          const result = await worker.sendHardMemory(memory, {
            scope,
            workspace: scope === 'workspace' ? workspace : null,
          });
          return {
            content: result
              ? `✓ Remembered${scopeLabel}: ${args.title} (id=${result.id})`
              : `⚠ Cached offline${scopeLabel} (worker unreachable): ${args.title}`,
          };
        },
      });

      editor.add({
        name: 'mem_search',
        description: 'Search memories by keyword. scope=all (default) searches global + current workspace; workspace searches only this directory.',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default 50)' },
            scope: { type: 'string', enum: ['all', 'global', 'workspace'], description: 'Search scope (default all)' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { query: string; limit?: number; scope?: 'all' | 'global' | 'workspace' };
          const scope = args.scope ?? 'all';
          const items = await worker.searchMemories(args.query, args.limit ?? 50, {
            scope,
            workspace: scope === 'global' ? null : workspace,
          });
          if (items.length === 0) return { content: `No memories matched "${args.query}".` };
          return {
            content: items
              .map((memory) => {
                const tag = memory.workspace ? ` [ws:${shortWorkspace(memory.workspace)}]` : '';
                return `- [${memory.type}]${tag} ${memory.title}\n  ${memory.content.slice(0, 200)}`;
              })
              .join('\n'),
          };
        },
      });

      editor.add({
        name: 'mem_focus',
        description: 'Show what you have been focusing on recently (rolling topic window), optionally for this workspace only',
        input: {
          type: 'object',
          properties: {
            days: { type: 'number', description: 'Lookback window in days (default 7)' },
            limit: { type: 'number', description: 'Max topics (default 10)' },
            all_workspaces: { type: 'boolean', description: 'Include topics from other workspaces (default false)' },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { days?: number; limit?: number; all_workspaces?: boolean };
          const ws = args.all_workspaces ? null : workspace;
          const items = await worker.listFocus(ws, args.days ?? 7, args.limit ?? 10);
          if (items.length === 0) return { content: 'No recent focus topics yet.' };
          return {
            content: items
              .map((f) => {
                const where = f.workspace ? ` (${shortWorkspace(f.workspace)})` : ' (global)';
                return `- ${f.topic}${where} — last seen ${f.last_seen}${f.weight > 1 ? `, ×${Math.round(f.weight)}` : ''}`;
              })
              .join('\n'),
          };
        },
      });

      editor.add({
        name: 'mem_list',
        description: 'List recent hard memories',
        input: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (default 50)' },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { limit?: number };
          const items = await worker.listMemories(args.limit ?? 50);
          return {
            content: items.length === 0 ? 'No memories yet.' : items.map((memory) => `- [${memory.type}] ${memory.title}`).join('\n'),
          };
        },
      });

      editor.add({
        name: 'mem_profile',
        description: 'Fetch the latest auto-generated user profile from the Worker',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const profile = await worker.getProfile();
          return {
            content: profile ?? 'No profile yet. Worker will generate one after enough activity.',
          };
        },
      });

      editor.add({
        name: 'mem_health',
        description: 'Check Worker connectivity and replay offline cache if available',
        input: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          const isHealthy = await worker.checkHealth(true);
          const replayed = isHealthy ? await worker.replayOfflineCache() : 0;
          return {
            content: JSON.stringify(
              { server_url: cfg.server_url, healthy: isHealthy, offline_cache_replayed: replayed },
              null,
              2,
            ),
          };
        },
      });

      // Sync approved skill drafts from the Worker into ~/.config/opencode/skills/.
      // Drafts are auto-distilled weekly; nothing lands on disk without the
      // user approving them server-side first.
      editor.add({
        name: 'mem_skill_sync',
        description: 'List Worker skill drafts, optionally approve them and install approved ones into ~/.config/opencode/skills/',
        input: {
          type: 'object',
          properties: {
            approve: {
              type: 'array',
              items: { type: 'number' },
              description: 'Draft ids to approve before syncing',
            },
            install: { type: 'boolean', description: 'Write approved drafts to ~/.config/opencode/skills/ (default true)' },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { approve?: number[]; install?: boolean };
          for (const id of args.approve ?? []) {
            const approved = await worker.approveSkillDraft(id);
            if (!approved) throw new Error(`Could not approve skill draft ${id}`);
          }

          const drafts = await worker.listSkillDrafts('approved');
          const install = args.install ?? true;
          if (!install) {
            return {
              content:
                drafts.length === 0
                  ? 'No approved skill drafts.'
                  : drafts.map((draft) => `- #${draft.id} ${draft.title}`).join('\n'),
            };
          }
          if (drafts.length === 0) return { content: 'No approved skill drafts to install.' };

          const skillsDir = join(homedir(), '.config', 'opencode', 'skills');
          const installed: string[] = [];
          const skipped: string[] = [];
          for (const draft of drafts) {
            const slug =
              draft.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 60) || `skill-${draft.id}`;
            const dir = join(skillsDir, slug);
            const file = join(dir, 'SKILL.md');
            // Never clobber an existing skill — human edits win over drafts.
            if (existsSync(file)) {
              skipped.push(slug);
              continue;
            }
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(file, draft.content_md, 'utf-8');
              installed.push(slug);
            } catch (error) {
              logger.warn(SERVICE, 'skill write failed', { slug, error: String(error) });
              skipped.push(slug);
            }
          }
          return { content: JSON.stringify({ installed, skipped_existing: skipped }, null, 2) };
        },
      });
    });

    // --- Capture tool executions as raw conversation entries ---
    await ctx.tool.hook('execute.after', (event) => {
      if (event.status !== 'completed') return;
      const toolName = event.tool;
      const toolResult = toolContentToString(event.result?.content);
      if (isTrivial(toolName, event.input, toolResult)) return;
      worker.enqueueRaw({
        session_id: event.sessionID || 'unknown',
        workspace,
        role: 'tool',
        content: '',
        tool_name: toolName,
        tool_input: safeStringify(event.input),
        tool_output: safeStringify(toolResult, 6000),
        timestamp: new Date().toISOString(),
      });
    });

    // --- Capture user prompts as raw conversations ---
    // (V1 used the message.updated event; V2's prompt hook is the direct equivalent.)
    await ctx.session.hook('prompt', (event) => {
      const text = safeStringify(event.prompt.text, 4000);
      if (!text) return;
      worker.enqueueRaw({
        session_id: event.sessionID,
        workspace,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      });
    });

    // --- Inject four layers into the system prompt ---
    // (V1: experimental.chat.system.transform; V2: session "context" hook.)
    //
    // Order matters: workspace memory is the most specific and goes first,
    // then global hard memories, then the rolling focus window, then profile.
    // Each layer has its own char budget so one large layer cannot starve the
    // others; anything omitted is still reachable via mem_search.
    await ctx.session.hook('context', async (event) => {
      // Hot path: never let Worker unavailability break a model request.
      let bundle = null as Awaited<ReturnType<typeof worker.getContextBundle>>;
      try {
        bundle = await worker.getContextBundle(workspace, cfg.focus_days);
      } catch (error) {
        logger.debug(SERVICE, 'context injection fetch failed, skipping', { error: String(error) });
      }

      const parts: string[] = [];
      const injectedHardIds: number[] = [];
      const injectedWorkspaceIds: number[] = [];

      // 1. Workspace memories (this directory only)
      if (bundle?.workspace_memories?.length) {
        const section = memorySection(rankMemories(bundle.workspace_memories), cfg.workspace_char_budget);
        if (section.text) {
          const hint = section.omitted > 0 ? `\n(${section.omitted} more workspace memories omitted — use mem_search scope=workspace)` : '';
          parts.push(
            `\n\n## Workspace Memory (${shortWorkspace(workspace)})\n\n${clampSection(section.text, cfg.workspace_char_budget)}${hint}`,
          );
          injectedWorkspaceIds.push(...section.injected.map(m => m.id).filter((id): id is number => typeof id === 'number'));
        }
      }

      // 2. Global hard memories (user-asserted + auto-distilled)
      if (bundle?.hard_memories?.length) {
        const section = memorySection(rankMemories(bundle.hard_memories), cfg.hard_char_budget);
        if (section.text) {
          const hint = section.omitted > 0 ? `\n(${section.omitted} more memories omitted — use mem_search to recall them)` : '';
          parts.push(
            `\n\n## Hard Memories (user-asserted + auto-distilled)\n\n${clampSection(section.text, cfg.hard_char_budget)}${hint}`,
          );
          injectedHardIds.push(...section.injected.map(m => m.id).filter((id): id is number => typeof id === 'number'));
        }
      }

      // 3. Recent focus (rolling window)
      if (bundle?.focus?.length) {
        const lines: string[] = [];
        let used = 0;
        for (const f of bundle.focus) {
          const line = `- ${f.topic}${f.workspace ? ` (${shortWorkspace(f.workspace)})` : ''}`;
          if (used + line.length > cfg.focus_char_budget) break;
          lines.push(line);
          used += line.length;
        }
        if (lines.length > 0) {
          parts.push(`\n\n## Recent Focus (last ${cfg.focus_days}d)\n\n${lines.join('\n')}`);
        }
      }

      // 4. Profile
      const profile = bundle?.profile ?? worker.getCachedProfile();
      if (profile) {
        parts.push(`\n\n## User Profile (auto-maintained)\n\n${clampSection(profile, cfg.profile_char_budget)}`);
      }

      if (parts.length > 0) {
        event.system.push({ type: 'text', text: parts.join('\n') });
      }

      // Report actual injection for recall accounting (fire-and-forget).
      if (injectedHardIds.length > 0 || injectedWorkspaceIds.length > 0) {
        void worker.touchMemories(injectedHardIds, injectedWorkspaceIds);
      }
    });

    // --- Flush + replay on session idle ---
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.idle') {
            try {
              await worker.flushRaw();
              await worker.replayOfflineCache();
            } catch (error) {
              logger.warn(SERVICE, 'idle flush failed', { error: String(error) });
            }
          }
        }
      } catch {
        // stream aborted during unload — ignore
      }
    })();

    return () => {
      controller.abort();
      worker.shutdown();
    };
  },
});
