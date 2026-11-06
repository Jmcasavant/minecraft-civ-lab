# Experiment protocol

Status: draft. No experiment has been run. Mock runs validate the pipeline and are never reported as results.

## Order of work

1. Qualify tools with scripted agents on a real server, at least ten repeats per controlled fixture. Any unexplained failure
   blocks calling that skill qualified.
2. One model in a short approved smoke test.
3. Four agents in one condition.
4. The matched pilot, once failures and usage can be explained.

## Pilot design

`2 models x 2 coordination conditions x 3 world snapshots = 12 runs`. Planned models use the logged-in CLIs; one option is one
Claude model and one Codex model. Note that this also compares two CLI wrappers and two containment setups, not models alone.

Keep one model per team. Change only the coordination condition between matched runs. Randomize condition order within each
world block and save the schedule, with its seed, before the first run. Three worlds are a pilot and cannot support a general
ranking.

Pin exact model ids where offered. If only an alias exists, record the requested and returned ids, the date and the limitation.
Codex output does not report the model it used, so its model is recorded as requested and unverified. Never substitute a model
after an error. Equal effort labels across providers do not mean equal computation.

## Limits

Fixed-time and fixed-budget experiments stay separate. Plan quota is shared with anything else the operator is doing, so rate
limiting is a confound: record every limit event and do not silently extend time. Compare runs only under the same limit policy.

## Validity

Invalid if: identity or permission breach, a model CLI tool attempt, wrong frozen configuration, critical evidence loss, a
missing terminal snapshot, unauthorized intervention, or a defined infrastructure failure.

Not invalid: ordinary mistakes, permitted deaths, declared tool limits and running out of budget or quota. Every attempted run
is kept, including invalid and aborted ones, with its usage. A confirmed harness bug can justify a new protocol version and
rerunning affected matched blocks, with the original results kept.

Classify failures as `model`, `tool`, `coordination`, `environment`, `provider`, `infrastructure` or `undetermined`. Cost per
completed objective is undefined at zero completions; report usage and the zero count instead.

## Reporting

Show raw per-run rows and paired differences, not only a winner. Call Settlement-60 success demonstrated settlement
functionality, not proof of indefinite self-sufficiency. Do not change objectives, weights, tools or settings during a scored
run; a change creates a new version and a new matched comparison.
