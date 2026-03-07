# Codex Telegram Bridge

一个面向 Linux 服务器部署的 Telegram 到 Codex 桥接守护进程。

它把 Telegram 私聊中的文本、图片和审批操作，转换成对本地 `codex` CLI 的会话驱动，并把运行状态、审批、日志、偏移量、会话摘要和审计记录持久化到 SQLite。

## 项目概览

这个项目解决的是“通过 Telegram 远程使用本机或云服务器上的 Codex”这一类场景，当前实现的重点是：

- 单机器人、单操作员模型
- 只支持 Telegram 私聊
- 只允许白名单用户
- 直接部署到 Linux 服务器，不依赖 Docker
- 通过本地 `codex` 登录态运行，不走 API-key-first 模式
- 使用 SQLite 持久化会话、审批、偏移量、审计和 rolling summary

## 已实现能力

- Telegram 长轮询、偏移量持久化、防重复消费
- 文本输入、Telegram photo、image-as-document 输入
- 会话创建、绑定、切换工作目录、增加可访问目录、模式切换
- Codex 运行预览消息、最终结果替换/分段发送
- 运行期审批：
  - Telegram inline button
  - `/perm approve <permission_id>` / `/perm deny <permission_id>` fallback
- 取消运行 `/stop`
- stale thread recovery：
  - 恢复失败时自动新开线程
  - 注入 rolling summary 作为恢复上下文
- SQLite migration、诊断命令、状态命令、日志查看

## 适用场景

- 你已经在 Linux 服务器上安装并登录好了 `codex`
- 你希望通过 Telegram 私聊远程驱动一个受控工作区
- 你需要审批、审计、会话状态和运行恢复，而不是“裸跑一个 shell bot”

## 核心架构

### 运行组件

| 组件 | 作用 |
| --- | --- |
| `src/cli/` | 守护进程 CLI，负责 `start / stop / status / logs / doctor` |
| `src/runtime/bridge/` | 应用编排层，连接 Telegram、Codex、SQLite、审批、摘要、审计 |
| `src/transport/telegram/` | Telegram API client、轮询、update 解析、preview/chunking |
| `src/runtime/codex/` | `codex exec` 启动、事件归一化、取消、resume、stale recovery |
| `src/core/router/` | chat gate + session actor 路由模型 |
| `src/core/session/` | 会话状态机，约束 run、approval、cancel、fail、recovery |
| `src/core/commands/` | Telegram 命令实现 |
| `src/core/approval/` | pending permission 生命周期和 `/perm` 解析 |
| `src/core/workspace/` | 工作区边界、路径校验、`/cwd`、`/adddir` |
| `src/core/audit/` | 审计事件记录 |
| `src/core/summary/` | rolling summary 构建与刷新 |
| `src/store/` | SQLite store、migration、repository |
| `src/doctor/` | 运行诊断 |

### 运行流

1. CLI `start` 校验环境后，启动后台 daemon。
2. daemon 创建 `BridgeRuntime`，连接 Telegram、Codex、SQLite 和所有核心服务。
3. `TelegramPollingService` 持续调用 `getUpdates`，并把 update 映射成 command、user input 或 approval decision。
4. `InMemoryRoutingCore` 根据 chat binding 和 session actor 把事件路由到正确的会话。
5. `BridgeRuntime` 在合法工作区上下文中启动 `codex exec`，持续消费 JSON 事件并更新 Telegram preview。
6. 审批、取消、恢复、最终结果、审计和 rolling summary 全部在同一条运行链路里完成。

### 状态模型

会话运行状态包括：

- `idle`
- `running`
- `waiting_approval`
- `cancelling`
- `cancelled`
- `failed`
- `stale_recovered`

同一 session 同时只允许一个 active run。

## 系统要求

- Linux 服务器
- Node.js `24+`
- 已安装可执行的 `codex` CLI
- 已完成 `codex login`
- 一个 Telegram bot token
- 至少一个 allowlist Telegram user id

