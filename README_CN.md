# opencode-mem

**[English](./README.md)**

> 通过集中式 Worker 为 [OpenCode](https://opencode.ai) 提供持久化记忆。插件面向 **OpenCode V2 插件 API**（`@opencode/plugin`，已在 OpenCode 2.0.32 上验证），采集对话、提供记忆工具并注入用户画像。

本仓库包含两部分：

| 路径        | 说明                                                   |
|-------------|--------------------------------------------------------|
| [`server/`](./server)  | **Worker** — Hono + SQLite + cron + LLM。单实例部署，随处可运行。 |
| [`src/`](./src)        | **Plugin** — OpenCode hooks 与记忆工具，在每个 OpenCode 实例中运行。 |

## 工作原理

```
┌─────────────────────────┐         ┌─────────────────────────────────┐
│  OpenCode (每台设备)     │  HTTPS  │   Worker (单实例)                │
│  ─────────────────────  │  ─────► │   ────────────────────────────  │
│  • tool.execute.after   │  原始   │   raw_conversations   (90 天)   │
│  • 用户消息              │  ─────► │   hard_memories       (永久)    │
│  • "记住X" → Skill      │  记忆   │             │                   │
│                         │         │             ▼ 定时任务           │
│  • 注入系统提示词        │  ◄───── │   daily_summaries (LLM)         │
│                         │ 用户画像 │   user_profiles   (LLM)         │
└─────────────────────────┘         └─────────────────────────────────┘
```

**两条数据通道，统一 HTTP API：**

1. **原始对话** — 插件批量采集每次工具调用和用户消息；低成本、允许丢失，90 天后自动清理。
2. **硬记忆** — 通过 `mem-remember` skill 显式创建的"记住 X / remember X"条目。永久存储，支持 FTS5 全文搜索。

**Worker 内部运行三个定时任务：**

| 时间                   | 任务                                                       |
|------------------------|-----------------------------------------------------------|
| 每天 03:00             | LLM 将昨天的原始对话提炼为每日摘要                          |
| 每周日 03:00           | LLM 从最近 7 天摘要构建用户画像                            |
| 用户新增 ≥10 条硬记忆时 | LLM 立即刷新用户画像                                        |

Worker 是唯一数据源。插件仅在 Worker 不可达时使用小型 JSONL 离线缓存。

## 快速开始

### 1. 启动 Worker

```bash
cd server
cp config.example.yaml config.yaml         # 编辑用户配置 + LLM 模型
export LLM_API_KEY=sk-...                  # 你的 OpenAI/OpenRouter/等 API Key
export USER_VINCENT_KEY=$(openssl rand -hex 32)
npm install
npm run dev                                # 或 `docker compose up -d`
```

完整部署和 API 文档见 [`server/README.md`](./server/README.md)。

### 2. 安装插件

```bash
npm install
npm run build:all
npm run install:opencode                   # 复制插件 bundle 和 skills
```

### 3. 配置插件

方式一：设置环境变量

```bash
export MEM_SERVER_URL=http://localhost:3777
export MEM_API_KEY=<步骤1中设置的相同 key>
```

方式二：写入配置文件 `~/.config/opencode/mem/config.json`：

```json
{
  "server_url": "http://localhost:3777",
  "api_key": "<相同的 key>"
}
```

重启 OpenCode。插件即可提供记忆工具和 system prompt 钩子。

## 弱网行为

设计为 Worker 不可达时优雅降级：

| 场景 | 行为 |
|---|---|
| Worker 宕机 → 上传原始对话 | 批次写入 `offline.jsonl` 缓存 |
| Worker 宕机 → 写入硬记忆 | 本地缓存并返回提示，不崩溃 |
| Worker 宕机 → 获取画像 | 回退到 `profile.cache.md` 中的最后已知画像 |
| Worker 会话中恢复 | 后台看门狗自动重放缓存 |
| 进程被终止 (SIGTERM/SIGINT) | 内存缓冲区在退出前刷新到离线缓存 |
| 缓存无限增长 | 达到 10 MB 时轮转为 `.jsonl.bak`（覆盖旧 `.bak`） |
| 缓存含无效条目 | 4xx（服务端拒绝）条目作为死信丢弃；5xx/网络错误重试 |
| 聊天启动时高延迟 | 画像获取限制 2 秒，超时后回退到本地缓存 |

所有阈值可在插件配置中调整：

| 配置项                       | 默认值 | 用途 |
|------------------------------|--------|------|
| `raw_buffer_size`            | 20     | 缓冲区达到 N 条时自动刷新 |
| `raw_flush_interval_ms`      | 10 000 | 即使缓冲区未满也定期刷新 |
| `watchdog_interval_ms`       | 300 000 | 重放离线缓存并重新检查健康状态 |
| `write_timeout_ms`           | 15 000 | POST 请求超时 |
| `read_timeout_ms`            | 10 000 | GET 请求超时 |
| `profile_fetch_timeout_ms`   | 2 000  | 聊天启动时画像请求超时 |
| `profile_cache_ttl_ms`       | 60 000 | 内存画像缓存 TTL（0 禁用） |
| `memories_cache_ttl_ms`      | 30 000 | 内存硬记忆缓存 TTL（0 禁用） |
| `inject_char_budget`         | 6 000  | 注入记忆的字符预算 |
| `offline_cache_path`         | `~/.config/opencode/mem/offline.jsonl` | JSONL 追加日志 |
| `offline_cache_max_bytes`    | `10485760` | 轮转阈值 (10 MB) |
| `profile_cache_path`         | `~/.config/opencode/mem/profile.cache.md` | 最后已知画像 |

## Worker 部署位置

Worker 只是一个 HTTP 服务。部署在符合你信任边界的位置：

- **本地** — 单用户，无网络暴露，`127.0.0.1:3777`
- **家庭服务器 / NAS** — 多设备个人使用，通过 LAN/VPN 访问
- **云服务器** — 多设备随处访问；**必须**配置 TLS + 限制 CORS

插件只看到 `server_url`。同一二进制文件，同一配置结构，不同网络位置。

## 插件提供的功能

6 个工具，均由 Worker HTTP API 支持：

| 工具 | 用途 |
|---|---|
| `mem_capture` | 写入硬记忆（由 `mem-remember` skill 调用） |
| `mem_search` | 全文搜索硬记忆 |
| `mem_list` | 列出最近的硬记忆 |
| `mem_profile` | 获取最新用户画像 |
| `mem_health` | 检查 Worker 连接并排空离线缓存 |
| `mem_skill_sync` | 安装 Worker 已批准的 skill 草稿 |

[`skills/`](./skills/) 中的 skill 封装插件工具。插件基于 OpenCode V2 插件 API 编写：`Plugin.define` + `ctx.tool.transform/hook`、`ctx.session.hook("prompt"/"context")`、`ctx.event.subscribe`。OpenCode V2 会自动加载 `~/.config/opencode/plugins/` 下的插件，执行 `npm run install:opencode` 后无需修改配置。要求 OpenCode 2.0.x；本版本插件不再支持 V1（1.x）。

## 许可证

MIT
