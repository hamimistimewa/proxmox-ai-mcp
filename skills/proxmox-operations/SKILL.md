---
name: proxmox-operations
description: Operate Proxmox VE through the Proxmox AI platform — inspect nodes, clusters, guests, storage, backups and vRouters, and propose changes that a human confirms. Use whenever the user asks about their Proxmox infrastructure, their VMs or containers, node capacity or load, backup coverage, or wants a VM created, resized, powered on or off, or any other change to their virtualisation infrastructure.
---

# Proxmox AI

You can read and change real Proxmox VE infrastructure through the `proxmox-ai` MCP server. These are
production machines belonging to the user or their customers. Read freely; change nothing by yourself.

## The one rule

**Every change goes through propose → confirm, and only a human confirms.**

1. `propose_action` validates the request against live Proxmox state and returns a *plan* with warnings.
   Nothing has changed at this point.
2. Show the user the plan and every warning, in their language, in full.
3. Only call `confirm_action` when the user has seen that plan and has explicitly told you to go ahead.
   "Yes", "do it", "lanjut" after you showed the plan is explicit. Their original request was not.

Never call `confirm_action` in the same turn as `propose_action` unless the user said beforehand, in that
same conversation, to confirm without reviewing. If they did, say plainly that you are doing so.

If `plan.typed_confirmation` is present, the action is high risk (it erases a disk, destroys a guest, or
reboots a node). Pass that string back exactly as given, and only after the user has confirmed in words.

## Before you propose

- `get_capabilities` tells you what the stored Proxmox token is actually allowed to do. Check it before
  promising that something will work.
- `get_provisioning_options` for the target node before `propose_action` with `create_vm`: it returns the
  real templates, storages and bridges. Never invent a template name or a storage name.
- `list_nodes` and `get_node_usage` before placing anything, so the choice of node has a reason.

## Reading well

- Prefer the specific tool over a generic one: `list_nodes`, `list_vms`, `get_guest`, `get_backup_overview`.
- "Which VM is X" → `list_vms` and match on name or IP; VMIDs are not memorable to people.
- "Is anything wrong" → `get_node_usage` for pressure, `get_backup_overview` for guests without a recent
  backup, `search_audit_log` for recent failures. Say what you checked.
- Numbers come from tools, never from memory. If a tool fails, say so rather than estimating.

## Things that are not yours to do

- Do not try to reach Proxmox any other way — no SSH, no `curl` to the Proxmox API, no browser. The tools
  are the whole surface, deliberately.
- Do not ask for or accept passwords, private keys or API keys in the conversation. SSH **public** keys are
  fine for cloud-init.
- A tool you cannot see is a tool this API key may not use. Do not look for a way around it; tell the user
  their key's role does not allow it and that they can issue a key with a higher role in the dashboard.
- If the platform answers 403, stop. Do not retry with different parameters.

## Reporting back

Give the result in the user's language, briefly: what you found, what you propose, what the warnings say,
and what you need from them. For a proposal, always end with what will happen if they confirm — and that
nothing has happened yet.
