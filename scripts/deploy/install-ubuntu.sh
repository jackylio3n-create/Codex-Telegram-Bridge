#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SERVICE_FILE="/etc/systemd/system/codex-telegram-bridge.service"
GO_BINARY_PATH=""
CLI_WRAPPER_PATH="/usr/local/bin/codex-telegram-bridge"
BOOTSTRAP_BINARY_PATH=""
TEMP_DOWNLOAD_DIR=""

RECONFIGURE=0
NON_INTERACTIVE=0
RELEASE_VERSION=""
RELEASE_REPO=""
RELEASE_BASE_URL=""
PLATFORM_OS=""
PLATFORM_ARCH=""
BOT_TOKEN=""
OWNER_USER_ID=""
OWNER_CHAT_ID=""
WORKSPACE_ROOT=""
APP_HOME=""
CODEX_HOME=""
LOG_LEVEL=""
VERIFICATION_PASSWORD=""
EXISTING_VERIFICATION_PASSWORD_HASH=""
TEMP_SERVICE_FILE=""
TEMP_WRAPPER_FILE=""

TARGET_USER="${SUDO_USER:-${USER:-}}"
TARGET_HOME=""
TARGET_GROUP=""
ENV_FILE=""

log() {
  printf '[install] %s\n' "$*"
}

die() {
  printf '[install] Error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${TEMP_SERVICE_FILE}" && -f "${TEMP_SERVICE_FILE}" ]]; then
    rm -f "${TEMP_SERVICE_FILE}"
  fi
  if [[ -n "${TEMP_WRAPPER_FILE}" && -f "${TEMP_WRAPPER_FILE}" ]]; then
    rm -f "${TEMP_WRAPPER_FILE}"
  fi
  if [[ -n "${BOOTSTRAP_BINARY_PATH}" && -f "${BOOTSTRAP_BINARY_PATH}" ]]; then
    rm -f "${BOOTSTRAP_BINARY_PATH}"
  fi
  if [[ -n "${TEMP_DOWNLOAD_DIR}" && -d "${TEMP_DOWNLOAD_DIR}" ]]; then
    rm -rf "${TEMP_DOWNLOAD_DIR}"
  fi
}

trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy/install-ubuntu.sh [options]

Options:
  --reconfigure             Prompt and rewrite the env file even if it already exists.
  --non-interactive         Do not prompt; rely on flags, existing env values, and defaults.
  --from-release <version>  Download a prebuilt binary from GitHub Releases.
                            Use 'latest' or a tag such as 'v1.0.0'.
  --release-repo <owner/name>
                            GitHub repo to use with --from-release.
  --release-base-url <url>  Override the release download base URL.
  --env-file <path>         Override the target env file path.
  --bot-token <token>       Provide the Telegram bot token non-interactively.
  --owner-user-id <id>      Provide the owner Telegram user ID non-interactively.
  --owner-chat-id <id>      Provide the owner Telegram chat ID non-interactively.
  --workspace-root <path>   Provide the workspace root non-interactively.
  --app-home <path>         Provide the app home non-interactively.
  --codex-home <path>       Provide the Codex home non-interactively.
  --log-level <level>       Provide the log level non-interactively.
  --verification-password <password>
                           Provide the verification password non-interactively.
  --help                    Show this help text.
EOF
}