## 快速开始

### 1. 安装依赖

```bash
npm ci
```

### 2. 配置环境变量

程序不会自动加载 `.env` 文件。你需要通过 shell、`systemd`、`direnv` 或其他进程管理器显式注入环境变量。

最小示例：

```bash
export CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN="123456:replace-me"
export CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS="123456789"
export CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT="/srv/codex-telegram-bridge/workspaces/main"
export CODEX_TELEGRAM_BRIDGE_APP_HOME="/var/lib/codex-telegram-bridge"
export CODEX_TELEGRAM_BRIDGE_CODEX_HOME="/home/bridge/.codex"
export CODEX_TELEGRAM_BRIDGE_LOG_LEVEL="info"
```

模板见 [.env.example](./.env.example)。

### 3. 确保这些目录已经存在

- `CODEX_TELEGRAM_BRIDGE_CODEX_HOME`
- `CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT`
- `CODEX_TELEGRAM_BRIDGE_APP_HOME`

说明：

- `APP_HOME` 下的 `data/`、`logs/`、`tmp/`、`run/` 可以在 `start` 时自动创建
- `CODEX_HOME` 和 `DEFAULT_WORKSPACE_ROOT` 必须预先存在

### 4. 先做环境检查

```bash
npm run doctor
```

### 5. 启动 daemon

```bash
npm run start
```

### 6. 查看运行状态

```bash
npm run status
npm run logs 100
```

### 7. 在 Telegram 中开始使用

```text
/new
hello
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN` | 是 | 无 | Telegram bot token |
| `CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS` | 是 | 无 | 逗号分隔的 Telegram 用户 ID 白名单 |
| `CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT` | 是 | 无 | 默认工作区根目录，必须是绝对 Linux 路径 |
| `CODEX_TELEGRAM_BRIDGE_APP_HOME` | 否 | `~/.codex-telegram-bridge` | 应用数据目录 |
| `CODEX_TELEGRAM_BRIDGE_CODEX_HOME` | 否 | `~/.codex` | Codex 登录态目录；若未设置则回退到 `CODEX_HOME` |
| `CODEX_TELEGRAM_BRIDGE_LOG_LEVEL` | 否 | `info` | 日志级别：`debug|info|warn|error` |
| `CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE` | 否 | `codex` | 覆盖默认 Codex 可执行文件路径 |
| `NODE_ENV` | 否 | `development` | `development|test|production` |

## 目录结构与运行时文件

默认 `APP_HOME=~/.codex-telegram-bridge`，目录结构如下：

```text
APP_HOME/
  data/
    bridge.sqlite3
  logs/
    bridge.log
  run/
    bridge.pid
    runtime-state.json
  tmp/
    telegram-media-*
```

说明：

- `bridge.sqlite3` 是唯一持久化存储
- `bridge.log` 是 JSON Lines 日志
- `bridge.pid` 供 `stop` / `status` 使用
- `runtime-state.json` 保存 daemon 当前运行状态和 polling 指标
- `tmp/` 用于暂存 Telegram 图片，运行结束后会自动清理

## CLI 命令

这些命令是在服务器 shell 中执行的，不是发给 Telegram bot 的命令。

| 命令 | 说明 |
| --- | --- |
| `npm run start` | 校验配置并在后台启动 daemon |
| `npm run stop` | 停止 daemon |
| `npm run status` | 查看 daemon/PID/runtime state/offset/poll health |
| `npm run logs` | 查看日志，默认最后 40 行 |
| `npm run logs 200` | 查看日志最后 200 行 |
| `npm run doctor` | 运行诊断 |
| `npm run build` | 编译到 `dist/` |
| `npm run clean` | 删除 `dist/` |
| `npm run cli -- help` | 直接调用 CLI |

说明：

- `serve` 是内部子命令，用于后台 daemon 进程，不需要手动调用
- `status` 在 daemon 未运行时会返回非零退出码

