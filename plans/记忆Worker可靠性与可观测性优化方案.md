# 记忆 Worker 可靠性与可观测性优化方案

版本：v1
日期：2026-09-11
适用：opencode-mem2md（Worker 端为主，含服务器托管）

## 一、背景

部署 354a6da 后实测发现：Worker 的 HTTP 层与采集层正常（近 7 天 766 条 raw），但所有依赖 LLM 的链路自 2026-06-20 起无产出。根因为上游 LLM 端点返回 HTTP 400 `InvalidSubscription`（Ark CodingPlan 订阅过期）。该故障持续约三个月未被发现，暴露的是可靠性与可观测性缺陷，而非记忆算法缺陷。本方案只处理不依赖订阅恢复即可落地的部分。

## 二、现状对照

| 能力 | 现状 | 问题 |
|------|------|------|
| 日报生成 | 8/27 天有产出，最新 2026-06-20 | 19 天共 3124 条 raw 未总结 |
| 原子蒸馏 | hard_auto=0，distill_state 空 | 从未产出，且被日报异常连带跳过 |
| 用户画像 | version 2，2026-06-20 | 每周任务空转 |
| 技能草稿 | skill_drafts 空 | 每周任务空转 |
| 故障暴露 | 仅 console.error 裸栈到已死的 SSH tty | 39 天日志全丢，无告警 |
| 进程托管 | setsid nohup 手工拉起 | 机器重启不自启，崩溃不自愈 |
| 日志 | logs/worker.log 无轮转 | 无限增长 |
| 健康检查 | /health 仅返回 status/users | 探不出管道停摆 |
| 启动校验 | initLLM 只构造 client | 密钥失效/订阅过期启动即静默 |
| 重试策略 | 任意 4xx 重试 3 次，再降级去 response_format 重试 | 订阅类错误每天 6 次无效调用 |
| raw 清理 | 90 天硬删，按 UTC 日期 | 与是否已总结不联动，且与 localtime 分桶不一致 |

## 三、关键约束

1. 生产服务在跑：必须先构建、构建通过再重启，停机控制在秒级。
2. SQLite 为唯一真源：所有 schema 变更走 migrate()，幂等、向后兼容、不删数据。
3. 不新增第三方依赖：服务器为裸 node 部署（无 docker、无 pm2），node 路径 /usr/bin/node。
4. LLM 订阅未恢复前，只能验证失败路径与进程稳定性，无法端到端验证蒸馏产出。
5. 禁止把 api_key 等密钥写入仓库或日志。
6. 保持 /health 顶层 status 语义不变，避免插件把"管道降级"误判为"服务不可达"而进入离线缓存模式，中断 raw 采集。

## 四、模块结构与改动点

### server/src/db/schema.ts
SCHEMA 新增 KV 表 service_state(key, value, updated_at)，用于持久化 LLM 最近成功/失败状态。CREATE TABLE IF NOT EXISTS，天然幂等，无需 migrate 分支。

### server/src/db/repo.ts
1. 新增 getServiceState / setServiceState / getServiceSnapshot。
2. 新增 getHealthMetrics：一次查询取 daily_summaries 最新 date 与 generated_at、user_profiles 最新 generated_at。
3. pruneRawOlderThan 替换为 pruneSummarizedRawOlderThan(days)：仅删除"该 local 日已存在日报"的 raw，日期计算统一改用 date(datetime(timestamp,'localtime'))，与分桶口径一致。

### server/src/llm/client.ts
1. 新增内部 LLMError，携带 HTTP status。
2. 重试分类：408/429/5xx/网络与超时才重试；400/401/403/404 立即失败，不再空耗 3 次。
3. 成功后写 service_state.llm_ok_at；最终失败写 llm_error 与 llm_error_at（写入包 try/catch，绝不影响主链路）。
4. 新增 ping()：最小 token 探测，供启动校验与诊断复用。

