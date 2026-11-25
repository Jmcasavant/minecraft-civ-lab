> **This is a research lab built on YC's harness, and is not the original project.** It adds a controller, budget ledger,
> independent scoring and a model broker under `lab/`, on top of
> [yc-software/minecraft-agent-harness](https://github.com/yc-software/minecraft-agent-harness) at commit `775d558`, under that
> project's MIT license. Early and unqualified: see [docs/STATUS.md](docs/STATUS.md) for what has and hasn't been shown to work.
> Everything below is upstream's README, unchanged.

<h1 align="center">minecraft-agent-harness</h1>

<p align="center">LLM agents that play Minecraft.</p>

<p align="center">
  <a href="https://github.com/yc-software/minecraft-agent-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yc-software/minecraft-agent-harness/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white">
  <img alt="Minecraft Java 1.21.6" src="https://img.shields.io/badge/minecraft-java%201.21.6-62B47A">
</p>

<p align="center">
  <img src="docs/images/hero.jpg" alt="Agents fishing together at a shoreline camp, gathering around a farm, and holding a bridge in Bed Wars" width="100%">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/tools.md">Tools</a> ·
  <a href="docs/multi-agent.md">Teams</a> ·
  <a href="examples/bedwars/README.md">Bed Wars example</a>
</p>

Point an LLM at a Minecraft server and give it something to do. It plays through
[Mineflayer](https://github.com/PrismarineJS/mineflayer), so it walks, mines, crafts, builds, fights and chats like a
regular player. [pi](https://github.com/earendil-works/pi) handles the model session. We've run Bed Wars matches with it,
and a survival server with 50 agents on it at once.

What's in here:

- Claude, GPT, Gemini, OpenRouter, or your own endpoint if it speaks the OpenAI Responses API
- Sessions that survive restarts. Kill an agent, start it again under the same name, and it carries on
- A shell for every agent (Docker, E2B or a plain local folder). Agents keep notes there and write little scripts that
  call their own game tools
- Teams from a single JSON file, with DMs between agents and an optional shared machine
- Vision, if you want it (experimental)

## Quickstart

You'll need Node 22.19+, an API key for some model provider, and a Minecraft server. If you don't have a server, the
repo comes with a dev one, which needs Java 21.

```sh
npm ci
cp .env.example .env    # add the API key for your model provider
npm run server          # Paper 1.21.6 on localhost:25565, offline mode
```

Then in a second terminal:

```sh
npm start -- --objective "Gather wood and build a small shelter near spawn"
```

That's it. The default model is GPT-6.1 Terra, and [Configuration](docs/configuration.md#model) covers the other providers
and how to switch.

Join `localhost:25565` from Minecraft 1.21.6 if you want to watch, and `/tell Agent <message>` to talk to it. Its
output and tool calls stream to the terminal. `Ctrl+C` stops it. Everything it knows lives in
`.agent-state/<name>/`, so starting it again with the same name resumes the session.

### Your own server

```sh
npm start -- --host play.example.net --port 25565 --objective "Mine iron"
```

Online-mode servers need `--auth microsoft` (you'll get a sign-in prompt). Agents assume survival; pass `--game-mode`
if your server puts them in something else.

### Docker

Fill in `.env` as above, then:

```sh
docker compose up
```

You get a Paper server on `localhost:25565` and one agent. Change what it does with `AGENT_OBJECTIVE` in `.env`. State
goes in the `agent-state` volume.

Already have a server? Just run the agent image:

```sh
docker build -t minecraft-agent .
docker run --rm -it --env-file .env -v agent-state:/data minecraft-agent --host play.example.net -o "Mine iron"
```

### Teams

```sh
npm start -- team examples/team.json
```

Starts three agents who can message each other. [Team config](docs/multi-agent.md) has the details. For
something with rules and a referee, look at the [Bed Wars example](examples/bedwars/README.md).

## Configuration

Flags, environment variables (`.env` works) or a JSON file via `--config`. Flags win over env vars, env vars win over
the file.

A heads-up about the shell: agents get one by default. That's E2B if `E2B_API_KEY` is set, otherwise Docker if it's
running, otherwise a local folder, and local means commands run as you. Use `--sandbox none` if you'd rather they
didn't have one.

More docs:

- [Configuration](docs/configuration.md): models, auth, sandboxes, vision, where files go
- [Tools](docs/tools.md): everything an agent can do
- [Architecture](docs/architecture.md): how the code fits together

## Development

```sh
npm run check   # lint, format, tests
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the rest.

## License

MIT. Some of the skill library comes from [Mindcraft](https://github.com/kolbytn/mindcraft) and the renderer worker
from [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer); their licenses are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
