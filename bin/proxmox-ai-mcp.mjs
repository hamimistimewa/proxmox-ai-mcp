#!/usr/bin/env node
// proxmox-ai-mcp — an MCP server that gives your AI client real Proxmox tools.
//
// It holds no tool list of its own. At start-up it asks the Proxmox AI platform which tools THIS API key
// is allowed to use and exposes exactly those, so a readonly key is never even shown the tools that write.
//
//   stdio (default, for Claude Code, Claude Desktop, Codex, Cursor):
//     proxmox-ai-mcp
//   streamable HTTP (one server, several clients, key per request):
//     proxmox-ai-mcp --transport http --port 8080
//
// Zero dependencies on purpose: the whole protocol is in lib/, so you can read it.
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { loadConfig, fetchManifest, ApiError } from '../lib/client.mjs';
import { createSession, handle } from '../lib/protocol.mjs';

// stdout is the JSON-RPC channel on stdio and nothing else may be written there.
const log = (...a) => console.error('[proxmox-ai-mcp]', ...a);

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const codeFor = (err) => (err instanceof ApiError && err.status === 404 ? -32601 : -32603);

async function respond(message, ctx) {
  const { id, method } = message;
  if (id === undefined) return null;            // a notification expects no answer
  try {
    return rpcOk(id, await handle(message, ctx));
  } catch (err) {
    return rpcError(id, codeFor(err), err.message || `Failed to handle ${method}`);
  }
}

// ---------------------------------------------------------------- stdio
async function serveStdio(cfg) {
  let session;
  const load = async () => { session = createSession(await fetchManifest(cfg)); return session; };
  try {
    await load();
  } catch (err) {
    log(`could not load the tool manifest: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const who = session.manifest.organization ? `${session.manifest.organization.name} (${session.manifest.role})` : 'platform scope';
  log(`connected to ${cfg.base} as ${who} — ${session.tools.size} tools, ${session.prompts.length} prompts, ${session.resources.length} resources`);

  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    const raw = line.trim();
    if (!raw) continue;
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    const out = await respond(message, { cfg, session, refresh: load });
    if (out) send(out);
  }
}

// ---------------------------------------------------------------- streamable HTTP
// POST /mcp carries one JSON-RPC message and gets one JSON response. The Authorization header
// overrides the configured key, so one server can serve several people with their own keys and
// each of them still sees only the tools their own key allows.
function serveHttp(cfg) {
  const sessions = new Map();          // key -> session, so the manifest is fetched once per key

  const sessionFor = async (reqCfg) => {
    const cached = sessions.get(reqCfg.key);
    if (cached) return cached;
    const session = createSession(await fetchManifest(reqCfg));
    sessions.set(reqCfg.key, session);
    return session;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const json = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    if (url.pathname === '/health') return json(200, { ok: true, server: 'proxmox-ai-mcp', version: 'http' });
    if (url.pathname !== '/mcp') return json(404, { error: 'Not found. The MCP endpoint is POST /mcp.' });
    if (req.method === 'GET') {
      // No server-initiated stream: every answer is returned on the POST that asked for it.
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      return res.end('{"error":"This server answers on POST /mcp; it opens no SSE stream."}');
    }
    if (req.method !== 'POST') return json(405, { error: 'Use POST /mcp' });

    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const key = bearer || req.headers['x-proxmox-ai-key'] || cfg.key;
    if (!key) return json(401, { error: 'Send the API key as "Authorization: Bearer pak_…"' });

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return json(413, { error: 'Request too large' });
    }
    let message;
    try { message = JSON.parse(body); } catch { return json(400, rpcError(null, -32700, 'Invalid JSON')); }

    const reqCfg = { ...cfg, key };
    try {
      const session = await sessionFor(reqCfg);
      const out = await respond(message, { cfg: reqCfg, session, refresh: async () => {
        sessions.delete(key);
        return sessionFor(reqCfg);
      } });
      // A notification gets 202 with no body, as the spec expects.
      if (!out) { res.writeHead(202); return res.end(); }
      return json(200, out);
    } catch (err) {
      sessions.delete(key);
      return json(err instanceof ApiError && err.status === 401 ? 401 : 500, rpcError(message?.id ?? null, -32603, err.message));
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    log(`listening on http://${cfg.host}:${cfg.port}/mcp`);
    log(cfg.key ? 'a default key is configured; Authorization: Bearer overrides it per request' : 'no default key: every request must carry Authorization: Bearer pak_…');
  });
}

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  if (cfg.transport === 'http' || cfg.transport === 'streamable-http') return serveHttp(cfg);
  if (cfg.transport !== 'stdio') throw new Error(`Unknown transport "${cfg.transport}". Use stdio or http.`);
  return serveStdio(cfg);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { log(err.message); process.exit(1); });
}
