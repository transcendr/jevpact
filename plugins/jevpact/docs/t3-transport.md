# Jevpact on T3 Code

The macOS T3 service runs alongside the Codex Desktop service. Every command requires a named T3 profile. Its LaunchAgents, socket, installed runtime, credentials, configuration and history are separate from Desktop, including when `CODEX_HOME` is set.

## Install and run

Update the Desktop plugin hooks and controller from this revision before running both services together. Both reject Codex rollouts whose native session metadata identifies the originator as `T3 Code`, including remembered attachments. That marker already exists on unpatched T3; exclusion does not depend on the T3 service or guarded-maintenance capability. Desktop and terminal Codex sessions continue through the existing attachment path. A separate provider `CODEX_HOME` is used for isolated testing; the service profile itself does not change the provider home.

Use Node.js 22.13 or later. Have the T3 server running and obtain a bearer credential for that environment with permission to observe threads and, for automatic maintenance, dispatch guarded maintenance. Put the raw T3 credential and Jev API key in separate files owned by you, with mode 0600. Pass file paths; never put secret values in arguments or configuration.

From this repository:

```sh
node plugins/jevpact/bin/jevpact.js t3 install --profile local-t3 \
  --runtime-file /absolute/path/to/t3-home/userdata/server-runtime.json \
  --token-file /absolute/path/to/private/t3-token \
  --jev-key-file /absolute/path/to/private/jev-key \
  --allow-writes
node plugins/jevpact/bin/jevpact.js t3 status --profile local-t3
```

`--runtime-file` discovers the origin from T3's runtime metadata and refreshes it on reconnection. For a remote server, use `--origin https://your-t3-origin` instead. The environment ID is discovered from the authenticated server and pinned to the profile. A different environment requires another profile. This service connects directly to that origin; relay pairing is outside this adapter.

Omit `--allow-writes` for read-only setup. Consent is saved across daemon restarts and updates. `t3 update --read-only --profile local-t3` revokes it. Every connection checks server support again, and each maintenance operation also checks it. A server without guarded maintenance remains read-only even with saved consent. Status explains this; the adapter never substitutes ordinary messages for missing maintenance support.

```sh
node plugins/jevpact/bin/jevpact.js t3 stop --profile local-t3
node plugins/jevpact/bin/jevpact.js t3 start --profile local-t3
node plugins/jevpact/bin/jevpact.js t3 update --profile local-t3
node plugins/jevpact/bin/jevpact.js t3 status --profile local-t3 --json
node plugins/jevpact/bin/jevpact.js t3 uninstall --profile local-t3
```

Installation copies both credentials into the profile's private state directory. Later starts and updates use those files. Supply `--token-file` or `--jev-key-file` again to rotate a credential. Uninstall removes both LaunchAgents, the staged runtimes and the stored credentials; diagnostic history and policy settings remain in the T3 profile. It does not uninstall Desktop Jevpact.

The labels are `com.slopware.jevpact.t3-PROFILE.controller` and `.health`. State is in `~/Library/Application Support/Jevpact-t3-PROFILE`; policy settings are in `~/.jevpact-t3-PROFILE/config.json`. The socket uses a profile-derived hash to fit macOS Unix socket paths. T3 commands ignore ambient Desktop config/history overrides.

## Attachment, settings and status

The service tracks all unarchived threads in the configured environment. Codex and Claude assignments enter detailed observation when they run. Archive and delete remove attachments. Other providers and subagent children appear as ineligible; children remain managed through their parent. T3 restart reconnects without a daemon restart and checks the pinned environment and capabilities again.

One authenticated RPC socket carries a global shell stream and the detailed streams for active work. Idle threads retain their observed state without a detailed stream. A detailed stream remains open through a pending maintenance cycle, then closes when the controller is quiescent. This avoids a socket or live server subscription per idle thread while preserving request cadence and compaction baselines across turns. T3's marked project-metadata refreshes do not replace the thread catalog.

Plain status lists each attachment and explains read-only, disabled, missing request identity, missing usage, insufficient cadence or growth, unsupported provider, and recovery states. JSON status also exposes profile paths, consent, capabilities, detailed-subscription count, and per-thread configuration keys. If the latest usage lacks a native request ID, automatic policy is ineligible until identified usage arrives. Historical request counts do not authorize a decision on unidentified current usage. JSON status exposes `identityGate.checks` and `identityGate.blocked` for each attachment since the daemon started. These count automatic identity-gate checks, including startup and idle periods without current usage; they are not counts of Jev API requests.

