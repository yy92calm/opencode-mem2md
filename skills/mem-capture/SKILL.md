---
name: mem_capture
description: Persist a hard or workspace-scoped memory to the centralized opencode-mem-worker
---

# mem_capture Skill

Wraps the `mem_capture` plugin tool. Use this when you need to deliberately
store a fact, preference, decision, or rule that should survive across sessions.

## When to use

- User says "记住 / remember / save this / 别忘了"
- You discover a project-wide config, build tool, or framework choice
- An error has a known fix worth preserving
- An explicit decision is made (e.g. "we use Postgres, not MySQL")

## Where it goes (scope)

| scope | Store | Injected |
|---|---|---|
| `global` (default) | `hard_memories` | every workspace |
| `workspace` | `workspace_memories` | only the current directory |

Use `scope: workspace` for facts that only hold for this repo/project:
scripts, ports, file layout, deployment target, local conventions, repo quirks.
Use `global` for personal preferences, machine setup, and cross-project rules.

## How to call

```yaml
tool: mem_capture
args:
  type: preference | config | decision | error | discovery | fact | constraint | pattern
  title: short semantic title (not "Read: file.ts")
  content: 1-3 sentence explanation
  facts: [2-5 short bullet strings]
  concepts: [tag1, tag2]
  priority: high | medium | low
  scope: global | workspace      # default global
```

Workspace memories are keyed by absolute path, so the same title in another
project does not collide. Re-asserting an existing title refreshes it instead
of duplicating.

## Language

Write `title`, `content`, and `facts` in the user's language. Default to
**简体中文** unless the user writes in another language or explicitly asks for
one. Keep code, commands, paths, and product names verbatim.

## Notes

- All memories belong to the authenticated user (`user_id` derived from API key).
- Returns the memory id (and scope), or a warning if cached offline.