require_value() {
  local option="$1"
  local value="${2-}"

  if [[ -z "${value}" ]]; then
    die "${option} requires a value."
  fi
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

    printf '%s is required.\n' "${label}" >&2
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

    printf '%s is required.\n' "${label}" >&2
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

    printf '%s is required.\n' "${label}" >&2
  done
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --reconfigure)
        RECONFIGURE=1
        shift
        ;;
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --from-release)
        require_value "$1" "${2-}"
        RELEASE_VERSION="$2"
        shift 2
        ;;
      --release-repo)
        require_value "$1" "${2-}"
        RELEASE_REPO="$2"
        shift 2
        ;;
      --release-base-url)
        require_value "$1" "${2-}"
        RELEASE_BASE_URL="$2"
        shift 2
        ;;
      --env-file)
        require_value "$1" "${2-}"
        ENV_FILE="$2"
        shift 2
        ;;
      --bot-token)
        require_value "$1" "${2-}"
        BOT_TOKEN="$2"
        shift 2
        ;;
      --owner-user-id)
        require_value "$1" "${2-}"
        OWNER_USER_ID="$2"
        shift 2
        ;;
      --owner-chat-id)
        require_value "$1" "${2-}"
        OWNER_CHAT_ID="$2"
        shift 2
        ;;
      --workspace-root)
        require_value "$1" "${2-}"
        WORKSPACE_ROOT="$2"
        shift 2
        ;;
      --app-home)
        require_value "$1" "${2-}"
        APP_HOME="$2"
        shift 2
        ;;
      --codex-home)
        require_value "$1" "${2-}"
        CODEX_HOME="$2"
        shift 2
        ;;
      --log-level)
        require_value "$1" "${2-}"
        LOG_LEVEL="$2"
        shift 2
        ;;
      --verification-password)
        require_value "$1" "${2-}"
        VERIFICATION_PASSWORD="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unsupported option: $1"
        ;;
    esac
  done
}

ensure_supported_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "This installer only supports Linux."

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release

    case "${ID:-}" in
      ubuntu|debian)
        ;;
      *)
        die "This installer currently targets Ubuntu or Debian."
        ;;
    esac
  fi
}

resolve_target_user_context() {
  [[ -n "${TARGET_USER}" ]] || die "Could not determine the target login user."
  [[ "${TARGET_USER}" != "root" ]] || die "Run this installer as your normal login user, not as root."
  [[ "${EUID}" -ne 0 ]] || die "Run this installer without sudo. It will request sudo only when needed."

  TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
  [[ -n "${TARGET_HOME}" ]] || die "Could not resolve the home directory for ${TARGET_USER}."

  TARGET_GROUP="$(id -gn -- "${TARGET_USER}")"
  [[ -n "${TARGET_GROUP}" ]] || die "Could not resolve the primary group for ${TARGET_USER}."

  if [[ -z "${ENV_FILE}" ]]; then
    ENV_FILE="${TARGET_HOME}/.config/codex-telegram-bridge/config.env"
  fi
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 || die "Missing required command: ${command_name}"
}

ensure_prerequisites() {
  require_command getent
  require_command id
  require_command sudo
  require_command systemctl
  require_command codex
  require_command mktemp
  require_command install
  require_command tar

  if [[ -n "${RELEASE_VERSION}" ]]; then
    require_command curl
    require_command sha256sum
  else
    require_command go
    [[ -f "${REPO_DIR}/go.mod" ]] || die "Could not find go.mod in ${REPO_DIR}."
  fi

  systemctl --version >/dev/null 2>&1 || die "systemd is required for this installer."
}

infer_release_repo() {
  if [[ -n "${RELEASE_REPO}" ]]; then
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi

  local remote_url=""
  remote_url="$(git -C "${REPO_DIR}" config --get remote.origin.url 2>/dev/null || true)"
  if [[ -z "${remote_url}" ]]; then
    return 0
  fi

  case "${remote_url}" in
    git@github.com:*.git)
      RELEASE_REPO="${remote_url#git@github.com:}"
      RELEASE_REPO="${RELEASE_REPO%.git}"
      ;;
    https://github.com/*/*.git)
      RELEASE_REPO="${remote_url#https://github.com/}"
      RELEASE_REPO="${RELEASE_REPO%.git}"
      ;;
    https://github.com/*/*)
      RELEASE_REPO="${remote_url#https://github.com/}"
      ;;
  esac
}

detect_platform() {
  local machine_arch
  machine_arch="$(uname -m)"
  case "${machine_arch}" in
    x86_64|amd64)
      PLATFORM_ARCH="amd64"
      ;;
    aarch64|arm64)
      PLATFORM_ARCH="arm64"
      ;;
    *)
      die "Unsupported CPU architecture: ${machine_arch}"
      ;;
  esac

  PLATFORM_OS="linux"
}

