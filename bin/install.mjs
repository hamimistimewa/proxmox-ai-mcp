#!/usr/bin/env node
// One command that teaches every AI client on this machine about your Proxmox.
//
//   node bin/install.mjs --url https://proxmox.ai.id --key pak_…
//
// It verifies the key against the platform first, writes the credentials to ~/.proxmox-ai/config.json with
// owner-only permissions, and then registers this server with each client it actually finds. The client config
// files only ever get a path — the key never goes into them, so dotfiles stay safe to commit and share.
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, fetchManifest } from './proxmox-ai-mcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, 'proxmox-ai-mcp.mjs');
const SKILL_SRC = resolve(HERE, '..', 'skills', 'proxmox-ai');
const HOME = homedir();
const CONFIG_DIR = join(HOME, '.proxmox-ai');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const NAME = 'proxmox-ai';

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const skip = (s) => console.log(`  \x1b[90m·\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);

const APP_SUPPORT = platform() === 'darwin'
  ? join(HOME, 'Library', 'Application Support')
  : platform() === 'win32'
    ? (process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'))
    : join(HOME, '.config');

// Every client below stores MCP servers as JSON under some key; only the file and the key differ.
const JSON_CLIENTS = [
  { label: 'Claude Code', file: join(HOME, '.claude.json'), key: 'mcpServers', createIfMissing: true },
  { label: 'Claude Desktop', file: join(APP_SUPPORT, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
  { label: 'Cursor', file: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
  { label: 'Windsurf', file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
  { label: 'Gemini CLI', file: join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' },
  { label: 'VS Code (Copilot)', file: join(APP_SUPPORT, 'Code', 'User', 'mcp.json'), key: 'servers' },
];

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

function registerJson({ label, file, key, createIfMissing }) {
  const existing = readJson(file);
  // Only touch a client that is actually installed: its config file, or at least its folder, must exist.
  if (existing === null && !(createIfMissing || existsSync(dirname(file)))) return skip(`${label} — not installed`);
  const config = existing ?? {};
  const servers = config[key] && typeof config[key] === 'object' ? config[key] : {};
  const before = JSON.stringify(servers[NAME] ?? null);
  servers[NAME] = { command: process.execPath, args: [SERVER] };
  config[key] = servers;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return ok(`${label} — ${before === JSON.stringify(servers[NAME]) ? 'already registered' : 'registered'} (${file})`);
}

// Codex keeps its MCP servers in TOML. Rather than depend on a TOML library, replace our own block if it is
// there and append it if it is not; nothing else in the file is touched.
function registerCodex() {
  const file = join(HOME, '.codex', 'config.toml');
  if (!existsSync(dirname(file))) return skip('Codex CLI — not installed');
  const block = [
    '[mcp_servers.proxmox_ai]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(SERVER)}]`,
    '',
  ].join('\n');
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const header = '[mcp_servers.proxmox_ai]';
  if (text.includes(header)) {
    const start = text.indexOf(header);
    const after = text.indexOf('\n[', start + 1);
    text = text.slice(0, start) + block + (after === -1 ? '' : text.slice(after + 1));
  } else {
    text = `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return ok(`Codex CLI — registered (${file})`);
}

// The skill is what teaches Claude the propose → confirm discipline; the tool list alone does not.
function installSkill() {
  const dir = join(HOME, '.claude', 'skills');
  if (!existsSync(join(HOME, '.claude'))) return skip('Claude skill — ~/.claude not found');
  if (!existsSync(SKILL_SRC)) return warn('Claude skill — skills/proxmox-ai is missing from this clone');
  mkdirSync(dir, { recursive: true });
  cpSync(SKILL_SRC, join(dir, NAME), { recursive: true });
  return ok(`Claude skill — installed (${join(dir, NAME)})`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node bin/install.mjs --url https://proxmox.ai.id --key pak_…\n');
    console.log('Create the key in the dashboard under Organization → API keys.');
    console.log('The key decides which tools your AI client will see: readonly keys get read tools only.');
    return;
  }

  let cfg;
  try {
    cfg = loadConfig(argv);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Check the key before writing anything, so a typo fails here instead of inside an AI client.
  console.log(`\nChecking ${cfg.base} …`);
  let manifest;
  try {
    manifest = await fetchManifest(cfg);
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${err.message}\n`);
    console.error('  Nothing was changed. Check the URL, the key, and that your current IP is on the key\'s whitelist.\n');
    process.exitCode = 1;
    return;
  }
  const who = manifest.organization ? `${manifest.organization.name} · role ${manifest.role}` : 'platform scope';
  ok(`key accepted — ${who}, ${manifest.tools.length} tools`);

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ url: cfg.base.replace(/\/api\/v1$/, ''), key: cfg.key }, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows has no mode bits */ }
  ok(`credentials saved — ${CONFIG_FILE} (owner only)`);

  console.log('\nRegistering with the AI clients on this machine:');
  for (const client of JSON_CLIENTS) registerJson(client);
  registerCodex();
  installSkill();

  console.log('\nRestart your AI client, then ask it something like:');
  console.log('  "node mana yang RAM-nya paling mepet?"');
  if (manifest.tools.some((t) => t.name === 'propose_action')) {
    console.log('\nThis key may propose changes. Nothing runs until a human confirms it in the dashboard.');
  } else {
    console.log('\nThis key is read only — no tool that changes anything was installed.');
  }
  console.log();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
