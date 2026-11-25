# Sources

## Code adopted

| Source                              | Revision                                   | Use                     | License |
| ----------------------------------- | ------------------------------------------ | ----------------------- | ------- |
| yc-software/minecraft-agent-harness | `775d558689f5e4eaa0f1d0d7a320035190b1fce6` | Base of this repository | MIT     |
| `yaml` npm package                  | 2.9.1                                      | Config parsing          | ISC     |

Upstream's own third-party notices remain in `THIRD_PARTY_NOTICES.md`.

## Inspected locally, 2026-11-05

- Upstream `src/agent.js`, `src/config.js`, `src/cli.js`, `src/index.js`, `src/model/session.js`, `src/tools/game-tools.js`,
  `src/tools/game/core.js`, `src/tools/extra-tools.js`, `src/tools/compute-worker.js`, `src/body/chat-guard.js`,
  `scripts/dev-server.js`, `compose.yaml`, and `docs/`.
- `minecraft-data` 3.116.0 for Minecraft 1.21.6: the food values and registry names checked by `tests/lab/unit/scorer.test.js`.
- `claude --help`, `claude auth status` (Claude Code 2.1.283), `codex exec --help` and `codex login status` (codex-cli 0.153.4):
  flags and login state. These report what the installed versions say about themselves.

## Documentation consulted, not code

- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): `--output-format json`, `result`,
  `structured_output`, and that cost figures are client-side estimates.
- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript): result message fields.
- [Model configuration](https://code.claude.com/docs/en/model-config): `modelUsage` shows the model used.

**Weaker evidence.** No official OpenAI reference for the `codex exec --json` event format was found. The parser follows
third-party references ([one reference](https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/),
[a Rust parser](https://docs.rs/agent-harness/latest/src/harness/codex/parser.rs.html)), which disagree on the message item name,
so both names are accepted. The fixtures in `tests/lab/fixtures/fake-cli.cjs` are written from these documents. One live
`lab:transport-check` per CLI on 2026-11-05 (`claude` 2.1.283, `codex-cli` 0.153.4) parsed correctly, which covers the successful
path only. Failure and tool-attempt events have not been observed live, and neither raw stream was kept.

## Design references, no code taken

Cairn (AGPL-3.0, design reference only pending license review), Mindcraft, Minecraft Agent Swarm, NPA-Bench, VillagerBench,
Voyager, Minecraft Agentic and prismarine-viewer are listed in the handoff. They were not inspected or used in this session.
