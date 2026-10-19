---
name: mem_profile
description: Fetch the latest auto-generated user profile from the Worker
---

# mem_profile Skill

Wraps the `mem_profile` plugin tool. Returns the Markdown profile that the
Worker maintains automatically.

## When to use

- At the start of a session when you need to know who you're helping
- When the user asks "what do you remember about me / this project?"
- To debug why injected context looks stale

## How to call

```yaml
tool: mem_profile
args: {}
```

## How the profile gets built

The Worker runs LLM jobs on a schedule:

- **Daily 03:00** — distills yesterday's raw conversations into a daily summary
- **Weekly Sunday 03:00** — builds a profile from the last 7 days of summaries
- **On demand** — refreshes a profile when at least 10 new hard memories accumulate

The plugin automatically injects the profile and ranked hard memories into each
chat system prompt. If the Worker is unreachable, it falls back to a local
cached profile.
