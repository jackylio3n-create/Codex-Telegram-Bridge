# Codex Telegram Bridge

一个面向 Linux 服务器部署的 Telegram 私聊桥接守护进程，用来把消息安全转发到本地已登录的 `codex` CLI。

[English README](./README.md)

## 项目作用

这个项目让白名单内的 Telegram 用户通过私聊 bot 驱动一台自托管的 Codex 运行环境。

设计重点：

- 直接调用本机已登录的 `codex` CLI，不走 API key first 架构
- 使用 SQLite 持久化 session、审批、offset、运行状态和 rolling summary
- 支持 Telegram 文本和图片输入
- 首次接触必须先通过验证密码
- 验证成功后必须选择中文或英文提示语言
- 未验证或已封禁的流量不会进入 Codex runtime
- 默认采用更保守的隐私和留存策略

## 当前安全链路

当前访问控制按层执行：

1. 仅接受 Telegram 私聊
2. 校验 Telegram user id 白名单
3. 可选 owner user/chat 锁定
4. 首次对话验证密码
5. 语言选择完成前继续阻断
6. 连续 5 次输错密码后，本地永久封禁该 Telegram user id

关键行为：

- 第一次 `/start` 只发送双语欢迎，不计入失败次数
- 验证前的文本、命令、文件、callback 都不会转发给 Codex
- 被封禁后，消息、文件、callback 都会被静默丢弃

## 主要功能

