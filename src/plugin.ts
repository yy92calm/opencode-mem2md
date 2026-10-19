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
          const result = await worker.sendHardMemory(memory);
          return {
            content: result
              ? `✓ Remembered: ${args.title} (id=${result.id})`
              : `⚠ Cached offline (worker unreachable): ${args.title}`,
          };
        },
      });

      editor.add({
        name: 'mem_search',
        description: 'Search hard memories by keyword (full-text)',
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default 50)' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { query: string; limit?: number };
          const items = await worker.searchMemories(args.query, args.limit ?? 50);
          return {
            content:
              items.length === 0
                ? `No memories matched "${args.query}".`
                : items
                    .map((memory) => `- [${memory.type}] ${memory.title}\n  ${memory.content.slice(0, 200)}`)
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
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      });
    });

    // --- Inject profile + memories into the system prompt ---
    // (V1: experimental.chat.system.transform; V2: session "context" hook.)
    // Memories are budgeted, not bulk-injected: ranked by source (manual first)
    // then priority then recency, cut when the char budget is exhausted.
    // The rest stays reachable on-demand via mem_search.
    await ctx.session.hook('context', async (event) => {
      // Hot path: never let Worker unavailability break a model request.
      let profile: string | null = null;
      let memories: HardMemory[] = [];
      try {
        [profile, memories] = await Promise.all([worker.getProfile(), worker.listMemories(50)]);
      } catch (error) {
        logger.debug(SERVICE, 'context injection fetch failed, skipping', { error: String(error) });
      }
      const parts: string[] = [];
      if (profile) {
        parts.push(`\n\n## User Profile (auto-maintained)\n\n${profile}`);
      }
      if (memories.length > 0) {
        const sourceRank = { manual: 0, 'auto-promoted': 1, auto: 2 } as Record<string, number>;
        const priorityRank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
        const ranked = [...memories].sort(
          (a, b) =>
            (sourceRank[a.source ?? 'manual'] ?? 0) - (sourceRank[b.source ?? 'manual'] ?? 0) ||
            (priorityRank[a.priority ?? 'high'] ?? 0) - (priorityRank[b.priority ?? 'high'] ?? 0) ||
            (b.timestamp || '').localeCompare(a.timestamp || ''),
        );

        const lines: string[] = [];
        let used = 0;
        let omitted = 0;
        for (const memory of ranked) {
          const line = `- [${memory.type}] ${memory.title}: ${memory.content.slice(0, 300)}`;
          if (used + line.length > cfg.inject_char_budget) {
            omitted++;
            continue;
          }
          lines.push(line);
          used += line.length;
        }
        if (lines.length > 0) {
          const hint = omitted > 0 ? `\n(${omitted} more memories omitted — use mem_search to recall them)` : '';
          parts.push(`\n\n## Hard Memories (user-asserted + auto-distilled)\n\n${lines.join('\n')}${hint}`);
        }
      }
      if (parts.length > 0) {
        event.system.push({ type: 'text', text: parts.join('\n') });
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
