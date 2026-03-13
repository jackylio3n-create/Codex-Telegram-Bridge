# Codex Telegram Bridge

## 这是什么项目

Codex Telegram Bridge 是一个给单个 Telegram owner 使用的私聊桥接器。

它把 Telegram 私聊消息转成对本机 `codex` CLI 的调用，让你可以直接在 Telegram 里和运行在云服务器上的 Codex 交互。项目会保存会话状态、工作目录、线程上下文和运行记录，并以 `systemd` 服务方式常驻运行。

## 能解决什么问题和使用场景

这个项目主要解决两个问题：

1. 你不想每次都 SSH 登录服务器才能用 Codex。
2. 你希望把云服务器直接当开发机，通过 Telegram 远程让 Codex 读代码、改代码、跑命令、装依赖、配环境。

适合的使用场景：

- 远程维护部署在云主机上的项目
- 出门在外用手机直接让 Codex 修代码、查日志、跑测试
- 把单台 Linux 服务器当长期在线的 Codex 开发机
- 需要保留会话上下文，而不是每次都重新开始

## 怎么配置部署

### 依赖要求

- Linux
- Go 1.22+（如果不用 release 包）
- 已安装并登录的 `codex` CLI
- Telegram bot token
- owner Telegram user id

### 推荐部署

```bash
cd /root/Codex-Telegram-Bridge
chmod +x ./scripts/deploy/install-ubuntu.sh
./scripts/deploy/install-ubuntu.sh
```

安装脚本交互时通常只需要输入：

- `Telegram bot token`
- `Owner Telegram user ID`
- `Telegram verification password`

默认配置文件位置：

```bash
~/.config/codex-telegram-bridge/config.env
```

### 非交互部署

```bash
cd /root/Codex-Telegram-Bridge
./scripts/deploy/install-ubuntu.sh \
  --bot-token 'your-bot-token' \
  --owner-user-id 'your-telegram-user-id' \
  --verification-password 'your-verification-password' \
  --approval-policy never \
  --sandbox-mode danger-full-access
```

### 使用 release 部署

```bash
cd /root/Codex-Telegram-Bridge
./scripts/deploy/install-ubuntu.sh --from-release latest
```

### 手工部署

```bash
codex login
cd /root/Codex-Telegram-Bridge
go build -o bin/codex-telegram-bridge ./cmd/bridge
./bin/codex-telegram-bridge setup
./bin/codex-telegram-bridge doctor
./bin/codex-telegram-bridge serve
```

### 关键配置项

最常用的配置项如下：

- `CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN`
- `CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH`
- `CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID`
- `CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID`
- `CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT`
- `CODEX_TELEGRAM_BRIDGE_CODEX_HOME`
- `CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE`
- `CODEX_TELEGRAM_BRIDGE_CODEX_APPROVAL_POLICY`
- `CODEX_TELEGRAM_BRIDGE_CODEX_SANDBOX_MODE`

默认推荐把服务器直接作为开发机使用：

```env
CODEX_TELEGRAM_BRIDGE_CODEX_APPROVAL_POLICY=never
CODEX_TELEGRAM_BRIDGE_CODEX_SANDBOX_MODE=danger-full-access
```

## 怎么使用

### 服务检查

```bash
codex-telegram-bridge doctor
codex-telegram-bridge status
codex-telegram-bridge logs 100
systemctl status codex-telegram-bridge
```

### Telegram 中的常用命令

- `/new` 新建并切换到会话
- `/reset` 重置当前会话上下文
- `/cd <path>` 切换当前工作目录
- `/mode <ask|plan|code>` 切换模式
- `/scope <workspace|system>` 切换访问范围
- `/think <minimal|low|medium|high|xhigh>` 设置思考强度
- `/ctx` 查看当前 Codex 运行上下文
- `/stat` 查看当前 bridge 会话状态
- `/stop` 停止当前运行

### 基本使用流程

1. 在 Telegram 私聊机器人。
2. 发送 `/new` 创建会话。
3. 用 `/cd` 切到项目目录。
4. 直接发送自然语言需求，例如让 Codex 修 bug、改代码、跑测试、查看日志。
5. 需要更大目录范围时，用 `/scope system`。
6. 需要查看当前状态时，用 `/stat`。
