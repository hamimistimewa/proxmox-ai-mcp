# proxmox-ai-mcp

Give your AI client — **Claude Code, Codex, Claude Desktop, Cursor** — real tools for your Proxmox VE
infrastructure, through the [Proxmox AI](https://proxmox.ai.id) platform.

> What is the platform? → **[PLATFORM.md](PLATFORM.md)**

Two ways in. Both are thin clients; the role check, the validation and the guardrail live on the platform.

| | Needs | Good for |
| --- | --- | --- |
| **A · Shell + curl** | `curl` only | anything that can run a shell: Claude Code, Codex, a terminal. Nothing to install. |
| **B · MCP server** | Node 20+ | first-class tools in the client's tool list — Claude Desktop, Cursor, Windsurf |

---

## A · Shell + curl (no Node)

```sh
git clone https://github.com/hamimistimewa/proxmox-ai-mcp
cd proxmox-ai-mcp
./install.sh --url https://proxmox.ai.id --key pak_xxxxxxxxxxxx_…
```

That checks the key, saves it to `~/.proxmox-ai/config.json` (mode `600`), links `pmx` onto your `PATH`, and
drops the skill into `~/.claude/skills/` and `~/.codex/skills/` where those exist. Then just talk to your
agent — it has a shell, and now it has `pmx`:

> node mana yang RAM-nya paling mepet?

`pmx` is one POSIX shell script with no dependency beyond `curl`. Read it: `bin/pmx`.

```sh
pmx me                                  # who this key is, which role, which organization
pmx tools                               # exactly what this key is allowed to call
pmx get /nodes                          # the fleet
pmx get /nodes/pve01/usage range=24h    # one node, with history
pmx get /vms                            # guests and templates
pmx get /guests/101                     # one guest in detail
pmx get /backups/overview               # last backup per guest — finds the gaps
pmx get /audit limit=20                 # who changed what, agents included
pmx actions                             # proposals waiting, recent results
pmx propose guest_power vmid=101 operation=shutdown
pmx confirm 42                          # only after a human read the plan
pmx cancel 42
```

Raw `curl` works exactly the same, if you would rather see it:

```sh
curl -sS -H "Authorization: Bearer pak_…" https://proxmox.ai.id/api/v1/nodes
```

## B · MCP server (Node 20+)

```sh
node bin/install.mjs --url https://proxmox.ai.id --key pak_xxxxxxxxxxxx_…
```

Same checks, then it registers this server with every AI client it finds and installs the skill. Restart the
client and the Proxmox tools are in its tool list. No dependencies, nothing to build — the whole JSON-RPC
protocol is written out in `bin/proxmox-ai-mcp.mjs` so you can read it in one sitting.

---

## The point: your API key decides the tools

Neither client ships a tool list of its own. Both ask the platform which tools **this key** may use:

| Key role | What the agent sees |
| --- | --- |
| `readonly` | nodes, guests, storage, backups, reports, audit — read only |
| `operator` | the above, plus `propose_action`, `confirm_action`, `cancel_action` |
| `superadmin` | the above, plus connections, backup servers, alerts, team |
| platform key | organizations, hosts, vRouters, estate-wide overview |

```console
$ pmx tools        # operator key
scope: organization  role: operator  org: Acme
  whoami           GET  /me
  list_nodes       GET  /nodes
  propose_action   POST /actions
  confirm_action   POST /actions/{id}/confirm
  …31 tools

$ pmx tools        # readonly key
  …28 tools, and propose_action is not among them
```

A readonly key is never *told* that `propose_action` exists, so the model cannot try it and be refused — the
tool is simply absent. IP whitelist, rate limit and expiry are still enforced by the platform on every call.

It also means the tools stay current: add an endpoint on the platform and every installed copy picks it up on
its next run. You do not pull this repository again.

## Changes always stop for a human

```
pmx propose …   →  validated against live Proxmox state, returns a plan and warnings — nothing changed
                     ↓
                   a human reads the plan and decides
                     ↓
pmx confirm 42  →  it runs, in the background, recorded in the audit log
```

High-risk actions (erasing a disk, destroying a guest, rebooting a node) additionally require the exact
`typed_confirmation` string from the plan. Organizations can switch on four-eyes, requiring a different
person to confirm. Proposals expire after 15 minutes.

The bundled skill is what teaches the model that discipline — tool descriptions alone do not.

---

## What gets written where

| File | Contents |
| --- | --- |
| `~/.proxmox-ai/config.json` | your platform URL and API key, mode `600` |
| `~/.local/bin/pmx` | symlink to `bin/pmx` (shell path) |
| `~/.claude/skills/proxmox-ai/`, `~/.codex/skills/proxmox-ai/` | the skill |
| `~/.claude.json` | Claude Code: a path to the MCP server |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop (`~/.config/Claude/` on Linux, `%APPDATA%` on Windows) |
| `~/.codex/config.toml` | Codex CLI, as `[mcp_servers.proxmox_ai]` |
| `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/settings.json` | Cursor, Windsurf, Gemini CLI |

**The key is never written into a client's config** — those only get a path. Your dotfiles stay safe to
commit. Clients that are not installed are skipped; existing entries are merged, never overwritten.

## Using it from the OpenAI API instead

```sh
node bin/export-openai-tools.mjs --url https://proxmox.ai.id --key pak_…   # → schemas/openai-tools.json
pip install openai && python examples/openai_client.py "ringkas kondisi infrastruktur saya"
```

Generated from the same manifest, so it is filtered by your key's role in exactly the same way.

## Getting a key

Dashboard → **Organization → API keys**. Pick the lowest role that does the job, list the IP addresses it
will be used from (required), and set an expiry. The key is shown once.

Start with `readonly`. Move to `operator` when you want the agent to draft changes for you — it still
cannot execute them.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| `cannot be used from …` | your current IP is not on the key's whitelist |
| `This needs the Operator role or higher` | the key's role is too low — issue a new key, do not retry |
| `did not return a tool manifest` | the URL does not point at a Proxmox AI platform |
| `pmx: no configuration` | run `./install.sh`, or set `PROXMOX_AI_URL` and `PROXMOX_AI_KEY` |
| no tools in the client | restart it; MCP config is read at start-up |

Re-running either installer is safe and verifies the key before touching anything.

## Licence

MIT · by **Nur Hamim** · [nurhamim.com](https://nurhamim.com)