- Telegram 长轮询与 offset 持久化
- 多 session 绑定、切换、重绑定
- 工作目录切换、访问范围切换、旧 session 清理
- Inline 审批按钮与 `/perm` fallback
- Rolling summary、resume、stale recovery
- 运行状态查看与诊断
- 安全写入 env 的 setup 配置流
- Ubuntu / Debian 安装脚本
- 默认最小化审计与自动清理

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/cli/` | 守护进程 CLI、setup、运维命令 |
| `src/runtime/bridge/` | bridge runtime 编排层 |
| `src/runtime/codex/` | Codex 进程执行、状态读取、resume |
| `src/transport/telegram/` | Telegram client、polling、update 解析 |
| `src/core/commands/` | Telegram 命令实现 |
| `src/core/approval/` | 审批生命周期和 `/perm` 解析 |
| `src/core/workspace/` | 工作区边界与路径校验 |
| `src/config/` | 配置解析、脱敏、启动校验 |
| `src/store/` | SQLite store、拆分后的 repositories、mappers、共享 codecs |
| `scripts/deploy/` | 部署与安装脚本 |
| `scripts/dev/` | 本地开发辅助脚本 |
| `migrations/` | 数据库迁移 |
| `docs/testing/` | 手工验收与检查清单 |
| `tests/unit/` | 单元测试 |
| `tests/integration/` | 集成测试 |

## 运行要求

- Linux 服务器
- Node.js 24+
- 可用的 `codex` CLI
- 已完成 `codex login`
- 一个 Telegram bot token
- 至少一个允许访问的 Telegram user id

## 快速开始

### 1. 克隆并安装依赖

```bash
git clone <your-repo-url> Codex-Telegram-Bridge
cd Codex-Telegram-Bridge
npm ci
```

### 2. 在目标机器上登录 Codex

```bash
codex login
```

### 3. 配置 bridge

交互式配置：

```bash
npm run setup
```

或直接使用 Ubuntu / Debian 安装脚本：

```bash
./scripts/deploy/install-ubuntu.sh
```

配置阶段会要求输入：

- Telegram bot token
- 首次对话验证密码
- 允许访问的 Telegram user id
- 默认工作区根目录
- App home / Codex home 路径

### 4. 运行检查

```bash
npm run doctor
npm run status
```

### 5. 启动服务

```bash
npm run start
```

如果用 `systemd` 之类的进程管理器，建议前台模式：

```bash
npm run serve
```

## 配置说明

参考 [`.env.example`](./.env.example)。

核心配置：

- `CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN`
- `CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH`
- `CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS`
- `CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID`
- `CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT`
- `CODEX_TELEGRAM_BRIDGE_APP_HOME`
- `CODEX_TELEGRAM_BRIDGE_CODEX_HOME`
- `CODEX_TELEGRAM_BRIDGE_LOG_LEVEL`

隐私与留存配置：

- `CODEX_TELEGRAM_BRIDGE_AUDIT_LEVEL`
- `CODEX_TELEGRAM_BRIDGE_INCLUDE_RUNTIME_IDENTIFIERS`
- `CODEX_TELEGRAM_BRIDGE_MAX_AUDIT_ROWS`
- `CODEX_TELEGRAM_BRIDGE_MAX_SUMMARIES_PER_SESSION`
- `CODEX_TELEGRAM_BRIDGE_RESOLVED_APPROVAL_RETENTION_DAYS`
- `CODEX_TELEGRAM_BRIDGE_EXPIRED_APPROVAL_RETENTION_DAYS`

注意：

- 路径必须是绝对 Linux 路径
- 不要把明文验证密码写进 env 文件
- `setup` 只会写入密码哈希
- env 文件包含 bot 凭证，必须限制权限

## 运行时数据

默认 `APP_HOME` 目录结构：

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

## Telegram 命令

支持别名。

| 命令 | 作用 |
| --- | --- |
| `/start` | 触发欢迎和验证流程 |
| `/help` | 查看支持的 Telegram 命令 |
| `/new [cwd]` | 创建并绑定新 session |
| `/sess` 或 `/sessions` | 列出 session |
| `/bind <session_id>` | 绑定已有 session |
| `/cd <absolute_path>` 或 `/cwd <absolute_path>` | 修改当前 session 的 cwd |
| `/allow <absolute_path>` 或 `/adddir <absolute_path>` | 申请增加 allowed directory |
| `/mode <ask\|plan\|code>` | 切换 session 模式 |
| `/scope [workspace\|system]` | 查看或切换访问范围 |
| `/think [minimal\|low\|medium\|high\|xhigh]` 或 `/reasoning ...` | 查看或修改 reasoning effort |
| `/stat` 或 `/status` | 查看当前状态 |
| `/stop` | 取消当前运行 |
| `/perm` | 查看待审批项 |
| `/perm approve <permission_id>` | 批准请求 |
| `/perm deny <permission_id>` | 拒绝请求 |
| `/clean [keep_count]` 或 `/prune [keep_count]` | 清理非活动且未绑定的旧 session |

## 开发与验证

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run lint:shell
```

常用脚本：

- `npm run build`
- `npm run clean`
- `npm run lint`
- `npm run format`
- `npm run format:check`
- `npm run test`
- `npm run lint:shell`
- `npm run start`
- `npm run serve`
- `npm run stop`
- `npm run status`
- `npm run logs`
- `npm run doctor`
- `npm run setup`

说明：

- `npm run lint:shell` 通过本地 wrapper 调用 `shellcheck`。如果 Windows 本机没有安装 `shellcheck`，命令会给出提示并成功退出，CI 仍然是实际的强制校验。
- CI 在 Ubuntu 上执行 `npm ci`、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run test`、`npm run lint:shell`。

## 部署说明

- 推荐目标系统：Ubuntu / Debian
- 设计目标就是直接部署，不依赖 Docker
- 自带安装脚本会写入配置文件并安装 `systemd` 服务
- 详细部署步骤见 [docs/deploy/linux-server.md](./docs/deploy/linux-server.md)

## 当前验证状态

当前本地基线：

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run test`

以上都已通过。`npm run lint:shell` 在未安装 `shellcheck` 的 Windows 环境下会本地降级提示，但 CI 会在 Ubuntu 上执行真实 shellcheck。部分集成测试在 Windows 下会跳过，因为它们要求 Linux 风格工作区路径。
