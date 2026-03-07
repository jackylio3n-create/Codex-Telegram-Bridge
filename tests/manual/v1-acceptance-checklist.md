# Codex + Telegram Bridge V1 Manual Acceptance Checklist

## Linux Server

- 确认服务器已安装 Node.js 24+，并且 `codex login status` 可用。
- 确认 `CODEX_TELEGRAM_BRIDGE_CODEX_HOME`、`CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT`、`CODEX_TELEGRAM_BRIDGE_APP_HOME` 都是已存在的绝对 Linux 路径。
- 运行 `npm run doctor`，确认 Telegram、Codex、SQLite、workspace 检查没有 error。
- 运行 `npm run start` 后再执行 `npm run status`，确认 daemon 为 `running`。
- 在 Telegram 私聊 allowlist 用户下验证 `/new`、`/status`、`/sessions`、`/bind`、`/mode`、`/cwd`、`/stop` 可用。
- 发送普通文本，确认 bridge 能启动 Codex 并返回最终结果。
- 发送 Telegram photo 和 image-as-document，确认 bridge 能消费图片输入且不会把原始文件名或 EXIF 透传进提示词。
- 触发一次 `on-request` 审批，确认 inline button 与 `/perm approve <permission_id>` fallback 都能工作，stale callback 会返回 `Expired or already handled.`。
- 在运行中尝试 `/bind`、`/new`、`/cwd`、`/mode`、`/adddir`，确认会被 active-session gate 拒绝；`/status`、`/help`、`/stop` 仍可用。
- 人工制造一次 stale thread recovery，确认 bridge 会保留 session、标记 `stale_recovered`，并向新线程注入 rolling summary。
- 运行 `npm run logs 200`，确认日志里能看到 polling、approval、cancel、resume recovery 的关键事件。
- 运行 `npm run doctor`，确认能检查 Telegram、Codex、SQLite、offset、workspace boundary 和 stale approvals。

## Restart And Recovery

- 在 daemon 运行时执行 `npm run stop`，确认进程能优雅退出且 PID 文件被清理。
- 重启 daemon 后执行 `npm run status`，确认 runtime state、SQLite 和日志路径仍然可读。
- 如上一次退出时存在未完成 run，确认它们会被标记为失败或过期，而不是永久卡在 `running` 或 `waiting_approval`。
- 确认 `channel_offsets.current_offset >= previous_offset`，大跳变时 `doctor` 会给出 warning。
