#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

BINARY_NAME="codex-telegram-bridge"
GOOS_VALUE="${GOOS:-linux}"
GOARCH_VALUE="${GOARCH:-amd64}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_DIR}/dist}"

if [[ -z "${VERSION:-}" ]]; then
  printf 'VERSION is required.\n' >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

ASSET_BASENAME="${BINARY_NAME}_${GOOS_VALUE}_${GOARCH_VALUE}"
PACKAGE_DIR="${STAGE_DIR}/${ASSET_BASENAME}"
ARCHIVE_PATH="${OUTPUT_DIR}/${ASSET_BASENAME}.tar.gz"

mkdir -p "${PACKAGE_DIR}" "${OUTPUT_DIR}"

(
  cd "${REPO_DIR}"
  CGO_ENABLED=1 GOOS="${GOOS_VALUE}" GOARCH="${GOARCH_VALUE}" go build -trimpath -ldflags "-s -w" -o "${PACKAGE_DIR}/${BINARY_NAME}" ./cmd/bridge
)

cp "${REPO_DIR}/README.md" "${PACKAGE_DIR}/README.md"
cp "${REPO_DIR}/.env.example" "${PACKAGE_DIR}/.env.example"
printf '%s\n' "${VERSION}" >"${PACKAGE_DIR}/VERSION"

tar -C "${STAGE_DIR}" -czf "${ARCHIVE_PATH}" "${ASSET_BASENAME}"

(
  cd "${OUTPUT_DIR}"
  sha256sum "$(basename "${ARCHIVE_PATH}")" >"$(basename "${ARCHIVE_PATH}").sha256"
)

printf 'Built %s\n' "${ARCHIVE_PATH}"
