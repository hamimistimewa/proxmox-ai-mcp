---
name: proxmox-operations
description: Operate Proxmox VE through the Proxmox AI platform using the `pmx` shell command — inspect nodes, clusters, guests, storage, backups and vRouters, and propose changes that a human confirms. Use whenever the user asks about their Proxmox infrastructure, their VMs or containers, node capacity or load, backup coverage, or wants a VM created, resized, powered on or off, or any other change to their virtualisation infrastructure.
---

# Proxmox AI (shell)

Real Proxmox VE infrastructure is reachable from this shell through `pmx`. These are production machines
belonging to the user or their customers. Read freely; change nothing by yourself.

`pmx` carries the API key for you. Never print the key, never read `~/.proxmox-ai/config.json`, and never
put the key on a command line.

## The one rule

**Every change goes through propose → confirm, and only a human confirms.**

```sh
pmx propose create_vm node=pve01 template=9000 vcpu=2 ram_gb=4 disk_gb=40
#   → returns a plan with warnings. Nothing has changed.
pmx confirm 42
#   → runs it. Only after the user has read the plan and said to go ahead.
```

1. `propose` validates against live Proxmox state and returns a *plan*. Nothing has happened yet.
2. Show the user the plan and **every** warning, in their language, in full.
3. Only then, and only if they explicitly say to proceed, run `pmx confirm <id>`.

Never run `propose` and `confirm` in the same turn unless the user said beforehand, in this conversation,
to confirm without reviewing — and if they did, say plainly that you are doing so.

If the plan contains `typed_confirmation`, the action is high risk (erases a disk, destroys a guest, reboots
a node). Pass that exact string: `pmx confirm 42 "<the exact text>"`. Only after the user confirms in words.

## Commands

```sh
pmx me                                  # who this key is, which role, which organization
pmx tools                               # exactly what this key is allowed to call
pmx get /nodes                          # the fleet
pmx get /nodes/pve01/usage range=24h    # one node, with history
pmx get /vms                            # guests and templates
pmx get /guests/101                     # one guest in detail
pmx get /storage                        # storage pools
pmx get /disks                          # physical disks, LVM, ZFS
pmx get /capabilities                   # what the stored Proxmox token may actually do
pmx get /backups/overview               # last backup per guest — finds the gaps
pmx get /audit limit=20                 # who changed what, including agents
pmx actions                             # proposals waiting and recent results
pmx action 42                           # one action, with its plan and warnings
pmx propose <action> key=value ...      # draft a change
pmx confirm 42 / pmx cancel 42
```

`pmx tools` is the authoritative list. If a tool is not in it, this key may not use it — say so and stop;
do not look for another route.

## Before you propose

- `pmx get /capabilities` — check the Proxmox token can actually perform the action before promising it.
- `pmx get /provisioning/options node=<node>` before `create_vm`: it returns the real templates, storages
  and bridges on that node. Never invent a template or storage name.
- `pmx get /nodes` first, so the choice of node has a reason behind it.

## Reading well

- "Which VM is X" → `pmx get /vms` and match on name or IP. VMIDs mean nothing to people.
- "Is anything wrong" → node usage for pressure, `/backups/overview` for guests without a recent backup,
  `/audit` for recent failures. Say what you checked.
- Numbers come from `pmx`, never from memory. If a call fails, report it rather than estimating.
- Output is JSON. Pipe through `jq` when it helps, but show the user plain sentences, not raw JSON.

## Things that are not yours to do

- Do not reach Proxmox any other way — no SSH, no `curl` straight at the Proxmox API, no browser. `pmx` is
  the whole surface, deliberately.
- Do not ask for or accept passwords, private keys or API keys in the conversation. SSH **public** keys are
  fine for cloud-init.
- `403` means this key may not do that. Stop. Do not retry with different parameters.
- `429` means rate limited. Wait; do not hammer.

## Reporting back

Answer in the user's language, briefly: what you found, what you propose, what the warnings say, and what
you need from them. For a proposal, always end with what will happen if they confirm — and that nothing has
happened yet.
