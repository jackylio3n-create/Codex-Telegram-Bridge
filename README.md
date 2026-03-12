# Codex Telegram Bridge

一个给单个 Telegram owner 用的 Codex 私聊桥接器。运行在 Linux，本地调用 `codex` CLI，保存 SQLite 状态，支持 approval 恢复、图片输入和 `systemd` 部署。

## 要求

- Linux
- Go 1.22+
- 已安装并登录的 `codex` CLI
- Telegram bot token
- owner Telegram user id

## 部署

```bash
./scripts/deploy/install-ubuntu.sh
```

如果目标机不装 Go，直接用预编译 release：

```bash
./scripts/deploy/install-ubuntu.sh --from-release latest
```

安装完成后直接用：

```bash
codex-telegram-bridge doctor
codex-telegram-bridge status
codex-telegram-bridge logs 100
systemctl status codex-telegram-bridge
```

如果不走安装脚本，也可以手工运行：

```bash
codex login
go build -o bin/codex-telegram-bridge ./cmd/bridge
./bin/codex-telegram-bridge setup
./bin/codex-telegram-bridge doctor
./bin/codex-telegram-bridge serve
```

CLI 默认读取 `~/.config/codex-telegram-bridge/config.env`，通常不需要再传 `--config-env-file`。

发布 tag `v*` 时会自动产出 `linux-amd64` 和 `linux-arm64` 的 tar.gz release 资产。

## 配置

以 [`.env.example`](./.env.example) 为模板。最关键的变量是：

- `CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN`
- `CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH`
- `CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID`
- `CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID`
- `CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT`

## Telegram 命令

- `/new` `/reset` `/cd`
- `/mode` `/scope` `/think`
- `/ctx` `/stat` `/stop`
- `/perm` `/perm approve <id>` `/perm deny <id>`

## 开发

```bash
go test ./cmd/... ./internal/...
go build ./cmd/bridge
bash -n scripts/deploy/install-ubuntu.sh
```
