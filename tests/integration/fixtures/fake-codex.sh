#!/usr/bin/env bash

set -euo pipefail

scenario="${FAKE_CODEX_SCENARIO:-}"

emit_json() {
  printf '%s\n' "$1"
}

has_resume="false"
for arg in "$@"; do
  if [[ "$arg" == "resume" ]]; then
    has_resume="true"
    break
  fi
done

case "$scenario" in
  cancel)
    trap 'exit 0' INT TERM
    emit_json '{"type":"thread.started","thread_id":"cancel-thread"}'
    while true; do
      sleep 0.2
    done
    ;;
  recover)
    if [[ "$has_resume" == "true" ]]; then
      emit_json '{"type":"thread.started","thread_id":"mismatched-thread"}'
      exit 0
    fi

    emit_json '{"type":"thread.started","thread_id":"recovered-thread"}'
    emit_json '{"type":"item.completed","item":{"type":"agent_message","id":"item-1","text":"Recovered answer"}}'
    emit_json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    ;;
  approval)
    trap 'exit 0' INT TERM
    if [[ "$has_resume" == "true" ]]; then
      emit_json '{"type":"thread.started","thread_id":"approval-thread"}'
      emit_json '{"type":"item.completed","item":{"type":"agent_message","id":"item-approved","text":"Approved answer"}}'
      emit_json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
      exit 0
    fi

    emit_json '{"type":"thread.started","thread_id":"approval-thread"}'
    emit_json '{"type":"exec_approval_request","call_id":"call-approval","command":["git","status"],"cwd":"/workspaces/approval","reason":"workspace_write_required"}'
    while true; do
      sleep 0.2
    done
    ;;
  cwd)
    emit_json '{"type":"thread.started","thread_id":"resume-thread"}'
    emit_json "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"id\":\"item-cwd\",\"text\":\"$PWD\"}}"
    emit_json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    ;;
  resume-skip-check)
    if [[ "$has_resume" != "true" ]]; then
      printf 'expected resume invocation\n' >&2
      exit 1
    fi

    has_skip_check="false"
    for arg in "$@"; do
      if [[ "$arg" == "--skip-git-repo-check" ]]; then
        has_skip_check="true"
        break
      fi
    done

    if [[ "$has_skip_check" != "true" ]]; then
      printf 'missing --skip-git-repo-check\n' >&2
      exit 1
    fi

    emit_json '{"type":"thread.started","thread_id":"resume-skip-thread"}'
    emit_json '{"type":"item.completed","item":{"type":"agent_message","id":"item-resume-skip","text":"resume skip check present"}}'
    emit_json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    ;;
  *)
    emit_json '{"type":"thread.started","thread_id":"default-thread"}'
    emit_json '{"type":"item.completed","item":{"type":"agent_message","id":"item-default","text":"Default answer"}}'
    emit_json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    ;;
esac
