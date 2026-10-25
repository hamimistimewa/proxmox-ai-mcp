// Guided workflows, offered over MCP as prompts. In Claude Code these appear as slash commands
// (/mcp__proxmox-ai__health-check); other clients list them in a prompt picker.
//
// A prompt is not a shortcut around the guardrail. Every one of them ends by telling the model to stop
// at a proposal, because a workflow that quietly confirmed things would defeat the point of the platform.

const GUARD = 'Do not call confirm_action. If a change is warranted, propose it and show the plan and every warning, then stop and let the person decide.';

export const PROMPTS = [
  {
    name: 'health-check',
    title: 'Health check',
    description: 'Walk the fleet and report what needs attention: node pressure, failed tasks, guests without a recent backup.',
    arguments: [{ name: 'range', description: 'History window: 24h, 7d or 30d (default 24h)', required: false }],
    needs: ['list_nodes'],
    build: ({ range = '24h' }) => `Run a health check of this Proxmox estate and report what actually needs attention.

Work in this order and say what you checked:
1. list_nodes — which nodes are online, and their CPU, memory and root disk.
2. get_node_usage with range=${range} for any node above 75% on CPU, memory or disk.
3. get_capabilities — note anything the stored token is not permitted to do, so your advice is actionable.
4. list_vms — guests that are stopped but expected to run, and templates taking space.
5. get_backup_overview — guests with no recent backup, and get_backup_link_health for datastores a node cannot reach.
6. search_audit_log with status=failed over the last ${range} — recent failures and who caused them.

Report as: what is healthy (one line), then each finding with the number behind it and what you would do.
Order findings by how much they would hurt if ignored. If nothing is wrong, say so plainly and stop.
${GUARD}`,
  },
  {
    name: 'capacity-review',
    title: 'Capacity review',
    description: 'How much headroom is left on each node, where it runs out first, and what to do before it does.',
    arguments: [{ name: 'range', description: 'Trend window: 24h, 7d or 30d (default 7d)', required: false }],
    needs: ['list_nodes'],
    build: ({ range = '7d' }) => `Review capacity across this Proxmox estate.

1. list_nodes and list_clusters — the shape of the estate, and whether HA or quorum constrains placement.
2. get_node_usage with range=${range} for every online node — allocated vs actually used CPU and memory.
3. list_storage and list_disks — free space per pool, thin-pool metadata, and disks sitting unused.
4. list_vms — the largest consumers, and anything allocated but stopped.

Then answer three questions directly: which resource runs out first, roughly when at the current trend,
and what the cheapest next step is (reclaim, rebalance, or add). Give numbers, not adjectives.
${GUARD}`,
  },
  {
    name: 'backup-audit',
    title: 'Backup audit',
    description: 'Which guests are not protected, which jobs are failing, and whether the datastores are reachable.',
    arguments: [],
    needs: ['get_backup_overview'],
    build: () => `Audit backup coverage for this organization.

1. get_backup_status — which backup servers and datastores exist.
2. get_backup_overview — last backup per guest. Flag every guest with no backup at all, and any older than 7 days.
3. get_backup_link_health — datastores a Proxmox node cannot reach, which silently breaks jobs.
4. list_backup_jobs for each datastore — schedules, and whether the last run failed.
5. For a failed job, get_backup_task_log and say what actually failed, in plain words.

Report a short table: guest, last backup, verdict. Then the gaps worth fixing first.
Treat "no backup" and "backup never verified" as different problems and say which is which.
${GUARD}`,
  },
  {
    name: 'exposure-review',
    title: 'Internet exposure review',
    description: 'What is reachable from the internet through the vRouter, and whether it should be.',
    arguments: [],
    needs: ['list_vrouters'],
    build: () => `Review what this organization exposes to the internet.

1. list_vrouters, then get_vrouter_overview for each.
2. get_vrouter_nat — every port forward: public port, destination guest, and destination port.
3. get_vrouter_firewall — which rules actually constrain those forwards, and which allow any source.
4. get_vrouter_wireguard — VPN peers, and when each last completed a handshake. A peer that has never
   handshaked is usually a device that was provisioned and forgotten.
5. list_dhcp_leases and list_vrouter_devices to resolve addresses to real guests.

For each exposed service say: what it is, who can reach it, and whether that is defensible. Call out
management ports (SSH, RDP, Proxmox 8006, PBS 8007) open to the whole internet as the first finding.
${GUARD}`,
  },
  {
    name: 'triage',
    title: 'Triage a problem',
    description: 'Start from a symptom and narrow it down with live data instead of guessing.',
    arguments: [{ name: 'symptom', description: 'What was observed, e.g. "web-01 is slow since this morning"', required: true }],
    needs: ['list_nodes'],
    build: ({ symptom }) => `Triage this report: "${symptom}"

Narrow it down with live data, and say what you ruled out as you go:
1. If a guest is named, find_guest or list_vms to resolve it, then get_guest and get_guest_live.
2. get_guest_metrics over a window that covers "before" and "after" — compare, do not just describe now.
3. get_node_usage and get_node_live for its node: is this the guest, or its neighbours?
4. list_storage and list_disks if the symptom could be I/O.
5. search_audit_log and the Proxmox task log around the time it started — a change is a likelier cause than a coincidence.

End with: the most probable cause, the evidence for it, what would confirm it, and the smallest safe next step.
If the data does not support a conclusion, say that instead of picking one.
${GUARD}`,
  },
  {
    name: 'plan-vm',
    title: 'Plan a new VM',
    description: 'Pick a node and template from real options, size it sensibly, and leave a proposal ready to confirm.',
    arguments: [{ name: 'request', description: 'What the VM is for, e.g. "staging web server, 4 vCPU, 8 GB, Ubuntu 24.04"', required: true }],
    needs: ['propose_action'],
    build: ({ request }) => `Plan a VM for this request: "${request}"

Use real options, never invented names:
1. list_nodes and get_node_usage — choose the node with the most genuine headroom, and say why that one.
2. get_provisioning_options for that node — the templates, storages and bridges that actually exist there.
3. get_capabilities — confirm the token may create a guest before promising anything.
4. propose_action with action=create_vm and parameters drawn from step 2.

Then show the returned plan and every warning, and tell the person exactly what will happen if they confirm
and that nothing has happened yet. ${GUARD}`,
  },
  {
    name: 'explain-action',
    title: 'Explain a proposal',
    description: 'Read a pending proposal and explain, in plain words, what it would do and what could go wrong.',
    arguments: [{ name: 'id', description: 'Action id, from list_actions', required: true }],
    needs: ['get_action'],
    build: ({ id }) => `Explain proposal ${id} to someone who has to decide whether to confirm it.

1. get_action with id=${id}.
2. Read its plan and warnings. If it names a node, guest or storage, look that up so you can describe the
   real state it is about to change.

Answer four things: what changes, what stays the same, what the warnings actually mean in practice, and
what is hard to undo. If the plan carries typed_confirmation, say what makes it high risk.
Do not recommend confirming or cancelling — give the person what they need to choose. ${GUARD}`,
  },
];

export const promptFor = (name) => PROMPTS.find((p) => p.name === name) ?? null;

// A prompt is only offered when the key can actually run it.
export const promptsFor = (toolNames) => PROMPTS.filter((p) => p.needs.every((n) => toolNames.has(n)));
