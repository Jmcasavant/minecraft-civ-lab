# Lab status

Last updated 2026-11-05 on Windows 11, Node 24.12.0. Branch `lab/offline-vertical-slice`, on top of pinned upstream
`775d558689f5e4eaa0f1d0d7a320035190b1fce6`. Published at https://github.com/Jmcasavant/minecraft-civ-lab.

**In one line:** the offline control plane works against mocks, and each CLI login has answered one live test request. No
Minecraft server has started, no model has played the game, and no containment has been shown to hold.

## How far each part has got

| Part                                                 | Implemented | Unit tested    | Integration tested    | Security qualified | Empirically evaluated |
| ---------------------------------------------------- | ----------- | -------------- | --------------------- | ------------------ | --------------------- |
| Pinned checkout and upstream baseline                | Yes         | n/a            | n/a                   | n/a                | n/a                   |
| Config validator, zero spend by default              | Yes         | Yes            | Yes                   | No                 | No                    |
| Mock provider                                        | Yes         | Yes            | Yes                   | n/a                | n/a                   |
| Run state machine, artifacts, redacted manifest      | Yes         | Yes            | Yes                   | No                 | No                    |
| Typed events, pure scorer, report                    | Yes         | Yes            | Yes                   | No                 | No                    |
| Stop path                                            | Yes         | Yes            | Yes, mock workers     | No                 | No                    |
| Budget ledger, across real processes with fake calls | Yes         | Yes            | Yes                   | No                 | No                    |
| Tool policy on the upstream session                  | Yes         | Yes, fake SDK  | No                    | No                 | No                    |
| CLI login transport (`claude`, `codex`)              | Yes         | Yes, fake CLIs | One live request each | No                 | No                    |
| Coordination service                                 | Yes         | Yes            | No                    | No                 | No                    |
| Paper world, telemetry plugin, real model loop       | No          | No             | No                    | No                 | No                    |

The seams for game actions, telemetry and coordination are in `docs/LAB_ARCHITECTURE.md`.

## What ran, and what it returned

| Command                                         | Result                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run lab:test`                              | 202 tests: 200 pass, 0 fail, 2 skipped                                                         |
| `npm run lab:run -- --config configs/mock.yaml` | COMPLETED (deadline). 100/100 from mock evidence, $0.000000, 0 provider requests               |
| `npm run lab:doctor`                            | No offline blockers. Live blockers listed under "Operator actions"                             |
| `npx eslint .`                                  | Exit 0                                                                                         |
| `npx prettier --check` on lab paths             | Clean. Upstream files fail on this host because of CRLF, as they do at the pin                 |
| Upstream tests, per file, pin against branch    | Identical: 283 pass, 34 fail, 4 files not clean. See `docs/UPSTREAM_AUDIT.md` for each failure |

The mock score says nothing about Minecraft or any model. The 100/100 only shows that the pipeline carries evidence from a
simulated world to a report.

The two skipped tests are not passes:

- `secret/network boundary`: needs the Linux VM.
- `no operator privileges`: needs a Paper server, and so the operator's EULA acceptance.

## Outside review

Codex (`gpt-6-astra`, `codex review --uncommitted`) reviewed the work once. It reported 1 P1 and 6 P2 findings, all confirmed by
reading the code and fixed with tests. Its output and each fix are in `docs/CODEX_REVIEW.md`. **The fixes themselves have not
had an outside review**, because the review was asked for once.

## Live transport checks

Each CLI made one request on 2026-11-05 through its own login, approved by the operator. Neither was retried. No game was
involved, and the lab metered $0 because it has no per-token price for a plan.

| Result               | `claude` 2.1.283, `claude-haiku-5-5`    | `codex-cli` 0.153.4, `gpt-6-astra`           |
| -------------------- | --------------------------------------- | -------------------------------------------- |
| Structured decision  | Parsed: `done: true`                    | Parsed: `done: true`                         |
| Model                | `claude-haiku-5-5`, reported by the CLI | **Not confirmed.** Its stream names no model |
| Usage                | 2 input, 144 output, 1,130 cache write  | 14,281 input, 31 output                      |
| Reported tools       | `StructuredOutput` only                 | Not reported                                 |
| Reported MCP servers | None                                    | Not reported                                 |
| Reported API key use | `none`                                  | Not reported                                 |
| Tool activity seen   | None                                    | None                                         |

Those checks ran before the output was corrected, so at the time Codex's `returnedModel` showed the requested id. That value was
an echo, and the command now prints `returnedModel: null` and `modelVerified: false` in this case. For Codex the lab can't detect
a substituted model. The correction has not been repeated against the live CLI, since each check was approved once.

## Not verified

- **Enforcement against a real CLI.** The API-key refusal, the API-key kill and the tool-activity kill are tested with fake CLIs
  only. One clean request shows the happy path works, not that a real violation would be caught.
- **Which Codex message item name is real.** The parser accepts both names in the references and did not log which one arrived.
- **Any game behaviour.** Upstream's game tools have not connected to a server in this project.
- **Worker containment.** `node --permission` is tested on a mock worker. It does not block network on this Node version,
  and Node does not present it as a sandbox.
- **Upstream on Linux.** The 34 upstream failures come from this host. They should be rerun where upstream's CI runs.

## Files changed

Upstream files, the only `src/` changes:

- `src/model/session.js`: optional `toolPolicy`, applied after `session_history` is added.
- `src/agent.js`: passes `toolPolicy` through.

Project files: `package.json` and `package-lock.json` (`yaml` 2.9.1 as a direct dependency, `lab:` scripts), `.gitignore`,
`.prettierignore`, `eslint.config.js`.

New: `lab/`, `tests/lab/`, `scenarios/`, `configs/`, and in `docs/`: `STATUS.md`, `OPERATIONS.md`, `SECURITY.md`,
`LAB_ARCHITECTURE.md`, `DECISIONS.md`, `EXPERIMENT_PROTOCOL.md`, `SOURCES.md`, `UPSTREAM_AUDIT.md`, `CODEX_REVIEW.md`.

## Risks

- **Codex is less contained than Claude.** `codex exec` has no documented way to remove its shell tool, and detection acts
  after an attempt starts. Do not put untrusted world text through it outside the VM.
- **Plan terms and quota.** Scripted use of a subscription login may be limited by each plan's terms and quota. The lab does
  not model quota, so `maxProviderRequests` and time are the only limits, and dollar figures stay at zero. Codex used 14,281
  input tokens on a very short prompt, so its per-request overhead is large before any game state is added.
- **Upstream dependencies.** `npm audit --omit=dev` reports 17 vulnerabilities (14 moderate, 3 high). None were changed.
- **Java.** This host has 25.0.1, and upstream's server configuration uses 21.

## Operator actions

Nothing below has been done, and each needs your decision:

1. Accept the Minecraft EULA yourself for a lab server.
2. Provide a Linux environment: enable virtualization for WSL2, or supply a disposable VM. M2 could use `createGameTools` on
   Windows with scripted actions and no model, but with no containment.
3. Check that scripted use of your Claude and ChatGPT plans is acceptable under their terms.

## Next step

Build M2: a world that implements `join`, `observe`, `execute` and `captureTerminal` over upstream's game tools on Paper,
with scripted actions and no model, plus the Java telemetry plugin. It needs actions 1 and 2.

To see what exists now:

```bash
npm run lab:run -- --config configs/mock.yaml
```