load_existing_values() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    set +a
  fi

  BOT_TOKEN="${BOT_TOKEN:-${CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN:-}}"
  OWNER_USER_ID="${OWNER_USER_ID:-${CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID:-}}"
  OWNER_CHAT_ID="${OWNER_CHAT_ID:-${CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID:-}}"
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
  OWNER_USER_ID="$(prompt_required "Owner Telegram user ID" "${OWNER_USER_ID}")"
  OWNER_CHAT_ID="$(prompt_with_default "Owner Telegram chat ID (optional)" "${OWNER_CHAT_ID}")"
  WORKSPACE_ROOT="$(prompt_with_default "Workspace root" "${WORKSPACE_ROOT}")"
  APP_HOME="$(prompt_with_default "App home" "${APP_HOME}")"
  CODEX_HOME="$(prompt_with_default "Codex home" "${CODEX_HOME}")"
  LOG_LEVEL="$(prompt_with_default "Log level" "${LOG_LEVEL}")"
}

verify_codex_login() {
  local codex_executable="${CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE:-codex}"

  if ! "${codex_executable}" login status >/dev/null 2>&1; then
    cat <<EOF

Codex CLI is installed but not logged in for ${TARGET_USER}.

Next step:
  codex login

After login finishes, rerun:
  ./scripts/deploy/install-ubuntu.sh
EOF
    exit 1
  fi
}

release_asset_basename() {
  printf 'codex-telegram-bridge_%s_%s.tar.gz\n' "${PLATFORM_OS}" "${PLATFORM_ARCH}"
}

release_asset_url() {
  local asset_name
  asset_name="$(release_asset_basename)"

  if [[ -n "${RELEASE_BASE_URL}" ]]; then
    printf '%s/%s\n' "${RELEASE_BASE_URL%/}" "${asset_name}"
    return 0
  fi

  [[ -n "${RELEASE_REPO}" ]] || die "--release-repo is required when --from-release is used and the Git remote cannot be inferred."

  if [[ "${RELEASE_VERSION}" == "latest" ]]; then
    printf 'https://github.com/%s/releases/latest/download/%s\n' "${RELEASE_REPO}" "${asset_name}"
  else
    printf 'https://github.com/%s/releases/download/%s/%s\n' "${RELEASE_REPO}" "${RELEASE_VERSION}" "${asset_name}"
  fi
}

prepare_bootstrap_binary() {
  BOOTSTRAP_BINARY_PATH="$(mktemp)"

  if [[ -n "${RELEASE_VERSION}" ]]; then
    TEMP_DOWNLOAD_DIR="$(mktemp -d)"
    local asset_name asset_url checksum_url archive_path checksum_path extracted_binary
    asset_name="$(release_asset_basename)"
    asset_url="$(release_asset_url)"
    checksum_url="${asset_url}.sha256"
    archive_path="${TEMP_DOWNLOAD_DIR}/${asset_name}"
    checksum_path="${archive_path}.sha256"

    log "Downloading release asset: ${asset_url}"
    curl -fsSL "${asset_url}" -o "${archive_path}"
    curl -fsSL "${checksum_url}" -o "${checksum_path}"
    (
      cd "${TEMP_DOWNLOAD_DIR}"
      sha256sum -c "$(basename "${checksum_path}")"
    )
    tar -xzf "${archive_path}" -C "${TEMP_DOWNLOAD_DIR}"
    extracted_binary="$(find "${TEMP_DOWNLOAD_DIR}" -type f -name codex-telegram-bridge | head -n 1)"
    [[ -n "${extracted_binary}" ]] || die "Downloaded archive did not contain codex-telegram-bridge"
    install -m 755 "${extracted_binary}" "${BOOTSTRAP_BINARY_PATH}"
    return 0
  fi

  log "Building bootstrap binary from local source"
  go build -o "${BOOTSTRAP_BINARY_PATH}" ./cmd/bridge
  chmod 755 "${BOOTSTRAP_BINARY_PATH}"
}

