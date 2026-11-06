# Lab architecture

This is the lab's design. `docs/architecture.md` covers the upstream harness.

```text
Operator CLI (lab/cli)
        |
Trusted controller (lab/controller)  -- control.sqlite: run state, stop requests, action ids
   |        |          |         \
 broker   world      action      event log (events.jsonl, written only by the controller)
   |      (mock now)  gate            |
 ledger.sqlite         |          evaluator (pure) -> score.json, report.md
 CLI login or mock     |
                 worker processes A-D (IPC only; identity = channel)
```

## How a run moves

`CREATED -> PREFLIGHT -> PREPARED -> READY -> RUNNING -> STOPPING -> FINALIZING -> COMPLETED | ABORTED | INVALID`

Each transition commits to SQLite before the run moves on. Any state before `RUNNING` can go straight to `STOPPING`.

- **PREFLIGHT** refuses paid and subscription runs today, unknown scorers, unsafe allowlists and a wrong upstream commit.
- **PREPARED** creates fresh per-run state and opens the immutable ledger partition.
- **READY** starts workers and waits for each to prove its token. All join, the clock starts once, and every worker is
  released in the same turn. Upstream's `staggerSeconds` is not used, because it gives the first agent free work.
- **STOPPING** closes action and model admission first. At a normal end the terminal snapshot comes next, while the team is
  still connected, and workers stop after. In an emergency the workers stop first and the snapshot is missing, which makes
  the affected criteria `unsupported`.
- **FINALIZING** scores from recorded events, retains open liability, and writes the report, manifest and hashes.

| End reason           | Execution state | Why                                                  |
| -------------------- | --------------- | ---------------------------------------------------- |
| `deadline`           | COMPLETED       | INVALID if the terminal snapshot or evidence is lost |
| `budget_exhausted`   | COMPLETED       | Running out of budget is a valid result              |
| `operator_stop`      | ABORTED         |                                                      |
| `controller_failure` | ABORTED         | Closed on the next controller start, never resumed   |
| `preflight_failed`   | ABORTED         |                                                      |
| `startup_failed`     | ABORTED         |                                                      |
| `integrity_breach`   | INVALID         | Bad identity, or a model CLI attempting a tool       |

Execution state is separate from benchmark success. A valid run can score zero.

## Evidence

Only one source and quality can move a score: `paper`/`authoritative` for real runs and `mock-server`/`mock` for mock
runs. Mock evidence cannot satisfy a real run, and agent claims are stored but ignored. Per-source sequence numbers expose
lost or duplicated events, which turn event-based criteria `unsupported`.

## Model transport

The broker asks for one structured decision per request: `{ done, tool, argsJson, note }`. Tools stay off inside the CLI, so
the lab, not the CLI, executes any game action. This replaces upstream's pi session for CLI-backed agents, because pi expects
a model API with native tool calling. Limits are `maxProviderRequests` and time. A subscription has no per-token price the
lab can verify, so dollars stay at zero and plan quota is not modelled.

## Seams for the next milestones

| Seam                                                   | File                                    | Next step                                                      |
| ------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------- |
| World: `join`, `observe`, `execute`, `captureTerminal` | `lab/adapter/mock-world.js`             | M2: an implementation that drives upstream game tools on Paper |
| Upstream startup without its CLI                       | `lab/adapter/upstream.js`               | M2: call `startAgent` or `createGameTools` with these options  |
| Final tool list                                        | `toolPolicy` in `src/model/session.js`  | Use if a pi session is kept for any provider                   |
| Server evidence                                        | Events in `lab/evaluator/settlement.js` | M2: the Java telemetry plugin must emit these types            |
| Model loop                                             | `lab/broker/cli-provider.js`            | M3: real worker loop with bounded history                      |
| Coordination                                           | `lab/coordination/service.js`           | M4: expose through worker RPC, and fence tool admission        |
