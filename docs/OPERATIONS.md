# Lab operations

Every command below exists and has tested success and failure paths in `tests/lab/integration/cli.test.js`. Nothing
here starts a Minecraft server. Only `lab:transport-check` can use a model, and only with its approval flag.

Install without third-party install scripts, then apply the repository's own patches:

```bash
npm ci --ignore-scripts
```

```bash
npx --no-install patch-package
```

## Everyday commands

| Command                                              | What it does                                                    | Model use |
| ---------------------------------------------------- | --------------------------------------------------------------- | --------- |
| `npm run lab:doctor`                                 | Versions, logins, credentials present or absent, blockers       | None      |
| `npm run lab:auth`                                   | Asks the `claude` and `codex` CLIs whether they are logged in   | None      |
| `npm run lab:test`                                   | The offline lab test suite                                      | None      |
| `npm run lab:validate -- --config configs/mock.yaml` | Strict config check                                             | None      |
| `npm run lab:run -- --config configs/mock.yaml`      | One complete mock run: simulated world and scripted provider    | None      |
| `npm run lab:status -- --run <run-id>`               | Run state, spending, transitions                                | None      |
| `npm run lab:stop -- --run <run-id>`                 | Stops a live run, or closes one whose controller died           | None      |
| `npm run lab:report -- --run <run-id>`               | Prints the report, checks artifact hashes and re-scores events  | None      |
| `npm run lab:replay -- --run <run-id>`               | Event timeline reconstruction, not a deterministic world replay | None      |

`--runs-dir <dir>` or `LAB_RUNS_DIR` moves run storage away from the default `runs/`.

Exit codes: 0 success, 1 the operation failed or the run did not complete, 2 bad usage or invalid config.

## Testing the model login

This makes exactly one real request against your plan, with no retry. It uses the CLI's own login and never an API key:

```bash
npm run lab:transport-check -- --provider claude-cli --model <exact-model-id> --approve-one-request
```

```bash
npm run lab:transport-check -- --provider codex-cli --model <exact-model-id> --approve-one-request
```

Check `boundary` in the output. For Claude, `tools` should be empty or hold only the structured-output tool,
`mcpServers` empty and `apiKeySource` `none`. Any tool activity or API-key auth kills the request.

For Codex, `boundary` is `null`, `returnedModel` is `null` and `modelVerified` is `false`, because its stream reports none of
them. That is the expected result, not a failure. It also means the lab can't detect a substituted Codex model.

## Reading a run

`runs/<run-id>/` holds `manifest.json`, `resolved-config.json`, `events.jsonl`, `score.json`, `usage.json`, `report.md`,
`cleanup.json`, `integrity.json`, per-agent `logs/`, and per-agent `workspaces/`. `runs/control.sqlite` holds run state
and `runs/ledger.sqlite` the spending ledger, which is shared across runs on purpose so a cap cannot be reset.

Start with `report.md`. A `MOCK RUN` banner means the run says nothing about Minecraft or any model.

## Stopping

`lab:stop` asks the controller to stop. New actions and model requests are refused first, then workers get one second to
exit before being killed. If the controller is gone, its workers have already exited because their channel closed, and
`lab:stop` closes the run as `ABORTED`. Runs are never resumed.
