// Configuration, the HTTP client for the platform, and the tool manifest.
// Shared by every transport, so stdio and HTTP behave identically.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const VERSION = '1.3.11';

// The machine identity a pinned key needs, kept in ${CLAUDE_PLUGIN_DATA} — the directory Claude Code
// gives a plugin for generated state, which survives plugin updates. If that variable is absent the
// id is derived from the host instead, so the request still identifies a machine rather than failing.
function pluginDevice(env) {
  const name = `${safeUser()}@${hostname()}`.slice(0, 100);
  const dir = env.CLAUDE_PLUGIN_DATA;
  if (!dir) return { id: null, name };
  const file = join(dir, 'device.json');
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof saved?.id === 'string' && /^[a-f0-9]{32}$/.test(saved.id)) return { id: saved.id, name: saved.name || name };
  } catch { /* first run, or the file was cleared */ }
  const id = randomUUID().replace(/-/g, '');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ id, name }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* read-only data dir: the id still works for this run, a new one is made next time */ }
  return { id, name };
}

const safeUser = () => {
  try { return userInfo().username; } catch { return 'user'; }
};

export function loadConfig(argv = [], env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) flags[m[1]] = m[2] ?? (argv[i + 1]?.startsWith('--') ? 'true' : argv[++i]);
  }
  // Claude Code starts this server from the plugin's .mcp.json, which sets PROXMOX_AI_PLUGIN=1 and
  // passes the key as ${user_config.api_key} — a value the user typed into the plugin's own prompt and
  // that Claude Code keeps in its credential store. In that mode the key may come from this handshake
  // and nowhere else: no config file is opened, no path override is honoured, and no value the user
  // happened to set in their shell for something else can be picked up. The standalone CLI and the
  // other AI clients have no such handshake, so outside plugin mode the config file remains the source.
  const fromPlugin = env.PROXMOX_AI_PLUGIN === '1';
  let file = {};
  const path = fromPlugin ? null : env.PROXMOX_AI_CONFIG || join(homedir(), '.proxmox-ai', 'config.json');
  if (path) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* no config file is fine */ }
  }

  const url = fromPlugin ? env.PROXMOX_AI_URL : flags.url || env.PROXMOX_AI_URL || file.url;
  const key = fromPlugin ? env.PROXMOX_AI_KEY || null : flags.key || env.PROXMOX_AI_KEY || file.key;
  // A key pinned to machines is identified by this id instead of by a fixed IP address, so a laptop
  // on a changing connection still works. It is generated once by the installer and never sent anywhere
  // but to the platform that issued the key.
  // A key pinned to machines needs to say which machine this is. That identifier is not a
  // credential: it carries no secret, grants nothing on its own, and an unrecognised one shows up in
  // the dashboard as a machine awaiting approval rather than as access. So plugin mode may have one,
  // and keeps it in the plugin's own data directory — never in the user's files or environment.
  const pinned = fromPlugin ? pluginDevice(env) : null;
  const device = fromPlugin ? pinned?.id ?? null : flags.device || env.PROXMOX_AI_DEVICE || file.device || null;
  const deviceName = fromPlugin ? pinned?.name ?? null : flags['device-name'] || env.PROXMOX_AI_DEVICE_NAME || file.device_name || null;
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
    fromPlugin,
  };
  // An HTTP server may take the key per request instead, so only stdio needs one up front.
  if (transport === 'stdio' && (!cfg.base || !cfg.key)) {
    throw new Error(fromPlugin
      ? 'Missing platform URL or API key.\n'
        + '  Open /plugin, pick Proxmox AI, and enter the key from your dashboard under\n'
        + '  Organization -> API keys. Claude Code keeps it in its credential store; this\n'
        + '  server reads no file and no other environment value.'
      : 'Missing platform URL or API key.\n'
        + `  The installer writes ${path} for you:\n`
        + '    node server/install.mjs --url https://proxmox.ai.id --key pak_...');
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
