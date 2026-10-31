![Jevpact: context lines converge at a checkpoint and continue](assets/jevpact-header.png)

# Jevpact

> Compact Codex at the right moment.

Jevpact is an open-source, local Codex plugin that watches the shape of ongoing work. At an eligible checkpoint it asks the agent to pause, invokes Codex's native compaction, observes completion, and resumes only work the agent can act on. It leaves native compaction available if Jevpact is stopped.

Free forever ♡ · by [Slopware Engineer](https://x.com/aienginerd). The plugin is free; a TypeSafe Jev API account may have its own charges.

Jevpact is a development preview for macOS Codex desktop. Its timing policy is still being evaluated; the tested private desktop interface and transcript shape may change in later Codex builds. It does not promise fewer tokens, better task outcomes, or support on web and mobile Codex.

## Install

You need macOS, the Codex desktop app, Node.js 22.13 or later, and a Jev API key from the [TypeSafe console](https://console.typesafe.ai/). The [TypeSafe API reference](https://api.typesafe.ai/docs) describes the hosted endpoint. Jevpact sends bounded task context to that endpoint for timing decisions.

After the public repository is available:

```sh
git clone https://github.com/transcendr/jevpact.git
cd jevpact
codex plugin marketplace add .
codex plugin add jevpact@jevpact
```

Set `JEV_API_KEY` or `JEV_TEST_KEY` in your shell from your secret manager, then install the supervised local service:

```sh
node plugins/jevpact/bin/jevpact.js service install
node plugins/jevpact/bin/jevpact.js service status
```

The install command saves the key in a private user file, installs two macOS LaunchAgents, starts the controller, and starts a health check. In Codex, inspect and trust the plugin's eight lifecycle hooks using `/hooks`. Open a new task after installation. Hooks attach tasks as they run. To alert if a particular task stops being watched, rerun `service install --expect-thread NATIVE_TASK_ID`.

[Installation details](docs/install.md) explain what Codex copies, where the service runs, key storage, updates, and removal.

## T3 Code

A separate macOS T3 service supports Codex and Claude threads. It discovers threads automatically, saves explicit write consent across restarts, and remains read-only when the T3 server lacks guarded maintenance support. It does not replace the Codex Desktop service. T3 must also use a Codex provider home without the Desktop Jevpact hooks; that provider isolation remains unverified.

```sh
node plugins/jevpact/bin/jevpact.js t3 install --profile local-t3 \
  --runtime-file /absolute/path/to/t3-home/userdata/server-runtime.json \
  --token-file /absolute/path/to/private/t3-token \
  --jev-key-file /absolute/path/to/private/jev-key \
  --allow-writes
node plugins/jevpact/bin/jevpact.js t3 status --profile local-t3
```

Both credential files must be private, owned by you, and mode 0600. Omit `--allow-writes` for read-only setup. [T3 setup and operation](docs/t3-transport.md) covers credentials, remote origins, stop/start, updates, configuration and removal.

## What it does

1. Trusted hooks send task and lifecycle identities to a local controller. The controller reads the local rollout incrementally and keeps a bounded view of recent visible work.
2. Above an eligibility floor, Jev judges whether the current step has a usable conclusion and whether the parent is waiting for an external result. Context pressure remains a separate fallback.
3. For an active task, the controller sends a plain-language pause request. After the final response, a clear request to defer compaction vetoes that checkpoint. Otherwise the controller requests native compaction and waits for its completion event.
4. The controller resumes a parent only when there is actionable work to do. A completed or waiting parent stays idle. Stops, new user direction, unsupported transcripts, and active native goals prevent unsafe actions.

There is no replacement summarizer. Codex performs the compaction. Jevpact decides when to request it and observes the result.

## Check it

```sh
node plugins/jevpact/bin/jevpact.js service status
node plugins/jevpact/bin/jevpact.js status
node plugins/jevpact/bin/jevpact.js history NATIVE_TASK_ID --since 2026-09-24
```

The service restarts the controller after a process exit. A separate one-shot check runs every minute and sends one macOS notification after two failed checks, then one on recovery. It checks the installed version and any task IDs configured with `--expect-thread`. macOS notification settings control whether banners and sounds are shown.

[Operations](docs/operations.md) covers diagnosis and update commands. [Privacy and data handling](docs/privacy.md) explains the external request, local history, and credentials. The [source](src/) and [tests](test/) are included in the public repository.

## Configure it

Jevpact creates `~/.jevpact/config.json` when the controller or CLI first reads it. Its editable `default` global profile starts with source defaults. If the selected global profile is missing, Jevpact restores the default binding and profile when possible; source defaults remain the fallback. Settings can apply to all tasks, a project directory, or one native task ID; named profiles can be saved and applied at those scopes. The bundled `jevpact-config` skill can walk you through options from a Codex task and change them from a natural-language request.

For a non-default `CODEX_HOME`, this local build appends a home-derived suffix to the config directory, so Strada and default Codex settings remain separate. `config show --global` reports the active path; `JEVPACT_CONFIG_HOME` overrides it.

```sh
node plugins/jevpact/bin/jevpact.js config list
node plugins/jevpact/bin/jevpact.js config tokens
node plugins/jevpact/bin/jevpact.js config show --thread current
node plugins/jevpact/bin/jevpact.js config profile set default minInputTokens 250000
node plugins/jevpact/bin/jevpact.js config set minInputTokens 250000 --project current
node plugins/jevpact/bin/jevpact.js config profile save deep-work --thread current
node plugins/jevpact/bin/jevpact.js config profile apply deep-work --project current
node plugins/jevpact/bin/jevpact.js config set resumeMessage "Continue from: {{assistant.lastBeforeCompaction}}" --thread current
```

The pause, resume, and continue-without-compaction message bodies accept dynamic tokens anywhere in their text. Tokens expand when the message is sent; `config tokens` lists the available values. Jevpact keeps fixed identifying prefixes so its transcript reader can exclude those controller messages from work evidence. See [configuration operations](docs/operations.md#configuration) for token availability, precedence, and reload behavior.

## License

Jevpact is licensed under [CC BY 4.0](LICENSE). Preferred attribution points to [Slopware Engineer on X](https://x.com/aienginerd).
