# Upstream audit

Inspected and run on 2026-11-05 on Windows 11, Node 24.12.0. Only the behaviour stated here was observed. The harness has not
connected to a Minecraft server or a model in this project.

## Provenance

| Item             | Value                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Remote           | `https://github.com/yc-software/minecraft-agent-harness`                                              |
| Branch           | `main`                                                                                                |
| Commit           | `775d558689f5e4eaa0f1d0d7a320035190b1fce6` (2026-10-28)                                               |
| State at pin     | Clean. Baseline ran in a detached worktree at this commit                                             |
| License          | MIT, with Mindcraft and prismarine-viewer notices retained                                            |
| Lockfile SHA-256 | `b30557da87ddd78cc0cd79f24cfc22a157d1d1f7cd2f803ea27c32cd499cbc99` with line endings normalized to LF |

The lab adds `yaml` 2.9.1 as a direct dependency. It was already in the lockfile as a transitive dependency.

## Runtime compatibility

| Component   | Declared by upstream                  | This host                                                   |
| ----------- | ------------------------------------- | ----------------------------------------------------------- |
| Node        | `>=22.19`; CI uses 22                 | 24.12.0                                                     |
| Java        | Compose image `java21`                | 25.0.1. Not qualified with Paper                            |
| Minecraft   | 1.21.6                                | No server                                                   |
| Paper build | Latest stable at download; not pinned | Not selected                                                |
| Mineflayer  | 4.33.0                                | Installed and patched                                       |
| Pathfinder  | 2.4.5                                 | Installed and patched                                       |
| Docker      | Optional                              | Not installed                                               |
| WSL         | Not applicable                        | No distribution. WSL2 reports virtualization is not enabled |
| Platform    | CI is `ubuntu-latest`                 | **Windows: `startAgent` cannot run**                        |

**Platform limit.** `createWorkspaceTools` throws `Workspace tools require Linux descriptor paths.` on anything but Linux
(`src/tools/workspace-tools.js:323`), and `startAgent` always calls it (`src/agent.js:495`). So upstream's full agent cannot start on
this machine. `createGameTools` has no such check, and upstream's game-tool tests pass here.

## Baseline results

Install: `npm ci --ignore-scripts`, then `patch-package` (all five patches applied). Third-party install scripts did not run.
`protobufjs` and `@google/genai` declare one each. The repository's own `postinstall` is only `patch-package`.

Each test file ran alone with a 45-second limit and a 30-second per-test limit, on the pinned commit and again on the lab branch.

| Run           | Files | Pass | Fail | Files not clean |
| ------------- | ----: | ---: | ---: | --------------: |
| Pinned commit |    45 |  283 |   34 |               4 |
| Lab branch    |    45 |  283 |   34 |               4 |

The per-file counts and failing test names are identical, so the lab's upstream change introduced no regression in these tests.
All 34 failures exist at the pinned commit on this host:

