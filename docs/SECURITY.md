# Lab security

Status words: **implemented** (code exists), **tested** (automated test against mocks or fakes), **qualified** (shown to
hold in the real target environment). Nothing in this project is qualified yet. Passing tests here are not evidence of
containment.

## Trust boundaries

| Boundary                            | State                 | How                                                                                               |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| Final tool list in the real session | Tested with fake SDK  | `toolPolicy` seam in `src/model/session.js`, applied after `session_history` is added             |
| Tool admission for lab actions      | Tested                | `lab/adapter/action-gate.js`: frozen allowlist, schema, run id, deadline, one action per body     |
| Identity                            | Tested                | Actor comes from the worker's IPC channel. `actorId` in a request fails validation                |
| Worker environment                  | Tested                | `buildWorkerEnv`: an allowlist, so keys and upstream variables are not forwarded                  |
| Worker file and process access      | Tested, mock worker   | `node --permission`. Node documents this as a seatbelt, not a sandbox against hostile code        |
| Worker network egress               | **Not enforced**      | `--permission` on this Node version does not restrict network. Needs the Linux VM                 |
| Model auth                          | Tested with fake CLIs | Only the broker runs the CLIs, with API keys stripped from their environment                      |
| Spending                            | Tested                | Durable reservations in `lab/broker/ledger.js`, checked across real processes                     |
| Operator rights on a server         | **Not tested**        | No server exists yet. Upstream's chat guard drops slash commands, which is not a permission check |

## Upstream behaviour the lab must keep away from

Verified in the source at the pinned commit. See `docs/UPSTREAM_AUDIT.md`.

- With no setting, the sandbox falls back to Docker and then to `local`, which is **unisolated bash on the host**.
- Flags and `AGENT_*` variables override config files, and `.env` loads from the working directory. So `AGENT_SANDBOX` or
  `AGENT_TOOLS_MODULE` could undo a config, and the second loads arbitrary code into the agent process. The lab never
  uses `bin/minecraft-agent.js`; `lab/adapter/upstream.js` calls `resolveConfig` with an empty environment.
- `sharedMachine` defaults to `local` in team mode: host bash shared by the whole team.
- `scripts/dev-server.js` **accepts the Minecraft EULA on your behalf**, and `compose.yaml` sets `EULA: TRUE` and publishes
  port 25565 with offline auth. The lab must not run either as written.
- `compute_js` and the workspace tools stay available with `sandbox: none`, so they are removed by the allowlist.

## CLI model transport

Real model turns run through the operator's logged-in `claude` and `codex` CLIs, not API keys.

- **No credentials are read.** The lab never opens CLI auth files. `lab:auth` asks the CLIs themselves and prints no account
  details.
- **Keys are stripped.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and the matching base
  URLs are never passed on, so a stray key cannot move a run to API billing. A Claude stream reporting API-key auth is killed.
- **The login method is checked first.** A CLI can persist an API key in its own login, which stripping cannot remove.
  `lab:transport-check` refuses to make a request unless the CLI reports a plan login (`claude.ai` or `chatgpt`), and refuses
  any method it does not recognise. Codex's stream does not report its auth, so this check is the only one it has. Any
  future subscription run must call the same check, `isSubscriptionLogin`, during preflight.
- **`claude --bare` is banned.** Its help states that auth is then strictly an API key and OAuth is never read.
- **Tool activity kills the request.** These CLIs are full coding agents. Each output event is checked as it arrives.

**Known weakness, Codex:** `codex exec` has no documented way, in the help for this version, to remove its shell tool.
`--sandbox read-only` still allows reading files anywhere the sandbox permits, including the home directory. Stream
detection acts after the attempt starts, so a read could happen first. Until this runs in the VM with nothing private to
read, treat Codex as **less contained than Claude**, and do not put untrusted world text through it outside the VM.

**Prompt injection:** signs, books and chat reach the model inside the observation. The system prompt marks them as data,
but that is a request to the model, not a control. The controls are that Claude has no tools, and that any tool attempt
stops the run as `INVALID`.

## Required before any real agent run

1. A disposable Linux VM as the outer boundary, with non-root workers, read-only code and resource limits.
2. Measured network policy from the worker: DNS, IPv4, IPv6, LAN, host services, metadata addresses and proxies.
3. A live no-operator test on a real server.
4. A live `lab:transport-check` for each CLI, reviewing the boundary output. Done once on 2026-11-05: Claude reported only
   `StructuredOutput`, no MCP servers and no API key. Codex reported no boundary or model, so neither can be checked for it.
   Repeat after any CLI update.

The two skipped tests in `tests/lab/integration/run.test.js` stand for items 2 and 3. They stay skipped, not passing,
until the environment exists.
