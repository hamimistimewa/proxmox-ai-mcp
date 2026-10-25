#!/usr/bin/env node
// proxmox-ai-mcp — an MCP server that gives your local AI client real Proxmox tools.
//
// It holds no tool list of its own. At start-up it asks the Proxmox AI platform which tools THIS API key is
// allowed to use (GET /mcp/manifest) and exposes exactly those. A readonly key is therefore never even shown
// the tools that write, so the model cannot try. Add an endpoint on the platform and every installed copy of
// this server picks it up on the next restart — no update to this repo.
//
// Zero dependencies on purpose: `git clone` and run. The whole protocol is below, so you can read it.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

// stdout is the JSON-RPC channel and nothing else may ever be written there
const log = (...args) => console.error('[proxmox-ai-mcp]', ...args);

// ---------------------------------------------------------------- configuration
export function loadConfig(argv = []) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) flags[m[1]] = m[2] ?? argv[++i];
  }
  let file = {};
  const path = process.env.PROXMOX_AI_CONFIG || join(homedir(), '.proxmox-ai', 'config.json');
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* no config file is fine */ }

  const url = flags.url || process.env.PROXMOX_AI_URL || file.url;
  const key = flags.key || process.env.PROXMOX_AI_KEY || file.key;
  if (!url || !key) {
    throw new Error(
      'Missing platform URL or API key.\n'
      + `  Looked in: --url/--key, PROXMOX_AI_URL/PROXMOX_AI_KEY, and ${path}\n`
      + '  Create a key in the dashboard under Organization → API keys, then run:\n'
      + '    node bin/install.mjs --url https://proxmox.ai.id --key pak_…',
    );
  }
  // Accept either the site root or the API base; normalise to the API base.
  const base = url.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return { base: `${base}/api/v1`, key, timeoutMs: Number(flags.timeout || file.timeout || 30000) };
}

// ---------------------------------------------------------------- platform calls
async function call(cfg, method, path, { query, body } = {}) {
  const url = new URL(cfg.base + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${cfg.key}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const message = data?.error ?? `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`The platform did not answer within ${cfg.timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchManifest(cfg) {
  const manifest = await call(cfg, 'GET', '/mcp/manifest');
  if (!Array.isArray(manifest?.tools)) throw new Error('The platform did not return a tool manifest — is the URL right, and is the platform up to date?');
  return manifest;
}

// Path params come out of the arguments; whatever is left is a query string for GET, a JSON body otherwise.
function splitArguments(tool, args) {
  const rest = { ...args };
  const path = tool.path.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = rest[name];
    delete rest[name];
    if (value === undefined || value === null || value === '') throw new Error(`Missing required parameter "${name}"`);
    return encodeURIComponent(String(value));
  });
  return tool.method === 'GET' ? { path, query: rest } : { path, body: rest };
}

// ---------------------------------------------------------------- JSON-RPC plumbing
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], isError });

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  let manifest = null;
  let tools = new Map();

  async function refresh() {
    manifest = await fetchManifest(cfg);
    tools = new Map(manifest.tools.map((t) => [t.name, t]));
    const who = manifest.organization ? `${manifest.organization.name} (${manifest.role})` : 'platform scope';
    log(`connected to ${cfg.base} as ${who} — ${tools.size} tools`);
  }

  // Fail loudly here rather than serving an empty tool list that looks like a broken platform.
  try {
    await refresh();
  } catch (err) {
    log(`could not load the tool manifest: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const instructions = [
    manifest.guardrail,
    manifest.organization
      ? `You are acting inside the organization "${manifest.organization.name}" with the role ${manifest.role}. Tools you cannot see are tools this key may not use — do not try to work around them.`
      : 'This key has platform scope: it administers organizations, not the guests inside them.',
  ].join('\n\n');

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    const { id, method, params } = message;
    // Notifications carry no id and expect no answer
    if (id === undefined) continue;

    try {
      if (method === 'initialize') {
        const wanted = params?.protocolVersion;
        result(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.has(wanted) ? wanted : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'proxmox-ai-mcp', version: VERSION },
          instructions,
        });
      } else if (method === 'ping') {
        result(id, {});
      } else if (method === 'tools/list') {
        result(id, {
          tools: manifest.tools.map((t) => ({
            name: t.name,
            description: t.writes
              ? `${t.description}\n\n(This tool changes state. Only call it when the person has explicitly asked for it.)`
              : t.description,
            inputSchema: t.input_schema,
          })),
        });
      } else if (method === 'tools/call') {
        const tool = tools.get(params?.name);
        if (!tool) {
          textResult(id, `No tool named "${params?.name}" is available to this API key.`, true);
          continue;
        }
        try {
          const { path, query, body } = splitArguments(tool, params?.arguments ?? {});
          const data = await call(cfg, tool.method, path, { query, body });
          textResult(id, JSON.stringify(data, null, 2));
        } catch (err) {
          const hint = err.status === 403
            ? '\n\nThis key is not allowed to do that. Do not retry with different parameters.'
            : err.status === 429
              ? `\n\nRate limited${err.retryAfter ? `; retry after ${err.retryAfter}s` : ''}.`
              : '';
          textResult(id, `${err.message}${hint}`, true);
        }
      } else {
        failure(id, -32601, `Unknown method: ${method}`);
      }
    } catch (err) {
      failure(id, -32603, err.message);
    }
  }
}

// Only run when executed directly, so install.mjs can import loadConfig/fetchManifest.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { log(err.message); process.exit(1); });
}
