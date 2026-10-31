# Operate Jevpact

Run these commands from the public repository clone. The service command is macOS only; the `status`, `attach`, and `history` commands work directly with the local controller.

```sh
node plugins/jevpact/bin/jevpact.js service status
node plugins/jevpact/bin/jevpact.js status
node plugins/jevpact/bin/jevpact.js history NATIVE_TASK_ID --since 2026-09-24
```

`service status --json` reports whether both LaunchAgents are loaded, the configured and running versions, whether expected tasks are watched, and the last health state. `status --json` reports each attached task's observation mode, token usage, recent decisions, and any attachment failure. It can show a transient `restoring` count immediately after startup. Wait for restoration to finish before judging a missing watcher.

The controller LaunchAgent uses `RunAtLoad` and `KeepAlive`. The health LaunchAgent runs at load and every 60 seconds. Its probe checks the controller RPC, its version, and any expected task IDs. The probe requests only compact health fields for those expected tasks, so decision history cannot inflate the reply or produce a false connection failure. It sends one local macOS failure notification after two consecutive failed checks and one recovery notification after a healthy check. The state is in `~/Library/Application Support/Jevpact/health-state.json`; the private error logs in that directory are `controller.stderr.log` and `health.stderr.log`. macOS notification settings and Focus control whether a banner or sound is visible.

If the controller is running but an expected task is absent, check the task ID, whether its Codex session ended, and `status --json` for `lastAttachmentFailure`. If the task is still active, reattach it with `attach NATIVE_TASK_ID`. If the expected task has ended intentionally, run `service install --clear-expected` or set the remaining expected IDs. Hooks for a new Codex task must be trusted in `/hooks` before they can attach it.

Use `service update` after installing a new plugin version. Running `jevpact stop` against a managed controller would only make launchd restart it, so use `service uninstall` to stop managed supervision. A manually started controller can still be stopped with `jevpact stop`.

Diagnostic history is a local 30-day, 5 GB rolling store. It contains exact redacted Jev request and response records, policy decisions, and native completion observations. Use `history --stats` to inspect retention and dropped records. A transient diagnostic database error appears in `status` but does not by itself mean the controller stopped. [Privacy and data handling](privacy.md) explains what those records can contain.

The timing policy remains experimental. A hook installation, a model answer, or a successful compaction request is not proof that native compaction completed or that the work resumed. The controller records each of those stages separately. A task with an active native Codex goal is not eligible for automatic pause or compaction.

## Configuration

`~/.jevpact/config.json` is created when the controller or CLI first reads it. Its pre-made `default` global profile contains the source defaults and is editable. If the selected global profile or the default profile entry is missing, Jevpact restores the default binding and entry when possible; source defaults remain the fallback if the repair cannot be saved. `config list` shows common settings first and advanced settings afterward; `config show` includes each effective value and its source. The bundled `jevpact-config` skill uses these commands to explain and change settings when asked in a Codex task.

In this local dual-profile build, a non-default `CODEX_HOME` gets a separate config directory with a suffix derived from its absolute path. Use `config show --global` to see it. `JEVPACT_CONFIG_HOME` still overrides the default location.

```sh
node plugins/jevpact/bin/jevpact.js config list
node plugins/jevpact/bin/jevpact.js config tokens
node plugins/jevpact/bin/jevpact.js config show --thread current
node plugins/jevpact/bin/jevpact.js config set mode observe --project current
node plugins/jevpact/bin/jevpact.js config set pauseMessage "Finish this connected step, then end the turn." --thread current
node plugins/jevpact/bin/jevpact.js config set resumeMessage "Continue from: {{assistant.lastBeforeCompaction}}" --thread current
node plugins/jevpact/bin/jevpact.js config reset mode --project current
```

`--thread current` verifies `CODEX_THREAD_ID` against the local native task index. `--project current` uses that task's recorded working directory, resolving a Git worktree to its main checkout so sibling worktrees share project settings. A project rule applies to that directory and its descendants; the most specific matching project path wins. Settings resolve as source defaults, the selected global profile and overrides, the matching project profile and overrides, then the task profile and overrides.
`config clear --thread current` removes all overrides and the profile binding for this task; `config clear --project current` does the same for its project path.

```sh
node plugins/jevpact/bin/jevpact.js config profile show default
node plugins/jevpact/bin/jevpact.js config profile set default minInputTokens 250000
node plugins/jevpact/bin/jevpact.js config profile unset default minInputTokens
node plugins/jevpact/bin/jevpact.js config profile save deep-work --thread current
node plugins/jevpact/bin/jevpact.js config profile apply deep-work --project current
node plugins/jevpact/bin/jevpact.js config profile set deep-work minInputTokens 300000
node plugins/jevpact/bin/jevpact.js config profile list
node plugins/jevpact/bin/jevpact.js config profile show deep-work
```

Saving a profile from a task or project copies its effective scopeable values; saving from global includes global-only history values. An applied profile remains linked, so later edits update its users unless a value is overridden at that scope. `profile clear --project PATH` removes a project binding; `profile clear --global` selects `default` again. The `default` profile cannot be deleted through the CLI, and manual deletion is repaired on the next read. Other unbound profiles can be deleted. A profile containing global-only values cannot be applied to a project or task.

Each write reports whether the file was saved and whether the running controller reloaded. A delivered pause keeps its current settings until that action resolves; the controller then applies the new ones. Changes to `watchTranscript`, `allowHookFallback`, or `maxLineBytes` need `config reattach --thread current` after any controller action finishes. Changes to `historyRetentionDays`, `historyMaxBytes`, or `historyDirectory` need a controller restart. The managed service reads the same config file on startup; `service update` restarts it after installing or changing restart-only settings.

`mode observe` evaluates and records candidate checkpoints without pausing or compacting. `mode off` leaves an attached task observable but performs no assessment or Jevpact action. Custom `pauseMessage`, `resumeMessage`, and `deferMessage` values replace the body of those controller messages. Their fixed Jevpact prefixes remain in the sent text so they are excluded from timing evidence.

Message bodies accept `{{token.name}}` anywhere; `config tokens` lists names and `:N` variants for the last 1-10 prompts, assistant messages, or tool calls. The body is validated when saved, and tokens expand once when the message is sent. An unavailable value appears as `[unavailable: token.name]`; use `\{{` for literal `{{`. Rendered dynamic content is bounded to 20,000 characters while preserving the surrounding template text. `{{pause.wrapUp}}` exists after the pause turn on defer or resume; `{{assistant.lastBeforeCompaction}}` is frozen just before native compaction and exists on resume. Resume context counters refer to that pre-compaction checkpoint. `{{user.latestPrompt}}` selects direct user input, while `{{work.latestDirection}}` can include a delegated or scheduled direction.

Tool tokens use recent observed rollout records. `tools.recentCalls:N` includes bounded call inputs and whether a result was observed; `tools.pendingCalls` means no result was observed for those recent calls, not that they are definitely still running. `tools.lastResult` includes a bounded textual output excerpt. These tool details stay out of the Jev decision packet unless quoted by an assistant or user; using a tool token copies them into the Codex message. Native compaction is opaque, so `{{compaction.recordText}}` is rejected rather than presented as a readable summary.

The [programmatic T3 adapter](t3-transport.md) supports automatic and explicit guarded maintenance on a patched T3 server. Attachments default to read-only; enabling writes allows the configured automatic policy.
