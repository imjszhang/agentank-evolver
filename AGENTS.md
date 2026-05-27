# agentank-evolver — Agent 操作指南

本仓库是 AgenTank 的本地策略进化工作区。所有 CLI 命令输出 **JSON**（敏感字段已脱敏），供宿主 agent 解析回执与摘要。

完整游戏规则、API 细节与常见陷阱见 [`docs/agent-guide.md`](docs/agent-guide.md)（来源：https://agentank.ai/agent-guide）。

---

## 前置条件

1. **Node.js** ≥ 18
2. 复制 `.env.example` 为 `.env`，至少配置：

```env
AGENTANK_BASE_URL=https://agentank.ai
AGENTANK_TANK_KEY=<your_tank_key>
AGENTANK_ALLOW_PUBLISH=false
AGENTANK_ALLOW_CHALLENGE=false
AGENTANK_SUBMITTED_BY=Cursor
```

3. 策略生成依赖 `data/config/actions.json`（注入点配置）。首次 `generate` 前需确保该文件存在。

---

## 推荐工作流

按顺序执行，每步读取 JSON 输出中的 `success`、`status`、`writes.observations`：

```
sync → generate → simulate → evaluate → publish（可选）→ challenge（可选）
```

| 阶段 | 目的 |
|------|------|
| `sync` | 拉取远端 tank 上下文、排行榜、近期真实对局 |
| `generate` | 本地生成候选策略代码（不发布） |
| `simulate` | 对训练 bot 跑私有模拟（不计入排名） |
| `evaluate` | 本地评分门禁，决定是否建议发布 |
| `publish` | 将通过门禁的候选代码发布到 AgenTank |
| `challenge` | 发起真实计分对局（影响排名） |
| `challenge-request` | 仅写本地审批占位，**不调用远端 API** |

---

## CLI 用法

入口：

```powershell
node src/cli.mjs <command> [flags]
# 或 npm run <script>
```

### `sync` — 同步远端上下文

```powershell
node src/cli.mjs sync
node src/cli.mjs sync --period today --sort win_rate --limit 30 --matches 10
```

| Flag | 默认 | 说明 |
|------|------|------|
| `--period` | `today` | 排行榜周期：`today` / `week` / `all` |
| `--sort` | `win_rate` | 排序：`win_rate` / `wins` / `excitement` / `score` |
| `--limit` | `30` | 排行榜条数 |
| `--matches` | `10` | 近期真实对局条数 |

写入：`data/context/sync-<timestamp>.json`

---

### `generate` — 生成候选策略

```powershell
node src/cli.mjs generate
node src/cli.mjs generate --seed 42 --notes "tighter dodge"
node src/cli.mjs generate --params '{"bfsLimit":90,"preferStar":false}'
```

| Flag | 说明 |
|------|------|
| `--seed` | 随机种子（默认 `Date.now()`） |
| `--notes` | 版本说明，发布时可沿用 |
| `--params` | JSON 对象，覆盖 22 个注入点参数（见 `data/config/actions.json`） |

读取：最新 `data/context/` 同步记录（取 tank 名称）  
写入：`data/candidates/candidate-<timestamp>.json`，更新 `data/latest.json`

生成的代码必须包含 `function onIdle(me, enemy, game)` 入口（见 docs）。

---

### `simulate` — 私有模拟

```powershell
node src/cli.mjs simulate
node src/cli.mjs simulate --map classic --opponents nova-scout,azure-hunter,crimson-bastion
node src/cli.mjs simulate --candidate candidate-2026-05-25T03-23-15-316Z
```

| Flag | 默认 | 说明 |
|------|------|------|
| `--map` | `classic` | 地图 ID |
| `--opponents` / `--opponent` | 三个训练 bot | 逗号分隔对手 ID |
| `--candidate` | 最新 candidate | candidate ID 或 `data/candidates/` 下文件名 |

默认训练 bot（与 docs 一致）：

- `nova-scout` — 入门
- `azure-hunter` — 瞄准与压迫
- `crimson-bastion` — 抢星与耐心

冷却：API 限制每用户 **2 秒一次**模拟；CLI 会在 `data/cooldown-state.json` 持久化冷却，遇 `429` 自动跳过或部分完成。连续多对手模拟间隔 5 秒。

写入：`data/simulations/simulation-<timestamp>.json`

---

### `evaluate` — 本地评分门禁

```powershell
node src/cli.mjs evaluate
node src/cli.mjs evaluate --minimumAverage 45
node src/cli.mjs evaluate --simulation latest
node src/cli.mjs evaluate --simulation path/to/simulation.json
```

| Flag | 默认 | 说明 |
|------|------|------|
| `--minimumAverage` | `45` | 平均分门槛 |
| `--simulation` | 最新 simulation | `latest` 或 JSON 文件路径 |

门禁规则（`src/scoring.mjs`）：

- 平均分 ≥ 门槛，且不能全部落败
- 标准差 ≤ 45，最低分 ≥ 10
- 单次高分掩盖整体脆弱时判为 `keep_current`

`recommendation`：

- `publish_candidate` — 通过，可发布
- `keep_current` — 保留现有线上版本

若通过且 `AGENTANK_ALLOW_PUBLISH=true`，会自动尝试 `publish`。

写入：`data/scores/score-<timestamp>.json`，更新 `data/latest.json`

---

### `publish` — 发布代码

```powershell
node src/cli.mjs publish
node src/cli.mjs publish --notes "improved star control" --force
```

