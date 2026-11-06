#!/usr/bin/env node
// One command that teaches every AI client on this machine about your Proxmox.
//
//   node server/install.mjs --url https://proxmox.ai.id --key pak_…
//
// It verifies the key against the platform first, writes the credentials to ~/.proxmox-ai/config.json with
// owner-only permissions, and then registers this server with each client it actually finds. The client config
// files only ever get a path — the key never goes into them, so dotfiles stay safe to commit and share.
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, platform, hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { loadConfig, fetchManifest } from '../lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, 'proxmox-ai-mcp.mjs');
const SKILL_SRC = resolve(HERE, '..', 'skills', 'proxmox-operations');
const HOME = homedir();
const CONFIG_DIR = join(HOME, '.proxmox-ai');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const NAME = 'proxmox-ai';
const SKILL_NAME = 'proxmox-operations';

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const skip = (s) => console.log(`  \x1b[90m·\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);

const APP_SUPPORT = platform() === 'darwin'
  ? join(HOME, 'Library', 'Application Support')
  : platform() === 'win32'
    ? (process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'))
    : join(HOME, '.config');

// Every client below stores MCP servers as JSON under some key; only the file and the key differ.
// Claude Code is here like any other client. It was left out for a while, on the reasoning that the
// plugin is the better route there — but the plugin asks for its own key and reads nothing from
// disk, so the two paths never touched. Leaving it out only meant a machine where every other agent
// got its tools and Claude Code silently did not.
const JSON_CLIENTS = [
  { label: 'Claude Code', file: join(HOME, '.claude.json'), key: 'mcpServers', createIfMissing: true },
  { label: 'Claude Desktop', file: join(APP_SUPPORT, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
  { label: 'Cursor', file: join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
  { label: 'Windsurf', file: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' },
  { label: 'Gemini CLI', file: join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' },
  { label: 'Qwen Code', file: join(HOME, '.qwen', 'settings.json'), key: 'mcpServers' },
  { label: 'VS Code (Copilot)', file: join(APP_SUPPORT, 'Code', 'User', 'mcp.json'), key: 'servers' },
];

// Codex and DeepSeek CLI keep their MCP servers in TOML under the same [mcp_servers.<name>] shape.
const TOML_CLIENTS = [
  { label: 'Codex CLI', file: join(HOME, '.codex', 'config.toml') },
  // The project renamed itself: it reads the new path first and still honours the old one.
  { label: 'DeepSeek CLI', file: join(HOME, '.weiping-whale', 'config.toml'), alt: join(HOME, '.deepseek-cli', 'config.toml') },
];

// Directories each agent scans for skills. DeepSeek CLI also reads ~/.claude/skills on its own,
// so a machine with both gets the skill once and both find it.
const SKILL_DIRS = [
  { label: 'Claude', dir: join(HOME, '.claude', 'skills'), needs: join(HOME, '.claude') },
  { label: 'Codex', dir: join(HOME, '.codex', 'skills'), needs: join(HOME, '.codex') },
  { label: 'DeepSeek CLI', dir: join(HOME, '.weiping-whale', 'skills'), needs: join(HOME, '.weiping-whale') },
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

// Rather than depend on a TOML library, replace our own block if it is there and append it if it is
// not; nothing else in the file is touched.
function registerToml({ label, file, alt }) {
  if (alt && !existsSync(dirname(file)) && existsSync(dirname(alt))) file = alt;
  if (!existsSync(dirname(file))) return skip(`${label} — not installed`);
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
  return ok(`${label} — registered (${file})`);
}

// The skill is what teaches Claude the propose → confirm discipline; the tool list alone does not.
// The shell client is useful whichever path installed things, and the README has always said it
// lands on PATH. Only install.sh was linking it, so the Node path left `pmx: command not found`.
function linkPmx() {
  const src = resolve(HERE, 'pmx');
  if (!existsSync(src)) return skip('pmx — not in this clone');
  let dir = '';
  for (const d of [join(HOME, '.local', 'bin'), join(HOME, 'bin'), '/usr/local/bin']) {
    if ((process.env.PATH ?? '').split(':').includes(d)) {
      try { mkdirSync(d, { recursive: true }); dir = d; break; } catch { /* not writable */ }
    }
  }
  if (!dir) { dir = join(HOME, '.local', 'bin'); mkdirSync(dir, { recursive: true }); }
  const dest = join(dir, 'pmx');
  try {
    rmSync(dest, { force: true });
    symlinkSync(src, dest);
    chmodSync(src, 0o755);
    return ok(`pmx — linked (${dest})`);
  } catch (err) {
    return warn(`pmx — could not link: ${err.message}`);
  }
}

// The organization can configure its own OpenAI-compatible endpoint under AI settings, and the
// manifest hands on its URL and model — never the key, which belongs to whoever runs the agent. If
// one is set and Codex is here, write it as a Codex *profile*: `--profile custom` reaches it, and
// the config the user already had keeps working untouched when they do not ask for it.
function writeCodexProfile(endpoint) {
  if (!endpoint?.base_url || !endpoint?.model) return undefined;
  const dir = join(HOME, '.codex');
  if (!existsSync(dir)) return undefined;
  const file = join(dir, 'custom.config.toml');
  const toml = [
    '# Written by the Proxmox AI installer, from your organization\'s AI settings.',
    '# Reached with: codex --profile custom. Your base config.toml is untouched.',
    `model = ${JSON.stringify(endpoint.model)}`,
    'model_provider = "custom"',
    '',
    '[model_providers.custom]',
    'name = "Organization endpoint"',
    `base_url = ${JSON.stringify(endpoint.base_url)}`,
    'env_key = "CODEX_CUSTOM_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
  try {
    writeFileSync(file, toml, { mode: 0o600 });
    return ok(`Codex profile — written (${file})`);
  } catch (err) {
    return warn(`Codex profile — could not write: ${err.message}`);
  }
}

function installSkills() {
  if (!existsSync(SKILL_SRC)) return warn('skill — skills/proxmox-operations is missing from this clone');
  for (const { label, dir, needs } of SKILL_DIRS) {
    if (!existsSync(needs)) { skip(`${label} skill — ${needs} not found`); continue; }
    mkdirSync(dir, { recursive: true });
    cpSync(SKILL_SRC, join(dir, SKILL_NAME), { recursive: true });
    ok(`${label} skill — installed (${join(dir, SKILL_NAME)})`);
  }
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  // Same courtesy as the bootstrap: a missing key is asked for, not refused, so --key is optional
  // wherever someone starts from. Non-interactive callers still pass it and never reach this.
  if (!argv.some((a) => a === '--key' || a.startsWith('--key=')) && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => {
      rl.question('\nPaste your Proxmox AI key (Dashboard -> API keys). It starts with pak_\nKey: ', res);
    });
    rl.close();
    const key = String(answer).trim();
    if (key) argv.push('--key', key);
    console.log();
  }
  // The platform URL has one sensible value and install.sh already defaults to it. Without the same
  // default here, a prompted key still failed for want of a flag nobody was asked for.
  if (!argv.some((a) => a === '--url' || a.startsWith('--url='))) {
    argv.push('--url', 'https://proxmox.ai.id');
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node server/install.mjs --url https://proxmox.ai.id --key pak_…\n');
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

  // A key pinned to machines needs this id on the very first request, because that request is what
  // enrols the machine. Reuse the one already on disk so re-running the installer does not look like
  // a second machine and land in the approval queue.
  if (!cfg.device) {
    let existing = {};
    try { existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
    cfg.device = existing.device || randomUUID().replace(/-/g, '');
    cfg.deviceName = cfg.deviceName || existing.device_name || `${userInfo().username}@${hostname()}`;
  }

  // Check the key before writing anything, so a typo fails here instead of inside an AI client.
  console.log(`\nChecking ${cfg.base} …`);
  let manifest;
  try {
    manifest = await fetchManifest(cfg);
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${err.message}\n`);
    if (/approve|pinned to specific machines|waiting to be approved/i.test(err.message)) {
      console.error(`  Nothing was changed. This machine is "${cfg.deviceName}" — approve it in the dashboard`);
      console.error('  under API keys → Pinned machines, then run this installer again.\n');
    } else {
      console.error('  Nothing was changed. Check the URL and the key; if the key is limited to fixed');
      console.error('  addresses, check that this machine\'s IP is on its whitelist.\n');
    }
    process.exitCode = 1;
    return;
  }
  const who = manifest.organization ? `${manifest.organization.name} · role ${manifest.role}` : 'platform scope';
  ok(`key accepted — ${who}, ${manifest.tools.length} tools`);

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({
    url: cfg.base.replace(/\/api\/v1$/, ''),
    key: cfg.key,
    device: cfg.device,
    device_name: cfg.deviceName,
  }, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows has no mode bits */ }
  ok(`credentials saved — ${CONFIG_FILE} (owner only)`);

  console.log('\nRegistering with the AI clients on this machine:');
  for (const client of JSON_CLIENTS) registerJson(client);
  for (const client of TOML_CLIENTS) registerToml(client);
  linkPmx();
  const profiled = writeCodexProfile(manifest.model_endpoint);
  installSkills();

  if (profiled) {
    console.log('\nYour organization has its own model endpoint, and Codex can use it:');
    console.log('  export CODEX_CUSTOM_API_KEY="your key for that endpoint"');
    console.log('  codex --profile custom');
    console.log('Without --profile, Codex keeps using whatever account it signed in to. The key for');
    console.log('that endpoint is yours to supply — this installer never carries one.');
  }

  console.log('\nIn Claude Code there is also a plugin, if you prefer it to ask for the key itself');
  console.log('and keep it out of any file:');
  console.log('  /plugin marketplace add hamimistimewa/proxmox-ai-mcp');
  console.log('  /plugin install proxmox-ai');
  console.log('Either way works. What this installer just set up needs nothing further.');

  console.log('\nRestart your AI client, then ask it something like:');
  console.log('  "node mana yang RAM-nya paling mepet?"');
  if (manifest.tools.some((t) => t.name === 'propose_action')) {
    console.log('\nThis key may propose changes, and nothing runs until you confirm. Confirming is a');
    console.log('reply: the agent shows you the plan and waits, and "lanjut" or "go ahead" is what');
    console.log('sends it. Right there in the terminal — the dashboard is only the other way to do it.');
  } else {
    console.log('\nThis key is read only — no tool that changes anything was installed.');
  }
  console.log();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
