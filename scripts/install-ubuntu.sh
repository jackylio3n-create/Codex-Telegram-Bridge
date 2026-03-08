#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_USER="${SUDO_USER:-${USER:-}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
TARGET_GROUP="$(id -gn "${TARGET_USER}")"
ENV_FILE="${TARGET_HOME}/.config/codex-telegram-bridge/config.env"
SERVICE_FILE="/etc/systemd/system/codex-telegram-bridge.service"
RECONFIGURE=0
BOT_TOKEN=""
ALLOWED_USER_ID=""
WORKSPACE_ROOT=""
APP_HOME=""
CODEX_HOME=""
LOG_LEVEL=""
VERIFICATION_PASSWORD=""
EXISTING_VERIFICATION_PASSWORD_HASH=""

while (($# > 0)); do
  case "$1" in
    --reconfigure)
      RECONFIGURE=1
      shift
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --bot-token)
      BOT_TOKEN="$2"
      shift 2
      ;;
    --allowed-user-id)
      ALLOWED_USER_ID="$2"
      shift 2
      ;;
    *)
      echo "Unsupported option: $1" >&2
      exit 1
      ;;
  esac
done

load_existing_values() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    set +a
  fi

  BOT_TOKEN="${BOT_TOKEN:-${CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN:-}}"
  ALLOWED_USER_ID="${ALLOWED_USER_ID:-${CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS:-}}"
  WORKSPACE_ROOT="${WORKSPACE_ROOT:-${CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT:-${TARGET_HOME}/codex-workspaces/main}}"
  APP_HOME="${APP_HOME:-${CODEX_TELEGRAM_BRIDGE_APP_HOME:-${TARGET_HOME}/.local/share/codex-telegram-bridge}}"
  CODEX_HOME="${CODEX_HOME:-${CODEX_TELEGRAM_BRIDGE_CODEX_HOME:-${TARGET_HOME}/.codex}}"
  LOG_LEVEL="${LOG_LEVEL:-${CODEX_TELEGRAM_BRIDGE_LOG_LEVEL:-info}}"
  EXISTING_VERIFICATION_PASSWORD_HASH="${CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH:-}"
}

collect_configuration() {
  echo
  echo "Bridge configuration"
  echo "Press Enter to accept the default shown in brackets."
  echo

  BOT_TOKEN="$(prompt_secret_required "Telegram bot token" "${BOT_TOKEN}")"
  VERIFICATION_PASSWORD="$(prompt_secret_required_or_keep_existing "Telegram verification password" "${EXISTING_VERIFICATION_PASSWORD_HASH}")"
  ALLOWED_USER_ID="$(prompt_required "Allowed Telegram user ID" "${ALLOWED_USER_ID}")"
  WORKSPACE_ROOT="$(prompt_with_default "Workspace root" "${WORKSPACE_ROOT}")"
  APP_HOME="$(prompt_with_default "App home" "${APP_HOME}")"
  CODEX_HOME="$(prompt_with_default "Codex home" "${CODEX_HOME}")"
  LOG_LEVEL="$(prompt_with_default "Log level" "${LOG_LEVEL}")"
}

prompt_required() {
  local label="$1"
  local default_value="$2"
  local value=""

  while true; do
    value="$(prompt_with_default "${label}" "${default_value}")"
    if [[ -n "${value}" ]]; then
      printf '%s\n' "${value}"
      return 0
    fi

    echo "${label} is required." >&2
  done
}

prompt_secret_required() {
  local label="$1"
  local default_value="$2"
  local value=""

  while true; do
    value="$(prompt_secret_with_default "${label}" "${default_value}")"
    if [[ -n "${value}" ]]; then
      printf '%s\n' "${value}"
      return 0
    fi

    echo "${label} is required." >&2
  done
}

prompt_secret_required_or_keep_existing() {
  local label="$1"
  local existing_hash="$2"
  local value=""

  while true; do
    value="$(prompt_secret_with_existing_option "${label}" "${existing_hash}")"
    if [[ -n "${value}" || -n "${existing_hash}" ]]; then
      printf '%s\n' "${value}"
      return 0
    fi

    echo "${label} is required." >&2
  done
}

prompt_with_default() {
  local label="$1"
  local default_value="$2"
  local answer=""

  if [[ -n "${default_value}" ]]; then
    read -r -p "${label} [${default_value}]: " answer
  else
    read -r -p "${label}: " answer
  fi

  if [[ -n "${answer}" ]]; then
    printf '%s\n' "${answer}"
  else
    printf '%s\n' "${default_value}"
  fi
}

