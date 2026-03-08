$scenario = $env:FAKE_CODEX_SCENARIO

function Emit-Json([string] $payload) {
  [Console]::Out.WriteLine($payload)
  [Console]::Out.Flush()
}

switch ($scenario) {
  "cancel" {
    Emit-Json '{"type":"thread.started","thread_id":"cancel-thread"}'
    while ($true) {
      Start-Sleep -Milliseconds 200
    }
  }
  "recover" {
    if ($args -contains "resume") {
      Emit-Json '{"type":"thread.started","thread_id":"mismatched-thread"}'
      exit 0
    }

    Emit-Json '{"type":"thread.started","thread_id":"recovered-thread"}'
    Emit-Json '{"type":"item.completed","item":{"type":"agent_message","id":"item-1","text":"Recovered answer"}}'
    Emit-Json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
  }
  "approval" {
    if ($args -contains "resume") {
      Emit-Json '{"type":"thread.started","thread_id":"approval-thread"}'
      Emit-Json '{"type":"item.completed","item":{"type":"agent_message","id":"item-approved","text":"Approved answer"}}'
      Emit-Json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
      exit 0
    }

    Emit-Json '{"type":"thread.started","thread_id":"approval-thread"}'
    Emit-Json '{"type":"exec_approval_request","call_id":"call-approval","command":["git","status"],"cwd":"/workspaces/approval","reason":"workspace_write_required"}'
    while ($true) {
      Start-Sleep -Milliseconds 200
    }
  }
  "cwd" {
    Emit-Json '{"type":"thread.started","thread_id":"resume-thread"}'
    Emit-Json ('{"type":"item.completed","item":{"type":"agent_message","id":"item-cwd","text":"' + (Get-Location).Path.Replace('\', '\\') + '"}}')
    Emit-Json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
  }
  "resume-skip-check" {
    if (-not ($args -contains "resume")) {
      [Console]::Error.WriteLine("expected resume invocation")
      exit 1
    }

    if (-not ($args -contains "--skip-git-repo-check")) {
      [Console]::Error.WriteLine("missing --skip-git-repo-check")
      exit 1
    }

    Emit-Json '{"type":"thread.started","thread_id":"resume-skip-thread"}'
    Emit-Json '{"type":"item.completed","item":{"type":"agent_message","id":"item-resume-skip","text":"resume skip check present"}}'
    Emit-Json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
  }
  default {
    Emit-Json '{"type":"thread.started","thread_id":"default-thread"}'
    Emit-Json '{"type":"item.completed","item":{"type":"agent_message","id":"item-default","text":"Default answer"}}'
    Emit-Json '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
    exit 0
  }
}
