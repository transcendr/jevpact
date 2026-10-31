# Install, update, and remove Jevpact

Jevpact is a Codex plugin made of JavaScript files and hook definitions. There is no compiled Jevpact binary. Codex copies the plugin into its versioned cache when you run `codex plugin add`; Codex then runs the installed hook script with Node.js. The local controller is a separate Node process. The optional macOS managed service starts that process at login and restarts it after a crash.

## Requirements

- macOS with the Codex desktop app. Jevpact's native control adapter was tested against the private desktop interface in Codex `0.155.0-alpha.9.2`; later builds must be checked before relying on it.
- Node.js 22.13 or later, available at a stable absolute path.
- A key for TypeSafe's hosted Jev API. Obtain access through the [TypeSafe console](https://console.typesafe.ai/) and review its [API reference](https://api.typesafe.ai/docs).
- Permission to read the current user's Codex rollout and index files, and to install per-user LaunchAgents.

## Full local install

Clone the public repository and add it as a Codex marketplace:

```sh
git clone https://github.com/transcendr/jevpact.git
cd jevpact
codex plugin marketplace add .
codex plugin add jevpact@jevpact
```

Set `JEV_API_KEY` or `JEV_TEST_KEY` in this shell through your normal secret manager. Do not put a literal key in the command line or in the repository. Install the service from this clone:

```sh
node plugins/jevpact/bin/jevpact.js service install
node plugins/jevpact/bin/jevpact.js service status
```

`service install` is idempotent. It copies the supplied key to `~/Library/Application Support/Jevpact/credential` with mode `0600`, stages a versioned JavaScript runtime in that private directory, writes two per-user LaunchAgent plists, starts the controller, waits for remembered tasks to restore, then starts the one-minute health check. The key is never written to a plist or printed. The private file is plaintext and is not stored in macOS Keychain. Keep the clone for convenient updates; the running service uses its staged runtime copy.

In Codex, open `/hooks`, inspect the Jevpact hook commands, and trust the eight lifecycle hooks. Restart Codex or open a new task so it picks up the installed plugin. Installing the plugin and trusting its hooks are separate actions. A running controller with zero attached tasks is not supervising any task.

Hooks attach active Desktop and terminal tasks automatically. T3-owned Codex sessions are excluded by their native `T3 Code` originator; use the separate [T3 service](t3-transport.md) to supervise them. Update both the plugin hooks and the controller to apply that exclusion. For an existing task, pass its native task ID to `attach`:

```sh
node plugins/jevpact/bin/jevpact.js attach NATIVE_TASK_ID
```

To make the health check alert when that task is missing, set its expected ID. Repeat `--expect-thread` for more than one task. The supplied set replaces the previous expected set; omit it on a later update to preserve the set.

```sh
node plugins/jevpact/bin/jevpact.js service install --expect-thread NATIVE_TASK_ID
```

`service install --clear-expected` clears the expected task set while leaving controller and version checks active. Jevpact stores remembered task IDs outside the OS temporary directory and restores their watchers after a controller restart. A genuine `SessionEnd` forgets the task.

## What is installed where

| Part | Location and purpose |
| --- | --- |
| Codex plugin | A versioned copy under `~/.codex/plugins/cache/<marketplace>/jevpact/<version>/`; Codex loads its hooks from that copy. |
| Controller | A versioned JavaScript runtime under `~/Library/Application Support/Jevpact/runtime/`, launched by a per-user LaunchAgent. |
| Health check | A copied `health-probe.mjs` and state file under `~/Library/Application Support/Jevpact/`, scheduled by a second LaunchAgent. |
| Credential | `~/Library/Application Support/Jevpact/credential`, readable only by the user. |
| Diagnostic history | `~/Library/Application Support/Jevpact/`, separate from the plugin cache. |

The plugin cache copy, the controller process, and trusted hooks all matter. `codex plugin add` alone does not start supervision.

## Update

From the same clone:

```sh
git pull --ff-only
codex plugin add jevpact@jevpact
node plugins/jevpact/bin/jevpact.js service update
node plugins/jevpact/bin/jevpact.js service status
```

Each published plugin change uses a new manifest version so Codex refreshes its cache. `service update` keeps the expected task set, rotates the stored key if a new `JEV_API_KEY` or `JEV_TEST_KEY` is present, replaces the managed jobs, and verifies the new controller version and task restoration. `service status` reports an update requirement when this clone's version differs from the running controller. Start a new Codex task after the plugin update to pick up changed hook definitions.

If you use a Git-backed remote marketplace rather than this local clone, refresh its snapshot with `codex plugin marketplace upgrade jevpact` before `codex plugin add`. A clone is still the simplest way to invoke the managed service command on each update.

## Remove

```sh
node plugins/jevpact/bin/jevpact.js service uninstall
codex plugin remove jevpact@jevpact
codex plugin marketplace remove jevpact
```

The service command unloads and removes its LaunchAgents, health probe, configuration, and stored key. It leaves diagnostic history and remembered task IDs for deliberate retention or deletion. Removing the Codex plugin disables its hooks. Native Codex compaction remains available throughout.
