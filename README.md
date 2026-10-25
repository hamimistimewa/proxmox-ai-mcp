# proxmox-ai-mcp

Give your own AI client — Claude Code, Codex, Claude Desktop, Cursor — real tools for your Proxmox VE
infrastructure, through the [Proxmox AI](https://proxmox.ai.id) platform.

```bash
git clone https://github.com/hamimistimewa/proxmox-ai-mcp
cd proxmox-ai-mcp
node bin/install.mjs --url https://proxmox.ai.id --key pak_xxxxxxxxxxxx_…
```

That is the whole setup. The installer checks the key, saves it to `~/.proxmox-ai/config.json` with
owner-only permissions, and registers this server with every AI client it finds on the machine. Restart the
client and ask it something:

> node mana yang RAM-nya paling mepet?

No dependencies, nothing to build. Node 20 or newer.

## The point: your API key decides the tools

This server ships with **no tool list of its own**. On start-up it asks the platform which tools *this key*
may use, and exposes exactly those:

| Key role | What the model sees |
| --- | --- |
| `readonly` | nodes, guests, storage, backups, reports, audit — read only |
| `operator` | the above, plus `propose_action`, `confirm_action`, `cancel_action` |
| `superadmin` | the above, plus connections, backup servers, alerts, team |
| platform key | organizations, hosts, vRouters, estate-wide overview |

A readonly key is never *told* that `propose_action` exists, so the model cannot try it and be refused — the
tool is simply not there. The key's IP whitelist, rate limit and expiry still apply on every call, enforced
by the platform rather than by this script.

It also means the tools stay current. Add an endpoint on the platform and every installed copy of this server
picks it up on its next restart. You do not pull this repo again.

## Changes always stop for a human

Nothing this server can do changes Proxmox on its own.

```
propose_action  →  validated against live Proxmox state, returns a plan and warnings — nothing has changed
     ↓
  a human reads the plan and confirms
     ↓
confirm_action  →  runs in the background, recorded in the audit log
```

High-risk actions (erasing a disk, destroying a guest, rebooting a node) additionally require
`typed_confirmation` copied exactly from the plan. Organizations can switch on four-eyes, which requires a
different person to confirm.

The bundled Claude skill (`skills/proxmox-ai/SKILL.md`, installed to `~/.claude/skills/`) is what teaches the
model that discipline — tool descriptions alone do not.

## What gets written where

| File | What goes in it |
| --- | --- |
| `~/.proxmox-ai/config.json` | your platform URL and API key, mode `600` |
| `~/.claude.json` | Claude Code: a path to this server |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop (`~/.config/Claude/` on Linux, `%APPDATA%` on Windows) |
| `~/.codex/config.toml` | Codex CLI, as `[mcp_servers.proxmox_ai]` |
| `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/settings.json` | Cursor, Windsurf, Gemini CLI |
| `~/.claude/skills/proxmox-ai/` | the skill |

**The key is never written into a client's config** — those only get a path. Your dotfiles stay safe to
commit and share. Clients that are not installed are skipped; existing entries are merged, not overwritten.

## Running it by hand

```bash
PROXMOX_AI_URL=https://proxmox.ai.id PROXMOX_AI_KEY=pak_… node bin/proxmox-ai-mcp.mjs
```

It speaks JSON-RPC over stdin/stdout. `--url` and `--key` work too, and environment variables win over the
config file, which is handy for pointing one client at a staging platform.

## Using it from the OpenAI API instead

```bash
node bin/export-openai-tools.mjs --url https://proxmox.ai.id --key pak_…   # → schemas/openai-tools.json
pip install openai && python examples/openai_client.py "ringkas kondisi infrastruktur saya"
```

The exported file is generated from the same manifest, so it is filtered by your key's role in exactly the
same way.

## Getting a key

Dashboard → **Organization → API keys**. Pick the lowest role that does the job, give it the IP addresses it
will be used from (required), and an expiry. The key is shown once.

Start with `readonly`. Move to `operator` when you want the model to be able to draft changes for you — it
still cannot execute them.

## Troubleshooting

| Message | What it means |
| --- | --- |
| `cannot be used from …` | your current IP is not on the key's whitelist |
| `The API reference is available from the platform network only` | expected — the docs are VPN-only, the API is not |
| `did not return a tool manifest` | the URL points at something that is not a Proxmox AI platform |
| no tools in the client | restart the client; it reads MCP config at start-up |

Run `node bin/install.mjs --url … --key …` again at any time: it is safe to repeat and verifies the key
before touching anything.

## Licence

MIT.