| File                                 | Pass | Fail | Cause                                                                  |
| ------------------------------------ | ---: | ---: | ---------------------------------------------------------------------- |
| `test/tools/workspace-tools.test.js` |    0 |   25 | The Linux-only check above                                             |
| `test/tools/shell-tools.test.js`     |    2 |    7 | Hit the 45-second limit. The sandbox tests need a bash this host lacks |
| `test/sandbox/local.test.js`         |    0 |    1 | `/usr/bin/env: 'bash': No such file or directory`                      |
| `test/startup.test.js`               |    5 |    1 | Test expects `/` path separators; Windows produces `\`                 |

These were not fixed, because they do not affect the lab's offline slice. They should be rerun on Linux, where upstream's CI runs.

A first attempt, a single `npm test`, hung past seven minutes on this host and produced no summary, so it is not counted. A later run of
the same suite with a time limit exited with status 124 for the same reason.

- **Lint:** passes at the pinned commit.
- **Format check:** fails on 132 files at the pinned commit. `core.autocrlf` is true on this host, so the checkout has CRLF and
  Prettier expects LF. New lab files use LF and pass.
- **`npm audit --omit=dev`:** 17 vulnerabilities (14 moderate, 3 high) at the time of the audit, including `zod` below 4.6.6 and
  advisories reached through Mineflayer. None were changed. Review before any exposed deployment.

## Existing behaviour

| Area                | Finding                                                                                                                                                                 | Where                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Startup             | `bin/minecraft-agent.js` loads `.env`, merges file, env and flags with flags highest, then supervises a child                                                           | `src/cli.js:120-173`         |
| Team launcher       | Spawns one process per agent `staggerSeconds` apart (default 3), giving early agents free time. Passes the full parent environment. `sharedMachine` defaults to `local` | `src/cli.js:291-381`         |
| Session persistence | `SessionManager.continueRecent` resumes earlier sessions, so each run needs a fresh state directory                                                                     | `src/model/session.js:47`    |
| Observations        | Injected before every model call with `transformContext`, not stored in the transcript                                                                                  | `docs/architecture.md`       |
| Model transport     | pi session. Catalog model, or an OpenAI Responses endpoint through `baseUrl`, whose registered cost is zero, so pi's cost figures cannot be used for accounting         | `src/model/session.js:32,86` |
| Model limits        | `startAgent` passes `MAX_SAFE_INTEGER` for model and tool calls, with backoff forever. There is no spending admission                                                   | `src/agent.js:629-630`       |
| Action runner       | One body action at a time, with `AbortSignal`. An action that will not settle in 8 s marks the body unsafe and exits                                                    | `src/tools/game/runtime.js`  |
| Cancellation        | `stop_action`, plus late writes refused at the packet level                                                                                                             | `docs/architecture.md`       |
| Reconnect           | Supervisor restarts on reconnectable exits, up to 8 tries. A stopped lab run must not use this                                                                          | `src/cli.js:188-233`         |
| Shutdown            | `finish` allows up to 10 s before `process.exit`, above the lab's 5 s target, so the controller must kill                                                               | `src/agent.js:143`           |

## Permission surfaces

| Surface                | Finding                                                                                    | Lab response                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Default sandbox        | `e2b` with a key, else Docker, else `local`: host bash with no isolation                   | Always explicit `none`; probe forced off           |
| `run_shell` + relay    | Reaches every other tool through `invokeTool`, with a long-poll HTTP relay                 | Removed by sandbox `none` and by the allowlist     |
| `shared_exec`          | Host bash when local; root and internet on E2B                                             | No socket passed; forbidden tool                   |
| `compute_js`           | Separate Node child under SES, empty env, `cwd: '/'`. Stays present with sandbox `none`    | Forbidden tool                                     |
| Workspace tools        | Private file read, write and list. Stay present with sandbox `none`                        | Forbidden tools. `wait` is kept                    |
| `session_history`      | Appended inside the session runner, after anything `agent.js` could filter                 | Policy applies after it is added                   |
| Tools module           | `AGENT_TOOLS_MODULE` imports any file into the agent process                               | Adapter ignores environment; fails if one resolves |
| Environment and `.env` | Override config files                                                                      | The lab does not use the upstream CLI              |
| Chat guard             | Drops outgoing slash commands at the packet layer. Not a server permission                 | Must still test no-operator on a real server       |
| `dev-server.js`        | **Accepts the Minecraft EULA on your behalf**, offline mode                                | Must not be run                                    |
| `compose.yaml`         | `EULA: 'TRUE'`, publishes 25565, offline, `restart: on-failure`                            | Must not be run unchanged                          |
| Network                | Docker sandbox and E2B have network access. The agent process itself has no egress control | Not solved. See `docs/SECURITY.md`                 |

## Extension seams

| Seam                 | Use                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `createGameTools`    | Real game tools with no pi session and no platform limit. Best fit for the lab's CLI model loop |
| `toolPolicy` (added) | Final tool filter for a pi session                                                              |
| `toolsModule`        | Could add tools, cannot remove them. Not used, and it refuses name clashes                      |
| `baseUrl`            | Would route pi through a local broker. Needs an API-shaped model, so it does not fit CLI login  |
| `resolveConfig`      | Takes an explicit `env`, so upstream config can be resolved without the process environment     |

## Integration blockers

1. `startAgent` is Linux-only, and this host has no working Linux environment.
2. A real Paper server requires the operator's own acceptance of the Minecraft EULA.
3. Upstream's pi loop expects a model API with native tools. The login-based CLIs do not provide that, so the lab uses its own
   one-decision-per-request loop. That loop's real-game version (M3) is not built.
