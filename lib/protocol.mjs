// The MCP surface: one JSON-RPC handler shared by every transport.
import { VERSION, call, fetchManifest, splitArguments, ApiError } from './client.mjs';
import { promptFor, promptsFor } from './prompts.mjs';

const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

// Read-only views the client can pull in as context without the model spending a tool call.
const RESOURCES = [
  { uri: 'proxmox://me', name: 'This API key', description: 'Scope, organization, role, IP whitelist and expiry of the key in use.', tool: 'whoami' },
  { uri: 'proxmox://nodes', name: 'Nodes', description: 'Every connected Proxmox node with its current CPU, memory and disk.', tool: 'list_nodes' },
  { uri: 'proxmox://guests', name: 'Guests', description: 'VMs, containers and templates with status and allocated resources.', tool: 'list_vms' },
  { uri: 'proxmox://storage', name: 'Storage', description: 'Storage pools with capacity and accepted content.', tool: 'list_storage' },
  { uri: 'proxmox://actions', name: 'Actions', description: 'Proposed, running and finished actions.', tool: 'list_actions' },
  { uri: 'proxmox://backups', name: 'Backup coverage', description: 'Last backup per guest and datastore usage.', tool: 'get_backup_overview' },
];

export function createSession(manifest) {
  const tools = new Map(manifest.tools.map((t) => [t.name, t]));
  const names = new Set(tools.keys());
  return {
    manifest,
    tools,
    names,
    prompts: promptsFor(names),
    resources: RESOURCES.filter((r) => names.has(r.tool)),
  };
}

export function instructionsFor(manifest) {
  return [
    manifest.guardrail,
    manifest.organization
      ? `You are acting inside the organization "${manifest.organization.name}" with the role ${manifest.role}. Tools you cannot see are tools this key may not use — do not look for a way around them.`
      : 'This key has platform scope: it administers organizations, hosts, vRouters and backup servers, not the guests inside them.',
    'Numbers come from tools, never from memory. If a call fails, say so rather than estimating.',
  ].join('\n\n');
}

const text = (s) => ({ content: [{ type: 'text', text: s }], isError: false });
const failed = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

export async function handle(message, { cfg, session, refresh }) {
  const { method, params } = message;

  if (method === 'initialize') {
    const wanted = params?.protocolVersion;
    return {
      protocolVersion: SUPPORTED.has(wanted) ? wanted : DEFAULT_PROTOCOL,
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
      },
      serverInfo: { name: 'proxmox-ai-mcp', version: VERSION },
      instructions: instructionsFor(session.manifest),
    };
  }

  if (method === 'ping') return {};

  if (method === 'tools/list') {
    return {
      tools: session.manifest.tools.map((t) => ({
        name: t.name,
        description: t.writes
          ? `${t.description}\n\n(This tool changes state. Only call it when the person has explicitly asked for it.)`
          : t.description,
        inputSchema: t.input_schema,
        annotations: { readOnlyHint: !t.writes, destructiveHint: Boolean(t.needs_confirmation) },
      })),
    };
  }

  if (method === 'tools/call') {
    const tool = session.tools.get(params?.name);
    if (!tool) return failed(`No tool named "${params?.name}" is available to this API key.`);
    try {
      const { path, query, body } = splitArguments(tool, params?.arguments ?? {});
      const data = await call(cfg, tool.method, path, { query, body });
      return text(JSON.stringify(data, null, 2));
    } catch (err) {
      const hint = err.status === 403
        ? '\n\nThis key is not allowed to do that. Do not retry with different parameters.'
        : err.status === 429
          ? `\n\nRate limited${err.retryAfter ? `; retry after ${err.retryAfter}s` : ''}.`
          : '';
      return failed(`${err.message}${hint}`);
    }
  }

  if (method === 'prompts/list') {
    return {
      prompts: session.prompts.map((p) => ({
        name: p.name, title: p.title, description: p.description, arguments: p.arguments,
      })),
    };
  }

  if (method === 'prompts/get') {
    const prompt = promptFor(params?.name);
    if (!prompt || !session.prompts.includes(prompt)) throw new ApiError(`No prompt named "${params?.name}"`, 404);
    const missing = (prompt.arguments ?? []).filter((a) => a.required && !params?.arguments?.[a.name]);
    if (missing.length) throw new ApiError(`Missing argument: ${missing.map((a) => a.name).join(', ')}`, 400);
    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.build(params?.arguments ?? {}) } }],
    };
  }

  if (method === 'resources/list') {
    return { resources: session.resources.map(({ uri, name, description }) => ({ uri, name, description, mimeType: 'application/json' })) };
  }

  if (method === 'resources/read') {
    const res = session.resources.find((r) => r.uri === params?.uri);
    if (!res) throw new ApiError(`No resource at ${params?.uri}`, 404);
    const tool = session.tools.get(res.tool);
    const data = await call(cfg, tool.method, tool.path);
    return { contents: [{ uri: res.uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }

  // The tool list follows the key; asking the platform again is how a changed key takes effect.
  if (method === 'proxmox/refresh' && refresh) return { tools: (await refresh()).manifest.tools.length };

  throw new ApiError(`Unknown method: ${method}`, 404);
}

export { fetchManifest };
