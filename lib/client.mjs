// Configuration, the HTTP client for the platform, and the tool manifest.
// Shared by every transport, so stdio and HTTP behave identically.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '1.3.1';

export function loadConfig(argv = [], env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) flags[m[1]] = m[2] ?? (argv[i + 1]?.startsWith('--') ? 'true' : argv[++i]);
  }
  let file = {};
  const path = env.PROXMOX_AI_CONFIG || join(homedir(), '.proxmox-ai', 'config.json');
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* no config file is fine */ }

  const url = flags.url || env.PROXMOX_AI_URL || file.url;
  // PROXMOX_AI_KEY is the variable Claude Code fills from the plugin's own userConfig prompt
  // (see .mcp.json), which is how a stdio MCP server receives a configured value. It is not read
  // from a credential the user happened to set for something else.
  const key = flags.key || env.PROXMOX_AI_KEY || file.key;
  // A key pinned to machines is identified by this id instead of by a fixed IP address, so a laptop
  // on a changing connection still works. It is generated once by the installer and never sent anywhere
  // but to the platform that issued the key.
  const device = flags.device || env.PROXMOX_AI_DEVICE || file.device || null;
  const deviceName = flags['device-name'] || env.PROXMOX_AI_DEVICE_NAME || file.device_name || null;
  const transport = (flags.transport || env.PROXMOX_AI_TRANSPORT || 'stdio').toLowerCase();
  const cfg = {
    transport,
    port: Number(flags.port || env.PROXMOX_AI_PORT || 8080),
    host: flags.host || env.PROXMOX_AI_HOST || '127.0.0.1',
    timeoutMs: Number(flags.timeout || file.timeout || 30000),
    base: url ? `${String(url).replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1` : null,
    key: key ?? null,
    device: device ?? null,
    deviceName: deviceName ?? null,
    configPath: path,
  };
  // An HTTP server may take the key per request instead, so only stdio needs one up front.
  if (transport === 'stdio' && (!cfg.base || !cfg.key)) {
    throw new Error(
      'Missing platform URL or API key.\n'
      + '  As a Claude Code plugin, enable it and enter the key when prompted; it is kept in\n'
      + '  the secure credential store, not in a file.\n'
      + `  Outside the plugin, the installer writes ${path} for you:\n`
      + '    node server/install.mjs --url https://proxmox.ai.id --key pak_…',
    );
  }
  return cfg;
}

export class ApiError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function call(cfg, method, path, { query, body } = {}) {
  if (!cfg.base) throw new ApiError('No platform URL configured', 500);
  if (!cfg.key) throw new ApiError('No API key supplied for this request', 401);
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
        ...(cfg.device ? { 'x-pmx-device': cfg.device } : {}),
        ...(cfg.device && cfg.deviceName ? { 'x-pmx-device-name': cfg.deviceName } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status, res.headers.get('retry-after'));
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(`The platform did not answer within ${cfg.timeoutMs} ms`, 504);
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

// Path params come out of the arguments; what is left is a query string for GET, a JSON body otherwise.
export function splitArguments(tool, args) {
  const rest = { ...args };
  const path = tool.path.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = rest[name];
    delete rest[name];
    if (value === undefined || value === null || value === '') throw new ApiError(`Missing required parameter "${name}"`, 400);
    return encodeURIComponent(String(value));
  });
  return tool.method === 'GET' ? { path, query: rest } : { path, body: rest };
}