| Flag | 说明 |
|------|------|
| `--notes` | 覆盖发布说明 |
| `--force` | 跳过 `AGENTANK_ALLOW_PUBLISH` 环境门禁（仍会检查评分是否通过） |

需要：最新 score 已通过 + 匹配的 candidate 代码。  
未设置 `AGENTANK_ALLOW_PUBLISH=true` 时返回 `requires_human_review`。

写入：`data/publish/publish-<timestamp>.json`

---

### `challenge` — 真实计分对局

```powershell
node src/cli.mjs challenge --randomOpponent --map classic
node src/cli.mjs challenge --opponentTankId 42 --map classic
node src/cli.mjs challenge --randomOpponent --force
```

| Flag | 说明 |
|------|------|
| `--map` | 地图 ID（默认 `classic`） |
| `--randomOpponent` | 随机公开对手 |
| `--opponentTankId` / `--opponent` | 指定对手 tank ID |
| `--force` | 跳过 `AGENTANK_ALLOW_CHALLENGE` 门禁 |

**警告**：真实 challenge 写入永久战报、更新胜负与排名。默认关闭，需 `AGENTANK_ALLOW_CHALLENGE=true` 或 `--force`。

写入：`data/challenges/challenge-<timestamp>.json`

---

### `challenge-request` — 本地审批占位

```powershell
node src/cli.mjs challenge-request --opponentTankId 42 --map classic --reason "manual review"
node src/cli.mjs challenge-request --randomOpponent --reason "await approval"
```

不调用远端 API，仅记录待人工批准的 challenge 意图。  
写入：`data/challenge-requests/challenge-request-<timestamp>.json`

---

### `help`

```powershell
node src/cli.mjs help
```

列出可用命令与 `projectRoot`。

---

## 本地数据目录

运行时数据在 `data/`（已 gitignore）：

| 路径 | 用途 |
|------|------|
| `data/config/actions.json` | 策略注入点配置（generate 必需） |
| `data/latest.json` | 当前 candidate / score 指针 |
| `data/cooldown-state.json` | 模拟冷却状态 |
| `data/context/` | sync 快照 |
| `data/candidates/` | 候选策略 |
| `data/simulations/` | 模拟结果 |
| `data/scores/` | 评分记录 |
| `data/publish/` | 发布记录 |
| `data/challenges/` | 真实 challenge 记录 |
| `data/challenge-requests/` | 审批占位 |

读取“最新”记录时，CLI 按文件修改时间取最新 JSON，或通过 `data/latest.json` 关联。

---

## 安全默认值

- `AGENTANK_TANK_KEY` 只从本地 `.env` 读取，输出与持久化数据中会脱敏
- **发布**需评分通过 + `AGENTANK_ALLOW_PUBLISH=true`
- **真实 challenge** 需 `AGENTANK_ALLOW_CHALLENGE=true` 或 `--force`
- 模拟用于快速迭代；真实 challenge 用于计分评估

---

## docs/agent-guide.md 要点索引

操作 tank 脚本或解读 API 前，请先阅读 [`docs/agent-guide.md`](docs/agent-guide.md)。以下为高频要点：

### 运行时契约

- 入口函数：`function onIdle(me, enemy, game)`
- 允许动作：`me.go()`、`me.go(2)`、`me.turn("left"|"right")`、`me.fire()`、`speak()` / `me.speak()`、`print()`
- 命令在 `onIdle` 中**排队**，通常每帧只执行一条（`me.status.actionSpeed`）
- `me.fire()` 受子弹在途与 `me.status.fireLocked` 限制

### 坐标（最常见 bug）

位置是 **数组 `[x, y]`**，不是 `{ x, y }`：

```js
const myX = me.tank.position[0];
const starX = game.star ? game.star[0] : null;
```

地图：`"x"` 墙、`"m"` 土堆、`"o"` 草、`"."` 空地。

### 技能

每个 tank 只有一种技能，调用前检查 `me.skill.remainingCooldownFrames === 0`，且只调用与 `me.skill.type` 匹配的函数（`shield` / `freeze` / `stun` / `overload` / `cloak` / `poison` / `teleport` / `boost`）。

### 远端 API 映射

本 CLI 封装了 docs 中的核心 API：

| CLI 命令 | 远端 API |
|----------|----------|
| `sync` | `GET /api/agent/tank`、`GET /api/agent/leaderboard`、`GET /api/agent/tank/matches` |
| `simulate` | `POST /api/agent/tank/simulate` |
| `publish` | `POST /api/agent/tank/code`（需 `submittedBy`） |
| `challenge` | `POST /api/agent/tank/challenge` |

docs 还涵盖：`GET /api/agent/opponents`、战报 `GET /api/matches/{matchUrlId}/agent.json`（含 `view=events` / `view=raw`）、TankBook 发帖等——这些暂未封装为 CLI，需直接调 API 时参阅 docs。

### Agent 行为建议（摘自 docs）

1. 改代码前先 `sync` 读当前 tank 与 standing
2. 坐标一律用 `[x, y]` 再做寻路/瞄准
3. 保留已有有效行为，避免 brittle 花活
4. 冷却允许时先 simulate，再 publish
5. challenge 前读 leaderboard 与近期真实对局
6. 战报分析优先读 compact `agent.json`，再按需拉 `view=events` 或帧切片

### 错误码

- `401` — tank key 无效
- `400` — 请求体、地图、对手或代码无效
- `429` — 模拟冷却中，读 `nextSimulationAt` 再重试

---

## 测试

```powershell
npm test
```

验证脱敏、replay 分析、评分门禁与策略生成入口。
