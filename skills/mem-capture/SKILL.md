---
name: mem_capture
description: Persist a hard memory to the centralized opencode-mem-worker
---

# mem_capture Skill

Wraps the `mem_capture` plugin tool. Use this when you need to deliberately
store a fact, preference, decision, or rule that should survive across sessions.

## When to use

- User says "记住 / remember / save this / 别忘了"
- You discover a project-wide config, build tool, or framework choice
- An error has a known fix worth preserving
- An explicit decision is made (e.g. "we use Postgres, not MySQL")

## How to call

```yaml
tool: mem_capture
args:
  type: preference | config | decision | error | discovery | fact
  title: short semantic title (not "Read: file.ts")
  content: 1-3 sentence explanation
  facts: [2-5 short bullet strings]
  concepts: [tag1, tag2]
  priority: high | medium | low
```

The Worker stores it in `hard_memories` (permanent, FTS5-searchable) and
incorporates it into the next user profile regeneration.

## Notes

- All hard memories belong to the authenticated user (`user_id` derived from API key).
- Returns the memory id, or a warning if cached offline.