### server/src/llm/prompts.ts
收窄两处降级重试判据（generateDailySummary 与 chatJson）：仅当错误文本包含 response_format / json_object / json_schema / unsupported parameter 等格式相关线索时才去掉 response_format 重试，其余原样抛出。移除过宽的 /\b4\d{2}\b/ 判据。

### server/src/cron/jobs.ts
1. runDailySummaryForUser 内 generateDailySummary 用 try/catch 包住并记 error 日志，使后续 distill 真正独立执行（兑现原有注释语义）。
2. runRawPrune 改用 pruneSummarizedRawOlderThan，日志同时输出已删与因未总结而保留的天数。

### server/src/index.ts
1. bootstrap 内异步执行 LLM ping 校验，失败记 error 日志并落 service_state，不阻塞启动。
2. /health 增加 pipeline 段：last_summary_date、last_summary_at、last_profile_at、lag_days、llm_ok_at、llm_error、llm_error_at，并给出 pipeline_status（ok/degraded）。顶层 status 保持 ok。

### server/deploy/（新增，入库）
1. opencode-mem-worker.service：systemd 托管，Restart=always，Environment=TZ=Asia/Shanghai，WorkingDirectory 指向 server，ExecStart=/usr/bin/node dist/index.js，StandardOutput/StandardError 追加到 logs/worker.log。
2. opencode-mem-worker.logrotate：按日轮转，保留 14 份，compress + copytruncate（配合 append 模式）。
3. README.md：安装与验证步骤。

### server/scripts/backfill.mjs（新增，入库）
按日期区间逐日调用 dist/cron/jobs.js 的 runDailySummaryForUser，串行、带间隔、输出每日结果，供订阅恢复后回填 19 天缺口。支持 --from/--to/--user/--dry。

## 五、实施步骤

1. 本地按上述改动点修改源码。
2. 本地 npm run typecheck 与 build，确保零错误。
3. 提交并推送。
4. 服务器备份 data/memory.db 与 config.yaml。
5. 服务器 git pull --ff-only，node_modules/.bin/tsc 构建。
6. 安装 systemd unit 与 logrotate 配置，daemon-reload。
7. 停掉手工 nohup 进程，systemctl enable --now 接管。
8. 验证：systemctl 状态与自启、/health 的 pipeline 段、日志落盘与结构化 error、ping 失败被正确记录、prune 不再误删未总结日。
9. 订阅恢复后执行 backfill 回填，并确认 hard_auto 与 distill_state 首次出现数据。

## 六、验证方式

| 项 | 方法 | 期望 |
|----|------|------|
| 构建 | tsc | 零错误 |
| 托管 | systemctl is-enabled / is-active | enabled / active |
| 自愈 | kill -9 进程 | systemd 自动拉起 |
| 自启 | 单元含 WantedBy=multi-user.target | 重启后自启 |
| 健康 | curl /health | pipeline_status=degraded 且 llm_error 含 InvalidSubscription |
| 快速失败 | 触发一次 manual daily | 日志仅 1 次 LLM 调用，不再是 3 次 |
| 隔离 | 同上 | distill 分支被执行（distill_state 出现水位行） |
| 清理 | 对含未总结日的库跑 prune | 未总结日 raw 保留 |
| 日志 | 轮转配置 dry-run | 生效且不截断当前写入 |

## 七、回滚

1. 代码：git revert 对应提交后重新构建重启。
2. 托管：systemctl disable --now 后恢复 setsid nohup 启动。
3. 数据：service_state 为新增表，可直接 DROP；prune 改动只会少删不会多删；如需还原数据用部署时的 memory.db.bak-*。

## 八、本次不做（留待后续）

语义/向量检索与混合召回、记忆衰减打分、冲突检测、入库脱敏、TLS 与限流、自动 DB 备份与告警通道、多用户密钥轮换。这些依赖订阅恢复或需单独评审。
