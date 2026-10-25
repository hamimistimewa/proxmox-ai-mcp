# Proxmox AI — the platform behind these tools

This repository is the client. This page is what it talks to.

**Proxmox AI** is a multi-tenant control plane for Proxmox VE. Each organization connects its own node or
cluster, and operates it through a dashboard, a public API, and an AI agent — with one rule holding the
whole thing together: *nothing that changes state runs without a human confirming it.*

---

## Why it exists

AI coding agents took off because a bad suggestion costs you a revert. Infrastructure is not like that. A
wrong `qm destroy` at 3 a.m. costs you the machine, and "the AI did it" is not an answer anyone accepts.

Most "AI + infra" demos hand the model an SSH session as root and hope. That is fine for a lab and
indefensible for anything someone else depends on. Proxmox AI takes the opposite position: the agent gets
**no shell and no credentials**, only a list of declared tools, and anything that writes stops at a gate.

---

## The guardrail

Every state-changing operation — from the dashboard, from the chat assistant, from the public API, from an
MCP client on your laptop — goes through the same four steps.

```
propose   validated against live Proxmox state; returns a plan and warnings; nothing has changed
   ↓
dry-run   the exact steps, plus quorum, HA, free RAM, free disk, guest locks
   ↓
confirm   an authorised human. High-risk actions need the typed confirmation from the plan.
   ↓
audit     who, when, from where, with what parameters, and the result
```

- A proposal expires after 15 minutes.
- High-risk actions (erasing a disk, destroying a guest, rebooting a node) require typing an exact string
  back — the VMID, the device path — so a stray click cannot do it.
- **Four-eyes** can be switched on per organization: a different person must confirm.
- The audit log records `actor_type`, so an action an agent proposed is distinguishable from one a person
  typed, forever.

Turn the AI off entirely and all of this still works. Propose → confirm is not an AI feature; it is the
foundation the AI happens to use.

---

## Multi-tenancy

One platform, many organizations, no leakage between them.

- **PostgreSQL row-level security**, with the tenant set per request inside the transaction — not a
  `WHERE tenant_id = ?` that someone can forget.
- Each organization has its own members, roles, Proxmox connections, reports, audit log and API keys.
- Members sign in at their organization's own URL (`/t/<slug>/`). Platform administration is separate.

| Role | Scope | May do |
| --- | --- | --- |
| **Platform Admin** | the whole platform | create and suspend organizations, attach hosts, vRouters and backup servers, platform security |
| **Superadmin** | one organization | members and roles, four-eyes, AI settings, API keys, backup datastores |
| **Operator** | one organization | propose, confirm and cancel actions |
| **Readonly** | one organization | dashboards, reports, audit log, ask the assistant |

---

## What it manages

| Module | What it covers |
| --- | --- |
| **Fleet** | nodes, clusters, quorum and HA, live CPU/RAM/disk, historical trends, cluster task log |
| **Guests** | VMs and containers: provisioning from templates, cloud-init, snapshots, disk resize, power, reinstall |
| **Console** | noVNC and xterm.js in the browser, proxied — no direct access to the hypervisor |
| **Storage** | physical disks, LVM and ZFS, thin pools, detection of unused disks, storage creation |
| **Backups** | Proxmox Backup Server: datastores, jobs, coverage per guest, restore to a new guest |
| **Network** | VyOS vRouter: NAT, firewall, DHCP, WireGuard — applied commit-confirm, so a bad rule rolls back |
| **Reports** | health, capacity, backup coverage, inventory, activity — as PDF or XLSX |
| **Audit** | every action, filterable by actor: manual, agent, or API |
| **Assistant** | chat with ~20 declared tools, bound by the same guardrail |

---

## How the AI is actually wired

The agent never sees a credential and never gets a shell.

1. It may call only the tools declared on the server, each with a parameter schema.
2. Parameters are validated **server-side**, against live Proxmox state.
3. The server translates the call into a Proxmox REST API request using a stored, encrypted,
   least-privilege API token belonging to that organization.
4. Results are **redacted** before they reach the model — anything shaped like a password, token or private
   key is stripped — and long results are truncated so they cannot flood the context.
5. Console, file-read and command-execution endpoints are blocked at the tool layer.

The **Capabilities** page shows what the stored Proxmox token is genuinely permitted to do, so nobody has to
guess whether an action will work.

Provider and model are configured per organization: Anthropic, OpenAI, or an OpenAI-compatible gateway.

---

## The public API

Everything the console can do is available over HTTP, with four deliberate exceptions that stay in a
signed-in session: a person's own second factor and sessions, creating or revoking API keys (a key must
never mint keys), the guest console ticket, and the live dashboard stream.

- `Authorization: Bearer pak_…`
- Every key carries a **role**, a **mandatory IP whitelist**, an **expiry** and a **per-minute rate limit**.
- A key is shown once.
- `GET /api/v1/me` reports exactly what a key is.
- `GET /api/v1/mcp/manifest` reports exactly which tools that key may call — which is what this repository
  reads at start-up, and why a readonly key never sees a tool that writes. A readonly organization key is
  answered with 48 tools, an operator 53, a superadmin 65, and a platform key 24.
- OpenAPI document at `/api/v1/openapi.json`; the human-readable reference is network-restricted.

Changing infrastructure over the API is the same two steps as everywhere else:

```http
POST /api/v1/actions              → a plan, with warnings. Nothing changed.
POST /api/v1/actions/{id}/confirm → it runs. Poll GET /api/v1/actions/{id}.
```

---

## Security posture

- Proxmox, PBS and vRouter credentials are stored encrypted and never appear in a prompt, a bundle, a log
  or an API response.
- All outbound targets pass SSRF validation and TLS verification. LAN endpoints behind a private CA pin a
  verified SHA-256 leaf fingerprint — there is no "skip TLS" switch.
- Sessions use `HttpOnly`, `SameSite=Strict` cookies, `Secure` over HTTPS. TOTP two-factor can be required
  per organization.
- The platform API listens on loopback only; TLS, routing and access policy live at the edge proxy.
- Release artifacts carry a SHA-256 manifest and a recorded attestation.

---

## Where this repository fits

```
your laptop                          the platform                    your infrastructure
─────────────                        ────────────                    ───────────────────
Claude Code / Codex / Cursor
      │  MCP stdio  ──────┐
      │                   ├────────► Proxmox AI ──── REST + token ──► Proxmox VE
      │  pmx + curl  ─────┘           ├─ RBAC per API key              PBS
      └─ skill (propose → confirm)    ├─ propose → confirm             VyOS vRouter
                                      └─ audit log
```

Both paths in this repository are thin clients. The role check, the validation, the guardrail and the audit
trail all live on the platform — so they hold no matter which client, or which model, is driving.

---

Platform by **Nur Hamim** · [nurhamim.com](https://nurhamim.com)
Built as the working example behind the Jatim Developer Day 2026 session
*"Bangun AI Agent untuk Kelola Proxmox-mu Sendiri"*.
