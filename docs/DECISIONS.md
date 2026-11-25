# Decisions

Dated 2026-11-05 unless noted.

1. **Fork layout.** The pinned upstream checkout is the repository, with the lab added under `lab/`, `tests/lab/`,
   `scenarios/`, `configs/` and `docs/`. There is one runtime copy. The operator later authorized a public GitHub repository,
   created as a standalone repository with upstream's history and license kept, not a GitHub fork. `upstream` is fetch-only.
2. **Small upstream change.** Only `src/model/session.js` and `src/agent.js` changed, adding an optional `toolPolicy`. With
   no policy set, behaviour is unchanged.
3. **Model transport (operator instruction).** The operator asked for Claude or Codex through login auth instead of the Claude
   API. Real runs use the logged-in `claude` and `codex` CLIs from the broker. No credential file is read and no API key is
   used. This narrows the handoff's generic provider-API design.
4. **Subscription accounting.** The lab cannot verify a per-token price for plan usage, so dollars stay zero and
   `maxProviderRequests` is the hard limit. The CLI's own cost figure is an estimate and is not recorded as spending. The
   handoff warns not to assume plans cover API use; this design does not use the API. Whether this kind of automated use
   fits each plan's terms and limits is the operator's call.
5. **One decision per request, no native tools.** CLI tools stay off, so the model returns JSON and the lab executes it. This
   differs from upstream's pi session. Model comparisons here measure the CLI-mediated setup, including its fixed overhead.
6. **Two validators avoided.** A small strict JSON Schema subset validator (`lab/lib/schema.js`) throws on unsupported
   keywords rather than ignoring them. `yaml` became a direct dependency at the version already in the lockfile.
7. **Mock mode's `maxProviderRequests: 0`.** It means no provider requests. Mock requests use a separate internal ceiling and
   are reported separately, so a report can state zero provider requests truthfully.
8. **Node `--permission` for mock workers.** Added as defence in depth. It is not containment and is not presented as such.
9. **No shelter wall corners.** The shelter predicate checks the non-corner wall ring, because diagonal corners do not open
   a walkable gap. This is a proposal for review before freezing the scenario.
10. **`argsJson` as a string.** Strict structured-output modes reject free-form objects, so tool arguments travel as JSON
    text and are parsed and validated in the broker's provider.
11. **`LAB_ARCHITECTURE.md`.** The handoff's `docs/ARCHITECTURE.md` would collide with upstream's `docs/architecture.md` on
    case-insensitive filesystems such as this Windows host.
12. **Settlement-60 stays unfrozen.** Its predicates are tested with fixtures only. Thresholds need scripted and pilot
    validation first, and `register_region` does not exist yet.
