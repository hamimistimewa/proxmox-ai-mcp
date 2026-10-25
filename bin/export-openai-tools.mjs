#!/usr/bin/env node
// Writes schemas/openai-tools.json: the same RBAC-filtered tools, in OpenAI function-calling shape.
//
//   node bin/export-openai-tools.mjs --url https://proxmox.ai.id --key pak_…
//
// The file is generated per key, so a readonly key produces a file with no write functions in it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, fetchManifest } from './proxmox-ai-mcp.mjs';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'openai-tools.json');
const cfg = loadConfig(process.argv.slice(2));
const manifest = await fetchManifest(cfg);

const doc = {
  generated_at: new Date().toISOString(),
  api_base_url: manifest.api_base_url,
  scope: manifest.scope,
  role: manifest.role,
  system_prompt: manifest.guardrail,
  tools: manifest.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  })),
  // keep the routing table beside the schema so a client knows where each call goes
  routes: Object.fromEntries(manifest.tools.map((t) => [t.name, `${t.method} ${t.path}`])),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote ${doc.tools.length} tools to ${out}`);
