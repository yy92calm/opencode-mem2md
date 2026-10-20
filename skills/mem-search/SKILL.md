---
name: mem_search
description: Search global and workspace memories on the Worker via full-text query
---

# mem_search Skill

Wraps the `mem_search` plugin tool. Calls `GET /api/memory/search` on the Worker.

## When to use

- "Did I ever decide on X?"
- "What was that command for Y?"
- Before answering a question that might have a prior recorded answer
- When unsure whether the user has expressed a preference

## How to call

```yaml
tool: mem_search
args:
  query: free-form text (matched via SQLite FTS5)
  limit: number of results (default 50)
  scope: all | global | workspace   # default all
```

`all` merges workspace memories (current directory) with global hard memories,
workspace hits first. `workspace` restricts to this project; `global` ignores
project-local facts.

## Notes

- Searches `hard_memories` + the current workspace's `workspace_memories`,
  falling back to daily summaries when results are sparse.
- Workspace hits are tagged `[ws:…]` in the output.
- For broader context, use `mem_profile` for the synthesized profile and
  `mem_focus` for recent topics.