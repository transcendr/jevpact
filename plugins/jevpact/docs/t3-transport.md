# T3 guarded maintenance

`T3Reader` remains read-only. `T3Transport` adds automatic and explicit maintenance for a T3 server advertising `guardedMaintenance: 1`. Both use authenticated protocol-2 connections to the same environment. Automatic cadence counts distinct native model-request IDs: Codex response IDs correlated with native usage, and Claude message IDs shared by streaming and snapshot updates. Active pause additionally requires `guardedMaintenanceActivePause: true`. A server without that flag can perform guarded idle maintenance but receives no active pause from this adapter.

Import the components into a host that owns its Jevpact daemon. Supply the actual T3 origin, environment ID, project root, and a credential callback reading a private credential file. Keep credentials out of configuration, logs, command arguments, and source:

```js
import { readFile } from 'node:fs/promises';
import { serve } from '../src/daemon.js';
import { createT3ReaderFactory } from '../src/t3-reader.js';
import { T3Transport } from '../src/t3-transport.js';

const connection = {
  origin,
  environmentId,
  projectRoot,
  token: async () => (await readFile(privateCredentialPath, 'utf8')).trim(),
};
const daemon = await serve({
  readerFactory: createT3ReaderFactory(connection),
  transport: new T3Transport(connection),
});
```

This is a programmatic adapter. The existing CLI and managed desktop service retain their Codex Desktop setup. The daemon socket is scoped by `CODEX_HOME`; use a separately selected profile when running a T3 daemon alongside a desktop daemon. Check `alreadyRunning` before issuing requests so an existing daemon is not mistaken for this one.

Each new or restored attachment defaults to read-only. Grant writes explicitly for that attachment:

```js
await daemon.dispatch({ method: 'attach', threadId, allowWrites: true });
```

An existing attachment keeps its original grant. To change it, use `reattach` with an explicit `allowWrites: true`; omit that flag to return to read-only. Reattachment refuses while a controller operation is pending. Grants are not saved or restored across daemon restarts. Status exposes `allowWrites`. Write-enabled attachments use their resolved mode, including automatic policy by default. Read-only attachments remain in observation mode. Explicit observe/off settings and configuration reloads preserve their normal meaning.

`maintain` remains available as an explicit request and returns its operation ID. Automatic mode starts the same guarded operation when the existing policy selects a checkpoint. Observe controller decisions and status for its outcome; that response is not delivery or completion. Active work on a server advertising active-pause support receives the existing pause message, then the genuine Jev pause assessment decides whether to compact and whether actionable work remains. Deferral can continue the assignment without compaction. Claude maintenance uses SDK priority `next` without interrupting foreground work or backgrounding subagents. Ordinary user steering retains priority `now`.

Idle maintenance leaves the thread idle by default. If continuing the existing unfinished assignment is explicitly authorized, request:

```js
await daemon.dispatch({ method: 'maintain', threadId, resume: true });
```

The transport captures the original observation fence, assignment run, provider/session/native identity, operation ID, command IDs, and message IDs. Later phases retain that fence while targeting their current run and compaction item. Bounded history is read when the current projection cannot establish the preceding compaction item. The server validates the guard at acceptance and provider delivery.

An accepted command is not delivered. A delivered compact command is not completed. The controller waits for a successful native compaction item and its completed run before continuing. Duplicate item updates do not create another generation. Independent native/T3 compaction observed after a delivered pause can satisfy the pending operation; the controller waits for its terminal run and adopts it instead of issuing another compaction.

Stop, new direction, unavailable observation, and identity changes prevent continuation. Ambiguous delivery enters recovery and never retries automatically. `T3Transport.reconcile(threadId, action)` explicitly replays a receipt using the original command payload and IDs; it cannot restore a closed attachment or authorize a new continuation. A controller in recovery requires native-thread inspection and explicit human direction. Do not retry an uncertain action with new IDs.

Request counters cover native request IDs observed by this reader. A bounded initial snapshot exposes only the latest usage per provider turn, so attachment starts conservatively and does not invent missing historical requests. Repeated usage updates count once. Native child requests and compaction requests do not advance the root work cadence; completed compaction starts a fresh cadence. Context capacity comes from the selected model’s reported usage.
