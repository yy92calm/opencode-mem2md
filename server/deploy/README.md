# 服务器托管部署

裸 node 部署（无 docker、无 pm2）。目标机为 Ubuntu，node 在 `/usr/bin/node`，代码在 `/home/ubuntu/workspace/opencode-mem2md`。

## 为什么要 systemd

此前进程由一次 SSH 会话里的 `npm start` 拉起：机器重启不会自启，崩溃不会自愈，且 stdout 挂在该 SSH 的 tty 上——会话断开后日志全部丢失。这正是 LLM 订阅过期导致管道停摆近三个月却无人发现的原因。

## 安装

```bash
cd /home/ubuntu/workspace/opencode-mem2md
git pull --ff-only origin master
cd server && npm run build && mkdir -p logs

sudo cp deploy/opencode-mem-worker.service /etc/systemd/system/
sudo cp deploy/opencode-mem-worker.logrotate /etc/logrotate.d/opencode-mem-worker
sudo systemctl daemon-reload

# 停掉手工拉起的旧进程，交给 systemd
pkill -f 'dist/index.js'   # 注意：不要在自己的 shell 里用会匹配到本命令行的模式
sudo systemctl enable --now opencode-mem-worker
```

## 验证

```bash
systemctl is-enabled opencode-mem-worker   # enabled
systemctl is-active  opencode-mem-worker   # active
curl -s localhost:12957/health | python3 -m json.tool
sudo systemctl kill -s SIGKILL opencode-mem-worker && sleep 4 \
  && systemctl is-active opencode-mem-worker   # 应自动恢复为 active
```

`/health` 顶层 `status` 恒为 `ok`（表示 HTTP 层可用，插件据此继续上报 raw）。判断智能链路是否真的在产出，看 `pipeline_status` 与 `pipeline` 段：

| 字段 | 含义 |
|------|------|
| `pipeline_status` | `ok` / `degraded` |
| `unsummarized_days` | 有 raw 但没出日报的天数，正常为 1（当天） |
| `lag_days` | 最新日报距今天数，正常 ≤1 |
| `llm_ok_at` / `llm_error_at` | LLM 最近成功与失败时间 |
| `llm_error` | 最近一次 LLM 错误摘要 |

启动时会做一次 LLM ping。凭据失效或订阅过期会在日志里立刻记一条 `level:error`，而不是几天后表现为日报缺失。

## 配置要点

- `TZ`（systemd 单元里）必须与 `config.yaml` 的 `tz` 一致，否则 SQLite `localtime()` 与 JS 的日历日不一致，日报会分桶到错误日期。
- `config.yaml` 不写 `tz` 时取宿主机时区。
- 单元里 `ReadWritePaths` 只放开 `data/` 与 `logs/`，其余文件系统只读。

## 回填

LLM 恢复后，把停摆期间的日报与原子记忆补回来（90 天保留窗口只删已总结的日期，未总结的 raw 会保留，因此不会丢源数据）：

```bash
cd /home/ubuntu/workspace/opencode-mem2md/server
node scripts/backfill.mjs --from 2026-06-22 --to 2026-09-11 --dry   # 先看清单
node scripts/backfill.mjs --from 2026-06-22 --to 2026-09-11          # 实际执行
```

脚本启动前先 ping 一次 LLM，失败即退出，不会逐日空耗调用。

## 日志轮转

`logrotate` 每天切割，保留 14 份，`copytruncate` 模式（不需要进程配合重开文件句柄）。手动验证：

```bash
sudo logrotate -d /etc/logrotate.d/opencode-mem-worker   # dry-run
```