Use the existing settings mechanism with a raw T3 thread ID or an absolute project path:

```sh
node plugins/jevpact/bin/jevpact.js t3 config set mode off \
  --thread THREAD_ID --profile local-t3
node plugins/jevpact/bin/jevpact.js t3 config clear \
  --thread THREAD_ID --profile local-t3
node plugins/jevpact/bin/jevpact.js t3 config set mode off \
  --project /absolute/path/to/workspace --profile local-t3
node plugins/jevpact/bin/jevpact.js t3 config clear \
  --project /absolute/path/to/workspace --profile local-t3
```

The CLI scopes thread IDs to the profile's environment. `current` selectors are unavailable on T3; they belong to the Desktop host. Off and observe settings retain their usual meanings and reload without a service restart.

## Guarded transport API

`T3Reader` remains read-only. Programmatic hosts can still construct `createT3ReaderFactory`, `T3Transport` and `serve`. Their explicit attachment grants default to read-only; the managed T3 service restores setup consent when it discovers threads. A programmatic host owns its own discovery and consent persistence.

Automatic maintenance requires `guardedMaintenance: 1`. Active pause also requires `guardedMaintenanceActivePause: true`. Cadence counts distinct native request IDs: Codex response IDs from canonical usage records at the native thread's own rollout path, and Claude message IDs shared by streaming and snapshot updates.

`maintain` remains available as an explicit request and returns its operation ID. Automatic mode starts the same guarded operation when the existing policy selects a checkpoint. Observe controller decisions and status for its outcome; that response is not delivery or completion. Active work on a server advertising active-pause support receives the existing pause message, then the genuine Jev pause assessment decides whether to compact and whether actionable work remains. Deferral can continue the assignment without compaction. Claude maintenance uses SDK priority `next` without interrupting foreground work or backgrounding subagents. Ordinary user steering retains priority `now`.

Idle maintenance leaves the thread idle by default. If continuing the existing unfinished assignment is explicitly authorized, request:

```js
await daemon.dispatch({ method: 'maintain', threadId, resume: true });
```

The transport captures the original observation fence, assignment run, provider/session/native identity, operation ID, command IDs, and message IDs. Later phases retain that fence while targeting their current run and compaction item. Bounded history is read when the current projection cannot establish the preceding compaction item. The server validates the guard at acceptance and provider delivery.

An accepted command is not delivered. A delivered compact command is not completed. The controller waits for a successful native compaction item and its completed run before continuing. Duplicate item updates do not create another generation. Independent native/T3 compaction observed after a delivered pause can satisfy the pending operation; the controller waits for its terminal run and adopts it instead of issuing another compaction.

Stop, new direction, unavailable observation, and identity changes prevent continuation. Ambiguous delivery enters recovery and never retries automatically. `T3Transport.reconcile(threadId, action)` explicitly replays a receipt using the original command payload and IDs; it cannot restore a closed attachment or authorize a new continuation. A controller in recovery requires native-thread inspection and explicit human direction. Do not retry an uncertain action with new IDs.

Request counters cover native request IDs observed by this reader. A bounded initial snapshot exposes only the latest usage per provider turn, so attachment starts conservatively and does not invent missing historical requests. Repeated usage updates count once. Native child requests and compaction requests do not advance the root work cadence; completed compaction starts a fresh cadence. Context capacity comes from the selected model’s reported usage.

Programmatic per-thread settings use `t3ConfigThreadId(environmentId, threadId)` exported by `src/config.js`. The reader factory exposes the same key as `factory.configThreadId(threadId)`, and the daemon resolves that key on attachment and configuration reload. Save overrides under `document.threads[key].settings` with the existing configuration API, or pass the key to `config set ... --thread KEY`. The key includes both environment and thread identity; it does not grant writes.

The T3 Codex reader can still omit a final canonical usage record flushed after its last usage notification. Its current-turn filter drops that record when a later turn drains the file. Counts therefore remain conservative. Fixing this requires late usage to retain the completed provider turn's identity; the managed service does not infer request identities from usage values or event counts.
