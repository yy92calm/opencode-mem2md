---
name: mem-remember
description: Trigger-word skill that captures user-asserted memories
trigger_words:
  - 记住
  - 记下来
  - 别忘了
  - 保存这个
  - 记一下
  - remember
  - save this
  - don't forget
  - note this
---

# mem-remember Skill

When the user says any of the trigger words, infer the memory type from
context and call `mem_capture` directly. The user shouldn't have to specify
the structured fields themselves.

## Workflow

1. Detect a trigger word in the user message.
2. Read the surrounding context (the message + the preceding turn).
3. Infer `type`:
   - mentions "配置 / config / env / 环境变量" → `config`
   - mentions "偏好 / 喜欢 / 习惯 / preference / always use" → `preference`
   - mentions "决策 / 选择 / 决定 / decided / chose" → `decision`
   - mentions "bug / 错误 / 修复 / fix / 报错" → `error`
   - mentions "模式 / 方法 / 技巧 / pattern / approach" → `discovery`
   - default → `fact`
4. Extract a short semantic `title` (≤ 30 chars).
5. Pull 2-5 concrete `facts` (verbatim phrases from the user).
6. Tag 1-3 `concepts`.
7. Choose `scope`:
   - project/repo-specific (scripts, ports, layout, local conventions, "this project") → `workspace`
   - personal preference / machine setup / cross-project rule → `global`
8. Call `mem_capture` with `priority: high` (user-asserted = important).
9. Briefly confirm to the user what was saved (and where, if workspace-scoped).

## Example

User: "记住这个项目用 Bun 构建，不要用 npm"

```yaml
tool: mem_capture
args:
  type: preference
  title: 项目构建工具 Bun
  content: 项目使用 Bun 构建，禁止使用 npm。
  facts:
    - 构建工具：Bun
    - 不要使用 npm
  concepts: [build, bun, tooling]
  priority: high
  scope: workspace
```

Reply: "✓ 已记住：项目用 Bun，不用 npm"

## Notes

- The memory is stored on the Worker, available across all devices and sessions.
- If the Worker is unreachable, the entry is cached locally and replayed on reconnect.