prompt_secret_with_default() {
  local label="$1"
  local default_value="$2"
  local answer=""

  if [[ -n "${default_value}" ]]; then
    read -r -s -p "${label} [hidden, press Enter to keep existing]: " answer
  else
    read -r -s -p "${label}: " answer
  fi
  echo

  if [[ -n "${answer}" ]]; then
    printf '%s\n' "${answer}"
  else
    printf '%s\n' "${default_value}"
  fi
}

prompt_secret_with_existing_option() {
  local label="$1"
  local existing_hash="$2"
  local answer=""

  if [[ -n "${existing_hash}" ]]; then
    read -r -s -p "${label} [hidden, press Enter to keep existing]: " answer
  else
    read -r -s -p "${label}: " answer
  fi
  echo

  printf '%s\n' "${answer}"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer only supports Linux." >&2
  exit 1
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian)
      ;;
    *)
      echo "This installer currently targets Ubuntu or Debian." >&2
      exit 1
      ;;
  esac
fi

if [[ -z "${TARGET_USER}" || "${TARGET_USER}" == "root" ]]; then
  echo "Run this installer as your normal login user, not as root." >&2
  exit 1
fi

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this installer without sudo. It will request sudo only when needed." >&2
  exit 1
fi

for command in sudo systemctl npm node codex; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Missing required command: ${command}" >&2
    exit 1
  fi
done

if [[ ! -f "${REPO_DIR}/package.json" ]]; then
  echo "Could not find package.json in ${REPO_DIR}." >&2
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1);'; then
  echo "Node.js 24+ is required." >&2
  exit 1
fi

if ! systemctl --version >/dev/null 2>&1; then
  echo "systemd is required for this installer." >&2
  exit 1
fi

echo "Using repository: ${REPO_DIR}"
echo "Target runtime user: ${TARGET_USER}"
echo "Config file: ${ENV_FILE}"

sudo -v

cd "${REPO_DIR}"
npm ci
load_existing_values

if ! "${CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE:-codex}" login status >/dev/null 2>&1; then
  cat <<EOF

Codex CLI is installed but not logged in for ${TARGET_USER}.

Next step:
  codex login

After login finishes, rerun:
  ./scripts/install-ubuntu.sh
EOF
  exit 1
fi

if [[ ${RECONFIGURE} -eq 1 || ! -f "${ENV_FILE}" ]]; then
  collect_configuration
  if [[ -n "${VERIFICATION_PASSWORD}" ]]; then
    CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN="${BOT_TOKEN}" \
      CODEX_TELEGRAM_BRIDGE_SETUP_VERIFICATION_PASSWORD="${VERIFICATION_PASSWORD}" \
      npm run setup -- --non-interactive \
        --config-env-file "${ENV_FILE}" \
        --allowed-user-id "${ALLOWED_USER_ID}" \
        --workspace-root "${WORKSPACE_ROOT}" \
        --app-home "${APP_HOME}" \
        --codex-home "${CODEX_HOME}" \
        --log-level "${LOG_LEVEL}"
  else
    CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN="${BOT_TOKEN}" npm run setup -- --non-interactive \
      --config-env-file "${ENV_FILE}" \
      --allowed-user-id "${ALLOWED_USER_ID}" \
      --workspace-root "${WORKSPACE_ROOT}" \
      --app-home "${APP_HOME}" \
      --codex-home "${CODEX_HOME}" \
      --log-level "${LOG_LEVEL}"
  fi
else
  echo "Reusing existing env file at ${ENV_FILE}. Use --reconfigure to edit it."
fi

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

TEMP_SERVICE_FILE="$(mktemp)"
cat >"${TEMP_SERVICE_FILE}" <<EOF
[Unit]
Description=Codex Telegram Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/npm run serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 644 "${TEMP_SERVICE_FILE}" "${SERVICE_FILE}"
rm -f "${TEMP_SERVICE_FILE}"

sudo systemctl daemon-reload
sudo systemctl enable --now codex-telegram-bridge

echo
echo "Bridge installed and started."
echo
sudo systemctl --no-pager --full status codex-telegram-bridge | sed -n '1,12p'
echo
echo "Useful commands:"
echo "  systemctl status codex-telegram-bridge"
echo "  journalctl -u codex-telegram-bridge -n 100"
echo "  cd ${REPO_DIR} && npm run doctor"
echo "  cd ${REPO_DIR} && npm run logs 100"
