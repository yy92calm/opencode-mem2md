---
name: mem_focus
description: Show what the user has been focusing on recently (rolling topic window)
---

# mem_focus Skill

Wraps the `mem_focus` plugin tool. Reads the Worker's rolling `recent_focus`
table, populated from daily-summary topics and daily decay.

## When to use

- "我最近在做什么 / what have I been working on?"
- Starting a new session and wanting continuity
- Deciding what to prioritize or what context to load

## How to call

```yaml
tool: mem_focus
args:
  days: lookback window (default 7)
  limit: max topics (default 10)
  all_workspaces: also include other projects' topics (default false)
```

## Notes

- Topics are attributed to the workspace that dominated the day; mixed days
  produce global topics.
- `weight` (×N) means the topic recurred across days.
- Stale topics are pruned after 14 days.