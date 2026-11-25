# Codex review

One review, run on 2026-11-05 with `codex review --uncommitted` on `gpt-6-astra`, read-only, through the operator's ChatGPT login.
It covered the whole working tree, on top of the pinned upstream commit. Gate result: **FAIL** (1 P1).

The fixes below came after the review and have not been reviewed by Codex. The reviewer's sandbox could not run the
write-dependent tests, as it says below. `npm run lab:test` ran here afterwards: 198 pass, 0 fail, 2 skipped.

## What was done about each finding

| Finding                                          | Confirmed | Fix                                                                                                                  |
| ------------------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| P1: API-key login can pass `lab:transport-check` | Yes       | `isSubscriptionLogin` in `lab/broker/cli-provider.js`. Refuses before any request, and refuses unknown login methods |
| P2: blocked tasks cannot recover                 | Yes       | New fenced `taskReopen` in `lab/coordination/service.js`. `failed` stays final, which is a design choice             |
| P2: in-flight duplicate skips the content check  | Yes       | `lab/adapter/action-gate.js` compares the request hash first and returns `action_id_conflict`                        |
| P2: missing vitals pass                          | Yes       | `team.functioning` returns `unsupported`. A failure already known from other data still fails                        |
| P2: missing crop data counts as ineligible       | Yes       | `crops.cells` returns `unsupported` when unknown cells could reach the threshold                                     |
| P2: non-participants affect the team's score     | Yes       | Inventories, chest registrations and deaths are filtered to the roster                                               |
| P2: fingerprint ignores untracked contents       | Yes       | `codeIdentity` in `lab/controller/finalize.js` hashes untracked file contents                                        |

Same kind of gap, found while fixing these and not in Codex's list:

- `tools`, `infrastructure` and `food.reserve` also treated missing data as a verdict. Each now returns `unsupported` when the missing data could change the result.
- A non-numeric food count produced `NaN`, which passed the reserve check.
- A snapshot with no `players` array crashed the scorer.
- `lab:doctor` matched `21` in the Java release date, so Java 25 counted as Java 21.

A registered chest absent from a snapshot still counts as empty, so the M2 telemetry must report every registered chest.

## Codex output

Unchanged except that absolute paths were shortened to repository paths.

```text
The changes contain an authentication-policy bypass, unrecoverable coordination states, and reproducible action/scoring errors. The 46 read-only tests and lint passed, but targeted checks exposed uncovered cases; the full write-dependent integration suite was not run.

Full review comments:

- [P1] Reject API-key authentication before starting a transport check — lab/cli/lab.js:211-214
  When Codex is logged in using a persisted API key, `cliAuthStatus()` returns `loggedIn: true` and `authMethod: 'api-key'`, so this check permits execution. Removing environment keys does not remove persisted CLI credentials, and `codexStream()` has no authentication check. Consequently, a request approved for subscription usage can incur API charges while the ledger records zero dollars. Require the approved subscription authentication method before invoking the CLI.

- [P2] Provide a recovery transition for blocked tasks — lab/coordination/service.js:246-248
  After an agent marks a task `blocked`, its owner is cleared, but `taskClaim()` accepts only `open` tasks and both `taskUpdate()` and `taskRelease()` require the current owner. The no-progress sweep creates the same unrecoverable state. Even after the blocker disappears, nobody can reopen or complete the task, permanently preventing dependent tasks from being claimed. Add a fenced reopening or reassignment path.

- [P2] Check request content before returning an in-flight result — lab/adapter/action-gate.js:105-110
  If two concurrent requests reuse an action ID with different tools or arguments, the second request returns the first request's result before reaching the hash comparison. A concurrent `craft` request can therefore report success even though only `gather` executed; the same conflict is correctly rejected after completion. Compare request hashes before deduplicating in-flight actions.

- [P2] Treat missing player vitals as unsupported evidence — lab/evaluator/settlement.js:367-374
  When connected player records omit `food` or `health`, comparisons against `undefined` are false, so the team receives a passing score without evidence that the thresholds were met. Removing these fields from every sample and the terminal snapshot still awards all 10 points. Validate the required numeric fields at both sampling and cutoff checks, returning `unsupported` when telemetry is incomplete.

- [P2] Distinguish missing crop telemetry from ineligible crops — lab/evaluator/settlement.js:228-232
  When a planted cell, its supporting farmland, or required light/moisture data is absent from the terminal snapshot, this loop treats it as a known ineligible cell. Deleting one crop cell from the passing fixture changes the result to `fail` rather than `unsupported`, incorrectly attributing evidence loss to benchmark failure. Preserve the unknown state when missing data could change whether the threshold is met, as the shelter predicate already does.

- [P2] Restrict team scoring inputs to the participant roster — lab/evaluator/settlement.js:304-310
  If authoritative telemetry includes another player, `reserveUnits()` counts that player's inventory toward the team's reserve; a visitor holding bread makes an otherwise empty team pass. Chest registrations are likewise unfiltered, and `scoreTeam()` counts nonparticipant deaths against the team. Apply `evidence.participants` consistently so unrelated players cannot raise or lower the benchmark score.

- [P2] Include untracked file contents in the code fingerprint — lab/controller/finalize.js:23-29
  For runs from this working tree, most lab implementation files are untracked. `git diff HEAD` excludes their contents, while porcelain status records only their paths, often collapsed to directory names. Editing an untracked controller or scorer therefore leaves `diffSha256` unchanged, making materially different implementations indistinguishable in run manifests. Include content hashes for untracked source files or refuse runs whose code identity cannot be captured.
```
