---
description: Run anything on your Proxmox infrastructure — inspect, build, analyse, report. Changes stop at a confirmation.
argument-hint: [what you want, in your own words]
---

The user asked: **$ARGUMENTS**

Carry this out against their Proxmox infrastructure using the `proxmox-ai` MCP tools. If `$ARGUMENTS`
is empty, show them what this organization currently looks like (nodes, guests, anything waiting on
them) and ask what they want to do.

## How to work

Read first, then act. Pick the specific tool over a general one, and never state a number you did not
get from a tool in this session.

**Find your footing before doing anything else.** `whoami` tells you the organization and the role this
key carries; `get_capabilities` tells you what the stored Proxmox token may actually do. A tool you
cannot see is one this key is not allowed to use — say so plainly rather than looking for a way around.

## Changes stop at a gate

Anything that alters infrastructure is a two-step: `propose_action` returns a plan and its warnings
without touching anything, and `confirm_action` runs it. Between those two steps is a person.

- Show the plan and **every** warning, in the user's language, before asking.
- Treat the original request as permission to *propose*, never as permission to confirm.
- Only call `confirm_action` after they have seen the plan and said to go ahead.
- If the plan carries `typed_confirmation`, it destroys something. Pass that string back exactly, and
  only after they confirm in words.
- A proposal may also be confirmed by the user in the dashboard under **Waiting on you**. If the
  organization has four-eyes enabled, a proposal you created needs a *different* person to confirm it —
  when the platform says so, tell them who has to do it rather than retrying.

## Common requests

| They ask for | Start with |
|---|---|
| "how is everything", "ada masalah?" | `list_nodes`, `get_node_usage`, `get_backup_overview`, `list_actions` |
| VM usage / a specific guest | `list_vms`, then `get_guest` and `get_guest_metrics` — match by name or IP, not VMID |
| build a VM | `get_provisioning_options` for the target node, then `propose_action` with `create_vm` |
| build a template | `list_template_catalog`, `get_template_options`, then `propose_action` |
| power, resize, snapshot, reinstall | `propose_action` with the matching action, after reading current state |
| networking / port forward | `get_vrouter_overview`, `get_vrouter_nat`, then `propose_action` |
| backups | `get_backup_status`, `get_backup_overview` |
| "what happened", an audit question | `search_audit_log` |
| a report | `generate_report`, then `get_report` |

For placement decisions, read `list_nodes` and `get_node_usage` first so the node you choose has a
reason behind it. For `create_vm`, take templates, storages and bridges from
`get_provisioning_options` — never invent a name.

## Reports

`generate_report` builds the report; `list_reports` and `get_report` read what exists. Reports download
from the dashboard as **PDF or XLSX**. There is no Word export — if they ask for .docx, say so and offer
the PDF, or offer to write the findings into a Markdown file in the repo instead.

If they want analysis rather than a stored report, read the tools and write the analysis yourself —
that is usually faster and more useful than generating a document.

## Boundaries

- The tools are the entire surface. No SSH, no `curl` to the Proxmox API, no browser, no `pvesh`.
- Never ask for or accept a password, a private key or an API key in the conversation. SSH **public**
  keys for cloud-init are fine.
- On a 403, stop and explain. Do not retry with different parameters.
- Everything you do is attributed to this API key and recorded in the organization's audit log.

## Answering

Reply in the user's language. Say what you checked, what you found, and — for a proposal — what will
happen if they confirm and that nothing has happened yet.