## Telegram 命令

这些命令是在 Telegram 私聊中发送给 bot 的。

| 命令 | 说明 |
| --- | --- |
| `/start` | 返回基础欢迎和使用提示 |
| `/help` | 显示支持的 Telegram 命令 |
| `/status` | 查看当前绑定 session、运行状态和 pending approvals |
| `/sessions` | 列出所有 session |
| `/new [cwd]` | 创建并绑定新 session，可选初始 cwd |
| `/bind <session_id>` | 绑定到已有 session |
| `/cwd <absolute_path>` | 修改当前 session 的 cwd |
| `/adddir <absolute_path>` | 申请为当前 session 增加 allowed dir |
| `/mode <ask|plan|code>` | 切换运行模式 |
| `/stop` | 取消当前 session 的 active run |
| `/perm` | 查看当前 session 的待审批项 |
| `/perm approve <permission_id>` | 批准待审批项 |
| `/perm deny <permission_id>` | 拒绝待审批项 |

### `/adddir` 的确认语义

`/adddir` 不是立即生效，而是两步式确认：

1. 第一次发送 `/adddir <path>` 会返回 confirmation required
2. 在 2 分钟内重复发送完全相同的 `/adddir <path>` 才会真正写入 session

## 工作区和路径模型

项目的路径模型是“绝对 Linux 路径优先”。

约束如下：

- `workspace_root`、`cwd`、`extra_allowed_dirs` 都必须是绝对 Linux 路径
- `cwd` 必须始终位于 `workspace_root` 或某个 `extra_allowed_dir` 内
- `/cwd` 只能切换到已经被允许的目录
- `/adddir` 只能添加当前服务用户真实可访问的目录
- 不支持 Windows 主机路径，例如 `D:\Project`

新 session 的初始化规则：

- `workspace_root`：
  - 如果当前 chat 已绑定 session，则继承当前 session 的 `workspace_root`
  - 否则使用全局 `DEFAULT_WORKSPACE_ROOT`
- `extra_allowed_dirs`：初始为空
- `cwd`：优先使用 `/new [cwd]` 提供的路径，非法时回退到 `workspace_root`
- `mode`：默认 `code`

## 运行模式

| 模式 | sandbox | approval policy |
| --- | --- | --- |
| `ask` | `read-only` | `on-request` |
| `plan` | `workspace-write` | `on-request` |
| `code` | `workspace-write` | `on-request` |

## 输入与输出行为

### 输入

支持的 Telegram 输入：

- 普通文本消息
- Telegram photo
- 以 document 形式发送的图片

不支持的输入：

- 群聊消息
- 非白名单用户消息
- 非图片类媒体

### 输出

- 运行开始时会发送 preview
- 运行中 agent 文本会尝试更新 preview
- 最终输出如果较短，会直接 edit preview
- 最终输出如果较长，会拆分为多个 Telegram 消息发送

当前默认值：

- preview 最大长度：`1500`
- 最终消息 chunk 最大长度：`3600`

## 审批流

当 Codex 在 `on-request` 模式下请求审批时：

1. bridge 创建 `pending_permissions` 记录
2. session 切到 `waiting_approval`
3. bot 发送 inline buttons
4. 用户可以：
   - 点击 Telegram 按钮
   - 或使用 `/perm approve <permission_id>` / `/perm deny <permission_id>`
5. 批准后，bridge 会基于原 `thread_id` 继续 `codex exec resume`
6. 拒绝或超时后，本次 run 会结束为失败

审批默认 TTL 为 5 分钟。

过期、重复、用户不匹配、chat 不匹配、run 不匹配的审批请求都会返回：

```text
Expired or already handled.
```

## 取消与恢复

### 取消

- Telegram `/stop` 会把 session 状态切到 `cancelling`
- runtime 会尝试向 `codex` 子进程发送 `SIGINT`
- 若未及时退出，会继续尝试终止
- 取消结果分为：
  - `full`
  - `partial`
  - `unknown`