run_setup() {
  if [[ ${RECONFIGURE} -eq 1 || ! -f "${ENV_FILE}" ]]; then
    if [[ ${NON_INTERACTIVE} -ne 1 ]]; then
      collect_configuration
    fi

    local -a setup_cmd=(
      setup --non-interactive
      --config-env-file "${ENV_FILE}"
      --bot-token "${BOT_TOKEN}"
      --owner-user-id "${OWNER_USER_ID}"
      --workspace-root "${WORKSPACE_ROOT}"
      --app-home "${APP_HOME}"
      --codex-home "${CODEX_HOME}"
      --log-level "${LOG_LEVEL}"
    )

    if [[ -n "${OWNER_CHAT_ID}" ]]; then
      setup_cmd+=(--owner-chat-id "${OWNER_CHAT_ID}")
    fi

    if [[ -n "${VERIFICATION_PASSWORD}" ]]; then
      CODEX_TELEGRAM_BRIDGE_SETUP_VERIFICATION_PASSWORD="${VERIFICATION_PASSWORD}" "${BOOTSTRAP_BINARY_PATH}" "${setup_cmd[@]}"
    else
      "${BOOTSTRAP_BINARY_PATH}" "${setup_cmd[@]}"
    fi
  else
    log "Reusing existing env file at ${ENV_FILE}. Use --reconfigure to edit it."
  fi
}

install_cli_wrapper() {
  TEMP_WRAPPER_FILE="$(mktemp)"

  cat >"${TEMP_WRAPPER_FILE}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${GO_BINARY_PATH}" --config-env-file "${ENV_FILE}" "\$@"
EOF

  sudo install -m 755 "${TEMP_WRAPPER_FILE}" "${CLI_WRAPPER_PATH}"
}

install_service() {
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
WorkingDirectory=${APP_HOME}
EnvironmentFile=${ENV_FILE}
ExecStart=${CLI_WRAPPER_PATH} serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

  sudo install -m 644 "${TEMP_SERVICE_FILE}" "${SERVICE_FILE}"
  sudo chown "${TARGET_USER}:${TARGET_GROUP}" "${ENV_FILE}"
  sudo chmod 600 "${ENV_FILE}"
  sudo systemctl daemon-reload
  sudo systemctl enable --now codex-telegram-bridge
}

install_binary() {
  GO_BINARY_PATH="${APP_HOME}/bin/codex-telegram-bridge"

  mkdir -p "$(dirname "${GO_BINARY_PATH}")"
  install -m 755 "${BOOTSTRAP_BINARY_PATH}" "${GO_BINARY_PATH}"
}

post_install_checks() {
  local attempt

  for attempt in $(seq 1 15); do
    if sudo systemctl is-active --quiet codex-telegram-bridge; then
      break
    fi
    sleep 1
  done

  if ! sudo systemctl is-active --quiet codex-telegram-bridge; then
    sudo systemctl --no-pager --full status codex-telegram-bridge || true
    sudo journalctl -u codex-telegram-bridge -n 80 --no-pager || true
    die "Service failed to become active."
  fi

  if ! codex-telegram-bridge doctor; then
    sudo systemctl --no-pager --full status codex-telegram-bridge || true
    sudo journalctl -u codex-telegram-bridge -n 80 --no-pager || true
    die "Post-install doctor check failed."
  fi
}

main() {
  parse_args "$@"
  ensure_supported_platform
  resolve_target_user_context
  infer_release_repo
  detect_platform
  ensure_prerequisites

  log "Using repository: ${REPO_DIR}"
  log "Target runtime user: ${TARGET_USER}"
  log "Config file: ${ENV_FILE}"
  if [[ -n "${RELEASE_VERSION}" ]]; then
    log "Install source: GitHub Release ${RELEASE_VERSION} (${PLATFORM_OS}/${PLATFORM_ARCH})"
  else
    log "Install source: local build"
  fi

  sudo -v

  cd "${REPO_DIR}"
  load_existing_values
  prepare_bootstrap_binary
  verify_codex_login
  run_setup

  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a

  install_binary
  install_cli_wrapper
  install_service
  post_install_checks

  echo
  echo "Bridge installed, started, and self-checked."
  echo
  sudo systemctl --no-pager --full status codex-telegram-bridge | sed -n '1,12p'
  echo
  echo "Useful commands:"
  echo "  systemctl status codex-telegram-bridge"
  echo "  journalctl -u codex-telegram-bridge -n 100"
  echo "  codex-telegram-bridge status"
  echo "  codex-telegram-bridge doctor"
  echo "  codex-telegram-bridge logs 100"
}

main "$@"