### stale thread recovery

如果 `codex exec resume <thread_id>` 发现恢复到的线程与预期不一致：

- bridge 会标记 `stale_recovered`
- 自动新开一个线程
- 将 rolling summary 注入新线程作为历史上下文
- 向用户继续返回新的执行结果

### daemon 重启恢复

daemon 启动时会扫描持久化状态：

- 若 session 上次停在 `running`、`waiting_approval` 或 `cancelling`
- 则会把该 session 标记为失败
- 并将相关未完成审批过期化

这可以避免重启后永远卡死在中间状态。

## 数据存储

SQLite 中的核心表：

| 表名 | 说明 |
| --- | --- |
| `sessions` | session 工作区、模式、thread、run state、last error、summary |
| `chat_bindings` | Telegram chat 到 session 的绑定 |
| `pending_permissions` | 审批请求及其状态 |
| `channel_offsets` | Telegram `getUpdates` offset |
| `audit_logs` | 用户、工具、运行、恢复等审计事件 |
| `session_summaries` | rolling summary 历史 |
| `migrations` | migration 记录 |

数据库打开时会自动：

- 执行 migrations
- 校验 migration checksum
- 开启 `foreign_keys`
- 配置 `WAL`
- 设置 `busy_timeout=5000`

## 审计与 rolling summary

审计事件覆盖：

- `user_input`
- `user_command`
- `approval_decision`
- `agent_text`
- `tool_start`
- `tool_result`
- `file_change`
- `shell_exec`
- `session_rebind`
- `run_cancel`
- `resume_recovery`

rolling summary 是本地确定性构建的，不依赖额外模型。它会聚合：

- session 基本信息
- pending approvals
- 最近命令
- 最近审批结果
- 最近边界变更
- 最近取消/恢复结果

主要用于 stale recovery 时给新线程补上下文。

## 诊断与日志

### `doctor` 会检查什么

- 配置解析
- app home 目录
- `codexHome`
- 默认工作区根目录
- daemon runtime
- SQLite 可读写性
- Telegram token 探测
- Codex CLI 可用性和登录状态
- offset 健康状况
- stale approvals
- run state 一致性
- workspace boundary 一致性

### 日志

- 日志写入 `APP_HOME/logs/bridge.log`
- 格式为 JSON Lines
- 会自动脱敏常见敏感字段和值

## 开发与测试

### 常用命令

```bash
npm run typecheck
npx tsx --test tests\\unit\\*.test.ts tests\\integration\\*.test.ts
npm run build
```

### 测试覆盖方向

仓库当前包含：

- unit tests
- integration tests
- manual acceptance checklist

覆盖重点包括：

- routing / session state machine
- workspace 边界
- approval invalidation
- Telegram update mapping
- preview/chunking
- cancel flow
- stale recovery
- offset diagnostics
- bridge runtime 端到端链路

## 部署建议

推荐先看 [docs/deploy/linux-server.md](./docs/deploy/linux-server.md)。

建议的服务器布局：

```text
/opt/codex-telegram-bridge
/var/lib/codex-telegram-bridge
/srv/codex-telegram-bridge/workspaces/main
/home/bridge/.codex
```

如果需要常驻运行，建议用 `systemd` 托管。

## 已知约束

- 仅支持 Telegram 私聊，不支持群组
- 仅支持白名单用户
- 仅支持文本和图片输入
- 路径必须是绝对 Linux 路径
- 程序不自动读取 `.env`
- `Node 24` 内置 SQLite 目前仍可能输出 experimental warning
- 暂无面向外部用户的 store cleanup CLI

## 相关文档

- [Linux server deployment](./docs/deploy/linux-server.md)
- [Manual acceptance checklist](./tests/manual/v1-acceptance-checklist.md)
- [Environment template](./.env.example)
